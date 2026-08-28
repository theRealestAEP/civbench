// Speaking the commentary out loud (docs/PLAN.md §12.3).
//
// The caster already writes two or three sentences per seat per turn. This turns them into sound.
// It sits behind the same wall the rest of the commentary does: nothing here is reachable from a
// playing agent, and a voice that fails must never cost a match a turn — every failure below is
// swallowed after one line on stderr.
import { spawn } from "node:child_process";
import { writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The OpenAI voice model. Chosen for latency: a turn can finish in ten seconds. */
const TTS_MODEL = "gpt-4o-mini-tts";
const TTS_VOICE = "ash";

export type Voice = {
  /** Queue a line. Resolves when it has been spoken. */
  say(text: string): Promise<void>;
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
function elevenLabsVoice(apiKey: string, voiceId: string): Voice {
  return {
    name: `elevenlabs ${voiceId} (${ELEVENLABS_MODEL})`,
    async say(text) {
      const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
        method: "POST",
        headers: { "content-type": "application/json", "xi-api-key": apiKey },
        body: JSON.stringify({ text, model_id: ELEVENLABS_MODEL }),
      });
      if (!res.ok) throw new Error(`elevenlabs ${res.status}: ${(await res.text()).slice(0, 120)}`);
      const dir = await mkdtemp(join(tmpdir(), "civbench-tts-"));
      const file = join(dir, "line.mp3");
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
function openAiVoice(apiKey: string): Voice {
  return {
    name: `openai ${TTS_MODEL}`,
    async say(text) {
      const res = await fetch("https://api.openai.com/v1/audio/speech", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model: TTS_MODEL, voice: TTS_VOICE, input: text, response_format: "wav" }),
      });
      if (!res.ok) throw new Error(`tts ${res.status}: ${(await res.text()).slice(0, 120)}`);
      const dir = await mkdtemp(join(tmpdir(), "civbench-tts-"));
      const file = join(dir, "line.wav");
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
 * A voice that speaks one line at a time.
 *
 * Turns finish in ten to thirty seconds and a round of commentary is three lines, so without a
 * queue the lines overlap and none of them is audible. Everything is chained onto one promise:
 * `say` returns as soon as the line is QUEUED, so the caster never blocks on playback.
 */
export function createVoice(keys: {
  elevenLabs?: string;
  elevenLabsVoiceId?: string;
  openAi?: string;
}): Voice {
  const backend = keys.elevenLabs
    ? elevenLabsVoice(keys.elevenLabs, keys.elevenLabsVoiceId ?? ELEVENLABS_DEFAULT_VOICE)
    : keys.openAi
      ? openAiVoice(keys.openAi)
      : systemVoice();
  let queue: Promise<void> = Promise.resolve();
  return {
    name: backend.name,
    say(text) {
      queue = queue
        .then(() => backend.say(text))
        .catch((err) => {
          // One line, then carry on. A caster that dies takes the commentary with it, and the
          // commentary is the thing that makes a run watchable.
          console.error(`  (voice failed: ${String(err).slice(0, 100)})`);
        });
      return Promise.resolve();
    },
    drain: () => queue,
  };
}
