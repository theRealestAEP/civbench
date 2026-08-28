// The bridge is the only thing that talks to a running Civ 7 process.
import type { Json } from "../dump/types.ts";
// Everything above it (dump generation, match server, agents) sees plain JSON.
//
// Civ 7 runs JavaScript on V8 behind Coherent Gameface. Two debug transports exist and both
// ship in the retail build (see docs/FINDINGS.md):
//   - CDP     : cohtml serves the Chrome DevTools Protocol over a WebSocket. Standard, preferred.
//   - FireTuner: the Firaxis Nexus binary protocol. Fallback.

export interface Bridge {
  /** Evaluate JavaScript inside the game and return the JSON-decoded result. */
  eval<T = unknown>(js: string): Promise<T>;
  close(): Promise<void>;
  /**
   * False once the transport is gone for good, so a caller can reconnect instead of retrying
   * into a wall. Absent on a transport that cannot die, such as the fake.
   */
  readonly alive?: boolean;
}

export class BridgeError extends Error {
  /** Whatever the game sent back with the failure, when it sent anything. */
  detail: Json | undefined;
  constructor(message: string, detail?: Json) {
    super(message);
    this.name = "BridgeError";
    this.detail = detail;
  }
}

/**
 * Wrap an expression so the game serialises it for us.
 *
 * The game's own API returns BigInt in places (unit ids, plot indices), which JSON.stringify
 * rejects. Firaxis' tuner handles this with the same replacer, so we mirror it rather than
 * inventing our own convention.
 */
export function wrapExpression(js: string): string {
  return `(() => {
  try {
    const __v = (() => { ${js} })();
    return JSON.stringify(
      { ok: true, value: __v === undefined ? null : __v },
      (_k, v) => (typeof v === "bigint" ? Number(v) : v),
    );
  } catch (err) {
    return JSON.stringify({ ok: false, error: String(err && err.stack ? err.stack : err) });
  }
})()`;
}

export type EvalEnvelope<T> = { ok: true; value: T } | { ok: false; error: string };

export function unwrap<T>(raw: string): T {
  let parsed: EvalEnvelope<T>;
  try {
    // SAFETY: `raw` is the string produced by wrapExpression above, which always stringifies
    // an EvalEnvelope. A value that is not JSON at all is caught below.
    parsed = JSON.parse(raw) as EvalEnvelope<T>;
  } catch {
    throw new BridgeError("game returned non-JSON", raw);
  }
  if (!parsed.ok) throw new BridgeError(`game-side exception: ${parsed.error}`);
  return parsed.value;
}
