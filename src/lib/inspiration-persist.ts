import { createDirectory, deleteFile, fileExists, listDirectory, readFile, writeFile } from "@/commands/fs"
import type {
  InspirationEvidence,
  InspirationFeedback,
  InspirationComment,
  InspirationAskMessage,
  InspirationItem,
  InspirationRun,
  InspirationSnapshot,
  IdeaStage,
} from "@/lib/inspiration-schema"
import type { InspirationConfig } from "@/stores/wiki-store"
import { EMPTY_INSPIRATION_SNAPSHOT } from "@/lib/inspiration-schema"
import { enrichCreativeMetadata } from "@/lib/creative-pipeline"
import { removePageEmbedding } from "@/lib/embedding"
import { getFileStem, joinPath, normalizePath } from "@/lib/path-utils"
import type { FileNode } from "@/types/wiki"

const META_PATH = ".llm-wiki/inspiration.json"
const REJECTED_IDEAS_DIR = ".llm-wiki/rejected-ideas"

function todaySlug(date = new Date()): string {
  return date.toISOString().slice(0, 10)
}

export function inspirationMetaPath(projectPath: string): string {
  return joinPath(normalizePath(projectPath), META_PATH)
}

export async function ensureInspirationDirs(projectPath: string, ideasPath = "wiki/ideas"): Promise<void> {
  const pp = normalizePath(projectPath)
  const dirs = [
    ".llm-wiki",
    REJECTED_IDEAS_DIR,
    `${REJECTED_IDEAS_DIR}/idea`,
    `${REJECTED_IDEAS_DIR}/theme`,
    `${REJECTED_IDEAS_DIR}/dream`,
    ideasPath,
    "wiki/inspirations",
    "wiki/inspirations/daily",
    "wiki/inspirations/themes",
    "wiki/inspirations/dreams",
  ]
  for (const dir of dirs) {
    await createDirectory(joinPath(pp, dir)).catch(() => {})
  }
}

export async function loadInspirationSnapshot(projectPath: string): Promise<InspirationSnapshot> {
  await ensureInspirationDirs(projectPath)
  try {
    const raw = await readFile(inspirationMetaPath(projectPath))
    const parsed = JSON.parse(raw) as Partial<InspirationSnapshot>
    const items = Array.isArray(parsed.items) ? parsed.items : []
    return {
      runs: Array.isArray(parsed.runs) ? parsed.runs : [],
      items: items.map(normalizeItem),
      feedback: Array.isArray(parsed.feedback) ? parsed.feedback : [],
      comments: Array.isArray(parsed.comments) ? parsed.comments : [],
      askMessages: Array.isArray(parsed.askMessages) ? parsed.askMessages : [],
    }
  } catch {
    return EMPTY_INSPIRATION_SNAPSHOT
  }
}

export async function loadInspirationAskMessages(
  projectPath: string,
  itemId: string,
): Promise<InspirationAskMessage[]> {
  const snapshot = await loadInspirationSnapshot(projectPath)
  return (snapshot.askMessages ?? [])
    .filter((message) => message.itemId === itemId)
    .sort((a, b) => a.createdAt - b.createdAt)
}

export async function saveInspirationAskMessages(
  projectPath: string,
  itemId: string,
  messages: InspirationAskMessage[],
): Promise<InspirationSnapshot> {
  const snapshot = await loadInspirationSnapshot(projectPath)
  const otherMessages = (snapshot.askMessages ?? []).filter((message) => message.itemId !== itemId)
  const itemMessages = messages
    .filter((message) => message.itemId === itemId)
    .sort((a, b) => a.createdAt - b.createdAt)
    .slice(-80)
  const next = {
    ...snapshot,
    askMessages: [...otherMessages, ...itemMessages].slice(-4000),
  }
  await saveInspirationSnapshot(projectPath, next)
  return next
}

