// The agent sandbox (docs/PLAN.md §9.1).
//
// The agent gets a shell, its own run directory, a scratch space, and one command. Containment
// is structural rather than policed:
//   - another agent's directory is not mounted, so it is unaddressable rather than unreadable
//   - events.jsonl is not mounted
//   - /run is a read-only VFS, so the agent cannot doctor its own record
//   - no fetch handler is registered, so the sandbox has no network at all
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Sandbox } from "@tinysandbox/tinysandbox";
import { grep, headTail, printf, find as findCmd, type Call, type Output } from "./tools.ts";
import type { CommandCall, CommandOutput } from "@tinysandbox/tinysandbox";
import { createReadOnlyVfs } from "./readonly-vfs.ts";
import { runCivCommand } from "../cli/civ.ts";
import { expandGlobs } from "./globs.ts";
import type { MatchServer } from "../server/match.ts";

export type SandboxSession = {
  sandbox: Sandbox;
  exec: (command: string) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
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

  const cut = (call: CommandCall): CommandOutput => {
    const args = call.args;
    let delim = "\t";
    let fields: number[] = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "-d") delim = args[++i] ?? "\t";
      else if (args[i]?.startsWith("-d")) delim = args[i]!.slice(2);
      else if (args[i] === "-f") fields = (args[++i] ?? "").split(",").map(Number);
      else if (args[i]?.startsWith("-f")) fields = args[i]!.slice(2).split(",").map(Number);
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

  const tr = (call: CommandCall): CommandOutput => {
    const [from, to] = call.args.filter((a) => !a.startsWith("-"));
    const body = text(call.stdin);
    if (from === undefined) return { exitCode: 1, stderr: "tr: missing operand\n" };
    const unescape = (s: string) => s.replace(/\\n/g, "\n").replace(/\\t/g, "\t");
    const src = unescape(from);
    const dst = unescape(to ?? "");
    let out = "";
    for (const ch of body) {
      const at = src.indexOf(ch);
      out += at >= 0 ? (dst[at] ?? dst[dst.length - 1] ?? "") : ch;
    }
    return { exitCode: 0, stdout: out };
  };

  const test = (call: CommandCall): CommandOutput => {
    const args = call.args;
    const flag = args[0];
    const target = args[1];
    if ((flag === "-f" || flag === "-e" || flag === "-d") && target) {
      return { exitCode: readMount(target) === null ? 1 : 0 };
    }
    return { exitCode: 1 };
  };

  /** Map a sandbox path onto the host directory backing its mount. */
  const hostPathOf = (path: string): string | null => {
    const roots: Array<[string, string]> = [
      ["/current", turnDir ?? ""],
      ["/run", runDir],
      ["/notes", notesDir],
    ];
    for (const [prefix, root] of roots) {
      if (!root || !path.startsWith(prefix)) continue;
      return join(root, path.slice(prefix.length));
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

  const civ = async (call: CommandCall): Promise<CommandOutput> => {
    // call.args excludes the command name, so it is already the argument list.
    const result = await runCivCommand(server, playerId, call.args, lastHud);
    return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
  };

  const sandbox = new Sandbox({
    cwd: "/current",
    persistSession: false, // a fresh process each turn (§9.3)
    // Mount names are single path components; they appear at the sandbox root as /run and /notes.
    mounts: {
      // Read-only: the dump, rules/, index.md, and every past turn.
      run: { type: "custom", vfs: createReadOnlyVfs(runDir) },
      // This turn's files, so nothing has to guess a path or parse `ls`.
      ...(turnDir ? { current: { type: "custom" as const, vfs: createReadOnlyVfs(turnDir) } } : {}),
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
      grep: grep(hostPathOf),
      head: headTail(hostPathOf, "head"),
      tail: headTail(hostPathOf, "tail"),
      printf: printf(),
      find: findCmd(hostPathOf),
    },
    env: { HOME: "/notes", PLAYER: String(playerId) },
  });

  return {
    sandbox,
    exec: async (command: string) => {
      // Globs are expanded here rather than inside the sandbox, which has no concept of them.
      const result = await sandbox.exec(expandGlobs(command, listMount));
      return {
        stdout: String(result.stdout ?? ""),
        stderr: String(result.stderr ?? ""),
        exitCode: result.exitCode ?? 0,
      };
    },
    close: () => {
      // tinysandbox holds no OS handles beyond our VFS; dropping the reference is enough.
    },
  };
}
