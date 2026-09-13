// Read the current seat's popup text and activate one of its observed controls.
if (GameContext.localPlayerID !== PLAYER_ID) {
  return { ok: false, code: "SCREEN_WRONG_SEAT", message: "the visible UI belongs to another seat; read again when your seat is local" };
}
const screens = screenInventory();
// With or without the `screen:` prefix: six of seven SCREEN_STALE refusals in one night were an
// agent typing the id the way the pending list shows it.
const wantedScreen = TARGET_ID ? (String(TARGET_ID).startsWith("screen:") ? String(TARGET_ID) : `screen:${TARGET_ID}`) : null;
const screen = wantedScreen ? screens.find((s) => s.id === wantedScreen) : null;
if (TARGET_ID && !screen) {
  return { ok: false, code: "SCREEN_STALE", message: "no open screen matches that id", hint: "run civ screen and use only the ids it returns; an empty list means no screen is open. Read pending.txt for notification commands" };
}
if (!ARGS.control) return { ok: true, screens: (screen ? [screen] : screens).map(screenRecord) };
if (!screen) return { ok: false, code: "SCREEN_REQUIRED", message: "specify the screen id from civ screen" };
const top = screens.filter((s) => s.layer === "popup").at(-1);
if (top && screen !== top) {
  return { ok: false, code: "SCREEN_COVERED", message: "another popup is above this screen", hint: `civ screen ${top.id}` };
}
// By id, by the words on it, or by its position in the last listing — whatever the agent has.
const wanted = String(ARGS.control).trim();
const lowered = wanted.toLowerCase();
const ordinal = /^\d+$/.test(wanted) ? Number(wanted) : null;
// Ids are slugs of a control's words, cut at forty characters, and the words shift a little
// between renders ("...Start_with_an_" one read, "...Start_with_an_extra_" the next). When the
// exact id is gone, one control whose id shares a prefix with what was typed is the same button.
const bare = (id) => String(id).toLowerCase().replace(/^control:/, "");
const prefixMatches = screen.controls.filter((c) => {
  const a = bare(c.id), b = bare(wanted);
  return a.length >= 8 && b.length >= 8 && (a.startsWith(b) || b.startsWith(a));
});
const control = screen.controls.find((c) => c.id === wanted)
  ?? screen.controls.find((c) => c.label.toLowerCase() === lowered || c.id.toLowerCase() === `control:${lowered}`)
  ?? (ordinal !== null ? screen.controls[ordinal - 1] : undefined)
  ?? (prefixMatches.length === 1 ? prefixMatches[0] : undefined);
if (!control) {
  return {
    ok: false,
    code: "CONTROL_STALE",
    message: `no control "${wanted}" is on ${screen.id} right now`,
    hint: screen.controls.length > 0
      ? `its controls are: ${screen.controls.map((c) => c.id).join(", ")}`
      : `civ screen ${screen.id}`,
  };
}
if (control.disabled) return { ok: false, code: "CONTROL_DISABLED", message: `${control.label} is disabled` };
const el = control.element;
if (el.tagName === "BUTTON") el.click();
else {
  const rect = el.getBoundingClientRect();
  const ignored = el.dispatchEvent(new CustomEvent("engine-input", {
    bubbles: true, cancelable: true,
    detail: { name: "mousebutton-left", status: InputActionStatuses.FINISH, x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 },
  }));
  if (ignored) return { ok: false, code: "SCREEN_INPUT_IGNORED", message: "the UI did not handle activation", hint: "civ screen reads the current controls; report this interface gap" };
}
return { ok: true, note: `sent activation to ${control.label}; run civ screen to read the result` };
