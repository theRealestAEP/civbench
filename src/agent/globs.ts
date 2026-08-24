// Glob expansion for the agent shell.
//
// tinysandbox has none, so `cat /current/*.txt` reached the parser as a literal and failed. The
// briefing answered that by telling agents "NO GLOBS — use find" — which is a workaround printed
// in a prompt, and agents typed globs anyway because every shell they have ever seen has them.
// Supporting the idiom is cheaper than documenting its absence (docs/PLAN.md §7).
//
// Deliberately small: `*` and `?` in the last path segment, which is what agents actually write.
// A pattern that matches nothing is quoted rather than dropped, so it reaches the command as a
// literal and the agent reads "No such file or directory: /current/nothing-*.txt" — sh's own
// behaviour, and it names what they typed. Left bare it would instead hit the sandbox parser and
// come back as "unsupported glob pattern", which is the confusing error we set out to remove.

/** Split a command line into tokens, remembering which ones were quoted. */
function tokenize(line: string): Array<{ text: string; quoted: boolean }> {
  const tokens: Array<{ text: string; quoted: boolean }> = [];
  let current = "";
  let quoted = false;
  let quote: '"' | "'" | null = null;
  let started = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      quoted = true;
      started = true;
      current += ch;
      continue;
    }
    if (ch === " " || ch === "\t") {
      if (started) tokens.push({ text: current, quoted });
      current = "";
      quoted = false;
      started = false;
      continue;
    }
    started = true;
    current += ch;
  }
  if (started) tokens.push({ text: current, quoted });
  return tokens;
}

/** Pass a token through to the shell as a literal. */
function literal(token: string): string {
  return `'${token.replace(/'/g, `'\\''`)}'`;
}

function toRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped.replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]")}$`);
}

/**
 * Expand every unquoted glob in `line`, listing directories with `list`.
 *
 * `list` returns the entry names of a directory, or null when there is no such directory.
 */
export function expandGlobs(line: string, list: (dir: string) => string[] | null): string {
  if (!/[*?]/.test(line)) return line;

  return tokenize(line)
    .map(({ text, quoted }) => {
      if (quoted || !/[*?]/.test(text)) return text;
      const slash = text.lastIndexOf("/");
      const dir = slash < 0 ? "." : text.slice(0, slash) || "/";
      const pattern = text.slice(slash + 1);
      // Only the last segment globs. `/run/turns/*/tiles.txt` is left alone rather than
      // half-expanded, because a wrong expansion is worse than no expansion.
      if (/[*?]/.test(dir)) return literal(text);
      const entries = list(dir);
      if (!entries) return literal(text);
      const re = toRegExp(pattern);
      const hits = entries.filter((name) => re.test(name)).sort();
      if (hits.length === 0) return literal(text);
      const prefix = slash < 0 ? "" : `${text.slice(0, slash)}/`;
      return hits.map((name) => `${prefix}${name}`).join(" ");
    })
    .join(" ");
}
