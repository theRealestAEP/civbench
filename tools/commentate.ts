// Commentate a run: node tools/commentate.ts <runDir> [--follow] [--speak] [--every-turn] [--drop-stale]
//
// Standalone on purpose. The match loop never calls this, so a caster that falls over, or a
// commentary model that stalls, cannot cost a match a single turn.
//
// Default: write commentary for every finished turn the interestingness gate lets through.
// --follow: watch a live run and stay with it. See the drop rule below.
// --every-turn: no gate — a segment for every turn. Live (--follow) always does this; the flag
//   forces it for the batch path too.
// --drop-stale: when the audio queue falls behind, drop unspoken lines from older turns.
import { existsSync, readFileSync, readdirSync, appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadEnv } from "../src/config/env.ts";
import { readTurns, milestonesOf, shouldSpeak, type CompleteTurn } from "../src/commentary/brief.ts";
import {
  commentateTurn, monologueTurn, hasCommentary, newMemory, writeCommentary,
} from "../src/commentary/commentate.ts";
import { modelSpeaker } from "../src/commentary/speak.ts";
import { createVoicePool } from "../src/commentary/voice.ts";
import { createBroadcast, type Broadcast } from "../src/commentary/broadcast.ts";

loadEnv();

// The narrator is standalone and long-running; it must never hard-crash. A stray rejection is
// logged and swallowed rather than taking the broadcast down mid-match.
process.on("unhandledRejection", (reason) => {
  console.error(`  (narrator unhandled rejection: ${String(reason instanceof Error ? reason.message : reason)})`);
});

const args = process.argv.slice(2);
const follow = args.includes("--follow");
const aloud = args.includes("--speak");
const monologue = args.includes("--monologue");
const site = args.includes("--site");
const portArg = args.indexOf("--port");
const sitePort = portArg >= 0 ? Number(args[portArg + 1]) : 7667;
// Live (follow) narrates every turn: the drop-stale + `behind` backstop below already thins the
// feed when generation cannot keep up, so the highlight gate would only suppress monologues that
// there was time to speak. The gate still governs the batch path, where highlights are the point.
const everyTurn = args.includes("--every-turn") || follow;
const dropStale = args.includes("--drop-stale");
const given = args.find((a) => !a.startsWith("--"));

if (!given || !existsSync(given)) {
  console.error("usage: node tools/commentate.ts <runDir> [--follow] [--speak|--site [--port N]] [--monologue] [--every-turn] [--drop-stale]");
  process.exit(1);
}
const runDir = given;

const speak = modelSpeaker();
// ElevenLabs when its key is set, then OpenAI, then macOS `say`. All are queued one line at a
// time: a round of commentary is several lines and a turn can finish in ten seconds, so unqueued
// they would overlap. ELEVENLABS_VOICE_ID picks the voice; a default ships in voice.ts.
const keys = { elevenLabs: process.env.ELEVENLABS_API_KEY, openAi: process.env.OPENAI_API_KEY };
const audioDir = join(runDir, "commentary", "audio");

// --site routes audio through a browser transcript page (see broadcast.ts); otherwise --speak plays
// it locally through one shared queue so the caster and the three agents never overlap. Never both:
// in site mode the browser is the output, so the local player stays off.
const broadcast: Broadcast | null = site ? createBroadcast({ runDir, keys, saveDir: audioDir, port: sitePort }) : null;
const voice = aloud && !site ? createVoicePool(keys, audioDir, dropStale) : null;
if (broadcast) console.log(`broadcast transcript + audio at ${broadcast.url}${monologue ? " (with per-agent monologue)" : ""}`);
else if (voice) console.log(`speaking with ${voice.name}${monologue ? " + per-agent monologue" : ""}`);

// The caster's voice, and each agent's own voice and color for the monologue. Agent voices and the
// roster order (which sets each seat's color) come from the manifest the match wrote.
const casterVoiceId = process.env.ELEVENLABS_VOICE_ID;
const CASTER_COLOR = "#ffcf5c";
const STANDINGS_COLOR = "#cbd5e1";
const SEAT_COLORS = ["#4da3ff", "#ffc74d", "#ff6b8a", "#4de0a8", "#c08cff"];
const agentVoices = new Map<string, string>();
const agentColors = new Map<string, string>();
try {
  // SAFETY: manifest.json is written by this harness at match start; every field is read optionally.
  const manifest = JSON.parse(readFileSync(join(runDir, "manifest.json"), "utf8")) as {
    agents?: Array<{ name?: string; voice?: { id?: string } }>;
  };
  (manifest.agents ?? []).forEach((a, i) => {
    if (!a?.name) return;
    if (a.voice?.id) agentVoices.set(a.name, a.voice.id);
    agentColors.set(a.name, SEAT_COLORS[i % SEAT_COLORS.length]!);
  });
} catch {
  /* no manifest: agents fall back to default voice and color below */
}

