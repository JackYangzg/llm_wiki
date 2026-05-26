import { readFile } from "@/commands/fs"
import { streamChat } from "@/lib/llm-client"
import { hasUsableLlm } from "@/lib/has-usable-llm"
import { collectInspirationSeeds, groupSeedsByCommunity, readProjectPurpose } from "@/lib/theme-mining"
import { buildDreamWalk, hydrateDreamWalk } from "@/lib/dream-walk"
import { dedupInspirationItems } from "@/lib/idea-dedup"
import { rankWithMmr } from "@/lib/idea-ranking"
import { saveInspirationItems } from "@/lib/inspiration-persist"
import { evolveIdeas } from "@/lib/idea-evolution"
import { loadInspirationSnapshot } from "@/lib/inspiration-persist"
import {
  blankScores,
  type InspirationEvidence,
  type InspirationItem,
  type InspirationRun,
  type InspirationRunType,
  type InspirationSeed,
  type InspirationStrategy,
  type InspirationTriggerType,
  type IdeaStage,
  type DreamFragment,
  type DreamFragmentType,
  type DreamInsight,
  type DreamInsightType,
  type DreamMaterial,
  type DreamMaterialRole,
  type DreamMode,
  type DreamOutput,
} from "@/lib/inspiration-schema"
import { dreamReplayPrompt, ideaGenerationPrompt, themeMiningPrompt } from "@/lib/inspiration-prompts"
import { normalizePath } from "@/lib/path-utils"
import type { LlmConfig } from "@/stores/wiki-store"
import type { InspirationConfig } from "@/stores/wiki-store"

interface RunnerCallbacks {
  onRunUpdate?: (run: InspirationRun) => void
}

function id(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n))
}

function parseScore(value: unknown, fallback: number): number {
  if (typeof value !== "number" || Number.isNaN(value)) return fallback
  return clamp01(value > 1 ? value / 100 : value)
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String).map((s) => s.trim()).filter(Boolean) : []
}

function asDreamMode(value: unknown): DreamMode {
  const mode = String(value ?? "free_association")
  const allowed: DreamMode[] = ["free_association", "future", "counterfactual", "metaphor", "conflict", "roleplay", "gap_fill", "solution_evolution"]
  return allowed.includes(mode as DreamMode) ? mode as DreamMode : "free_association"
}

function asDreamFragmentType(value: unknown): DreamFragmentType {
  const type = String(value ?? "strange_connection")
  const allowed: DreamFragmentType[] = ["scene", "metaphor", "conflict", "transformation", "future", "dialogue", "strange_connection", "question_mutation", "solution_variant"]
  return allowed.includes(type as DreamFragmentType) ? type as DreamFragmentType : "strange_connection"
}

function asDreamInsightType(value: unknown): DreamInsightType {
  const type = String(value ?? "product_opportunity")
  const allowed: DreamInsightType[] = ["product_opportunity", "research_hypothesis", "workflow", "knowledge_gap", "solution", "task"]
  return allowed.includes(type as DreamInsightType) ? type as DreamInsightType : "product_opportunity"
}

function dreamMaterialRole(seed: InspirationSeed, index: number): DreamMaterialRole {
  if (index < 3) return "core"
  if (seed.type === "idea" || seed.type === "idea_card") return "historical"
  if (seed.community !== (index > 0 ? seed.community : -1) && index % 3 === 0) return "heterogeneous"
  if (seed.snippet.includes("but") || seed.snippet.includes("however") || seed.snippet.includes("冲突") || seed.snippet.includes("矛盾")) return "conflict"
  return index % 2 === 0 ? "edge" : "user_interest"
}

function buildDreamMaterials(runId: string, seeds: InspirationSeed[]): DreamMaterial[] {
  return seeds.slice(0, 18).map((seed, index) => ({
    id: `${runId}-material-${index + 1}`,
    role: dreamMaterialRole(seed, index),
    sourceType: seed.type === "idea" || seed.type === "idea_card" ? "idea" : seed.type === "theme" ? "theme" : "knowledge",
    sourceId: seed.path,
    title: seed.title,
    content: seed.snippet.slice(0, 360),
    relevanceScore: clamp01(0.55 + Math.min(seed.linkCount, 10) / 30),
  }))
}

