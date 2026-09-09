// What is silently failing? Run this after every match.
//
//   npm run audit              every run in runs/
//   npm run audit -- <runDir>  one run
//
// This exists because a bug that made EVERY BUILDING SILENTLY FAIL survived for the life of the
// project. It was visible in one screenshot the moment a human looked — an agent saying "it's a
// bit frustrating to not have clarity" — and invisible in the aggregate numbers everyone kept
// reading, because "some builds fail" looks like ordinary noise. Segmenting the same events by
// ARGUMENT KIND made it unmissable: every UNIT_* build succeeded, every BUILDING_* failed.
//
// So the rule this tool encodes: never look at a failure rate without asking "of what, exactly?"
// and never trust an `ok` that the agent had to issue twice.
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { PendingItem } from "../src/dump/types.ts";
import type { Event } from "../src/server/events.ts";

type Bucket = { ok: number; fail: number; codes: Map<string, number> };

const bucket = (): Bucket => ({ ok: 0, fail: 0, codes: new Map() });
const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);

function readEvents(runDir: string): Event[] {
  const path = join(runDir, "events.jsonl");
  if (!existsSync(path)) return [];
  // SAFETY: this harness's own append-only log, one Event per line.
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Event);
}

/**
 * The key an action is grouped under.
 *
 * The ARGUMENT KIND is the whole point: `build` alone hides that units work and buildings do
 * not, because they are the same action type with different arguments.
 */
function keyOf(event: Event): string {
  const type = event.request?.actionType ?? "?";
  const thing = event.request?.args?.thing;
  if (typeof thing !== "string") return type;
  const kind = thing.includes("_") ? thing.slice(0, thing.indexOf("_")) : thing;
  return `${type}:${kind}`;
}

export type Finding = { severity: "high" | "medium"; what: string; detail: string };

function auditScreens(runDir: string): Finding[] {
  const findings: Finding[] = [];
  // A screen can be inaccessible without any failed action. Inspect the saved observations.
  const agentsDir = join(runDir, "agents");
  const gaps = new Map<string, string>();
  if (existsSync(agentsDir)) {
    for (const agent of readdirSync(agentsDir)) {
      const turnsDir = join(agentsDir, agent, "turns");
      if (!existsSync(turnsDir)) continue;
      for (const turn of readdirSync(turnsDir)) {
        const file = join(turnsDir, turn, "pending.jsonl");
        if (!existsSync(file)) continue;
        for (const line of readFileSync(file, "utf8").split("\n").filter(Boolean)) {
          // SAFETY: pending.jsonl is written from the adapter's PendingItem records.
          const item = JSON.parse(line) as PendingItem;
          if (!item.type?.startsWith("SCREEN_")) continue;
          const issues = [...(item.interfaceGaps ?? [])];
          if (!item.message) issues.push("screen text missing");
          if (!item.controls?.length) issues.push("screen controls missing");
          for (const issue of issues) gaps.set(`${item.type}: ${issue}`, file);
        }
      }
    }
  }
  for (const [what, file] of gaps) findings.push({ severity: "high", what, detail: file });
  return findings;
}

