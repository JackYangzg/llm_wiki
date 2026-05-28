import { streamChat } from "@/lib/llm-client"
import { hasUsableLlm } from "@/lib/has-usable-llm"
import { collectInspirationSeeds, groupSeedsByCommunity } from "@/lib/theme-mining"
import { buildWikiGraph } from "@/lib/wiki-graph"
import { normalizePath } from "@/lib/path-utils"
import type { LlmConfig } from "@/stores/wiki-store"
import type { InspirationSeed } from "@/lib/inspiration-schema"
import {
  type KnowledgeThread,
  type KnowledgeThreadBundle,
  type KnowledgeThreadEdge,
  type KnowledgeThreadGap,
  type KnowledgeThreadNode,
  type ThreadEvolutionInput,
  type ThreadEvolutionLog,
  type UserThreadContext,
} from "./types"
import { loadKnowledgeThreadBundle, saveKnowledgeThreadBundle } from "./storage"

function id(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function clamp01(value: unknown, fallback = 0.65): number {
  const n = typeof value === "number" ? value : Number(value)
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : fallback
}

function shortId(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || Math.random().toString(36).slice(2, 8)
}

function safeArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => String(item)).filter(Boolean).slice(0, 12) : []
}

function relativeToProject(projectPath: string, path: string): string {
  const pp = normalizePath(projectPath)
  const normalized = normalizePath(path)
  return normalized.startsWith(`${pp}/`) ? normalized.slice(pp.length + 1) : normalized
}

function pathKey(path: string): string {
  return normalizePath(path).toLowerCase()
}

function pathMatches(page: string, targetPage: string): boolean {
  const pageKey = pathKey(page)
  const targetKey = pathKey(targetPage)
  return pageKey === targetKey || pageKey.endsWith(`/${targetKey}`) || targetKey.endsWith(`/${pageKey}`)
}

