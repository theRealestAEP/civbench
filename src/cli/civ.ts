// The `civ` command (docs/PLAN.md §9.2).
//
// The shell reads; this writes. It is registered as a host command inside the sandbox, so it
// appears in /bin and pipes like any other tool, and it calls the Match Server directly rather
// than crossing a socket. Nothing else in the sandbox can reach the game.
//
// Macros matter here. `civ move u12 14,22` is one agent decision; ten adjacent-tile moves would
// be ten decisions and ten times the tokens (§6.2).
import type { MatchServer, ActionRequest, ActionResult } from "../server/match.ts";
import { tilesNear } from "./near.ts";

export type CommandOutput = { stdout: string; stderr: string; exitCode: number };

const ok = (stdout: string): CommandOutput => ({ stdout, stderr: "", exitCode: 0 });

/**
 * A refusal, on STDOUT.
 *
 * Failures used to go to stderr. A shell prints one stream after the other, so an agent running
 * `civ a; civ b; civ c` saw every success first and every failure afterwards — results no longer
 * lined up with the commands that produced them. Six of the seven transcript readers found this
 * independently: "output tells the agent the second command succeeded before the first failed",
 * "the agent cannot map result to command". One stream keeps the order.
 *
 * The exit code is unchanged, so `&&` still short-circuits.
 */
const fail = (text: string, code = 1): CommandOutput => ({ stdout: text, stderr: "", exitCode: code });

const USAGE = `civ — act on the game. Reading is done with the shell; this is the only way to act.

  civ hud                                  the turn HUD again
  civ time                                 seconds left in your turn, and the per-turn limit
  civ near <unit|x,y> [radius]             the tiles around a place, nearest first
  civ what-can <unit> [x,y]                legal unit actions now, with reasons for the rest
  civ what-can city:<id>                   legal actions for one settlement
  civ what-can player                      legal player-level actions (research, policies, ...)
  civ list-ops <kind>                       every operation name this build knows
  civ move <unit> <x,y>                    macro for UNITOPERATION_MOVE_TO
  civ attack <unit> <x,y>                  macro for a move with the attack modifier
  civ combat-preview <unit> <x,y>          what would happen if you attacked that plot
  civ skip <unit>                          macro for UNITOPERATION_SKIP_TURN
  civ promote <unit> [PROMOTION]           promotions this unit can take, or take one
  civ note <text>                          append a line to your journal (cannot overwrite it)
  civ do unit-op <unit> <TYPE> [k=v ...]   any unit operation
  civ do unit-cmd <unit> <TYPE> [k=v ...]  any unit command
  civ do city-op <city> <TYPE> [k=v ...]   any settlement operation
  civ do player-op <TYPE> [k=v ...]        any player operation
  civ say <text>                           tell every civ you have met
  civ say @<seat> <text>                   tell one civ privately
  civ inbox                                what other civs have said to you
  civ build <city> [THING] [x,y]           what that settlement can build, or build one
                                           (a building takes a plot; omit it and the game picks)
  civ expand <city> [x,y]                  where a grown city can put its new citizen
  civ tech [NODE]                          your research: what you can pick, or pick one
  civ civic [NODE]                         your civics: what you can adopt, or adopt one
  civ government [TYPE]                    your government: what you can adopt, or adopt one
  civ story [ANSWER]                       the narrative event waiting on you, or answer it
  civ tradition [TYPE]                     the social policies you can adopt, or adopt one
  civ age finish                           tell the game you are done with the Age transition
  civ celebration [TYPE]                   pick what a Celebration gives you
  civ pantheon [BELIEF]                    found a pantheon
  civ attribute [NODE]                     spend an attribute point
  civ diplomacy [player] [ACTION]          who you have met, what you can do to them, or do it
  civ deal items <player>                  what each side could put on the table
  civ deal offer <player> <KIND> [AMOUNT]  put one thing on the table
  civ deal send <player>                   propose the deal you have built
  civ deal clear <player>                  start the deal over
  civ deal pending <player>                deals awaiting a response
  civ deal incoming <player>               what a deal sent TO you contains
  civ deal accept <player>                 accept the deal they sent you
  civ deal reject <player>                 turn it down
  civ resource [<resource> <city>]         assign a new resource to a settlement, or list both
  civ screen [screen-id] [control-id]      read open popup text and controls, or activate one
  civ dismiss [id]                         clear a notification; with no id, the one blocking you
  civ open <id>                            open a notification that wants a decision
  civ end-turn                             end your turn

Types come from the game's own catalogue; \`civ what-can\` lists the ones that apply.`;

