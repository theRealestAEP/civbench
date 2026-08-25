// A model-backed brain (docs/PLAN.md §9.4).
//
// One tool: bash. Everything the agent does — reading the dump, grepping history, acting, ending
// the turn — goes through the sandbox shell. That is the point: we hand the agent a filesystem
// and a command line, not a bespoke API of hand-written tools.
//
// The harness is FIXED across models. Same briefing, same single tool, same sandbox; only the
// model id changes. Otherwise a comparison measures scaffolding and credits it to the model.
import { Agent } from "@mariozechner/pi-agent-core";
import { Type } from "@mariozechner/pi-ai";
import { BRIEFING } from "./briefing.ts";
import { resolveModel } from "./models.ts";
import { compactTranscript } from "./compaction.ts";
import type { Brain, TurnContext, TurnReport } from "./brain.ts";

export type TurnUsage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
};

export type MemoryMode = "persistent" | "fresh";

/**
 * Does this command line actually end the turn?
 *
 * Anchored to the START of a command, and never when the part redirects to a file.
 * `echo "then civ end-turn" >> /notes/notes.md` used to match: echo exits 0, so the turn was
 * aborted without ever being ended — and notes.md is exactly where an agent writes next turn's
 * plan. Exported so its test drives this rule rather than a copy of it.
 */
export function endsTurn(command: string): boolean {
  return command
    .split(/[;&|]+/)
    .some((part) => /^\s*civ\s+end-turn\b/.test(part) && !/[<>]/.test(part));
}

export class PiBrain implements Brain {
  readonly name: string;
  #modelId: string;
  #memoryMode: MemoryMode;
  /** Kept across turns when memoryMode is "persistent". */
  #messages: unknown[] = [];
  /** Index in #messages where each turn started, so compaction knows what is recent. */
  #turnMarkers: number[] = [];
  #thinking: "minimal" | "low" | "medium" | "high" | "xhigh";
  /** Accumulated across the match, so the report can show cache effectiveness. */
  usage: TurnUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  /** Set when the last turn triggered compaction, for the ticker. */
  lastCompaction: string | null = null;
  /** The last turn's reasoning and commands, written to disk for review. */
  lastTranscript = "";

  constructor(
    modelId: string,
    thinking: PiBrain["#thinking"] = "low",
    memoryMode: MemoryMode = "persistent",
  ) {
    this.#modelId = modelId;
    this.#thinking = thinking;
    this.#memoryMode = memoryMode;
    this.name = modelId;
  }