function deriveSummary(name: string, seeds: InspirationSeed[]): string {
  const snippets = seeds
    .map((s) => s.snippet?.trim())
    .filter(Boolean)
  if (snippets.length === 0) {
    return `${name}：涵盖 ${seeds.map((s) => s.title.replace(/\.(md|pdf)$/i, "")).slice(0, 3).join("、")} 等 ${seeds.length} 个页面。`
  }
  // Take a longer chunk from the first seed and extract its key claim
  const primary = snippets[0].slice(0, 300)
  const keyPhrase = primary.split(/[。；\n]/).map((p) => p.trim()).find((p) => p.length > 15 && !/^\[|^#|^http/.test(p)) ?? primary.slice(0, 80)
  // Also capture distinguishing terms from other seeds
  const otherTerms = seeds.slice(1, 4).map((s) => s.title.replace(/\.(md|pdf)$/i, "").trim()).filter(Boolean)
  const termClause = otherTerms.length > 0 ? `涉及 ${otherTerms.join("、")}` : ""
  return `${name}：${keyPhrase}${termClause ? `；${termClause}。` : "。"}`
}

function deriveCoreQuestion(name: string, seeds: InspirationSeed[]): string {
  const titles = seeds
    .map((s) => s.title.replace(/\.(md|pdf)$/i, "").trim())
    .filter(Boolean)
    .slice(0, 6)
  if (titles.length < 2) {
    return `${name} 的核心方法是什么？存在哪些关键挑战与演进方向？`
  }
  const a = titles[0]
  const b = titles[1]
  // Pick different question templates based on content to increase variety
  const templates = [
    `${a} 与 ${b} 在核心思路上有何异同？各自适用于什么场景？`,
    `${a} 如何影响 ${b} 的设计与演进？两者之间存在怎样的依赖关系？`,
    `从 ${a} 到 ${b}，技术路线经历了哪些关键转折？哪些问题仍未解决？`,
    `${a} 领域当前面临的核心挑战是什么？${b} 等方案能否有效应对？`,
  ]
  const idx = (a.length + b.length) % templates.length
  const question = templates[idx]
  const rest = titles.slice(2, 4)
  return rest.length > 0 ? `${question}（同时关联 ${rest.join("、")}）` : question
}

function cleanTitle(title: string): string {
  return title.replace(/\.(md|pdf)$/i, "").trim()
}

function seedTitles(seeds: InspirationSeed[], limit = 6): string[] {
  return seeds.map((seed) => cleanTitle(seed.title)).filter(Boolean).slice(0, limit)
}

function basenameWithoutExt(path: string): string {
  return cleanTitle(path.split("/").pop() ?? path).toLowerCase()
}

function threadTerms(thread: KnowledgeThread): string[] {
  const terms = [
    thread.name,
    ...thread.rootTopics,
    ...thread.keyConcepts,
    ...thread.sourcePages.map((page) => basenameWithoutExt(page)),
  ]
    .map((value) => cleanTitle(value).toLowerCase())
    .filter((value) => value.length >= 2)
  return [...new Set(terms)].slice(0, 16)
}

function threadSearchQuery(thread: KnowledgeThread, userContext?: string): string {
  return [
    thread.name,
    ...thread.rootTopics.slice(0, 4),
    ...thread.keyConcepts.slice(0, 4),
    userContext,
  ].filter(Boolean).join(" ")
}

function seedScoreForThread(seed: InspirationSeed, thread: KnowledgeThread, projectPath: string): number {
  const seedPath = relativeToProject(projectPath, seed.path)
  let score = thread.sourcePages.some((page) => pathMatches(seedPath, page)) ? 12 : 0
  const haystack = `${cleanTitle(seed.title)}\n${seedPath}\n${seed.snippet ?? ""}`.toLowerCase()
  for (const term of threadTerms(thread)) {
    if (haystack.includes(term)) score += 2
  }
  return score
}

function filterSeedsForThread(seeds: InspirationSeed[], thread: KnowledgeThread, projectPath: string): InspirationSeed[] {
  return seeds
    .map((seed) => ({ seed, score: seedScoreForThread(seed, thread, projectPath) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((item) => item.seed)
    .slice(0, 18)
}

function artifactMatchesThread(
  value: {
    threadId?: string
    title?: string
    summary?: string
    sourcePageIds?: string[]
    relatedWikiLinks?: string[]
  },
  targetThread: KnowledgeThread,
  existingThreadIds: Set<string>,
): boolean {
  if (value.threadId && value.threadId !== targetThread.id && existingThreadIds.has(value.threadId)) {
    return false
  }
  const sourcePageIds = safeArray(value.sourcePageIds)
  if (sourcePageIds.length > 0 && !sourcePageIds.some((page) => targetThread.sourcePages.some((target) => pathMatches(page, target)))) {
    return false
  }
  const haystack = [
    value.title,
    value.summary,
    ...sourcePageIds,
    ...safeArray(value.relatedWikiLinks),
  ].filter(Boolean).join("\n").toLowerCase()
  if (!haystack.trim()) return true
  if (value.threadId === targetThread.id) return true
  return threadTerms(targetThread).some((term) => haystack.includes(term))
}

function artifactSourcePagesBelongToThread(sourcePageIds: string[] | undefined, targetThread: KnowledgeThread): boolean {
  const sourcePages = safeArray(sourcePageIds)
  if (sourcePages.length === 0) return true
  return sourcePages.some((page) => targetThread.sourcePages.some((target) => pathMatches(page, target)))
}

function focusedContextText(
  projectPath: string,
  targetThread: KnowledgeThread,
  seeds: InspirationSeed[],
  nodes: KnowledgeThreadNode[],
  gaps: KnowledgeThreadGap[],
): string {
  const seedText = seeds.map((seed, i) =>
    `[${i + 1}] ${seed.title} (${seed.type}; community=${seed.community}; links=${seed.linkCount})\nPath: ${relativeToProject(projectPath, seed.path)}\n${seed.snippet}`,
  ).join("\n\n")
  const nodeText = nodes.slice(0, 24).map((node) =>
    `- [${node.type}] ${node.title}: ${node.summary}`,
  ).join("\n")
  const gapText = gaps.slice(0, 12).map((gap) =>
    `- ${gap.title}: ${gap.description}`,
  ).join("\n")
  return [
    `## Target Thread Only\n${JSON.stringify({
      id: targetThread.id,
      name: targetThread.name,
      rootTopics: targetThread.rootTopics,
      keyConcepts: targetThread.keyConcepts,
      sourcePages: targetThread.sourcePages,
    }, null, 2)}`,
    nodeText ? `## Existing Nodes In This Thread\n${nodeText}` : "",
    gapText ? `## Existing Gaps In This Thread\n${gapText}` : "",
    seedText ? `## Related Wiki Pages For This Thread\n${seedText}` : "## Related Wiki Pages For This Thread\nNo directly related wiki pages were found. Do not borrow content from other threads.",
  ].filter(Boolean).join("\n\n")
}

function extractClaim(seed?: InspirationSeed): string {
  const snippet = seed?.snippet?.trim() ?? ""
  if (!snippet) return cleanTitle(seed?.title ?? "")
  return snippet
    .split(/[。；;.!?\n]/)
    .map((part) => part.trim())
    .find((part) => part.length >= 12 && !/^#|^\[|^http/.test(part))
    ?.slice(0, 90) ?? snippet.slice(0, 90)
}

function concreteGapsFromSeeds(name: string, seeds: InspirationSeed[]): string[] {
  const titles = seedTitles(seeds, 6)
  const primary = titles[0] || name
  const secondary = titles[1]
  const tertiary = titles[2]
  const primaryClaim = extractClaim(seeds[0])
  const secondaryClaim = extractClaim(seeds[1])
  const gaps = [
    secondary
      ? `「${primary}」与「${secondary}」已有相邻材料，但尚未说明二者在问题定义、适用条件或证据口径上的差异。`
      : `「${primary}」目前缺少可对照的第二类材料，难以判断该主题的边界、反例和替代路线。`,
    primaryClaim && secondaryClaim
      ? `现有摘录分别强调「${primaryClaim}」和「${secondaryClaim}」，但还缺少把这些主张连接成因果链或演进链的中间证据。`
      : `围绕「${primary}」的现有摘录不足以形成清晰证据链，需要补充关键论据、案例或失败条件。`,
    tertiary
      ? `「${tertiary}」已经进入同一脉络，但它与「${primary}」的关系仍停留在主题相近，尚未明确是支撑、冲突、方法补充还是应用分支。`
      : null,
  ].filter(Boolean) as string[]
  return gaps.slice(0, 3)
}

function concreteDirectionsFromSeeds(name: string, seeds: InspirationSeed[], context?: UserThreadContext): string[] {
  const titles = seedTitles(seeds, 6)
  const primary = titles[0] || name
  const secondary = titles[1]
  const tertiary = titles[2]
  const sourcePages = seeds.slice(0, 3).map((seed) => cleanTitle(seed.title)).filter(Boolean)
  const directions = [
    context?.content,
    secondary
      ? `整理一张「${primary}」与「${secondary}」对照表，分别标注核心问题、关键假设、证据来源、适用场景和未覆盖边界。`
      : `为「${primary}」补充至少一个对照页面或反例页面，用来校准该脉络的适用边界。`,
    sourcePages.length > 0
      ? `回到 ${sourcePages.map((title) => `「${title}」`).join("、")}，抽取可引用的关键结论、案例和限制条件，补进对应节点摘要。`
      : null,
    tertiary
      ? `判断「${tertiary}」在该脉络中更像方法、案例、冲突观点还是后续应用，并据此补一条明确关系边。`
      : `把「${primary}」拆成“问题-方法-证据-限制”四类节点，优先补齐缺失的一类。`,
  ].filter(Boolean) as string[]
  return directions.slice(0, 4)
}

function concreteDirectionsFromThread(
  thread: KnowledgeThread,
  nodes: KnowledgeThreadNode[],
  gaps: KnowledgeThreadGap[],
): string[] {
  const importantNodes = [...nodes]
    .sort((a, b) => b.importance - a.importance)
    .map((node) => node.title)
    .filter(Boolean)
  const first = importantNodes[0] || thread.rootTopics[0] || thread.name
  const second = importantNodes[1] || thread.rootTopics[1]
  const openGap = gaps.find((gap) => gap.status !== "resolved")
  return [
    openGap
      ? `围绕「${openGap.title}」补充证据：把相关页面中的原始表述、案例和限制条件整理到同一节点下。`
      : `围绕「${first}」补充一个可验证的案例或反例，帮助判断该脉络的适用边界。`,
    second
      ? `明确「${first}」与「${second}」之间的关系类型，补写一条说明它们是依赖、支撑、冲突还是演进。`
      : `把「${first}」拆成问题、方法、证据、限制四类信息，优先补齐当前缺失的一类。`,
  ]
}

function concreteGapsFromThread(
  thread: KnowledgeThread,
  nodes: KnowledgeThreadNode[],
  gaps: KnowledgeThreadGap[],
): string[] {
  const importantNodes = [...nodes]
    .sort((a, b) => b.importance - a.importance)
    .map((node) => node.title)
    .filter(Boolean)
  const first = importantNodes[0] || thread.rootTopics[0] || thread.name
  const second = importantNodes[1] || thread.rootTopics[1]
  const openGap = gaps.find((gap) => gap.status !== "resolved")
  return [
    openGap ? `${openGap.title}：${openGap.description}` : null,
    second
      ? `「${first}」与「${second}」之间还缺少明确的证据连接，当前无法判断它们是因果、支撑、冲突还是阶段演进。`
      : `「${first}」目前缺少相邻概念或案例节点，难以形成可检验的知识路径。`,
  ].filter(Boolean) as string[]
}

function isGenericGuidance(text: string): boolean {
  const normalized = text.trim()
  if (!normalized) return true
  return [
    "使用 LLM 对该脉络进行深度迭代",
    "继续补充 Wiki 页面",
    "进一步梳理核心问题",
    "进一步梳理「",
    "证据链与演进方向待细化",
    "当前已从 Wiki 页面聚合出专题",
    "关键方法、案例和未解决问题",
    "发现更多节点、关系和知识缺口",
  ].some((pattern) => normalized.includes(pattern))
}

function isGenericGap(title: string, description: string): boolean {
  return isGenericGuidance(`${title}\n${description}`) || /^知识缺口\s*\d+$/.test(title.trim())
}

function nonGenericStrings(primary: string[], fallback: string[], limit = 12): string[] {
  return mergeUniqueStrings(
    primary.filter((item) => !isGenericGuidance(item)),
    fallback.filter((item) => !isGenericGuidance(item)),
    limit,
  )
}

function isGenericThread(thread: KnowledgeThread): boolean {
  const text = `${thread.name}\n${thread.summary}\n${thread.coreQuestion}`.toLowerCase()
  const genericPatterns = [
    /知识脉络\s*\d*$/,
    /^专题\s*\d*$/,
    "知识库主线",
    "这条知识脉络试图回答什么",
    "当前知识库正在围绕哪些核心问题形成体系",
    "系统基于当前 wiki 内容识别出的核心知识主线",
    "这条脉络试图回答",
    "由  等内容聚合出的知识专题",
    "围绕「」现有知识如何形成问题",
    "现有知识如何形成问题、方法、案例与后续探索方向",
    "重点梳理这些页面之间的共同问题",
  ]
  if (!thread.name.trim() || !thread.summary.trim() || !thread.coreQuestion.trim()) return true
  if (genericPatterns.some((p) => (typeof p === "string" ? text.includes(p) : p.test(thread.name.trim())))) return true
  if (thread.summary.trim().length < 15) return true
  if (/^由\s.{0,5}\s*(等内容)?聚合/.test(thread.summary.trim())) return true
  if (/^围绕「.{0,8}」现有知识如何/.test(thread.coreQuestion.trim())) return true
  return false
}

function extractJsonObject(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenced) return fenced[1].trim()
  const start = text.indexOf("{")
  const end = text.lastIndexOf("}")
  return start >= 0 && end > start ? text.slice(start, end + 1) : text
}

async function wikiContext(projectPath: string, topic?: string): Promise<{ text: string; seeds: InspirationSeed[] }> {
  const pp = normalizePath(projectPath)
  const [seeds, graph] = await Promise.all([
    collectInspirationSeeds(pp, topic, 36).catch(() => []),
    buildWikiGraph(pp).catch(() => ({ nodes: [], edges: [], communities: [] })),
  ])
  const seedText = seeds.map((seed, i) =>
    `[${i + 1}] ${seed.title} (${seed.type}; community=${seed.community}; links=${seed.linkCount})\nPath: ${relativeToProject(pp, seed.path)}\n${seed.snippet}`,
  ).join("\n\n")
  const topicText = groupSeedsByCommunity(seeds).slice(0, 12).map((group, index) => {
    const titles = group.slice(0, 10).map((seed) => seed.title).join(" / ")
    const sourcePages = group.slice(0, 8).map((seed) => relativeToProject(pp, seed.path)).join(", ")
    return `Topic Cluster ${index + 1}: ${titles}\nSource pages: ${sourcePages}`
  }).join("\n")
  const communityText = graph.communities?.slice(0, 12).map((community) =>
    `Community ${community.id}: ${community.topNodes.slice(0, 12).join(", ")}; cohesion=${community.cohesion.toFixed(2)}`,
  ).join("\n") ?? ""
  const text = [
    topicText ? `## Candidate Knowledge Topics From Wiki Pages\n${topicText}` : "",
    communityText ? `## Graph Communities\n${communityText}` : "",
    seedText ? `## Key Wiki Pages\n${seedText.slice(0, 18000)}` : "",
  ].filter(Boolean).join("\n\n")
  return { text, seeds }
}

function buildThreadFromSeedGroup(
  group: InspirationSeed[],
  index: number,
  existing: KnowledgeThreadBundle,
  projectPath: string,
  now: number,
  context?: UserThreadContext,
): { thread: KnowledgeThread; nodes: KnowledgeThreadNode[]; edges: KnowledgeThreadEdge[]; gaps: KnowledgeThreadGap[] } {
  const top = group[0]
  const titleTerms = seedTitles(group, 4)
  const name = titleTerms[0] || `专题 ${index + 1}`
  const threadId = `thread-${shortId(name)}`
  const previous = existing.threads.find((item) => item.id === threadId)
  const pages = group.slice(0, 10).map((seed) => relativeToProject(projectPath, seed.path))
  const concepts = titleTerms.slice(0, 6)
  const derivedGaps = concreteGapsFromSeeds(name, group)
  const derivedDirections = concreteDirectionsFromSeeds(name, group, context)
  const thread: KnowledgeThread = {
    id: threadId,
    name,
    summary: deriveSummary(name, group),
    coreQuestion: deriveCoreQuestion(name, group),
    status: group.length >= 6 ? "active" : "forming",
    rootTopics: titleTerms.slice(0, 5),
    keyConcepts: concepts,
    sourcePages: pages,
    maturityScore: Math.min(0.9, 0.35 + group.length * 0.06),
    coverageScore: Math.min(0.9, 0.3 + pages.length * 0.06),
    coherenceScore: Math.min(0.85, 0.4 + (top?.linkCount ?? 0) * 0.04),
    noveltyScore: 0.55,
    activityScore: Math.min(0.9, 0.45 + group.filter((seed) => (seed.modifiedAt ?? 0) > now - 7 * 24 * 60 * 60 * 1000).length * 0.08),
    gaps: derivedGaps,
    nextDirections: derivedDirections,
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
  }
  const nodes: KnowledgeThreadNode[] = thread.sourcePages.slice(0, 8).map((page, i) => {
    const seed = group[i]
    const snippet = seed?.snippet?.trim().slice(0, 120) ?? ""
    const title = thread.rootTopics[i] || page.split("/").pop()?.replace(/\.md$/, "") || page
    return {
      id: `node-${shortId(thread.id)}-${i}`,
      threadId: thread.id,
      type: i === 0 ? "topic" : "source_page",
      title,
      summary: snippet || title,
      sourcePageIds: [page],
      relatedWikiLinks: [],
      confidence: 0.65,
      importance: Math.max(0.35, 0.9 - i * 0.06),
      createdAt: now,
      updatedAt: now,
    }
  })
  const rootNode = nodes[0]
  const edges: KnowledgeThreadEdge[] = rootNode
    ? nodes.slice(1).map((node, i) => ({
        id: `edge-${shortId(thread.id)}-${i}`,
        threadId: thread.id,
        sourceNodeId: rootNode.id,
        targetNodeId: node.id,
        type: "contains" as const,
        reason: "同属一个 Wiki 社区或高相关知识专题。",
        confidence: 0.62,
        createdAt: now,
      }))
    : []
  const gaps: KnowledgeThreadGap[] = [{
    id: `gap-${shortId(thread.id)}`,
    threadId: thread.id,
    title: derivedGaps[0]?.replace(/[。.]$/, "") || `${thread.name} 的关联证据不足`,
    description: derivedGaps.slice(1).join("；") || `当前材料主要集中在「${thread.name}」，缺少可用于验证边界、反例或应用条件的关联页面。`,
    priority: "medium" as const,
    sourceNodeIds: nodes.slice(0, 4).map((node) => node.id),
    status: "open" as const,
    createdAt: now,
    updatedAt: now,
  }]
  return { thread, nodes, edges, gaps }
}

function remapThreadArtifacts(
  result: { nodes: KnowledgeThreadNode[]; edges: KnowledgeThreadEdge[]; gaps: KnowledgeThreadGap[] },
  threadId: string,
): { nodes: KnowledgeThreadNode[]; edges: KnowledgeThreadEdge[]; gaps: KnowledgeThreadGap[] } {
  return {
    nodes: result.nodes.map((node) => ({ ...node, threadId })),
    edges: result.edges.map((edge) => ({ ...edge, threadId })),
    gaps: result.gaps.map((gap) => ({ ...gap, threadId })),
  }
}

function mergeUniqueStrings(primary: string[], fallback: string[], limit = 12): string[] {
  const seen = new Set<string>()
  const merged: string[] = []
  for (const item of [...primary, ...fallback]) {
    const trimmed = item.trim()
    if (!trimmed || seen.has(trimmed)) continue
    seen.add(trimmed)
    merged.push(trimmed)
    if (merged.length >= limit) break
  }
  return merged
}

function heuristicBundle(
  existing: KnowledgeThreadBundle,
  input: ThreadEvolutionInput,
  projectPath: string,
  seeds: InspirationSeed[],
  context?: UserThreadContext,
): KnowledgeThreadBundle {
  const now = Date.now()
  const { targetThreadId } = input

  // Single-thread iteration: only update the target thread, keep others intact
  if (targetThreadId) {
    const targetThread = existing.threads.find((t) => t.id === targetThreadId)
    if (!targetThread) {
      return heuristicBundle(existing, { ...input, targetThreadId: undefined }, projectPath, seeds, context)
    }
    const targetSeeds = filterSeedsForThread(seeds, targetThread, projectPath)
    const groups = groupSeedsByCommunity(targetSeeds).filter((g) => g.length > 0).slice(0, 1)
    const group = groups[0] ?? targetSeeds.slice(0, 12)
    if (group.length === 0) {
      const targetNodes = existing.nodes.filter((node) => node.threadId === targetThreadId)
      const targetGaps = existing.gaps.filter((gap) => gap.threadId === targetThreadId)
      const refreshedGaps = concreteGapsFromThread(targetThread, targetNodes, targetGaps)
      const refreshedDirections = concreteDirectionsFromThread(targetThread, targetNodes, targetGaps)
      const bumped: KnowledgeThread = {
        ...targetThread,
        updatedAt: now,
        gaps: nonGenericStrings(refreshedGaps, targetThread.gaps, 8),
        nextDirections: nonGenericStrings(refreshedDirections, targetThread.nextDirections, 8),
      }
      const log: ThreadEvolutionLog = {
        id: id("thread-log"),
        triggerType: "manual_refresh",
        triggerRef: targetThreadId,
        affectedThreadIds: [targetThreadId],
        summary: `已对「${targetThread.name}」进行迭代，当前无新增 Wiki 内容，原有节点、关系、缺口和评分保持不变。`,
        addedNodes: [],
        updatedNodes: [],
        addedEdges: [],
        newGaps: [],
        resolvedGaps: [],
        nextTasks: bumped.nextDirections.slice(0, 3),
        createdAt: now,
      }
      return {
        ...existing,
        threads: existing.threads.map((t) => (t.id === targetThreadId ? bumped : t)),
        logs: [log, ...existing.logs].slice(0, 80),
      }
    }
    const result = buildThreadFromSeedGroup(group, 0, existing, projectPath, now, context)
    const artifacts = remapThreadArtifacts(result, targetThreadId)
    const iteratedThread: KnowledgeThread = {
      ...result.thread,
      id: targetThreadId,
      name: targetThread.name,
      createdAt: targetThread.createdAt,
      maturityScore: targetThread.maturityScore,
      coherenceScore: Math.max(targetThread.coherenceScore, result.thread.coherenceScore),
      gaps: nonGenericStrings(result.thread.gaps, targetThread.gaps),
      nextDirections: nonGenericStrings(result.thread.nextDirections, targetThread.nextDirections),
    }
    const log: ThreadEvolutionLog = {
      id: id("thread-log"),
      triggerType: "manual_refresh",
      triggerRef: targetThreadId,
      affectedThreadIds: [targetThreadId],
      summary: `已对「${targetThread.name}」进行单脉络迭代，更新了节点、边和知识缺口。`,
      addedNodes: artifacts.nodes.map((n) => n.id),
      updatedNodes: [],
      addedEdges: artifacts.edges.map((e) => e.id),
      newGaps: artifacts.gaps.map((g) => g.id),
      resolvedGaps: [],
      nextTasks: iteratedThread.nextDirections.slice(0, 4),
      createdAt: now,
    }
    return {
      ...existing,
      threads: existing.threads.map((t) => (t.id === targetThreadId ? iteratedThread : t)),
      nodes: [...existing.nodes.filter((n) => n.threadId !== targetThreadId), ...artifacts.nodes],
      edges: [...existing.edges.filter((e) => e.threadId !== targetThreadId), ...artifacts.edges],
      gaps: [...existing.gaps.filter((g) => g.threadId !== targetThreadId), ...artifacts.gaps],
      contexts: context ? [context, ...existing.contexts].slice(0, 100) : existing.contexts,
      logs: [log, ...existing.logs].slice(0, 80),
    }
  }

  // Full regeneration: rebuild all threads from seeds
  const groups = groupSeedsByCommunity(seeds).filter((group) => group.length > 0).slice(0, 8)
  const sourceGroups = groups.length > 0 ? groups : [seeds.slice(0, 12)].filter((group) => group.length > 0)
  const results = sourceGroups.map((group, index) =>
    buildThreadFromSeedGroup(group, index, existing, projectPath, now, context),
  )
  const threads = results.map((r) => r.thread)
  const nodes = results.flatMap((r) => r.nodes)
  const edges = results.flatMap((r) => r.edges)
  const newGaps = results.flatMap((r) => r.gaps)
  const affectedThreadIds = threads.map((t) => t.id)
  const log: ThreadEvolutionLog = {
    id: id("thread-log"),
    triggerType: input.triggerType === "user_context_added" ? "user_context_added" : input.triggerType === "new_source_ingested" ? "new_source_ingested" : "manual_refresh",
    triggerRef: context?.id ?? input.changedWikiPages?.join(", ") ?? "manual",
    affectedThreadIds,
    summary: context
      ? `已结合用户补充描述重新从 Wiki 内容中梳理知识专题：${context.content}`
      : `已从 Wiki 内容和图谱社区中保底梳理出 ${threads.length} 条知识专题。`,
    addedNodes: nodes.map((node) => node.id),
    updatedNodes: [],
    addedEdges: edges.map((edge) => edge.id),
    newGaps: newGaps.map((gap) => gap.id),
    resolvedGaps: [],
    nextTasks: threads.flatMap((thread) => thread.nextDirections).slice(0, 6),
    createdAt: now,
  }
  return {
    ...existing,
    threads,
    nodes,
    edges,
    gaps: newGaps,
    contexts: context ? [context, ...existing.contexts].slice(0, 100) : existing.contexts,
    logs: [log, ...existing.logs].slice(0, 80),
  }
}

interface LlmThreadPayload {
  threads?: Array<Partial<KnowledgeThread>>
  nodes?: Array<Partial<KnowledgeThreadNode>>
  edges?: Array<Partial<KnowledgeThreadEdge>>
  gaps?: Array<Partial<KnowledgeThreadGap>>
  log?: Partial<ThreadEvolutionLog>
}

function normalizePayload(
  payload: LlmThreadPayload,
  existing: KnowledgeThreadBundle,
  input: ThreadEvolutionInput,
  context?: UserThreadContext,
): KnowledgeThreadBundle {
  const now = Date.now()
  const existingThreadIds = new Set(existing.threads.map((thread) => thread.id))
  const threads = (payload.threads ?? []).slice(0, 12).map((thread, index): KnowledgeThread => {
    const name = String(thread.name || `知识脉络 ${index + 1}`)
    const threadId = thread.id && existingThreadIds.has(thread.id) ? thread.id : `thread-${shortId(name)}`
    const previous = existing.threads.find((item) => item.id === threadId)
    const summary = String(thread.summary || previous?.summary || "")
    const coreQuestion = String(thread.coreQuestion || previous?.coreQuestion || "")
    const parsedGaps = safeArray(thread.gaps).filter((item) => !isGenericGuidance(item))
    const parsedDirections = safeArray(thread.nextDirections).filter((item) => !isGenericGuidance(item))
    return {
      id: threadId,
      name,
      summary,
      coreQuestion,
      status: ["forming", "active", "mature", "stale", "archived"].includes(String(thread.status)) ? thread.status as KnowledgeThread["status"] : previous?.status ?? "forming",
      rootTopics: safeArray(thread.rootTopics),
      keyConcepts: safeArray(thread.keyConcepts),
      sourcePages: safeArray(thread.sourcePages),
      maturityScore: clamp01(thread.maturityScore),
      coverageScore: clamp01(thread.coverageScore),
      coherenceScore: clamp01(thread.coherenceScore),
      noveltyScore: clamp01(thread.noveltyScore),
      activityScore: clamp01(thread.activityScore),
      gaps: parsedGaps.length > 0 ? parsedGaps : (previous?.gaps ?? []).filter((item) => !isGenericGuidance(item)),
      nextDirections: parsedDirections.length > 0 ? parsedDirections : (previous?.nextDirections ?? []).filter((item) => !isGenericGuidance(item)),
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
    }
  })
  const meaningfulThreads = threads.filter((thread) => !isGenericThread(thread))
  const validThreadIds = new Set(meaningfulThreads.map((thread) => thread.id))

  // Single-thread iteration: merge LLM output for target thread with existing other threads
  if (input.targetThreadId && meaningfulThreads.length > 0) {
    const targetThreadId = input.targetThreadId
    const previousThread = existing.threads.find((t) => t.id === targetThreadId)
    const singleThreadCandidates = meaningfulThreads.filter((thread, index) => {
      const rawId = payload.threads?.[index]?.id
      if (rawId && String(rawId) !== targetThreadId && existingThreadIds.has(String(rawId))) return false
      return artifactMatchesThread({
        threadId: rawId ? String(rawId) : undefined,
        title: thread.name,
        summary: `${thread.summary}\n${thread.coreQuestion}`,
        sourcePageIds: thread.sourcePages,
        relatedWikiLinks: thread.rootTopics,
      }, previousThread ?? thread, existingThreadIds)
    })
    const llmThread = singleThreadCandidates.find((t) => t.id === targetThreadId) ?? singleThreadCandidates[0]
    if (!previousThread || !llmThread) return existing
    let updatedThread: KnowledgeThread = previousThread
      ? {
          ...previousThread,
          ...llmThread,
          id: previousThread.id,
          createdAt: previousThread.createdAt,
          rootTopics: mergeUniqueStrings(llmThread.rootTopics, previousThread.rootTopics),
          keyConcepts: mergeUniqueStrings(llmThread.keyConcepts, previousThread.keyConcepts),
          sourcePages: mergeUniqueStrings(llmThread.sourcePages, previousThread.sourcePages),
          gaps: nonGenericStrings(llmThread.gaps, previousThread.gaps),
          nextDirections: nonGenericStrings(llmThread.nextDirections, previousThread.nextDirections),
          updatedAt: now,
        }
      : { ...llmThread, id: targetThreadId, updatedAt: now }
    const generatedNodes = (payload.nodes ?? []).slice(0, 120).flatMap((node, index): KnowledgeThreadNode[] => {
      if (!artifactMatchesThread(node, previousThread, existingThreadIds)) return []
      const title = String(node.title || `节点 ${index + 1}`)
      return [{
        id: String(node.id || `node-${shortId(title)}-${index}`),
        threadId: targetThreadId,
        type: String(node.type || "concept") as KnowledgeThreadNode["type"],
        title,
        summary: String(node.summary || ""),
        sourcePageIds: safeArray(node.sourcePageIds),
        relatedWikiLinks: safeArray(node.relatedWikiLinks),
        confidence: clamp01(node.confidence),
        importance: clamp01(node.importance),
        createdAt: now,
        updatedAt: now,
      }]
    })
    const threadNodes = generatedNodes.length > 0
      ? generatedNodes
      : existing.nodes.filter((node) =>
          node.threadId === targetThreadId &&
          artifactSourcePagesBelongToThread(node.sourcePageIds, previousThread),
        )
    const validNodeIds = new Set(threadNodes.map((n) => n.id))
    const generatedEdges = (payload.edges ?? []).slice(0, 180).flatMap((edge, index): KnowledgeThreadEdge[] => {
      const edgeThreadId = edge.threadId ? String(edge.threadId) : ""
      if (edgeThreadId && edgeThreadId !== targetThreadId && existingThreadIds.has(edgeThreadId)) return []
      const sourceNodeId = String(edge.sourceNodeId || "")
      const targetNodeId = String(edge.targetNodeId || "")
      if (!validNodeIds.has(sourceNodeId) || !validNodeIds.has(targetNodeId)) return []
      return [{
        id: String(edge.id || `edge-${index}-${shortId(sourceNodeId)}-${shortId(targetNodeId)}`),
        threadId: targetThreadId,
        sourceNodeId,
        targetNodeId,
        type: String(edge.type || "contains") as KnowledgeThreadEdge["type"],
        reason: String(edge.reason || ""),
        confidence: clamp01(edge.confidence),
        createdAt: now,
      }]
    })
    const threadEdges = generatedEdges.length > 0
      ? generatedEdges
      : existing.edges.filter((edge) => edge.threadId === targetThreadId)
    const generatedGaps = (payload.gaps ?? []).slice(0, 60).flatMap((gap, index): KnowledgeThreadGap[] => {
      const title = String(gap.title || `知识缺口 ${index + 1}`)
      const description = String(gap.description || "")
      if (!artifactMatchesThread(gap, previousThread, existingThreadIds)) return []
      if (isGenericGap(title, description)) return []
      return [{
        id: String(gap.id || `gap-${shortId(title)}-${index}`),
        threadId: targetThreadId,
        title,
        description,
        priority: ["low", "medium", "high"].includes(String(gap.priority)) ? gap.priority as KnowledgeThreadGap["priority"] : "medium",
        sourceNodeIds: safeArray(gap.sourceNodeIds).filter((nodeId) => validNodeIds.has(nodeId)),
        status: ["open", "resolved", "watching"].includes(String(gap.status)) ? gap.status as KnowledgeThreadGap["status"] : "open",
        createdAt: now,
        updatedAt: now,
      }]
    })
    const threadNodeIds = new Set(threadNodes.map((node) => node.id))
    const threadGaps = generatedGaps.length > 0
      ? generatedGaps
      : existing.gaps.filter((gap) =>
          gap.threadId === targetThreadId &&
          (gap.sourceNodeIds.length === 0 || gap.sourceNodeIds.some((nodeId) => threadNodeIds.has(nodeId))),
        )
    updatedThread = {
      ...updatedThread,
      gaps: updatedThread.gaps.length > 0
        ? updatedThread.gaps
        : concreteGapsFromThread(updatedThread, threadNodes, threadGaps),
      nextDirections: updatedThread.nextDirections.length > 0
        ? updatedThread.nextDirections
        : concreteDirectionsFromThread(updatedThread, threadNodes, threadGaps),
    }
    const mergedThreads = existing.threads.map((t) => (t.id === targetThreadId ? updatedThread : t))
    const log: ThreadEvolutionLog = {
      id: id("thread-log"),
      triggerType: "manual_refresh",
      triggerRef: targetThreadId,
      affectedThreadIds: [targetThreadId],
      summary: String(payload.log?.summary || `已对「${updatedThread.name}」进行单脉络深度迭代。`),
      addedNodes: generatedNodes.map((n) => n.id),
      updatedNodes: [],
      addedEdges: generatedEdges.map((e) => e.id),
      newGaps: generatedGaps.map((g) => g.id),
      resolvedGaps: safeArray(payload.log?.resolvedGaps),
      nextTasks: safeArray(payload.log?.nextTasks),
      createdAt: now,
    }
    return {
      threads: mergedThreads,
      nodes: [...existing.nodes.filter((n) => n.threadId !== targetThreadId), ...threadNodes],
      edges: [...existing.edges.filter((e) => e.threadId !== targetThreadId), ...threadEdges],
      gaps: [...existing.gaps.filter((g) => g.threadId !== targetThreadId), ...threadGaps],
      contexts: context ? [context, ...existing.contexts].slice(0, 100) : existing.contexts,
      logs: [log, ...existing.logs].slice(0, 80),
    }
  }

  // Full regeneration: replace all threads
  const nodes = (payload.nodes ?? []).slice(0, 120).flatMap((node, index): KnowledgeThreadNode[] => {
    const threadId = String(node.threadId || meaningfulThreads[0]?.id || "")
    if (!validThreadIds.has(threadId)) return []
    const title = String(node.title || `节点 ${index + 1}`)
    return [{
      id: String(node.id || `node-${shortId(title)}-${index}`),
      threadId,
      type: String(node.type || "concept") as KnowledgeThreadNode["type"],
      title,
      summary: String(node.summary || ""),
      sourcePageIds: safeArray(node.sourcePageIds),
      relatedWikiLinks: safeArray(node.relatedWikiLinks),
      confidence: clamp01(node.confidence),
      importance: clamp01(node.importance),
      createdAt: now,
      updatedAt: now,
    }]
  })
  const validNodeIds = new Set(nodes.map((node) => node.id))
  const edges = (payload.edges ?? []).slice(0, 180).flatMap((edge, index): KnowledgeThreadEdge[] => {
    const sourceNodeId = String(edge.sourceNodeId || "")
    const targetNodeId = String(edge.targetNodeId || "")
    if (!validNodeIds.has(sourceNodeId) || !validNodeIds.has(targetNodeId)) return []
    const threadId = String(edge.threadId || nodes.find((node) => node.id === sourceNodeId)?.threadId || "")
    if (!validThreadIds.has(threadId)) return []
    return [{
      id: String(edge.id || `edge-${index}-${shortId(sourceNodeId)}-${shortId(targetNodeId)}`),
      threadId,
      sourceNodeId,
      targetNodeId,
      type: String(edge.type || "contains") as KnowledgeThreadEdge["type"],
      reason: String(edge.reason || ""),
      confidence: clamp01(edge.confidence),
      createdAt: now,
    }]
  })
  const gaps = (payload.gaps ?? []).slice(0, 60).flatMap((gap, index): KnowledgeThreadGap[] => {
    const threadId = String(gap.threadId || meaningfulThreads[0]?.id || "")
    if (!validThreadIds.has(threadId)) return []
    const title = String(gap.title || `知识缺口 ${index + 1}`)
    const description = String(gap.description || "")
    if (isGenericGap(title, description)) return []
    return [{
      id: String(gap.id || `gap-${shortId(title)}-${index}`),
      threadId,
      title,
      description,
      priority: ["low", "medium", "high"].includes(String(gap.priority)) ? gap.priority as KnowledgeThreadGap["priority"] : "medium",
      sourceNodeIds: safeArray(gap.sourceNodeIds).filter((nodeId) => validNodeIds.has(nodeId)),
      status: ["open", "resolved", "watching"].includes(String(gap.status)) ? gap.status as KnowledgeThreadGap["status"] : "open",
      createdAt: now,
      updatedAt: now,
    }]
  })
  const enrichedThreads = meaningfulThreads.map((thread) => {
    const threadNodes = nodes.filter((node) => node.threadId === thread.id)
    const threadGaps = gaps.filter((gap) => gap.threadId === thread.id)
    return {
      ...thread,
      gaps: thread.gaps.length > 0 ? thread.gaps : concreteGapsFromThread(thread, threadNodes, threadGaps),
      nextDirections: thread.nextDirections.length > 0 ? thread.nextDirections : concreteDirectionsFromThread(thread, threadNodes, threadGaps),
    }
  })
  const log: ThreadEvolutionLog = {
    id: id("thread-log"),
    triggerType: input.triggerType === "user_context_added" ? "user_context_added" : input.triggerType === "scheduled_evolution" ? "scheduled_evolution" : "manual_refresh",
    triggerRef: context?.id ?? input.changedWikiPages?.join(", ") ?? "manual",
    affectedThreadIds: safeArray(payload.log?.affectedThreadIds).filter((threadId) => validThreadIds.has(threadId)).slice(0, 12),
    summary: String(payload.log?.summary || "知识脉络已更新。"),
    addedNodes: safeArray(payload.log?.addedNodes),
    updatedNodes: safeArray(payload.log?.updatedNodes),
    addedEdges: safeArray(payload.log?.addedEdges),
    newGaps: safeArray(payload.log?.newGaps),
    resolvedGaps: safeArray(payload.log?.resolvedGaps),
    nextTasks: safeArray(payload.log?.nextTasks),
    createdAt: now,
  }
  return {
    threads: enrichedThreads,
    nodes,
    edges,
    gaps,
    contexts: context ? [context, ...existing.contexts].slice(0, 100) : existing.contexts,
    logs: [log, ...existing.logs].slice(0, 80),
  }
}

export async function runKnowledgeThreadEvolution(
  projectPath: string,
  llmConfig: LlmConfig,
  input: ThreadEvolutionInput,
): Promise<KnowledgeThreadBundle> {
  const pp = normalizePath(projectPath)
  const existing = await loadKnowledgeThreadBundle(pp)
  const context = input.userContext
  const isSingleThread = Boolean(input.targetThreadId)
  const targetThread = isSingleThread ? existing.threads.find((t) => t.id === input.targetThreadId) : null
  const topic = targetThread ? threadSearchQuery(targetThread, context?.content) : context?.content
  const wiki = await wikiContext(pp, topic)
  const seeds = targetThread ? filterSeedsForThread(wiki.seeds, targetThread, pp) : wiki.seeds
  const contextText = targetThread
    ? focusedContextText(
        pp,
        targetThread,
        seeds,
        existing.nodes.filter((n) => n.threadId === targetThread.id),
        existing.gaps.filter((g) => g.threadId === targetThread.id),
      )
    : wiki.text

  if (!hasUsableLlm(llmConfig)) {
    const next = heuristicBundle(existing, input, pp, seeds, context)
    await saveKnowledgeThreadBundle(pp, next)
    return next
  }

  const existingText = isSingleThread && targetThread
    ? JSON.stringify({
        targetThread,
        targetNodes: existing.nodes.filter((n) => n.threadId === targetThread.id).slice(0, 40),
        targetGaps: existing.gaps.filter((g) => g.threadId === targetThread.id).slice(0, 20),
        recentLogs: existing.logs.filter((l) => l.affectedThreadIds.includes(targetThread.id)).slice(0, 4),
        userContexts: existing.contexts.slice(0, 6),
      }, null, 2)
    : JSON.stringify({
        threads: existing.threads,
        nodes: existing.nodes.slice(0, 80),
        gaps: existing.gaps.slice(0, 40),
        recentLogs: existing.logs.slice(0, 8),
        userContexts: existing.contexts.slice(0, 12),
      }, null, 2)

  const systemPrompt = isSingleThread && targetThread
    ? [
        "You are a knowledge architect responsible for deepening and expanding a specific knowledge thread inside a wiki.",
        `You are given ONE target knowledge thread: "${targetThread.name}". Your task is to deepen it — add more nodes, refine edges, discover new gaps, and improve scores.`,
        `The thread's current core question is: "${targetThread.coreQuestion}".`,
        "A knowledge thread is a concrete storyline formed by a group of Wiki pages around a domain problem, including branches, evidence, gaps, and evolution directions.",
        "Isolation rule: use ONLY the target thread, its existing nodes/gaps/logs, and the related wiki pages provided for this target. Do not import sections, nodes, source pages, or gaps from any other knowledge thread.",
        `Every returned node, edge, gap, and thread.sourcePages entry must belong to targetThreadId "${targetThread.id}". If evidence belongs to another thread, omit it.`,
        "CRITICAL — thread.summary: Write a unique, content-specific description that captures what THIS thread covers. It must be clearly different from other threads. Ground every sentence in the actual wiki content. Never use template phrases.",
        "CRITICAL — thread.coreQuestion: Analyze this thread's knowledge AND its relationship with other threads (if any) to formulate a sharp, analytical research question. The question should probe contradictions, gaps, or unexplored connections between concepts.",
        "CRITICAL — thread.gaps and thread.nextDirections: regenerate them from the actual target thread content, nodes, gaps, recent logs, and wiki excerpts. Each item must name at least one actual concept/page/node from the provided content and say what is missing or what to do next. Do not copy generic placeholders.",
        "Use the candidate knowledge topics, graph communities, and key page excerpts to expand this thread with new nodes, edges, and gaps.",
        "Add nodes of various types (concept, method, question, claim, case, gap, idea). Each node.summary must be a unique, concrete description — never use placeholder text.",
        "Add edges with meaningful relationship types (depends_on, supports, contradicts, evolves_to, inspires, should_explore) and specific reasons.",
        "Identify specific knowledge gaps with concrete titles and descriptions.",
        "Forbidden gap/direction wording: generic phrases like '继续补充 Wiki 页面', '进一步梳理核心问题', '使用 LLM 深度迭代', '证据链与演进方向待细化'.",
        "Return a strict JSON object only. Do not return markdown or explanatory prose.",
        "JSON keys: threads (array with ONE updated thread), nodes, edges, gaps, log. All scores must be 0-1.",
      ].join("\n")
    : [
        "You are a knowledge architect responsible for identifying knowledge threads inside a wiki.",
        "Your task: from the provided Wiki content, extract 3-12 concrete knowledge threads. Each thread is a storyline formed by a group of Wiki pages around a domain problem.",
        "",
        "CRITICAL — thread.summary (descriptions MUST be unique per thread):",
        "Each thread.summary must be a distinctive description of what THIS specific thread covers, grounded in the actual wiki content. Two threads must NEVER have the same or similar summary. Highlight what makes each thread different — its unique angle, its specific knowledge domain, its particular set of problems.",
        "",
        "CRITICAL — thread.coreQuestion (must use cross-thread analysis):",
        "For each thread, analyze its own knowledge content AND its relationship with other threads to formulate a sharp, analytical core question. The question should probe contradictions, gaps, unexplored connections, or competing hypotheses. Examples of good questions: 'Attention mechanisms outperform RNNs in sequence tasks, but under what conditions does this advantage disappear?' or 'How does the efficiency-accuracy tradeoff in sparse transformers differ between NLP and vision domains?'",
        "",
        "Rules:",
        "- thread.name: a concrete topic name grounded in the actual knowledge base.",
        "- thread.summary: unique per thread, content-specific, no templates.",
        "- thread.coreQuestion: analytical, probes relationships between concepts, no templates.",
        "- thread.gaps and thread.nextDirections: content-specific lists generated from each thread's real pages, nodes, and unresolved issues. Each item must mention concrete concepts/pages/nodes from the input.",
        "- node.summary: concrete description from wiki content, NOT placeholder text.",
        "- gap.title/description: specific and actionable.",
        "- Only use the given Wiki content, graph communities, and existing threads.",
        "- Return a strict JSON object only (keys: threads, nodes, edges, gaps, log).",
        "- All scores must be 0-1.",
        "- Never output: \"知识库主线\", \"专题 N\", template questions/descriptions.",
        "- Never output generic gap/direction phrases such as \"继续补充 Wiki 页面\", \"进一步梳理核心问题\", \"使用 LLM 深度迭代\", or \"证据链与演进方向待细化\".",
      ].join("\n")

  let output = ""
  await streamChat(
    llmConfig,
    [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content: [
          `Trigger: ${input.triggerType}`,
          input.changedWikiPages?.length ? `Changed wiki pages: ${input.changedWikiPages.join(", ")}` : "",
          context ? `User context: ${context.content}` : "",
          input.targetThreadId ? `Target thread id: ${input.targetThreadId}` : "",
          "",
          isSingleThread ? "## Target knowledge thread (deepen this)" : "## Existing knowledge threads",
          existingText,
          "",
          "## Wiki / graph context",
          contextText,
        ].filter(Boolean).join("\n"),
      },
    ],
    {
      onToken: (token) => { output += token },
      onDone: () => {},
      onError: (err) => { throw err },
    },
    undefined,
    { temperature: 0.2, max_tokens: 6000 },
  )

  let next: KnowledgeThreadBundle
  try {
    const payload = JSON.parse(extractJsonObject(output)) as LlmThreadPayload
    next = normalizePayload(payload, existing, input, context)
    if (next.threads.length === 0) {
      next = heuristicBundle(existing, input, pp, seeds, context)
    }
  } catch {
    next = heuristicBundle(existing, input, pp, seeds, context)
  }
  await saveKnowledgeThreadBundle(pp, next)
  return next
}
