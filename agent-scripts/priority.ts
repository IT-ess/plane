export type Priority = "high" | "medium" | "low";

// Modulate the RICE priority by strategic alignment (see plane-product-strategy skill).
// score 3 → bump up one tier, score 0 → bump down one tier, 1-2 → unchanged. Tiers clamp.
export function adjustPriority(
  ricePriority: unknown,
  alignmentScore: unknown
): Priority {
  const tiers: Priority[] = ["low", "medium", "high"];
  const idx = tiers.indexOf(ricePriority as Priority);
  if (idx === -1) return "medium"; // unknown RICE priority → neutral fallback
  const delta = alignmentScore === 3 ? 1 : alignmentScore === 0 ? -1 : 0;
  return tiers[Math.max(0, Math.min(tiers.length - 1, idx + delta))];
}
