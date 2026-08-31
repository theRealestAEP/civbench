// Patch the Civ VII engine crash that ends long automated matches.
//
//   npm run patch-crash -- apply
//   npm run patch-crash -- revert
//   npm run patch-crash -- status
//
// THE BUG (docs/FINDINGS.md, docs/crash-evidence/): on the engine's AsyncWorker1 thread, native
// code receives a null fifth argument and later dereferences it as a virtual-call receiver:
//
//   +0xfe99e0  cbz  w3, +0x1204     ; count == 0 -> take the "nothing to do" exit
//   +0xfe99e4  ldr  x8, [x19]       ; x8 = *this   <-- FAULTS when x19 == 0
//   +0xfe99e8  ldr  x8, [x8, #0x120]
//   +0xfe99ec  mov  x0, x19
//   ...        blr  x8
//
// THE FIX: give the null case the SAME exit the empty case already takes. The function is already
// written to handle "there is nothing to dispatch here" — `cbz w3` jumps to +0x1204, which sets
// the result flag to 0 and falls into the normal cleanup path. A null job object is that same
// situation, so this is not an invented behaviour; it is the engine's own.
//
// Mechanically, ARM64 cannot grow an instruction in place, so the patched site branches to a
// cave, the cave does the null test and either returns to the original path or jumps to the
// engine's empty-case exit.
//
// SAFETY RAILS. This edits a vendor binary, so every step refuses rather than guesses:
//   - the exact original bytes must be present, or nothing is written
//   - the cave must be entirely zero bytes inside __text, or nothing is written
//   - a pristine copy is kept outside the app bundle, and `revert` restores it byte for byte
//   - the binary is re-signed ad-hoc afterwards, because an edited signature will not launch
// Steam's "verify integrity of game files" undoes all of this, as does any game patch. That is
// fine: re-run `apply` afterwards, and `status` will tell you which state you are in.
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const BINARY = join(
  homedir(),
  "Library/Application Support/Steam/steamapps/common/Sid Meier's Civilization VII",
  "CivilizationVII.app/Contents/MacOS/CivilizationVII",
);
const LEGACY_BACKUP = `${BINARY}.civbench-original`;
const BACKUP_DIR = join(homedir(), "Library/Application Support/CivBench/patch-backups");
const BACKUP = join(BACKUP_DIR, "CivilizationVII-1.4.2-1290193-original");

/** __TEXT loads at this address, and its file offset equals the virtual offset from it. */
const TEXT_BASE = 0x100000000;
/** The build this was disassembled against. A different size means different offsets. */
const KNOWN_SIZE = 53295072;

const CRASH_VA = 0x100fe99e4; // ldr x8, [x19]  — the faulting instruction
const RESUME_VA = 0x100fe99e8; // where the original path continues
const EMPTY_EXIT_VA = 0x100fe9a1c; // the loop's own "nothing to do" exit (+0x1204)

const ORIGINAL_AT_CRASH = 0xf9400268; // ldr x8, [x19]

const fileOff = (va: number) => va - TEXT_BASE;

/** Little-endian 32-bit read/write, which is how ARM64 instructions sit in the file. */
const readInsn = (buf: Buffer, va: number) => buf.readUInt32LE(fileOff(va));
const writeInsn = (buf: Buffer, va: number, insn: number) => buf.writeUInt32LE(insn >>> 0, fileOff(va));

/** B <target> — a 26-bit signed word displacement. */
function encodeB(fromVa: number, toVa: number): number {
  const delta = (toVa - fromVa) / 4;
  if (!Number.isInteger(delta) || delta < -(1 << 25) || delta >= 1 << 25) {
    throw new Error(`branch out of range: ${fromVa.toString(16)} -> ${toVa.toString(16)}`);
  }
  return (0x14000000 | (delta & 0x03ffffff)) >>> 0;
}

