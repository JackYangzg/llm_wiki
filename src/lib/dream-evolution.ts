import { readFile, writeFile } from "@/commands/fs"
import { hasUsableLlm } from "@/lib/has-usable-llm"
import { streamChat } from "@/lib/llm-client"
import { loadInspirationSnapshot, saveInspirationSnapshot } from "@/lib/inspiration-persist"
import { collectInspirationSeeds } from "@/lib/theme-mining"
import { addLog } from "@/stores/log-store"
import type { DreamFragment, DreamFragmentType, DreamInsight, DreamInsightType, DreamMode, DreamOutput, InspirationItem, InspirationSnapshot } from "@/lib/inspiration-schema"
import type { LlmConfig } from "@/stores/wiki-store"

interface DreamEvolutionResult {
  title: string
  summary: string
  note: string
  dreamMode?: DreamMode
  fragments: DreamFragment[]
  insights: DreamInsight[]
  outputs: DreamOutput[]
  dreamScore?: number
}

function summarizeDreamChanges(result: DreamEvolutionResult, converging: boolean): string[] {
  const lines = [
    converging ? "收敛归纳梦境，提炼最终结论与下一步任务。" : "继续扩散梦境路径，并更新醒后复盘。",
    ...result.fragments.slice(0, 2).map((fragment) => `${fragment.type}: ${fragment.title}`),
    ...result.insights.slice(0, 2).map((insight) => `${insight.type}: ${insight.content}`),
    ...result.outputs.slice(0, 1).map((output) => `${output.outputType}: ${output.title}`),
  ]
  return lines.map((line) => line.trim()).filter(Boolean).slice(0, 6)
}

function parseScore(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.min(1, value > 1 ? value / 100 : value))
    : fallback
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

interface ContinueDreamOptions {
  maxIterations?: number
  itemIds?: string[]
  forceConverge?: boolean
  allowBeyondLimit?: boolean
}

function activeDreams(snapshot: InspirationSnapshot, options: ContinueDreamOptions = {}): InspirationItem[] {
  const idSet = options.itemIds ? new Set(options.itemIds) : null
  const maxIterations = Math.max(1, Math.min(20, Math.floor(options.maxIterations ?? 3)))
  return snapshot.items
    .filter((item) =>
      (!idSet || idSet.has(item.id)) &&
      item.type === "dream" &&
      item.reviewState !== "rejected" &&
      item.reviewState !== "formal" &&
      (options.forceConverge || options.allowBeyondLimit || item.dreamStatus !== "done") &&
      (options.forceConverge || options.allowBeyondLimit || (item.evolutionCount ?? 0) < maxIterations) &&
      !!item.markdownPath,
    )
    .sort((a, b) => (a.lastEvolvedAt ?? a.createdAt) - (b.lastEvolvedAt ?? b.createdAt))
}

