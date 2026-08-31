// Speaking the commentary out loud (docs/PLAN.md §12.3).
//
// The caster already writes two or three sentences per seat per turn. This turns them into sound.
// It sits behind the same wall the rest of the commentary does: nothing here is reachable from a
// playing agent, and a voice that fails must never cost a match a turn — every failure below is
// swallowed after one line on stderr.
import { spawn } from "node:child_process";
import { writeFile, mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Where a spoken line's audio lands. With a saveDir the file goes into the run directory and
 * stays, numbered in speaking order so the files concatenate back into the broadcast; without
 * one, a throwaway temp dir as before.
 */
let spoken = 0;
async function audioPath(saveDir: string | undefined, ext: string): Promise<string> {
  if (saveDir) {
    await mkdir(saveDir, { recursive: true });
    return join(saveDir, `${String(++spoken).padStart(4, "0")}.${ext}`);
  }
  return join(await mkdtemp(join(tmpdir(), "civbench-tts-")), `line.${ext}`);
}

/** The OpenAI voice model. Chosen for latency: a turn can finish in ten seconds. */
const TTS_MODEL = "gpt-4o-mini-tts";
const TTS_VOICE = "ash";

export type Voice = {
  /**
   * Queue a line; resolves as soon as it is queued. `group` tags lines that belong together
   * (one turn's segments) so the drop-stale rule drops whole groups, never half of one.
   */
  say(text: string, group?: string): Promise<void>;
  /** Wait for everything queued so far. */
  drain(): Promise<void>;
  name: string;
};

/**
 * Speech through macOS's own voice.
 *
 * No key, no network, no cost, and it starts talking immediately. Worth having as the default:
 * the commentary is short and conversational, which is what `say` is good at.
 */
function systemVoice(): Voice {
  return {
    name: "macOS say",
    say: (text) =>
      new Promise<void>((resolve) => {
        const child = spawn("say", ["-r", "190", text], { stdio: "ignore" });
        child.on("error", () => resolve());
        child.on("close", () => resolve());
      }),
    drain: async () => {},
  };
}

/** The ElevenLabs voice for the caster. Overridable per run without touching code. */
const ELEVENLABS_DEFAULT_VOICE = "J2FGlQG8Gd7x8uEDt2H8";
/** Flash is the low-latency tier, which is what turn-by-turn casting needs. */
const ELEVENLABS_MODEL = "eleven_flash_v2_5";

/** Speech through ElevenLabs. The best voice of the three; needs a key and a round trip. */
function elevenLabsVoice(apiKey: string, voiceId: string, saveDir?: string): Voice {
  return {
    name: `elevenlabs ${voiceId} (${ELEVENLABS_MODEL})`,
    async say(text) {
      const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
        method: "POST",
        headers: { "content-type": "application/json", "xi-api-key": apiKey },
        body: JSON.stringify({ text, model_id: ELEVENLABS_MODEL }),
      });
      if (!res.ok) throw new Error(`elevenlabs ${res.status}: ${(await res.text()).slice(0, 120)}`);
      const file = await audioPath(saveDir, "mp3");
      await writeFile(file, Buffer.from(await res.arrayBuffer()));
      await new Promise<void>((resolve) => {
        const child = spawn("afplay", [file], { stdio: "ignore" });
        child.on("error", () => resolve());
        child.on("close", () => resolve());
      });
    },
    drain: async () => {},
  };
}

/** Speech through OpenAI. Better voice, needs a key and a round trip. */
function openAiVoice(apiKey: string, saveDir?: string): Voice {
  return {
    name: `openai ${TTS_MODEL}`,
    async say(text) {
      const res = await fetch("https://api.openai.com/v1/audio/speech", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model: TTS_MODEL, voice: TTS_VOICE, input: text, response_format: "wav" }),
      });
      if (!res.ok) throw new Error(`tts ${res.status}: ${(await res.text()).slice(0, 120)}`);
      const file = await audioPath(saveDir, "wav");
      await writeFile(file, Buffer.from(await res.arrayBuffer()));
      await new Promise<void>((resolve) => {
        const child = spawn("afplay", [file], { stdio: "ignore" });
        child.on("error", () => resolve());
        child.on("close", () => resolve());
      });
    },
    drain: async () => {},
  };
}

/**
 * Synthesize a line to an audio FILE without playing it.
 *
 * The transcript site routes audio through the browser, not the machine's speakers, so it needs the
 * bytes on disk rather than an afplay call. ElevenLabs (mp3) is preferred, then OpenAI (wav); with
 * neither key there is no browser-playable audio, so this returns null and the site stays text-only.
 */
export async function synthesize(
  keys: { elevenLabs?: string; openAi?: string },
  voiceId: string | undefined,
  text: string,
  saveDir: string,
): Promise<{ file: string; mime: string } | null> {
  if (keys.elevenLabs) {
    const id = voiceId ?? ELEVENLABS_DEFAULT_VOICE;
    const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${id}`, {
      method: "POST",
      headers: { "content-type": "application/json", "xi-api-key": keys.elevenLabs },
      body: JSON.stringify({ text, model_id: ELEVENLABS_MODEL }),
    });
    if (!res.ok) throw new Error(`elevenlabs ${res.status}: ${(await res.text()).slice(0, 120)}`);
    const file = await audioPath(saveDir, "mp3");
    await writeFile(file, Buffer.from(await res.arrayBuffer()));
    return { file, mime: "audio/mpeg" };
  }
  if (keys.openAi) {
    const res = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${keys.openAi}` },
      body: JSON.stringify({ model: TTS_MODEL, voice: TTS_VOICE, input: text, response_format: "wav" }),
    });
    if (!res.ok) throw new Error(`tts ${res.status}: ${(await res.text()).slice(0, 120)}`);
    const file = await audioPath(saveDir, "wav");
    await writeFile(file, Buffer.from(await res.arrayBuffer()));
    return { file, mime: "audio/wav" };
  }
  return null;
}

