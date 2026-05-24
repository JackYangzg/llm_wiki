import { useEffect, useMemo, useState } from "react"
import {
  Bookmark,
  CheckCircle2,
  Brain,
  FlaskConical,
  GitBranch,
  Heart,
  Lightbulb,
  Loader2,
  Moon,
  RefreshCw,
  Search,
  ThumbsDown,
  X,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useWikiStore } from "@/stores/wiki-store"
import { useInspirationStore } from "@/stores/inspiration-store"
import type { IdeaStage, InspirationItem, InspirationTab } from "@/lib/inspiration-schema"
import { readFile } from "@/commands/fs"
import { queueResearch } from "@/lib/deep-research"
import { normalizePath } from "@/lib/path-utils"
import { useTranslation } from "react-i18next"

const TABS: { id: InspirationTab; label: string; icon: typeof Lightbulb }[] = [
  { id: "daily", label: "inspiration.tabs.factory", icon: Lightbulb },
  { id: "themes", label: "inspiration.tabs.themeLab", icon: FlaskConical },
  { id: "dreams", label: "inspiration.tabs.dreamLab", icon: Moon },
  { id: "feedback", label: "inspiration.tabs.outcomes", icon: Brain },
]

function formatTime(ts: number): string {
  return new Date(ts).toLocaleString()
}

function typeLabel(t: (key: string, options?: { defaultValue?: string }) => string, item: InspirationItem): string {
  return t(`inspiration.itemTypes.${item.type}`, { defaultValue: item.type })
}

function scorePercent(n: number): string {
  return `${Math.round(n * 100)}`
}

function statusLabel(t: (key: string, options?: { defaultValue?: string }) => string, status?: InspirationItem["lifecycleStatus"]): string {
  if (!status || status === "idle") return ""
  return t(`inspiration.status.${status}`, { defaultValue: status })
}

function stageLabel(t: (key: string, options?: { defaultValue?: string }) => string, stage?: IdeaStage): string {
  if (!stage) return t("inspiration.stage.candidate", { defaultValue: "Candidate" })
  return t(`inspiration.stage.${stage}`, { defaultValue: stage })
}