  async playTurn({ hud, exec, report }: TurnContext): Promise<TurnReport> {
    let commands = 0;
    let endedTurn = false;
    const transcript: string[] = [];

    const bash = {
      name: "bash",
      label: "bash",
      description:
        "Run a shell command in your sandbox. Use it to read your position and to run `civ`.",
      parameters: Type.Object({ command: Type.String({ description: "The command to run." }) }),
      execute: async (_id: string, params: { command: string }) => {
        commands++;
        report?.({ action: params.command });
        const result = await exec(params.command);
        const body = [result.stdout, result.stderr].filter((s) => s.length > 0).join("\n");
        // Keep the exchange verbatim for the transcript: a wrong decision is usually a wrong
        // reading of the dump, and that is only visible with the command and its output side by side.
        transcript.push(
          `--- ran ---\n$ ${params.command}\n${body.length > 1200 ? body.slice(0, 1200) + "\n… (truncated)" : body}`,
        );

        // Ending the turn ends the agent's work. Without this the model gets "ok", carries on
        // reasoning, and calls end-turn again and again until it hits the timeout — while the
        // game has already moved to the next seat.
        if (endsTurn(params.command) && result.exitCode === 0) {
          endedTurn = true;
          queueMicrotask(() => agent.abort());
        }

        return {
          content: [
            {
              type: "text" as const,
              text: endedTurn
                ? "Turn ended. Stop here — the next seat is playing now."
                : body || `(no output, exit ${result.exitCode})`,
            },
          ],
          isError: result.exitCode !== 0,
        };
      },
    };

    // eslint-disable-next-line prefer-const -- the bash tool closes over this
    const agent: Agent = new Agent({
      // Compaction runs before each model call. It drops the bodies of old tool results and
      // keeps the agent's own reasoning — the dropped output is still on disk and re-readable.
      transformContext: async (messages) => {
        const { messages: compacted, stats } = compactTranscript(messages, this.#turnMarkers);
        if (stats.dropped > 0) {
          this.lastCompaction = `compacted ${stats.before}->${stats.after} tokens, ${stats.dropped} stubs`;
        }
        return compacted;
      },
      // Which key to use follows from the model, not from a global. Sonnet talks to Anthropic;
      // GLM, DeepSeek and Luna talk to OpenRouter with a different key.
      getApiKey: (provider) => {
        const wanted = resolveModel(this.#modelId).apiKeyEnv;
        const key = process.env[wanted];
        if (!key) throw new Error(`${wanted} is not set, needed for provider ${provider}`);
        return key;
      },
      initialState: {
        // BRIEFING is byte-identical for every seat and turn, which is what makes it cacheable.
        // Everything that varies arrives in the HUD below, after the cache breakpoint.
        systemPrompt: BRIEFING,
        model: resolveModel(this.#modelId) as never,
        thinkingLevel: this.#thinking,
        tools: [bash as never],
        // Carry the transcript across turns unless the run asked for a clean slate. Nuking it
        // every turn is cheap to reason about but no real deployment works that way, and it
        // forces the agent to re-derive its own plan from scratch each time.
        messages: (this.#memoryMode === "persistent" ? this.#messages : []) as never,
      },
    });

    // Capture the agent's own words as they stream, in order with the commands it runs.
    // Reconstructing them from state.messages afterwards proved unreliable — an aborted turn
    // (which is every turn, since end-turn aborts) could leave nothing to read.
    let streamed = "";
    agent.subscribe((event: unknown) => {
      // The event carries `message`, not `partial` — pi's AgentEvent union names it that way.
      const e = event as {
        type?: string;
        message?: { role?: string; content?: Array<{ type: string; text?: string; thinking?: string }> };
      };
      if (e.type !== "message_update" && e.type !== "message_end") return;
      // message_end fires for the prompt as well as the reply; only the assistant is thinking.
      if (e.message?.role !== "assistant") return;
      // Take both: `thinking` is the model's reasoning, `text` is what it chose to say. Asking
      // for narration in the briefing would bias the thing under test, so we take whatever it
      // produces on its own — often nothing on the first call, prose on later ones.
      const text = (e.message?.content ?? [])
        .filter((c) => (c.type === "text" || c.type === "thinking") && (c.text ?? c.thinking))
        .map((c) => c.text ?? c.thinking)
        .join("\n");
      if (!text) return;

      // The overlay only wants changes, but the transcript wants every finished message. These
      // were previously one branch, so the dedupe for the overlay silently swallowed the
      // transcript push: message_update set `streamed`, then message_end saw identical text and
      // returned before recording anything.
      if (e.type === "message_update") {
        if (text === streamed) return;
        streamed = text;
        report?.({ thinking: text });
        return;
      }

      streamed = text;
      report?.({ thinking: text });
      transcript.push(`--- thinking ---\n${text}`);
    });

    this.#turnMarkers.push(this.#messages.length);
    await agent.prompt(hud);
    await agent.waitForIdle();

    if (this.#memoryMode === "persistent") {
      this.#messages = agent.state.messages as unknown[];
    }

    const turn: TurnUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
    for (const message of agent.state.messages as Array<{ role?: string; usage?: TurnUsage & { cost?: { total?: number } } }>) {
      const u = message.usage;
      if (message.role !== "assistant" || !u) continue;
      turn.input += u.input ?? 0;
      turn.output += u.output ?? 0;
      turn.cacheRead += u.cacheRead ?? 0;
      turn.cacheWrite += u.cacheWrite ?? 0;
      turn.cost += u.cost?.total ?? 0;
    }
    for (const key of ["input", "output", "cacheRead", "cacheWrite", "cost"] as const) {
      this.usage[key] += turn[key];
    }

    // Already in order: thinking and commands were pushed as they happened.
    this.lastTranscript = transcript.join("\n\n");

    return {
      commands,
      inputTokens: turn.input + turn.cacheRead,
      outputTokens: turn.output,
      notes:
        `in ${turn.input} +${turn.cacheWrite} new, ${turn.cacheRead} cached, out ${turn.output}, $${turn.cost.toFixed(4)}` +
        (this.lastCompaction ? `  [${this.lastCompaction}]` : ""),
    };
  }
}
