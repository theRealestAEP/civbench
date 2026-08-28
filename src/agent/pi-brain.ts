// A model-backed brain (docs/PLAN.md §9.4).
//
// One tool: bash. Everything the agent does — reading the dump, grepping history, acting, ending
// the turn — goes through the sandbox shell. That is the point: we hand the agent a filesystem
// and a command line, not a bespoke API of hand-written tools.
//
// The harness is FIXED across models. Same briefing, same single tool, same sandbox; only the
// model id changes. Otherwise a comparison measures scaffolding and credits it to the model.
import { Agent } from "@mariozechner/pi-agent-core";
import type { AgentEvent } from "@mariozechner/pi-agent-core";
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
 * How hard the model is asked to think.
 *
 * A named type because a private field cannot be reached through `PiBrain["#thinking"]` — that
 * indexed access resolves to nothing, so the constructor parameter was silently untyped.
 */
export type ThinkingLevel = "minimal" | "low" | "medium" | "high" | "xhigh";

/**
 * The slice of pi's streaming event that this reads.
 *
 * pi does not export its AgentEvent union in a form we can name, so the shape we depend on is
 * written down here rather than re-asserted inline at each use. Every field is optional: an event
 * of a kind we do not handle simply fails the guards.
 */
type PiStreamEvent = {
  type?: string;
  message?: {
    role?: string;
    content?: Array<{ type: string; text?: string; thinking?: string }>;
  };
};

export class PiBrain implements Brain {
  readonly name: string;
  #modelId: string;
  #memoryMode: MemoryMode;
  /** Kept across turns when memoryMode is "persistent". */
  #messages: unknown[] = [];
  /** Index in #messages where each turn started, so compaction knows what is recent. */
  #turnMarkers: number[] = [];
  #thinking: ThinkingLevel;
  /** Accumulated across the match, so the report can show cache effectiveness. */
  usage: TurnUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  /** Set when the last turn triggered compaction, for the ticker. */
  lastCompaction: string | null = null;
  /** The last turn's reasoning and commands, written to disk for review. */
  lastTranscript = "";

