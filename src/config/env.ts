// Load .env once, at process start.
//
// Node has process.loadEnvFile(), so no dependency is needed. A missing .env is fine — the key
// may already be exported, and the scripted baseline needs no key at all.
import { existsSync } from "node:fs";

let loaded = false;

export function loadEnv(path = ".env"): void {
  if (loaded) return;
  loaded = true;
  if (existsSync(path)) process.loadEnvFile(path);
}

/** Throw early and clearly rather than deep inside a provider call. */
export function requireAnthropicKey(): string {
  return requireKey("ANTHROPIC_API_KEY");
}

export function requireOpenRouterKey(): string {
  return requireKey("OPEN_ROUTER_API_KEY");
}

export function requireKey(name: string): string {
  loadEnv();
  const key = process.env[name];
  if (!key) {
    throw new Error(`${name} is not set. Put it in .env (see .env.example) or export it.`);
  }
  return key;
}
