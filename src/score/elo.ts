// Elo over completed matches (docs/PLAN.md §13).
//
// Ratings only mean something against an anchor, so the scripted baseline is pinned: it never
// moves, and every model's rating is read relative to it. Inadmissible matches are excluded,
// never quietly folded in.
export const START_RATING = 1500;
export const K_FACTOR = 24;
export const ANCHOR = "scripted-baseline";

export type MatchResult = {
  /** Seat names in finishing order, best first. Ties share a rank via `tiedWith`. */
  ranking: Array<{ name: string; rank: number }>;
  admissible: boolean;
};

export type Ratings = Record<string, { rating: number; matches: number }>;

const expected = (a: number, b: number) => 1 / (1 + 10 ** ((b - a) / 400));

export function updateRatings(ratings: Ratings, result: MatchResult) {
  if (!result.admissible) return ratings;

  const next = { ...ratings };
  for (const { name } of result.ranking) {
    next[name] ??= { rating: START_RATING, matches: 0 };
  }

  // Every pair in the match contributes, which is how Elo generalises past two players.
  const deltas: Record<string, number> = {};
  for (const a of result.ranking) {
    for (const b of result.ranking) {
      if (a.name === b.name) continue;
      const score = a.rank < b.rank ? 1 : a.rank > b.rank ? 0 : 0.5;
      const exp = expected(next[a.name]!.rating, next[b.name]!.rating);
      deltas[a.name] = (deltas[a.name] ?? 0) + K_FACTOR * (score - exp);
    }
  }

  const pairs = Math.max(1, result.ranking.length - 1);
  for (const { name } of result.ranking) {
    next[name]!.matches += 1;
    // The anchor is fixed: it is the yardstick, so it must not drift.
    if (name === ANCHOR) continue;
    next[name]!.rating += (deltas[name] ?? 0) / pairs;
  }
  return next;
}

export function leaderboard(ratings: Ratings): Array<{ name: string; rating: number; matches: number }> {
  return Object.entries(ratings)
    .map(([name, r]) => ({ name, rating: Math.round(r.rating), matches: r.matches }))
    .sort((a, b) => b.rating - a.rating);
}