/**
 * CBNZ x19, <target> — branch when x19 is NOT zero, 19-bit signed word displacement.
 *
 * The guard tests the non-null case and skips over a `B` to the engine's empty-case exit,
 * rather than branching directly to that exit on null. CBZ's +/-1MB reach cannot span the
 * distance from an arbitrary cave to the crash site; B's +/-128MB can, and this arrangement
 * only ever needs CBNZ to jump two instructions.
 */
function encodeCbnzX19(fromVa: number, toVa: number): number {
  const delta = (toVa - fromVa) / 4;
  if (!Number.isInteger(delta) || delta < -(1 << 18) || delta >= 1 << 18) {
    throw new Error(`cbnz out of range: ${fromVa.toString(16)} -> ${toVa.toString(16)}`);
  }
  return (0xb5000000 | ((delta & 0x7ffff) << 5) | 19) >>> 0;
}

/** The __text section, so the cave search stays inside executable bytes. */
function textSection() {
  const out = execFileSync("otool", ["-l", BINARY], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const lines = out.split("\n");
  const at = lines.findIndex((l) => l.includes("sectname __text"));
  if (at < 0) throw new Error("no __text section found");
  const grab = (key: string) => {
    const line = lines.slice(at, at + 12).find((l) => l.trim().startsWith(key));
    if (!line) throw new Error(`__text has no ${key}`);
    return Number.parseInt(line.trim().split(/\s+/)[1]!, 16);
  };
  return { start: fileOff(grab("addr")), size: grab("size") };
}

/**
 * A run of zero bytes inside __text, big enough for the guard and CLOSE ENOUGH to branch to.
 *
 * Padding between functions is zero-filled and never executed, so borrowing it does not
 * displace any code. Proximity matters: CBZ reaches only +/-1MB, and the first cave in the
 * binary was 12MB past the crash site, so a naive "first cave" search produced an unencodable
 * branch. Search outwards from the crash site and take the nearest fit.
 */
function findCave(buf: Buffer, words: number, nearVa: number): number {
  const { start, size } = textSection();
  const need = words * 4 + 8; // a little slack so we never sit flush against real code
  const caves: number[] = [];
  let run = 0;
  for (let i = start; i < start + size; i++) {
    if (buf[i] === 0) {
      run++;
      if (run === need) {
        // Align to 4 bytes, and leave the first word of the run alone.
        caves.push((((i - run + 8) & ~3) >>> 0) + TEXT_BASE);
      }
    } else {
      run = 0;
    }
  }
  if (caves.length === 0) throw new Error("no code cave found in __text");
  // Nearest to the crash site wins, so every branch in the guard stays in range.
  caves.sort((a, b) => Math.abs(a - nearVa) - Math.abs(b - nearVa));
  return caves[0]!;
}

function readBinary(): Buffer {
  if (!existsSync(BINARY)) throw new Error(`game binary not found at ${BINARY}`);
  return readFileSync(BINARY);
}

/** Which of the three states the binary is in. */
function status(): "original" | "patched" | "unknown" {
  const buf = readBinary();
  const insn = readInsn(buf, CRASH_VA);
  if (insn === ORIGINAL_AT_CRASH) return "original";
  // A patched site holds an unconditional branch (top byte 0x14).
  if ((insn & 0xfc000000) >>> 0 === 0x14000000) return "patched";
  return "unknown";
}

function resign(): void {
  // Signing the executable at its in-bundle path makes codesign walk the app's resource envelope.
  // Civ writes Telemetry.log beside the executable, and codesign mistakes that log for an unsigned
  // code subcomponent. Sign an identical detached copy, verify it, then copy those bytes back.
  const signingDir = mkdtempSync(join(tmpdir(), "civbench-sign-"));
  const detached = join(signingDir, "CivilizationVII");
  try {
    copyFileSync(BINARY, detached);
    execFileSync(
      "codesign",
      ["--force", "--sign", "-", "--identifier", "com.2k.civ7", "--timestamp=none", detached],
      { stdio: "inherit" },
    );
    execFileSync("codesign", ["--verify", "--strict", detached], { stdio: "inherit" });
    copyFileSync(detached, BINARY);
    chmodSync(BINARY, 0o755);
  } finally {
    rmSync(signingDir, { recursive: true, force: true });
  }
}

/** Keep executable backups out of Contents/MacOS, where codesign treats them as nested code. */
function ensureBackup(copyCurrent: boolean): void {
  mkdirSync(BACKUP_DIR, { recursive: true });
  if (!existsSync(BACKUP)) {
    if (existsSync(LEGACY_BACKUP)) copyFileSync(LEGACY_BACKUP, BACKUP);
    else if (copyCurrent) copyFileSync(BINARY, BACKUP);
    else throw new Error(`no pristine backup at ${BACKUP}; restore the game through Steam`);
  }
  if (readInsn(readFileSync(BACKUP), CRASH_VA) !== ORIGINAL_AT_CRASH) {
    throw new Error(`backup is not pristine: ${BACKUP}`);
  }
  if (existsSync(LEGACY_BACKUP)) unlinkSync(LEGACY_BACKUP);
}

function apply(): void {
  const buf = readBinary();
  if (statSync(BINARY).size < KNOWN_SIZE || statSync(BINARY).size > KNOWN_SIZE + 4096) {
    throw new Error(
      `binary is ${statSync(BINARY).size} bytes, expected ${KNOWN_SIZE}. This is a different ` +
        `build — the offsets in this patch were disassembled against 1.4.2 (1290193) and must ` +
        `be re-derived. See docs/crash-evidence/README.md.`,
    );
  }
  const state = status();
  if (state === "patched") {
    ensureBackup(false);
    resign();
    console.log("already patched — repaired and verified its ad-hoc signature");
    return;
  }
  if (state === "unknown") {
    throw new Error("the crash site holds neither the original instruction nor our patch; refusing to write");
  }

  // Keep a pristine copy BEFORE touching anything.
  ensureBackup(true);

  // The guard, written into unused padding:
  //   cbnz x19, +8            ; object is fine -> run the displaced instruction
  //   b    <empty-case exit>  ; null receiver -> the path already used for "nothing"
  //   ldr  x8, [x19]          ; the instruction we displaced
  //   b    <resume>           ; back into the original flow
  //
  // CBNZ only ever jumps two instructions, so cave distance cannot make it unencodable; both
  // long jumps are B, which reaches +/-128MB.
  const WORDS = 4;
  const caveVa = findCave(buf, WORDS, CRASH_VA);
  for (let i = 0; i < WORDS; i++) {
    if (readInsn(buf, caveVa + i * 4) !== 0) throw new Error("cave is not zero-filled; refusing to write");
  }
  writeInsn(buf, caveVa + 0, encodeCbnzX19(caveVa + 0, caveVa + 8));
  writeInsn(buf, caveVa + 4, encodeB(caveVa + 4, EMPTY_EXIT_VA));
  writeInsn(buf, caveVa + 8, ORIGINAL_AT_CRASH);
  writeInsn(buf, caveVa + 12, encodeB(caveVa + 12, RESUME_VA));

  // And the jump into it, replacing the faulting load.
  writeInsn(buf, CRASH_VA, encodeB(CRASH_VA, caveVa));

  writeFileSync(BINARY, buf);
  resign();
  console.log(`patched: null-object guard at ${caveVa.toString(16)}, crash site branches to it`);
  console.log(`backup:  ${BACKUP}`);
  console.log("re-signed ad-hoc. Steam's 'verify integrity' or any game patch will undo this.");
}

function revert(): void {
  ensureBackup(false);
  copyFileSync(BACKUP, BINARY);
  resign();
  console.log("reverted to the original binary, re-signed");
}

const command = process.argv[2] ?? "status";
if (command === "apply") apply();
else if (command === "revert") revert();
else if (command === "status") {
  console.log(`binary: ${BINARY}`);
  console.log(`state:  ${status()}${existsSync(BACKUP) || existsSync(LEGACY_BACKUP) ? "  (backup present)" : ""}`);
} else {
  console.log("usage: npm run patch-crash -- <apply|revert|status>");
  process.exit(1);
}
