import { create } from "zustand"
import { appendInspirationComment, appendInspirationFeedback, loadInspirationSnapshot, saveInspirationSnapshot, upsertRun } from "@/lib/inspiration-persist"
import { runInspiration } from "@/lib/inspiration-runner"
import { evolveIdeas, evolveInspirationItem } from "@/lib/idea-evolution"
import { continueDreams } from "@/lib/dream-evolution"
import { queueResearch } from "@/lib/deep-research"
import { useWikiStore } from "@/stores/wiki-store"
import type {
  InspirationFeedback,
  InspirationComment,
  InspirationItem,
  InspirationRun,
  InspirationRunType,
  InspirationSnapshot,
  InspirationTaskStatus,
  InspirationTriggerType,
} from "@/lib/inspiration-schema"
import type { LlmConfig } from "@/stores/wiki-store"

interface InspirationState {
  runs: InspirationRun[]
  items: InspirationItem[]
  feedback: InspirationFeedback[]
  comments: InspirationComment[]
  loading: boolean
  runningByType: Partial<Record<InspirationRunType, boolean>>
  statusByType: Partial<Record<InspirationRunType, InspirationTaskStatus>>
  evolving: boolean
  evolvingItemIds: string[]
  activeTaskId: string | null
  activeStatus: InspirationTaskStatus | null
  error: string | null

  load: (projectPath: string) => Promise<void>
  run: (
    projectPath: string,
    llmConfig: LlmConfig,
    runType: InspirationRunType,
    triggerType: InspirationTriggerType,
    topic?: string,
  ) => Promise<void>
  addFeedback: (
    projectPath: string,
    itemId: string,
    action: InspirationFeedback["action"],
    reasonCode?: string,
  ) => Promise<void>
  evolve: (projectPath: string, llmConfig: LlmConfig) => Promise<void>
  evolveItem: (projectPath: string, llmConfig: LlmConfig, itemId: string) => Promise<void>
  exploreExistingThemes: (projectPath: string, llmConfig: LlmConfig) => Promise<void>
  continueDreams: (projectPath: string, llmConfig: LlmConfig) => Promise<void>
  addComment: (projectPath: string, itemId: string, body: string) => Promise<void>
  markThemeLabExploring: (projectPath: string) => Promise<void>
  setSnapshot: (snapshot: InspirationSnapshot) => void
}

