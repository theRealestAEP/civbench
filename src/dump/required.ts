// What the game will not let you skip (docs/PLAN.md §6.4).
//
// Civ blocks the end of a turn until certain decisions are made: choose a technology, place a new
// citizen, answer a narrative event. That is a hard requirement, and we were showing it as one
// item in a list of three, mid-way down a stats line — `pending: 3 items (blocking: X)` — with no
// indication of which was mandatory and no command to answer it.
//
// An agent that cannot tell "you must do this" from "here is a thing that happened" spends its
// turn guessing, and then cannot end it. Representing the requirement as a requirement is part of
// representing the state accurately, not a hint.

/** The command that answers a blocking notification, where one exists. */
const ANSWERS: Array<[RegExp, string]> = [
  [/CHOOSE_TECH|CHOOSE_RESEARCH/, "civ tech"],
  [/CULTURE_NODE|CHOOSE_CIVIC/, "civ civic"],
  [/NEW_POPULATION|POPULATION_GROWTH/, "civ expand <city>"],
  [/STORY_DIRECTION|NARRATIVE/, "civ story"],
  [/GOLDEN_AGE|CELEBRATION/, "civ celebration"],
  [/PANTHEON/, "civ pantheon"],
  [/ATTRIBUTE/, "civ attribute"],
  [/GOVERNMENT/, "civ government"],
  // Adopting does NOT clear this one. The game's policy screen sends its "finished considering"
  // signal when it closes, and that is what the notification waits for.
  [/TRADITION|POLICY|POLICIES/, "civ tradition <TYPE>, then `civ tradition done`"],
  [/AGE_TRANSITION|AGE_ENDED|CHOOSE_AGE/, "civ age finish"],
  [/UNIT_PROMOTION|PROMOTION_AVAILABLE/, "civ promote <unit>"],
  // Advisor warnings are informational but can block; dismissal usually clears them, and when it
  // does not, activating the notification does.
  [/ADVISOR_WARNING/, "civ dismiss — and if it will not clear, civ open <id>"],
  [/CRISIS/, "civ what-can player"],
  [/PRODUCTION|CHOOSE_PRODUCTION/, "civ build <city>"],
  [/COMMAND_UNITS|MOVE_A_UNIT|UNIT/, "civ move <unit> <x,y>, or civ skip <unit>"],
];

export function answerFor(notificationType: string | null): string | null {
  if (!notificationType) return null;
  for (const [pattern, command] of ANSWERS) {
    if (pattern.test(notificationType)) return command;
  }
  return null;
}

export type PendingItem = { type: string | null; summary: string | null; blocking?: boolean };

/**
 * The lines an agent must act on, first, in their own section.
 *
 * Deliberately only the blocking ones. Everything else stays in the full pending list, because
 * deciding what merits attention is the agent's job — but a hard requirement is not a judgement
 * call, it is a fact about the game state.
 */
export function requiredLines(items: PendingItem[], blockingType: string | null): string[] {
  // The snapshot's PendingItem carries no `blocking` flag; match on the blocking type the engine
  // named. Without this the per-item branch was dead code and only the bare fallback ever ran.
  const blocking = items.filter((i) => i.blocking || (i.type !== null && i.type === blockingType));
  // The engine names one blocker at a time; trust it over the per-item flags when they disagree.
  if (blocking.length === 0 && !blockingType) return [];

  const out = ["", "## YOU MUST DO THIS BEFORE THE TURN CAN END"];
  const seen = new Set<string>();
  for (const item of blocking.length > 0 ? blocking : [{ type: blockingType, summary: null }]) {
    const label = (item.summary ?? item.type ?? "something").replace(/_/g, " ");
    const answer = answerFor(item.type ?? blockingType);
    const key = `${label}|${answer}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(answer ? `  ${label}  ->  ${answer}` : `  ${label}`);
  }
  out.push("  `civ end-turn` will refuse until this is done, and will say so.");
  return out;
}
