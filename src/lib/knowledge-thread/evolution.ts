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

function isGenericThread(thread: KnowledgeThread): boolean {
  const text = `${thread.name}\n${thread.summary}\n${thread.coreQuestion}`.toLowerCase()
  return (
    !thread.name.trim() ||
    !thread.summary.trim() ||
    !thread.coreQuestion.trim() ||
    /知识脉络\s*\d*$/.test(thread.name.trim()) ||
    thread.name.trim() === "知识库主线" ||
    text.includes("这条知识脉络试图回答什么") ||
    text.includes("当前知识库正在围绕哪些核心问题形成体系") ||
    text.includes("系统基于当前 wiki 内容识别出的核心知识主线")
  )
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

function heuristicBundle(
  existing: KnowledgeThreadBundle,
  input: ThreadEvolutionInput,
  projectPath: string,
  seeds: InspirationSeed[],
  context?: UserThreadContext,
): KnowledgeThreadBundle {
  const now = Date.now()
  const groups = groupSeedsByCommunity(seeds).filter((group) => group.length > 0).slice(0, 8)
  const sourceGroups = groups.length > 0 ? groups : [seeds.slice(0, 12)].filter((group) => group.length > 0)
  const threads: KnowledgeThread[] = sourceGroups.map((group, index) => {
    const top = group[0]
    const titleTerms = group.slice(0, 4).map((seed) => seed.title.replace(/\.(md|pdf)$/i, "").trim()).filter(Boolean)
    const name = titleTerms[0] || `专题 ${index + 1}`
    const threadId = `thread-${shortId(name)}`
    const previous = existing.threads.find((item) => item.id === threadId)
    const pages = group.slice(0, 10).map((seed) => relativeToProject(projectPath, seed.path))
    const concepts = titleTerms.slice(0, 6)
    return {
      id: threadId,
      name,
      summary: `由 ${titleTerms.slice(0, 3).join("、") || top?.title || "当前 Wiki 页面"} 等内容聚合出的知识专题，重点梳理这些页面之间的共同问题、方法和演进方向。`,
      coreQuestion: `围绕「${name}」，现有知识如何形成问题、方法、案例与后续探索方向？`,
      status: group.length >= 6 ? "active" : "forming",
      rootTopics: titleTerms.slice(0, 5),
      keyConcepts: concepts,
      sourcePages: pages,
      maturityScore: Math.min(0.9, 0.35 + group.length * 0.06),
      coverageScore: Math.min(0.9, 0.3 + pages.length * 0.06),
      coherenceScore: Math.min(0.85, 0.4 + (top?.linkCount ?? 0) * 0.04),
      noveltyScore: 0.55,
      activityScore: Math.min(0.9, 0.45 + group.filter((seed) => (seed.modifiedAt ?? 0) > now - 7 * 24 * 60 * 60 * 1000).length * 0.08),
      gaps: [`需要进一步提炼「${name}」内部的关键矛盾、证据链和可行动问题。`],
      nextDirections: [
        context?.content,
        `围绕「${name}」补充核心概念、关键方法、案例和未解决问题。`,
        "使用 LLM 重新分析以获得更精细的脉络节点和关系。",
      ].filter(Boolean) as string[],
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
    }
  })
  const nodes: KnowledgeThreadNode[] = threads.flatMap((thread) =>
    thread.sourcePages.slice(0, 8).map((page, index) => ({
      id: `node-${shortId(thread.id)}-${index}`,
      threadId: thread.id,
      type: index === 0 ? "topic" : "source_page",
      title: thread.rootTopics[index] || page.split("/").pop()?.replace(/\.md$/, "") || page,
      summary: `来源页面：${page}`,
      sourcePageIds: [page],
      relatedWikiLinks: [],
      confidence: 0.65,
      importance: Math.max(0.35, 0.9 - index * 0.06),
      createdAt: now,
      updatedAt: now,
    })),
  )
  const edges: KnowledgeThreadEdge[] = threads.flatMap((thread) => {
    const threadNodes = nodes.filter((node) => node.threadId === thread.id)
    const root = threadNodes[0]
    if (!root) return []
    return threadNodes.slice(1).map((node, index) => ({
      id: `edge-${shortId(thread.id)}-${index}`,
      threadId: thread.id,
      sourceNodeId: root.id,
      targetNodeId: node.id,
      type: "contains",
      reason: "同属一个 Wiki 社区或高相关知识专题。",
      confidence: 0.62,
      createdAt: now,
    }))
  })
  const gaps: KnowledgeThreadGap[] = threads.map((thread) => ({
    id: `gap-${shortId(thread.id)}`,
    threadId: thread.id,
    title: `${thread.name} 的证据链与演进方向待细化`,
    description: `当前已从 Wiki 页面聚合出专题，但仍需要进一步梳理核心问题、分支路径、缺口和可触发的点子/主题/梦境任务。`,
    priority: "medium",
    sourceNodeIds: nodes.filter((node) => node.threadId === thread.id).slice(0, 4).map((node) => node.id),
    status: "open",
    createdAt: now,
    updatedAt: now,
  }))
  const affectedThreadIds = threads.map((thread) => thread.id)
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
    newGaps: gaps.map((gap) => gap.id),
    resolvedGaps: [],
    nextTasks: threads.flatMap((thread) => thread.nextDirections).slice(0, 6),
    createdAt: now,
  }
  return {
    ...existing,
    threads,
    nodes,
    edges,
    gaps,
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
      gaps: safeArray(thread.gaps),
      nextDirections: safeArray(thread.nextDirections),
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
    }
  })
  const meaningfulThreads = threads.filter((thread) => !isGenericThread(thread))
  const validThreadIds = new Set(meaningfulThreads.map((thread) => thread.id))
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
    return [{
      id: String(gap.id || `gap-${shortId(title)}-${index}`),
      threadId,
      title,
      description: String(gap.description || ""),
      priority: ["low", "medium", "high"].includes(String(gap.priority)) ? gap.priority as KnowledgeThreadGap["priority"] : "medium",
      sourceNodeIds: safeArray(gap.sourceNodeIds).filter((nodeId) => validNodeIds.has(nodeId)),
      status: ["open", "resolved", "watching"].includes(String(gap.status)) ? gap.status as KnowledgeThreadGap["status"] : "open",
      createdAt: now,
      updatedAt: now,
    }]
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
    threads: meaningfulThreads,
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
  const { text: contextText, seeds } = await wikiContext(pp, context?.content)

  if (!hasUsableLlm(llmConfig)) {
    const next = heuristicBundle(existing, input, pp, seeds, context)
    await saveKnowledgeThreadBundle(pp, next)
    return next
  }

  const existingText = JSON.stringify({
    threads: existing.threads,
    nodes: existing.nodes.slice(0, 80),
    gaps: existing.gaps.slice(0, 40),
    recentLogs: existing.logs.slice(0, 8),
    userContexts: existing.contexts.slice(0, 12),
  }, null, 2)
  let output = ""
  await streamChat(
    llmConfig,
    [
      {
        role: "system",
        content: [
          "You are a knowledge architect responsible for identifying and evolving knowledge threads inside a wiki.",
          "Your task is to extract real knowledge topics and knowledge threads from the provided Wiki content. Do not explain what a knowledge thread is, and do not ask the user what it means.",
          "A knowledge thread is not a generic category. It is a concrete storyline formed by a group of Wiki pages around a domain problem, including branches, evidence, gaps, and evolution directions.",
          "Use the candidate knowledge topics, graph communities, and key page excerpts to produce 3-12 concrete knowledge topics.",
          "Each thread.name must be a topic name grounded in the actual knowledge base, such as a technology direction, product direction, research direction, business problem, or methodology system.",
          "Each thread.coreQuestion must be the specific question that this topic is trying to answer. Do not output placeholders, template questions, or phrases like \"这条知识脉络试图回答什么？\".",
          "Only use the given Wiki content, graph communities, user context, and existing threads. Do not invent pages or unsupported sources.",
          "If evidence is sparse, still derive low-confidence concrete topics from page titles and graph communities. Do not create generic results such as \"知识库主线\".",
          "Return a strict JSON object only. Do not return markdown or explanatory prose.",
          "JSON keys: threads, nodes, edges, gaps, log.",
          "Every thread must include id, name, summary, coreQuestion, status, rootTopics, keyConcepts, sourcePages, maturityScore, coverageScore, coherenceScore, noveltyScore, activityScore, gaps, and nextDirections.",
          "Every node must include id, threadId, type, title, summary, sourcePageIds, relatedWikiLinks, confidence, and importance.",
          "Every edge.sourceNodeId and edge.targetNodeId must reference an id that exists in nodes.",
          "All scores must be numbers between 0 and 1.",
          "Never use these as final results: \"知识库主线\", \"知识脉络 1\", \"当前知识库正在围绕哪些核心问题形成体系\", \"这条知识脉络试图回答什么\".",
        ].join("\n"),
      },
      {
        role: "user",
        content: [
          `Trigger: ${input.triggerType}`,
          input.changedWikiPages?.length ? `Changed wiki pages: ${input.changedWikiPages.join(", ")}` : "",
          context ? `User context: ${context.content}` : "",
          input.targetThreadId ? `Target thread id: ${input.targetThreadId}` : "",
          "",
          "## Existing knowledge threads",
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
