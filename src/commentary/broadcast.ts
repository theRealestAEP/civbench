// The narrator/TTS transcript site (docs/PLAN.md §12.3).
//
// Instead of playing narration through the machine's speakers, this synthesizes each line to a file,
// publishes a feed, and serves a page that shows WHO is talking and WHAT they say while playing the
// audio in the browser. On a stream you point one OBS browser source at it: the transcript is your
// on-screen captions and the page's audio is your narration track, both in one capturable source.
//
// It sits behind the same wall as the rest of the commentary: nothing here is reachable by a playing
// agent, and a failure only costs a line, never a turn.
import { createServer, type Server } from "node:http";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { synthesize } from "./voice.ts";

export type BroadcastLine = {
  seq: number;
  speaker: string;
  text: string;
  color: string;
  group: string;
  /** Basename of the audio file under the save dir, or null when there is no key to synthesize. */
  audio: string | null;
  mime: string | null;
};

export type Broadcast = {
  /** Synthesize a line (no local playback) and publish it to the feed, in call order. */
  say(line: { speaker: string; text: string; voiceId?: string; color: string; group: string }): void;
  /** Wait for every queued line to finish synthesizing. */
  drain(): Promise<void>;
  url: string;
};

export function createBroadcast(opts: {
  runDir: string;
  keys: { elevenLabs?: string; openAi?: string };
  saveDir: string;
  port: number;
}): Broadcast {
  const feed: BroadcastLine[] = [];
  const feedPath = join(opts.runDir, "broadcast.jsonl");
  let seq = 0;
  // Continue the run's own feed rather than starting a new one. A restarted narrator used to
  // serve an empty feed, and the page — which only appends past the length it already holds —
  // sat on the old last line until someone refreshed the browser source.
  if (existsSync(feedPath)) {
    for (const line of readFileSync(feedPath, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        // SAFETY: this run's own feed file, one BroadcastLine per line, written by this function.
        const entry = JSON.parse(line) as BroadcastLine;
        feed.push(entry);
        seq = Math.max(seq, Number(entry.seq) || 0);
      } catch { /* a torn last line; the rest of the feed still counts */ }
    }
  }

  // Synthesize strictly in call order, so the feed reads and plays in the order lines were spoken.
  let chain: Promise<void> = Promise.resolve();
  function say(line: { speaker: string; text: string; voiceId?: string; color: string; group: string }): void {
    const mine = ++seq;
    chain = chain.then(async () => {
      let audio: string | null = null;
      let mime: string | null = null;
      try {
        const made = await synthesize(opts.keys, line.voiceId, line.text, opts.saveDir);
        if (made) {
          audio = basename(made.file);
          mime = made.mime;
        }
      } catch (err) {
        console.error(`  (broadcast synth failed: ${String(err).slice(0, 100)})`);
      }
      const entry: BroadcastLine = { seq: mine, speaker: line.speaker, text: line.text, color: line.color, group: line.group, audio, mime };
      feed.push(entry);
      try {
        appendFileSync(feedPath, JSON.stringify(entry) + "\n");
      } catch {
        /* the in-memory feed is enough to serve the page */
      }
    });
  }

  const server: Server = createServer((req, res) => {
    const url = req.url ?? "/";
    if (url.startsWith("/feed.json")) {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(feed));
      return;
    }
    if (url.startsWith("/audio/")) {
      // Basename only: never let a request escape the save dir.
      const name = basename(decodeURIComponent(url.slice("/audio/".length)));
      const file = join(opts.saveDir, name);
      if (existsSync(file)) {
        const mime = name.endsWith(".wav") ? "audio/wav" : "audio/mpeg";
        res.writeHead(200, { "content-type": mime, "cache-control": "no-store" });
        res.end(readFileSync(file));
        return;
      }
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(PAGE);
  });
  // A busy port (a previous narrator still running) makes Node emit an unhandled error and crash
  // the whole narrator. Log it and carry on: synthesis and the feed file still work without serving.
  server.on("error", (err) => {
    console.error(`  (broadcast server on ${opts.port}: ${String(err instanceof Error ? err.message : err)})`);
  });
  server.listen(opts.port, () => console.log(`broadcast site live at http://localhost:${opts.port}`));

  return { say, drain: () => chain, url: `http://localhost:${opts.port}` };
}

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>CivBench — now speaking</title>
<style>
  :root{ --ink:#f3f6fb; --dim:#8493a6; --gold:#ffcf5c }
  *{box-sizing:border-box; margin:0; padding:0}
  html,body{height:100%}
  body{background:#0a0e14; color:var(--ink); font-family:"Inter",system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
    -webkit-font-smoothing:antialiased; overflow:hidden}
  .stage{position:fixed; inset:0; display:flex; align-items:center; justify-content:center; padding:clamp(10px,2vh,20px) clamp(14px,3vw,36px)}
  /* FIXED height: the bar never grows with text, so a stream layout stays put. */
  .card{
    width:min(1120px,94vw); height:clamp(118px,18vh,158px);
    display:flex; align-items:center; gap:clamp(14px,2vw,26px);
    padding:clamp(12px,2vh,20px) clamp(18px,2.4vw,30px);
    background:linear-gradient(180deg,#121822,#0d131c);
    border:1px solid #2a3648; border-radius:16px;
    box-shadow:0 18px 50px -12px #000a, 0 0 0 1px #ffffff08 inset;
    opacity:0; transform:translateY(14px); transition:opacity .22s ease, transform .28s cubic-bezier(.2,.8,.2,1);
    overflow:hidden; position:relative;
  }
  .card.show{opacity:1; transform:translateY(0)}
  @keyframes pulse{0%,100%{opacity:1}50%{opacity:.25}}
  /* Standing-by state: the real card layout, in a clearly-waiting mode. Not a skeleton, not blank. */
  .card.idle .dot{background:#3a4658; box-shadow:none; animation:pulse 1.7s infinite; color:transparent}
  .card.idle .name{color:var(--dim)}
  .card.idle .eq{display:none}
  .waiting{display:none; align-items:center; color:var(--dim); font-weight:600; font-size:clamp(15px,2.3vh,21px)}
  .card.idle .waiting{display:inline-flex}
  .card.idle .text{display:none}
  .ell{display:inline-flex; margin-left:2px}
  .ell i{width:5px; height:5px; border-radius:50%; background:var(--dim); margin-left:4px; animation:pulse 1.4s infinite}
  .ell i:nth-child(2){animation-delay:.2s} .ell i:nth-child(3){animation-delay:.4s}
  .speaker{display:flex; align-items:center; gap:12px; flex:0 0 auto; min-width:clamp(110px,14vw,180px)}
  .dot{width:clamp(34px,5vh,46px); height:clamp(34px,5vh,46px); border-radius:50%; flex:0 0 auto;
    background:var(--spk); box-shadow:0 0 18px -2px var(--spk); display:flex; align-items:center; justify-content:center;
    font-weight:800; color:#0a0e14; font-size:clamp(15px,2.4vh,20px)}
  .who{display:flex; flex-direction:column; gap:3px; min-width:0}
  .name{font-weight:800; color:var(--spk); font-size:clamp(15px,2.4vh,21px); letter-spacing:.01em; white-space:nowrap}
  .eq{display:inline-flex; gap:3px; height:11px; align-items:flex-end}
  .eq i{width:3px; background:var(--spk); border-radius:2px; height:40%; animation:bounce .9s infinite ease-in-out}
  .eq i:nth-child(2){animation-delay:.15s} .eq i:nth-child(3){animation-delay:.3s} .eq i:nth-child(4){animation-delay:.45s}
  @keyframes bounce{0%,100%{height:35%}50%{height:100%}}
  /* Text lives in a fixed box; if a sentence is long it teleprompter-scrolls instead of growing. */
  .textwrap{flex:1; align-self:stretch; overflow:hidden; display:flex; align-items:center}
  .textwrap.scrolling{align-items:flex-start}
  .text{width:100%; font-size:clamp(17px,2.5vh,25px); line-height:1.32; font-weight:500}
</style></head>
<body>
<div class="stage">
  <div class="card idle show" id="card" style="--spk:#ffcf5c">
    <div class="speaker"><div class="dot" id="dot"></div>
      <div class="who"><span class="name" id="name">Standing by</span>
      <span class="eq"><i></i><i></i><i></i><i></i></span></div></div>
    <div class="textwrap" id="wrap"><div class="text" id="text"></div>
      <div class="waiting">Waiting for the opening move<span class="ell"><i></i><i></i><i></i></span></div></div>
  </div>
</div>
<audio id="au"></audio>
<script>
const card=document.getElementById('card'), dotEl=document.getElementById('dot'), nameEl=document.getElementById('name'),
      textEl=document.getElementById('text'), wrap=document.getElementById('wrap'), au=document.getElementById('au');
let items=[], nextPlay=0, playingSeq=-1, timer=null;
async function poll(){
  try{ const d=await fetch('/feed.json',{cache:'no-store'}).then(r=>r.json());
    // A shorter feed, or a different first entry, is a NEW run behind this page — the narrator
    // was restarted on another run directory. The page used to append only past its old length,
    // so it sat on the previous run's last line until the new feed outgrew it (or someone hit
    // refresh). Start over instead.
    if(d.length<items.length || (d.length && items.length && d[0].seq!==items[0].seq)){
      items=[]; nextPlay=0; playingSeq=-1; if(timer){clearTimeout(timer); timer=null;} au.pause();
    }
    for(let i=items.length;i<d.length;i++) items.push(d[i]); pump(); }catch(e){}
}
function show(it){
  card.classList.remove('show');
  setTimeout(()=>{
    card.classList.remove('idle');
    card.style.setProperty('--spk', it.color);
    dotEl.textContent=(it.speaker||'?').slice(0,1).toUpperCase();
    nameEl.textContent=it.speaker;
    textEl.textContent=it.text;
    // reset scroll, then measure: if the line overflows the fixed box, scroll it into view slowly
    textEl.style.transition='none'; textEl.style.transform='translateY(0)'; wrap.classList.remove('scrolling');
    requestAnimationFrame(()=>{
      const overflow=textEl.scrollHeight - wrap.clientHeight;
      if(overflow>4){
        wrap.classList.add('scrolling');
        const dur=Math.max(4, overflow/26);
        requestAnimationFrame(()=>{ textEl.style.transition='transform '+dur+'s linear 1.2s';
          textEl.style.transform='translateY(-'+overflow+'px)'; });
      }
      card.classList.add('show');
    });
  }, 200);
}
function advance(){ if(timer){clearTimeout(timer); timer=null;} playingSeq=-1; nextPlay++; pump(); }
function pump(){
  if(playingSeq!==-1 || nextPlay>=items.length) return;
  // Stay near-live: if the game has raced ahead and a backlog piled up, skip the stale lines and
  // jump to the latest so the audio matches what is on screen now. The line playing still finishes.
  if(items.length - nextPlay > 3) nextPlay = items.length - 1;
  const it=items[nextPlay];
  playingSeq=it.seq; show(it);
  if(it.audio){
    au.src='/audio/'+it.audio;
    au.play().catch(()=>{ timer=setTimeout(advance, 5000); });
  } else { timer=setTimeout(advance, 5000); }
}
au.addEventListener('ended', advance);
au.addEventListener('error', advance);
setInterval(poll, 1500); poll();
</script></body></html>`;
