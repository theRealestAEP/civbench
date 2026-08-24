// Finding the game's debug bridge (docs/PLAN.md §3.1).
//
// The port is not a literal in the binary, so guessing from a candidate list is unreliable. On a
// machine where we can see the process, asking the OS which ports it listens on is exact.
import { execFileSync } from "node:child_process";

export function findGamePids(pattern = "CivilizationVII"): number[] {
  try {
    return execFileSync("pgrep", ["-f", pattern], { encoding: "utf8" })
      .split("\n")
      .map((l) => Number(l.trim()))
      .filter((n) => Number.isInteger(n) && n > 0);
  } catch {
    return [];
  }
}

/** TCP ports the given process is listening on. macOS/Linux, via lsof. */
export function listeningPorts(pid: number): number[] {
  try {
    const out = execFileSync(
      "lsof",
      ["-nP", "-iTCP", "-sTCP:LISTEN", "-a", "-p", String(pid)],
      { encoding: "utf8" },
    );
    const ports = new Set<number>();
    for (const line of out.split("\n").slice(1)) {
      const m = /:(\d+)\s*\(LISTEN\)/.exec(line);
      if (m) ports.add(Number(m[1]));
    }
    return [...ports].sort((a, b) => a - b);
  } catch {
    return [];
  }
}

/** Every port the running game listens on. Empty if the game is not up. */
export function gameListeningPorts(): number[] {
  const ports = new Set<number>();
  for (const pid of findGamePids()) for (const port of listeningPorts(pid)) ports.add(port);
  return [...ports].sort((a, b) => a - b);
}
