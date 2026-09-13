// A broadcast-quality live standings panel for a running (or finished) match.
//
//   node tools/stats-page.ts <runDir> --serve [--port 7666]   live panel at http://localhost:PORT
//   node tools/stats-page.ts <runDir>                          write a static snapshot stats.html
//
// Designed as a VERTICAL SIDEBAR to sit beside the game on a stream: point an OBS browser source at
// the URL (source size ~460x1080) next to your game capture. The page polls a tiny local endpoint
// and updates in place — bars glide, numbers change, and there is no reload flash.
//
// Reads only what the match already writes: the manifest (each seat's name and model) and each
// seat's own header.json (the ribbon numbers a viewer watches). Standalone, like the commentator:
// it never writes anything a playing agent can read, and if it falls over it cannot cost a turn.
import { createServer } from "node:http";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const given = process.argv[2];
const serve = process.argv.includes("--serve");
const portArg = process.argv.indexOf("--port");
const port = portArg >= 0 ? Number(process.argv[portArg + 1]) : 7666;
if (!given || !existsSync(given)) {
  console.error("usage: node tools/stats-page.ts <runDir> [--serve] [--port N]");
  process.exit(1);
}
const runDir = given;

type Header = {
  turn?: number;
  age?: string;
  gold?: number;
  yields?: { science?: number; production?: number; culture?: number; gold?: number };
  settlements?: { total?: number; population?: number };
  unitCount?: number;
  militaryStrength?: number;
  researching?: { node?: string };
  civ?: string;
  leader?: string;
  legacy?: Array<{ type: string; score?: number; target?: number }>;
  victories?: Array<{ type: string; current?: number; total?: number }>;
};

// One broadcast color per seat, assigned by roster order. Distinct hues that read at stream bitrate.
const COLORS = ["#4da3ff", "#ffc74d", "#ff6b8a", "#4de0a8", "#c08cff"];

function agents(): Array<{ name: string; model: string }> {
  try {
    // SAFETY: manifest.json is written by this harness at match start; every field is read optionally.
    const manifest = JSON.parse(readFileSync(join(runDir, "manifest.json"), "utf8")) as {
      agents?: Array<{ name?: string; brain?: { model?: string } }>;
    };
    // Show the model name only (drop the "openai/" provider prefix): it is long and crowds a 200px column.
    return (manifest.agents ?? []).map((a) => ({
      name: a.name ?? "?",
      model: (a.brain?.model ?? "scripted").split("/").pop() ?? "scripted",
    }));
  } catch {
    const dir = join(runDir, "agents");
    return existsSync(dir) ? readdirSync(dir).map((name) => ({ name, model: "" })) : [];
  }
}

function latestHeader(seat: string): { header: Header; turn: number } | null {
  const dir = join(runDir, "agents", seat, "turns");
  if (!existsSync(dir)) return null;
  const turns = readdirSync(dir)
    .map((d) => Number(d.replace(/^t/, "")))
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => b - a);
  for (const turn of turns) {
    const path = join(dir, `t${String(turn).padStart(4, "0")}`, "header.json");
    if (existsSync(path)) {
      try {
        // SAFETY: header.json is written by this harness's snapshot writer; Header fields are optional.
        return { header: JSON.parse(readFileSync(path, "utf8")) as Header, turn };
      } catch {
        /* try the next-newest */
      }
    }
  }
  return null;
}

const shortNode = (node: string | undefined) =>
  node ? node.replace(/^NODE_(TECH|CIVIC)_[A-Z]+_/, "").replace(/_/g, " ") : "";

function closestVictory(legacy: Header["legacy"]): { label: string; score: number; target: number } | null {
  const scored = (legacy ?? []).filter((l) => (l.score ?? 0) > 0 && (l.target ?? 0) > 0);
  if (scored.length === 0) return null;
  scored.sort((a, b) => (b.score ?? 0) / (b.target ?? 1) - (a.score ?? 0) / (a.target ?? 1));
  const top = scored[0]!;
  return { label: top.type.replace(/_/g, " "), score: top.score ?? 0, target: top.target ?? 0 };
}

