import {
  fileExists,
  readFile,
  writeFileAtomic,
} from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"
import { streamChat } from "@/lib/llm-client"
import {
  collectPaperCandidates,
  importCandidatePaper,
  type PaperCandidate,
  type PaperResearchConfig,
} from "@/lib/paper-research"
import type { LlmConfig } from "@/stores/wiki-store"
import type { WikiProject } from "@/types/wiki"
import { addLog } from "@/stores/log-store"

export interface PaperMonitorTopic {
  id: string
  query: string
  enabled: boolean
}

export interface PaperMonitorConfig {
  enabled: boolean
  topics: PaperMonitorTopic[]
  sources: ("arxiv" | "openalex" | "crossref")[]
  maxDailyPapers: number
  autoPushToKnowledge: boolean
  scheduledTime: string
}

export interface DailyScanEntry {
  date: string
  scannedAt: number
  topics: string[]
  paperCount: number
  papers: PaperCandidate[]
  importedIds: string[]
}

interface PaperMonitorDb {
  version: 1
  config: PaperMonitorConfig
  scans: DailyScanEntry[]
}

export const DEFAULT_PAPER_MONITOR_CONFIG: PaperMonitorConfig = {
  enabled: false,
  topics: [],
  sources: ["arxiv", "openalex", "crossref"],
  maxDailyPapers: 50,
  autoPushToKnowledge: false,
  scheduledTime: "09:00",
}

const DB_FILE = ".llm-wiki/paper-monitor-db.json"
const MAX_SCAN_HISTORY = 30

let scanTimer: ReturnType<typeof setTimeout> | null = null
let scanning = false

function msUntilNextScan(scheduledTime: string): number {
  const [h, m] = scheduledTime.split(":").map(Number)
  const now = new Date()
  const target = new Date(now)
  target.setHours(h, m, 0, 0)
  if (target.getTime() <= now.getTime()) {
    target.setDate(target.getDate() + 1)
  }
  return target.getTime() - now.getTime()
}

export async function triggerPaperMonitorScan(
  project: WikiProject,
  config: PaperMonitorConfig,
  llmConfig: LlmConfig,
): Promise<DailyScanEntry | null> {
  return runPaperMonitorScan(project.path, config, llmConfig)
}

export function startPaperMonitor(
  project: WikiProject,
  config: PaperMonitorConfig,
  llmConfig: LlmConfig,
): void {
  stopPaperMonitor()

  if (!config.enabled) return

  const scheduleNext = () => {
    const delay = msUntilNextScan(config.scheduledTime || "09:00")
    scanTimer = setTimeout(() => {
      runPaperMonitorScan(project.path, config, llmConfig)
      scheduleNext()
    }, delay)
  }

  scheduleNext()
}

function dbPath(projectPath: string): string {
  return `${normalizePath(projectPath)}/${DB_FILE}`
}

function todayIso(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
}

export async function loadPaperMonitorDb(projectPath: string): Promise<PaperMonitorDb | null> {
  const path = dbPath(projectPath)
  try {
    if (!(await fileExists(path))) return null
    const content = await readFile(path)
    const parsed = JSON.parse(content) as Partial<PaperMonitorDb>
    if (parsed.version !== 1) return null
    if (!parsed.config) return null
    return parsed as PaperMonitorDb
  } catch {
    return null
  }
}

async function savePaperMonitorDb(projectPath: string, db: PaperMonitorDb): Promise<void> {
  await writeFileAtomic(dbPath(projectPath), JSON.stringify(db, null, 2))
}

export async function loadPaperMonitorConfig(projectPath: string): Promise<PaperMonitorConfig> {
  const db = await loadPaperMonitorDb(projectPath)
  return db?.config ?? { ...DEFAULT_PAPER_MONITOR_CONFIG }
}

export async function savePaperMonitorConfig(
  projectPath: string,
  config: PaperMonitorConfig,
): Promise<void> {
  const db = (await loadPaperMonitorDb(projectPath)) ?? {
    version: 1 as const,
    config: { ...DEFAULT_PAPER_MONITOR_CONFIG },
    scans: [],
  }
  db.config = config
  await savePaperMonitorDb(projectPath, db)
}

export async function loadDailyScans(projectPath: string): Promise<DailyScanEntry[]> {
  const db = await loadPaperMonitorDb(projectPath)
  return db?.scans ?? []
}

