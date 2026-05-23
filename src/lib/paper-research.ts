import {
  copyFile,
  createDirectory,
  fileExists,
  listDirectory,
  preprocessFile,
  writeBinaryFile,
  writeFile,
} from "@/commands/fs"
import { enqueueSourceIngest } from "@/lib/source-lifecycle"
import { getFileName, normalizePath } from "@/lib/path-utils"
import { getHttpFetch } from "@/lib/tauri-fetch"
import { streamChat } from "@/lib/llm-client"
import type { LlmConfig } from "@/stores/wiki-store"
import type { FileNode, WikiProject } from "@/types/wiki"

export interface PaperResearchConfig {
  autoAnalyzeOnImport: boolean
  importDestination: "papers" | "sources"
  literatureQueryCount: number
}

export interface PaperCandidate {
  id: string
  title: string
  abstract: string
  authors: string[]
  year?: number
  publishedDate?: string
  venue?: string
  arxivId?: string
  arxivUrl?: string
  pdfUrl?: string
  s2PaperId?: string
  citationCount?: number
  influentialCitationCount?: number
  tldr?: string
  doi?: string
  openAlexId?: string
  source: "arxiv" | "openalex" | "crossref" | "semantic_scholar" | "deepxiv"
  score: number
  signals: string[]
}

interface PaperSearchWindow {
  from: Date
  to: Date
  fromIso: string
  toIso: string
  fromArxiv: string
  toArxiv: string
}

export const DEFAULT_PAPER_RESEARCH_CONFIG: PaperResearchConfig = {
  autoAnalyzeOnImport: true,
  importDestination: "papers",
  literatureQueryCount: 3,
}

export async function ensurePaperResearchFolders(projectPath: string): Promise<void> {
  const root = normalizePath(projectPath)
  await createDirectory(`${root}/raw`)
  await createDirectory(`${root}/raw/papers`)
  await createDirectory(`${root}/raw/tmp`)
  await createDirectory(`${root}/raw/discovered`)
  await createDirectory(`${root}/wiki`)
  await createDirectory(`${root}/wiki/papers`)
  await createDirectory(`${root}/wiki/methods`)
  await createDirectory(`${root}/wiki/concepts`)
}

export async function listResearchPapers(
  projectPath: string,
  config: PaperResearchConfig = DEFAULT_PAPER_RESEARCH_CONFIG,
): Promise<FileNode[]> {
  const dir = paperResearchSourceDir(projectPath, config)
  if (!(await fileExists(dir))) return []
  return flattenResearchFiles(await listDirectory(dir))
}

export async function rewriteSearchQuery(
  query: string,
  llmConfig: LlmConfig,
): Promise<string> {
  const prompt = `You are a research librarian helping a scientist search for academic papers.
Rewrite the user's search query to maximize recall and precision across arXiv, OpenAlex, and Crossref APIs.

Rules:
- If the user's query is in Chinese (or any non-English language), translate it into English and expand with standard academic terminology.
- If the query is already in English, expand it with synonyms, related concepts, and standard field-specific terminology.
- Remove noise words (like "please find", "I want papers about", "search for").
- Output ONLY the rewritten search query string — no explanation, no markdown, no quotes.
- Optimize for keyword-based academic search engines (not semantic/vector search).

User query: ${query}`

  let rewritten = ""
  try {
    await streamChat(
      llmConfig,
      [
        { role: "user", content: prompt },
      ],
      {
        onToken: (token) => { rewritten += token },
        onDone: () => {},
        onError: () => {},
      },
      undefined,
      { temperature: 0.1, reasoning: { mode: "off" }, max_tokens: 256 },
    )
  } catch {
    return query
  }
  const cleaned = rewritten.trim()
  return cleaned.length > 0 ? cleaned : query
}

