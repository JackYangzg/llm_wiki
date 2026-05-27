import { useEffect, useMemo, useState } from "react"
import {
  Bookmark,
  CheckCircle2,
  Brain,
  ChevronLeft,
  ChevronRight,
  FlaskConical,
  GitBranch,
  Heart,
  Lightbulb,
  Loader2,
  MessageCircle,
  Moon,
  RefreshCw,
  Search,
  Send,
  ThumbsDown,
  X,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { useWikiStore } from "@/stores/wiki-store"
import { useInspirationStore } from "@/stores/inspiration-store"
import type { IdeaStage, InspirationAskMessage, InspirationComment, InspirationEvolutionEvent, InspirationItem, InspirationTab } from "@/lib/inspiration-schema"
import { streamChat, type ChatMessage as LLMMessage } from "@/lib/llm-client"
import { hasUsableLlm } from "@/lib/has-usable-llm"
import { readFile } from "@/commands/fs"
import { loadInspirationAskMessages, saveInspirationAskMessages } from "@/lib/inspiration-persist"
import { KnowledgeThreadTab } from "@/components/inspiration/knowledge-thread-tab"
import { queueResearch } from "@/lib/deep-research"
import { normalizePath } from "@/lib/path-utils"
import { useTranslation } from "react-i18next"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import remarkMath from "remark-math"

const TABS: { id: InspirationTab; label: string; icon: typeof Lightbulb }[] = [
  { id: "threads", label: "inspiration.tabs.knowledgeThreads", icon: GitBranch },
  { id: "daily", label: "inspiration.tabs.factory", icon: Lightbulb },
  { id: "themes", label: "inspiration.tabs.themeLab", icon: FlaskConical },
  { id: "dreams", label: "inspiration.tabs.dreamLab", icon: Moon },
  { id: "feedback", label: "inspiration.tabs.outcomes", icon: Brain },
]

const ITEMS_PER_PAGE = 10

function formatTime(ts: number): string {
  return new Date(ts).toLocaleString()
}

function typeLabel(t: (key: string, options?: { defaultValue?: string }) => string, item: InspirationItem): string {
  return t(`inspiration.itemTypes.${item.type}`, { defaultValue: item.type })
}

function creativeTypeLabel(t: (key: string, options?: { defaultValue?: string }) => string, item: InspirationItem): string {
  const creativeType = item.creativeType ?? (item.type === "dream" ? "dream_idea" : item.type === "theme" ? "topic_idea" : "idea")
  return t(`inspiration.creativeTypes.${creativeType}`, { defaultValue: creativeType })
}

function routeLabel(t: (key: string, options?: { defaultValue?: string }) => string, item: InspirationItem): string {
  if (!item.routingTarget) return ""
  return t(`inspiration.routes.${item.routingTarget}`, { defaultValue: item.routingTarget })
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

function eventTypeLabel(t: (key: string, options?: { defaultValue?: string }) => string, event: InspirationEvolutionEvent): string {
  return t(`inspiration.evolution.types.${event.changeType}`, { defaultValue: event.changeType })
}

function getEvolutionEvents(
  item: InspirationItem,
  t: (key: string, options?: { defaultValue?: string }) => string,
  markdownEvents: InspirationEvolutionEvent[] = [],
): InspirationEvolutionEvent[] {
  const events = [...(item.evolutionEvents ?? [])].sort((a, b) => a.iteration - b.iteration || a.changedAt - b.changedAt)
  if (markdownEvents.length > events.length) return markdownEvents
  if (events.length > 0) return events
  return [{
    id: `${item.id}-current-snapshot`,
    itemId: item.id,
    iteration: item.evolutionCount ?? 0,
    title: item.title,
    summary: item.summary,
    changeType: "created",
    changedAt: item.updatedAt ?? item.createdAt,
    updatedBy: "system",
    stage: item.ideaStage,
    dreamStatus: item.dreamStatus,
    keyChanges: [
      item.type === "dream" ? t("inspiration.evolution.currentDreamSnapshot") : t("inspiration.evolution.currentVersionSnapshot"),
      item.lifecycleStatus ? `status: ${item.lifecycleStatus}` : "",
      item.version ? `version: ${item.version}` : "",
    ].filter(Boolean),
    details: item.body || item.summary,
    evidenceChain: (item.evidence ?? []).slice(0, 6),
    score: item.type === "dream" ? item.dreamScore : item.scores.final,
  }]
}

function stripMarkdown(markdown: string): string[] {
  return markdown
    .split("\n")
    .map((line) => line.replace(/^#{1,6}\s*/, "").replace(/^[-*]\s*/, "").trim())
    .filter(Boolean)
    .slice(0, 8)
}

function parseDatedMarkdownBlocks(section: string): Array<{ timestamp: string; body: string }> {
  const matches = [...section.matchAll(/^###\s+(.+?)\s*$/gm)]
  return matches.map((match, index) => {
    const start = (match.index ?? 0) + match[0].length
    const end = index + 1 < matches.length ? matches[index + 1].index ?? section.length : section.length
    return {
      timestamp: match[1].trim(),
      body: section.slice(start, end).trim(),
    }
  }).filter((block) => block.body.length > 0)
}

function markdownSection(markdown: string, heading: string): string {
  const start = markdown.indexOf(heading)
  if (start < 0) return ""
  const rest = markdown.slice(start + heading.length)
  const next = rest.search(/\n##\s+/)
  return next >= 0 ? rest.slice(0, next) : rest
}

function parseMarkdownEvolutionEvents(item: InspirationItem, markdown: string): InspirationEvolutionEvent[] {
  const rawBlocks = [
    ...parseDatedMarkdownBlocks(markdownSection(markdown, "## Evolution Log")).map((block) => ({ ...block, type: "expand" as const })),
    ...parseDatedMarkdownBlocks(markdownSection(markdown, "## Dream Continuation")).map((block) => ({ ...block, type: "dream" as const })),
    ...parseDatedMarkdownBlocks(markdownSection(markdown, "## Final Dream Conclusion")).map((block) => ({ ...block, type: "conclude" as const })),
  ].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp))
  return rawBlocks.map((block, index) => {
    const changedAt = Date.parse(block.timestamp)
    return {
      id: `${item.id}-markdown-evolution-${index + 1}`,
      itemId: item.id,
      iteration: index + 1,
      title: `${item.title} · ${index + 1}`,
      summary: stripMarkdown(block.body).slice(0, 2).join(" ") || item.summary,
      changeType: block.type,
      changedAt: Number.isFinite(changedAt) ? changedAt : item.updatedAt ?? item.createdAt,
      updatedBy: "LLM",
      stage: item.ideaStage,
      dreamStatus: item.dreamStatus,
      keyChanges: stripMarkdown(block.body),
      details: block.body,
      evidenceChain: (item.evidence ?? []).slice(0, 6),
      score: item.type === "dream" ? item.dreamScore : item.scores.final,
    }
  })
}

function EvolutionGraphDialog({
  item,
  open,
  onOpenChange,
}: {
  item: InspirationItem | null
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { t } = useTranslation()
  const [markdownEvents, setMarkdownEvents] = useState<InspirationEvolutionEvent[]>([])

  useEffect(() => {
    let cancelled = false
    async function loadMarkdownEvents() {
      if (!item?.markdownPath) {
        setMarkdownEvents([])
        return
      }
      try {
        const markdown = await readFile(item.markdownPath)
        if (!cancelled) setMarkdownEvents(parseMarkdownEvolutionEvents(item, markdown))
      } catch {
        if (!cancelled) setMarkdownEvents([])
      }
    }
    if (open) void loadMarkdownEvents()
    return () => {
      cancelled = true
    }
  }, [item, open])

  const events = item ? getEvolutionEvents(item, t, markdownEvents) : []
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[82vh] max-h-[82vh] grid-rows-none flex-col overflow-hidden sm:max-w-4xl">
        <DialogHeader className="shrink-0 pr-8">
          <DialogTitle>{t("inspiration.evolution.title")}</DialogTitle>
          <DialogDescription>
            {item ? t("inspiration.evolution.description", { title: item.title }) : ""}
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden pr-1">
          <div className="mb-4 grid gap-2 sm:grid-cols-3">
            <div className="rounded-lg border bg-muted/30 p-3">
              <div className="text-[11px] text-muted-foreground">{t("inspiration.evolution.totalIterations")}</div>
              <div className="text-2xl font-semibold">{item?.evolutionCount ?? 0}</div>
            </div>
            <div className="rounded-lg border bg-muted/30 p-3">
              <div className="text-[11px] text-muted-foreground">{t("inspiration.evolution.currentStage")}</div>
              <div className="truncate text-sm font-medium">
                {item?.type === "dream" ? item.dreamStatus ?? "-" : stageLabel(t, item?.ideaStage)}
              </div>
            </div>
            <div className="rounded-lg border bg-muted/30 p-3">
              <div className="text-[11px] text-muted-foreground">{t("inspiration.evolution.evidenceCount")}</div>
              <div className="text-2xl font-semibold">{item?.evidence?.length ?? 0}</div>
            </div>
          </div>

          <div className="relative space-y-4 pl-5">
            <div className="absolute left-[0.95rem] top-2 bottom-2 w-px bg-border" />
            {events.map((event, index) => (
              <div key={event.id} className="relative">
                <div className="absolute -left-5 top-2 flex h-8 w-8 items-center justify-center rounded-full border bg-background text-xs font-semibold text-primary shadow-sm">
                  {index + 1}
                </div>
                <div className="ml-5 rounded-lg border bg-background p-3 shadow-sm">
                  <div className="mb-2 flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="mb-1 flex flex-wrap items-center gap-1.5">
                        <span className="rounded-md bg-primary/10 px-1.5 py-0.5 text-[11px] font-medium text-primary">
                          {eventTypeLabel(t, event)}
                        </span>
                        <span className="rounded-md bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
                          {t("inspiration.evolution.iteration", { count: event.iteration })}
                        </span>
                        {typeof event.score === "number" && (
                          <span className="rounded-md bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
                            {t("inspiration.evolution.score", { score: scorePercent(event.score) })}
                          </span>
                        )}
                      </div>
                      <h3 className="line-clamp-2 text-sm font-semibold">{event.title}</h3>
                      <div className="mt-1 text-[11px] text-muted-foreground">{formatTime(event.changedAt)} / {event.updatedBy}</div>
                    </div>
                  </div>
                  <p className="mb-3 text-sm text-muted-foreground">{event.summary}</p>
                  <div className="mb-3">
                    <div className="mb-1 text-[11px] font-medium text-muted-foreground">{t("inspiration.evolution.keyChanges")}</div>
                    <div className="grid gap-1">
                      {(event.keyChanges.length > 0 ? event.keyChanges : [t("inspiration.evolution.noChanges")]).map((change, changeIndex) => (
                        <div key={`${event.id}-change-${changeIndex}`} className="rounded-md bg-muted/50 px-2 py-1 text-xs">
                          {change}
                        </div>
                      ))}
                    </div>
                  </div>
                  {event.details && (
                    <div className="mb-3">
                      <div className="mb-1 text-[11px] font-medium text-muted-foreground">{t("inspiration.evolution.details")}</div>
                      <div className="max-h-64 overflow-auto whitespace-pre-wrap rounded-md border bg-muted/20 px-2 py-2 text-xs leading-relaxed">
                        {event.details}
                      </div>
                    </div>
                  )}
                  <div>
                    <div className="mb-1 text-[11px] font-medium text-muted-foreground">{t("inspiration.evolution.evidenceChain")}</div>
                    {event.evidenceChain.length === 0 ? (
                      <div className="rounded-md border border-dashed px-2 py-2 text-xs text-muted-foreground">
                        {t("inspiration.evolution.noEvidence")}
                      </div>
                    ) : (
                      <div className="flex flex-wrap gap-1.5">
                        {event.evidenceChain.map((evidence, evidenceIndex) => (
                          <span
                            key={`${event.id}-${evidence.id}-${evidenceIndex}`}
                            className="max-w-full truncate rounded-md border bg-muted/40 px-2 py-1 text-[11px] text-muted-foreground"
                            title={`${evidence.title}: ${evidence.snippet}`}
                          >
                            {evidenceIndex + 1}. {evidence.title}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function buildAskContext(
  item: InspirationItem,
  comments: InspirationComment[],
  events: InspirationEvolutionEvent[],
  markdown: string,
): string {
  const evidence = (item.evidence ?? [])
    .slice(0, 12)
    .map((e, index) => `${index + 1}. ${e.title} (${e.role}, ${Math.round(e.relevanceScore * 100)}): ${e.snippet}\n${e.pagePath}`)
    .join("\n")
  const userComments = comments
    .slice(0, 12)
    .map((comment, index) => `${index + 1}. ${new Date(comment.createdAt).toISOString()}: ${comment.body}`)
    .join("\n")
  const evolution = events
    .slice(-8)
    .map((event) => [
      `Iteration ${event.iteration}: ${event.title}`,
      `Type: ${event.changeType}; summary: ${event.summary}`,
      event.details ? `Details:\n${event.details.slice(0, 2500)}` : "",
    ].filter(Boolean).join("\n"))
    .join("\n\n")
  return [
    `Item type: ${item.type}`,
    `Title: ${item.title}`,
    `Summary: ${item.summary}`,
    `Status: ${item.lifecycleStatus ?? "idle"} / ${item.reviewState}`,
    `Stage: ${item.ideaStage ?? "n/a"}`,
    `Dream status: ${item.dreamStatus ?? "n/a"}`,
    "",
    "Evidence chain:",
    evidence || "(No evidence recorded.)",
    "",
    "User comments:",
    userComments || "(No user comments.)",
    "",
    "Evolution history:",
    evolution || "(No evolution history.)",
    "",
    "Current markdown:",
    markdown.slice(0, 10000),
  ].join("\n")
}

function AskItemDialog({
  item,
  comments,
  projectPath,
  llmConfig,
  open,
  onOpenChange,
}: {
  item: InspirationItem | null
  comments: InspirationComment[]
  projectPath?: string
  llmConfig: ReturnType<typeof useWikiStore.getState>["llmConfig"]
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { t } = useTranslation()
  const [question, setQuestion] = useState("")
  const [messages, setMessages] = useState<InspirationAskMessage[]>([])
  const [streaming, setStreaming] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    async function loadHistory() {
      if (!projectPath || !item) {
        setMessages([])
        return
      }
      const history = await loadInspirationAskMessages(projectPath, item.id).catch(() => [])
      if (!cancelled) setMessages(history)
    }
    if (open) {
      setQuestion("")
      setError(null)
      setStreaming(false)
      void loadHistory()
    }
    return () => {
      cancelled = true
    }
  }, [item, open, projectPath])

  async function ask() {
    if (!item || !projectPath || !question.trim() || streaming) return
    if (!hasUsableLlm(llmConfig)) {
      setError(t("inspiration.ask.noModel"))
      return
    }
    const userQuestion = question.trim()
    const now = Date.now()
    const userMessage: InspirationAskMessage = { id: `ask-user-${now}`, itemId: item.id, role: "user", content: userQuestion, createdAt: now }
    const assistantId = `ask-assistant-${Date.now()}`
    const assistantMessage: InspirationAskMessage = { id: assistantId, itemId: item.id, role: "assistant", content: "", createdAt: now + 1 }
    const baseMessages = [...messages, userMessage, assistantMessage]
    setMessages(baseMessages)
    setQuestion("")
    setStreaming(true)
    setError(null)

    try {
      await saveInspirationAskMessages(projectPath, item.id, baseMessages).catch(() => {})
      const markdown = await readFile(item.markdownPath).catch(() => item.body)
      const markdownEvents = parseMarkdownEvolutionEvents(item, markdown)
      const events = getEvolutionEvents(item, t, markdownEvents)
      const context = buildAskContext(item, comments, events, markdown)
      const history: LLMMessage[] = messages.slice(-8).map((message) => ({
        role: message.role,
        content: message.content,
      }))
      let assistantContent = ""
      const llmMessages: LLMMessage[] = [
        {
          role: "system",
          content: [
            "You are an AI explainer inside an inspiration system.",
            "Answer only about the current idea, theme, or dream unless the user explicitly asks for adjacent context.",
            "Use the provided evidence chain, user comments, evolution history, and markdown.",
            "Be clear, practical, and trace claims back to evidence or evolution steps when useful.",
            "If evidence is insufficient, say what is missing instead of inventing facts.",
          ].join("\n"),
        },
        {
          role: "user",
          content: [
            "Current item context:",
            context,
            "",
            "Conversation so far follows. Answer the latest user question.",
          ].join("\n"),
        },
        ...history,
        { role: "user", content: userQuestion },
      ]
      await streamChat(
        llmConfig,
        llmMessages,
        {
          onToken: (token) => {
            assistantContent += token
            setMessages((prev) => prev.map((message) =>
              message.id === assistantId ? { ...message, content: message.content + token } : message,
            ))
          },
          onDone: () => {
            setStreaming(false)
            const finalMessages = baseMessages.map((message) =>
              message.id === assistantId ? { ...message, content: assistantContent } : message,
            )
            setMessages(finalMessages)
            void saveInspirationAskMessages(projectPath, item.id, finalMessages)
          },
          onError: (err) => {
            setError(err.message)
            setStreaming(false)
            const finalMessages = baseMessages.map((message) =>
              message.id === assistantId ? { ...message, content: assistantContent || err.message } : message,
            )
            setMessages(finalMessages)
            void saveInspirationAskMessages(projectPath, item.id, finalMessages)
          },
        },
        undefined,
        { temperature: 0.35 },
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setStreaming(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[78vh] max-h-[78vh] grid-rows-none flex-col overflow-hidden sm:max-w-3xl">
        <DialogHeader className="shrink-0 pr-8">
          <DialogTitle>{t("inspiration.ask.title")}</DialogTitle>
          <DialogDescription>
            {item ? t("inspiration.ask.description", { title: item.title }) : ""}
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
          {messages.length === 0 ? (
            <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
              {t("inspiration.ask.empty")}
            </div>
          ) : (
            messages.map((message) => (
              <div
                key={message.id}
                className={message.role === "user"
                  ? "ml-auto max-w-[85%] rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground"
                  : "mr-auto max-w-[90%] rounded-lg border bg-muted/40 px-3 py-2 text-sm"}
              >
                {message.role === "assistant" ? (
                  message.content ? (
                    <div className="prose prose-sm max-w-none dark:prose-invert prose-p:my-2 prose-ul:my-2 prose-ol:my-2 prose-pre:my-2 prose-pre:overflow-auto prose-code:break-words">
                      <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]}>
                        {message.content}
                      </ReactMarkdown>
                    </div>
                  ) : (
                    t("inspiration.ask.thinking")
                  )
                ) : (
                  <div className="whitespace-pre-wrap">{message.content}</div>
                )}
              </div>
            ))
          )}
          {error && (
            <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
              {error}
            </div>
          )}
        </div>
        <div className="shrink-0 border-t pt-3">
          <div className="flex gap-2">
            <Input
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
              placeholder={t("inspiration.ask.placeholder")}
              disabled={streaming}
              onKeyDown={(event) => {
                if (event.key === "Enter") void ask()
              }}
            />
            <Button onClick={ask} disabled={!question.trim() || streaming || !item || !projectPath}>
              {streaming ? <Loader2 className="animate-spin" /> : <Send />}
              {t("inspiration.ask.send")}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function ItemCard({
  item,
  onOpen,
  onFeedback,
  onResearch,
  onIterate,
  onDreamContinue,
  onDreamConclude,
  onShowEvolution,
  onAsk,
  dreamMaxIterations,
  isLiked,
  isSaved,
  isAdopted,
  isDisliked,
  isEvolving,
  comments,
  commentDraft,
  onCommentDraft,
  onComment,
}: {
  item: InspirationItem
  onOpen: (item: InspirationItem) => void
  onFeedback: (item: InspirationItem, action: "like" | "unlike" | "dislike" | "undislike" | "save" | "unsave" | "promote" | "unpromote" | "reject") => void
  onResearch: (item: InspirationItem) => void
  onIterate: (item: InspirationItem) => void
  onDreamContinue: (item: InspirationItem) => void
  onDreamConclude: (item: InspirationItem) => void
  onShowEvolution: (item: InspirationItem) => void
  onAsk: (item: InspirationItem) => void
  dreamMaxIterations: number
  isLiked: boolean
  isSaved: boolean
  isAdopted: boolean
  isDisliked: boolean
  isEvolving: boolean
  comments: InspirationComment[]
  commentDraft: string
  onCommentDraft: (item: InspirationItem, value: string) => void
  onComment: (item: InspirationItem) => void
}) {
  const { t } = useTranslation()
  const recentComments = comments.slice(0, 3)
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
            <span className="rounded-md bg-secondary px-1.5 py-0.5 text-[11px] text-secondary-foreground">
              {creativeTypeLabel(t, item)}
            </span>
            {item.routingTarget && (
              <span className="rounded-md bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
                {routeLabel(t, item)}
              </span>
            )}
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
      {item.methodologies?.length ? (
        <div className="mb-3 flex flex-wrap gap-1.5">
          {item.methodologies.slice(0, 4).map((methodology) => (
            <span key={methodology} className="rounded-full border bg-background px-2 py-0.5 text-[10px] text-muted-foreground">
              {t(`inspiration.methodologies.${methodology}`, { defaultValue: methodology })}
            </span>
          ))}
        </div>
      ) : null}
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
          <span>{t("inspiration.card.dreamIterations", { count: item.evolutionCount ?? 0, max: dreamMaxIterations })}</span>
          <span>{t("inspiration.card.updated")} {formatTime(item.updatedAt ?? item.createdAt)}</span>
          <span>{t("inspiration.card.dreamMode")} {item.dreamMode ? t(`inspiration.dreamModes.${item.dreamMode}`, { defaultValue: item.dreamMode }) : "-"}</span>
          <span>{t("inspiration.card.fragments", { count: item.dreamFragments?.length ?? 0 })}</span>
          <span>{t("inspiration.card.dreamScore")} {typeof item.dreamScore === "number" ? scorePercent(item.dreamScore) : "-"}</span>
        </div>
      )}
      {recentComments.length > 0 && (
        <div className="mt-3 rounded-md border bg-muted/30 p-2">
          <div className="mb-1 text-[11px] font-medium text-muted-foreground">
            {t("inspiration.comments.recent")}
          </div>
          <div className="space-y-1">
            {recentComments.map((comment) => (
              <div key={comment.id} className="rounded-md bg-background/80 px-2 py-1">
                <div className="text-[10px] text-muted-foreground">{formatTime(comment.createdAt)}</div>
                <div className="line-clamp-2 whitespace-pre-wrap text-xs text-foreground">{comment.body}</div>
              </div>
            ))}
          </div>
          {comments.length > recentComments.length && (
            <div className="mt-1 text-[10px] text-muted-foreground">
              {t("inspiration.comments.more", { count: comments.length - recentComments.length })}
            </div>
          )}
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
        <Button variant="ghost" size="icon-xs" title={t("inspiration.actions.evolutionGraph")} onClick={() => onShowEvolution(item)}>
          <GitBranch />
        </Button>
        <Button variant="ghost" size="icon-xs" title={t("inspiration.actions.askAi")} onClick={() => onAsk(item)}>
          <MessageCircle />
        </Button>
        {(item.type === "idea" || item.type === "theme") && (
          <Button variant="ghost" size="icon-xs" title={t("inspiration.actions.iterate")} onClick={() => onIterate(item)} disabled={isEvolving}>
            {isEvolving ? <Loader2 className="animate-spin" /> : <RefreshCw />}
          </Button>
        )}
        {item.type === "dream" && (
          <>
            <Button variant="ghost" size="icon-xs" title={t("inspiration.actions.continueDream")} onClick={() => onDreamContinue(item)} disabled={isEvolving}>
              {isEvolving ? <Loader2 className="animate-spin" /> : <Moon />}
            </Button>
            <Button variant="ghost" size="icon-xs" title={t("inspiration.actions.concludeDream")} onClick={() => onDreamConclude(item)} disabled={isEvolving}>
              {isEvolving ? <Loader2 className="animate-spin" /> : <Brain />}
            </Button>
          </>
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
  const inspirationConfig = useWikiStore((s) => s.inspirationConfig)
  const setSelectedFile = useWikiStore((s) => s.setSelectedFile)
  const setFileContent = useWikiStore((s) => s.setFileContent)
  const bumpDataVersion = useWikiStore((s) => s.bumpDataVersion)

  const {
    runs,
    items,
    feedback,
    comments,
    runningByType,
    statusByType,
    activeStatus,
    error,
    load,
    run,
    addFeedback,
    addComment,
    evolveItem,
    continueDreamItem,
    concludeDreamItem,
    markThemeLabExploring,
    exploreExistingThemes,
  } = useInspirationStore()

  const [tab, setTab] = useState<InspirationTab>("threads")
  const [topic, setTopic] = useState("")
  const [commentDrafts, setCommentDrafts] = useState<Record<string, string>>({})
  const [dreamPickerOpen, setDreamPickerOpen] = useState(false)
  const [selectedDreamSeeds, setSelectedDreamSeeds] = useState<string[]>([])
  const [evolutionItem, setEvolutionItem] = useState<InspirationItem | null>(null)
  const [askItem, setAskItem] = useState<InspirationItem | null>(null)
  const [pageByTab, setPageByTab] = useState<Partial<Record<InspirationTab, number>>>({})

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

  const commentsByItem = useMemo(() => {
    const grouped = new Map<string, InspirationComment[]>()
    for (const comment of comments) {
      const list = grouped.get(comment.itemId) ?? []
      list.push(comment)
      grouped.set(comment.itemId, list)
    }
    for (const list of grouped.values()) {
      list.sort((a, b) => b.createdAt - a.createdAt)
    }
    return grouped
  }, [comments])

  useEffect(() => {
    if (project) void load(project.path)
  }, [load, project])

  const factoryItems = useMemo(() => items.filter((item) =>
    item.origin === "factory" &&
    item.type === "idea" &&
    item.reviewState !== "formal" &&
    item.reviewState !== "rejected" &&
    item.ideaStage !== "adopted" &&
    item.ideaStage !== "archived",
  ), [items])

  const visibleItems = useMemo(() => {
    if (tab === "daily") return factoryItems
    if (tab === "themes") return items.filter((item) => item.origin === "theme_lab" && item.reviewState !== "formal" && item.reviewState !== "rejected")
    if (tab === "dreams") return items.filter((item) => item.origin === "dream" && item.reviewState !== "formal" && item.reviewState !== "rejected")
    if (tab === "threads") return []
    return items.filter((item) => item.reviewState === "formal" || item.origin === "adopted")
  }, [factoryItems, items, tab])

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
    for (const item of factoryItems) {
      const stage = item.ideaStage ?? (item.reviewState === "formal" ? "adopted" : item.reviewState === "rejected" ? "archived" : "candidate")
      stats[stage] += 1
    }
    return stats
  }, [factoryItems])

  const currentPage = pageByTab[tab] ?? 0
  const paginatedTabs = tab === "daily" || tab === "themes" || tab === "dreams"
  const totalItemPages = Math.max(1, Math.ceil(visibleItems.length / ITEMS_PER_PAGE))
  const safePage = Math.min(currentPage, totalItemPages - 1)
  const pageItems = paginatedTabs
    ? visibleItems.slice(safePage * ITEMS_PER_PAGE, (safePage + 1) * ITEMS_PER_PAGE)
    : visibleItems

  useEffect(() => {
    if (currentPage > totalItemPages - 1) {
      setPageByTab((prev) => ({ ...prev, [tab]: totalItemPages - 1 }))
    }
  }, [currentPage, tab, totalItemPages])

  function setCurrentPage(nextPage: number) {
    setPageByTab((prev) => ({
      ...prev,
      [tab]: Math.max(0, Math.min(totalItemPages - 1, nextPage)),
    }))
  }

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

  async function handleDreamContinue(item: InspirationItem) {
    if (!project || item.type !== "dream") return
    await continueDreamItem(project.path, llmConfig, item.id)
  }

  async function handleDreamConclude(item: InspirationItem) {
    if (!project || item.type !== "dream") return
    await concludeDreamItem(project.path, llmConfig, item.id)
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

        {tab === "threads" && <KnowledgeThreadTab />}

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

        {runningByType[tab === "daily" ? "daily" : tab === "themes" ? "theme" : tab === "dreams" ? "dream" : "daily"] && tab !== "feedback" && tab !== "threads" && (
          <div className="mb-4 flex items-center gap-2 rounded-lg border bg-muted/40 p-3 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            {t("inspiration.runningCurrent", { status: statusByType[tab === "daily" ? "daily" : tab === "themes" ? "theme" : "dream"] ?? activeStatus ?? "queued" })}
          </div>
        )}

        {tab !== "threads" && (visibleItems.length === 0 ? (
          <div className="flex min-h-[260px] flex-col items-center justify-center gap-2 rounded-lg border border-dashed text-center text-sm text-muted-foreground">
            <Lightbulb className="h-8 w-8 opacity-40" />
            <p>{tab === "feedback" ? t("inspiration.empty.outcomes") : t("inspiration.empty.module")}</p>
          </div>
        ) : (
          <>
            {paginatedTabs && totalItemPages > 1 && (
              <div className="mb-3 flex items-center justify-between rounded-lg border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                <span>
                  {t("inspiration.pagination.summary", {
                    page: safePage + 1,
                    total: totalItemPages,
                    count: visibleItems.length,
                    defaultValue: `Page ${safePage + 1}/${totalItemPages} · ${visibleItems.length} items`,
                  })}
                </span>
                <div className="flex items-center gap-1">
                  <Button variant="outline" size="icon-xs" onClick={() => setCurrentPage(safePage - 1)} disabled={safePage === 0}>
                    <ChevronLeft />
                  </Button>
                  <Button variant="outline" size="icon-xs" onClick={() => setCurrentPage(safePage + 1)} disabled={safePage >= totalItemPages - 1}>
                    <ChevronRight />
                  </Button>
                </div>
              </div>
            )}
            <div className="grid gap-3 xl:grid-cols-2 2xl:grid-cols-3">
              {pageItems.filter(Boolean).map((item) => (
                <ItemCard
                  key={item.id}
                  item={item}
                  onOpen={handleOpen}
                  onFeedback={handleFeedback}
                  onResearch={handleResearch}
                  onIterate={handleIterate}
                  onDreamContinue={handleDreamContinue}
                  onDreamConclude={handleDreamConclude}
                  onShowEvolution={setEvolutionItem}
                  onAsk={setAskItem}
                  dreamMaxIterations={inspirationConfig.dreamMaxIterations}
                  isLiked={feedbackState.liked.has(item.id)}
                  isSaved={feedbackState.saved.has(item.id)}
                  isAdopted={feedbackState.adopted.has(item.id)}
                  isDisliked={feedbackState.disliked.has(item.id)}
                  isEvolving={item.lifecycleStatus === "evolving"}
                  comments={commentsByItem.get(item.id) ?? []}
                  commentDraft={commentDrafts[item.id] ?? ""}
                  onCommentDraft={handleCommentDraft}
                  onComment={handleComment}
                />
              ))}
            </div>
          </>
        ))}
      </div>
      <EvolutionGraphDialog
        item={evolutionItem}
        open={!!evolutionItem}
        onOpenChange={(open) => {
          if (!open) setEvolutionItem(null)
        }}
      />
      <AskItemDialog
        item={askItem}
        comments={askItem ? commentsByItem.get(askItem.id) ?? [] : []}
        projectPath={project?.path}
        llmConfig={llmConfig}
        open={!!askItem}
        onOpenChange={(open) => {
          if (!open) setAskItem(null)
        }}
      />
    </div>
  )
}