function seedEvidence(runId: string, seeds: InspirationSeed[], indexes?: number[]): InspirationEvidence[] {
  const selected = (indexes && indexes.length > 0 ? indexes.map((i) => seeds[i - 1]).filter(Boolean) : seeds.slice(0, 3))
  return selected.slice(0, 5).map((seed, index) => ({
    id: `${runId}-ev-${index + 1}`,
    pagePath: seed.path,
    title: seed.title,
    role: index === 0 ? "support" : seed.community !== selected[0]?.community ? "bridge" : "support",
    snippet: seed.snippet.slice(0, 220),
    relevanceScore: clamp01(0.6 + seed.linkCount / 40),
  }))
}

function stageMaturity(stage: IdeaStage): number {
  if (stage === "seed") return 1
  if (stage === "candidate") return 2
  if (stage === "incubating") return 3
  if (stage === "validated") return 4
  if (stage === "mature" || stage === "adopted") return 5
  return 0
}

function stageFromScore(item: InspirationItem): IdeaStage {
  if (item.reviewState === "formal") return "adopted"
  if (item.reviewState === "rejected") return "archived"
  if (item.type === "dream") return "incubating"
  if (item.type === "theme") return item.scores.final >= 0.72 ? "incubating" : "candidate"
  if (item.scores.final >= 0.85) return "mature"
  if (item.scores.final >= 0.7) return "incubating"
  if (item.scores.final >= 0.55) return "candidate"
  return "seed"
}

function enrichFactoryLifecycle(
  item: InspirationItem,
  triggerType: InspirationTriggerType,
  runType: InspirationRunType,
): InspirationItem {
  const ideaStage = item.ideaStage ?? stageFromScore(item)
  const evidence = item.evidence ?? []
  const sourceKnowledgeIds = item.sourceKnowledgeIds?.length
    ? item.sourceKnowledgeIds
    : evidence.map((e) => e.pagePath)
  const relatedEntities = item.relatedEntities?.length
    ? item.relatedEntities
    : [...new Set(evidence.map((e) => e.title).filter(Boolean))].slice(0, 8)
  const reasoningPath = item.reasoningPath?.length
    ? item.reasoningPath
    : [
      `trigger:${triggerType}`,
      `run:${runType}`,
      `strategy:${item.strategy}`,
      ...evidence.slice(0, 5).map((e) => `${e.role}:${e.title}`),
    ]
  return {
    ...item,
    ideaStage,
    maturityLevel: item.maturityLevel ?? stageMaturity(ideaStage),
    version: item.version ?? 1,
    triggerType: item.triggerType ?? triggerType,
    sourceKnowledgeIds,
    relatedEntities,
    reasoningPath,
    lastTaskType: item.lastTaskType ?? (item.type === "idea" ? "score" : "structure"),
    reactivationReasons: item.reactivationReasons ?? [],
    mergedFrom: item.mergedFrom ?? [],
  }
}