function normalizeItem(item: InspirationItem): InspirationItem {
  const createdAt = item.createdAt ?? Date.now()
  const reviewState = item.reviewState ?? "new"
  const type = item.type ?? "idea"
  const ideaStage = normalizeIdeaStage(item.ideaStage, reviewState, type)
  return enrichCreativeMetadata({
    ...item,
    origin: item.origin ?? (
      reviewState === "formal"
        ? "adopted"
        : type === "dream"
          ? "dream"
          : type === "theme"
            ? "theme_lab"
            : "factory"
    ),
    reviewState,
    ideaStage,
    maturityLevel: item.maturityLevel ?? stageMaturity(ideaStage),
    version: item.version ?? Math.max(1, (item.evolutionCount ?? 0) + 1),
    sourceKnowledgeIds: Array.isArray(item.sourceKnowledgeIds) ? item.sourceKnowledgeIds : (item.evidence ?? []).map((e) => e.pagePath),
    relatedEntities: Array.isArray(item.relatedEntities) ? item.relatedEntities : [],
    reasoningPath: Array.isArray(item.reasoningPath) ? item.reasoningPath : [],
    reactivationReasons: Array.isArray(item.reactivationReasons) ? item.reactivationReasons : [],
    mergedFrom: Array.isArray(item.mergedFrom) ? item.mergedFrom : [],
    dreamMaterials: Array.isArray(item.dreamMaterials) ? item.dreamMaterials : [],
    dreamFragments: Array.isArray(item.dreamFragments) ? item.dreamFragments : [],
    dreamInsights: Array.isArray(item.dreamInsights) ? item.dreamInsights : [],
    dreamOutputs: Array.isArray(item.dreamOutputs) ? item.dreamOutputs : [],
    dreamScore: typeof item.dreamScore === "number" ? item.dreamScore : undefined,
    evolutionEvents: Array.isArray(item.evolutionEvents) ? item.evolutionEvents : [],
    enteredAt: item.enteredAt ?? createdAt,
    updatedAt: item.updatedAt ?? createdAt,
    evolutionCount: item.evolutionCount ?? 0,
    lifecycleStatus: item.lifecycleStatus ?? "idle",
  })
}

function normalizeIdeaStage(
  stage: IdeaStage | undefined,
  reviewState: InspirationItem["reviewState"],
  type: InspirationItem["type"],
): IdeaStage {
  if (reviewState === "formal") return "adopted"
  if (reviewState === "rejected") return "archived"
  if (stage) return stage
  if (type === "dream") return "incubating"
  if (type === "theme") return "candidate"
  return "candidate"
}

function stageMaturity(stage: IdeaStage): number {
  if (stage === "seed") return 1
  if (stage === "candidate") return 2
  if (stage === "incubating") return 3
  if (stage === "validated") return 4
  if (stage === "mature" || stage === "adopted") return 5
  return 0
}

export async function saveInspirationSnapshot(
  projectPath: string,
  snapshot: InspirationSnapshot,
): Promise<void> {
  await ensureInspirationDirs(projectPath)
  await writeFile(inspirationMetaPath(projectPath), JSON.stringify(snapshot, null, 2))
}

function slugifyTitle(title: string): string {
  const ascii = title
    .toLowerCase()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
    .replace(/^-+|-+$/g, "")
  return ascii.slice(0, 64) || `inspiration-${Date.now()}`
}

function yamlString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, " ")}"`
}

function evidenceFrontmatter(evidence: InspirationEvidence[]): string {
  if (evidence.length === 0) return "evidence_pages: []"
  return [
    "evidence_pages:",
    ...evidence.map((e) => {
      const normalized = normalizePath(e.pagePath)
      const marker = "/wiki/"
      const relative = normalized.includes(marker)
        ? `wiki/${normalized.split(marker)[1]}`
        : normalized
      return `  - ${yamlString(relative)}`
    }),
  ].join("\n")
}

function yamlArray(key: string, values: string[] | undefined): string {
  const normalized = (values ?? []).filter(Boolean)
  if (normalized.length === 0) return `${key}: []`
  return [
    `${key}:`,
    ...normalized.map((value) => `  - ${yamlString(value)}`),
  ].join("\n")
}

