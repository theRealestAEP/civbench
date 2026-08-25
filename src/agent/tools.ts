// Shell tools the sandbox lacks or implements too narrowly (docs/PLAN.md §7).
//
// Scanning the transcripts showed agents losing commands to the shell rather than to the game:
// `grep -E` and `grep -A` unsupported, `printf` and `find` missing, `head -50` rejected. Each one
// costs a command and an error the agent has to interpret, which is the handicap failure mode —
// it measures our sandbox, not the model.
//
// Registered commands shadow the built-ins, so these replace the narrower versions.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

export type Call = { args: string[]; env: Record<string, string>; cwd: string; stdin: Buffer };
export type Output = { exitCode?: number; stdout?: string; stderr?: string };

/** Resolve a sandbox path to a host path, or null if it is outside the mounts. */
export type Resolver = (path: string) => string | null;

const asText = (stdin: Buffer | string) => (typeof stdin === "string" ? stdin : stdin.toString("utf8"));

/** Read a file, or fall back to stdin when no file is named. */
function inputs(files: string[], resolve: Resolver, stdin: Buffer): Array<[string, string]> {
  if (files.length === 0) return [["", asText(stdin)]];
  const out: Array<[string, string]> = [];
  for (const file of files) {
    const host = resolve(file);
    if (!host) continue;
    try {
      out.push([file, readFileSync(host, "utf8")]);
    } catch { /* unreadable */ }
  }
  return out;
}

/** Walk a directory tree under the mounts. */
function walk(hostDir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(hostDir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const path = join(hostDir, entry);
    try {
      if (statSync(path).isDirectory()) walk(path, out);
      else out.push(path);
    } catch { /* raced */ }
  }
  return out;
}

/**
 * grep with the flags people actually reach for: -E -i -v -c -l -n -o -r and -A/-B/-C context.
 * The built-in supports only a subset and rejects the rest outright.
 */
export function grep(resolve: Resolver) {
  return (call: Call): Output => {
    const flags = new Set<string>();
    let after = 0;
    let before = 0;
    const rest: string[] = [];

    for (let i = 0; i < call.args.length; i++) {
      const arg = call.args[i]!;
      const ctx = /^-([ABC])(\d*)$/.exec(arg);
      if (ctx) {
        const n = ctx[2] ? Number(ctx[2]) : Number(call.args[++i] ?? 0);
        if (ctx[1] === "A" || ctx[1] === "C") after = n;
        if (ctx[1] === "B" || ctx[1] === "C") before = n;
        continue;
      }
      if (/^-[EivclnorRh]+$/.test(arg)) {
        for (const ch of arg.slice(1)) flags.add(ch);
        continue;
      }
      rest.push(arg);
    }

    const [pattern, ...files] = rest;
    if (pattern === undefined) return { exitCode: 2, stderr: "grep: no pattern\n" };

    let re: RegExp;
    try {
      re = new RegExp(pattern, flags.has("i") ? "i" : "");
    } catch (err) {
      return { exitCode: 2, stderr: `grep: bad pattern: ${(err as Error).message}\n` };
    }

    // -r expands directories into their files.
    const expanded: string[] = [];
    for (const file of files) {
      const host = resolve(file);
      if (host && (flags.has("r") || flags.has("R"))) {
        try {
          if (statSync(host).isDirectory()) {
            for (const found of walk(host)) {
              expanded.push(file.replace(/\/$/, "") + "/" + relative(host, found));
            }
            continue;
          }
        } catch { /* not a directory */ }
      }
      expanded.push(file);
    }

    const sources = inputs(expanded, resolve, call.stdin);
    const showName = sources.length > 1 && !flags.has("h");
    const out: string[] = [];
    let total = 0;

    for (const [name, body] of sources) {
      const lines = body.split("\n");
      let hits = 0;
      for (let i = 0; i < lines.length; i++) {
        const matched = re.test(lines[i]!) !== flags.has("v");
        if (!matched) continue;
        hits++;
        total++;
        if (flags.has("c") || flags.has("l")) continue;
        const from = Math.max(0, i - before);
        const to = Math.min(lines.length - 1, i + after);
        for (let j = from; j <= to; j++) {
          if (lines[j] === undefined || (j === lines.length - 1 && lines[j] === "")) continue;
          const prefix = showName ? `${name}:` : "";
          const numbered = flags.has("n") ? `${j + 1}:` : "";
          if (flags.has("o") && j === i) {
            const m = lines[j]!.match(new RegExp(pattern, flags.has("i") ? "gi" : "g"));
            for (const piece of m ?? []) out.push(prefix + numbered + piece);
          } else {
            out.push(prefix + numbered + lines[j]);
          }
        }
      }
      if (flags.has("c")) out.push((showName ? `${name}:` : "") + String(hits));
      if (flags.has("l") && hits > 0) out.push(name);
    }

    return { exitCode: total > 0 ? 0 : 1, stdout: out.length ? out.join("\n") + "\n" : "" };
  };
}