function ItemCard({
  item,
  onOpen,
  onFeedback,
  onResearch,
  onIterate,
  isLiked,
  isSaved,
  isAdopted,
  isDisliked,
  isEvolving,
  commentDraft,
  onCommentDraft,
  onComment,
}: {
  item: InspirationItem
  onOpen: (item: InspirationItem) => void
  onFeedback: (item: InspirationItem, action: "like" | "unlike" | "dislike" | "undislike" | "save" | "unsave" | "promote" | "unpromote" | "reject") => void
  onResearch: (item: InspirationItem) => void
  onIterate: (item: InspirationItem) => void
  isLiked: boolean
  isSaved: boolean
  isAdopted: boolean
  isDisliked: boolean
  isEvolving: boolean
  commentDraft: string
  onCommentDraft: (item: InspirationItem, value: string) => void
  onComment: (item: InspirationItem) => void
}) {
  const { t } = useTranslation()
  return (
    <article className="rounded-lg border bg-background p-3 shadow-sm">
      <div className="mb-2 flex items-start justify-between gap-3">
        <button
          type="button"
          onClick={() => onOpen(item)}
          className="min-w-0 text-left"
        >
          <div className="mb-1 flex flex-wrap items-center gap-1.5">
            <span className="rounded-md bg-primary/10 px-1.5 py-0.5 text-[11px] font-medium text-primary">
              {typeLabel(t, item)}
            </span>
            <span className="rounded-md bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
              {item.strategy}
            </span>
            {item.reviewState !== "new" && (
              <span className="rounded-md bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
                {t(`inspiration.reviewState.${item.reviewState}`, { defaultValue: item.reviewState })}
              </span>
            )}
            {(item.type === "idea" || item.type === "theme") && (
              <span className="rounded-md bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
                {stageLabel(t, item.ideaStage)}
              </span>
            )}
            {item.lifecycleStatus && item.lifecycleStatus !== "idle" && (
              <span className="rounded-md bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
                {statusLabel(t, item.lifecycleStatus)}
              </span>
            )}
          </div>
          <h3 className="line-clamp-2 text-sm font-semibold">{item.title}</h3>
        </button>
        <div className="shrink-0 rounded-md border px-1.5 py-1 text-center text-[11px] text-muted-foreground">
          <div className="font-semibold text-foreground">{scorePercent(item.scores.final)}</div>
          <div>{t("inspiration.card.score")}</div>
        </div>
      </div>
      <p className="mb-3 line-clamp-3 text-sm text-muted-foreground">{item.summary}</p>
      <div className="mb-3 flex flex-wrap gap-1.5">
        {(item.evidence ?? []).slice(0, 3).map((evidence) => (
          <button
            key={evidence.id}
            type="button"
            onClick={() => onOpen(item)}
            className="max-w-full truncate rounded-md bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground hover:text-foreground"
            title={evidence.title}
          >
            {evidence.title}
          </button>
        ))}
      </div>
      <div className="grid grid-cols-5 gap-1 text-[10px] text-muted-foreground">
        <span>{t("inspiration.card.groundedness")} {scorePercent(item.scores.groundedness)}</span>
        <span>{t("inspiration.card.novelty")} {scorePercent(item.scores.novelty)}</span>
        <span>{t("inspiration.card.goalFit")} {scorePercent(item.scores.goalFit)}</span>
        <span>{t("inspiration.card.actionability")} {scorePercent(item.scores.actionability)}</span>
        <span>{t("inspiration.card.diversity")} {scorePercent(item.scores.diversity)}</span>
      </div>
      {item.type === "idea" && (
        <div className="mt-2 grid grid-cols-3 gap-1 text-[10px] text-muted-foreground">
          <span>{t("inspiration.card.entered")} {formatTime(item.enteredAt ?? item.createdAt)}</span>
          <span>{t("inspiration.card.updated")} {formatTime(item.updatedAt ?? item.createdAt)}</span>
          <span>{t("inspiration.card.iterations", { count: item.evolutionCount ?? 0 })}</span>
          <span>{t("inspiration.card.version", { version: item.version ?? 1 })}</span>
          <span>{t("inspiration.card.maturity", { level: item.maturityLevel ?? 2 })}</span>
          <span>{t("inspiration.card.task", { task: item.lastTaskType ?? "score" })}</span>
        </div>
      )}
      {item.type === "dream" && (
        <div className="mt-2 grid grid-cols-3 gap-1 text-[10px] text-muted-foreground">
          <span>{t("inspiration.card.status")} {item.dreamStatus ?? "dreaming"}</span>
          <span>{t("inspiration.card.dreamIterations", { count: item.evolutionCount ?? 0 })}</span>
          <span>{t("inspiration.card.updated")} {formatTime(item.updatedAt ?? item.createdAt)}</span>
          <span>{t("inspiration.card.dreamMode")} {item.dreamMode ? t(`inspiration.dreamModes.${item.dreamMode}`, { defaultValue: item.dreamMode }) : "-"}</span>
          <span>{t("inspiration.card.fragments", { count: item.dreamFragments?.length ?? 0 })}</span>
          <span>{t("inspiration.card.dreamScore")} {typeof item.dreamScore === "number" ? scorePercent(item.dreamScore) : "-"}</span>
        </div>
      )}
      <div className="mt-3 flex items-center gap-1">
        <Button
          variant="ghost"
          size="icon-xs"
          title={isLiked ? t("inspiration.actions.unlike") : t("inspiration.actions.like")}
          onClick={() => onFeedback(item, isLiked ? "unlike" : "like")}
          className={isLiked ? "text-red-500 hover:text-red-600" : undefined}
        >
          <Heart className={isLiked ? "fill-current" : undefined} />
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          title={isSaved ? t("inspiration.actions.unsave") : t("inspiration.actions.save")}
          onClick={() => onFeedback(item, isSaved ? "unsave" : "save")}
          className={isSaved ? "text-amber-500 hover:text-amber-600" : undefined}
        >
          <Bookmark className={isSaved ? "fill-current" : undefined} />
        </Button>
        {(item.type === "idea" || item.type === "theme" || item.type === "dream") && (
          <Button
            variant="ghost"
            size="icon-xs"
            title={isAdopted ? t("inspiration.actions.unpromote") : t("inspiration.actions.promote")}
            onClick={() => onFeedback(item, isAdopted ? "unpromote" : "promote")}
            className={isAdopted ? "text-emerald-600 hover:text-emerald-700" : undefined}
          >
            <CheckCircle2 className={isAdopted ? "fill-current" : undefined} />
          </Button>
        )}
        <Button variant="ghost" size="icon-xs" title={t("inspiration.actions.deepResearch")} onClick={() => onResearch(item)}>
          <Search />
        </Button>
        {(item.type === "idea" || item.type === "theme") && (
          <Button variant="ghost" size="icon-xs" title={t("inspiration.actions.iterate")} onClick={() => onIterate(item)} disabled={isEvolving}>
            {isEvolving ? <Loader2 className="animate-spin" /> : <RefreshCw />}
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon-xs"
          title={isDisliked ? t("inspiration.actions.undislike") : t("inspiration.actions.dislike")}
          onClick={() => onFeedback(item, isDisliked ? "undislike" : "dislike")}
          className={isDisliked ? "text-orange-500 hover:text-orange-600" : undefined}
        >
          <ThumbsDown className={isDisliked ? "fill-current" : undefined} />
        </Button>
        <Button variant="ghost" size="icon-xs" title={t("inspiration.actions.reject")} onClick={() => onFeedback(item, "reject")}>
          <X />
        </Button>
      </div>
      {(item.type === "idea" || item.type === "theme" || item.type === "dream") && (
        <div className="mt-3 flex gap-2">
          <input
            value={commentDraft}
            onChange={(e) => onCommentDraft(item, e.target.value)}
            placeholder={item.type === "dream" ? t("inspiration.comments.dreamPlaceholder") : t("inspiration.comments.placeholder")}
            className="h-7 min-w-0 flex-1 rounded-md border bg-background px-2 text-xs outline-none focus:ring-2 focus:ring-ring"
          />
          <Button size="xs" variant="outline" onClick={() => onComment(item)} disabled={!commentDraft.trim()}>
            {t("inspiration.comments.submit")}
          </Button>
        </div>
      )}
    </article>
  )
}

export function InspirationView() {
  const { t } = useTranslation()
  const project = useWikiStore((s) => s.project)
  const llmConfig = useWikiStore((s) => s.llmConfig)
  const searchApiConfig = useWikiStore((s) => s.searchApiConfig)
  const setSelectedFile = useWikiStore((s) => s.setSelectedFile)
  const setFileContent = useWikiStore((s) => s.setFileContent)
  const bumpDataVersion = useWikiStore((s) => s.bumpDataVersion)

  const {
    runs,
    items,
    feedback,
    runningByType,
    statusByType,
    activeStatus,
    error,
    load,
    run,
    addFeedback,
    addComment,
    evolveItem,
    markThemeLabExploring,
    exploreExistingThemes,
  } = useInspirationStore()

  const [tab, setTab] = useState<InspirationTab>("daily")
  const [topic, setTopic] = useState("")
  const [commentDrafts, setCommentDrafts] = useState<Record<string, string>>({})
  const [dreamPickerOpen, setDreamPickerOpen] = useState(false)
  const [selectedDreamSeeds, setSelectedDreamSeeds] = useState<string[]>([])

  const feedbackState = useMemo(() => {
    const liked = new Set<string>()
    const saved = new Set<string>()
    const disliked = new Set<string>()
    for (const f of [...feedback].sort((a, b) => a.createdAt - b.createdAt)) {
      if (f.action === "like") liked.add(f.itemId)
      if (f.action === "unlike" || f.action === "reject") liked.delete(f.itemId)
      if (f.action === "save") saved.add(f.itemId)
      if (f.action === "unsave" || f.action === "reject") saved.delete(f.itemId)
      if (f.action === "dislike") disliked.add(f.itemId)
      if (f.action === "undislike" || f.action === "reject") disliked.delete(f.itemId)
    }
    for (const item of items) {
      if (item.reviewState === "saved") saved.add(item.id)
      if (item.reviewState === "formal") saved.delete(item.id)
      if (item.reviewState === "rejected") {
        liked.delete(item.id)
        saved.delete(item.id)
        disliked.delete(item.id)
      }
    }
    const adopted = new Set(items.filter((item) => item.reviewState === "formal" || item.origin === "adopted").map((item) => item.id))
    return { liked, saved, disliked, adopted }
  }, [feedback, items])

  useEffect(() => {
    if (project) void load(project.path)
  }, [load, project])

  const visibleItems = useMemo(() => {
    if (tab === "daily") return items.filter((item) => item.origin === "factory" && item.reviewState !== "formal" && item.reviewState !== "rejected").slice(0, 24)
    if (tab === "themes") return items.filter((item) => item.origin === "theme_lab" && item.reviewState !== "formal" && item.reviewState !== "rejected")
    if (tab === "dreams") return items.filter((item) => item.origin === "dream" && item.reviewState !== "formal" && item.reviewState !== "rejected")
    return items.filter((item) => item.reviewState === "formal" || item.origin === "adopted")
  }, [items, tab])

  const factoryStageStats = useMemo(() => {
    const stats: Record<IdeaStage, number> = {
      seed: 0,
      candidate: 0,
      incubating: 0,
      validated: 0,
      mature: 0,
      adopted: 0,
      archived: 0,
    }
    for (const item of items) {
      if (item.origin !== "factory" || item.type !== "idea") continue
      const stage = item.ideaStage ?? (item.reviewState === "formal" ? "adopted" : item.reviewState === "rejected" ? "archived" : "candidate")
      stats[stage] += 1
    }
    return stats
  }, [items])

  async function handleRunDaily() {
    if (!project || runningByType.daily) return
    await run(project.path, llmConfig, "daily", "manual")
    bumpDataVersion()
  }

  const dreamSeedOptions = useMemo(() => items.filter((item) =>
    (item.origin === "factory" || item.origin === "theme_lab") &&
    item.reviewState !== "formal" &&
    item.reviewState !== "rejected",
  ), [items])

  async function handleRunTopic(kind: "theme" | "dream") {
    if (!project || runningByType[kind]) return
    const selectedSeeds = dreamSeedOptions.filter((item) => selectedDreamSeeds.includes(item.id))
    const effectiveTopic = kind === "dream"
      ? (selectedSeeds.length > 0
        ? `基于这些点子/主题开始造梦：${selectedSeeds.map((item) => item.title).join("；")}`
        : "从当前点子池启动梦境")
      : (topic.trim() || t("inspiration.themeLab.stockExplorationTopic", "存量主题深度探索"))
    if (kind === "theme" && !topic.trim()) {
      await markThemeLabExploring(project.path)
      await exploreExistingThemes(project.path, llmConfig)
      bumpDataVersion()
      return
    }
    await run(project.path, llmConfig, kind, "manual", effectiveTopic)
    if (kind === "dream") {
      setDreamPickerOpen(false)
      setSelectedDreamSeeds([])
    }
    bumpDataVersion()
  }

  async function handleOpen(item: InspirationItem) {
    try {
      const content = await readFile(item.markdownPath)
      setSelectedFile(item.markdownPath)
      setFileContent(content)
    } catch (err) {
      console.error("Failed to open inspiration item:", err)
    }
  }

  async function handleFeedback(item: InspirationItem, action: "like" | "unlike" | "dislike" | "undislike" | "save" | "unsave" | "promote" | "unpromote" | "reject") {
    if (!project) return
    await addFeedback(project.path, item.id, action)
  }

  function handleResearch(item: InspirationItem) {
    if (!project) return
    queueResearch(
      normalizePath(project.path),
      item.title,
      llmConfig,
      searchApiConfig,
      item.evidence.map((e) => `${item.title} ${e.title}`).slice(0, 3),
    )
    void handleFeedback(item, "save")
  }

  function handleCommentDraft(item: InspirationItem, value: string) {
    setCommentDrafts((prev) => ({ ...prev, [item.id]: value }))
  }

  async function handleComment(item: InspirationItem) {
    if (!project) return
    const body = commentDrafts[item.id]?.trim()
    if (!body) return
    await addComment(project.path, item.id, body)
    setCommentDrafts((prev) => ({ ...prev, [item.id]: "" }))
  }

  async function handleIterate(item: InspirationItem) {
    if (!project || (item.type !== "idea" && item.type !== "theme")) return
    await evolveItem(project.path, llmConfig, item.id)
  }

  const latestRun = runs[0]
  const liked = feedbackState.liked.size
  const saved = feedbackState.saved.size
  const disliked = feedbackState.disliked.size
  const adopted = feedbackState.adopted.size

  return (
    <div className="flex h-full flex-col overflow-hidden bg-background">
      <div className="shrink-0 border-b px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-base font-semibold">{t("inspiration.title", "灵思妙想")}</h1>
            <p className="text-xs text-muted-foreground">
              {latestRun
                ? t("inspiration.latestRun", { runType: latestRun.runType, status: latestRun.status, time: formatTime(latestRun.startedAt) })
                : t("inspiration.subtitle")}
            </p>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap gap-1">
          {TABS.map(({ id, label, icon: Icon }) => (
            <Button
              key={id}
              variant={tab === id ? "secondary" : "ghost"}
              size="sm"
              onClick={() => setTab(id)}
            >
              <Icon />
              {t(label)}
            </Button>
          ))}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-4">
        {tab === "daily" && (
          <div className="mb-4 space-y-3 rounded-lg border bg-muted/30 p-3">
            <div className="flex items-center justify-between gap-3">
              <p className="text-sm text-muted-foreground">{t("inspiration.factory.description")}</p>
              <Button onClick={handleRunDaily} disabled={!project || !!runningByType.daily}>
                {runningByType.daily ? <Loader2 className="animate-spin" /> : <RefreshCw />}
                {t("inspiration.factory.build")}
              </Button>
            </div>
            <div className="grid gap-2 sm:grid-cols-4 lg:grid-cols-7">
              {(Object.keys(factoryStageStats) as IdeaStage[]).map((stage) => (
                <div key={stage} className="rounded-md border bg-background px-2 py-1.5">
                  <div className="text-[11px] text-muted-foreground">{stageLabel(t, stage)}</div>
                  <div className="text-lg font-semibold">{factoryStageStats[stage]}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        {tab === "themes" && (
          <div className="mb-4 flex gap-2">
            <Input
              value={topic}
              onChange={(event) => setTopic(event.target.value)}
              placeholder={t("inspiration.themeLab.placeholder")}
              onKeyDown={(event) => {
                if (event.key === "Enter") void handleRunTopic("theme")
              }}
            />
            <Button
              onClick={() => handleRunTopic("theme")}
              disabled={!!runningByType.theme}
            >
              <GitBranch />
              {t("inspiration.themeLab.explore")}
            </Button>
          </div>
        )}

        {tab === "dreams" && (
          <div className="mb-4 space-y-3 rounded-lg border bg-muted/30 p-3">
            <div className="flex items-center justify-between gap-3">
              <p className="text-sm text-muted-foreground">{t("inspiration.dreamLab.description")}</p>
            <Button onClick={() => setDreamPickerOpen((open) => !open)} disabled={!!runningByType.dream || dreamSeedOptions.length === 0}>
                <Moon />
                {t("inspiration.dreamLab.start")}
              </Button>
            </div>
            {dreamPickerOpen && (
              <div className="space-y-3 rounded-md border bg-background p-3">
                <div className="text-xs text-muted-foreground">{t("inspiration.dreamLab.pickSeeds")}</div>
                <div className="max-h-56 space-y-1 overflow-auto">
                  {dreamSeedOptions.map((item) => (
                    <label key={item.id} className="flex items-start gap-2 rounded-md px-2 py-1 hover:bg-muted/60">
                      <input
                        type="checkbox"
                        checked={selectedDreamSeeds.includes(item.id)}
                        onChange={(event) => {
                          setSelectedDreamSeeds((prev) =>
                            event.target.checked
                              ? [...prev, item.id]
                              : prev.filter((id) => id !== item.id),
                          )
                        }}
                        className="mt-0.5 h-4 w-4"
                      />
                      <span className="min-w-0">
                        <span className="block truncate text-sm">{item.title}</span>
                        <span className="block truncate text-xs text-muted-foreground">{item.origin} / {item.type}</span>
                      </span>
                    </label>
                  ))}
                </div>
                <div className="flex justify-end gap-2">
                  <Button variant="ghost" size="sm" onClick={() => setDreamPickerOpen(false)}>{t("common.cancel", { defaultValue: "Cancel" })}</Button>
                  <Button size="sm" onClick={() => handleRunTopic("dream")} disabled={!!runningByType.dream || selectedDreamSeeds.length === 0}>
                    <Moon />
                    {t("inspiration.dreamLab.startDream")}
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}

        {tab === "feedback" && (
          <div className="mb-4 grid gap-3 sm:grid-cols-4">
            <div className="rounded-lg border p-3">
              <div className="text-xs text-muted-foreground">{t("inspiration.metrics.adopted")}</div>
              <div className="text-2xl font-semibold">{adopted}</div>
            </div>
            <div className="rounded-lg border p-3">
              <div className="text-xs text-muted-foreground">{t("inspiration.metrics.saved")}</div>
              <div className="text-2xl font-semibold">{saved}</div>
            </div>
            <div className="rounded-lg border p-3">
              <div className="text-xs text-muted-foreground">{t("inspiration.metrics.liked")}</div>
              <div className="text-2xl font-semibold">{liked}</div>
            </div>
            <div className="rounded-lg border p-3">
              <div className="text-xs text-muted-foreground">{t("inspiration.metrics.disliked")}</div>
              <div className="text-2xl font-semibold">{disliked}</div>
            </div>
          </div>
        )}

        {error && (
          <div className="mb-4 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
            {error}
          </div>
        )}

        {runningByType[tab === "daily" ? "daily" : tab === "themes" ? "theme" : tab === "dreams" ? "dream" : "daily"] && tab !== "feedback" && (
          <div className="mb-4 flex items-center gap-2 rounded-lg border bg-muted/40 p-3 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            {t("inspiration.runningCurrent", { status: statusByType[tab === "daily" ? "daily" : tab === "themes" ? "theme" : "dream"] ?? activeStatus ?? "queued" })}
          </div>
        )}

        {visibleItems.length === 0 ? (
          <div className="flex min-h-[260px] flex-col items-center justify-center gap-2 rounded-lg border border-dashed text-center text-sm text-muted-foreground">
            <Lightbulb className="h-8 w-8 opacity-40" />
            <p>{tab === "feedback" ? t("inspiration.empty.outcomes") : t("inspiration.empty.module")}</p>
          </div>
        ) : (
          <div className="grid gap-3 xl:grid-cols-2 2xl:grid-cols-3">
            {visibleItems.filter(Boolean).map((item) => (
              <ItemCard
                key={item.id}
                item={item}
                onOpen={handleOpen}
                onFeedback={handleFeedback}
                onResearch={handleResearch}
                onIterate={handleIterate}
                isLiked={feedbackState.liked.has(item.id)}
                isSaved={feedbackState.saved.has(item.id)}
                isAdopted={feedbackState.adopted.has(item.id)}
                isDisliked={feedbackState.disliked.has(item.id)}
                isEvolving={item.lifecycleStatus === "evolving"}
                commentDraft={commentDrafts[item.id] ?? ""}
                onCommentDraft={handleCommentDraft}
                onComment={handleComment}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