export function renderInspirationMarkdown(item: InspirationItem): string {
  const created = new Date(item.createdAt).toISOString()
  const entered = new Date(item.enteredAt ?? item.createdAt).toISOString()
  const updated = new Date(item.updatedAt ?? item.createdAt).toISOString()
  const evidenceLinks = item.evidence
    .map((e, i) => {
      const pageStem = e.pagePath.split("/").pop()?.replace(/\.md$/, "") ?? e.title
      return `${i + 1}. [[${pageStem}]] - ${e.role}: ${e.snippet}`
    })
    .join("\n")

  return [
    "---",
    `type: ${item.type === "theme" ? "theme_digest" : item.type === "dream" ? "dream_sequence" : "idea_card"}`,
    `origin: ${item.origin}`,
    `creative_type: ${item.creativeType ?? (item.type === "dream" ? "dream_idea" : item.type === "theme" ? "topic_idea" : "idea")}`,
    `source_factory: ${item.sourceFactory ?? (item.type === "dream" ? "dream_factory" : item.type === "theme" ? "theme_factory" : "idea_factory")}`,
    `title: ${yamlString(item.title)}`,
    `strategy: ${item.strategy}`,
    `run_id: ${item.runId}`,
    `created_at: ${created}`,
    `generated_at: ${created}`,
    `entered_at: ${entered}`,
    `updated_at: ${updated}`,
    item.lastEvolvedAt ? `last_evolved_at: ${new Date(item.lastEvolvedAt).toISOString()}` : "",
    `evolution_count: ${item.evolutionCount ?? 0}`,
    item.dreamStartedAt ? `dream_started_at: ${new Date(item.dreamStartedAt).toISOString()}` : "",
    item.dreamUntil ? `dream_until: ${new Date(item.dreamUntil).toISOString()}` : "",
    item.dreamStatus ? `dream_status: ${item.dreamStatus}` : "",
    item.dreamMode ? `dream_mode: ${item.dreamMode}` : "",
    typeof item.dreamScore === "number" ? `dream_score: ${item.dreamScore}` : "",
    `review_state: ${item.reviewState}`,
    `lifecycle_status: ${item.lifecycleStatus ?? "idle"}`,
    `idea_stage: ${item.ideaStage ?? normalizeIdeaStage(item.ideaStage, item.reviewState, item.type)}`,
    `maturity_level: ${item.maturityLevel ?? stageMaturity(normalizeIdeaStage(item.ideaStage, item.reviewState, item.type))}`,
    `version: ${item.version ?? Math.max(1, (item.evolutionCount ?? 0) + 1)}`,
    item.triggerType ? `trigger_type: ${item.triggerType}` : "",
    item.lastTaskType ? `last_task_type: ${item.lastTaskType}` : "",
    item.routingTarget ? `routing_target: ${item.routingTarget}` : "",
    item.routingReason ? `routing_reason: ${yamlString(item.routingReason)}` : "",
    `novelty_score: ${item.scores.novelty}`,
    `groundedness_score: ${item.scores.groundedness}`,
    `goal_fit_score: ${item.scores.goalFit}`,
    `actionability_score: ${item.scores.actionability}`,
    `diversity_score: ${item.scores.diversity}`,
    `final_score: ${item.scores.final}`,
    yamlArray("source_knowledge_ids", item.sourceKnowledgeIds ?? item.evidence.map((e) => e.pagePath)),
    yamlArray("related_entities", item.relatedEntities),
    yamlArray("reasoning_path", item.reasoningPath),
    yamlArray("methodologies", item.methodologies),
    yamlArray("critiques", item.critiques),
    yamlArray("knowledge_gaps", item.knowledgeGaps),
    yamlArray("next_tasks", item.nextTasks),
    yamlArray("dream_material_ids", item.dreamMaterials?.map((material) => material.id)),
    yamlArray("dream_fragment_ids", item.dreamFragments?.map((fragment) => fragment.id)),
    yamlArray("dream_insight_ids", item.dreamInsights?.map((insight) => insight.id)),
    yamlArray("dream_output_ids", item.dreamOutputs?.map((output) => output.id)),
    yamlArray("reactivation_reasons", item.reactivationReasons),
    yamlArray("merged_from", item.mergedFrom),
    evidenceFrontmatter(item.evidence),
    "---",
    "",
    `# ${item.title}`,
    "",
    item.summary,
    "",
    item.body,
    item.improvementSummary ? `\n## Improvement Summary\n\n${item.improvementSummary}` : "",
    item.critiques?.length ? `\n## Critique\n\n${item.critiques.map((critique) => `- ${critique}`).join("\n")}` : "",
    item.routingTarget ? `\n## Routing\n\n- Target: ${item.routingTarget}\n- Reason: ${item.routingReason ?? ""}` : "",
    item.knowledgeGaps?.length ? `\n## Knowledge Gaps\n\n${item.knowledgeGaps.map((gap) => `- ${gap}`).join("\n")}` : "",
    item.nextTasks?.length ? `\n## Next Tasks\n\n${item.nextTasks.map((task) => `- ${task}`).join("\n")}` : "",
    "",
    "## Evidence Trail",
    "",
    evidenceLinks || "- Evidence is currently sparse; treat this as a low-confidence association.",
  ].filter(Boolean).join("\n").trimEnd() + "\n"
}

