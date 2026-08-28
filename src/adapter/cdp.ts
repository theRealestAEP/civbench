// Chrome DevTools Protocol transport.
//
// Coherent Gameface (libcohtml + libHttpServer) serves CDP over a WebSocket and embeds the
// DevTools frontend. Each Gameface "view" is a separate CDP target, so the game's UI context
// and any other views appear as distinct targets in /json/list.
import { type Bridge, BridgeError, unwrap, wrapExpression } from "./bridge.ts";
import type { Json } from "../dump/types.ts";

export type CdpTarget = { id: string; title: string; url: string; webSocketDebuggerUrl: string };

/** Ports Gameface hosts commonly use. Discovery tries each and keeps whichever answers. */
export const CANDIDATE_PORTS = [9222, 9444, 8080, 9223, 1234, 8081, 9229];

/**
 * Cohtml builds its webSocketDebuggerUrl from the request path, so asking /json/list yields
 * `ws://host/json/list/devtools/page/0` instead of `ws://host/devtools/page/0`. Repair it.
 */
function normaliseWsUrl(url: string, port: number): string {
  const m = /\/devtools\/(page|browser)\/(.+)$/.exec(url);
  return m ? `ws://127.0.0.1:${port}/devtools/${m[1]}/${m[2]}` : url;
}

export async function listTargets(port: number, timeoutMs = 3000): Promise<CdpTarget[]> {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`, {
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new BridgeError(`/json/list returned ${res.status}`);
  // SAFETY: /json/list is Chrome DevTools Protocol's own endpoint and its response shape is part
  // of that protocol. A malformed entry surfaces as a missing webSocketDebuggerUrl, which the
  // callers already filter on.
  const targets = (await res.json()) as CdpTarget[];
  return targets.map((t) => ({
    ...t,
    webSocketDebuggerUrl: normaliseWsUrl(t.webSocketDebuggerUrl, port),
  }));
}

/**
 * Scan the candidate ports for a live CDP endpoint. Returns every port that answered.
 *
 * The game stops answering while it generates a map or loads a save, so a single failed probe
 * means little. `attempts` retries before giving up.
 */
export async function discover(
  ports: number[] = CANDIDATE_PORTS,
  attempts = 3,
): Promise<Array<{ port: number; targets: CdpTarget[] }>> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const results = await Promise.all(
      ports.map(async (port) => {
        try {
          return { port, targets: await listTargets(port) };
        } catch {
          return null;
        }
      }),
    );
    const found = results.filter((r) => r !== null);
    if (found.length > 0) return found;
    if (attempt < attempts - 1) await new Promise((r) => setTimeout(r, 2000));
  }
  return [];
}

/** A CDP request awaiting its reply. The result is whatever that method returns, as JSON. */
type Pending = { resolve: (v: Json) => void; reject: (e: Error) => void };

export class CdpBridge implements Bridge {
  #ws: WebSocket;
  #nextId = 1;
  #pending = new Map<number, Pending>();

  /** Set once the socket is gone, so later calls fail immediately instead of waiting 30s. */
  #dead: string | null = null;

  private constructor(ws: WebSocket) {
    this.#ws = ws;
    ws.addEventListener("message", (ev) => this.#onMessage(String(ev.data)));
    // A dropped socket used to leave every in-flight request hanging for its full 30s timeout,
    // and every later call hung for 30s too because nothing knew the socket had gone. That is
    // what "CDP Runtime.evaluate timed out after 30000ms", repeated, actually was.
    ws.addEventListener("close", () => this.#die("the game closed the debug connection"));
    ws.addEventListener("error", () => this.#die("the debug connection failed"));
  }

  #die(reason: string): void {
    if (this.#dead) return;
    this.#dead = reason;
    for (const [id, pending] of this.#pending) {
      this.#pending.delete(id);
      pending.reject(new BridgeError(reason));
    }
  }

  /** Whether this bridge can still be used. Callers can reconnect rather than retry into a wall. */
  get alive(): boolean {
    return this.#dead === null;
  }

  static async connect(webSocketDebuggerUrl: string, timeoutMs = 5000): Promise<CdpBridge> {
    const ws = new WebSocket(webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new BridgeError("CDP connect timed out")), timeoutMs);
      ws.addEventListener("open", () => {
        clearTimeout(timer);
        resolve();
      });
      ws.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new BridgeError(`CDP connect failed: ${webSocketDebuggerUrl}`));
      });
    });
    return new CdpBridge(ws);
  }

  #onMessage(data: string): void {
    let msg: { id?: number; result?: Json; error?: { message: string } };
    try {
      msg = JSON.parse(data);
    } catch {
      return; // CDP events we do not care about
    }
    if (msg.id === undefined) return;
    const pending = this.#pending.get(msg.id);
    if (!pending) return;
    this.#pending.delete(msg.id);
    if (msg.error) pending.reject(new BridgeError(`CDP error: ${msg.error.message}`));
    else pending.resolve(msg.result ?? null);
  }

  #send<T>(method: string, params: Record<string, Json>, timeoutMs = 30_000): Promise<T> {
    // Fail now rather than in 30 seconds. A caller that reconnects can only do so if it is told.
    if (this.#dead) return Promise.reject(new BridgeError(this.#dead));
    const id = this.#nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new BridgeError(`CDP ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.#pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          // SAFETY: the pending map is keyed by request id, and T is the result type the caller
          // named for that exact CDP method. Nothing else can resolve this entry.
          resolve(v as T);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.#ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async eval<T = unknown>(js: string): Promise<T> {
    const result = await this.#send<{
      result: { type: string; value?: string };
      exceptionDetails?: { text: string };
    }>("Runtime.evaluate", {
      expression: wrapExpression(js),
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) {
      throw new BridgeError(`CDP evaluate threw: ${result.exceptionDetails.text}`);
    }
    const value = result.result?.value;
    if (typeof value !== "string") {
      throw new BridgeError("expected a JSON string from the game", result.result);
    }
    return unwrap<T>(value);
  }

  async close(): Promise<void> {
    this.#die("this bridge was closed");
    this.#ws.close();
  }
}
