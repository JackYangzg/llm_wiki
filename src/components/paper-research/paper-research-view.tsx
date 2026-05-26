import { useCallback, useEffect, useMemo, useState } from "react"
import { open } from "@tauri-apps/plugin-dialog"
import {
  BookOpen,
  CalendarDays,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  FileText,
  Loader2,
  RefreshCw,
  Search,
  Send,
  Sparkles,
  Upload,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { useTranslation } from "react-i18next"
import { readFile, listDirectory } from "@/commands/fs"
import { useWikiStore } from "@/stores/wiki-store"
import {
  analyzeResearchPapers,
  collectPaperCandidates,
  importCandidatePaper,
  importResearchPapers,
  listResearchPapers,
  type PaperCandidate,
} from "@/lib/paper-research"
import {
  loadDailyScans,
  manualPushPaper,
  triggerPaperMonitorScan,
  type DailyScanEntry,
} from "@/lib/paper-monitor"
import { normalizePath } from "@/lib/path-utils"
import { isImeComposing } from "@/lib/keyboard-utils"
import type { FileNode } from "@/types/wiki"

export function PaperResearchView() {
  const { t } = useTranslation()
  const project = useWikiStore((s) => s.project)
  const llmConfig = useWikiStore((s) => s.llmConfig)
  const paperResearchConfig = useWikiStore((s) => s.paperResearchConfig)
  const paperMonitorConfig = useWikiStore((s) => s.paperMonitorConfig)
  const setFileTree = useWikiStore((s) => s.setFileTree)
  const setSelectedFile = useWikiStore((s) => s.setSelectedFile)
  const setFileContent = useWikiStore((s) => s.setFileContent)
  const [papers, setPapers] = useState<FileNode[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [topic, setTopic] = useState("")
  const [candidates, setCandidates] = useState<PaperCandidate[]>([])
  const [notes, setNotes] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [candidateBusyIds, setCandidateBusyIds] = useState<string[]>([])
  const [page, setPage] = useState(0)
  const [scans, setScans] = useState<DailyScanEntry[]>([])
  const [expandedScanDate, setExpandedScanDate] = useState<string | null>(null)
  const [pushingKeys, setPushingKeys] = useState<string[]>([])
  const [scanningNow, setScanningNow] = useState(false)
  const [scanPages, setScanPages] = useState<Record<string, number>>({})
  const [expandedPaperGroup, setExpandedPaperGroup] = useState<string | null>(null)
  const [paperGroupPages, setPaperGroupPages] = useState<Record<string, number>>({})
  const pageSize = 50
  const PAPERS_PER_GROUP_PAGE = 10
  const SCAN_PAPERS_PER_PAGE = 10

  const projectPath = project ? normalizePath(project.path) : ""
  const totalPages = Math.max(1, Math.ceil(candidates.length / pageSize))
  const pageCandidates = candidates.slice(page * pageSize, (page + 1) * pageSize)
  const candidateBusySet = useMemo(() => new Set(candidateBusyIds), [candidateBusyIds])

  const paperGroups = useMemo(() => {
    const groups: Record<string, FileNode[]> = {}
    for (const paper of papers) {
      const match = paper.name.match(/\b((?:19|20)\d{2})\b/)
      const label = match ? match[1] : t("paperResearch.uncategorized")
      ;(groups[label] ??= []).push(paper)
    }
    return Object.entries(groups)
      .sort(([a], [b]) => b.localeCompare(a))
      .map(([label, papers]) => ({ label, papers }))
  }, [papers, t])

  const refresh = useCallback(async () => {
    if (!projectPath) return
    try {
      setPapers(await listResearchPapers(projectPath, paperResearchConfig))
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [paperResearchConfig, projectPath])

  const loadScans = useCallback(async () => {
    if (!projectPath) return
    try {
      setScans(await loadDailyScans(projectPath))
    } catch {
      // ignore
    }
  }, [projectPath])

  const pushPaper = useCallback(async (paper: PaperCandidate, scanDate: string) => {
    if (!project) return
    const key = `${scanDate}:${paper.id}`
    if (pushingKeys.includes(key)) return
    setPushingKeys((keys) => [...keys, key])
    try {
      await manualPushPaper(project, paper, llmConfig, scanDate)
      setScans((current) => current.map((scan) => {
        if (scan.date !== scanDate) return scan
        const importedIds = new Set(scan.importedIds ?? [])
        importedIds.add(paper.id)
        return { ...scan, importedIds: [...importedIds] }
      }))
      setFileTree(await listDirectory(project.path))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setPushingKeys((keys) => keys.filter((item) => item !== key))
      await refresh()
      await loadScans()
    }
  }, [llmConfig, project, pushingKeys, refresh, loadScans, setFileTree])

  const triggerScan = useCallback(async () => {
    if (!project) return
    setScanningNow(true)
    try {
      await triggerPaperMonitorScan(project, paperMonitorConfig, llmConfig)
      await loadScans()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setScanningNow(false)
    }
  }, [llmConfig, paperMonitorConfig, project, loadScans])

  useEffect(() => {
    refresh()
    loadScans()
  }, [refresh, loadScans])

  const importPdfs = useCallback(async () => {
    if (!project) return
    const selected = await open({
      multiple: true,
      title: t("paperResearch.importDialogTitle"),
      filters: [
        { name: t("paperResearch.paperFiles"), extensions: ["pdf", "tex", "md", "txt"] },
        { name: t("paperResearch.allFiles"), extensions: ["*"] },
      ],
    })
    if (!selected) return
    const paths = Array.isArray(selected) ? selected : [selected]
    if (paths.length === 0) return
    setBusy("import")
    try {
      await importResearchPapers(project, paths, llmConfig, paperResearchConfig)
      setFileTree(await listDirectory(project.path))
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }, [llmConfig, paperResearchConfig, project, refresh, setFileTree])

  const analyzePaper = useCallback(async (paper: FileNode) => {
    if (!project) return
    setBusy(paper.path)
    try {
      await analyzeResearchPapers(project, [paper.path], llmConfig, paperResearchConfig)
      setFileTree(await listDirectory(project.path))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }, [llmConfig, paperResearchConfig, project, setFileTree])

  const openPaper = useCallback(async (paper: FileNode) => {
    setSelectedFile(paper.path)
    try {
      setFileContent(await readFile(paper.path))
    } catch {
      setFileContent("")
    }
  }, [setFileContent, setSelectedFile])

  const collectPapers = useCallback(async () => {
    if (!topic.trim()) return
    setBusy("collect")
    try {
      const result = await collectPaperCandidates(topic.trim(), llmConfig, paperResearchConfig.literatureQueryCount * 4)
      setCandidates(result.candidates)
      setNotes(result.notes)
      setError(null)
      setPage(0)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }, [llmConfig, paperResearchConfig.literatureQueryCount, topic])

  const importCandidate = useCallback(async (candidate: PaperCandidate) => {
    if (!project) return
    if (candidateBusyIds.includes(candidate.id)) return
    setCandidateBusyIds((ids) => [...ids, candidate.id])
    setError(null)
    try {
      await importCandidatePaper(project, candidate, llmConfig, paperResearchConfig, { forceAnalyze: true })
      setFileTree(await listDirectory(project.path))
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setCandidateBusyIds((ids) => ids.filter((id) => id !== candidate.id))
    }
  }, [candidateBusyIds, llmConfig, paperResearchConfig, project, refresh, setFileTree])

  if (!project) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        {t("paperResearch.openProject")}
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col overflow-hidden bg-background">
      <header className="shrink-0 border-b px-6 py-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <BookOpen className="h-5 w-5 text-primary" />
              <h1 className="text-lg font-semibold">{t("paperResearch.title")}</h1>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              {t("paperResearch.subtitle")}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={importPdfs} disabled={!!busy}>
              {busy === "import" ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileText className="h-4 w-4" />}
              {t("paperResearch.importPapers")}
            </Button>
          </div>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto px-6 py-5">
        {error && (
          <div className="mb-4 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        )}

        <section className="mb-5 rounded-md border bg-card p-4">
          <div className="mb-3 flex items-center gap-2 text-sm font-semibold">
              <Search className="h-4 w-4 text-primary" />
              {t("paperResearch.collectTitle")}
          </div>
          <div className="flex gap-2">
            <input
              value={topic}
              dir="auto"
              onChange={(e) => setTopic(e.target.value)}
              onKeyDown={(e) => {
                if (isImeComposing(e)) return
                if (e.key === "Enter") collectPapers()
              }}
              placeholder={t("paperResearch.topicPlaceholder")}
              className="min-w-0 flex-1 rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring"
            />
            <Button onClick={collectPapers} disabled={!topic.trim() || !!busy}>
              {busy === "collect" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              {t("paperResearch.collect")}
            </Button>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            {t("paperResearch.collectHint")}
          </p>
          {notes.length > 0 && (
            <div className="mt-3 space-y-1 text-xs text-muted-foreground">
              {notes.map((note) => <div key={note}>{note}</div>)}
            </div>
          )}
        </section>

        {candidates.length > 0 && (
          <section className="mb-5 rounded-md border bg-card">
            <div className="flex items-center justify-between border-b px-4 py-3">
              <div className="text-sm font-semibold">{t("paperResearch.candidatesTitle")}</div>
              <span className="text-xs text-muted-foreground">{t("paperResearch.candidateCount", { count: candidates.length })}</span>
            </div>
            <div className="divide-y">
              {pageCandidates.map((candidate) => (
                <div key={candidate.id} className="px-4 py-3">
                  <div className="flex items-start gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium">{candidate.title}</div>
                      <div className="mt-1 text-xs text-muted-foreground">
                        {candidate.authors.slice(0, 4).join(", ") || t("paperResearch.unknownAuthors")}
                        {candidate.publishedDate ? ` · ${candidate.publishedDate}` : ""}
                        {candidate.year ? ` · ${candidate.year}` : ""}
                        {candidate.venue ? ` · ${candidate.venue}` : ""}
                        {candidate.arxivId ? ` · arXiv:${candidate.arxivId}` : ""}
                      </div>
                      <p className="mt-2 line-clamp-3 text-xs text-muted-foreground">
                        {candidate.tldr || candidate.abstract || t("paperResearch.noAbstract")}
                      </p>
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {candidate.signals.slice(0, 5).map((signal) => (
                          <span key={signal} className="rounded-full border px-2 py-0.5 text-[11px] text-muted-foreground">
                            {signal}
                          </span>
                        ))}
                      </div>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => importCandidate(candidate)}
                      disabled={candidateBusySet.has(candidate.id)}
                    >
                      {candidateBusySet.has(candidate.id) ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileText className="h-4 w-4" />}
                      {t("paperResearch.collectAndAnalyze")}
                    </Button>
                  </div>
                </div>
              ))}
            </div>
            {totalPages > 1 && (
              <div className="flex items-center justify-between border-t px-4 py-3">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPage((p) => Math.max(0, p - 1))}
                  disabled={page === 0}
                >
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <span className="text-xs text-muted-foreground">
                  {page + 1} / {totalPages}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                  disabled={page >= totalPages - 1}
                >
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            )}
          </section>
        )}

        <section className="rounded-md border bg-card">
          <div className="flex items-center justify-between border-b px-4 py-3">
            <div className="flex items-center gap-2 text-sm font-semibold">
              <Sparkles className="h-4 w-4 text-primary" />
              {t("paperResearch.analysisTitle")}
            </div>
            <span className="text-xs text-muted-foreground">{t("paperResearch.fileCount", { count: papers.length })}</span>
          </div>
          {paperGroups.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 px-6 py-14 text-center text-sm text-muted-foreground">
              <FileText className="h-10 w-10 opacity-30" />
              <p>{t("paperResearch.noPapers")}</p>
              <p className="max-w-md text-xs">
                {t("paperResearch.noPapersHint")}
              </p>
            </div>
          ) : (
            <div className="divide-y">
              {paperGroups.map((group) => {
                const gp = paperGroupPages[group.label] ?? 0
                const groupTotalPages = Math.max(1, Math.ceil(group.papers.length / PAPERS_PER_GROUP_PAGE))
                const groupPagePapers = group.papers.slice(gp * PAPERS_PER_GROUP_PAGE, (gp + 1) * PAPERS_PER_GROUP_PAGE)
                const isExpanded = expandedPaperGroup === group.label
                return (
                  <div key={group.label}>
                    <button
                      type="button"
                      onClick={() =>
                        setExpandedPaperGroup(isExpanded ? null : group.label)
                      }
                      className="flex w-full items-center justify-between px-4 py-3 text-left hover:bg-muted/50"
                    >
                      <div>
                        <span className="text-sm font-medium">{group.label}</span>
                        <span className="ml-3 text-xs text-muted-foreground">
                          {t("paperResearch.fileCount", { count: group.papers.length })}
                        </span>
                      </div>
                      <ChevronDown
                        className={`h-4 w-4 text-muted-foreground transition-transform ${
                          isExpanded ? "rotate-180" : ""
                        }`}
                      />
                    </button>
                    {isExpanded && (
                      <div className="border-t bg-muted/20">
                        <div className="divide-y">
                          {groupPagePapers.map((paper) => (
                            <div key={paper.path} className="flex items-center gap-3 px-4 py-3">
                              <button
                                type="button"
                                onClick={() => openPaper(paper)}
                                className="min-w-0 flex-1 text-left"
                              >
                                <div className="truncate text-sm font-medium">{paper.name}</div>
                                <div className="truncate text-xs text-muted-foreground">{paper.path.replace(projectPath + "/", "")}</div>
                              </button>
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => analyzePaper(paper)}
                                disabled={!!busy}
                              >
                                {busy === paper.path ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
                                {t("paperResearch.analyze")}
                              </Button>
                            </div>
                          ))}
                        </div>
                        {groupTotalPages > 1 && (
                          <div className="flex items-center justify-between border-t px-4 py-3">
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() =>
                                setPaperGroupPages((prev) => ({
                                  ...prev,
                                  [group.label]: Math.max(0, gp - 1),
                                }))
                              }
                              disabled={gp === 0}
                            >
                              <ChevronLeft className="h-4 w-4" />
                            </Button>
                            <span className="text-xs text-muted-foreground">
                              {gp + 1} / {groupTotalPages}
                            </span>
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() =>
                                setPaperGroupPages((prev) => ({
                                  ...prev,
                                  [group.label]: Math.min(groupTotalPages - 1, gp + 1),
                                }))
                              }
                              disabled={gp >= groupTotalPages - 1}
                            >
                              <ChevronRight className="h-4 w-4" />
                            </Button>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </section>

        <section className="rounded-md border bg-card">
            <div className="flex items-center justify-between border-b px-4 py-3">
              <div className="flex items-center gap-2 text-sm font-semibold">
                <CalendarDays className="h-4 w-4 text-primary" />
                {t("paperResearch.monitor.dailyResults")}
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={triggerScan}
                  disabled={scanningNow}
                >
                  {scanningNow ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <RefreshCw className="h-4 w-4" />
                  )}
                  {t("paperResearch.monitor.scanNow")}
                </Button>
                <span className="text-xs text-muted-foreground">
                  {t("paperResearch.monitor.scanCount", { count: scans.length })}
                </span>
              </div>
            </div>
            {scans.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-2 px-6 py-10 text-center text-sm text-muted-foreground">
                <CalendarDays className="h-8 w-8 opacity-30" />
                <p>{t("paperResearch.monitor.noScansYet")}</p>
              </div>
            ) : (
              <div className="divide-y">
                {scans.map((scan) => (
                <div key={scan.date}>
                  <button
                    type="button"
                    onClick={() =>
                      setExpandedScanDate(
                        expandedScanDate === scan.date ? null : scan.date,
                      )
                    }
                    className="flex w-full items-center justify-between px-4 py-3 text-left hover:bg-muted/50"
                  >
                    <div>
                      <span className="text-sm font-medium">{scan.date}</span>
                      <span className="ml-3 text-xs text-muted-foreground">
                        {t("paperResearch.monitor.paperCount", { count: scan.paperCount })}
                      </span>
                    </div>
                    <ChevronDown
                      className={`h-4 w-4 text-muted-foreground transition-transform ${
                        expandedScanDate === scan.date ? "rotate-180" : ""
                      }`}
                    />
                  </button>
                  {expandedScanDate === scan.date && (
                    <div className="border-t bg-muted/20">
                      {scan.topics.length > 0 && (
                        <div className="px-4 py-2 text-xs text-muted-foreground">
                          {t("paperResearch.monitor.topicsLabel")}:{" "}
                          {scan.topics.join(", ")}
                        </div>
                      )}
                      {scan.papers.length === 0 ? (
                        <div className="px-4 py-6 text-center text-xs text-muted-foreground">
                          {t("paperResearch.monitor.noPapersFound")}
                        </div>
                      ) : (() => {
                        const sp = scanPages[scan.date] ?? 0
                        const scanTotalPages = Math.max(1, Math.ceil(scan.papers.length / SCAN_PAPERS_PER_PAGE))
                        const scanPagePapers = scan.papers.slice(sp * SCAN_PAPERS_PER_PAGE, (sp + 1) * SCAN_PAPERS_PER_PAGE)
                        return (
                          <>
                            {scanPagePapers.map((paper) => {
                              const isImported = scan.importedIds?.includes(paper.id)
                              const pushKey = `${scan.date}:${paper.id}`
                              const isPushing = pushingKeys.includes(pushKey)
                              return (
                              <div
                                key={paper.id}
                                className="flex items-start gap-3 border-t px-4 py-3"
                              >
                                <div className="min-w-0 flex-1">
                                  <div className="flex items-center gap-2 text-sm font-medium">
                                    {paper.title}
                                    {isImported && (
                                      <span className="inline-flex items-center gap-1 shrink-0 rounded-full border border-green-200 bg-green-50 px-2 py-0.5 text-[11px] text-green-700 dark:border-green-800 dark:bg-green-950 dark:text-green-400">
                                        <CheckCircle2 className="h-3 w-3" />
                                        {t("paperResearch.monitor.imported")}
                                      </span>
                                    )}
                                  </div>
                                  <div className="mt-1 text-xs text-muted-foreground">
                                    {paper.authors.slice(0, 3).join(", ") || t("paperResearch.unknownAuthors")}
                                    {paper.publishedDate ? ` · ${paper.publishedDate}` : ""}
                                    {paper.arxivId ? ` · arXiv:${paper.arxivId}` : ""}
                                  </div>
                                </div>
                                <Button
                                  variant="outline"
                                  size="sm"
                                  onClick={() => pushPaper(paper, scan.date)}
                                  disabled={isPushing || isImported}
                                >
                                  {isPushing ? (
                                    <Loader2 className="h-4 w-4 animate-spin" />
                                  ) : isImported ? (
                                    <CheckCircle2 className="h-4 w-4 text-green-600" />
                                  ) : (
                                    <Upload className="h-4 w-4" />
                                  )}
                                  {isImported
                                    ? t("paperResearch.monitor.imported")
                                    : t("paperResearch.monitor.pushToWiki")}
                                </Button>
                              </div>
                            )})}
                            {scanTotalPages > 1 && (
                              <div className="flex items-center justify-between border-t px-4 py-3">
                                <Button
                                  variant="outline"
                                  size="sm"
                                  onClick={() =>
                                    setScanPages((prev) => ({
                                      ...prev,
                                      [scan.date]: Math.max(0, sp - 1),
                                    }))
                                  }
                                  disabled={sp === 0}
                                >
                                  <ChevronLeft className="h-4 w-4" />
                                </Button>
                                <span className="text-xs text-muted-foreground">
                                  {sp + 1} / {scanTotalPages}
                                </span>
                                <Button
                                  variant="outline"
                                  size="sm"
                                  onClick={() =>
                                    setScanPages((prev) => ({
                                      ...prev,
                                      [scan.date]: Math.min(scanTotalPages - 1, sp + 1),
                                    }))
                                  }
                                  disabled={sp >= scanTotalPages - 1}
                                >
                                  <ChevronRight className="h-4 w-4" />
                                </Button>
                              </div>
                            )}
                          </>
                        )
                      })()}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
          </section>
      </div>
    </div>
  )
}