export async function saveInspirationItems(
  projectPath: string,
  items: InspirationItem[],
  config?: Pick<InspirationConfig, "ideasPath">,
): Promise<InspirationItem[]> {
  const ideasPath = normalizePath(config?.ideasPath?.trim() || "wiki/ideas").replace(/^\/+/, "")
  await ensureInspirationDirs(projectPath, ideasPath)
  const pp = normalizePath(projectPath)
  const saved: InspirationItem[] = []

  for (const item of items) {
    const prefix = item.type === "theme" ? "theme" : item.type
    const now = Date.now()
    const fallbackCreatedAt = item.createdAt ?? now
    const markdownPath = item.markdownPath || (item.type === "idea"
      ? joinPath(pp, ideasPath, `${prefix}-${todaySlug(new Date(fallbackCreatedAt))}-${slugifyTitle(item.title)}.md`)
      : joinPath(
        pp,
        "wiki/inspirations",
        item.type === "theme" ? "themes" : "dreams",
        `${prefix}-${todaySlug(new Date(fallbackCreatedAt))}-${slugifyTitle(item.title)}.md`,
      ))
    const existingMarkdown = await fileExists(markdownPath)
      .then((exists) => (exists ? readFile(markdownPath) : ""))
      .catch(() => "")
    const existingCreatedAt = frontmatterDateMs(existingMarkdown, "created_at")
      ?? frontmatterDateMs(existingMarkdown, "generated_at")
    const existingEnteredAt = frontmatterDateMs(existingMarkdown, "entered_at")
    const withPath = enrichCreativeMetadata({
      ...item,
      markdownPath,
      createdAt: existingCreatedAt ?? fallbackCreatedAt,
      enteredAt: existingEnteredAt ?? item.enteredAt ?? existingCreatedAt ?? fallbackCreatedAt,
      updatedAt: item.updatedAt ?? existingCreatedAt ?? fallbackCreatedAt,
      evolutionCount: item.evolutionCount ?? 0,
    })
    await writeFile(markdownPath, renderInspirationMarkdown(withPath))
    saved.push(withPath)
  }

  await writeDailySummary(pp, saved)
  return saved
}

