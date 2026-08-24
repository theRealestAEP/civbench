// Runs inside Civ 7's SHELL context. Reads any modal dialog currently on screen.
//
// The game refuses some configurations with an on-screen dialog and NOTHING in any log — the
// load log shows only `LOADSTATE_EARLYEXIT` and an opaque `Error Cause`. "MAP SIZE UNSUPPORTED"
// cost an hour precisely because it was invisible to the logs. Read the DOM instead.
const dialogs = [];
for (const el of document.querySelectorAll("screen-dialog-box, .screen-dialog-box, fxs-modal-frame")) {
  const style = getComputedStyle(el);
  if (style.display === "none" || style.visibility === "hidden") continue;
  const text = (el.textContent || "").replace(/\s+/g, " ").trim();
  if (text) dialogs.push(text.slice(0, 400));
}
return { count: dialogs.length, dialogs };
