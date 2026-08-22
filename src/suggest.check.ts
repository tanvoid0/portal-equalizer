/**
 * Self-check for the preset matcher and the model-reply parser.
 *
 * No test framework and no test-only dependency: `pnpm check` runs this through
 * jiti, which is already here as a Tailwind dependency and resolves TypeScript
 * the same way Vite does.
 */
import { findPreset } from "./presets";
import { autoCurve, drift, effectiveNeed, parseSuggestion, rank } from "./suggest";

const ok = (cond: unknown, msg: string) => {
  if (!cond) throw new Error(msg);
};
const same = (got: unknown, want: unknown, msg: string) =>
  ok(
    JSON.stringify(got) === JSON.stringify(want),
    `${msg}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`,
  );
const throws = (fn: () => unknown, match: RegExp) => {
  try {
    fn();
  } catch (e) {
    return ok(match.test(String(e)), `wrong error: ${e}`);
  }
  throw new Error(`expected a throw matching ${match}`);
};

// A dark mix asks for treble; the winner must lift the top, not the bottom.
const forDark = rank([-4, -3, -2, -1, 0, 1, 2, 3, 4, 5])[0].preset;
ok(
  forDark.gains[9] > forDark.gains[0],
  `dark mix picked ${forDark.name} ${JSON.stringify(forDark.gains)}`,
);

// A boomy one asks for the opposite.
const forBoom = rank([-6, -5, -4, -2, 0, 1, 1, 2, 2, 2])[0].preset;
ok(forBoom.gains[0] < 0, `boomy mix picked ${forBoom.name}`);

// Nothing worth correcting is Flat, not the least-bad shape in the catalogue.
const balanced = rank([0.2, -0.1, 0, 0.1, 0, 0, -0.2, 0, 0.1, 0]);
same(balanced.length, 1, "a balanced mix should offer one answer");
same(balanced[0].preset.name, "Flat", "balanced mix");

// Size matters as well as shape: a huge preset is a poor answer to a small
// problem even though it points the same way.
const small = rank([-1, -1, -0.5, 0, 0, 0, 0.5, 0.5, 1, 1], 5).map((c) => c.preset.name);
ok(!small.includes("Deep V"), `oversized preset won a small correction: ${small}`);

// The loopback hears the EQ, so a suggestion must be read as "total from flat".
// A curve that is already right must ask for itself again, not for more.
same(
  effectiveNeed([0, 0, 0, 0, 0, 0, 0, 0, 0, 0], [3, 2, 0, 0, 0, 0, 0, -2, -3, -4]),
  [3, 2, 0, 0, 0, 0, 0, -2, -3, -4],
  "a satisfied measurement must hold the applied curve, not zero it",
);
same(effectiveNeed([2, 0], [1, 1]), [3, 1], "residual adds to what is applied");

// The correction curve itself stays inside slider range and on the 0.5 dB grid.
same(autoCurve([20, -20, 0.26, 0, 0, 0, 0, 0, 0, 0]).slice(0, 3), [12, -12, 0.5], "autoCurve");

// Drift is total absolute movement, and an absent baseline always re-asks.
same(drift([0, 0], [1, -2]), 3, "drift");
same(drift(undefined, [1, 2]), Infinity, "drift with no baseline");

// --- model replies ---------------------------------------------------------

// Chatty, fenced output still parses.
const chatty = parseSuggestion(
  'Sure!\n```json\n{"preset":"Techno","gains":[9,9,9,9,9,9,9,9,9,9],"reason":"Four to the floor.","confidence":0.9}\n```',
);
same(chatty.preset, "Techno", "preset name");
// A named preset applies the catalogue's gains, never the model's copy of them.
same(chatty.gains, findPreset("Techno")!.gains, "named preset must use catalogue gains");
same(chatty.confidence, 0.9, "confidence");

// A bespoke curve is accepted, but clamped like any slider.
const custom = parseSuggestion(
  '{"preset":"Custom","gains":[99,-99,3,0,0,0,0,0,0,0],"reason":"x","confidence":2}',
);
same(custom.gains.slice(0, 3), [12, -12, 3], "custom curve is clamped");
same(custom.confidence, 1, "confidence is clamped to 0-1");

// Junk is rejected rather than silently applied.
throws(() => parseSuggestion("no json here"), /did not return JSON/);
throws(() => parseSuggestion('{"preset":"Nonsense","gains":[1,2]}'), /unusable curve/);

console.log("suggest: ok");