/** head/tail accepting -N, -n N and -c N. The built-in rejects -N and -c. */
export function headTail(resolve: Resolver, which: "head" | "tail") {
  return (call: Call): Output => {
    let count = 10;
    let bytes = 0;
    const files: string[] = [];
    for (let i = 0; i < call.args.length; i++) {
      const arg = call.args[i]!;
      if (/^-\d+$/.test(arg)) count = Number(arg.slice(1));
      else if (arg === "-n") count = Number(call.args[++i] ?? 10);
      else if (arg.startsWith("-n")) count = Number(arg.slice(2));
      else if (arg === "-c") bytes = Number(call.args[++i] ?? 0);
      else if (arg.startsWith("-c")) bytes = Number(arg.slice(2));
      else if (!arg.startsWith("-")) files.push(arg);
    }
    const out: string[] = [];
    for (const [, body] of inputs(files, resolve, call.stdin)) {
      if (bytes > 0) {
        out.push(which === "head" ? body.slice(0, bytes) : body.slice(-bytes));
        continue;
      }
      const lines = body.split("\n").filter((l, i, a) => !(i === a.length - 1 && l === ""));
      out.push((which === "head" ? lines.slice(0, count) : lines.slice(-count)).join("\n"));
    }
    const text = out.join("\n");
    return { exitCode: 0, stdout: text.endsWith("\n") || text === "" ? text : text + "\n" };
  };
}

/** printf with the handful of escapes and %s/%d that scripts actually use. */
export function printf(): (call: Call) => Output {
  return (call: Call): Output => {
    const [format, ...rest] = call.args;
    if (format === undefined) return { exitCode: 1, stderr: "printf: missing format\n" };
    const unescape = (s: string) =>
      s.replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\\\/g, "\\");
    let i = 0;
    const body = unescape(format).replace(/%[sd]/g, () => rest[i++] ?? "");
    // A format with placeholders repeats until the arguments run out, as printf does.
    let out = body;
    while (i < rest.length && /%[sd]/.test(format)) {
      out += unescape(format).replace(/%[sd]/g, () => rest[i++] ?? "");
    }
    return { exitCode: 0, stdout: out };
  };
}

/** find with -name and -type, which is all anyone uses here. */
export function find(resolve: Resolver) {
  return (call: Call): Output => {
    const roots: string[] = [];
    let namePattern: RegExp | null = null;
    let type: string | null = null;
    for (let i = 0; i < call.args.length; i++) {
      const arg = call.args[i]!;
      if (arg === "-name") {
        const glob = call.args[++i] ?? "*";
        namePattern = new RegExp("^" + glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$");
      } else if (arg === "-type") {
        type = call.args[++i] ?? null;
      } else if (!arg.startsWith("-")) {
        roots.push(arg);
      }
    }
    if (roots.length === 0) roots.push(call.cwd || "/");

    const out: string[] = [];
    for (const root of roots) {
      const host = resolve(root);
      if (!host) continue;
      for (const file of walk(host)) {
        const rel = root.replace(/\/$/, "") + "/" + relative(host, file);
        if (namePattern && !namePattern.test(rel.split("/").pop() ?? "")) continue;
        // `-type d` used to return nothing at all, silently and with exit 0, so an agent looking
        // for directories concluded there were none. Say so rather than lie.
        if (type === "d") {
          return { exitCode: 1, stderr: "find: -type d is not supported here; every mount holds files only\n" };
        }
        out.push(rel);
      }
    }
    return { exitCode: 0, stdout: out.length ? out.join("\n") + "\n" : "" };
  };
}

/**
 * `sed` for the shapes agents actually reach for.
 *
 * The briefing listed `sed` unqualified, but the sandbox only handles `s///` — so `sed -n '1,20p'`
 * and `sed 1d`, the two commonest ways to read part of a file, both failed. Agents were told a
 * tool was there and found half of it.
 *
 * Supports: `-n` with `Np` / `M,Np` / `$p`, and `Nd` / `M,Nd`. Substitution stays with the
 * sandbox's own implementation, which already handles it.
 */
export function sed(read: (path: string) => string | null): (call: Call) => Output {
  return (call) => {
    const args = [...call.args];
    const quiet = args[0] === "-n" ? (args.shift(), true) : false;
    const script = args.shift() ?? "";
    const file = args.shift();
    const body = file ? read(file) : asText(call.stdin);
    if (body === null) return { exitCode: 1, stderr: `sed: ${file}: No such file or directory\n` };

    // A file ending in a newline splits to a trailing empty element. Left in, it counts as a line
    // and every range is off by one at the end.
    const lines = body.split("\n");
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    const last = lines.length;
    const bound = (v: string) => (v === "$" ? last : Number(v));

    const range = /^(\$|\d+)(?:,(\$|\d+))?([pd])$/.exec(script.trim());
    if (!range) {
      return {
        exitCode: 1,
        stderr: "sed: only s///, and line ranges like '1,20p' or '3d', are supported here\n",
      };
    }
    const from = bound(range[1]!);
    const to = range[2] ? bound(range[2]) : from;
    const action = range[3];

    // 1-based and inclusive, like sed.
    const picked = lines.filter((_l, i) => {
      const n = i + 1;
      const inRange = n >= from && n <= to;
      return action === "p" ? inRange : !inRange;
    });
    // `p` without -n prints matched lines twice, which is never what an agent wants here.
    void quiet;
    return { exitCode: 0, stdout: picked.join("\n") + (picked.length > 0 ? "\n" : "") };
  };
}