function parseDreamResult(output: string, item: InspirationItem, nextCount: number): DreamEvolutionResult {
  const fenced = output.match(/```(?:json)?\s*([\s\S]*?)```/)
  const jsonText = fenced ? fenced[1] : output
  try {
    const parsed = JSON.parse(jsonText) as Partial<DreamEvolutionResult> & Record<string, unknown>
    const fragments: DreamFragment[] = Array.isArray(parsed.fragments)
      ? parsed.fragments.slice(0, 10).map((fragment, index) => {
        const f = fragment as unknown as Record<string, unknown>
        return {
          id: `${item.id}-fragment-${nextCount}-${index + 1}`,
          type: asDreamFragmentType(f.type),
          title: String(f.title ?? `Dream fragment ${nextCount}.${index + 1}`),
          content: String(f.content ?? ""),
          relatedEntities: stringArray(f.relatedEntities),
          sourceMaterialIds: stringArray(f.sourceMaterialIds),
          imaginationLevel: parseScore(f.imaginationLevel, 0.76),
          relevanceScore: parseScore(f.relevanceScore, 0.68),
        }
      })
      : []
    const insights: DreamInsight[] = Array.isArray(parsed.insights)
      ? parsed.insights.slice(0, 8).map((insight, index) => {
        const it = insight as unknown as Record<string, unknown>
        return {
          id: `${item.id}-insight-${nextCount}-${index + 1}`,
          type: asDreamInsightType(it.type),
          content: String(it.content ?? ""),
          sourceFragmentIds: stringArray(it.sourceFragmentIds),
          valueScore: parseScore(it.valueScore, 0.72),
          convertStatus: "candidate",
        }
      })
      : []
    const outputs: DreamOutput[] = Array.isArray(parsed.outputs)
      ? parsed.outputs.slice(0, 8).map((outputItem, index) => {
        const out = outputItem as unknown as Record<string, unknown>
        const outputType = String(out.outputType ?? "idea") as DreamOutput["outputType"]
        return {
          id: `${item.id}-output-${nextCount}-${index + 1}`,
          outputType,
          title: String(out.title ?? `Dream output ${nextCount}.${index + 1}`),
          content: String(out.content ?? ""),
          targetSystem: out.targetSystem === "idea_factory" || out.targetSystem === "deep_research" || out.targetSystem === "wiki"
            ? out.targetSystem
            : undefined,
        }
      })
      : []
    return {
      title: String(parsed.title || `${item.title} · 梦境第 ${nextCount} 层`),
      summary: String(parsed.summary || item.summary),
      note: String(parsed.note || output),
      dreamMode: asDreamMode(parsed.dreamMode ?? item.dreamMode),
      fragments,
      insights,
      outputs,
      dreamScore: parseScore(parsed.dreamScore, item.dreamScore ?? 0.7),
    }
  } catch {
    return {
      title: `${item.title} · 梦境第 ${nextCount} 层`,
      summary: output.split("\n").map((line) => line.replace(/^[-#*\s]+/, "").trim()).filter(Boolean).slice(0, 2).join(" ") || item.summary,
      note: output,
      dreamMode: item.dreamMode,
      fragments: [{
        id: `${item.id}-fragment-${nextCount}-1`,
        type: "strange_connection",
        title: `梦境第 ${nextCount} 层`,
        content: output,
        relatedEntities: item.relatedEntities ?? [],
        sourceMaterialIds: [],
        imaginationLevel: 0.7,
        relevanceScore: 0.62,
      }],
      insights: [],
      outputs: [],
      dreamScore: item.dreamScore,
    }
  }
}

async function dreamStep(
  item: InspirationItem,
  markdown: string,
  knowledgeContext: string,
  converging: boolean,
  nextCount: number,
  llmConfig: LlmConfig,
): Promise<DreamEvolutionResult> {
  if (!hasUsableLlm(llmConfig)) {
    const note = [
      "- 扩散：沿着证据轨迹寻找一个更远的相邻主题。",
      "- 支撑：把这次跳转改写成一个可验证的知识假设。",
      "- 收敛候选：保留一个可以变成产品或丰满知识条目的核心命题。",
    ].join("\n")
    return {
      title: `${item.title} · 梦境第 ${nextCount} 层`,
      summary: "梦境继续沿知识图谱扩散，并沉淀出一个更接近产品或完整知识条目的收敛候选。",
      note,
      dreamMode: item.dreamMode ?? "free_association",
      fragments: [{
        id: `${item.id}-fragment-${nextCount}-1`,
        type: "strange_connection",
        title: `梦境第 ${nextCount} 层`,
        content: note,
        relatedEntities: item.relatedEntities ?? [],
        sourceMaterialIds: [],
        imaginationLevel: 0.68,
        relevanceScore: 0.62,
      }],
      insights: [],
      outputs: [],
      dreamScore: item.dreamScore ?? 0.68,
    }
  }

  let output = ""
  await streamChat(
    llmConfig,
    [
      {
        role: "system",
        content: [
          "You are continuing a long-running traceable knowledge dream.",
          converging
            ? "This is a convergence pass. Summarize the full dream, resolve the fragments, and produce final conclusions, useful ideas, solution sketches, hypotheses, knowledge gaps, and next tasks."
            : "Each step should expand the dream, add logical support, and move slightly toward convergence.",
          "Use broad wiki context and graph-neighbor evidence. Do not limit yourself to the original evidence list.",
          "Return strict JSON only.",
          "Shape: {\"title\":\"new dream title\",\"summary\":\"updated concise summary\",\"dreamMode\":\"free_association|future|counterfactual|metaphor|conflict|roleplay|gap_fill|solution_evolution\",\"note\":\"compact Markdown with Diffusion, Support, Convergence Candidate, Evidence Hooks, Wake Review, Dream-born Outputs\",\"fragments\":[{\"type\":\"scene|metaphor|conflict|transformation|future|dialogue|strange_connection|question_mutation|solution_variant\",\"title\":\"string\",\"content\":\"string\",\"relatedEntities\":[\"string\"],\"sourceMaterialIds\":[\"string\"],\"imaginationLevel\":0.8,\"relevanceScore\":0.7}],\"insights\":[{\"type\":\"product_opportunity|research_hypothesis|workflow|knowledge_gap|solution|task\",\"content\":\"string\",\"sourceFragmentIds\":[\"string\"],\"valueScore\":0.8}],\"outputs\":[{\"outputType\":\"idea|solution|hypothesis|knowledge_gap|task|report\",\"title\":\"string\",\"content\":\"string\",\"targetSystem\":\"idea_factory|deep_research|wiki\"}],\"dreamScore\":0.75}.",
          "The title must evolve every iteration and reflect the newest convergence direction.",
          "The summary must replace the card description with the newest insight.",
          "First diverge through fragments, then perform wake-up review and extract useful outputs.",
          "Do not overwrite previous dream content.",
        ].join("\n"),
      },
      {
        role: "user",
        content: [
          `Dream title: ${item.title}`,
          `Dream summary: ${item.summary}`,
          `Dream mode: ${item.dreamMode ?? "free_association"}`,
          `Next iteration: ${nextCount}`,
          "",
          "Existing dream fragments:",
          (item.dreamFragments ?? []).slice(-8).map((fragment) => `- ${fragment.id} / ${fragment.type}: ${fragment.title} — ${fragment.content}`).join("\n") || "(none)",
          "",
          "Existing wake insights:",
          (item.dreamInsights ?? []).slice(-8).map((insight) => `- ${insight.id} / ${insight.type}: ${insight.content}`).join("\n") || "(none)",
          "",
          "Existing dream-born outputs:",
          (item.dreamOutputs ?? []).slice(-8).map((output) => `- ${output.id} / ${output.outputType}: ${output.title} — ${output.content}`).join("\n") || "(none)",
          "",
          "Broad wiki / knowledge graph context:",
          knowledgeContext,
          "",
          "Existing dream markdown:",
          markdown.slice(0, 14000),
        ].join("\n"),
      },
    ],
    {
      onToken: (token) => { output += token },
      onDone: () => {},
      onError: (error) => { throw error },
    },
    undefined,
    { temperature: 0.8 },
  )
  return parseDreamResult(output.trim() || "- Dream step produced no content.", item, nextCount)
}

function appendDreamStep(markdown: string, note: string, timestamp: string): string {
  const block = [
    "",
    "## Dream Continuation",
    "",
    `### ${timestamp}`,
    "",
    note.trim(),
    "",
  ].join("\n")
  if (!markdown.includes("## Dream Continuation")) {
    return markdown.trimEnd() + "\n" + block
  }
  return markdown.replace("## Dream Continuation", `${block.trimEnd()}\n\n## Dream Continuation`)
}

function appendFinalConclusion(markdown: string, note: string, timestamp: string): string {
  const block = [
    "",
    "## Final Dream Conclusion",
    "",
    `### ${timestamp}`,
    "",
    note.trim(),
    "",
  ].join("\n")
  if (!markdown.includes("## Final Dream Conclusion")) {
    return markdown.trimEnd() + "\n" + block
  }
  return markdown.replace("## Final Dream Conclusion", `${block.trimEnd()}\n\n## Final Dream Conclusion`)
}

function yamlString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, " ")}"`
}

