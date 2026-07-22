export type Priority = "high" | "medium" | "low";

// Compute the RICE score + priority tier from the model's four inputs, in TS — the LLM
// only picks reach/impact/confidence/effort, so the arithmetic can't drift (and Haiku
// can't fumble it). Formula & thresholds mirror the original prompt: score is ×100 for
// readability, high ≥ 15 / medium ≥ 5 / low otherwise.
export function computeRice(r: { reach?: unknown; impact?: unknown; confidence?: unknown; effort?: unknown }): {
  riceScore: number;
  priority: Priority;
} {
  const reach = Number(r.reach);
  const impact = Number(r.impact);
  const confidence = Number(r.confidence);
  const effort = Number(r.effort);
  if (!effort || [reach, impact, confidence].some((n) => !Number.isFinite(n))) return { riceScore: 0, priority: "low" };
  const riceScore = Math.round(((reach * impact * confidence) / 100 / effort) * 100 * 10) / 10;
  const priority: Priority = riceScore >= 15 ? "high" : riceScore >= 5 ? "medium" : "low";
  return { riceScore, priority };
}

// Modulate the RICE priority by strategic alignment (see plane-product-strategy skill).
// score 3 → bump up one tier, score 0 → bump down one tier, 1-2 → unchanged. Tiers clamp.
export function adjustPriority(ricePriority: unknown, alignmentScore: unknown): Priority {
  const tiers: Priority[] = ["low", "medium", "high"];
  const idx = tiers.indexOf(ricePriority as Priority);
  if (idx === -1) return "medium"; // unknown RICE priority → neutral fallback
  const delta = alignmentScore === 3 ? 1 : alignmentScore === 0 ? -1 : 0;
  return tiers[Math.max(0, Math.min(tiers.length - 1, idx + delta))];
}
