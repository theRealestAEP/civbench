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
const fail = (stderr: string, code = 1): CommandOutput => ({ stdout: "", stderr, exitCode: code });

const USAGE = `civ — act on the game. Reading is done with the shell; this is the only way to act.

  civ hud                                  the turn HUD again
  civ near <unit|x,y> [radius]             the tiles around a place, nearest first
  civ what-can <unit> [x,y]                legal unit actions now, with reasons for the rest
  civ what-can city:<id>                   legal actions for one settlement
  civ what-can player                      legal player-level actions (research, policies, ...)
  civ list-ops <kind>                       every operation name this build knows
  civ move <unit> <x,y>                    macro for UNITOPERATION_MOVE_TO
  civ attack <unit> <x,y>                  macro for a move with the attack modifier
  civ combat-preview <unit> <x,y>          what would happen if you attacked that plot
  civ skip <unit>                          macro for UNITOPERATION_SKIP_TURN
  civ do unit-op <unit> <TYPE> [k=v ...]   any unit operation
  civ do unit-cmd <unit> <TYPE> [k=v ...]  any unit command
  civ do city-op <city> <TYPE> [k=v ...]   any settlement operation
  civ do player-op <TYPE> [k=v ...]        any player operation
  civ say <text>                           tell every civ you have met
  civ say @<seat> <text>                   tell one civ privately
  civ inbox                                what other civs have said to you
  civ build <city> [THING]                 what that settlement can build, or build one
  civ expand <city> [x,y]                  where a grown city can put its new citizen
  civ tech [NODE]                          your research: what you can pick, or pick one
  civ civic [NODE]                         your civics: what you can adopt, or adopt one
  civ government [TYPE]                    your government: what you can adopt, or adopt one
  civ story [ANSWER]                       the narrative event waiting on you, or answer it
  civ civic [NODE]                         what civics you can adopt, or pick one
  civ deal items <player>                  what each side could put on the table
  civ deal pending <player>                deals awaiting a response
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

/** `k=v k=v` -> {k: v}, numbers coerced. Unknown keys pass through to the engine untouched. */
function parseArgs(parts: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const part of parts) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const key = part.slice(0, eq);
    const raw = part.slice(eq + 1);
    out[key] = /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : raw;
  }
  return out;
}

/** Accept `u12`, `unit:12`, or `12` — agents write ids all three ways. */
function parseId(text: string | undefined): string | null {
  if (!text) return null;
  const m = /^(?:u|unit:|c|city:|settlement:)?(\d+)$/i.exec(text.trim());
  return m ? m[1]! : null;
}

function renderResult(result: ActionResult): CommandOutput {
  if (result.ok) return ok(result.note ? `ok — ${result.note}\n` : "ok\n");
  // Failure messages are part of the benchmark surface (§10): always a reason, and a remedy
  // when the engine gave us one.
  const lines = [`failed: ${result.code ?? "ERROR"}`, result.message ?? "no reason given"];
  if (result.hint) lines.push(`hint: ${result.hint}`);
  return fail(lines.join("\n") + "\n");
}

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
      return ok(lastHud() + "\n");

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
        const result = (await server.catalogue(playerId, "player")) as {
          legal?: Array<{ short: string; type: string }>;
        };
        const legal = (result.legal ?? []).map((a) => `  ${a.short}  (${a.type})`).join("\n");
        return ok(`legal player actions:\n${legal || "  (none)"}\n`);
      }
      if (/^(city|settlement):/i.test(first)) {
        const id = parseId(first);
        if (!id) return fail("usage: civ what-can city:<id>\n");
        const result = (await server.catalogue(playerId, "city", id)) as {
          error?: string;
          legal?: Array<{ short: string; type: string }>;
        };
        if (result.error) return fail(result.error + "\n");
        // BUILD is listed here, and reaching it through `civ do city-op` means guessing an
        // argument key. Send the agent to the command that already knows it.
        const legal = (result.legal ?? [])
          .map((a) =>
            a.type === "CITYOPERATION_BUILD"
              ? `  ${a.short}  (${a.type})  -> use: civ build ${id} <THING>, listed by civ produce ${id}`
              : `  ${a.short}  (${a.type})`,
          )
          .join("\n");
        return ok(`legal actions for settlement ${id}:\n${legal || "  (none)"}\n`);
      }

      const unit = parseId(rest[0]);
      if (!unit) return fail("usage: civ what-can <unit|city:id|player> [x,y]\n");
      const plot = parsePlot(rest[1]);
      const result = (await server.whatCan(
        playerId,
        unit,
        plot ? { x: plot.X, y: plot.Y } : undefined,
      )) as { legal?: Array<{ short: string; type: string }>; illegal?: Array<{ short: string; reasons: string[] }> };
      const legal = (result.legal ?? []).map((a) => `  ${a.short}  (${a.type})`).join("\n");
      const illegal = (result.illegal ?? [])
        .filter((a) => a.reasons.length > 0)
        .map((a) => `  ${a.short}: ${a.reasons.join("; ")}`)
        .join("\n");
      return ok(`legal:\n${legal || "  (none)"}\n\nunavailable:\n${illegal || "  (none)"}\n`);
    }

    case "near": {
      const radius = Math.min(6, Math.max(1, Number(rest[1] ?? 3) || 3));
      const plot = parsePlot(rest[0]);
      let cx: number;
      let cy: number;
      if (plot) {
        cx = plot.X;
        cy = plot.Y;
      } else {
        // Centring on a unit is the common case — that is where the agent is standing.
        const unit = parseId(rest[0]);
        if (!unit) return fail("usage: civ near <unit|x,y> [radius]\n");
        const at = server.unitLocation(playerId, unit);
        if (!at) return fail(`you have no unit ${unit}\n`);
        cx = at.x;
        cy = at.y;
      }
      const tiles = server.currentTilesText(playerId);
      if (tiles === null) return fail("no tile data for this turn yet\n");
      const lines = tilesNear(tiles, cx, cy, radius);
      if (lines.length === 0) return ok(`nothing revealed within ${radius} of ${cx},${cy}\n`);
      return ok(`${lines.length} tiles within ${radius} of ${cx},${cy}:\n${lines.join("\n")}\n`);
    }

    case "combat-preview": {
      const unit = parseId(rest[0]);
      const plot = parsePlot(rest[1]);
      if (!unit || !plot) return fail("usage: civ combat-preview <unit> <x,y>\n");
      const preview = (await server.combatPreview(playerId, unit, plot.X, plot.Y)) as Record<string, unknown>;
      if (preview.error) return fail(String(preview.error) + "\n");
      if (preview.possible === false) {
        return ok(`no attack possible: ${preview.reason ?? "not a valid target"}\n`);
      }
      return ok(JSON.stringify(preview, null, 2) + "\n");
    }

    case "move":
    case "attack": {
      const unit = parseId(rest[0]);
      const plot = parsePlot(rest[1]);
      if (!unit || !plot) return fail(`usage: civ ${command} <unit> <x,y>\n`);
      const args: Record<string, unknown> = { ...plot };
      // An attack in Civ 7 is a MOVE_TO carrying the attack modifier, not a separate operation.
      if (command === "attack") args.Modifiers = "ATTACK";
      return renderResult(
        await server.act(playerId, {
          kind: "unit_operation",
          targetId: unit,
          actionType: "UNITOPERATION_MOVE_TO",
          args,
        }),
      );
    }

    case "skip": {
      const unit = parseId(rest[0]);
      if (!unit) return fail("usage: civ skip <unit>\n");
      return renderResult(
        await server.act(playerId, {
          kind: "unit_operation",
          targetId: unit,
          actionType: "UNITOPERATION_SKIP_TURN",
        }),
      );
    }

    case "do": {
      const [form, ...tail] = rest;
      const kinds: Record<string, ActionRequest["kind"]> = {
        "unit-op": "unit_operation",
        "unit-cmd": "unit_command",
        "city-op": "city_operation",
        "city-cmd": "city_command",
        "player-op": "player_operation",
      };
      const kind = kinds[form ?? ""];
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
      // The turn's messages are written into the dump, so the agent can also just read them.
      return ok("messages are in /current/messages.txt — read that file\n");
    }

    // One case for every "pick a thing" decision. They differ only in the argument shape the
    // engine wants, and that lives in one table game-side rather than in a case each here.
    case "build":
    case "expand":
    case "tech":
    case "civic":
    case "story":
    case "government": {
      const what = command;
      const isCity = what === "build" || what === "expand";
      const targetId = isCity ? parseId(rest[0]) ?? undefined : undefined;
      if (isCity && !targetId) return fail(`usage: civ ${command} <city> [value]\n`);
      const value = rest[isCity ? 1 : 0];
      const r = (await server.choose(playerId, what, value, targetId)) as ActionResult & {
        listing?: boolean;
        current?: string | null;
        options?: Array<{ name: string; turns?: number | null; available?: boolean; why?: string | null }>;
      };
      if (!r.listing) return renderResult(r);
      // Every line is the command that picks it. A list an agent must still translate into
      // arguments is what cost 25 failed guesses in one turn.
      const prefix = `civ ${command}${isCity ? ` ${targetId}` : ""}`;
      const lines = [`${what} now: ${r.current ?? "nothing"}`];
      const open = (r.options ?? []).filter((o) => o.available !== false);
      const shut = (r.options ?? []).filter((o) => o.available === false);
      if (open.length > 0) {
        lines.push("", "you can pick:");
        for (const o of open) lines.push(`  ${prefix} ${o.name}${o.turns ? `    # ${o.turns} turns` : ""}`);
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
      if (!mode || Number.isNaN(other)) return fail("usage: civ deal <items|pending> <player>\n");
      return ok(JSON.stringify(await server.deal(playerId, mode, other), null, 2) + "\n");
    }

    case "dismiss":
    case "open": {
      const id = rest[0] ? (parseId(rest[0]) ?? rest[0]) : undefined;
      if (command === "open" && !id) return fail("usage: civ open <id>\n");
      const r = (await server.notify(playerId, command === "open" ? "activate" : "dismiss", id)) as
        ActionResult & { note?: string };
      if (!r.ok) return renderResult(r);
      return ok(`ok — ${r.note}\n`);
    }

    case "end-turn":
      return renderResult(await server.endTurn(playerId));

    default:
      return fail(`unknown command: ${command}\n\n${USAGE}\n`);
  }
}
