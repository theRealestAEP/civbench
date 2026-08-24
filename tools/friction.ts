// What is the harness doing to the agents? (docs/PLAN.md §7)
//
// Every large failure rate in this project has turned out to be a missing file or a wrong lookup
// on our side, found one screenshot at a time. This scans every transcript for the signatures of
// that instead: commands the shell rejected, tools that were not there, and the agent saying out
// loud that something is missing or stale.
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const runsDir = process.argv[2] ?? "runs";
if (!existsSync(runsDir)) {
  console.error(`no ${runsDir}/`);
  process.exit(1);
}

const transcripts: string[] = [];
for (const run of readdirSync(runsDir)) {
  const agents = join(runsDir, run, "agents");
  if (!existsSync(agents)) continue;
  for (const agent of readdirSync(agents)) {
    const turns = join(agents, agent, "turns");
    if (!existsSync(turns)) continue;
    for (const turn of readdirSync(turns)) {
      const path = join(turns, turn, "transcript.md");
      if (existsSync(path)) transcripts.push(readFileSync(path, "utf8"));
    }
  }
}
console.log(`scanned ${transcripts.length} turn transcripts\n`);

const blob = transcripts.join("\n");
const count = (re: RegExp) => (blob.match(re) ?? []).length;

/** Shell-level friction: the sandbox refusing something an agent reasonably tried. */
const shell: Array<[string, RegExp]> = [
  ["command not found", /command not found/g],
  ["unsupported option", /unsupported option/g],
  ["No such file or directory", /No such file or directory/g],
  ["parse error / unsupported syntax", /parse error|unsupported (command substitution|heredoc)/g],
  ["permission denied", /[Pp]ermission denied/g],
];
console.log("shell friction");
for (const [label, re] of shell) {
  const n = count(re);
  if (n > 0) console.log(`  ${String(n).padStart(4)}  ${label}`);
}

/** Game-level friction: the engine or our validator refusing an action. */
console.log("\naction friction");
for (const [label, re] of [
  ["the game refused this action", /the game refused this action/g],
  ["does not exist in this build", /does not exist in this build/g],
  ["not found for p", /not found for p\d/g],
  ["already ended this turn", /already ended this turn/g],
  ["action budget spent", /ACTION_BUDGET_SPENT|used all \d+ actions/g],
] as Array<[string, RegExp]>) {
  const n = count(re);
  if (n > 0) console.log(`  ${String(n).padStart(4)}  ${label}`);
}

/** The agents saying, in their own words, that something is wrong. */
console.log("\nwhat the agents said about it");
const complaints = new Map<string, number>();
for (const line of blob.split("\n")) {
  if (!/^(?!\$)/.test(line)) continue;
  const m = line.match(
    /[^.]*\b(no |not |missing|cannot|can't|couldn't|doesn't|isn't|unavailable|stale|not yet updated|there is no|let me try|instead)\b[^.]*\./i,
  );
  if (!m) continue;
  const text = m[0].trim();
  if (text.length < 24 || text.length > 160) continue;
  if (text.startsWith("$")) continue;
  complaints.set(text, (complaints.get(text) ?? 0) + 1);
}
for (const [text, n] of [...complaints.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14)) {
  console.log(`  ${String(n).padStart(3)}x  ${text}`);
}
