// Runs inside Civ 7's GAMEPLAY context. Points the camera at a plot.
//
// With agents playing there is no human moving the view, so the camera sits wherever it was left
// and the match looks static even while it is advancing. Following the acting seat is what makes
// it watchable (docs/PLAN.md §12).
//
// Purely a view change: it touches no game state.
if (typeof LOOK_X !== "number" || typeof LOOK_Y !== "number") return { moved: false };

try {
  Camera.lookAtPlot(LOOK_X, LOOK_Y);
  return { moved: true, x: LOOK_X, y: LOOK_Y };
} catch (err) {
  return { moved: false, error: String(err) };
}
