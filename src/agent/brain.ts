// A Brain plays one turn inside a sandbox (docs/PLAN.md §9).
//
// The contract is deliberately narrow: it receives the HUD, it may run shell commands, and it
// finishes. Everything it can do — read the dump, grep history, act, end the turn — happens
// through `exec`. That is what keeps the bench agent-agnostic: a model, a scripted bot, and a
// random baseline all implement the same three lines.
export type Exec = (command: string) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

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
};

export type TurnReport = {
  commands: number;
  inputTokens?: number;
  outputTokens?: number;
  notes?: string;
};

export interface Brain {
  readonly name: string;
  playTurn(context: TurnContext): Promise<TurnReport>;
}
