import { strict as assert } from "assert";
import { adjustPriority, computeRice } from "./priority";

// score 3 bumps up, 0 bumps down, 1-2 unchanged, tiers clamp at the ends.
assert.equal(adjustPriority("medium", 3), "high");
assert.equal(adjustPriority("medium", 0), "low");
assert.equal(adjustPriority("medium", 2), "medium");
assert.equal(adjustPriority("medium", 1), "medium");
assert.equal(adjustPriority("high", 3), "high"); // clamp up
assert.equal(adjustPriority("low", 0), "low"); // clamp down
assert.equal(adjustPriority("garbage", 3), "medium"); // unknown → neutral fallback

console.log("✅ adjustPriority: all assertions passed");

// computeRice: (reach*impact*confidence/100)/effort*100, rounded to 0.1; high≥15/med≥5/low.
assert.deepEqual(computeRice({ reach: 15, impact: 2, confidence: 80, effort: 3 }), {
  riceScore: 800,
  priority: "high",
});
assert.deepEqual(computeRice({ reach: 10, impact: 0.5, confidence: 50, effort: 5 }), {
  riceScore: 50,
  priority: "high",
});
// Missing/garbage inputs or zero effort → safe zero, never NaN or divide-by-zero.
assert.deepEqual(computeRice({ reach: 10, impact: 1, confidence: 50, effort: 0 }), {
  riceScore: 0,
  priority: "low",
});
assert.deepEqual(computeRice({}), { riceScore: 0, priority: "low" });

console.log("✅ computeRice: all assertions passed");
