// Runs inside Civ 7. Shows the acting agent's name and its current thinking on screen.
//
// Without this a spectator sees units move with no idea why, and no idea which agent is playing.
// The reasoning is the interesting part of an agent match (docs/PLAN.md §12) — watching a settler
// move is dull; reading why it moved, and then watching it be wrong, is not.
//
// Pure DOM, painted over the game. It touches no game state.
const ID = "civbench-overlay";

let panel = document.getElementById(ID);
if (!panel) {
  panel = document.createElement("div");
  panel.id = ID;
  panel.style.cssText = [
    "position:fixed", "left:24px", "bottom:24px", "width:46vw", "min-width:640px",
    "max-height:52vh", "overflow:hidden", "z-index:99999", "pointer-events:none",
    "background:rgba(8,12,18,0.90)", "border:2px solid rgba(210,175,95,0.7)",
    "border-radius:10px", "padding:18px 22px",
    "font-family:ui-monospace,Menlo,monospace", "color:#eef3f9",
    "box-shadow:0 10px 44px rgba(0,0,0,0.7)",
  ].join(";");
  panel.innerHTML =
    '<div id="' + ID + '-who" style="font-size:24px;font-weight:700;color:#f0cd80;margin-bottom:10px;letter-spacing:.02em"></div>' +
    '<div id="' + ID + '-act" style="font-size:15px;color:#8fe0a8;margin-bottom:10px;white-space:pre-wrap"></div>' +
    '<div id="' + ID + '-say" style="font-size:18px;line-height:1.5;white-space:pre-wrap;opacity:.96"></div>';
  document.body.appendChild(panel);
}

const set = (suffix, text) => {
  const el = document.getElementById(ID + suffix);
  if (el) el.textContent = text ?? "";
};

if (typeof OVERLAY_WHO === "string") set("-who", OVERLAY_WHO);
if (typeof OVERLAY_ACTION === "string") set("-act", OVERLAY_ACTION);
if (typeof OVERLAY_TEXT === "string") {
  // Keep the tail: the most recent thinking is what matters.
  set("-say", OVERLAY_TEXT.length > 1400 ? "..." + OVERLAY_TEXT.slice(-1400) : OVERLAY_TEXT);
}
return { shown: true };