export async function collectPaperCandidates(
  query: string,
  llmConfig: LlmConfig,
  limit = 12,
): Promise<{ candidates: PaperCandidate[]; notes: string[]; rewrittenQuery: string }> {
  const notes: string[] = []

  let searchQuery = query.trim()
  try {
    searchQuery = await rewriteSearchQuery(query, llmConfig)
    if (searchQuery !== query) {
      notes.push(`Query rewritten: "${searchQuery}"`)
    }
  } catch {
    notes.push("Query rewriting failed, using original query")
  }

  const window = paperSearchWindow()
  const perSourceLimit = Math.max(4, Math.min(25, limit))
  const [arxiv, openAlex, crossref] = await Promise.all([
    searchArxiv(searchQuery, limit, window).catch((err) => {
      notes.push(`arXiv unavailable: ${err instanceof Error ? err.message : String(err)}`)
      return [] as PaperCandidate[]
    }),
    searchOpenAlex(searchQuery, perSourceLimit, window).catch((err) => {
      notes.push(`OpenAlex unavailable: ${err instanceof Error ? err.message : String(err)}`)
      return [] as PaperCandidate[]
    }),
    searchCrossref(searchQuery, perSourceLimit, window).catch((err) => {
      notes.push(`Crossref unavailable: ${err instanceof Error ? err.message : String(err)}`)
      return [] as PaperCandidate[]
    }),
  ])

  const merged = mergeCandidates([...arxiv, ...openAlex, ...crossref])
    .filter((candidate) => isWithinSearchWindow(candidate, window))
    .sort(compareByDateDesc)
    .slice(0, 200)
  if (merged.length === 0 && notes.length === 0) {
    notes.push("No papers found from arXiv, OpenAlex, or Crossref. Try a broader English query or a specific method/paper title.")
  }
  return { candidates: merged, notes, rewrittenQuery: searchQuery }
}

export async function importCandidatePaper(
  project: WikiProject,
  candidate: PaperCandidate,
  llmConfig: LlmConfig,
  config: PaperResearchConfig,
): Promise<string[]> {
  const root = normalizePath(project.path)
  await ensurePaperResearchFolders(root)
  const baseDir = paperResearchSourceDir(root, config)
  await createDirectory(baseDir)

  let importedPath: string
  if (candidate.pdfUrl) {
    importedPath = await downloadCandidatePdf(baseDir, candidate)
    preprocessFile(importedPath).catch(() => {})
  } else {
    importedPath = await writeCandidateMetadata(baseDir, candidate)
  }

  if (config.autoAnalyzeOnImport) {
    await analyzeResearchPapers(project, [importedPath], llmConfig, config)
  }
  return [importedPath]
}

export async function importResearchPapers(
  project: WikiProject,
  paths: string[],
  llmConfig: LlmConfig,
  config: PaperResearchConfig,
): Promise<string[]> {
  const root = normalizePath(project.path)
  await ensurePaperResearchFolders(root)
  const baseDir = paperResearchSourceDir(root, config)
  await createDirectory(baseDir)

  const imported: string[] = []
  for (const sourcePath of paths) {
    const fileName = getFileName(sourcePath) || "paper.pdf"
    const destPath = await uniquePath(baseDir, fileName)
    await copyFile(sourcePath, destPath)
    imported.push(destPath)
    preprocessFile(destPath).catch(() => {})
  }

  if (config.autoAnalyzeOnImport) {
    await analyzeResearchPapers(project, imported, llmConfig, config)
  }
  return imported
}

export async function analyzeResearchPapers(
  project: WikiProject,
  paperPaths: string[],
  llmConfig: LlmConfig,
  config: PaperResearchConfig,
): Promise<string[]> {
  const root = normalizePath(project.path)
  const sourceRoot = paperResearchSourceDir(root, config)
  return enqueueSourceIngest(project, paperPaths, llmConfig, {
    sourceRoot,
    rootContext: "Paper Research",
  })
}

function paperResearchSourceDir(projectPath: string, config: PaperResearchConfig): string {
  const root = normalizePath(projectPath)
  return config.importDestination === "sources"
    ? `${root}/raw/sources`
    : `${root}/raw/papers`
}

