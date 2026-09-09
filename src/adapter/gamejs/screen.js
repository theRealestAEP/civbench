// Read the current seat's popup text and activate one of its observed controls.
if (GameContext.localPlayerID !== PLAYER_ID) {
  return { ok: false, code: "SCREEN_WRONG_SEAT", message: "the visible UI belongs to another seat; read again when your seat is local" };
}
const screens = screenInventory();
const screen = TARGET_ID ? screens.find((s) => s.id === TARGET_ID) : null;
if (TARGET_ID && !screen) {
  return { ok: false, code: "SCREEN_STALE", message: "no open screen matches that id", hint: "run civ screen and use only the ids it returns; an empty list means no screen is open. Read pending.txt for notification commands" };
}
if (!ARGS.control) return { ok: true, screens: (screen ? [screen] : screens).map(screenRecord) };
if (!screen) return { ok: false, code: "SCREEN_REQUIRED", message: "specify the screen id from civ screen" };
const top = screens.filter((s) => s.layer === "popup").at(-1);
if (top && screen !== top) {
  return { ok: false, code: "SCREEN_COVERED", message: "another popup is above this screen", hint: `civ screen ${top.id}` };
}
const control = screen.controls.find((c) => c.id === ARGS.control);
if (!control) return { ok: false, code: "CONTROL_STALE", message: "that control has changed", hint: `civ screen ${screen.id}` };
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
