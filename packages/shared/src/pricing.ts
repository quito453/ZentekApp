// What a customer should pay. Used by the office Customers screen.

/**
 * Profit per hour on site.
 * @param profitCents profit after whatever share of fixed costs the owner is counting
 */
export function profitPerHour(profitCents: number, siteMinutes: number): number {
  return siteMinutes > 0 ? Math.round((profitCents / siteMinutes) * 60) : 0;
}

/**
 * The price per visit that would earn this customer the company's average profit per hour on site:
 * cost per visit + average profit per hour × hours on site per visit, rounded up to the next $5.
 * Returns null when there's nothing to go on.
 */
export function suggestedPrice(o: { visits: number; costsCents: number; siteMinutes: number; avgPerHourCents: number }): number | null {
  if (o.visits <= 0 || o.avgPerHourCents <= 0) return null;
  const perVisit = o.costsCents / o.visits + (o.avgPerHourCents * o.siteMinutes) / o.visits / 60;
  return Math.ceil(perVisit / 500) * 500;
}

/** A customer earning less than this share of the average per hour is worth a price review. */
export const REVIEW_BELOW = 0.85;
export function needsPriceReview(perHourCents: number, avgPerHourCents: number): boolean {
  return avgPerHourCents > 0 && perHourCents < avgPerHourCents * REVIEW_BELOW;
}
