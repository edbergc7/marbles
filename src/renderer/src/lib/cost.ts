/** "$0.05", "$1.30", or "<$0.01" for tiny amounts. */
export function formatCost(usd: number): string {
  if (usd < 0.005) return '<$0.01'
  return `$${usd.toFixed(2)}`
}

/** A change costing at least this much gets a visible "about $X each" hint. */
export const PRICEY_CHANGE_USD = 0.15