export function auditRun(runDir: string): Finding[] {
  const events = readEvents(runDir);
  const findings: Finding[] = [];

  findings.push(...auditScreens(runDir));
  for (const e of events) {
    if (e.kind === "interface_gap") findings.push({
      severity: "high", what: e.message ?? "interface gap", detail: `${e.playerName} turn ${e.turn}`,
    });
    if (e.result?.code === "SCREEN_INPUT_IGNORED") findings.push({
      severity: "high", what: "screen activation was ignored", detail: `${e.playerName} turn ${e.turn}`,
    });
  }
  // 1. Actions that fail far more often than they work, grouped by argument kind.
  const byKey = new Map<string, Bucket>();
  for (const e of events) {
    if (e.kind !== "action") continue;
    const b = byKey.get(keyOf(e)) ?? bucket();
    if (e.result?.ok) b.ok++;
    else {
      b.fail++;
      bump(b.codes, e.result?.code ?? "?");
    }
    byKey.set(keyOf(e), b);
  }
  for (const [key, b] of byKey) {
    const total = b.ok + b.fail;
    if (total < 3) continue;
    const rate = b.fail / total;
    if (rate < 0.5) continue;
    const codes = [...b.codes].sort((a, c) => c[1] - a[1]).slice(0, 2).map(([c, n]) => `${c} x${n}`).join(", ");
    findings.push({
      severity: rate === 1 ? "high" : "medium",
      what: `${key} fails ${Math.round(rate * 100)}% (${b.fail}/${total})`,
      detail: codes,
    });
  }

  // 2. The dangerous class: reported ok, then contradicted by the harness's own re-check.
  const corrections = new Map<string, number>();
  for (const e of events) {
    if (e.kind === "action_correction") bump(corrections, e.code ?? "?");
  }
  for (const [code, n] of corrections) {
    if (n < 3) continue;
    findings.push({
      severity: "high",
      what: `${n} actions reported ok and were then contradicted (${code})`,
      detail: "an ok that the harness itself had to take back — the agent was told two things",
    });
  }

  // 3. The same order issued twice in one turn and "succeeding" both times: a no-op the agent
  //    could not tell had failed, so it tried again. This is how the building bug looked from
  //    the inside, for months, in plain sight.
  const repeats = new Map<string, number>();
  const perTurn = new Map<string, boolean[]>();
  for (const e of events) {
    if (e.kind !== "action") continue;
    const thing = e.request?.args?.thing;
    if (typeof thing !== "string") continue;
    const k = `${e.turn}|${e.playerName}|${e.request?.actionType}|${thing}`;
    const list = perTurn.get(k) ?? [];
    list.push(e.result?.ok === true);
    perTurn.set(k, list);
  }
  for (const [k, list] of perTurn) {
    if (list.filter(Boolean).length < 2) continue;
    const [, , type, thing] = k.split("|");
    bump(repeats, `${type}:${thing}`);
  }
  for (const [what, n] of [...repeats].sort((a, b) => b[1] - a[1]).slice(0, 8)) {
    findings.push({
      severity: "high",
      what: `${what} reported ok twice in one turn, ${n} times`,
      detail: "a successful order the agent repeated — it could not see any effect",
    });
  }

  // 4. End-turn blockers with no answer, which strand a seat until the harness forces past it.
  const blockers = new Map<string, number>();
  for (const e of events) {
    if ((e.kind === "turn_end" || e.kind === "turn_end_forced") && e.ok === false && e.blocking) {
      bump(blockers, e.blocking);
    }
  }
  for (const [name, n] of [...blockers].sort((a, b) => b[1] - a[1])) {
    if (n < 20) continue;
    findings.push({
      severity: n > 100 ? "high" : "medium",
      what: `${name} blocked the end of a turn ${n} times`,
      detail: "check src/dump/required.ts has a real answer for it, not a placeholder",
    });
  }

  return findings;
}

const target = process.argv[2];
const runs = target
  ? [target]
  : existsSync("runs")
    ? readdirSync("runs").map((d) => join("runs", d)).filter((d) => existsSync(join(d, "events.jsonl")))
    : [];

if (runs.length === 0) {
  console.log("no runs to audit");
  process.exit(0);
}

// Findings are pooled across runs when auditing everything: a bug that appears once per match
// in ten matches is one bug, and reading it ten times hides that.
const pooled = new Map<string, Finding>();
for (const run of runs) {
  for (const f of auditRun(run)) {
    const key = f.what.replace(/\d+/g, "N");
    if (!pooled.has(key)) pooled.set(key, f);
  }
}

const order = { high: 0, medium: 1 };
const sorted = [...pooled.values()].sort((a, b) => order[a.severity] - order[b.severity]);
console.log(`audited ${runs.length} run(s), ${sorted.length} finding(s)\n`);
for (const f of sorted) {
  console.log(`[${f.severity.toUpperCase()}] ${f.what}`);
  if (f.detail) console.log(`         ${f.detail}`);
}
if (sorted.length === 0) console.log("no findings from the recorded actions and popup snapshots; unvisited interfaces remain unverified");
