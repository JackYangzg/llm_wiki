import { buildWikiGraph } from "@/lib/wiki-graph"
import { readFile } from "@/commands/fs"
import type { InspirationSeed } from "@/lib/inspiration-schema"

function brief(content: string): string {
  return content
    .replace(/^---\n[\s\S]*?\n---\s*/m, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 420)
}

export async function buildDreamWalk(
  projectPath: string,
  seeds: InspirationSeed[],
  topic = "Daily inspiration",
): Promise<{ seed: InspirationSeed; reason: string }[]> {
  if (seeds.length === 0) return []
  const graph = await buildWikiGraph(projectPath).catch(() => ({ nodes: [], edges: [], communities: [] }))
  const seedByPath = new Map(seeds.map((s) => [s.path, s]))
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]))
  const pathToNode = new Map(graph.nodes.map((n) => [n.path, n]))
  const adjacency = new Map<string, string[]>()

  for (const edge of graph.edges) {
    adjacency.set(edge.source, [...(adjacency.get(edge.source) ?? []), edge.target])
    adjacency.set(edge.target, [...(adjacency.get(edge.target) ?? []), edge.source])
  }

  let current = seeds[0]
  const currentNode = pathToNode.get(current.path)
  const walk: { seed: InspirationSeed; reason: string }[] = [
    { seed: current, reason: `Starting from the strongest seed for ${topic}.` },
  ]
  const seen = new Set([current.path])

  for (let i = 0; i < 5; i++) {
    const node = pathToNode.get(current.path) ?? currentNode
    const neighbors = node ? (adjacency.get(node.id) ?? []).map((id) => nodeById.get(id)).filter(Boolean) : []
    const neighborSeeds = neighbors
      .map((n) => seedByPath.get(n!.path))
      .filter((s): s is InspirationSeed => !!s && !seen.has(s.path))

    const crossCommunity = seeds.find((s) => !seen.has(s.path) && s.community !== current.community)
    const next = neighborSeeds[0] ?? crossCommunity ?? seeds.find((s) => !seen.has(s.path))
    if (!next) break

    const reason = next.community !== current.community
      ? `Cross-community jump from cluster ${current.community} to ${next.community}.`
      : `Graph-neighbor jump inside community ${next.community}.`
    walk.push({ seed: next, reason })
    seen.add(next.path)
    current = next
  }

  return walk
}

export async function hydrateDreamWalk(
  walk: { seed: InspirationSeed; reason: string }[],
): Promise<{ title: string; reason: string; snippet: string; path: string }[]> {
  const hydrated = []
  for (const step of walk) {
    let snippet = step.seed.snippet
    try {
      snippet = brief(await readFile(step.seed.path))
    } catch {
      // keep seed snippet
    }
    hydrated.push({
      title: step.seed.title,
      reason: step.reason,
      snippet,
      path: step.seed.path,
    })
  }
  return hydrated
}
