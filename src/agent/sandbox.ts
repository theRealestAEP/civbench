// The agent sandbox (docs/PLAN.md §9.1).
//
// The agent gets a shell, its own run directory, a scratch space, and one command. Containment
// is structural rather than policed:
//   - another agent's directory is not mounted, so it is unaddressable rather than unreadable
//   - events.jsonl is not mounted
//   - /run is a read-only VFS, so the agent cannot doctor its own record
//   - no fetch handler is registered, so the sandbox has no network at all
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, normalize } from "node:path";
import { Sandbox } from "@tinysandbox/tinysandbox";
import { grep, headTail, printf, sed as sedCmd, find as findCmd, type Call, type Output } from "./tools.ts";
import type { CommandCall, CommandOutput, MountOptions } from "@tinysandbox/tinysandbox";
import { createReadOnlyVfs } from "./readonly-vfs.ts";
import { runCivCommand } from "../cli/civ.ts";
import { expandGlobs } from "./globs.ts";
import type { MatchServer } from "../server/match.ts";

export type ExecResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
  /** True when a `civ end-turn` in this command actually ended the turn. */
  turnEnded?: boolean;
  /** True when the session is closed — the turn is over and the brain must stop. */
  turnOver?: boolean;
};

export type SandboxSession = {
  sandbox: Sandbox;
  exec: (command: string) => Promise<ExecResult>;
  /** How many commands have run, readable even after a timeout discarded the brain's report. */
  commandsRun: () => number;
  close: () => void;
};

