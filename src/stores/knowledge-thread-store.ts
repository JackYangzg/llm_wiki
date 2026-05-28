import { create } from "zustand"
import type { LlmConfig } from "@/stores/wiki-store"
import {
  EMPTY_KNOWLEDGE_THREAD_BUNDLE,
  type KnowledgeThread,
  type KnowledgeThreadBundle,
  type KnowledgeThreadEdge,
  type KnowledgeThreadGap,
  type KnowledgeThreadNode,
  type KnowledgeThreadRelation,
  type ThreadMainlineStep,
  type ThreadNextDirection,
  type ThreadEvolutionInput,
  type ThreadEvolutionLog,
  type UserThreadContext,
} from "@/lib/knowledge-thread/types"
import { deleteKnowledgeThreadPermanently, loadKnowledgeThreadBundle } from "@/lib/knowledge-thread/storage"
import { runKnowledgeThreadEvolution } from "@/lib/knowledge-thread/evolution"

interface KnowledgeThreadState extends KnowledgeThreadBundle {
  selectedThreadId: string | null
  running: boolean
  runningThreadId: string | null
  error: string | null
  loadThreads: (projectPath: string) => Promise<void>
  selectThread: (id: string | null) => void
  deleteThread: (projectPath: string, id: string) => Promise<void>
  addUserContext: (
    projectPath: string,
    llmConfig: LlmConfig,
    content: string,
    target?: { type: "global" | "thread" | "node"; id?: string },
  ) => Promise<void>
  runEvolution: (
    projectPath: string,
    llmConfig: LlmConfig,
    input: ThreadEvolutionInput,
  ) => Promise<void>
}

function applyBundle(bundle: KnowledgeThreadBundle): Pick<
  KnowledgeThreadState,
  "threads" | "nodes" | "edges" | "gaps" | "contexts" | "logs"
  | "mainlineSteps" | "nextDirections" | "relations"
> {
  return {
    threads: bundle.threads,
    nodes: bundle.nodes,
    edges: bundle.edges,
    gaps: bundle.gaps,
    mainlineSteps: bundle.mainlineSteps,
    nextDirections: bundle.nextDirections,
    relations: bundle.relations,
    contexts: bundle.contexts,
    logs: bundle.logs,
  }
}

export const useKnowledgeThreadStore = create<KnowledgeThreadState>((set, get) => ({
  ...EMPTY_KNOWLEDGE_THREAD_BUNDLE,
  selectedThreadId: null,
  running: false,
  runningThreadId: null,
  error: null,

  loadThreads: async (projectPath) => {
    const bundle = await loadKnowledgeThreadBundle(projectPath)
    const selected = get().selectedThreadId
    const selectedStillExists = selected && bundle.threads.some((thread) => thread.id === selected)
    set({
      ...applyBundle(bundle),
      selectedThreadId: selectedStillExists ? selected : bundle.threads[0]?.id ?? null,
      error: null,
    })
  },

  selectThread: (selectedThreadId) => set({ selectedThreadId }),

  deleteThread: async (projectPath, id) => {
    const state = get()
    const bundle: KnowledgeThreadBundle = {
      threads: state.threads,
      nodes: state.nodes,
      edges: state.edges,
      gaps: state.gaps,
      mainlineSteps: state.mainlineSteps,
      nextDirections: state.nextDirections,
      relations: state.relations,
      contexts: state.contexts,
      logs: state.logs,
    }
    const next = await deleteKnowledgeThreadPermanently(projectPath, id, bundle)
    const selected = state.selectedThreadId === id ? next.threads[0]?.id ?? null : state.selectedThreadId
    set({
      ...applyBundle(next),
      selectedThreadId: selected && next.threads.some((thread) => thread.id === selected) ? selected : next.threads[0]?.id ?? null,
      error: null,
    })
  },

  addUserContext: async (projectPath, llmConfig, content, target) => {
    const trimmed = content.trim()
    if (!trimmed) return
    const context: UserThreadContext = {
      id: `ctx-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      targetType: target?.type ?? (get().selectedThreadId ? "thread" : "global"),
      targetId: target?.id ?? get().selectedThreadId ?? undefined,
      content: trimmed,
      effect: "direction_hint",
      createdAt: Date.now(),
    }
    await get().runEvolution(projectPath, llmConfig, {
      triggerType: "user_context_added",
      userContext: context,
      targetThreadId: context.targetType === "thread" ? context.targetId : undefined,
    })
  },

  runEvolution: async (projectPath, llmConfig, input) => {
    if (get().running) return
    set({ running: true, runningThreadId: input.targetThreadId ?? null, error: null })
    try {
      const bundle = await runKnowledgeThreadEvolution(projectPath, llmConfig, input)
      const selected = get().selectedThreadId
      const selectedStillExists = selected && bundle.threads.some((thread) => thread.id === selected)
      set({
        ...applyBundle(bundle),
        selectedThreadId: selectedStillExists ? selected : bundle.threads[0]?.id ?? null,
        running: false,
        runningThreadId: null,
        error: null,
      })
    } catch (err) {
      set({
        running: false,
        runningThreadId: null,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  },
}))

export type {
  KnowledgeThread,
  KnowledgeThreadNode,
  KnowledgeThreadEdge,
  KnowledgeThreadGap,
  KnowledgeThreadRelation,
  ThreadMainlineStep,
  ThreadNextDirection,
  ThreadEvolutionLog,
  UserThreadContext,
}