function feedbackId(): string {
  return `feedback-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

let itemEvolutionQueue: Promise<void> = Promise.resolve()

export const useInspirationStore = create<InspirationState>((set, get) => ({
  runs: [],
  items: [],
  feedback: [],
  comments: [],
  loading: false,
  runningByType: {},
  statusByType: {},
  evolving: false,
  evolvingItemIds: [],
  activeTaskId: null,
  activeStatus: null,
  error: null,

  setSnapshot: (snapshot) => set({
    runs: snapshot.runs,
    items: snapshot.items,
    feedback: snapshot.feedback,
    comments: snapshot.comments,
  }),

  load: async (projectPath) => {
    set({ loading: true, error: null })
    try {
      const snapshot = await loadInspirationSnapshot(projectPath)
      set({
        runs: snapshot.runs,
        items: snapshot.items,
        feedback: snapshot.feedback,
        comments: snapshot.comments,
        loading: false,
      })
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : String(err) })
    }
  },

  run: async (projectPath, llmConfig, runType, triggerType, topic) => {
    if (get().runningByType[runType]) return
    set((state) => ({
      loading: true,
      runningByType: { ...state.runningByType, [runType]: true },
      statusByType: { ...state.statusByType, [runType]: "queued" },
      error: null,
      activeStatus: "queued",
    }))
    const snapshot = await loadInspirationSnapshot(projectPath)
    try {
      const result = await runInspiration(projectPath, llmConfig, useWikiStore.getState().inspirationConfig, runType, triggerType, topic, {
        onRunUpdate: async (run) => {
          set((state) => ({
            activeTaskId: run.id,
            activeStatus: run.status,
            statusByType: { ...state.statusByType, [run.runType]: run.status },
            runs: [run, ...state.runs.filter((r) => r.id !== run.id)],
          }))
        },
      })
      const next = upsertRun({
        ...snapshot,
        items: [
          ...result.items,
          ...snapshot.items.map((item) =>
            runType === "theme" && item.origin === "theme_lab" && item.lifecycleStatus === "exploring"
              ? { ...item, lifecycleStatus: "done" as const }
              : item,
          ),
        ].slice(0, 500),
      }, result.run)
      await saveInspirationSnapshot(projectPath, next)
      set((state) => ({
        runs: next.runs,
        items: next.items,
        feedback: next.feedback,
        comments: next.comments,
        runningByType: { ...state.runningByType, [runType]: false },
        statusByType: { ...state.statusByType, [runType]: undefined },
        loading: Object.entries({ ...state.runningByType, [runType]: false }).some(([, v]) => v),
        activeTaskId: null,
        activeStatus: null,
      }))
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const activeTaskId = get().activeTaskId
      set((state) => ({
        runningByType: { ...state.runningByType, [runType]: false },
        statusByType: { ...state.statusByType, [runType]: "error" },
        loading: Object.entries({ ...state.runningByType, [runType]: false }).some(([, v]) => v),
        error: message,
        activeStatus: "error",
        runs: state.runs.map((run) =>
          run.id === activeTaskId
            ? { ...run, status: "error", error: message, finishedAt: Date.now() }
            : run,
        ),
      }))
    }
  },

  addFeedback: async (projectPath, itemId, action, reasonCode) => {
    const feedback: InspirationFeedback = {
      id: feedbackId(),
      itemId,
      action,
      reasonCode,
      createdAt: Date.now(),
    }
    const snapshot = await appendInspirationFeedback(projectPath, feedback)
    set({
      runs: snapshot.runs,
      items: snapshot.items,
      feedback: snapshot.feedback,
      comments: snapshot.comments,
    })
  },

  evolve: async (projectPath, llmConfig) => {
    if (get().evolving) return
    set({ evolving: true, activeStatus: "evolving", error: null })
    try {
      let snapshot = await evolveIdeas(projectPath, llmConfig)
      const wiki = useWikiStore.getState()
      if (wiki.inspirationConfig.autoDeepResearchEnabled) {
        const researched = new Set(snapshot.feedback.filter((f) => f.action === "research").map((f) => f.itemId))
        const candidate = snapshot.items.find((item) =>
          item.reviewState !== "rejected" &&
          item.reviewState !== "formal" &&
          !researched.has(item.id) &&
          (item.evidence.length < 2 || item.strategy === "gap" || item.type === "theme"),
        )
        if (candidate) {
          queueResearch(
            projectPath,
            candidate.title,
            llmConfig,
            wiki.searchApiConfig,
            [
              candidate.title,
              `${candidate.title} evidence gaps`,
              `${candidate.title} related work`,
            ],
          )
          await get().addFeedback(projectPath, candidate.id, "research", "auto-evolution")
          snapshot = await loadInspirationSnapshot(projectPath)
        }
      }
      set({
        runs: snapshot.runs,
        items: snapshot.items,
        feedback: snapshot.feedback,
        comments: snapshot.comments,
        evolving: false,
        activeStatus: null,
      })
      useWikiStore.getState().bumpDataVersion()
    } catch (err) {
      set({
        evolving: false,
        activeStatus: "error",
        error: err instanceof Error ? err.message : String(err),
      })
    }
  },

  evolveItem: async (projectPath, llmConfig, itemId) => {
    if (get().evolvingItemIds.includes(itemId)) return
    set((state) => ({
      evolving: true,
      evolvingItemIds: [...state.evolvingItemIds, itemId],
      activeStatus: "evolving",
      error: null,
      items: state.items.map((item) =>
        item.id === itemId ? { ...item, lifecycleStatus: "evolving" as const } : item,
      ),
    }))

    const task = itemEvolutionQueue.then(async () => {
      try {
        const snapshot = await evolveInspirationItem(projectPath, llmConfig, itemId)
        set((state) => {
          const remaining = state.evolvingItemIds.filter((id) => id !== itemId)
          return {
            runs: snapshot.runs,
            items: snapshot.items.map((item) =>
              remaining.includes(item.id)
                ? { ...item, lifecycleStatus: "evolving" as const }
                : item,
            ),
            feedback: snapshot.feedback,
            comments: snapshot.comments,
            evolvingItemIds: remaining,
            evolving: remaining.length > 0,
            activeStatus: remaining.length > 0 ? "evolving" : null,
          }
        })
        useWikiStore.getState().bumpDataVersion()
      } catch (err) {
        set((state) => {
          const remaining = state.evolvingItemIds.filter((id) => id !== itemId)
          return {
            evolvingItemIds: remaining,
            evolving: remaining.length > 0,
            activeStatus: remaining.length > 0 ? "evolving" : "error",
            error: err instanceof Error ? err.message : String(err),
            items: state.items.map((item) =>
              item.id === itemId ? { ...item, lifecycleStatus: "error" as const } : item,
            ),
          }
        })
      }
    })
    itemEvolutionQueue = task.catch(() => {})
    await task
  },

  exploreExistingThemes: async (projectPath, llmConfig) => {
    if (get().runningByType.theme) return
    set((state) => ({
      loading: true,
      runningByType: { ...state.runningByType, theme: true },
      statusByType: { ...state.statusByType, theme: "evolving" },
      activeStatus: "evolving",
      error: null,
    }))
    try {
      const snapshot = await loadInspirationSnapshot(projectPath)
      const themeLabIds = snapshot.items
        .filter((item) =>
          item.origin === "theme_lab" &&
          item.reviewState !== "formal" &&
          item.reviewState !== "rejected",
        )
        .map((item) => item.id)

      const exploring = {
        ...snapshot,
        items: snapshot.items.map((item) =>
          themeLabIds.includes(item.id)
            ? { ...item, lifecycleStatus: "exploring" as const, updatedAt: Date.now() }
            : item,
        ),
      }
      await saveInspirationSnapshot(projectPath, exploring)
      set({
        runs: exploring.runs,
        items: exploring.items,
        feedback: exploring.feedback,
        comments: exploring.comments,
      })

      const evolved = themeLabIds.length > 0
        ? await evolveIdeas(projectPath, llmConfig, themeLabIds.length, themeLabIds)
        : exploring
      const done = {
        ...evolved,
        items: evolved.items.map((item) =>
          themeLabIds.includes(item.id) && item.lifecycleStatus === "exploring"
            ? { ...item, lifecycleStatus: "done" as const, updatedAt: Date.now() }
            : item,
        ),
      }
      await saveInspirationSnapshot(projectPath, done)
      set((state) => ({
        runs: done.runs,
        items: done.items,
        feedback: done.feedback,
        comments: done.comments,
        loading: Object.entries({ ...state.runningByType, theme: false }).some(([, v]) => v),
        runningByType: { ...state.runningByType, theme: false },
        statusByType: { ...state.statusByType, theme: undefined },
        activeStatus: null,
      }))
      useWikiStore.getState().bumpDataVersion()
    } catch (err) {
      set((state) => ({
        loading: Object.entries({ ...state.runningByType, theme: false }).some(([, v]) => v),
        runningByType: { ...state.runningByType, theme: false },
        statusByType: { ...state.statusByType, theme: "error" },
        activeStatus: "error",
        error: err instanceof Error ? err.message : String(err),
      }))
    }
  },

  continueDreams: async (projectPath, llmConfig) => {
    if (get().evolving) return
    set({ evolving: true, activeStatus: "evolving", error: null })
    try {
      const snapshot = await continueDreams(projectPath, llmConfig)
      set({
        runs: snapshot.runs,
        items: snapshot.items,
        feedback: snapshot.feedback,
        comments: snapshot.comments,
        evolving: false,
        activeStatus: null,
      })
      useWikiStore.getState().bumpDataVersion()
    } catch (err) {
      set({
        evolving: false,
        activeStatus: "error",
        error: err instanceof Error ? err.message : String(err),
      })
    }
  },

  addComment: async (projectPath, itemId, body) => {
    const trimmed = body.trim()
    if (!trimmed) return
    const comment: InspirationComment = {
      id: feedbackId().replace("feedback", "comment"),
      itemId,
      body: trimmed,
      createdAt: Date.now(),
    }
    const snapshot = await appendInspirationComment(projectPath, comment)
    set({
      runs: snapshot.runs,
      items: snapshot.items,
      feedback: snapshot.feedback,
      comments: snapshot.comments,
    })
    const item = snapshot.items.find((i) => i.id === itemId)
    if (item && (item.type === "idea" || item.type === "theme")) {
      void get().evolveItem(projectPath, useWikiStore.getState().llmConfig, itemId)
    }
  },

  markThemeLabExploring: async (projectPath) => {
    const snapshot = await loadInspirationSnapshot(projectPath)
    const next = {
      ...snapshot,
      items: snapshot.items.map((item) =>
        item.origin === "theme_lab" && item.reviewState !== "formal" && item.reviewState !== "rejected"
          ? { ...item, lifecycleStatus: "exploring" as const, updatedAt: Date.now() }
          : item,
      ),
    }
    await saveInspirationSnapshot(projectPath, next)
    set({
      runs: next.runs,
      items: next.items,
      feedback: next.feedback,
      comments: next.comments,
    })
  },
}))