async function searchArxiv(query: string, limit: number, window: PaperSearchWindow): Promise<PaperCandidate[]> {
  const url = new URL("https://export.arxiv.org/api/query")
  url.searchParams.set("search_query", `all:${query} AND submittedDate:[${window.fromArxiv}0000 TO ${window.toArxiv}2359]`)
  url.searchParams.set("start", "0")
  url.searchParams.set("max_results", String(Math.max(1, Math.min(50, limit))))
  url.searchParams.set("sortBy", "relevance")
  url.searchParams.set("sortOrder", "descending")
  const httpFetch = await getHttpFetch()
  const res = await httpFetch(url.toString(), { headers: { Accept: "application/atom+xml,text/xml" } })
  if (!res.ok) throw new Error(`${res.status} ${await res.text().catch(() => res.statusText)}`)
  const xml = await res.text()
  const doc = new DOMParser().parseFromString(xml, "application/xml")
  return [...doc.querySelectorAll("entry")].map((entry, index) => {
    const title = text(entry, "title").replace(/\s+/g, " ").trim()
    const abstract = text(entry, "summary").trim()
    const idUrl = text(entry, "id").trim()
    const arxivId = extractArxivId(idUrl)
    const authors = [...entry.querySelectorAll("author > name")].map((n) => n.textContent?.trim() ?? "").filter(Boolean)
    const pdfUrl = [...entry.querySelectorAll("link")]
      .map((link) => link.getAttribute("href") ?? "")
      .find((href) => href.includes("/pdf/")) ?? (arxivId ? `https://arxiv.org/pdf/${arxivId}.pdf` : undefined)
    const publishedDate = (text(entry, "published") || "").slice(0, 10) || undefined
    const year = Number((publishedDate || "").slice(0, 4)) || undefined
    return {
      id: arxivId ? `arxiv:${arxivId}` : `arxiv:${title}`,
      title,
      abstract,
      authors,
      year,
      publishedDate,
      arxivId,
      arxivUrl: arxivId ? `https://arxiv.org/abs/${arxivId}` : idUrl,
      pdfUrl,
      source: "arxiv" as const,
      score: 0.72 - index * 0.006,
      signals: ["arXiv relevance"],
    }
  }).filter((c) => c.title)
}

async function searchOpenAlex(query: string, limit: number, window: PaperSearchWindow): Promise<PaperCandidate[]> {
  const url = new URL("https://api.openalex.org/works")
  url.searchParams.set("search", query)
  url.searchParams.set("per-page", String(Math.max(1, Math.min(50, limit))))
  url.searchParams.set("filter", `from_publication_date:${window.fromIso},to_publication_date:${window.toIso}`)
  url.searchParams.set("sort", "relevance_score:desc")
  const httpFetch = await getHttpFetch()
  const res = await httpFetch(url.toString(), { headers: { Accept: "application/json" } })
  if (!res.ok) throw new Error(`${res.status} ${await res.text().catch(() => res.statusText)}`)
  const data = await res.json()
  return ((data.results ?? []) as unknown[])
    .map((item, index) => normalizeOpenAlexCandidate(item, index))
    .filter(Boolean) as PaperCandidate[]
}

async function searchCrossref(query: string, limit: number, window: PaperSearchWindow): Promise<PaperCandidate[]> {
  const url = new URL("https://api.crossref.org/works")
  url.searchParams.set("query", query)
  url.searchParams.set("rows", String(Math.max(1, Math.min(50, limit))))
  url.searchParams.set("select", "DOI,title,abstract,author,published-print,published-online,container-title,is-referenced-by-count,URL,link,type")
  url.searchParams.set("filter", `from-pub-date:${window.fromIso},until-pub-date:${window.toIso}`)
  url.searchParams.set("sort", "score")
  url.searchParams.set("order", "desc")
  const httpFetch = await getHttpFetch()
  const res = await httpFetch(url.toString(), { headers: { Accept: "application/json" } })
  if (!res.ok) throw new Error(`${res.status} ${await res.text().catch(() => res.statusText)}`)
  const data = await res.json()
  return ((data.message?.items ?? []) as unknown[])
    .map((item, index) => normalizeCrossrefCandidate(item, index))
    .filter(Boolean) as PaperCandidate[]
}