function replaceHeadingAndSummary(markdown: string, title: string, summary: string): string {
  const end = markdown.startsWith("---") ? markdown.indexOf("\n---", 3) : -1
  const fmEnd = end >= 0 ? end + 4 : 0
  const head = markdown.slice(0, fmEnd)
  let body = markdown.slice(fmEnd)
  if (/^# .+$/m.test(body)) {
    body = body.replace(/^# .+$/m, `# ${title}`)
  } else {
    body = `\n# ${title}\n\n${body.trimStart()}`
  }
  const headingMatch = /^# .+$/m.exec(body)
  if (!headingMatch) return head + body
  const afterHeading = body.indexOf("\n", headingMatch.index)
  if (afterHeading < 0) return head + body
  const before = body.slice(0, afterHeading + 1)
  const rest = body.slice(afterHeading + 1)
  const nextRest = rest.replace(/^\s*[\s\S]*?(?=\n## |\n# |$)/, `\n${summary}\n`)
  return head + before + nextRest
}

function patchFrontmatter(
  markdown: string,
  title: string,
  summary: string,
  updatedIso: string,
  count: number,
  status: string,
  mode: DreamMode | undefined,
  dreamScore: number | undefined,
): string {
  if (!markdown.startsWith("---")) return markdown
  const end = markdown.indexOf("\n---", 3)
  if (end < 0) return markdown
  let fm = markdown.slice(0, end + 4)
  const body = markdown.slice(end + 4)
  const setKey = (source: string, key: string, value: string) => {
    const re = new RegExp(`^${key}:.*$`, "m")
    return re.test(source) ? source.replace(re, `${key}: ${value}`) : source.replace(/\n---$/, `\n${key}: ${value}\n---`)
  }
  fm = setKey(fm, "title", yamlString(title))
  fm = setKey(fm, "summary", yamlString(summary))
  fm = setKey(fm, "updated_at", updatedIso)
  fm = setKey(fm, "last_evolved_at", updatedIso)
  fm = setKey(fm, "evolution_count", String(count))
  fm = setKey(fm, "dream_status", status)
  if (mode) fm = setKey(fm, "dream_mode", mode)
  if (typeof dreamScore === "number") fm = setKey(fm, "dream_score", String(Number(dreamScore.toFixed(3))))
  return fm + body
}

export async function continueDreams(
  projectPath: string,
  llmConfig: LlmConfig,
  options: ContinueDreamOptions = {},
): Promise<InspirationSnapshot> {
  const snapshot = await loadInspirationSnapshot(projectPath)
  const now = Date.now()
  const maxIterations = Math.max(1, Math.min(20, Math.floor(options.maxIterations ?? 3)))
  const selected = activeDreams(snapshot, options).slice(0, options.itemIds ? options.itemIds.length : 2)
  if (selected.length === 0) return snapshot

  const evolved = new Map<string, InspirationItem>()
  for (const item of selected) {
    let markdown = ""
    try {
      markdown = await readFile(item.markdownPath)
    } catch {
      continue
    }
    const timestamp = new Date().toISOString()
    const nextCount = (item.evolutionCount ?? 0) + 1
    const reachedIterationLimit = !options.allowBeyondLimit && nextCount >= maxIterations
    const reachedTimeLimit = !options.allowBeyondLimit && now >= (item.dreamUntil ?? Number.POSITIVE_INFINITY)
    const converging = !!options.forceConverge || reachedIterationLimit || reachedTimeLimit
    const status = converging ? "done" : (now + 60_000 >= (item.dreamUntil ?? now) ? "converging" : "dreaming")
    const seeds = await collectInspirationSeeds(projectPath, item.title, 140).catch(() => [])
    const knowledgeContext = seeds
      .map((seed, index) => `[${index + 1}] ${seed.title} (type=${seed.type}; community=${seed.community}; links=${seed.linkCount})\n${seed.snippet}`)
      .join("\n\n")
      .slice(0, 28000)
    const result = await dreamStep(item, markdown, knowledgeContext, converging, nextCount, llmConfig).catch(() => ({
      title: `${item.title} · 梦境第 ${nextCount} 层`,
      summary: "梦境演进遇到模型异常，本轮保留原证据路径，并继续识别一个可收敛的候选方向。",
      note: "- Dream step failed softly; keep expanding from the strongest evidence path and identify one convergence candidate.",
      dreamMode: item.dreamMode,
      fragments: [],
      insights: [],
      outputs: [],
      dreamScore: item.dreamScore,
    }))
    const appended = status === "done"
      ? appendFinalConclusion(markdown, result.note, timestamp)
      : appendDreamStep(markdown, result.note, timestamp)
    const nextMarkdown = patchFrontmatter(
      replaceHeadingAndSummary(appended, result.title, result.summary),
      result.title,
      result.summary,
      timestamp,
      nextCount,
      status,
      result.dreamMode,
      result.dreamScore,
    )
    await writeFile(item.markdownPath, nextMarkdown)
    const event = {
      id: `${item.id}-dream-${nextCount}`,
      itemId: item.id,
      iteration: nextCount,
      title: result.title,
      summary: result.summary,
      changeType: status === "done" ? "conclude" as const : "dream" as const,
      changedAt: now,
      updatedBy: "LLM" as const,
      dreamStatus: status as InspirationItem["dreamStatus"],
      keyChanges: summarizeDreamChanges(result, converging),
      details: result.note,
      evidenceChain: (item.evidence ?? []).slice(0, 6),
      score: result.dreamScore ?? item.dreamScore,
    }
    evolved.set(item.id, {
      ...item,
      title: result.title,
      summary: result.summary,
      dreamMode: result.dreamMode ?? item.dreamMode,
      dreamFragments: [...(item.dreamFragments ?? []), ...result.fragments].slice(-40),
      dreamInsights: [...(item.dreamInsights ?? []), ...result.insights].slice(-30),
      dreamOutputs: [...(item.dreamOutputs ?? []), ...result.outputs].slice(-30),
      dreamScore: result.dreamScore ?? item.dreamScore,
      updatedAt: now,
      lastEvolvedAt: now,
      evolutionCount: nextCount,
      dreamStatus: status as InspirationItem["dreamStatus"],
      evolutionEvents: [...(item.evolutionEvents ?? []), event],
    })
  }

  const next = {
    ...snapshot,
    items: snapshot.items.map((item) => evolved.get(item.id) ?? item),
  }
  await saveInspirationSnapshot(projectPath, next)
  addLog(
    "梦境演进完成",
    `已推进 ${evolved.size} 个梦境：${[...evolved.values()].map((item) => `${item.title}（${item.dreamStatus}）`).join("、") || "无"}`,
  )
  return next
}
