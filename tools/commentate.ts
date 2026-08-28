// Commentate a run: node tools/commentate.ts <runDir> [--follow] [--speak]
//
// Standalone on purpose. The match loop never calls this, so a caster that falls over, or a
// commentary model that stalls, cannot cost a match a single turn.
//
// Default: write commentary for every finished turn that has none yet.
// --follow: watch a live run and stay with it. See the drop rule below.
import { existsSync } from "node:fs";
import { loadEnv } from "../src/config/env.ts";
import { readTurns, milestonesOf, type CompleteTurn } from "../src/commentary/brief.ts";
import { commentateTurn, hasCommentary, newMemory, writeCommentary } from "../src/commentary/commentate.ts";
import { modelSpeaker } from "../src/commentary/speak.ts";
import { createVoice } from "../src/commentary/voice.ts";

loadEnv();

const args = process.argv.slice(2);
const follow = args.includes("--follow");
const aloud = args.includes("--speak");
const given = args.find((a) => !a.startsWith("--"));

if (!given || !existsSync(given)) {
  console.error("usage: node tools/commentate.ts <runDir> [--follow] [--speak]");
  process.exit(1);
}
const runDir = given;

const speak = modelSpeaker();
// ElevenLabs when its key is set, then OpenAI, then macOS `say`. All are queued one line at a
// time: a round of commentary is several lines and a turn can finish in ten seconds, so unqueued
// they would overlap. ELEVENLABS_VOICE_ID picks the voice; a default ships in voice.ts.
const voice = aloud
  ? createVoice({
      elevenLabs: process.env.ELEVENLABS_API_KEY,
      elevenLabsVoiceId: process.env.ELEVENLABS_VOICE_ID,
      openAi: process.env.OPENAI_API_KEY,
    })
  : null;
if (voice) console.log(`speaking with ${voice.name}`);
// Held across turns so the caster can say what has changed rather than re-describing each turn.
const memory = newMemory();
const POLL_MS = 5000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function say(turn: CompleteTurn, missed: string[] = []) {
  const started = Date.now();
  const lines = await commentateTurn(turn, speak, memory, missed);
  writeCommentary(runDir, turn.turn, lines);
  console.log(`\n== turn ${turn.turn}  (${((Date.now() - started) / 1000).toFixed(1)}s)`);
  for (const line of lines) {
    console.log(`  ${line.seat} — ${line.text}`);
    voice?.say(`${line.seat}. ${line.text}`);
  }
}

if (!follow) {
  for (const turn of readTurns(runDir)) {
    if (hasCommentary(runDir, turn.turn)) continue;
    await say(turn);
  }
  // Let the last line finish before the process goes away.
  await voice?.drain();
  process.exit(0);
}

// Turn N is commentated while turn N+1 plays, so the caster never delays the match. When
// generation falls behind, take the newest finished turn and drop the rest: stale commentary
// is worse than none.
let last = readTurns(runDir).at(-1)?.turn ?? 0;
console.log(`following ${runDir} from turn ${last + 1}`);
while (true) {
  const finished = readTurns(runDir).filter((t) => t.turn > last && !hasCommentary(runDir, t.turn));
  const newest = finished.at(-1);
  if (!newest) {
    await sleep(POLL_MS);
    continue;
  }
  const dropped = finished.slice(0, -1);
  if (dropped.length > 0) console.log(`  (behind — dropped turn ${dropped.map((t) => t.turn).join(", ")})`);
  // The big beats of dropped turns survive the drop: a war declared in a skipped turn gets
  // said as "while we were away", instead of never.
  const missed = dropped.flatMap(milestonesOf);
  last = newest.turn;
  await say(newest, missed);
}
