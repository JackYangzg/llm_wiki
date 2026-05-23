import { useCallback, useEffect, useState } from "react"
import { open } from "@tauri-apps/plugin-dialog"
import {
  BookOpen,
  ChevronLeft,
  ChevronRight,
  FileText,
  Loader2,
  Search,
  Send,
  Sparkles,
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
import { normalizePath } from "@/lib/path-utils"
import { isImeComposing } from "@/lib/keyboard-utils"
import type { FileNode } from "@/types/wiki"

export function PaperResearchView() {
  const { t } = useTranslation()
  const project = useWikiStore((s) => s.project)
  const llmConfig = useWikiStore((s) => s.llmConfig)
  const paperResearchConfig = useWikiStore((s) => s.paperResearchConfig)
  const setFileTree = useWikiStore((s) => s.setFileTree)
  const setSelectedFile = useWikiStore((s) => s.setSelectedFile)
  const setFileContent = useWikiStore((s) => s.setFileContent)
  const [papers, setPapers] = useState<FileNode[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [topic, setTopic] = useState("")
  const [candidates, setCandidates] = useState<PaperCandidate[]>([])
  const [notes, setNotes] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [page, setPage] = useState(0)
  const pageSize = 50

  const projectPath = project ? normalizePath(project.path) : ""
  const totalPages = Math.max(1, Math.ceil(candidates.length / pageSize))
  const pageCandidates = candidates.slice(page * pageSize, (page + 1) * pageSize)

  const refresh = useCallback(async () => {
    if (!projectPath) return
    try {
      setPapers(await listResearchPapers(projectPath, paperResearchConfig))
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [paperResearchConfig, projectPath])

  useEffect(() => {
    refresh()
  }, [refresh])

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
    setBusy(candidate.id)
    try {
      await importCandidatePaper(project, candidate, llmConfig, paperResearchConfig)
      setFileTree(await listDirectory(project.path))
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }, [llmConfig, paperResearchConfig, project, refresh, setFileTree])

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
                      disabled={!!busy}
                    >
                      {busy === candidate.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileText className="h-4 w-4" />}
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
          {papers.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 px-6 py-14 text-center text-sm text-muted-foreground">
              <FileText className="h-10 w-10 opacity-30" />
              <p>{t("paperResearch.noPapers")}</p>
              <p className="max-w-md text-xs">
                {t("paperResearch.noPapersHint")}
              </p>
            </div>
          ) : (
            <div className="divide-y">
              {papers.map((paper) => (
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
          )}
        </section>
      </div>
    </div>
  )
}
