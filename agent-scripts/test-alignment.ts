import { strict as assert } from "assert";
import { adjustPriority } from "./priority";

// score 3 bumps up, 0 bumps down, 1-2 unchanged, tiers clamp at the ends.
assert.equal(adjustPriority("medium", 3), "high");
assert.equal(adjustPriority("medium", 0), "low");
assert.equal(adjustPriority("medium", 2), "medium");
assert.equal(adjustPriority("medium", 1), "medium");
assert.equal(adjustPriority("high", 3), "high"); // clamp up
assert.equal(adjustPriority("low", 0), "low"); // clamp down
assert.equal(adjustPriority("garbage", 3), "medium"); // unknown → neutral fallback

console.log("✅ adjustPriority: all assertions passed");