/** `14,22` -> {X:14, Y:22} */
function parsePlot(text: string | undefined): { X: number; Y: number } | null {
  if (!text) return null;
  const m = /^(\d+)\s*,\s*(\d+)$/.exec(text.trim());
  return m ? { X: Number(m[1]), Y: Number(m[2]) } : null;
}

/**
 * `k=v k=v` -> {k: v}, numbers coerced. Unknown keys pass through to the engine untouched.
 *
 * The values really are open: `civ do` lets an agent name any operation, and each operation wants
 * a differently shaped argument. Naming the type says what that openness is for.
 */
export type EngineArgs = Record<string, string | number>;

function parseArgs(parts: string[]): EngineArgs {
  const out: EngineArgs = {};
  for (const part of parts) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const key = part.slice(0, eq);
    const raw = part.slice(eq + 1);
    // The engine's coordinate arguments are X and Y. Agents naturally write `x=48 y=16`, the
    // engine ignores the lowercase keys, and the order is refused "with no reason" — a move to a
    // real plot that silently does nothing. Normalise the two coordinate keys; every other key
    // passes through untouched, since the rest of the engine's arguments are already PascalCase.
    const norm = key === "x" ? "X" : key === "y" ? "Y" : key;
    out[norm] = /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : raw;
  }
  return out;
}

/** Accept `u12`, `unit:12`, or `12` — agents write ids all three ways. */
function parseId(text: string | undefined): string | null {
  if (!text) return null;
  const m = /^(?:u|unit:|c|city:|settlement:)?(\d+)$/i.exec(text.trim());
  return m ? m[1]! : null;
}

/**
 * A unit argument: a handle like `scout-1`, or the raw ComponentID.
 *
 * Agents were inventing ids by adding 65536 to the last one they saw, and ordering whatever came
 * back. Handles are what the dump leads with now, so they are what commands must accept.
 */
function parseUnit(server: MatchServer, playerId: number, text: string | undefined): string | null {
  if (!text) return null;
  const direct = parseId(text);
  if (direct) return direct;
  const resolved = server.resolveHandle(playerId, text);
  return parseId(resolved);
}

/** Pull the "What changed" section out of the turn-start HUD, which is the one part that keeps. */
function deltaOf(hud: string): string {
  const start = hud.indexOf("## What changed");
  if (start < 0) return "";
  const rest = hud.slice(start + "## What changed".length);
  const end = rest.indexOf("\n## ");
  return (end < 0 ? rest : rest.slice(0, end)).trim();
}

function renderResult(result: ActionResult): CommandOutput {
  // A success can still carry something the agent must read — "your turn is already over" rode
  // on `message`, which this printed only for failures, so the agent saw a bare "ok".
  if (result.ok) {
    const said = result.note ?? result.message;
    return ok((said ? `ok — ${said}\n` : "ok\n") + (result.hint ? `hint: ${result.hint}\n` : ""));
  }
  // Failure messages are part of the benchmark surface (§10): always a reason, and a remedy
  // when the engine gave us one.
  const lines = [`failed: ${result.code ?? "ERROR"}`, result.message ?? "no reason given"];
  // The facts the engine gave us about the subject. These were being collected and then thrown
  // away here, so a refusal that knew the unit had no moves left still printed "no reason".
  if (result.state) lines.push(`state: ${JSON.stringify(result.state)}`);
  if (result.hint) lines.push(`hint: ${result.hint}`);
  return fail(lines.join("\n") + "\n");
}