export async function runPaperMonitorScan(
  projectPath: string,
  config: PaperMonitorConfig,
  llmConfig: LlmConfig,
): Promise<DailyScanEntry | null> {
  if (scanning) return null
  scanning = true

  try {
    const activeTopics = config.topics.filter((t) => t.enabled)
    if (activeTopics.length === 0) return null

    const candidatesPerTopic = Math.max(1, Math.floor(config.maxDailyPapers / activeTopics.length))

    // Collect per topic
    const perTopicResults: PaperCandidate[][] = []
    for (const topic of activeTopics) {
      const { candidates } = await collectPaperCandidates(
        topic.query,
        llmConfig,
        candidatesPerTopic,
      )
      perTopicResults.push(candidates)
    }

    // Deduplicate globally, preserving per-topic grouping
    const seen = new Set<string>()
    const dedupedPerTopic: PaperCandidate[][] = perTopicResults.map((results) => {
      const deduped: PaperCandidate[] = []
      for (const c of results) {
        const key = c.doi ?? c.arxivId ?? c.id
        if (seen.has(key)) continue
        seen.add(key)
        deduped.push(c)
      }
      return deduped
    })

    // Round-robin select to balance across topics
    const balanced: PaperCandidate[] = []
    const pointers = new Array(dedupedPerTopic.length).fill(0)
    while (balanced.length < config.maxDailyPapers) {
      let added = false
      for (let i = 0; i < dedupedPerTopic.length && balanced.length < config.maxDailyPapers; i++) {
        if (pointers[i] < dedupedPerTopic[i].length) {
          balanced.push(dedupedPerTopic[i][pointers[i]++])
          added = true
        }
      }
      if (!added) break
    }

    const today = todayIso()

    const db = (await loadPaperMonitorDb(projectPath)) ?? {
      version: 1 as const,
      config,
      scans: [],
    }
    const existingEntry = db.scans?.find((s) => s.date === today)
    const entry: DailyScanEntry = {
      date: today,
      scannedAt: Date.now(),
      topics: activeTopics.map((t) => t.query),
      paperCount: balanced.length,
      papers: balanced,
      importedIds: existingEntry?.importedIds ?? [],
    }
    const existing = db.scans.findIndex((s) => s.date === today)
    if (existing >= 0) {
      db.scans[existing] = entry
    } else {
      db.scans.unshift(entry)
      db.scans = db.scans.slice(0, MAX_SCAN_HISTORY)
    }
    await savePaperMonitorDb(projectPath, db)

    const topicNames = activeTopics.map((t) => t.query).join(", ")
    addLog(
      "论文监控扫描完成",
      `主题: ${topicNames}\n发现 ${balanced.length} 篇论文${balanced.length > 0 ? `\n已保存到每日扫描结果` : ""}`,
    )

    if (config.autoPushToKnowledge) {
      void autoPushPapers(projectPath, entry, llmConfig)
    }

    return entry
  } catch (err) {
    addLog(
      "论文监控扫描失败",
      `错误: ${err instanceof Error ? err.message : String(err)}`,
    )
    return null
  } finally {
    scanning = false
  }
}

async function autoPushPapers(
  projectPath: string,
  entry: DailyScanEntry,
  llmConfig: LlmConfig,
): Promise<void> {
  const { openProject } = await import("@/commands/fs")
  const paperConfig: PaperResearchConfig = {
    autoAnalyzeOnImport: true,
    importDestination: "papers",
    literatureQueryCount: 3,
  }
  try {
    const project = await openProject(projectPath)
    for (const paper of entry.papers) {
      if (entry.importedIds.includes(paper.id)) continue
      try {
        await importCandidatePaper(project, paper, llmConfig, paperConfig, { forceAnalyze: true })
        entry.importedIds.push(paper.id)
        await persistImportedIds(projectPath, entry.date, [paper.id])
        addLog(
          "论文自动入库",
          `已导入: ${paper.title}`,
        )
      } catch (err) {
        addLog(
          "论文自动导入失败",
          `论文: ${paper.title}\n错误: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }
  } catch (err) {
    console.warn("[paper-monitor] Failed to open project for auto-push:", err)
  }
}

async function persistImportedIds(
  projectPath: string,
  date: string,
  importedIds: string[],
): Promise<void> {
  const db = await loadPaperMonitorDb(projectPath)
  if (!db) return
  const scan = db.scans.find((s) => s.date === date)
  if (scan) {
    const existing = new Set(scan.importedIds)
    for (const id of importedIds) existing.add(id)
    scan.importedIds = [...existing]
  }
  await savePaperMonitorDb(projectPath, db)
}

export async function manualPushPaper(
  project: WikiProject,
  paper: PaperCandidate,
  llmConfig: LlmConfig,
  scanDate: string,
): Promise<void> {
  const paperConfig: PaperResearchConfig = {
    autoAnalyzeOnImport: true,
    importDestination: "papers",
    literatureQueryCount: 3,
  }
  await importCandidatePaper(project, paper, llmConfig, paperConfig, { forceAnalyze: true })
  await persistImportedIds(project.path, scanDate, [paper.id])
}

export function stopPaperMonitor(): void {
  if (scanTimer) {
    clearTimeout(scanTimer)
    scanTimer = null
  }
}

export async function recommendMonitorTopics(
  topic: string,
  llmConfig: LlmConfig,
): Promise<string[]> {
  const prompt = `You are a research librarian helping a scientist set up daily paper monitoring.

Given a research topic, generate 3-5 specific, well-formed search queries optimized for academic paper search APIs (arXiv, OpenAlex, Crossref). Each query should:
- Cover a different angle or sub-topic of the research area
- Use precise technical terminology
- Be concise (under 100 characters)
- Be ready to paste directly into a search API

Output format: one query per line. No numbering, no bullets, no extra commentary.

Research topic: ${topic.trim()}`

  let result = ""
  try {
    await streamChat(
      llmConfig,
      [{ role: "user", content: prompt }],
      {
        onToken: (token) => { result += token },
        onDone: () => {},
        onError: () => {},
      },
      undefined,
      { temperature: 0.3, reasoning: { mode: "off" }, max_tokens: 512 },
    )
  } catch {
    return []
  }
  return result
    .split("\n")
    .map((line) => line.replace(/^[\s•\-*\d.]+\s*/, "").trim())
    .filter((line) => line.length > 3 && line.length < 200)
}