function normalizeOpenAlexCandidate(item: unknown, index: number): PaperCandidate | null {
  const r = item as {
    id?: string
    doi?: string
    title?: string
    display_name?: string
    publication_year?: number
    publication_date?: string
    cited_by_count?: number
    relevance_score?: number
    abstract_inverted_index?: Record<string, number[]>
    primary_location?: { landing_page_url?: string; pdf_url?: string; source?: { display_name?: string } }
    authorships?: { author?: { display_name?: string } }[]
    ids?: { doi?: string }
  }
  const title = r.title || r.display_name || ""
  if (!title) return null
  const doi = normalizeDoi(r.doi || r.ids?.doi)
  const arxivId = extractArxivIdFromDoiOrUrl(doi) || extractArxivIdFromDoiOrUrl(r.primary_location?.landing_page_url)
  const citationCount = r.cited_by_count ?? 0
  const openAlexScore = typeof r.relevance_score === "number" ? Math.min(0.22, r.relevance_score / 35000) : 0
  return {
    id: arxivId ? `arxiv:${arxivId}` : r.id || doi || `openalex:${title}`,
    title,
    abstract: abstractFromOpenAlexIndex(r.abstract_inverted_index),
    authors: (r.authorships ?? []).map((a) => a.author?.display_name ?? "").filter(Boolean),
    year: r.publication_year,
    publishedDate: r.publication_date,
    venue: r.primary_location?.source?.display_name,
    arxivId,
    arxivUrl: arxivId ? `https://arxiv.org/abs/${arxivId}` : undefined,
    pdfUrl: r.primary_location?.pdf_url || (arxivId ? `https://arxiv.org/pdf/${arxivId}.pdf` : undefined),
    citationCount,
    doi,
    openAlexId: r.id,
    source: "openalex",
    score: 0.76 + openAlexScore + Math.min(0.18, Math.log10(citationCount + 1) / 10) - index * 0.002,
    signals: [
      "OpenAlex relevance",
      citationCount ? `${citationCount} citations` : "",
      arxivId ? "arXiv linked" : "",
      doi ? "DOI" : "",
    ].filter(Boolean),
  }
}

function normalizeCrossrefCandidate(item: unknown, index: number): PaperCandidate | null {
  const r = item as {
    DOI?: string
    title?: string[]
    abstract?: string
    author?: { given?: string; family?: string }[]
    "published-print"?: { "date-parts"?: number[][] }
    "published-online"?: { "date-parts"?: number[][] }
    "container-title"?: string[]
    "is-referenced-by-count"?: number
    URL?: string
    link?: { URL?: string; "content-type"?: string }[]
    type?: string
  }
  const title = r.title?.[0] ?? ""
  if (!title) return null
  const doi = normalizeDoi(r.DOI)
  const arxivId = extractArxivIdFromDoiOrUrl(doi) || extractArxivIdFromDoiOrUrl(r.URL)
  const dateParts = r["published-online"]?.["date-parts"]?.[0] ?? r["published-print"]?.["date-parts"]?.[0]
  const publishedDate = datePartsToIso(dateParts)
  const year = dateParts?.[0]
  const citationCount = r["is-referenced-by-count"] ?? 0
  const pdfUrl = r.link?.find((link) => link["content-type"]?.includes("pdf"))?.URL
  return {
    id: arxivId ? `arxiv:${arxivId}` : doi ? `doi:${doi}` : `crossref:${title}`,
    title,
    abstract: stripHtml(r.abstract ?? ""),
    authors: (r.author ?? []).map((a) => [a.given, a.family].filter(Boolean).join(" ")).filter(Boolean),
    year,
    publishedDate,
    venue: r["container-title"]?.[0],
    arxivId,
    arxivUrl: arxivId ? `https://arxiv.org/abs/${arxivId}` : undefined,
    pdfUrl: pdfUrl || (arxivId ? `https://arxiv.org/pdf/${arxivId}.pdf` : undefined),
    citationCount,
    doi,
    source: "crossref",
    score: 0.58 + Math.min(0.18, Math.log10(citationCount + 1) / 10) - index * 0.002,
    signals: [
      "Crossref relevance",
      citationCount ? `${citationCount} references` : "",
      r.type ? r.type : "",
      doi ? "DOI" : "",
    ].filter(Boolean),
  }
}

