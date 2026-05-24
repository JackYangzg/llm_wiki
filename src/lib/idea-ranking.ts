import type { InspirationItem } from "@/lib/inspiration-schema"

function itemTerms(item: InspirationItem): Set<string> {
  return new Set(
    `${item.title} ${item.summary}`
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((t) => t.length > 1),
  )
}

function overlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let shared = 0
  for (const token of a) {
    if (b.has(token)) shared++
  }
  return shared / Math.min(a.size, b.size)
}

export function rankWithMmr(items: InspirationItem[], maxItems = 12, lambda = 0.72): InspirationItem[] {
  const pool = [...items]
  const selected: InspirationItem[] = []
  const selectedTerms: Set<string>[] = []

  while (pool.length > 0 && selected.length < maxItems) {
    let bestIndex = 0
    let bestScore = Number.NEGATIVE_INFINITY
    for (let i = 0; i < pool.length; i++) {
      const terms = itemTerms(pool[i])
      const redundancy = selectedTerms.length === 0
        ? 0
        : Math.max(...selectedTerms.map((other) => overlap(terms, other)))
      const mmr = lambda * pool[i].scores.final - (1 - lambda) * redundancy
      if (mmr > bestScore) {
        bestScore = mmr
        bestIndex = i
      }
    }
    const [next] = pool.splice(bestIndex, 1)
    selected.push(next)
    selectedTerms.push(itemTerms(next))
  }

  return selected
}