export function createAgentSandbox(
  server: MatchServer,
  playerId: number,
  notesDir: string,
  lastHud: () => string,
): SandboxSession {
  const runDir = server.agentDir(playerId);
  const turnDir = server.currentTurnDir(playerId);

  /**
   * Tools the sandbox does not ship but agents reach for anyway.
   *
   * Probing the shell showed `cut`, `tr`, and `test` missing, and no `/dev/null` at all — so the
   * near-universal `2>/dev/null` idiom failed with "No such file or directory". Every one of
   * those costs an agent a wasted command and a confusing error, which is the §7 handicap in
   * miniature: it measures our sandbox, not the model.
   */
  const text = (buf: Buffer | string) => (typeof buf === "string" ? buf : buf.toString("utf8"));

  /** `1,3` and `1-3` field lists — the range form silently produced empty columns before. */
  const parseFields = (spec: string): number[] => {
    const out: number[] = [];
    for (const part of spec.split(",")) {
      const range = /^(\d+)-(\d+)$/.exec(part);
      if (range) {
        for (let f = Number(range[1]); f <= Number(range[2]); f++) out.push(f);
      } else if (/^\d+$/.test(part)) {
        out.push(Number(part));
      }
    }
    return out;
  };

  const cut = (call: CommandCall): CommandOutput => {
    const args = call.args;
    let delim = "\t";
    let fields: number[] = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "-d") delim = args[++i] ?? "\t";
      else if (args[i]?.startsWith("-d")) delim = args[i]!.slice(2);
      else if (args[i] === "-f") fields = parseFields(args[++i] ?? "");
      else if (args[i]?.startsWith("-f")) fields = parseFields(args[i]!.slice(2));
    }
    const file = args.find((a, i) => !a.startsWith("-") && args[i - 1] !== "-d" && args[i - 1] !== "-f");
    const body = file ? readMount(file) : text(call.stdin);
    if (body === null) return { exitCode: 1, stderr: `cut: ${file}: No such file or directory\n` };
    const out = body
      .split("\n")
      .filter((l) => l.length > 0)
      .map((line) => {
        const parts = line.split(delim);
        return fields.map((f) => parts[f - 1] ?? "").join(delim);
      })
      .join("\n");
    return { exitCode: 0, stdout: out + "\n" };
  };

  /** Expand `a-z` ranges — `tr 'a-z' 'A-Z'` silently left most letters unchanged without it. */
  const expandRanges = (s: string): string => {
    let out = "";
    for (let i = 0; i < s.length; i++) {
      if (s[i + 1] === "-" && i + 2 < s.length) {
        const from = s.charCodeAt(i);
        const to = s.charCodeAt(i + 2);
        if (to >= from) {
          for (let c = from; c <= to; c++) out += String.fromCharCode(c);
          i += 2;
          continue;
        }
      }
      out += s[i];
    }
    return out;
  };

  const tr = (call: CommandCall): CommandOutput => {
    const flags = call.args.filter((a) => a.startsWith("-"));
    const [from, to] = call.args.filter((a) => !a.startsWith("-"));
    const body = text(call.stdin);
    if (from === undefined) return { exitCode: 1, stderr: "tr: missing operand\n" };
    const unescape = (s: string) => s.replace(/\\n/g, "\n").replace(/\\t/g, "\t");
    const src = expandRanges(unescape(from));
    // `-d` deletes the matched set; it worked before only by the accident of an empty dst.
    const dst = flags.includes("-d") ? "" : expandRanges(unescape(to ?? ""));
    let out = "";
    for (const ch of body) {
      const at = src.indexOf(ch);
      out += at >= 0 ? (dst[at] ?? dst[dst.length - 1] ?? "") : ch;
    }
    return { exitCode: 0, stdout: out };
  };

  /**
   * `test -f` / `-e` / `-d`.
   *
   * `-d` used to run the same readMount() as `-f`, and readFileSync on a directory throws — so
   * `test -d` was ALWAYS false. An agent checking whether a directory existed before reading it
   * got told "no" every time, for directories that were right there.
   */
  // eslint-disable-next-line complexity -- test(1)'s operator table: one branch per operator, each one line.
  const test = (call: CommandCall): CommandOutput => {
    // `[ ... ]` is the same command with a closing bracket; strip it.
    const args = [...call.args];
    if (args.at(-1) === "]") args.pop();
    // String and numeric comparisons, which agents write reflexively in conditionals.
    if (args.length === 3) {
      const [a, op, b] = args as [string, string, string];
      if (op === "=" || op === "==") return { exitCode: a === b ? 0 : 1 };
      if (op === "!=") return { exitCode: a !== b ? 0 : 1 };
      const numeric: Record<string, (x: number, y: number) => boolean> = {
        "-eq": (x, y) => x === y, "-ne": (x, y) => x !== y,
        "-lt": (x, y) => x < y, "-le": (x, y) => x <= y,
        "-gt": (x, y) => x > y, "-ge": (x, y) => x >= y,
      };
      const cmp = numeric[op];
      if (cmp) return { exitCode: cmp(Number(a), Number(b)) ? 0 : 1 };
    }
    const [flag, target] = args;
    if (flag === "-n") return { exitCode: (target ?? "").length > 0 ? 0 : 1 };
    if (flag === "-z") return { exitCode: (target ?? "").length === 0 ? 0 : 1 };
    if (!target) return { exitCode: 1 };
    const host = hostPathOf(target);
    if (!host) return { exitCode: 1 };
    let stats;
    try {
      stats = statSync(host);
    } catch {
      return { exitCode: 1 };
    }
    if (flag === "-d") return { exitCode: stats.isDirectory() ? 0 : 1 };
    if (flag === "-f") return { exitCode: stats.isFile() ? 0 : 1 };
    if (flag === "-s") return { exitCode: stats.isFile() && stats.size > 0 ? 0 : 1 };
    if (flag === "-e") return { exitCode: 0 };
    return { exitCode: 1 };
  };

  /**
   * Map a sandbox path onto the host directory backing its mount.
   *
   * Two rules the first version missed, each verified live:
   *   - A RELATIVE path resolves against /current (the working directory). It used to resolve
   *     against nothing, so `grep x tiles.txt` silently read no file and printed "no matches".
   *   - `..` cannot escape a mount. `join` normalises it, so `/run/../../events.jsonl` walked
   *     out of the mount and read the event log agents must never see (§9.1). Normalise first
   *     and require the result to stay under the mount's prefix.
   */
  const hostPathOf = (path: string): string | null => {
    const roots: Array<[string, string]> = [
      ["/current", turnDir ?? ""],
      ["/run", runDir],
      ["/notes", notesDir],
    ];
    const absolute = path.startsWith("/") ? path : `/current/${path}`;
    const clean = normalize(absolute);
    for (const [prefix, root] of roots) {
      if (!root) continue;
      if (clean !== prefix && !clean.startsWith(prefix + "/")) continue;
      return join(root, clean.slice(prefix.length));
    }
    return null;
  };

  /** Read a path from whichever mount it belongs to, or null if it is not there. */
  const readMount = (path: string): string | null => {
    const host = hostPathOf(path);
    if (!host) return null;
    try {
      return readFileSync(host, "utf8");
    } catch {
      return null;
    }
  };

  /** Directory entries for glob expansion, via the same mount mapping reads use. */
  const listMount = (dir: string): string[] | null => {
    const host = hostPathOf(dir === "." ? "/current" : dir);
    if (!host) return null;
    try {
      return readdirSync(host);
    } catch {
      return null;
    }
  };

  // Set when a `civ end-turn` inside the CURRENT exec actually ended the turn. The brain used to
  // infer this from the whole compound command's exit code, which is the LAST segment's — so
  // `civ end-turn; civ hud` with a refused end-turn read as "turn ended" and the agent was
  // aborted mid-decision.
  let turnEndedThisExec = false;
  const civ = async (call: CommandCall): Promise<CommandOutput> => {
    // call.args excludes the command name, so it is already the argument list.
    const result = await runCivCommand(server, playerId, call.args, lastHud);
    if (call.args[0] === "end-turn" && result.exitCode === 0) turnEndedThisExec = true;
    return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
  };

  // Built as its own binding so the omission is visible. A conditional spread of `{}` reads as
  // "sometimes there is nothing here" without saying which key it is that goes missing.
  const currentMount: Record<string, MountOptions> = turnDir
    ? { current: { type: "custom", vfs: createReadOnlyVfs(turnDir) } }
    : {};

  const sandbox = new Sandbox({
    cwd: "/current",
    persistSession: false, // a fresh process each turn (§9.3)
    // Mount names are single path components; they appear at the sandbox root as /run and /notes.
    mounts: {
      // Read-only: the dump, rules/, index.md, and every past turn.
      run: { type: "custom", vfs: createReadOnlyVfs(runDir) },
      // This turn's files, so nothing has to guess a path or parse `ls`. Added below rather than
      // spread conditionally: an empty spread hides which key is being omitted.
      ...currentMount,
      // The only writable place. notes.md is the agent's memory between turns (§8).
      notes: { type: "local", root: notesDir },
      // `2>/dev/null` is reflex for anyone who has used a shell. Without a /dev to redirect
      // into, it fails with "No such file or directory" and costs the agent a command.
      dev: { type: "memory" },
    },
    // These shadow the built-ins, which reject flags agents reach for constantly (-E, -A, -50).
    commands: {
      civ,
      cut,
      tr,
      test,
      // `[ -f x ]` is how everyone writes test; without this it was command-not-found.
      "[": test,
      grep: grep(hostPathOf),
      head: headTail(hostPathOf, "head"),
      tail: headTail(hostPathOf, "tail"),
      printf: printf(),
      find: findCmd(hostPathOf),
      // The briefing lists `sed`; the sandbox only ever handled `s///`, so the two commonest
      // shapes — `sed -n '1,20p'` and `sed 3d` — failed on a tool agents were told they had.
      sed: sedCmd(readMount),
    },
    env: { HOME: "/notes", PLAYER: String(playerId) },
  });

  let commands = 0;
  let closed = false;

  return {
    sandbox,
    exec: async (command: string) => {
      // A closed session refuses everything. withTimeout races but never cancels, so a timed-out
      // brain kept acting into the NEXT seat's turn — rewriting its files from reads taken under
      // the wrong local player, and appending notes. The brain reads `turnOver` and stops.
      if (closed) {
        return {
          stdout: "",
          stderr: "your turn is over — the game has moved on\n",
          exitCode: 1,
          turnOver: true,
        };
      }
      commands++;
      // Settle the dump before ANY command, not just `civ`.
      //
      // The engine applies a request asynchronously, so the refresh straight after an action often
      // captures the state before it. Hooking this to `civ` alone missed the common case: an agent
      // acts, then reads the result with `grep` or `cat`. One did exactly that, saw its move had
      // not changed `moves=`, and spent its turn wondering whether unit ids had changed underneath
      // it. Nothing happens when the dump is already current, so this costs nothing per read.
      await server.settleDump(playerId).catch(() => undefined);
      turnEndedThisExec = false;
      // `cd /current` first: the Sandbox cwd option does not take effect (probed: pwd prints /),
      // and the briefing promises relative reads from /current. Globs are expanded here rather
      // than inside the sandbox, which has no concept of them.
      const result = await sandbox.exec("cd /current 2>/dev/null; " + expandGlobs(command, listMount));
      return {
        stdout: String(result.stdout ?? ""),
        stderr: String(result.stderr ?? ""),
        exitCode: result.exitCode ?? 0,
        turnEnded: turnEndedThisExec,
      };
    },
    commandsRun: () => commands,
    close: () => {
      closed = true;
    },
  };
}
