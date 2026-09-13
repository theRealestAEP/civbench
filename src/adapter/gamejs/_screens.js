// Shared DOM access for pending.js and screen.js. Controls use the same engine-input event
// as Firaxis' legacy FxsActivatable and Solid Activatable components.
function screenVisible(el) {
  for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (node.hidden || node.getAttribute("aria-hidden") === "true" ||
        style.display === "none" || style.visibility === "hidden") return false;
  }
  return true;
}

function screenText(el) {
  if (!screenVisible(el)) return "";
  const parts = [];
  for (const node of el.childNodes) {
    if (node.nodeType === 3) parts.push(node.textContent);
    else if (node.nodeType === 1 && !["SCRIPT", "STYLE"].includes(node.tagName)) parts.push(screenText(node));
  }
  return parts.join(" ").replace(/LOC_[A-Z0-9_]+/g, (key) => Locale.compose(key))
    .replace(/\s+/g, " ").trim();
}

function screenDisabled(el) {
  return el.matches(':disabled, [disabled="true"], [disabled=""], [aria-disabled="true"], .disabled') ||
    !!el.parentElement?.closest('[disabled="true"], [aria-disabled="true"], .disabled');
}

function screenInventory() {
  if (typeof document === "undefined" || GameContext.localPlayerID !== PLAYER_ID) return [];
  // Ids come from what a control SAYS, not from which DOM node it is. Gameface re-renders a
  // screen freely, so a read can hand back fresh elements for the same buttons, and ids tied to
  // node identity went stale between one read and the next command: 56 of 83 activations in one
  // run failed as CONTROL_STALE on a single screen, and the seat never got through its Age
  // transition. A label is what a human would click, and it survives a re-render. Duplicate
  // labels count up: Empty_Slot, Empty_Slot#2, Empty_Slot#3.
  const slug = (text) => String(text ?? "").trim().replace(/\s+/g, "_").replace(/[^\w.'()#-]/g, "").slice(0, 40) || "control";
  const seen = new Map();
  const idFor = (prefix, label) => {
    const base = `${prefix}:${slug(label)}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return n === 1 ? base : `${base}#${n}`;
  };
  // ContextManager also mounts choosers in named layout slots. Popup roots overlay them.
  const roots = [...document.querySelectorAll('[id^="target-slot-"]'), ...document.querySelectorAll(".fxs-popups")];
  const screens = [];
  for (const root of roots) for (const el of root.children) {
    const tag = el.tagName.toLowerCase();
    if (tag === "mouse-guard" || !screenVisible(el)) continue;
    const controls = [];
    const selector = '[data-activatable="true"], fxs-activatable, fxs-button, fxs-chooser-item, fxs-checkbox, fxs-close-button, fxs-reward-button, fxs-icon-button, fxs-dropdown, fxs-dropdown-item, fxs-tab-item, fxs-minmax-button, fxs-hero-button, fxs-text-button, fxs-selector, fxs-selector-ornate, fxs-minus-plus, fxs-link, fxs-edit-button, button, [role="button"]';
    // Gameface can return the same element once per matching selector.
    for (const button of new Set(el.querySelectorAll(selector))) {
      if (!screenVisible(button)) continue;
      const label = button.getAttribute("aria-label") || button.getAttribute("caption") ||
        screenText(button) || button.getAttribute("data-tooltip-content") ||
        screenText(button.closest(".advisor-card") ?? button) || button.getAttribute("data-name") || button.tagName.toLowerCase();
      controls.push({
        element: button,
        id: idFor("control", label),
        label: label.replace(/LOC_[A-Z0-9_]+/g, (key) => Locale.compose(key)),
        disabled: screenDisabled(button),
        selected: button.getAttribute("aria-checked") ?? button.getAttribute("aria-selected") ?? button.getAttribute("selected"),
        context: screenText(button.closest(".advisor-card")?.querySelector(".advisor-card-title") ?? button),
        description: button.getAttribute("data-tooltip-content") ?? button.getAttribute("title"),
      });
    }
    const gaps = [];
    if (!controls.length) gaps.push("screen has no exposed activation controls");
    for (const input of el.querySelectorAll('input, textarea, select, [role="slider"], fxs-slider, fxs-textbox')) {
      if (screenVisible(input)) gaps.push(`value input requires interface support: ${input.tagName.toLowerCase()}`);
    }
    const text = screenText(el);
    if (!text) gaps.push("screen text missing");
    screens.push({ layer: root.classList.contains("fxs-popups") ? "popup" : "panel", element: el, id: idFor("screen", tag), tag, text, controls, gaps });
  }
  return screens;
}

function screenRecord(screen) {
  return {
    id: screen.id, type: `SCREEN_${screen.tag.toUpperCase().replace(/-/g, "_")}`,
    summary: `open screen: ${screen.tag}; read and act with civ screen ${screen.id}`,
    message: screen.text,
    controls: screen.controls.map(({ id, label, disabled, selected, context, description }) => ({ id, label, disabled, selected, context, description })),
    interfaceGaps: screen.gaps,
  };
}
