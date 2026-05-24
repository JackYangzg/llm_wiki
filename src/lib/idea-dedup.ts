import type { InspirationItem } from "@/lib/inspiration-schema"

function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
}

function shingles(text: string): Set<string> {
  const normalized = normalizeText(text)
  const tokens = normalized.split(" ").filter(Boolean)
  if (tokens.length <= 3) return new Set(tokens)
  const out = new Set<string>()
  for (let i = 0; i <= tokens.length - 3; i++) out.add(tokens.slice(i, i + 3).join(" "))
  return out
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let intersection = 0
  for (const token of a) {
    if (b.has(token)) intersection++
  }
  return intersection / (a.size + b.size - intersection)
}

export function dedupInspirationItems(items: InspirationItem[], threshold = 0.62): InspirationItem[] {
  const selected: InspirationItem[] = []
  const selectedShingles: Set<string>[] = []

  for (const item of [...items].sort((a, b) => b.scores.final - a.scores.final)) {
    const sig = shingles(`${item.title} ${item.summary}`)
    const duplicate = selectedShingles.some((other) => jaccard(sig, other) >= threshold)
    if (!duplicate) {
      selected.push(item)
      selectedShingles.push(sig)
    }
  }

  return selected
}