  constructor(
    modelId: string,
    thinking: ThinkingLevel = "low",
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
        let body = [result.stdout, result.stderr].filter((s) => s.length > 0).join("\n");
        // Keep the exchange verbatim for the transcript: a wrong decision is usually a wrong
        // reading of the dump, and that is only visible with the command and its output side by side.
        transcript.push(
          `--- ran ---\n$ ${params.command}\n${body.length > 1200 ? body.slice(0, 1200) + "\n… (truncated)" : body}`,
        );
        // One `cat tiles.txt` late-game is a few hundred KB; verbatim it can blow the context in
        // a single call. The file is still on disk; a smaller read gets the rest.
        const MAX_TOOL_OUTPUT = 60_000;
        if (body.length > MAX_TOOL_OUTPUT) {
          body =
            body.slice(0, MAX_TOOL_OUTPUT) +
            `\n… [output cut at ${MAX_TOOL_OUTPUT} characters — the file is still on disk; ` +
            `read a slice (head, sed -n '1,200p') or grep it instead]`;
        }

        // Ending the turn ends the agent's work. Without this the model gets "ok", carries on
        // reasoning, and calls end-turn again and again until it hits the timeout — while the
        // game has already moved to the next seat.
        //
        // `turnEnded` comes from the `civ` command itself. Inferring it from the compound exit
        // code read `civ end-turn; civ hud` with a REFUSED end-turn as success — the agent was
        // told "Turn ended" mid-decision — and a trailing failed command hid a real end.
        if (result.turnEnded || result.turnOver) {
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
        // SAFETY: pi's Agent is generic over its own model registry type, which a descriptor
        // built here cannot satisfy nominally. The value is a real ModelDescriptor — resolveModel
        // throws for anything it does not know — and pi only ever reads its fields.
        model: resolveModel(this.#modelId) as never,
        thinkingLevel: this.#thinking,
        // SAFETY: same boundary. `bash` is a valid pi tool; the cast is to pi's generic tool type.
        tools: [bash as never],
        // Carry the transcript across turns unless the run asked for a clean slate. Nuking it
        // every turn is cheap to reason about but no real deployment works that way, and it
        // forces the agent to re-derive its own plan from scratch each time.
        // SAFETY: these are pi's own messages, kept from the previous turn and handed straight
        // back. The cast is to pi's generic message type, not a change of shape.
        messages: (this.#memoryMode === "persistent" ? this.#messages : []) as never,
      },
    });

    // Capture the agent's own words as they stream, in order with the commands it runs.
    // Reconstructing them from state.messages afterwards proved unreliable — an aborted turn
    // (which is every turn, since end-turn aborts) could leave nothing to read.
    let streamed = "";
    agent.subscribe((event: AgentEvent) => {
      // pi's own event type, so the shape is checked rather than asserted. The two kinds this
      // cares about both carry `message`; the guards below narrow to them.
      if (event.type !== "message_update" && event.type !== "message_end") return;
      // SAFETY: narrowed above to the two kinds that carry a message. PiStreamEvent names the
      // fields this reads — pi's AgentMessage is a union whose arms differ per custom message
      // type, and every field here is optional, so an arm we do not expect fails the guards.
      const e = event as PiStreamEvent;
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

    // Stop when the TURN ends, not when the agent decides it is finished.
    //
    // `agent.abort()` does not reliably interrupt a request already in flight, so an agent that
    // called `civ end-turn` kept reasoning afterwards — one was observed investigating "what has
    // been executed" for a turn that was already over — and we sat in waitForIdle until the 480s
    // budget expired. That is where 600-second rounds came from: the work was done in twenty
    // seconds and the harness waited out the clock.
    //
    // The turn ending is a fact we already know, so wait on that too and take whichever comes
    // first. A short grace lets the in-flight tool result land before we walk away.
    await Promise.race([
      agent.waitForIdle(),
      new Promise<void>((resolve) => {
        const check = setInterval(() => {
          if (!endedTurn) return;
          clearInterval(check);
          setTimeout(resolve, 250).unref?.();
        }, 100);
        check.unref?.();
      }),
    ]);

    if (this.#memoryMode === "persistent") {
      // SAFETY: pi's own messages, kept verbatim to hand back next turn. Nothing here reads
      // inside them — they are opaque to us by design, which is why the element type is unknown.
      this.#messages = agent.state.messages as unknown[];
    }

    // Two silent failures, made loud.
    //
    // Both of these depend on the shape of pi's own event and message objects, which we assert
    // rather than parse. When that shape last changed, reasoning capture returned nothing and the
    // run looked healthy for days — the agents appeared to be thinking silently. A cast cannot be
    // made safe, but its failure can be made visible.
    if (commands > 0 && transcript.length === 0) {
      console.warn(
        `[${this.name}] ran ${commands} commands and captured no reasoning — pi's event shape has ` +
          `probably changed. See the agent.subscribe handler in pi-brain.ts.`,
      );
    }

    const turn: TurnUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
    // SAFETY: pi records usage on its own assistant messages. Both fields are optional, so an
    // arm of the union without them contributes nothing to the totals.
    const messages = agent.state.messages as Array<{
      role?: string;
      usage?: TurnUsage & { cost?: { total?: number } };
    }>;
    for (const message of messages) {
      const u = message.usage;
      if (message.role !== "assistant" || !u) continue;
      turn.input += u.input ?? 0;
      turn.output += u.output ?? 0;
      turn.cacheRead += u.cacheRead ?? 0;
      turn.cacheWrite += u.cacheWrite ?? 0;
      turn.cost += u.cost?.total ?? 0;
    }
    if (commands > 0 && turn.input === 0 && turn.cacheRead === 0) {
      console.warn(
        `[${this.name}] ran ${commands} commands and reported no token usage — pi's usage shape has ` +
          `probably changed, so every cost figure this run is wrong.`,
      );
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