function frontmatterDateMs(markdown: string, key: string): number | undefined {
  if (!markdown.startsWith("---")) return undefined
  const end = markdown.indexOf("\n---", 3)
  if (end < 0) return undefined
  const match = markdown.slice(0, end).match(new RegExp(`^${key}:\\s*(.+)$`, "m"))
  const raw = match?.[1]?.trim().replace(/^["']|["']$/g, "")
  if (!raw) return undefined
  const parsed = Date.parse(raw)
  return Number.isFinite(parsed) ? parsed : undefined
}

async function writeDailySummary(projectPath: string, items: InspirationItem[]): Promise<void> {
  if (items.length === 0) return
  const date = todaySlug(new Date(items[0].createdAt))
  const dailyPath = joinPath(projectPath, "wiki/inspirations/daily", `${date}.md`)
  const existing = await fileExists(dailyPath).then((exists) => (exists ? readFile(dailyPath) : "")).catch(() => "")
  const rows = items
    .map((item) => {
      const stem = item.markdownPath.split("/").pop()?.replace(/\.md$/, "") ?? item.id
      return `- [[${stem}]] - ${item.type} / ${item.strategy}: ${item.summary}`
    })
    .join("\n")
  const header = [
    "---",
    "type: theme_digest",
    `title: ${yamlString(`Daily Inspiration ${date}`)}`,
    `generated_at: ${new Date(items[0].createdAt).toISOString()}`,
    `review_state: new`,
    "---",
    "",
    `# Daily Inspiration ${date}`,
    "",
  ].join("\n")
  const body = existing.trim()
    ? `${existing.trimEnd()}\n\n## Run ${items[0].runId}\n\n${rows}\n`
    : `${header}## Run ${items[0].runId}\n\n${rows}\n`
  await writeFile(dailyPath, body)
}

function flattenMd(nodes: FileNode[]): FileNode[] {
  const out: FileNode[] = []
  for (const node of nodes) {
    if (node.is_dir) out.push(...flattenMd(node.children ?? []))
    else if (node.name.endsWith(".md")) out.push(node)
  }
  return out
}

export async function listInspirationMarkdown(projectPath: string): Promise<FileNode[]> {
  try {
    const tree = await listDirectory(joinPath(normalizePath(projectPath), "wiki/inspirations"))
    return flattenMd(tree)
  } catch {
    return []
  }
}

export async function appendInspirationFeedback(
  projectPath: string,
  feedback: InspirationFeedback,
): Promise<InspirationSnapshot> {
  const snapshot = await loadInspirationSnapshot(projectPath)
  const target = snapshot.items.find((item) => item.id === feedback.itemId)
  if (target && feedback.action === "promote") {
    await patchFrontmatterFields(target.markdownPath, {
      review_state: "formal",
      origin: "adopted",
      idea_stage: "adopted",
    }, feedback.createdAt).catch(() => undefined)
  }
  if (target && (feedback.action === "unpromote" || feedback.action === "unsave")) {
    await patchFrontmatterFields(target.markdownPath, {
      review_state: "new",
      idea_stage: feedback.action === "unpromote" ? "incubating" : (target.ideaStage ?? "candidate"),
    }, feedback.createdAt).catch(() => {})
  }
  let archivedTarget: string | undefined
  if (target && feedback.action === "reject") {
    archivedTarget = await archiveRejectedInspirationItem(projectPath, target, {
      review_state: "rejected",
      lifecycle_status: "done",
      idea_stage: "archived",
    }, feedback.createdAt).catch(() => undefined)
  }
  const next = {
    ...snapshot,
    feedback: [feedback, ...snapshot.feedback].slice(0, 1000),
    items: snapshot.items.map((item) => {
      if (item.id !== feedback.itemId) return item
      if (feedback.action === "save") return { ...item, reviewState: "saved" as const, ideaStage: item.ideaStage === "seed" ? "candidate" as const : item.ideaStage, updatedAt: feedback.createdAt }
      if (feedback.action === "unsave") return { ...item, reviewState: "new" as const, updatedAt: feedback.createdAt }
      if (feedback.action === "promote") return { ...item, origin: "adopted" as const, reviewState: "formal" as const, ideaStage: "adopted" as const, maturityLevel: 5, updatedAt: feedback.createdAt }
      if (feedback.action === "unpromote") {
        const restoredOrigin = item.type === "dream" ? "dream" : item.type === "theme" ? "theme_lab" : "factory"
        return { ...item, origin: restoredOrigin as typeof item.origin, reviewState: "new" as const, ideaStage: "incubating" as const, maturityLevel: Math.max(3, item.maturityLevel ?? 3), updatedAt: feedback.createdAt }
      }
      if (feedback.action === "reject") return { ...item, markdownPath: archivedTarget ?? item.markdownPath, reviewState: "rejected" as const, ideaStage: "archived" as const, maturityLevel: 0, updatedAt: feedback.createdAt }
      return item
    }),
  }
  await saveInspirationSnapshot(projectPath, next)
  return next
}

export async function appendInspirationComment(
  projectPath: string,
  comment: InspirationComment,
): Promise<InspirationSnapshot> {
  const snapshot = await loadInspirationSnapshot(projectPath)
  const target = snapshot.items.find((item) => item.id === comment.itemId)
  if (target) {
    await appendCommentToMarkdown(target.markdownPath, comment).catch(() => {})
  }
  const next = {
    ...snapshot,
    comments: [comment, ...(snapshot.comments ?? [])].slice(0, 2000),
    items: snapshot.items.map((item) =>
      item.id === comment.itemId ? { ...item, updatedAt: comment.createdAt } : item,
    ),
  }
  await saveInspirationSnapshot(projectPath, next)
  return next
}

async function appendCommentToMarkdown(markdownPath: string, comment: InspirationComment): Promise<void> {
  if (!markdownPath) return
  const markdown = await readFile(markdownPath)
  const block = [
    "",
    "## User Commentary",
    "",
    `### ${new Date(comment.createdAt).toISOString()}`,
    "",
    comment.body.trim(),
    "",
  ].join("\n")
  const next = markdown.includes("## User Commentary")
    ? markdown.replace("## User Commentary", `${block.trimEnd()}\n\n## User Commentary`)
    : markdown.trimEnd() + "\n" + block
  await writeFile(markdownPath, next)
}

async function patchFrontmatterFields(markdownPath: string, fields: Record<string, string>, updatedAt: number): Promise<void> {
  if (!markdownPath) return
  const markdown = await readFile(markdownPath)
  if (!markdown.startsWith("---")) return
  const end = markdown.indexOf("\n---", 3)
  if (end < 0) return
  await writeFile(markdownPath, patchFrontmatterMarkdown(markdown, fields, updatedAt))
}

function patchFrontmatterMarkdown(markdown: string, fields: Record<string, string>, updatedAt: number): string {
  if (!markdown.startsWith("---")) return markdown
  const end = markdown.indexOf("\n---", 3)
  if (end < 0) return markdown
  let fm = markdown.slice(0, end + 4)
  const body = markdown.slice(end + 4)
  const setKey = (source: string, key: string, value: string) => {
    const re = new RegExp(`^${key}:.*$`, "m")
    return re.test(source) ? source.replace(re, `${key}: ${value}`) : source.replace(/\n---$/, `\n${key}: ${value}\n---`)
  }
  for (const [key, value] of Object.entries(fields)) {
    fm = setKey(fm, key, value)
  }
  fm = setKey(fm, "updated_at", new Date(updatedAt).toISOString())
  return fm + body
}

async function rejectedArchivePath(projectPath: string, item: InspirationItem): Promise<string> {
  const pp = normalizePath(projectPath)
  const typeDir = item.type === "theme" ? "theme" : item.type === "dream" ? "dream" : "idea"
  const dir = joinPath(pp, REJECTED_IDEAS_DIR, typeDir)
  await createDirectory(dir).catch(() => {})
  const fileName = item.markdownPath.split("/").pop() || `${item.id}.md`
  return uniqueArchivePath(dir, fileName)
}

async function uniqueArchivePath(dir: string, fileName: string): Promise<string> {
  const extIndex = fileName.lastIndexOf(".")
  const stem = extIndex > 0 ? fileName.slice(0, extIndex) : fileName
  const ext = extIndex > 0 ? fileName.slice(extIndex) : ".md"
  let candidate = joinPath(dir, fileName)
  let index = 2
  while (await fileExists(candidate).catch(() => false)) {
    candidate = joinPath(dir, `${stem}-${index}${ext}`)
    index++
  }
  return candidate
}

async function archiveRejectedInspirationItem(
  projectPath: string,
  item: InspirationItem,
  fields: Record<string, string>,
  updatedAt: number,
): Promise<string> {
  if (!item.markdownPath) return item.markdownPath
  const sourcePath = normalizePath(item.markdownPath)
  const archivePath = await rejectedArchivePath(projectPath, item)
  const markdown = await readFile(sourcePath)
  await writeFile(archivePath, patchFrontmatterMarkdown(markdown, {
    ...fields,
    archived_from: sourcePath,
  }, updatedAt))
  if (sourcePath.includes("/wiki/")) {
    await deleteFile(sourcePath)
    const slug = getFileStem(sourcePath)
    if (slug) await removePageEmbedding(projectPath, slug)
  }
  return archivePath
}

export function upsertRun(snapshot: InspirationSnapshot, run: InspirationRun): InspirationSnapshot {
  return {
    ...snapshot,
    runs: [run, ...snapshot.runs.filter((r) => r.id !== run.id)].slice(0, 100),
  }
}