// eslint-disable-next-line complexity -- a CLI dispatcher: one switch case per command, each flat. Splitting it per-case would satisfy the metric without helping the reader.
export async function runCivCommand(
  server: MatchServer,
  playerId: number,
  argv: string[],
  lastHud: () => string,
): Promise<CommandOutput> {
  const [command, ...rest] = argv;

  switch (command) {
    case undefined:
    case "help":
    case "-h":
    case "--help":
      return ok(USAGE + "\n");

    case "hud":
      // Re-read, do not replay. The turn-start string is out of date the moment you act.
      return ok((await server.currentHud(playerId, deltaOf(lastHud()))) + "\n");

    case "time": {
      const clock = server.turnClock(playerId);
      if (!clock) return ok("no turn is running, so there is no clock.\n");
      const left = Math.round(clock.remainingSec);
      const used = Math.round(clock.elapsedSec);
      return ok(
        `turn time: ${left}s left of ${clock.budgetSec}s (used ${used}s).\n` +
          "When it runs out your turn ends where it stands and unfinished work is lost. " +
          "Call `civ end-turn` before then.\n",
      );
    }

    case "list-ops": {
      const kinds = await server.operationTypes();
      const wanted = rest[0];
      if (!wanted) {
        return ok(
          Object.entries(kinds)
            .map(([k, v]) => `${k}  (${v.length})`)
            .join("\n") + "\n\nusage: civ list-ops <kind>\n",
        );
      }
      const list = kinds[wanted];
      if (!list) return fail(`unknown kind: ${wanted}. One of: ${Object.keys(kinds).join(", ")}\n`);
      return ok(list.join("\n") + "\n");
    }

    case "what-can": {
      // Settlements and the player have catalogues too. Agents were guessing action names
      // because only units were discoverable.
      const first = rest[0] ?? "";
      if (first === "player") {
        const result = await server.catalogue(playerId, "player");
        const legal = (result.legal ?? []).map((a) => `  ${a.short}  (${a.type})`).join("\n");
        return ok(`legal player actions:\n${legal || "  (none)"}\n`);
      }
      if (/^(city|settlement):/i.test(first)) {
        const id = parseId(first);
        if (!id) return fail("usage: civ what-can city:<id>\n");
        const result = await server.catalogue(playerId, "city", id);
        if (result.error) return fail(result.error + "\n");
        // BUILD is listed here, and reaching it through `civ do city-op` means guessing an
        // argument key. Send the agent to the command that already knows it.
        const legal = (result.legal ?? [])
          .map((a) =>
            a.type === "CITYOPERATION_BUILD"
              ? `  ${a.short}  (${a.type})  -> use: civ build ${id} <THING>, or civ build ${id} for the list`
              : `  ${a.short}  (${a.type})`,
          )
          .join("\n");
        return ok(`legal actions for settlement ${id}:\n${legal || "  (none)"}\n`);
      }

      const unit = parseUnit(server, playerId, rest[0]);
      if (!unit) return fail("usage: civ what-can <unit|city:id|player> [x,y]\n");
      const plot = parsePlot(rest[1]);
      const result = await server.whatCan(playerId, unit, plot ? { x: plot.X, y: plot.Y } : undefined);
      const legal = (result.legal ?? []).map((a) => `  ${a.short}  (${a.type})`).join("\n");
      const illegal = (result.illegal ?? [])
        .filter((a) => a.why)
        .map((a) => `  ${a.short}: ${a.why}`)
        .join("\n");
      // A busy unit refuses everything with no reasons; the fact explains the whole listing.
      const busy = result.busy
        ? "NOTE: this unit is busy with an operation it has not finished. It will refuse new\n" +
          `orders and it does not block your turn. \`civ do unit-cmd ${unit} UNITCOMMAND_CANCEL\` cancels it.\n\n`
        : "";
      return ok(`${busy}legal:\n${legal || "  (none)"}\n\nunavailable:\n${illegal || "  (none)"}\n`);
    }

    case "near": {
      const asked = Number(rest[1] ?? 3) || 3;
      const radius = Math.min(6, Math.max(1, asked));
      const plot = parsePlot(rest[0]);
      let cx: number;
      let cy: number;
      if (plot) {
        cx = plot.X;
        cy = plot.Y;
      } else {
        // Centring on a unit is the common case — that is where the agent is standing.
        const unit = parseUnit(server, playerId, rest[0]);
        if (!unit) return fail("usage: civ near <unit|x,y> [radius]\n");
        const at = server.unitLocation(playerId, unit);
        if (!at) return fail(`you have no unit ${unit}\n`);
        cx = at.x;
        cy = at.y;
      }
      const tiles = server.currentTilesText(playerId);
      if (tiles === null) return fail("no tile data for this turn yet\n");
      const lines = tilesNear(tiles, cx, cy, radius);
      const capped = asked > 6 ? ` (radius capped at 6)` : "";
      if (lines.length === 0) return ok(`nothing revealed within ${radius} of ${cx},${cy}${capped}\n`);
      return ok(`${lines.length} tiles within ${radius} of ${cx},${cy}${capped}:\n${lines.join("\n")}\n`);
    }

    case "diplomacy": {
      const other = rest[0] === undefined ? undefined : Number(String(rest[0]).replace(/^p/i, ""));
      if (rest[0] !== undefined && Number.isNaN(other)) return fail("usage: civ diplomacy [player] [ACTION]\n");
      const r = await server.diplomacy(playerId, other, rest[1]);
      if (!r.listing) return renderResult(r);
      if (r.players) {
        if (r.players.length === 0) return ok("you have met nobody yet\n");
        return ok(
          "civilizations you have met:\n" +
            r.players
              .map((p) => `  ${p.player}  ${p.civ ?? "?"}${p.atWar ? "  (at war with you)" : ""}   -> civ diplomacy ${p.player}`)
              .join("\n") +
            "\n",
        );
      }
      if ((r.offers ?? []).length === 0) return ok(`nothing you can do to ${r.target} right now\n`);
      // Every line is the command that does it, listed only if the engine accepts it.
      return ok(
        `what you can do to ${r.target}:\n` +
          (r.offers ?? []).map((o) => `  civ diplomacy ${r.target} ${o.action}`).join("\n") +
          "\n",
      );
    }

    case "combat-preview": {
      const unit = parseUnit(server, playerId, rest[0]);
      const plot = parsePlot(rest[1]);
      if (!unit || !plot) return fail("usage: civ combat-preview <unit> <x,y>\n");
      const preview = await server.combatPreview(playerId, unit, plot.X, plot.Y);
      if (preview.error) return fail(String(preview.error) + "\n");
      if (preview.possible === false) {
        return ok(`no attack possible: ${preview.reason ?? "not a valid target"}\n`);
      }
      return ok(JSON.stringify(preview, null, 2) + "\n");
    }

    case "move":
    case "attack": {
      const unit = parseUnit(server, playerId, rest[0]);
      const plot = parsePlot(rest[1]);
      if (!unit || !plot) return fail(`usage: civ ${command} <unit> <x,y>\n`);
      const args: EngineArgs = { ...plot };
      // An attack in Civ 7 is a MOVE_TO carrying the attack modifier, not a separate operation.
      if (command === "attack") args.Modifiers = "ATTACK";
      // Where it was, so we can tell whether it actually went anywhere.
      //
      // The engine ACCEPTS a move order it cannot carry out — an unreachable plot, a blocked
      // path, a target outside this turn's range — and simply does nothing. We reported `ok`
      // followed by the unit's ORIGIN, which reads exactly like a successful move to somewhere.
      //
      // The check WAITS for the engine to apply the order before judging (waitForMove). The
      // first version read the position on the next line, which is the pre-move state about as
      // often as not — so working moves were confidently reported as "unreachable", the inverse
      // of the lie it was built to stop.
      const before = await server.unitAt(playerId, unit);
      const beforeMoves = await server.unitMoves(playerId, unit);
      const moved = await server.act(playerId, {
        kind: "unit_operation",
        targetId: unit,
        actionType: "UNITOPERATION_MOVE_TO",
        args,
      });
      if (moved.ok) {
        const asked = `${plot.X},${plot.Y}`;
        const { changed, state } = await server.waitForMove(playerId, unit, {
          at: before,
          moves: beforeMoves,
        });
        if (!changed && state && state.at === before && state.at !== asked) {
          server.logCorrection(playerId, "DID_NOT_MOVE", `unit ${unit} still at ${before ?? "?"}`);
          // The accepted-but-unpathable order sits in the unit's queue as a zombie: the unit
          // turns unskippable and the engine's async worker re-chews the dead entry — the
          // pattern under every observed engine crash. Clear what we watched get created.
          await server.cancelDeadOrder(playerId, unit);
          const remaining = state.moves === null
            ? "remaining movement is unavailable"
            : `${state.moves} movement remaining`;
          const hint = state.moves === 0
            ? "this unit has finished moving for this turn; give it another move next turn"
            : `\`civ near ${unit} 2\` lists nearby plots and their move costs; check the unit's movement before choosing another destination`;
          return fail(
            `failed: DID_NOT_MOVE\n` +
              `unit ${unit} is still at ${before}; ${remaining}. The engine accepted the order ` +
              `but its position stayed unchanged. Cancellation of the stalled order was requested.\n` +
              `hint: ${hint}\n`,
          );
        }
        // A move order spends the movement the unit has and then stops, so a distant target ends
        // the turn short of it and continues next turn. Say where it ended up AND how much
        // movement is left — 69 of 73 "no moves left" refusals were an agent re-ordering a unit
        // it had just moved, because a successful move said only "ok" and never that the unit was
        // now spent. One tile can cost two movement, so "moved" does not imply "can move again".
        const where = await server.unitReport(playerId, unit);
        if (where) {
          const at = state?.at ?? null;
          const base = at !== null && at !== asked ? `${where} (short of ${asked})` : where;
          const left = state?.moves ?? null;
          const spent =
            left === 0
              ? " — no movement left, this unit is done for the turn"
              : left != null
                ? ` — ${left} movement left`
                : "";
          moved.note = `${base}${spent}`;
        }
      }
      return renderResult(moved);
    }

    case "note": {
      const text = rest.join(" ");
      if (!text) return fail("usage: civ note <text>\n");
      return renderResult(await server.note(playerId, text));
    }

    case "resource": {
      // Answers NOTIFICATION_ASSIGN_NEW_RESOURCES. No args = list the resources and the settlements
      // that can take them; `civ resource <resource> <city>` assigns one.
      const which = rest[0];
      if (!which) {
        const { resources, cities } = await server.resources(playerId);
        if (resources.length === 0) return ok("you have no resources to assign right now\n");
        const lines = ["resources you can assign:"];
        for (const r of resources) lines.push(`  ${r.name}`);
        lines.push("settlements that can take one:");
        for (const c of cities) lines.push(`  ${c.name}  city:${c.id}`);
        lines.push("assign with: civ resource <resource> <city>");
        return ok(lines.join("\n") + "\n");
      }
      const city = parseId(rest[1]);
      if (!city) return fail("usage: civ resource <resource> <city>   (run `civ resource` to list both)\n");
      return renderResult(await server.assignResource(playerId, which, city));
    }

    case "skip": {
      const unit = parseUnit(server, playerId, rest[0]);
      if (!unit) return fail("usage: civ skip <unit>\n");
      const skipped = await server.act(playerId, {
        kind: "unit_operation",
        targetId: unit,
        actionType: "UNITOPERATION_SKIP_TURN",
      });
      // "Already finished" is turned into a success in act.js, so the event log records what the
      // agent actually saw rather than a failure it never experienced.
      return renderResult(skipped);
    }

    case "do": {
      const [form, ...tail] = rest;
      // `satisfies` keeps each value checked against ActionRequest["kind"] while the key
      // literals survive, so the lookup below narrows instead of widening to string.
      const kinds = {
        "unit-op": "unit_operation",
        "unit-cmd": "unit_command",
        "city-op": "city_operation",
        "city-cmd": "city_command",
        "player-op": "player_operation",
      } satisfies Record<string, ActionRequest["kind"]>;
      // SAFETY: guarded by hasOwn, so `form` is one of the table's own keys.
      const kind = Object.hasOwn(kinds, form ?? "") ? kinds[form as keyof typeof kinds] : undefined;
      if (!kind) return fail(`unknown action form: ${form ?? "(none)"}\n\n${USAGE}\n`);

      if (kind === "player_operation") {
        const [actionType, ...pairs] = tail;
        if (!actionType) return fail("usage: civ do player-op <TYPE> [k=v ...]\n");
        return renderResult(
          await server.act(playerId, { kind, actionType, args: parseArgs(pairs) }),
        );
      }
      const targetId = parseId(tail[0]);
      const actionType = tail[1];
      if (!targetId || !actionType) return fail(`usage: civ do ${form} <id> <TYPE> [k=v ...]\n`);
      return renderResult(
        await server.act(playerId, { kind, targetId, actionType, args: parseArgs(tail.slice(2)) }),
      );
    }

    case "say": {
      if (rest.length === 0) return fail("usage: civ say [@seat] <text>\n");
      // `@name` addresses one seat; anything else is a broadcast.
      const addressed = rest[0]!.startsWith("@");
      const to = addressed ? rest[0]!.slice(1) : null;
      const text = (addressed ? rest.slice(1) : rest).join(" ");
      if (!text.trim()) return fail("nothing to say\n");
      return renderResult(await server.say(playerId, to, text));
    }

    case "inbox": {
      // Show the messages rather than describing where they live. This used to spend one of the
      // agent's commands to be told to read a file, which is a command it will never get back.
      const text = server.currentMessages(playerId);
      return ok(text && text.trim().length > 0 ? text : "nobody has said anything to you\n");
    }

    // One case for every "pick a thing" decision. They differ only in the argument shape the
    // engine wants, and that lives in one table game-side rather than in a case each here.
    case "build":
    case "expand":
    case "tech":
    case "civic":
    case "story":
    case "promote":
    case "tradition":
    case "age":
    case "celebration":
    case "pantheon":
    case "attribute":
    case "government": {
      const what = command;
      const isCity = what === "build" || what === "expand" || what === "promote";
      const targetId = isCity ? parseUnit(server, playerId, rest[0]) ?? undefined : undefined;
      if (isCity && !targetId) {
        return fail(`usage: civ ${command} <${command === "promote" ? "unit" : "city"}> [value]\n`);
      }
      const value = rest[isCity ? 1 : 0];
      // `civ build <city> <THING> [x,y]` — a building needs a plot, and the engine picks a legal
      // one when the agent does not name it. `civ build <city>` lists the plots each item may go on.
      const plot = what === "build" ? rest[2] : undefined;
      const r = await server.choose(playerId, what, value, targetId, plot);
      if (!r.listing) {
        // A build joins a queue rather than replacing what is in progress, so say what the queue
        // holds now. Without this an agent sees "ok", looks, still sees the previous item at the
        // front, and reasonably concludes the order was ignored.
        // Verify it is actually there. An `ok` is not evidence.
        //
        // The engine accepts CITYOPERATION_BUILD with the wrong argument encoding and queues
        // nothing. A live turn printed "BUILDING_GRANARY added to the build queue" and then
        // "Pārsa has nothing in its build queue" — both true statements from this harness, in the
        // same turn. Read the queue back and refuse to claim anything that is not in it.
        if (r.ok && what === "build" && targetId && value) {
          // waitForQueued polls until the engine has applied the order: judging from an immediate
          // read produced false NOT_QUEUED verdicts for orders that had worked, and comparing
          // against only the queue HEAD failed every order that queued behind one.
          const queue = await server.waitForQueued(playerId, targetId, value);
          if (queue && !queue.includes(value)) {
            server.logCorrection(playerId, "NOT_QUEUED", `${value} missing from queue: ${queue}`);
            return fail(
              `failed: NOT_QUEUED\n` +
                `the engine accepted the order and queued nothing. ${queue}\n` +
                `hint: run \`civ build ${targetId}\` to see what this settlement can actually make\n`,
            );
          }
          if (!queue) {
            server.logCorrection(playerId, "NOT_QUEUED", `${value} — queue still empty`);
            return fail(
              `failed: NOT_QUEUED\n` +
                `the engine accepted the order but the build queue is still empty.\n` +
                `hint: run \`civ build ${targetId}\` to see what this settlement can actually make\n`,
            );
          }
          r.note = r.note ? `${r.note}; ${queue}` : queue;
        }
        return renderResult(r);
      }
      // Every line is the command that picks it. A list an agent must still translate into
      // arguments is what cost 25 failed guesses in one turn.
      const prefix = `civ ${command}${isCity ? ` ${targetId}` : ""}`;
      const lines = [`${what} now: ${r.current ?? "nothing"}`];
      const open = (r.options ?? []).filter((o) => o.available !== false);
      const shut = (r.options ?? []).filter((o) => o.available === false);
      // What the option IS, beside the command that picks it. A bare id list forced agents to
      // cross-reference by hand — one expanded onto the wrong tile that way.
      const describe = (o: { turns?: number | null; title?: string | null; does?: string | null }): string => {
        const parts = [
          o.turns ? `${o.turns} turns` : null,
          o.title ?? null,
          o.does ? String(o.does).slice(0, 100) : null,
        ].filter(Boolean);
        return parts.length > 0 ? `    # ${parts.join(" — ")}` : "";
      };
      if (open.length > 0) {
        lines.push("", "you can pick:");
        for (const o of open) lines.push(`  ${prefix} ${o.name}${describe(o)}`);
      } else {
        lines.push("", "nothing is available right now");
      }
      if (shut.length > 0) {
        lines.push("", "not yet:");
        for (const o of shut) lines.push(`  ${o.name}${o.why ? ` — ${o.why}` : ""}`);
      }
      return ok(lines.join("\n") + "\n");
    }

    case "deal": {
      const mode = rest[0];
      const other = Number(String(rest[1] ?? "").replace(/^p/, ""));
      const modes = ["items", "pending", "incoming", "offer", "send", "accept", "reject", "clear"];
      if (!mode || !modes.includes(mode) || Number.isNaN(other)) {
        return fail(`usage: civ deal <${modes.join("|")}> <player> [KIND] [AMOUNT|SUBJECT]\n`);
      }
      // `offer` puts one item on the table; the rest read or act on the working deal.
      const extra = mode === "offer" ? { kind: rest[2], amount: Number(rest[3]) || undefined, subject: rest[3] } : undefined;
      const result = await server.deal(playerId, mode, other, extra);
      if (result?.error) return fail(`failed: ${result.error}\n${result.hint ? `hint: ${result.hint}\n` : ""}`);
      if (result.incoming) {
        if (result.incoming.length === 0) return ok(`no deal from p${other} is waiting on you\n`);
        const lines = result.incoming.map(
          (i) => `  ${i.from} offers ${i.kind}${i.of ? ` ${i.of}` : ""}${i.amount ? ` x${i.amount}` : ""}${i.turns ? ` for ${i.turns} turns` : ""}`,
        );
        return ok(
          `deal from p${other}:\n${lines.join("\n")}\n` +
            `answer it: \`civ deal accept ${other}\` or \`civ deal reject ${other}\`\n`,
        );
      }
      if (result.offerable) {
        if (result.offerable.length === 0) return ok(`nothing either side can offer p${other} right now\n`);
        // Every line is the command that puts it on the table.
        // `of` names what the item IS — the resource, the agreement. The old renderer read
        // `city` and `resource`, neither of which a deal item has ever carried.
        const lines = result.offerable.map(
          (i) => `  ${i.from} ${i.kind}${i.of ? ` ${i.of}` : ""}${i.amount ? ` up to ${i.amount}` : ""}` +
            (i.valid === false ? "  (not valid right now)" : "") +
            (i.from === `p${playerId}` ? `   -> civ deal offer ${other} ${i.kind}${i.amount ? " <amount>" : ""}` : ""),
        );
        return ok(`what can go on the table with p${other}:\n${lines.join("\n")}\n`);
      }
      return ok(JSON.stringify(result, null, 2) + "\n");
    }

    case "screen": {
      if (rest.length > 2) return fail("usage: civ screen [screen-id] [control-id]\n");
      const result = await server.screen(playerId, rest[0], rest[1]);
      if (!result.ok || rest[1]) return renderResult(result);
      return ok(JSON.stringify(result, null, 2) + "\n");
    }

    case "dismiss":
    case "open": {
      const id = rest[0] ? (parseId(rest[0]) ?? rest[0]) : undefined;
      if (command === "open" && !id) return fail("usage: civ open <id>\n");
      return renderResult(await server.notify(playerId, command === "open" ? "activate" : "dismiss", id));
    }

    case "end-turn":
      return renderResult(await server.endTurn(playerId));

    default:
      return fail(`unknown command: ${command}\n\n${USAGE}\n`);
  }
}
