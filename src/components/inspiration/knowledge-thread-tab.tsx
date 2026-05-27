import { useEffect, useMemo, useState } from "react"
import {
  GitBranch,
  Loader2,
  PanelRightOpen,
  RefreshCw,
  Send,
  Sparkles,
  Trash2,
  X,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { useWikiStore } from "@/stores/wiki-store"
import { useKnowledgeThreadStore } from "@/stores/knowledge-thread-store"
import type { KnowledgeThread } from "@/lib/knowledge-thread/types"
import { useTranslation } from "react-i18next"

function pct(value: number): string {
  return `${Math.round(value * 100)}%`
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleString()
}

export function KnowledgeThreadTab() {
  const { t } = useTranslation()
  const project = useWikiStore((s) => s.project)
  const llmConfig = useWikiStore((s) => s.llmConfig)
  const {
    threads,
    nodes,
    edges,
    gaps,
    contexts,
    logs,
    selectedThreadId,
    running,
    error,
    loadThreads,
    selectThread,
    deleteThread,
    runEvolution,
    addUserContext,
  } = useKnowledgeThreadStore()
  const [contextDraft, setContextDraft] = useState("")
  const [sidePanelOpen, setSidePanelOpen] = useState(false)

  useEffect(() => {
    if (project) void loadThreads(project.path)
  }, [loadThreads, project])

  const selectedThread = useMemo(
    () => threads.find((thread) => thread.id === selectedThreadId) ?? threads[0] ?? null,
    [selectedThreadId, threads],
  )
  const threadNodes = useMemo(
    () => selectedThread ? nodes.filter((node) => node.threadId === selectedThread.id) : [],
    [nodes, selectedThread],
  )
  const threadEdges = useMemo(
    () => selectedThread ? edges.filter((edge) => edge.threadId === selectedThread.id) : [],
    [edges, selectedThread],
  )
  const threadGaps = useMemo(
    () => selectedThread ? gaps.filter((gap) => gap.threadId === selectedThread.id) : [],
    [gaps, selectedThread],
  )
  const threadContexts = useMemo(
    () => selectedThread
      ? contexts.filter((context) => context.targetType === "global" || context.targetId === selectedThread.id).slice(0, 5)
      : contexts.slice(0, 5),
    [contexts, selectedThread],
  )

  async function handleRefresh() {
    if (!project) return
    await runEvolution(project.path, llmConfig, {
      triggerType: "manual_refresh",
      targetThreadId: selectedThread?.id,
    })
  }

  async function handleAddContext() {
    if (!project || !contextDraft.trim()) return
    await addUserContext(project.path, llmConfig, contextDraft, selectedThread ? { type: "thread", id: selectedThread.id } : { type: "global" })
    setContextDraft("")
  }

  async function handleDeleteThread(thread: KnowledgeThread) {
    if (!project) return
    const confirmed = window.confirm(t("inspiration.knowledgeThreads.deleteConfirm", { name: thread.name }))
    if (!confirmed) return
    await deleteThread(project.path, thread.id)
  }

  return (
    <div className="relative flex min-h-[620px] overflow-hidden rounded-lg border bg-background">
      <aside className="w-80 shrink-0 border-r bg-muted/20">
        <div className="border-b p-3">
          <div className="flex items-center justify-between gap-2">
            <div>
              <h3 className="text-sm font-semibold">{t("inspiration.knowledgeThreads.overview")}</h3>
              <p className="text-xs text-muted-foreground">
                {t("inspiration.knowledgeThreads.threadCount", { count: threads.length })}
              </p>
            </div>
            <Button size="sm" variant="outline" onClick={handleRefresh} disabled={!project || running}>
              {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            </Button>
          </div>
          {error && <div className="mt-2 rounded border border-destructive/30 bg-destructive/10 p-2 text-xs text-destructive">{error}</div>}
        </div>
        <div className="max-h-[560px] overflow-auto p-2">
          {threads.length === 0 ? (
            <div className="rounded-md border border-dashed p-4 text-center text-xs text-muted-foreground">
              {t("inspiration.knowledgeThreads.empty")}
            </div>
          ) : (
            threads.map((thread) => (
              <ThreadListItem
                key={thread.id}
                thread={thread}
                selected={thread.id === selectedThread?.id}
                onClick={() => selectThread(thread.id)}
                onDelete={() => handleDeleteThread(thread)}
              />
            ))
          )}
        </div>
      </aside>

      <main className="min-w-0 flex-1 overflow-auto p-4">
        {!selectedThread ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            {t("inspiration.knowledgeThreads.emptyHint")}
          </div>
        ) : (
          <div className="space-y-4">
            <section>
              <div className="mb-2 flex items-start justify-between gap-3">
                <div className="flex min-w-0 items-center gap-2">
                  <GitBranch className="h-4 w-4 shrink-0 text-primary" />
                  <h3 className="truncate text-base font-semibold">{selectedThread.name}</h3>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setSidePanelOpen(true)}
                >
                  <PanelRightOpen className="h-4 w-4" />
                  {t("inspiration.knowledgeThreads.openSidePanel")}
                </Button>
              </div>
              <p className="text-sm text-muted-foreground">{selectedThread.summary}</p>
            </section>

            <section className="grid gap-2 md:grid-cols-5">
              <ScoreCard label={t("inspiration.knowledgeThreads.maturity")} value={pct(selectedThread.maturityScore)} />
              <ScoreCard label={t("inspiration.knowledgeThreads.coverage")} value={pct(selectedThread.coverageScore)} />
              <ScoreCard label={t("inspiration.knowledgeThreads.coherence")} value={pct(selectedThread.coherenceScore)} />
              <ScoreCard label={t("inspiration.knowledgeThreads.novelty")} value={pct(selectedThread.noveltyScore)} />
              <ScoreCard label={t("inspiration.knowledgeThreads.activity")} value={pct(selectedThread.activityScore)} />
            </section>

            <section className="rounded-md border p-3">
              <h4 className="mb-2 text-sm font-semibold">{t("inspiration.knowledgeThreads.coreQuestion")}</h4>
              <p className="text-sm">{selectedThread.coreQuestion}</p>
            </section>

            <section className="rounded-md border p-3">
              <h4 className="mb-3 text-sm font-semibold">{t("inspiration.knowledgeThreads.pathMap")}</h4>
              <div className="space-y-2">
                {threadNodes.length === 0 ? (
                  <p className="text-xs text-muted-foreground">{t("inspiration.knowledgeThreads.noNodes")}</p>
                ) : (
                  threadNodes
                    .sort((a, b) => b.importance - a.importance)
                    .slice(0, 12)
                    .map((node) => (
                      <div key={node.id} className="rounded-md border bg-muted/20 p-2">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-sm font-medium">{node.title}</span>
                          <span className="rounded-full border px-2 py-0.5 text-[11px] text-muted-foreground">{node.type}</span>
                        </div>
                        <p className="mt-1 text-xs text-muted-foreground">{node.summary}</p>
                      </div>
                    ))
                )}
              </div>
            </section>

            <section className="rounded-md border p-3">
              <h4 className="mb-3 text-sm font-semibold">{t("inspiration.knowledgeThreads.relations")}</h4>
              <div className="space-y-1">
                {threadEdges.length === 0 ? (
                  <p className="text-xs text-muted-foreground">{t("inspiration.knowledgeThreads.noEdges")}</p>
                ) : (
                  threadEdges.slice(0, 16).map((edge) => {
                    const source = threadNodes.find((node) => node.id === edge.sourceNodeId)
                    const target = threadNodes.find((node) => node.id === edge.targetNodeId)
                    return (
                      <div key={edge.id} className="text-xs text-muted-foreground">
                        <span className="font-medium text-foreground">{source?.title ?? edge.sourceNodeId}</span>
                        <span> -- {edge.type} -- </span>
                        <span className="font-medium text-foreground">{target?.title ?? edge.targetNodeId}</span>
                        {edge.reason ? <span>：{edge.reason}</span> : null}
                      </div>
                    )
                  })
                )}
              </div>
            </section>
          </div>
        )}
      </main>

      {sidePanelOpen && (
        <div className="absolute inset-0 z-20 flex justify-end bg-background/30 backdrop-blur-[1px]">
          <aside className="h-full w-[min(460px,calc(100%-1rem))] overflow-auto border-l bg-background p-3 shadow-xl">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold">{t("inspiration.knowledgeThreads.sidePanelTitle")}</h3>
                <p className="text-xs text-muted-foreground">{selectedThread?.name ?? t("inspiration.knowledgeThreads.emptyHint")}</p>
              </div>
              <Button
                variant="ghost"
                size="icon-sm"
                title={t("common.close", { defaultValue: "Close" })}
                onClick={() => setSidePanelOpen(false)}
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
            <div className="space-y-4">
          <section className="rounded-md border bg-background p-3">
            <h4 className="mb-2 text-sm font-semibold">{t("inspiration.knowledgeThreads.gaps")}</h4>
            <div className="space-y-2">
              {threadGaps.length > 0
                ? threadGaps.map((gap) => (
                    <div key={gap.id} className="rounded-md border p-2">
                      <div className="text-sm font-medium">{gap.title}</div>
                      <div className="text-xs text-muted-foreground">{gap.description}</div>
                    </div>
                  ))
                : selectedThread?.gaps.map((gap) => <div key={gap} className="rounded-md border p-2 text-xs text-muted-foreground">{gap}</div>)}
            </div>
          </section>

          <section className="rounded-md border bg-background p-3">
            <h4 className="mb-2 text-sm font-semibold">{t("inspiration.knowledgeThreads.nextDirections")}</h4>
            <ul className="space-y-1 text-xs text-muted-foreground">
              {(selectedThread?.nextDirections ?? []).map((direction) => <li key={direction}>- {direction}</li>)}
            </ul>
          </section>

          <section className="rounded-md border bg-background p-3">
            <h4 className="mb-2 text-sm font-semibold">{t("inspiration.knowledgeThreads.userContext")}</h4>
            <textarea
              value={contextDraft}
              onChange={(event) => setContextDraft(event.target.value)}
              placeholder={t("inspiration.knowledgeThreads.contextPlaceholder")}
              className="min-h-24 w-full resize-y rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring"
            />
            <Button className="mt-2 w-full" size="sm" onClick={handleAddContext} disabled={!contextDraft.trim() || running}>
              {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              {t("inspiration.knowledgeThreads.submitContext")}
            </Button>
            {threadContexts.length > 0 && (
              <div className="mt-3 space-y-1">
                {threadContexts.map((context) => (
                  <div key={context.id} className="rounded-md bg-muted p-2 text-xs text-muted-foreground">
                    {context.content}
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="rounded-md border bg-background p-3">
            <h4 className="mb-2 flex items-center gap-2 text-sm font-semibold">
              <Sparkles className="h-4 w-4 text-primary" />
              {t("inspiration.knowledgeThreads.evolutionLogs")}
            </h4>
            <div className="space-y-2">
              {logs.length === 0 ? (
                <p className="text-xs text-muted-foreground">{t("inspiration.knowledgeThreads.noLogs")}</p>
              ) : (
                logs.slice(0, 8).map((log) => (
                  <div key={log.id} className="rounded-md border p-2">
                    <div className="text-xs text-muted-foreground">{formatTime(log.createdAt)} / {log.triggerType}</div>
                    <div className="mt-1 text-sm">{log.summary}</div>
                    {log.nextTasks.length > 0 && (
                      <ul className="mt-1 text-xs text-muted-foreground">
                        {log.nextTasks.slice(0, 3).map((task) => <li key={task}>- {task}</li>)}
                      </ul>
                    )}
                  </div>
                ))
              )}
            </div>
          </section>
            </div>
          </aside>
        </div>
      )}
    </div>
  )
}

function ThreadListItem({
  thread,
  selected,
  onClick,
  onDelete,
}: {
  thread: KnowledgeThread
  selected: boolean
  onClick: () => void
  onDelete: () => void
}) {
  const { t } = useTranslation()
  return (
    <div
      className={`mb-2 w-full rounded-md border p-3 text-left transition-colors ${
        selected ? "border-primary bg-primary/10" : "bg-background hover:bg-muted"
      }`}
    >
      <div className="flex items-start gap-2">
        <button type="button" onClick={onClick} className="min-w-0 flex-1 text-left">
          <div className="flex items-start justify-between gap-2">
            <div className="text-sm font-medium">{thread.name}</div>
            <span className="rounded-full border px-2 py-0.5 text-[11px] text-muted-foreground">{pct(thread.maturityScore)}</span>
          </div>
          <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{thread.coreQuestion}</p>
          <div className="mt-2 flex flex-wrap gap-1">
            {thread.rootTopics.slice(0, 3).map((topic) => (
              <span key={topic} className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">{topic}</span>
            ))}
          </div>
        </button>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          title={t("inspiration.knowledgeThreads.deleteThread")}
          onClick={(event) => {
            event.stopPropagation()
            onDelete()
          }}
        >
          <Trash2 className="text-destructive" />
        </Button>
      </div>
    </div>
  )
}

function ScoreCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border bg-muted/20 p-2">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className="text-lg font-semibold">{value}</div>
    </div>
  )
}