function mergeCandidates(candidates: PaperCandidate[]): PaperCandidate[] {
  const merged: PaperCandidate[] = []
  const byArxiv = new Map<string, number>()
  const byDoi = new Map<string, number>()

  for (const candidate of candidates) {
    let matchIndex = -1

    if (candidate.arxivId) {
      const key = candidate.arxivId.toLowerCase()
      const idx = byArxiv.get(key)
      if (idx !== undefined) matchIndex = idx
    }
    if (matchIndex < 0 && candidate.doi) {
      const key = candidate.doi.toLowerCase()
      const idx = byDoi.get(key)
      if (idx !== undefined) matchIndex = idx
    }
    if (matchIndex < 0) {
      matchIndex = merged.findIndex(
        (m) => m.title.toLowerCase() === candidate.title.toLowerCase(),
      )
    }

    if (matchIndex >= 0) {
      const existing = merged[matchIndex]
      const updated: PaperCandidate = {
        ...existing,
        ...candidate,
        abstract: existing.abstract || candidate.abstract,
        authors: existing.authors.length ? existing.authors : candidate.authors,
        arxivId: existing.arxivId || candidate.arxivId,
        arxivUrl: existing.arxivUrl || candidate.arxivUrl,
        pdfUrl: existing.pdfUrl || candidate.pdfUrl,
        doi: existing.doi || candidate.doi,
        openAlexId: existing.openAlexId || candidate.openAlexId,
        publishedDate: latestDate(existing.publishedDate, candidate.publishedDate),
        year: Math.max(existing.year ?? 0, candidate.year ?? 0) || undefined,
        citationCount: Math.max(existing.citationCount ?? 0, candidate.citationCount ?? 0) || undefined,
        score: Math.max(existing.score, candidate.score) + 0.08,
        signals: [...new Set([...existing.signals, ...candidate.signals, candidate.source])],
      }
      merged[matchIndex] = updated
      if (updated.arxivId && !existing.arxivId) {
        byArxiv.set(updated.arxivId.toLowerCase(), matchIndex)
      }
      if (updated.doi && !existing.doi) {
        byDoi.set(updated.doi.toLowerCase(), matchIndex)
      }
    } else {
      const index = merged.length
      merged.push(candidate)
      if (candidate.arxivId) {
        byArxiv.set(candidate.arxivId.toLowerCase(), index)
      }
      if (candidate.doi) {
        byDoi.set(candidate.doi.toLowerCase(), index)
      }
    }
  }

  return merged
}

function compareByDateDesc(a: PaperCandidate, b: PaperCandidate): number {
  const dateDiff = dateMs(b) - dateMs(a)
  if (dateDiff !== 0) return dateDiff
  return (b.citationCount ?? 0) - (a.citationCount ?? 0)
}

function dateMs(candidate: PaperCandidate): number {
  if (candidate.publishedDate) {
    const ms = Date.parse(candidate.publishedDate)
    if (Number.isFinite(ms)) return ms
  }
  return candidate.year ? Date.UTC(candidate.year, 0, 1) : 0
}

function isWithinSearchWindow(candidate: PaperCandidate, window: PaperSearchWindow): boolean {
  const ms = dateMs(candidate)
  return ms >= window.from.getTime() && ms <= window.to.getTime()
}

function paperSearchWindow(now = new Date()): PaperSearchWindow {
  const to = new Date(now)
  to.setHours(23, 59, 59, 999)
  const from = new Date(to)
  from.setFullYear(from.getFullYear() - 1)
  from.setHours(0, 0, 0, 0)
  return {
    from,
    to,
    fromIso: isoDate(from),
    toIso: isoDate(to),
    fromArxiv: arxivDate(from),
    toArxiv: arxivDate(to),
  }
}

function isoDate(date: Date): string {
  const year = String(date.getFullYear()).padStart(4, "0")
  const month = String(date.getMonth() + 1).padStart(2, "0")
  const day = String(date.getDate()).padStart(2, "0")
  return `${year}-${month}-${day}`
}

function arxivDate(date: Date): string {
  return isoDate(date).replace(/-/g, "")
}

function latestDate(a: string | undefined, b: string | undefined): string | undefined {
  if (!a) return b
  if (!b) return a
  return Date.parse(b) > Date.parse(a) ? b : a
}

function datePartsToIso(parts: number[] | undefined): string | undefined {
  if (!parts?.[0]) return undefined
  const year = String(parts[0]).padStart(4, "0")
  const month = String(parts[1] ?? 1).padStart(2, "0")
  const day = String(parts[2] ?? 1).padStart(2, "0")
  return `${year}-${month}-${day}`
}