/** A display name and color for a commentary line's seat label. */
function speakerOf(seat: string) {
  if (seat === "play-by-play") return { name: "Caster", color: CASTER_COLOR };
  if (seat === "standings") return { name: "Standings", color: STANDINGS_COLOR };
  return { name: seat, color: agentColors.get(seat) ?? "#4da3ff" };
}

/** Speak one line, either to the browser transcript or the local player. */
function emit(seat: string, text: string, voiceId: string | undefined, group: string): void {
  const who = speakerOf(seat);
  if (broadcast) broadcast.say({ speaker: who.name, text, voiceId, color: who.color, group });
  else voice?.say(text, { voiceId, group });
}

/** One turn's monologue, written beside the commentary but in its own thread. */
function writeMonologue(dir: string, turn: number, lines: { seat: string; text: string }[]): void {
  const body = `## turn ${turn}\n\n${lines.map((l) => `**${l.seat}** — ${l.text}`).join("\n\n")}\n`;
  mkdirSync(join(dir, "monologue"), { recursive: true });
  writeFileSync(join(dir, "monologue", `t${String(turn).padStart(4, "0")}.md`), body);
  appendFileSync(join(dir, "monologue.md"), `${body}\n`);
}

// Held across turns so the caster can say what has changed rather than re-describing each turn.
const memory = newMemory();
// The agents' monologue memory, one thread per seat, kept apart from the caster's.
const monoMemory = newMemory();
const POLL_MS = 5000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * id -> name for every power, so the narrator says "Carthage" or "Ada", never "p11".
 *
 * Seats come from the event log (player id + playerName); city-states and rivals from the players
 * dump each seat writes (which now resolves real independent names). Rebuilt each turn — city-states
 * are discovered as the game goes on.
 */
/** The seats, from the event log: id -> name, and the ordered list of names (the players). */
function seatsFromEvents(dir: string) {
  const legend = new Map<number, string>();
  const players: string[] = [];
  const seatIds = new Set<number>();
  try {
    for (const line of readFileSync(join(dir, "events.jsonl"), "utf8").split("\n")) {
      if (!line.trim()) continue;
      // SAFETY: this run's own append-only event log, one record per line.
      const e = JSON.parse(line) as { player?: number; playerName?: string };
      const id = Number(e.player);
      if (!Number.isFinite(id) || !e.playerName) continue;
      legend.set(id, String(e.playerName));
      if (!seatIds.has(id)) {
        seatIds.add(id);
        players.push(String(e.playerName));
      }
    }
  } catch {
    /* no events yet */
  }
  return { legend, players, seatIds };
}

/** One power from a players.jsonl line: {id, name, kind} or null. */
function parsePower(line: string): { id: number; name: string; kind?: string } | null {
  try {
    // SAFETY: players.jsonl is written by this harness's players dump, one power per line.
    const pl = JSON.parse(line) as { id?: number; name?: string; civ?: string; kind?: string };
    const id = Number(pl.id);
    const name = pl.name ?? pl.civ;
    return Number.isFinite(id) && name ? { id, name, kind: pl.kind } : null;
  } catch {
    return null;
  }
}

function buildLegend(dir: string) {
  const { legend, players, seatIds } = seatsFromEvents(dir);
  const cityStates = new Set<string>();
  try {
    const agentsDir = join(dir, "agents");
    for (const seat of readdirSync(agentsDir)) {
      const turnsDir = join(agentsDir, seat, "turns");
      if (!existsSync(turnsDir)) continue;
      for (const t of readdirSync(turnsDir).sort().slice(-3)) {
        const pf = join(turnsDir, t, "players.jsonl");
        if (!existsSync(pf)) continue;
        for (const line of readFileSync(pf, "utf8").split("\n")) {
          const power = line.trim() ? parsePower(line) : null;
          if (!power) continue;
          legend.set(power.id, power.name);
          // A player id we never saw take a turn is not a seat: a rival civ or a city-state.
          if (seatIds.has(power.id)) continue;
          if (power.kind === "city_state") cityStates.add(power.name);
          else if (!players.includes(power.name)) players.push(power.name);
        }
      }
    }
  } catch {
    /* no players dumps yet */
  }
  return { legend, roster: { players, cityStates: [...cityStates] } };
}

