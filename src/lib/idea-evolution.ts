import { readFile, writeFile } from "@/commands/fs"
import { hasUsableLlm } from "@/lib/has-usable-llm"
import { streamChat } from "@/lib/llm-client"
import { loadInspirationSnapshot, saveInspirationSnapshot } from "@/lib/inspiration-persist"
import { collectInspirationSeeds } from "@/lib/theme-mining"
import { addLog } from "@/stores/log-store"
import type { IdeaStage, IdeaTaskType, InspirationItem, InspirationSnapshot } from "@/lib/inspiration-schema"
import type { LlmConfig } from "@/stores/wiki-store"

function pickEvolvableItems(snapshot: InspirationSnapshot, limit = 4, itemIds?: string[]): InspirationItem[] {
  const idSet = itemIds ? new Set(itemIds) : null
  return snapshot.items
    .filter((item) =>
      (!idSet || idSet.has(item.id)) &&
      item.type !== "dream" &&
      item.reviewState !== "rejected" &&
      item.reviewState !== "formal" &&
      item.ideaStage !== "archived" &&
      item.ideaStage !== "adopted" &&
      item.markdownPath,
    )
    .sort((a, b) => {
      const ae = a.lastEvolvedAt ?? a.updatedAt ?? a.createdAt
      const be = b.lastEvolvedAt ?? b.updatedAt ?? b.createdAt
      if (ae !== be) return ae - be
      return (a.evolutionCount ?? 0) - (b.evolutionCount ?? 0)
    })
    .slice(0, limit)
}

async function llmEvolutionNote(
  item: InspirationItem,
  markdown: string,
  userComments: string[],
  knowledgeContext: string,
  llmConfig: LlmConfig,
): Promise<string> {
  if (!hasUsableLlm(llmConfig)) {
    return [
      "## Evolution Note",
      "- Re-read the evidence trail and turn the strongest next action into a smaller validation step.",
      "- Compare this idea with any newer wiki pages before promoting it to the formal idea library.",
    ].join("\n")
  }

  let output = ""
  await streamChat(
    llmConfig,
    [
      {
        role: "system",
        content: [
          "You evolve an existing evidence-grounded idea without overwriting the user's text.",
          "This can be an idea or a theme. Use broad existing wiki knowledge and graph-neighbor evidence.",
          "Treat this as an Idea Factory pipeline step: structure, expand, score, validate, or mature the idea depending on its current stage.",
          "Return a compact Markdown section only.",
          "Include: stage decision, deeper framing, graph/knowledge connections, validation or maturity gap, next step, and risk or falsification check.",
          "Do not restate the entire item.",
        ].join("\n"),
      },
      {
        role: "user",
        content: [
          `Item type: ${item.type}`,
          `Title: ${item.title}`,
          `Current stage: ${item.ideaStage ?? "candidate"}`,
          `Maturity level: ${item.maturityLevel ?? 2}`,
          `Version: ${item.version ?? 1}`,
          `Current summary: ${item.summary}`,
          "",
          "User commentary to respect as feedback, critique, or preference. Do not rewrite the idea directly from these notes; use them to guide evolution:",
          userComments.length > 0 ? userComments.map((comment, index) => `${index + 1}. ${comment}`).join("\n") : "(No user commentary yet.)",
          "",
          "Broad wiki / knowledge graph context:",
          knowledgeContext,
          "",
          "Current markdown:",
          markdown.slice(0, 12000),
        ].join("\n"),
      },
    ],
    {
      onToken: (token) => { output += token },
      onDone: () => {},
      onError: (error) => { throw error },
    },
    undefined,
    { temperature: 0.65 },
  )
  return output.trim() || "- No evolution generated."
}

function appendEvolution(markdown: string, note: string, timestamp: string): string {
  const section = [
    "",
    "## Evolution Log",
    "",
    `### ${timestamp}`,
    "",
    note.trim(),
    "",
  ].join("\n")

  if (!markdown.includes("## Evolution Log")) {
    return markdown.trimEnd() + "\n" + section
  }
  return markdown.replace("## Evolution Log", section.trimEnd() + "\n\n## Evolution Log")
}

function stageMaturity(stage: IdeaStage): number {
  if (stage === "seed") return 1
  if (stage === "candidate") return 2
  if (stage === "incubating") return 3
  if (stage === "validated") return 4
  if (stage === "mature" || stage === "adopted") return 5
  return 0
}

function nextFactoryStage(item: InspirationItem, nextCount: number, hasComments: boolean, evidenceCount: number): IdeaStage {
  const current = item.ideaStage ?? (item.type === "theme" ? "candidate" : "candidate")
  if (current === "adopted" || current === "archived" || current === "mature") return current
  if (current === "seed") return "candidate"
  if (current === "candidate") {
    return item.scores.final >= 0.7 || hasComments || nextCount >= 1 ? "incubating" : "candidate"
  }
  if (current === "incubating") {
    return evidenceCount >= 2 && (hasComments || nextCount >= 2) ? "validated" : "incubating"
  }
  if (current === "validated") {
    return nextCount >= 3 || item.scores.final >= 0.84 ? "mature" : "validated"
  }
  return current
}

