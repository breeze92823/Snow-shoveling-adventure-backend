import assert from "assert";

import { sanitizeProgress, resolveTutorialStep } from "../src/sanitize.js";

describe("sanitizeProgress", () => {
  it("rejects non-objects and bounds numbers", () => {
    assert.strictEqual(sanitizeProgress(null), null);
    assert.strictEqual(sanitizeProgress([1]), null);
    const out = sanitizeProgress({ cash: 1e30, power: -5, leaves: NaN, level: 0, rebirths: 2.9, hack: "x" })!;
    assert.strictEqual(out.cash, 1e18);
    assert.strictEqual(out.power, 0);
    assert.strictEqual(out.leaves, undefined);
    assert.strictEqual(out.level, 1);
    assert.strictEqual(out.rebirths, 2);
    assert.ok(!("hack" in out));
  });

  it("keeps well-formed loot, ids and upgrades and drops the rest", () => {
    const out = sanitizeProgress({
      bag: [{ name: "Gem", rarity: "Uncommon", value: 5 }, { name: "Fake", rarity: "Nope", value: 1 }],
      sellLocked: ["Gem", "Gem", 5],
      discovered: ["Rock", "Coal", ""],
      vacuumOwned: ["battery", "gas", "bogus", "gas"],
      vacuum: "gas",
      auraOwned: ["static", "nope"],
      aura: null,
      upgrades: { range: 3.7, capacity: 99, bogus: 4, walk: -2 },
    })!;
    assert.deepStrictEqual(out.bag, [{ name: "Gem", rarity: "Uncommon", value: 5 }]);
    assert.deepStrictEqual(out.sellLocked, ["Gem"]);
    assert.deepStrictEqual(out.discovered, ["Rock", "Coal"]);
    assert.deepStrictEqual(out.vacuumOwned, ["battery", "gas"]);
    assert.strictEqual(out.vacuum, "gas");
    assert.deepStrictEqual(out.auraOwned, ["static"]);
    assert.strictEqual(out.aura, null);
    assert.deepStrictEqual(out.upgrades, { range: 3, capacity: 10, walk: 0 });
  });

  it("ignores unknown vacuum and aura ids", () => {
    const out = sanitizeProgress({ vacuum: "laser", aura: "../etc" })!;
    assert.ok(!("vacuum" in out));
    assert.ok(!("aura" in out));
  });

  it("bounds the tutorial step and reads a doc without one as finished", () => {
    assert.strictEqual(sanitizeProgress({ tutorialStep: 99 })!.tutorialStep, 9);
    assert.strictEqual(sanitizeProgress({ tutorialStep: -4 })!.tutorialStep, 0);
    assert.ok(!("tutorialStep" in sanitizeProgress({ cash: 1 })!));
    assert.strictEqual(resolveTutorialStep({}), 9);
    assert.strictEqual(resolveTutorialStep({ tutorialStep: 0 }), 0);
    assert.strictEqual(resolveTutorialStep({ tutorialStep: 5.9 }), 5);
  });

  it("bounds the daily login streak and timed boosts", () => {
    const now = Date.now();
    const out = sanitizeProgress({
      dailyDay: 9.8, dailyClaimedAt: now + 1e12, boosts: { power: now + 1e12, cash: now + 1000, bogus: 5 },
    })!;
    assert.strictEqual(out.dailyDay, 7);
    assert.ok(out.dailyClaimedAt! <= now + 11 * 60 * 1000);
    assert.ok(out.boosts!.power <= now + 24 * 60 * 60 * 1000 + 1000);
    assert.ok(out.boosts!.cash >= now + 900 && out.boosts!.cash <= now + 1100);
    assert.ok(!("bogus" in out.boosts!));
    assert.deepStrictEqual(sanitizeProgress({ dailyDay: -3, boosts: "x" })!.boosts, {});
  });
});
