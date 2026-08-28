// Renders the replay as one self-contained HTML file (docs/PLAN.md §12.1).
// No network, no build step: open the file and scrub.
import type { ReplayData } from "./build.ts";

// Indexed by whatever terrain name the game produced, so a Map rather than a dictionary type:
// the keys are open by nature and `satisfies` would only pin the ones we happened to list.
const TERRAIN_COLORS = new Map<string, string>(Object.entries({
  grassland: "#5c8a3a", plains: "#a89a4e", desert: "#d6c187", tundra: "#9aa89a",
  snow: "#e6ecef", ocean: "#2b5d78", coast: "#3c7fa0", mountain: "#6b6459", hills: "#7d8f4a",
}));

/**
 * JSON safe to embed inside a script tag.
 *
 * `JSON.stringify` does not escape `<`, so agent-controlled text containing a closing script tag
 * terminates the block and everything after it is parsed as HTML. Agents choose their own
 * operation names, so this is reachable. Escaping `<` as \\u003c keeps the JSON identical to a
 * parser and inert to the HTML tokeniser.
 */
function safeJson(value: ReplayData): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

export function renderReplayPage(data: ReplayData, title: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>
  :root{--bg:#12151a;--panel:#1b2029;--line:#2c333f;--text:#e6eaf0;--dim:#98a2b3;--accent:#7aa2f7}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace}
  header{padding:12px 16px;border-bottom:1px solid var(--line);display:flex;gap:16px;align-items:center;flex-wrap:wrap}
  h1{font-size:15px;margin:0;font-weight:600}
  .layout{display:grid;grid-template-columns:1fr 380px;gap:0;height:calc(100vh - 58px)}
  @media (max-width:900px){.layout{grid-template-columns:1fr;height:auto}}
  #map{width:100%;height:100%;background:#0d1014}
  aside{border-left:1px solid var(--line);overflow-y:auto;padding:14px;background:var(--panel)}
  pre{white-space:pre-wrap;word-break:break-word;margin:0 0 14px;font-size:12px;color:var(--text)}
  h2{font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:var(--dim);margin:16px 0 6px}
  select,input[type=range]{accent-color:var(--accent)}
  select{background:var(--panel);color:var(--text);border:1px solid var(--line);border-radius:6px;padding:4px 8px}
  .ev{border-bottom:1px solid var(--line);padding:5px 0;font-size:11px;color:var(--dim)}
  .ev b{color:var(--text);font-weight:600}
  .legend{display:flex;gap:12px;font-size:11px;color:var(--dim);flex-wrap:wrap}
  .sw{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:4px;vertical-align:-1px}
</style></head><body>
<header>
  <h1>${title}</h1>
  <label>agent <select id="agent"></select></label>
  <label>turn <input type="range" id="turn" min="0" value="0" style="width:220px"></label>
  <span id="turnLabel" class="legend"></span>
  <span class="legend"><span class="sw" style="background:#5c8a3a"></span>visible
    <span class="sw" style="background:#5c8a3a;opacity:.35"></span>fogged (remembered)</span>
</header>
<div class="layout">
  <svg id="map"></svg>
  <aside>
    <h2>HUD pushed this turn</h2><pre id="hud"></pre>
    <h2>Events</h2><div id="events"></div>
  </aside>
</div>
<script>
const DATA = ${safeJson(data)};
const COLORS = ${JSON.stringify(Object.fromEntries(TERRAIN_COLORS))};
const agentSel = document.getElementById("agent");
const turnEl = document.getElementById("turn");
DATA.agents.forEach((a,i)=>agentSel.add(new Option(a.name,String(i))));

// Odd-row offset hex layout, the same scheme Civ uses.
const R = 15, W = Math.sqrt(3)*R, H = 1.5*R;
function hexPath(cx,cy){
  let d="";
  for(let i=0;i<6;i++){
    const a=Math.PI/180*(60*i-30);
    d+=(i?"L":"M")+(cx+R*Math.cos(a)).toFixed(1)+","+(cy+R*Math.sin(a)).toFixed(1);
  }
  return d+"Z";
}
function draw(){
  const agent = DATA.agents[Number(agentSel.value)||0];
  if(!agent||!agent.turns.length) return;
  const idx = Math.min(Number(turnEl.value), agent.turns.length-1);
  const t = agent.turns[idx];
  document.getElementById("turnLabel").textContent = "t"+t.turn+"  ("+t.tiles.length+" tiles known)";
  document.getElementById("hud").textContent = t.hud || "(none)";

  const svg = document.getElementById("map");
  const parts = [];
  for(const tile of t.tiles){
    const cx = W*(tile.x + (tile.y%2)*0.5) + W;
    const cy = H*tile.y + R*1.2;
    const fill = COLORS[tile.t] || "#4a5568";
    // Fogged tiles are dimmed, not hidden: the agent remembers them (§7).
    parts.push('<path d="'+hexPath(cx,cy)+'" fill="'+fill+'" opacity="'+(tile.v===2?1:0.35)+'" stroke="#0d1014" stroke-width="1"/>');
    if(tile.o) parts.push('<circle cx="'+cx+'" cy="'+cy+'" r="3" fill="#fff" opacity=".5"/>');
  }
  for(const u of t.units){
    const cx = W*(u.x + (u.y%2)*0.5) + W;
    const cy = H*u.y + R*1.2;
    parts.push('<circle cx="'+cx+'" cy="'+cy+'" r="6" fill="'+(u.own?"#7aa2f7":"#f7768e")+'" stroke="#0d1014" stroke-width="1.5"><title>'+u.type+' '+u.id+'</title></circle>');
  }
  svg.setAttribute("viewBox","0 0 "+(W*(DATA.width+2))+" "+(H*(DATA.height+2)));
  svg.innerHTML = parts.join("");

  const evs = DATA.events.filter(e=>e.turn===t.turn).slice(0,60);
  // Escape before this reaches innerHTML. actionType is typed by the agent: civ do takes a
  // free-form operation name — so an agent naming an operation with an img onerror attribute
  // would run script in the browser of whoever opens the replay.
  // (No backticks in this comment: it lives inside a template literal.)
  const esc = s => String(s==null?"":s).replace(/[&<>"']/g, c =>
    ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  document.getElementById("events").innerHTML = evs.length
    ? evs.map(e=>'<div class="ev"><b>'+esc(e.kind)+'</b> p'+esc(e.player)+' '+
        esc(e.request?(e.request.actionType||""):"")+' '+
        (e.result&&e.result.ok===false?('&rarr; '+esc(e.result.code||"failed")):"")+'</div>').join("")
    : '<div class="ev">(no events this turn)</div>';
}
function resetRange(){
  const agent = DATA.agents[Number(agentSel.value)||0];
  turnEl.max = String(Math.max(0,(agent?agent.turns.length:1)-1));
  draw();
}
agentSel.addEventListener("change",resetRange);
turnEl.addEventListener("input",draw);
resetRange();
</script></body></html>`;
}