// header.json numbers arrive as numbers; anything missing coerces to NaN and floors to 0.
const n = (v: number | null | undefined) => {
  const num = Number(v);
  return Number.isFinite(num) ? Math.round(num) : 0;
};

/** The whole panel's data, computed fresh from disk. Shipped to the page as JSON. */
function buildData() {
  const seats = agents().map((a, i) => {
    const found = latestHeader(a.name);
    const h = found?.header ?? {};
    // Legacy scores when the match has legacy paths; otherwise the victory manager's own
    // progress, which read 8/13 on domination while every legacy score was 0.
    const legacyScore = (h.legacy ?? []).reduce((s, l) => s + (l.score ?? 0), 0);
    const victories = (h.victories ?? []).filter((v) => (v.total ?? 0) > 0);
    const lead = [...victories].sort((a, b) => (b.current ?? 0) / (b.total ?? 1) - (a.current ?? 0) / (a.total ?? 1))[0];
    const score = legacyScore > 0 ? legacyScore : (lead?.current ?? 0);
    return {
      name: a.name,
      model: a.model,
      color: COLORS[i % COLORS.length]!,
      turn: found?.turn ?? 0,
      age: h.age ?? "",
      // Who this agent is playing as, from its own header. Leader trimmed to the name before its
      // epithet ("Xerxes, the Achaemenid" -> "Xerxes").
      civ: h.civ ?? "",
      leader: (h.leader ?? "").split(",")[0]!.trim(),
      score,
      closest: closestVictory(h.legacy) ?? (lead && (lead.current ?? 0) > 0
        ? { label: lead.type.replace(/^VICTORY_/, "").replace(/_/g, " "), score: lead.current ?? 0, target: lead.total ?? 0 }
        : null),
      economy: n(h.gold),
      economyRate: n(h.yields?.gold),
      science: n(h.yields?.science),
      production: n(h.yields?.production),
      culture: n(h.yields?.culture),
      military: n(h.militaryStrength),
      settlements: n(h.settlements?.total),
      population: n(h.settlements?.population),
      units: n(h.unitCount),
      researching: shortNode(h.researching?.node),
    };
  });
  const turn = Math.max(0, ...seats.map((s) => s.turn));
  const age = seats.find((s) => s.age)?.age ?? "";
  const leader = seats.reduce((best, s) => (s.score > (best?.score ?? -1) ? s : best), seats[0]);
  return { turn, age, leaderName: seats.length && leader && leader.score > 0 ? leader.name : null, seats };
}