function taskForStage(stage: IdeaStage): IdeaTaskType {
  if (stage === "seed") return "structure"
  if (stage === "candidate") return "expand"
  if (stage === "incubating") return "validate"
  if (stage === "validated") return "mature"
  return "score"
}

function summarizeChanges(note: string): string[] {
  const lines = note
    .split("\n")
    .map((line) => line.replace(/^#{1,6}\s*/, "").replace(/^[-*]\s*/, "").trim())
    .filter(Boolean)
    .filter((line) => !/^evolution note$/i.test(line))
  return lines.slice(0, 5)
}

function patchFrontmatter(
  markdown: string,
  updatedIso: string,
  count: number,
  version: number,
  stage: IdeaStage,
  taskType: IdeaTaskType,
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
  fm = setKey(fm, "updated_at", updatedIso)
  fm = setKey(fm, "last_evolved_at", updatedIso)
  fm = setKey(fm, "evolution_count", String(count))
  fm = setKey(fm, "version", String(version))
  fm = setKey(fm, "idea_stage", stage)
  fm = setKey(fm, "maturity_level", String(stageMaturity(stage)))
  fm = setKey(fm, "last_task_type", taskType)
  return fm + body
}

export async function evolveIdeas(
  projectPath: string,
  llmConfig: LlmConfig,
  limit = 4,
  itemIds?: string[],
): Promise<InspirationSnapshot> {
  const snapshot = await loadInspirationSnapshot(projectPath)
  const selected = pickEvolvableItems(snapshot, limit, itemIds)
  if (selected.length === 0) return snapshot

  const evolvedIds = new Map<string, InspirationItem>()

  for (const item of selected) {
    let markdown = ""
    try {
      markdown = await readFile(item.markdownPath)
    } catch {
      continue
    }
    const now = Date.now()
    const updatedIso = new Date(now).toISOString()
    const nextCount = (item.evolutionCount ?? 0) + 1
    const nextVersion = Math.max(item.version ?? 1, 1) + 1
    const userComments = (snapshot.comments ?? [])
      .filter((comment) => comment.itemId === item.id)
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((comment) => comment.body)
    const seeds = await collectInspirationSeeds(projectPath, item.title, 120).catch(() => [])
    const knowledgeContext = seeds
      .map((seed, index) => `[${index + 1}] ${seed.title} (type=${seed.type}; community=${seed.community}; links=${seed.linkCount})\n${seed.snippet}`)
      .join("\n\n")
      .slice(0, 24000)
    const note = await llmEvolutionNote(item, markdown, userComments, knowledgeContext, llmConfig).catch(() =>
      [
        "- Evolution skipped the model call and added a lightweight reflection.",
        "- Re-check the evidence trail, then rewrite the next action as a testable task.",
      ].join("\n"),
    )
    const nextStage = nextFactoryStage(item, nextCount, userComments.length > 0, item.evidence?.length ?? 0)
    const taskType = taskForStage(item.ideaStage ?? "candidate")
    const nextMarkdown = patchFrontmatter(appendEvolution(markdown, note, updatedIso), updatedIso, nextCount, nextVersion, nextStage, taskType)
    await writeFile(item.markdownPath, nextMarkdown)
    const event = {
      id: `${item.id}-evolution-${nextCount}`,
      itemId: item.id,
      iteration: nextCount,
      title: `${item.title} v${nextVersion}`,
      summary: `stage: ${item.ideaStage ?? "candidate"} -> ${nextStage}; task: ${taskType}`,
      changeType: taskType === "validate" ? "validate" as const : taskType === "mature" ? "mature" as const : taskType === "structure" ? "structure" as const : "expand" as const,
      changedAt: now,
      updatedBy: "LLM" as const,
      stage: nextStage,
      taskType,
      keyChanges: summarizeChanges(note),
      details: note,
      evidenceChain: (item.evidence ?? []).slice(0, 6),
      score: item.scores.final,
    }
    evolvedIds.set(item.id, {
      ...item,
      ideaStage: nextStage,
      maturityLevel: stageMaturity(nextStage),
      version: nextVersion,
      lastTaskType: taskType,
      updatedAt: now,
      lastEvolvedAt: now,
      evolutionCount: nextCount,
      lifecycleStatus: "done",
      evolutionEvents: [...(item.evolutionEvents ?? []), event],
    })
  }

  const next = {
    ...snapshot,
    items: snapshot.items.map((item) => evolvedIds.get(item.id) ?? item),
  }
  await saveInspirationSnapshot(projectPath, next)
  addLog(
    "灵思妙想演进完成",
    `已演进 ${evolvedIds.size} 个主题/idea：${[...evolvedIds.values()].map((item) => item.title).join("、") || "无"}`,
  )
  return next
}

export async function evolveInspirationItem(
  projectPath: string,
  llmConfig: LlmConfig,
  itemId: string,
): Promise<InspirationSnapshot> {
  return evolveIdeas(projectPath, llmConfig, 1, [itemId])
}
