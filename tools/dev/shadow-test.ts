// Can a registered command shadow a built-in? Decides whether we can ship a fuller grep.
import { Sandbox } from "@tinysandbox/tinysandbox";
const sb = new Sandbox({
  mounts: { work: { type: "memory" } },
  commands: {
    grep: () => ({ exitCode: 0, stdout: "SHADOWED\n" }),
    printf: () => ({ exitCode: 0, stdout: "printf works\n" }),
  },
});
for (const cmd of ["grep x /work", "printf hi"]) {
  const r = await sb.exec(cmd);
  console.log(`${cmd.padEnd(14)} -> exit ${r.exitCode}  ${String(r.stdout ?? "").trim() || String(r.stderr ?? "").trim()}`);
}
