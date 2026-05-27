import { listDirectory, readFile, getFileModifiedTime } from "@/commands/fs"
import { buildWikiGraph } from "@/lib/wiki-graph"
import { joinPath, normalizePath } from "@/lib/path-utils"
import { isKnowledgeProcessingEligiblePath } from "@/lib/wiki-system-files"
import type { FileNode } from "@/types/wiki"
import type { InspirationSeed } from "@/lib/inspiration-schema"

function flattenMdFiles(nodes: FileNode[]): FileNode[] {
  const files: FileNode[] = []
  for (const node of nodes) {
    if (node.is_dir) files.push(...flattenMdFiles(node.children ?? []))
    else if (node.name.endsWith(".md")) files.push(node)
  }
  return files
}

function extractTitle(content: string, fallback: string): string {
  const fm = content.match(/^---\n[\s\S]*?^title:\s*["']?(.+?)["']?\s*$/m)
  if (fm) return fm[1].trim()
  const heading = content.match(/^#\s+(.+)$/m)
  return heading ? heading[1].trim() : fallback.replace(/\.md$/, "").replace(/-/g, " ")
}

function extractType(content: string): string {
  const fm = content.match(/^---\n[\s\S]*?^type:\s*["']?(.+?)["']?\s*$/m)
  return fm ? fm[1].trim().toLowerCase() : "other"
}

function excerpt(content: string): string {
  return content
    .replace(/^---\n[\s\S]*?\n---\s*/m, "")
    .replace(/!\[[^\]]*]\([^)]+\)/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 700)
}

export async function collectInspirationSeeds(
  projectPath: string,
  topic?: string,
  limit = 24,
): Promise<InspirationSeed[]> {
  const pp = normalizePath(projectPath)
  let files: FileNode[] = []
  try {
    files = flattenMdFiles(await listDirectory(joinPath(pp, "wiki")))
  } catch {
    return []
  }

  const graph = await buildWikiGraph(pp).catch(() => ({ nodes: [], edges: [], communities: [] }))
  const nodeByPath = new Map(graph.nodes.map((n) => [normalizePath(n.path), n]))
  const queryTerms = topic?.toLowerCase().split(/[\s,，。！？、；：()]+/).filter(Boolean) ?? []

  const seeds: InspirationSeed[] = []
  for (const file of files) {
    if (!isKnowledgeProcessingEligiblePath(file.path)) continue
    let content = ""
    try {
      content = await readFile(file.path)
    } catch {
      continue
    }
    const node = nodeByPath.get(normalizePath(file.path))
    const text = `${file.name}\n${content}`.toLowerCase()
    const queryBoost = queryTerms.length > 0
      ? queryTerms.reduce((sum, term) => sum + (text.includes(term) ? 4 : 0), 0)
      : 0
    const modifiedAt = await getFileModifiedTime(file.path).catch(() => 0)
    seeds.push({
      path: file.path,
      title: extractTitle(content, file.name),
      type: extractType(content),
      snippet: excerpt(content),
      linkCount: (node?.linkCount ?? 0) + queryBoost,
      community: node?.community ?? 0,
      modifiedAt,
    })
  }

  return seeds
    .sort((a, b) => {
      const scoreA = a.linkCount * 10 + (a.modifiedAt ?? 0) / 1_000_000_000
      const scoreB = b.linkCount * 10 + (b.modifiedAt ?? 0) / 1_000_000_000
      return scoreB - scoreA
    })
    .slice(0, limit)
}

export function groupSeedsByCommunity(seeds: InspirationSeed[]): InspirationSeed[][] {
  const groups = new Map<number, InspirationSeed[]>()
  for (const seed of seeds) {
    const group = groups.get(seed.community) ?? []
    group.push(seed)
    groups.set(seed.community, group)
  }
  return [...groups.values()]
    .map((group) => group.sort((a, b) => b.linkCount - a.linkCount))
    .sort((a, b) => b.length - a.length)
}
