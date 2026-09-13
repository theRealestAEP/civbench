// A Brain plays one turn inside a sandbox (docs/PLAN.md §9).
//
// The contract is deliberately narrow: it receives the HUD, it may run shell commands, and it
// finishes. Everything it can do — read the dump, grep history, act, end the turn — happens
// through `exec`. That is what keeps the bench agent-agnostic: a model, a scripted bot, and a
// random baseline all implement the same three lines.
import type { AgentMessage } from "@mariozechner/pi-agent-core";

export type Exec = (command: string) => Promise<{
  stdout: string;
  stderr: string;
  exitCode: number;
  /** True when a `civ end-turn` in this command actually ended the turn. */
  turnEnded?: boolean;
  /** True when the session is closed — the turn is over and the brain must stop. */
  turnOver?: boolean;
}>;

export type TurnContext = {
  hud: string;
  turn: number;
  playerId: string;
  exec: Exec;
  /**
   * Called as the agent thinks and acts, so the spectator overlay can show it on screen.
   * Optional: a brain that does not report simply shows nothing (docs/PLAN.md §12).
   */
  report?: (update: { thinking?: string; action?: string }) => void;
  /**
   * Append one transcript entry (a thinking block, or a command with its output) to the turn's
   * record on disk. Called as each happens, so a turn that times out or crashes still leaves
   * everything up to that point behind. Optional: a brain with nothing to say logs nothing.
   */
  log?: (entry: string) => void;
  /**
   * Append one raw message of the model conversation — the prompt, the model's reply with its
   * reasoning and tool calls, or a tool result — exactly as the model sent or received it. This
   * is the real thread; `log` is a readable digest of it.
   */
  thread?: (message: ThreadEntry) => void;
};

/** One line of a seat's thread on disk: a model message, or a marker around the turn. */
export type ThreadEntry =
  | AgentMessage
  | { event: "turn_start"; turn: number; model: string; memory: string; carriedMessages: number }
  | { event: "turn_over"; reason: "timeout"; secondsPerTurn: number }
  | { event: "turn_over"; reason: "error"; message: string }
  /** The model went idle without ending its turn and was asked once to continue or end it. */
  | { event: "nudge"; turn: number };

export type TurnReport = {
  commands: number;
  /** Errors the model returned mid-turn, for the event log. A turn with only errors throws instead. */
  errors?: string[];
  inputTokens?: number;
  outputTokens?: number;
  notes?: string;
};

export interface Brain {
  readonly name: string;
  playTurn(context: TurnContext): Promise<TurnReport>;
}
