// What the game-side scripts hand back, named once.
//
// These used to be `Promise<unknown>`, and every caller re-asserted the shape at the point of use
// — nine `as` casts in civ.ts alone, each one a separate chance to describe the same payload
// differently. A shape stated once is a shape that can be wrong in only one place.
//
// Note the boundary these sit on. The scripts run inside Civ 7 and return JSON, so nothing here
// is verified by the compiler: these types say what the script is written to return. When a
// script changes, this file changes with it. That is the contract, and it is worth writing down
// precisely because it cannot be enforced.
import type { ActionResult } from "./match.ts";

/** One thing an agent can pick, as `civ tech` / `civ tradition` / `civ expand` list them. */
export type ChoiceOption = {
  name: string;
  /** The human-readable name and effect, where the game has them. */
  title?: string | null;
  does?: string | null;
  turns?: number | null;
  available?: boolean;
  active?: boolean;
  kind?: string;
  /** Gold, for `civ buy`. */
  cost?: number | null;
  why?: string | null;
};

/** `civ attack` asks this before choosing a ranged attack over a melee move. */
export type StrikeOptions = {
  ranged: boolean;
  /** It can also attack by moving onto the enemy, the way a galley or a warrior does. */
  melee?: boolean;
  canStrikeNow: boolean;
  plots: Array<{ at: string; what: string | null }>;
  error?: string;
};

/** `civ <decision>` with no value lists; with a value it acts. */
export type ChooseResult = ActionResult & {
  listing?: boolean;
  current?: string | null;
  options?: ChoiceOption[];
};

/** The engine's own catalogue of legal operations for a subject. */
export type CatalogueResult = {
  error?: string;
  legal?: Array<{ short: string; type: string }>;
};

/** `civ what-can <unit>` — what this unit may do, and why the rest is refused. */
export type WhatCanResult = {
  error?: string;
  unit?: { id: string; type: string | null; at: string | null; moves: number | null };
  /** A unit with a queued operation refuses everything and blocks nothing. */
  busy?: boolean;
  legal?: Array<{ short: string; type: string; kind?: string }>;
  illegal?: Array<{ short: string; type: string; why: string | null }>;
};

/** `civ diplomacy` — who you have met, or what you may do to one of them. */
export type DiplomacyResult = ActionResult & {
  listing?: boolean;
  players?: Array<{ player: string; civ: string | null; atWar: boolean; greetingOwed?: boolean }>;
  target?: string;
  offers?: Array<{ operation: string; action: string }>;
  /** Whether this civ has just met you and waits on a greeting. */
  greetingOwed?: boolean;
  /** Proposals from other civs waiting on accept/reject. */
  proposals?: Array<{ id: string; from: string | null; action: string | null }>;
};

/** One item either side could put on a trade deal. */
export type DealItem = {
  from: string;
  to: string;
  kind: string;
  /** What the item is OF — the resource, the agreement. */
  of: string | null;
  amount: number | null;
  turns: number | null;
  valid: boolean | null;
};

export type DealResult = ActionResult & {
  error?: string;
  offerable?: DealItem[];
  kinds?: string[];
  hasPending?: boolean;
  dealIds?: string[];
  /** The items in a deal another player sent to this one. */
  incoming?: DealItem[];
  count?: number;
  /** Set after `accept` or `reject`. */
  responded?: string;
  added?: string;
  sent?: boolean;
  cleared?: boolean;
};

/**
 * `civ attack <unit> <x,y>` — the odds, before committing.
 *
 * The engine answers asynchronously: the first call says only whether an attack is possible and
 * of what kind, and the damage estimate arrives on a later read. Every field is therefore
 * optional — a preview that times out still carries the kind, which is worth having.
 */
export type CombatPreview = {
  possible?: boolean;
  kind?: string;
  error?: string;
  /** Why no attack is possible, when the engine says. */
  reason?: string;
  ready?: boolean;
  /** Present once the engine has produced an estimate. */
  results?: unknown;
  /** Set when the estimate did not arrive in time. */
  note?: string;
};

/** Where a unit is once the engine has applied its orders. */
export type UnitState = {
  error?: string;
  id: string;
  at: string | null;
  moves: number | null;
  maxMoves: number | null;
  hasMoved: boolean | null;
  canMove: boolean | null;
};