async function downloadCandidatePdf(dir: string, candidate: PaperCandidate): Promise<string> {
  if (!candidate.pdfUrl) throw new Error("Candidate has no PDF URL")
  const httpFetch = await getHttpFetch()
  const res = await httpFetch(candidate.pdfUrl, { headers: { Accept: "application/pdf,*/*" } })
  if (!res.ok) throw new Error(`PDF download failed (${res.status})`)
  const bytes = new Uint8Array(await res.arrayBuffer())
  const fileName = `${slugify(candidate.title || candidate.arxivId || "paper")}.pdf`
  const path = await uniquePath(dir, fileName)
  await writeBinaryFile(path, bytes)
  return path
}

async function writeCandidateMetadata(dir: string, candidate: PaperCandidate): Promise<string> {
  const fileName = `${slugify(candidate.title || candidate.s2PaperId || "paper")}.md`
  const path = await uniquePath(dir, fileName)
  const content = [
    "---",
    `title: "${candidate.title.replace(/"/g, '\\"')}"`,
    candidate.arxivId ? `arxiv: "${candidate.arxivId}"` : "",
    candidate.s2PaperId ? `s2_id: "${candidate.s2PaperId}"` : "",
    candidate.doi ? `doi: "${candidate.doi}"` : "",
    candidate.openAlexId ? `openalex: "${candidate.openAlexId}"` : "",
    candidate.year ? `year: ${candidate.year}` : "",
    "---",
    "",
    `# ${candidate.title}`,
    "",
    candidate.tldr ? `## TLDR\n\n${candidate.tldr}\n` : "",
    "## Abstract",
    "",
    candidate.abstract || "_No abstract available._",
    "",
    "## Metadata",
    "",
    `- Authors: ${candidate.authors.join(", ") || "Unknown"}`,
    `- Venue: ${candidate.venue || "Unknown"}`,
    `- Source: ${candidate.source}`,
    candidate.arxivUrl ? `- arXiv: ${candidate.arxivUrl}` : "",
    candidate.doi ? `- DOI: ${candidate.doi}` : "",
    "",
  ].filter(Boolean).join("\n")
  await writeFile(path, content)
  return path
}

function extractArxivId(value: string): string | undefined {
  const raw = value.trim().split("/").pop()?.replace(/v\d+$/i, "")
  return raw || undefined
}

function extractArxivIdFromDoiOrUrl(value: string | undefined): string | undefined {
  if (!value) return undefined
  const match = value.match(/(?:arxiv[.:/]|arxiv\.org\/(?:abs|pdf)\/)(\d{4}\.\d{4,5})(?:v\d+)?/i)
  return match?.[1]
}

function normalizeDoi(value: string | undefined): string | undefined {
  if (!value) return undefined
  return value.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "").trim() || undefined
}

function abstractFromOpenAlexIndex(index: Record<string, number[]> | undefined): string {
  if (!index) return ""
  const words: string[] = []
  for (const [word, positions] of Object.entries(index)) {
    for (const position of positions) words[position] = word
  }
  return words.filter(Boolean).join(" ")
}

function stripHtml(value: string): string {
  return value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()
}

function text(parent: Element, selector: string): string {
  return parent.querySelector(selector)?.textContent ?? ""
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "paper"
}

function flattenResearchFiles(nodes: FileNode[]): FileNode[] {
  const out: FileNode[] = []
  for (const node of nodes) {
    if (node.is_dir) {
      out.push(...flattenResearchFiles(node.children ?? []))
    } else if (isPaperResearchFile(node.name)) {
      out.push(node)
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

function isPaperResearchFile(name: string): boolean {
  const ext = name.split(".").pop()?.toLowerCase()
  return ext === "pdf" || ext === "tex" || ext === "md" || ext === "txt"
}

async function uniquePath(dir: string, fileName: string): Promise<string> {
  const safeName = fileName.replace(/[<>:"|?*\x00-\x1f]/g, "_")
  const dot = safeName.lastIndexOf(".")
  const stem = dot > 0 ? safeName.slice(0, dot) : safeName
  const ext = dot > 0 ? safeName.slice(dot) : ""
  let candidate = `${dir}/${safeName}`
  let i = 1
  while (await fileExists(candidate)) {
    candidate = `${dir}/${stem}-${i}${ext}`
    i += 1
  }
  return candidate
}