async function say(turn: CompleteTurn, missed: string[] = [], withMonologue = true) {
  const started = Date.now();
  const { legend, roster } = buildLegend(runDir);
  const lines = await commentateTurn(turn, speak, memory, missed, legend, roster);
  writeCommentary(runDir, turn.turn, lines);
  console.log(`\n== turn ${turn.turn}  (${((Date.now() - started) / 1000).toFixed(1)}s)`);
  const group = String(turn.turn);
  for (const line of lines) {
    console.log(`  ${line.seat} — ${line.text}`);
    // Grouped by turn so the drop-stale rule can never split one turn's segments.
    emit(line.seat, line.text, casterVoiceId, group);
  }
  // The ONE sync rule: when the narration is falling behind, skip the monologues so it catches up.
  // The caster still calls the turn. Nothing else changes — same one-sentence lines either way.
  if (monologue && withMonologue && turn.seats.length > 0) {
    const monoLines = await monologueTurn(turn, speak, monoMemory, legend, roster);
    writeMonologue(runDir, turn.turn, monoLines);
    for (const line of monoLines) {
      console.log(`  ${line.seat} (says) — ${line.text}`);
      emit(line.seat, line.text, agentVoices.get(line.seat), group);
    }
  }
}

// The gate's state, shared by both modes: the last turn that was spoken (swings are measured
// against it), how many turns in a row were held, and the held turns' big beats, which ride
// into the next spoken segment instead of vanishing.
let prevSpoken: CompleteTurn | undefined;
let quietStreak = 0;
let held: string[] = [];

/** Speak the turn, or hold it and bank its big beats for the next spoken segment. */
async function sayIfInteresting(turn: CompleteTurn, missed: string[] = [], withMonologue = true): Promise<void> {
  const { speak: go, reasons } = everyTurn ? { speak: true, reasons: ["--every-turn"] } : shouldSpeak(turn, prevSpoken, quietStreak);
  if (!go) {
    quietStreak += 1;
    held.push(...missed, ...milestonesOf(turn));
    console.log(`  (turn ${turn.turn} quiet — holding)`);
    return;
  }
  console.log(`  (turn ${turn.turn}: ${reasons[0]}${reasons.length > 1 ? ` +${reasons.length - 1} more` : ""})`);
  const carried = [...held, ...missed];
  held = [];
  quietStreak = 0;
  await say(turn, carried, withMonologue);
  prevSpoken = turn;
}

if (!follow) {
  for (const turn of readTurns(runDir)) {
    if (hasCommentary(runDir, turn.turn)) {
      // A turn commentated by an earlier invocation counts as spoken: swings measure from it.
      prevSpoken = turn;
      quietStreak = 0;
      continue;
    }
    await sayIfInteresting(turn);
  }
  // Let the last line finish before the process goes away.
  await voice?.drain();
  await broadcast?.drain();
  process.exit(0);
}

// Turn N is commentated while turn N+1 plays, so the caster never delays the match. When
// generation falls behind, take the newest finished turn and drop the rest: stale commentary
// is worse than none.
const latest = readTurns(runDir).at(-1);
let last = latest?.turn ?? 0;
// Swings measure against the state where we joined, not against nothing.
prevSpoken = latest;
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
  // Falling behind = we had to drop turns this cycle. Then skip the monologues (the caster and the
  // every-few-turns standings still play); when caught up, the monologues return. This is the ONLY
  // sync rule — line length never changes.
  const behind = dropped.length > 0;
  // A single failing turn — a model hiccup, a rate limit, a bad read — must not kill the narrator.
  // Log it and keep following; the commentary is what makes a run watchable.
  try {
    await sayIfInteresting(newest, missed, !behind);
  } catch (err) {
    console.error(`  (narrator skipped turn ${newest.turn}: ${String(err instanceof Error ? err.message : err)})`);
  }
}
