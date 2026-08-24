// Runs inside Civ 7. Lists every GameInfo table present in this build, so the rules export
// adapts to DLC and patches instead of hard-coding a list that will rot.
const names = [];
for (const k of Object.keys(GameInfo)) {
  try {
    const t = GameInfo[k];
    if (t && typeof t[Symbol.iterator] === "function") names.push(k);
  } catch { /* some keys are accessors that throw */ }
}
names.sort();
return names;