/**
 * A voice that speaks one line at a time.
 *
 * Turns finish in ten to thirty seconds and a round of commentary is several lines, so without a
 * queue the lines overlap and none of them is audible. `say` returns as soon as the line is
 * queued, so the caster never blocks on playback.
 *
 * `dropStale` is the audio version of the follow loop's drop rule: a segment is 25 to 35 seconds
 * of speech, so on fast turns the queue only grows and the voice narrates the past. With it on,
 * queuing a line from a new group throws away every waiting line from older groups — the line
 * being spoken always finishes. Off by default until the interestingness gate proves it is still
 * needed (docs/narrator-review.md).
 */
export function createVoice(
  keys: {
    elevenLabs?: string;
    elevenLabsVoiceId?: string;
    openAi?: string;
  },
  /** Directory to keep each line's audio in (the run's commentary dir). Temp files without it. */
  saveDir?: string,
  dropStale = false,
): Voice {
  const backend = keys.elevenLabs
    ? elevenLabsVoice(keys.elevenLabs, keys.elevenLabsVoiceId ?? ELEVENLABS_DEFAULT_VOICE, saveDir)
    : keys.openAi
      ? openAiVoice(keys.openAi, saveDir)
      : systemVoice();
  let waiting: Array<{ text: string; group: string }> = [];
  let pump: Promise<void> = Promise.resolve();
  let pumping = false;
  const start = () => {
    if (pumping) return;
    pumping = true;
    pump = (async () => {
      let next;
      while ((next = waiting.shift())) {
        try {
          await backend.say(next.text);
        } catch (err) {
          // One line, then carry on. A caster that dies takes the commentary with it, and the
          // commentary is the thing that makes a run watchable.
          console.error(`  (voice failed: ${String(err).slice(0, 100)})`);
        }
      }
      pumping = false;
    })();
  };
  return {
    name: backend.name,
    say(text, group = "") {
      if (dropStale && group) {
        const stale = waiting.filter((q) => q.group !== group);
        if (stale.length > 0) console.error(`  (voice behind — dropped ${stale.length} unspoken line(s))`);
        waiting = waiting.filter((q) => q.group === group);
      }
      waiting.push({ text, group });
      start();
      return Promise.resolve();
    },
    drain: () => pump,
  };
}

/**
 * Several voices, ONE playback queue.
 *
 * The color caster and each agent's inner monologue speak in different ElevenLabs voices, but they
 * must not talk over each other — one shared queue plays them back one line at a time, in the order
 * queued, whichever voice each line uses. Per-voice backends are made once and cached; with no
 * ElevenLabs key everyone falls back to a single OpenAI or macOS voice (the voiceId is ignored,
 * since those backends are one-voice here).
 */
export type VoicePool = {
  /** Queue a line in a specific voice. Resolves as soon as it is queued. */
  say(text: string, opts?: { voiceId?: string; group?: string }): Promise<void>;
  drain(): Promise<void>;
  name: string;
};

export function createVoicePool(
  keys: { elevenLabs?: string; openAi?: string },
  saveDir?: string,
  dropStale = false,
): VoicePool {
  const cache = new Map<string, Voice>();
  const backendFor = (voiceId: string): Voice => {
    const key = keys.elevenLabs ? voiceId : "_single";
    let backend = cache.get(key);
    if (!backend) {
      backend = keys.elevenLabs
        ? elevenLabsVoice(keys.elevenLabs, voiceId, saveDir)
        : keys.openAi
          ? openAiVoice(keys.openAi, saveDir)
          : systemVoice();
      cache.set(key, backend);
    }
    return backend;
  };

  let waiting: Array<{ text: string; voiceId: string; group: string }> = [];
  let pump: Promise<void> = Promise.resolve();
  let pumping = false;
  const start = () => {
    if (pumping) return;
    pumping = true;
    pump = (async () => {
      let next;
      while ((next = waiting.shift())) {
        try {
          await backendFor(next.voiceId).say(next.text);
        } catch (err) {
          console.error(`  (voice failed: ${String(err).slice(0, 100)})`);
        }
      }
      pumping = false;
    })();
  };

  const name = keys.elevenLabs
    ? `elevenlabs pool (${ELEVENLABS_MODEL})`
    : keys.openAi
      ? `openai ${TTS_MODEL}`
      : "macOS say";
  return {
    name,
    say(text, opts = {}) {
      const voiceId = opts.voiceId ?? ELEVENLABS_DEFAULT_VOICE;
      const group = opts.group ?? "";
      if (dropStale && group) {
        waiting = waiting.filter((q) => q.group === group);
      }
      waiting.push({ text, voiceId, group });
      start();
      return Promise.resolve();
    },
    drain: () => pump,
  };
}