async function completeJson(llmConfig: LlmConfig, system: string, user: string): Promise<unknown | null> {
  let output = ""
  await streamChat(
    llmConfig,
    [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    {
      onToken: (token) => { output += token },
      onDone: () => {},
      onError: (error) => { throw error },
    },
    undefined,
    { temperature: 0.7 },
  )
  const fenced = output.match(/```(?:json)?\s*([\s\S]*?)```/)
  const jsonText = fenced ? fenced[1] : output
  try {
    return JSON.parse(jsonText)
  } catch {
    const first = jsonText.indexOf("{")
    const last = jsonText.lastIndexOf("}")
    if (first >= 0 && last > first) {
      try {
        return JSON.parse(jsonText.slice(first, last + 1))
      } catch {
        return null
      }
    }
    return null
  }
}

function fallbackThemeItems(runId: string, seeds: InspirationSeed[]): InspirationItem[] {
  return groupSeedsByCommunity(seeds).slice(0, 6).map((group, index) => {
    const now = Date.now()
    const top = group[0]
    const title = top ? `${top.title} 周边主题簇` : `主题簇 ${index + 1}`
    const evidence = seedEvidence(runId, group.slice(0, 5))
    return {
      id: id("theme"),
      runId,
      type: "theme",
      origin: "theme_lab",
      title,
      summary: `由 ${group.length} 个页面形成的知识簇，核心节点包括 ${group.slice(0, 3).map((s) => s.title).join("、")}。`,
      body: [
        "## Key Tension",
        "这些页面之间已经有足够连接，适合继续提炼共同命题、冲突点与下一步研究问题。",
        "",
        "## Opportunity",
        "可以把这个主题作为今天的发散入口，生成桥接假设、矛盾问题或梦境回放。",
      ].join("\n"),
      strategy: "community",
      themeKey: `community-${top?.community ?? index}`,
      markdownPath: "",
      evidence,
      scores: blankScores({
        groundedness: evidence.length > 0 ? 0.82 : 0.45,
        novelty: 0.58 + Math.min(group.length, 6) * 0.04,
        goalFit: 0.72,
        actionability: 0.62,
      }),
      reviewState: "new",
      lifecycleStatus: "idle",
      createdAt: now,
      enteredAt: now,
      updatedAt: now,
      evolutionCount: 0,
    }
  })
}

function fallbackIdeaItems(runId: string, topic: string, strategy: InspirationStrategy, seeds: InspirationSeed[]): InspirationItem[] {
  const evidence = seedEvidence(runId, seeds)
  const now = Date.now()
  return [{
    id: id("idea"),
    runId,
    type: "idea",
    origin: "factory",
    title: `${topic} 的${strategy === "bridge" ? "桥接假设" : strategy === "contradiction" ? "张力问题" : "实验想法"}`,
    summary: `基于 ${evidence.map((e) => e.title).slice(0, 2).join("、")}，继续追问一个可验证的新方向。`,
    body: [
      "## Why Interesting",
      "这个想法来自现有证据之间的相邻关系。它不是事实结论，而是下一步探索的候选入口。",
      "",
      "## Next Actions",
      "- 展开证据页，确认是否有一手来源支撑。",
      "- 将问题投递到 Deep Research 或写成正式 query 页面。",
      "",
      "## Risks",
      "- 证据数量有限，可能只是语义相近而不是真实关联。",
    ].join("\n"),
    strategy,
    themeKey: topic,
    markdownPath: "",
    evidence,
    scores: blankScores({ novelty: strategy === "bridge" ? 0.75 : 0.68, actionability: 0.72 }),
    reviewState: "new",
    lifecycleStatus: "idle",
    createdAt: now,
    enteredAt: now,
    updatedAt: now,
    evolutionCount: 0,
  }]
}

async function generateThemeItems(runId: string, llmConfig: LlmConfig, purpose: string, seeds: InspirationSeed[]): Promise<InspirationItem[]> {
  if (!hasUsableLlm(llmConfig)) return fallbackThemeItems(runId, seeds)
  const prompt = themeMiningPrompt(purpose, seeds)
  const parsed = await completeJson(llmConfig, prompt.system, prompt.user).catch(() => null) as { themes?: Array<Record<string, unknown>> } | null
  if (!parsed?.themes?.length) return fallbackThemeItems(runId, seeds)
  return parsed.themes.slice(0, 8).map((theme) => {
    const now = Date.now()
    const evidenceIndexes = Array.isArray(theme.evidenceIndexes) ? theme.evidenceIndexes.map(Number).filter(Boolean) : undefined
    const evidence = seedEvidence(runId, seeds, evidenceIndexes)
    const title = String(theme.title ?? "Untitled Theme")
    return {
      id: id("theme"),
      runId,
      type: "theme",
      origin: "theme_lab",
      title,
      summary: String(theme.summary ?? ""),
      body: [
        "## Key Tension",
        String(theme.tension ?? "No explicit tension identified."),
        "",
        "## Opportunity",
        String(theme.opportunity ?? "Use this theme as an ideation seed."),
        "",
        "## Knowledge Gap",
        String(theme.gap ?? "No explicit gap identified."),
      ].join("\n"),
      strategy: "community",
      themeKey: title,
      markdownPath: "",
      evidence,
      scores: blankScores({
        groundedness: evidence.length >= 2 ? 0.84 : 0.58,
        novelty: 0.72,
        goalFit: 0.76,
        actionability: 0.64,
      }),
      reviewState: "new",
      lifecycleStatus: "idle",
      createdAt: now,
      enteredAt: now,
      updatedAt: now,
      evolutionCount: 0,
    }
  })
}

async function generateIdeaItems(
  runId: string,
  llmConfig: LlmConfig,
  topic: string,
  strategy: InspirationStrategy,
  purpose: string,
  seeds: InspirationSeed[],
): Promise<InspirationItem[]> {
  if (!hasUsableLlm(llmConfig)) return fallbackIdeaItems(runId, topic, strategy, seeds)
  const prompt = ideaGenerationPrompt(topic, strategy, purpose, seeds)
  const parsed = await completeJson(llmConfig, prompt.system, prompt.user).catch(() => null) as { ideas?: Array<Record<string, unknown>> } | null
  if (!parsed?.ideas?.length) return fallbackIdeaItems(runId, topic, strategy, seeds)
  return parsed.ideas.slice(0, 5).map((idea) => {
    const now = Date.now()
    const evidenceIndexes = Array.isArray(idea.evidenceIndexes) ? idea.evidenceIndexes.map(Number).filter(Boolean) : undefined
    const evidence = seedEvidence(runId, seeds, evidenceIndexes)
    const actions = stringArray(idea.next_actions)
    const risks = stringArray(idea.risks)
    const targetUsers = stringArray(idea.target_users)
    const relatedEntities = stringArray(idea.related_entities)
    const sourceKnowledge = stringArray(idea.source_knowledge)
    const rawScores = typeof idea.scores === "object" && idea.scores ? idea.scores as Record<string, unknown> : {}
    return {
      id: id("idea"),
      runId,
      type: "idea",
      origin: "factory",
      title: String(idea.title ?? "Untitled Idea"),
      summary: String(idea.one_liner ?? idea.why_interesting ?? ""),
      body: [
        "## Problem",
        String(idea.problem ?? "No explicit problem framed yet."),
        "",
        "## Solution",
        String(idea.solution ?? "No explicit solution framed yet."),
        "",
        "## Target Users",
        targetUsers.map((user) => `- ${user}`).join("\n") || "- To be clarified during incubation.",
        "",
        "## Value",
        String(idea.value ?? "Value hypothesis needs validation."),
        "",
        "## Why Interesting",
        String(idea.why_interesting ?? ""),
        "",
        "## Next Actions",
        actions.map((a) => `- ${String(a)}`).join("\n") || "- Validate this idea against the evidence trail.",
        "",
        "## Risks",
        risks.map((r) => `- ${String(r)}`).join("\n") || "- Evidence may be incomplete.",
      ].join("\n"),
      strategy,
      themeKey: topic,
      markdownPath: "",
      evidence,
      scores: blankScores({
        groundedness: parseScore(rawScores.evidence, evidence.length >= 2 ? 0.82 : 0.55),
        novelty: parseScore(rawScores.novelty, strategy === "bridge" || strategy === "analogy" ? 0.78 : 0.7),
        goalFit: parseScore(rawScores.relevance, parseScore(rawScores.value, 0.72)),
        actionability: parseScore(rawScores.actionability, parseScore(rawScores.feasibility, actions.length > 0 ? 0.78 : 0.58)),
        diversity: parseScore(rawScores.differentiation, 0.66),
      }),
      relatedEntities,
      reasoningPath: [
        ...sourceKnowledge.map((source) => `source:${source}`),
        ...evidence.slice(0, 5).map((e) => `${e.role}:${e.title}`),
      ],
      reviewState: "new",
      lifecycleStatus: "idle",
      createdAt: now,
      enteredAt: now,
      updatedAt: now,
      evolutionCount: 0,
    }
  })
}

async function generateDreamItem(runId: string, llmConfig: LlmConfig, topic: string, seeds: InspirationSeed[]): Promise<InspirationItem[]> {
  const walk = await buildDreamWalk(normalizePath(useProjectPathFromSeeds(seeds)), seeds, topic)
  const hydrated = await hydrateDreamWalk(walk)
  const dreamMaterials = buildDreamMaterials(runId, seeds)
  const evidence = seedEvidence(runId, hydrated.map((step, index) => ({
    path: step.path,
    title: step.title,
    type: "dream-step",
    snippet: step.snippet,
    linkCount: Math.max(1, 5 - index),
    community: index,
  })))
  if (hasUsableLlm(llmConfig) && hydrated.length > 0) {
    const prompt = dreamReplayPrompt(topic, hydrated)
    const parsed = await completeJson(llmConfig, prompt.system, prompt.user).catch(() => null) as Record<string, unknown> | null
    if (parsed) {
      const fragments: DreamFragment[] = Array.isArray(parsed.fragments)
        ? parsed.fragments.slice(0, 12).map((fragment, index) => {
          const f = fragment as Record<string, unknown>
          const sourceIndexes = Array.isArray(f.sourceIndexes) ? f.sourceIndexes.map(Number).filter(Boolean) : []
          return {
            id: `${runId}-fragment-${index + 1}`,
            type: asDreamFragmentType(f.type),
            title: String(f.title ?? `Dream fragment ${index + 1}`),
            content: String(f.content ?? ""),
            relatedEntities: stringArray(f.relatedEntities),
            sourceMaterialIds: sourceIndexes.map((sourceIndex) => dreamMaterials[sourceIndex - 1]?.id).filter(Boolean),
            imaginationLevel: parseScore(f.imaginationLevel, 0.72),
            relevanceScore: parseScore(f.relevanceScore, 0.68),
          }
        })
        : []
      const afterReview = typeof parsed.afterReview === "object" && parsed.afterReview ? parsed.afterReview as Record<string, unknown> : {}
      const insights: DreamInsight[] = Array.isArray(afterReview.insights)
        ? afterReview.insights.slice(0, 8).map((insight, index) => {
          const it = insight as Record<string, unknown>
          const fragmentIndexes = Array.isArray(it.sourceFragmentIndexes) ? it.sourceFragmentIndexes.map(Number).filter(Boolean) : []
          return {
            id: `${runId}-insight-${index + 1}`,
            type: asDreamInsightType(it.type),
            content: String(it.content ?? ""),
            sourceFragmentIds: fragmentIndexes.map((fragmentIndex) => fragments[fragmentIndex - 1]?.id).filter(Boolean),
            valueScore: parseScore(it.valueScore, 0.7),
            convertStatus: "candidate",
          }
        })
        : []
      const dreamBornIdeas = Array.isArray(afterReview.dreamBornIdeas) ? afterReview.dreamBornIdeas : []
      const outputs: DreamOutput[] = [
        ...stringArray(afterReview.usableCreatives).map((content, index) => ({
          id: `${runId}-output-creative-${index + 1}`,
          outputType: "idea" as const,
          title: content.slice(0, 40),
          content,
          targetSystem: "idea_factory" as const,
        })),
        ...stringArray(afterReview.solutions).map((content, index) => ({
          id: `${runId}-output-solution-${index + 1}`,
          outputType: "solution" as const,
          title: content.slice(0, 40),
          content,
        })),
        ...stringArray(afterReview.hypotheses).map((content, index) => ({
          id: `${runId}-output-hypothesis-${index + 1}`,
          outputType: "hypothesis" as const,
          title: content.slice(0, 40),
          content,
        })),
        ...stringArray(afterReview.knowledgeGaps).map((content, index) => ({
          id: `${runId}-output-gap-${index + 1}`,
          outputType: "knowledge_gap" as const,
          title: content.slice(0, 40),
          content,
          targetSystem: "deep_research" as const,
        })),
        ...stringArray(afterReview.nextTasks).map((content, index) => ({
          id: `${runId}-output-task-${index + 1}`,
          outputType: "task" as const,
          title: content.slice(0, 40),
          content,
        })),
        ...dreamBornIdeas.slice(0, 5).map((idea, index) => {
          const record = idea as Record<string, unknown>
          const title = String(record.title ?? `Dream-born idea ${index + 1}`)
          return {
            id: `${runId}-output-dream-idea-${index + 1}`,
            outputType: "idea" as const,
            title,
            content: [
              String(record.description ?? ""),
              String(record.problem ?? ""),
              String(record.solution ?? ""),
              String(record.nextStep ?? ""),
            ].filter(Boolean).join("\n"),
            targetSystem: "idea_factory" as const,
          }
        }),
      ]
      const walkLines = stringArray(parsed.walk)
      return [{
        id: id("dream"),
        runId,
        type: "dream",
        origin: "dream",
        title: String(parsed.title ?? `${topic} 的梦境回放`),
        summary: String(parsed.summary ?? outputs[0]?.content ?? ""),
        body: [
          "## Dream Fragments",
          fragments.map((fragment) => `### ${fragment.title}\n${fragment.content}`).join("\n\n") || "No dream fragments generated.",
          "",
          "## Dream Walk",
          walkLines.map((beat) => `- ${beat}`).join("\n") || "No replay beats generated.",
          "",
          "## Wake Review",
          insights.map((insight) => `- **${insight.type}**: ${insight.content}`).join("\n") || "No wake review generated.",
          "",
          "## Dream-born Outputs",
          outputs.map((output) => `- **${output.outputType}** ${output.title}: ${output.content}`).join("\n") || "No dream-born outputs yet.",
        ].join("\n"),
        strategy: "dream",
        themeKey: topic,
        markdownPath: "",
        evidence,
        scores: blankScores({ novelty: 0.82, diversity: 0.8, actionability: 0.62 }),
        dreamMode: asDreamMode(parsed.dreamMode),
        dreamMaterials,
        dreamFragments: fragments,
        dreamInsights: insights,
        dreamOutputs: outputs,
        dreamScore: parseScore(parsed.dreamScore, 0.74),
        reviewState: "new",
        lifecycleStatus: "idle",
        createdAt: Date.now(),
        enteredAt: Date.now(),
        updatedAt: Date.now(),
        evolutionCount: 0,
      }]
    }
  }
  const pathText = hydrated.map((step) => `- ${step.title}: ${step.reason}`).join("\n")
  return [{
    id: id("dream"),
    runId,
    type: "dream",
    origin: "dream",
    title: `${topic} 的梦境回放`,
    summary: "一次可追溯的图谱跳转，把相邻节点和跨簇节点串成新的联想线索。",
    body: [
      "## Replay Path",
      pathText || "- No graph walk available yet.",
      "",
      "## Actionable Idea",
      "选择最意外的一跳，把它改写成一个可验证的问题或小实验。",
    ].join("\n"),
    strategy: "dream",
    themeKey: topic,
    markdownPath: "",
    evidence,
    scores: blankScores({ novelty: 0.78, diversity: 0.82 }),
    dreamMode: "free_association",
    dreamMaterials,
    dreamFragments: hydrated.slice(0, 8).map((step, index) => ({
      id: `${runId}-fragment-${index + 1}`,
      type: "strange_connection",
      title: step.title,
      content: step.reason || step.snippet,
      relatedEntities: [step.title],
      sourceMaterialIds: [dreamMaterials[index]?.id].filter(Boolean),
      imaginationLevel: 0.68,
      relevanceScore: 0.66,
    })),
    dreamInsights: [],
    dreamOutputs: [],
    dreamScore: 0.68,
    reviewState: "new",
    lifecycleStatus: "idle",
    createdAt: Date.now(),
    enteredAt: Date.now(),
    updatedAt: Date.now(),
    evolutionCount: 0,
  }]
}

function useProjectPathFromSeeds(seeds: InspirationSeed[]): string {
  const first = seeds[0]?.path
  if (!first) return ""
  const marker = "/wiki/"
  const index = normalizePath(first).indexOf(marker)
  return index >= 0 ? normalizePath(first).slice(0, index) : ""
}

function relevanceTokens(text: string): Set<string> {
  const normalized = text.toLowerCase()
  const tokens = new Set<string>()
  for (const token of normalized.split(/[^\p{L}\p{N}]+/u).map((part) => part.trim()).filter((part) => part.length >= 2)) {
    tokens.add(token)
  }
  const cjk = normalized.match(/[\u4e00-\u9fff]+/gu) ?? []
  for (const segment of cjk) {
    for (let i = 0; i < segment.length - 1; i++) {
      tokens.add(segment.slice(i, i + 2))
    }
  }
  return tokens
}

function tokenOverlapScore(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let overlap = 0
  for (const token of a) {
    if (b.has(token)) overlap++
  }
  return overlap / Math.min(a.size, b.size)
}

function itemRelevanceText(item: InspirationItem): string {
  return [
    item.title,
    item.summary,
    item.themeKey,
    item.body,
    ...(item.relatedEntities ?? []),
    ...(item.reasoningPath ?? []),
    ...(item.evidence ?? []).flatMap((evidence) => [evidence.title, evidence.snippet, evidence.pagePath]),
  ].filter(Boolean).join("\n")
}

function seedRelevanceText(seed: InspirationSeed): string {
  return [seed.title, seed.type, seed.snippet, seed.path].filter(Boolean).join("\n")
}

function recentFactoryKnowledgeSeeds(snapshot: { runs: InspirationRun[] } | null, seeds: InspirationSeed[]): InspirationSeed[] {
  const latestFactoryRunAt = snapshot?.runs
    .filter((run) => run.runType === "daily" || run.runType === "factory")
    .reduce((latest, run) => Math.max(latest, run.finishedAt ?? run.startedAt ?? 0), 0) ?? 0
  const recent = seeds.filter((seed) => (seed.modifiedAt ?? 0) > latestFactoryRunAt)
  return recent.length > 0
    ? recent
    : [...seeds].sort((a, b) => (b.modifiedAt ?? 0) - (a.modifiedAt ?? 0)).slice(0, 24)
}

function relevantFactoryIdeaIds(snapshot: { items: InspirationItem[] } | null, seeds: InspirationSeed[]): string[] {
  if (!snapshot || seeds.length === 0) return []
  const seedTexts = seeds.map((seed) => ({
    seed,
    tokens: relevanceTokens(seedRelevanceText(seed)),
    path: normalizePath(seed.path),
  }))
  const ids: string[] = []
  for (const item of snapshot.items) {
    if (
      item.origin !== "factory" ||
      item.type !== "idea" ||
      item.reviewState === "formal" ||
      item.reviewState === "rejected" ||
      item.ideaStage === "adopted" ||
      item.ideaStage === "archived" ||
      !item.markdownPath
    ) {
      continue
    }
    const evidencePaths = new Set((item.evidence ?? []).map((evidence) => normalizePath(evidence.pagePath)))
    const itemTokens = relevanceTokens(itemRelevanceText(item))
    const relevant = seedTexts.some(({ tokens, path }) =>
      evidencePaths.has(path) ||
      tokenOverlapScore(itemTokens, tokens) >= 0.18 ||
      [...tokens].some((token) => token.length >= 4 && itemTokens.has(token)),
    )
    if (relevant) ids.push(item.id)
  }
  return ids
}

export async function runInspiration(
  projectPath: string,
  llmConfig: LlmConfig,
  config: Pick<InspirationConfig, "ideasPath" | "dreamMinDurationMinutes"> | undefined,
  runType: InspirationRunType,
  triggerType: InspirationTriggerType,
  topic?: string,
  callbacks: RunnerCallbacks = {},
): Promise<{ run: InspirationRun; items: InspirationItem[] }> {
  const pp = normalizePath(projectPath)
  const runId = id("idea-run")
  let run: InspirationRun = {
    id: runId,
    runType,
    triggerType,
    topic,
    runDate: today(),
    status: "collecting",
    startedAt: Date.now(),
    itemIds: [],
  }
  callbacks.onRunUpdate?.(run)

  const [purpose, seeds] = await Promise.all([
    readProjectPurpose(pp),
    collectInspirationSeeds(pp, topic, runType === "daily" ? 96 : 48),
  ])

  if (seeds.length === 0) {
    run = { ...run, status: "error", error: "No wiki pages available for inspiration.", finishedAt: Date.now() }
    callbacks.onRunUpdate?.(run)
    return { run, items: [] }
  }

  run = { ...run, status: "generating" }
  callbacks.onRunUpdate?.(run)

  let candidates: InspirationItem[] = []
  if (runType === "daily") {
    const snapshotBeforeEvolution = await loadInspirationSnapshot(pp).catch(() => null)
    const changedKnowledgeSeeds = recentFactoryKnowledgeSeeds(snapshotBeforeEvolution, seeds)
    const relevantIdeaIds = relevantFactoryIdeaIds(snapshotBeforeEvolution, changedKnowledgeSeeds)
    if (relevantIdeaIds.length > 0) {
      await evolveIdeas(pp, llmConfig, relevantIdeaIds.length, relevantIdeaIds).catch(() => {})
    }
    const snapshot = await loadInspirationSnapshot(pp).catch(() => null)
    const existingIdeaContext = snapshot?.items
      .filter((item) => item.origin === "factory" && item.type === "idea" && item.reviewState !== "formal" && item.reviewState !== "rejected")
      .slice(0, 20)
      .map((item, index) => [
        `[${index + 1}] ${item.title}`,
        item.summary,
        `stage=${item.ideaStage ?? "candidate"}; maturity=${item.maturityLevel ?? 2}; version=${item.version ?? 1}; evolution_count=${item.evolutionCount ?? 0}; updated=${new Date(item.updatedAt ?? item.createdAt).toISOString()}`,
      ].join("\n"))
      .join("\n\n") ?? ""
    const factoryPurpose = [
      purpose,
      "",
      "## Existing idea factory items",
      existingIdeaContext || "No existing factory ideas yet.",
      "",
      "Factory rule: prefer improving or branching from existing evolvable ideas when new knowledge changes their evidence, scope, or action path. Generate fewer but more durable ideas.",
    ].join("\n")
    const topicSeeds = await generateThemeItems(runId, llmConfig, factoryPurpose, seeds)
    const themeIdeas = await Promise.all(
      topicSeeds.slice(0, 4).flatMap((theme) =>
        (["bridge", "contradiction", "timeline"] as InspirationStrategy[]).map((strategy) =>
          generateIdeaItems(runId, llmConfig, theme.title, strategy, factoryPurpose, seeds.slice(0, 48)),
        ),
      ),
    )
    candidates = themeIdeas.flat().map((item) => ({ ...item, origin: "factory" as const }))
  } else if (runType === "dream") {
    candidates = await generateDreamItem(runId, llmConfig, topic || "Dream replay", seeds)
  } else {
    const strategies: InspirationStrategy[] = ["bridge", "contradiction", "analogy", "timeline", "gap"]
    const batches = await Promise.all(strategies.map((strategy) => generateIdeaItems(runId, llmConfig, topic || "Untitled topic", strategy, purpose, seeds)))
    candidates = batches.flat().map((item) => ({ ...item, origin: "theme_lab" as const }))
  }

  const enrichedCandidates = candidates.map((item) => enrichFactoryLifecycle(item, triggerType, runType))
  const ranked = rankWithMmr(dedupInspirationItems(enrichedCandidates), runType === "daily" ? 14 : 10)

  run = { ...run, status: "saving" }
  callbacks.onRunUpdate?.(run)
  const dreamUntil = Date.now() + Math.max(60, config?.dreamMinDurationMinutes ?? 60) * 60_000
  const withDreamSession = ranked.map((item) =>
    item.type === "dream" && (runType === "dream" || runType === "daily")
      ? { ...item, dreamStartedAt: item.dreamStartedAt ?? Date.now(), dreamUntil, dreamStatus: "dreaming" as const }
      : item,
  )
  const saved = await saveInspirationItems(pp, withDreamSession, config)
  run = { ...run, status: "done", finishedAt: Date.now(), itemIds: saved.map((item) => item.id) }
  callbacks.onRunUpdate?.(run)
  return { run, items: saved }
}

export async function openInspirationMarkdown(item: InspirationItem): Promise<string> {
  return readFile(item.markdownPath)
}