// The page: a static shell that renders and then updates in place. `bootstrap` either inlines a data
// snapshot (file mode) or polls the live endpoint (serve mode).
function page(bootstrap: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>CivBench — live standings</title>
<style>
  :root{
    --bg:#0a0e14; --panel:#121822; --panel2:#0e141d; --ink:#f3f6fb; --dim:#8b98ab;
    --line:#20293659; --gold:#ffcf5c;
  }
  *{box-sizing:border-box; margin:0; padding:0}
  html,body{height:100%}
  body{
    background:var(--bg); color:var(--ink);
    font-family:"Inter",system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
    -webkit-font-smoothing:antialiased; overflow:hidden;
  }
  .panel{height:100vh; display:flex; flex-direction:column; padding:clamp(10px,1.8vh,18px); gap:clamp(6px,1.1vh,12px); overflow:hidden}
  header{display:flex; align-items:center; justify-content:space-between; flex:0 0 auto}
  .brand{font-weight:800; letter-spacing:.05em; font-size:clamp(15px,3.4vw,24px); white-space:nowrap}
  .brand b{color:var(--gold)}
  .live{display:flex; align-items:center; gap:.4em; font-size:clamp(9px,1.4vh,12px); font-weight:700; letter-spacing:.18em; color:#ff5c6c}
  .live .dot{width:.62em; height:.62em; border-radius:50%; background:#ff5c6c; animation:pulse 1.6s infinite}
  @keyframes pulse{0%,100%{opacity:1}50%{opacity:.25}}
  .meta{color:var(--dim); font-size:clamp(10px,1.5vh,14px); font-weight:600; letter-spacing:.08em; text-transform:uppercase; flex:0 0 auto}
  .cards{flex:1; display:flex; flex-direction:column; gap:clamp(6px,1.1vh,12px); min-height:0}
  .card{flex:1; min-height:0; position:relative; overflow:hidden;
    background:linear-gradient(180deg,var(--panel),var(--panel2)); border:1px solid var(--line); border-radius:12px;
    padding:clamp(7px,1.1vh,13px) clamp(9px,1.3vh,14px) clamp(7px,1.1vh,13px) clamp(15px,2vh,22px);
    display:flex; flex-direction:column; gap:clamp(4px,.7vh,8px); transition:box-shadow .4s ease}
  .card::before{content:""; position:absolute; left:clamp(6px,1vh,9px); top:clamp(8px,1.3vh,13px);
    bottom:clamp(8px,1.3vh,13px); width:4px; border-radius:4px; background:var(--accent)}
  .card.leader{box-shadow:0 0 0 1px var(--accent), 0 0 24px -8px var(--accent)}
  .crown{position:absolute; top:8px; right:11px; font-size:clamp(13px,1.9vh,18px)}
  .top{display:flex; align-items:baseline; gap:8px; flex:0 0 auto; min-width:0}
  .rank{font-weight:800; color:var(--accent); font-size:clamp(13px,1.9vh,18px); flex:0 0 auto}
  .name{font-weight:800; font-size:clamp(14px,1.9vh,20px); letter-spacing:.01em;
    white-space:nowrap; overflow:hidden; text-overflow:ellipsis}
  .model{color:var(--dim); font-size:clamp(9px,1.2vh,11px); font-weight:600; white-space:nowrap; flex:0 0 auto}
  .civ{flex:0 0 auto; color:var(--accent); font-size:clamp(10px,1.4vh,13px); font-weight:700; letter-spacing:.02em;
    white-space:nowrap; overflow:hidden; text-overflow:ellipsis; opacity:.9}
  .sub{flex:0 0 auto; display:flex; align-items:baseline; gap:.4em; color:var(--dim);
    font-size:clamp(9px,1.3vh,12px); font-weight:600; letter-spacing:.06em; text-transform:uppercase;
    white-space:nowrap; overflow:hidden; text-overflow:ellipsis}
  .sub .pts{color:var(--ink); font-weight:800; font-size:clamp(14px,2vh,20px); letter-spacing:0}
  .sub b{color:var(--ink)}
  .grid{flex:1; min-height:0; display:flex; flex-direction:column; gap:clamp(3px,.6vh,7px)}
  .m{flex:1; min-height:0; position:relative; display:flex; align-items:center; justify-content:space-between;
    gap:8px; padding:0 10px; border-radius:5px; background:#ffffff0a; overflow:hidden}
  .m .fill{position:absolute; inset:0; width:0; background:var(--accent); opacity:.16;
    transition:width .6s cubic-bezier(.2,.8,.2,1)}
  .m .lab{position:relative; color:var(--dim); font-size:clamp(8px,1.1vh,11px); font-weight:700; letter-spacing:.08em; text-transform:uppercase}
  .m .val{position:relative; font-weight:800; font-size:clamp(12px,1.7vh,18px); font-variant-numeric:tabular-nums}
  .m .val small{color:var(--dim); font-weight:600; font-size:.62em; margin-left:.3em}
  footer{flex:0 0 auto; color:var(--dim); font-size:clamp(8px,1.1vh,11px); text-align:center; letter-spacing:.1em}
</style></head>
<body><div class="panel">
  <header>
    <div class="brand">CIV<b>BENCH</b></div>
    <div class="live"><span class="dot"></span>LIVE</div>
  </header>
  <div class="meta" id="meta">—</div>
  <div class="cards" id="cards"></div>
  <footer>updated every few seconds</footer>
</div>
<script>
const METRICS=[["economy","gold"],["science","sci/t"],["production","prod/t"],["military","military"]];
function esc(s){return String(s).replace(/[&<>]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;"}[c]))}
function card(seat,i){
  return '<div class="card" id="card'+i+'" style="--accent:'+seat.color+'">'
    +'<div class="crown" id="crown'+i+'"></div>'
    +'<div class="top"><span class="rank" id="rank'+i+'"></span>'
    +'<span class="name">'+esc(seat.name)+'</span><span class="model">'+esc(seat.model)+'</span></div>'
    +'<div class="civ" id="civ'+i+'"></div>'
    +'<div class="sub"><span class="pts" id="score'+i+'">0</span>legacy pts<span id="vic'+i+'"></span></div>'
    +'<div class="grid">'+METRICS.map(([k,lab],j)=>
      '<div class="m"><div class="fill" id="f'+i+'_'+j+'"></div>'
      +'<span class="lab">'+lab+'</span><span class="val" id="v'+i+'_'+j+'">0</span></div>').join('')
    +'</div></div>';
}
let built=false, count=0;
function render(d){
  document.getElementById('meta').textContent =
    'Turn '+d.turn+(d.age?' · '+d.age.toUpperCase():'');
  if(!built || d.seats.length!==count){
    document.getElementById('cards').innerHTML = d.seats.map(card).join('');
    built=true; count=d.seats.length;
  }
  // rank by score
  const order=[...d.seats.keys()].sort((a,b)=>d.seats[b].score-d.seats[a].score);
  const rankOf={}; order.forEach((idx,r)=>rankOf[idx]=r+1);
  d.seats.forEach((s,i)=>{
    document.getElementById('card'+i).classList.toggle('leader', s.name===d.leaderName);
    document.getElementById('crown'+i).textContent = s.name===d.leaderName ? '👑' : '';
    document.getElementById('rank'+i).textContent = '#'+rankOf[i];
    document.getElementById('civ'+i).textContent = [s.civ, s.leader].filter(Boolean).join(' · ');
    document.getElementById('score'+i).textContent = s.score;
    const vic=document.getElementById('vic'+i);
    vic.innerHTML = s.closest
      ? ' · <b>'+esc(s.closest.label)+' '+s.closest.score+'/'+s.closest.target+'</b>'
      : (s.researching?' · '+esc(s.researching):'');
    METRICS.forEach(([k],j)=>{
      const max=Math.max(1,...d.seats.map(x=>x[k]));
      const extra = k==='economy' ? ' <small>'+(s.economyRate>=0?'+':'')+s.economyRate+'/t</small>' : '';
      document.getElementById('v'+i+'_'+j).innerHTML = s[k]+extra;
      document.getElementById('f'+i+'_'+j).style.width = Math.round(s[k]/max*100)+'%';
    });
  });
}
${bootstrap}
</script></body></html>`;
}

if (serve) {
  const shell = page(
    `async function tick(){try{const d=await (await fetch('/data.json',{cache:'no-store'})).json();render(d);}catch(e){}}
     tick(); setInterval(tick, 3000);`,
  );
  createServer((req, res) => {
    if (req.url && req.url.startsWith("/data.json")) {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(buildData()));
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(shell);
  }).listen(port, () => console.log(`stats panel live at http://localhost:${port}  (OBS browser source, ~460x1080)`));
} else {
  // A self-contained snapshot: same look, data inlined, no polling. For preview and sharing.
  const out = join(runDir, "stats.html");
  writeFileSync(out, page(`render(${JSON.stringify(buildData())});`));
  console.log(`wrote ${out}`);
}
