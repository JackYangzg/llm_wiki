import { create } from "zustand"
import type { LlmConfig } from "@/stores/wiki-store"
import {
  EMPTY_KNOWLEDGE_THREAD_BUNDLE,
  type KnowledgeThread,
  type KnowledgeThreadBundle,
  type KnowledgeThreadEdge,
  type KnowledgeThreadGap,
  type KnowledgeThreadNode,
  type ThreadEvolutionInput,
  type ThreadEvolutionLog,
  type UserThreadContext,
} from "@/lib/knowledge-thread/types"
import { loadKnowledgeThreadBundle, saveKnowledgeThreadBundle } from "@/lib/knowledge-thread/storage"
import { runKnowledgeThreadEvolution } from "@/lib/knowledge-thread/evolution"

interface KnowledgeThreadState extends KnowledgeThreadBundle {
  selectedThreadId: string | null
  running: boolean
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
> {
  return {
    threads: bundle.threads,
    nodes: bundle.nodes,
    edges: bundle.edges,
    gaps: bundle.gaps,
    contexts: bundle.contexts,
    logs: bundle.logs,
  }
}

export const useKnowledgeThreadStore = create<KnowledgeThreadState>((set, get) => ({
  ...EMPTY_KNOWLEDGE_THREAD_BUNDLE,
  selectedThreadId: null,
  running: false,
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
    const removedNodeIds = new Set(state.nodes.filter((node) => node.threadId === id).map((node) => node.id))
    const next: KnowledgeThreadBundle = {
      threads: state.threads.filter((thread) => thread.id !== id),
      nodes: state.nodes.filter((node) => node.threadId !== id),
      edges: state.edges.filter((edge) =>
        edge.threadId !== id &&
        !removedNodeIds.has(edge.sourceNodeId) &&
        !removedNodeIds.has(edge.targetNodeId),
      ),
      gaps: state.gaps.filter((gap) => gap.threadId !== id),
      contexts: state.contexts.filter((context) => context.targetId !== id && !removedNodeIds.has(context.targetId ?? "")),
      logs: state.logs.filter((log) => !log.affectedThreadIds.includes(id)),
    }
    await saveKnowledgeThreadBundle(projectPath, next)
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
    set({ running: true, error: null })
    try {
      const bundle = await runKnowledgeThreadEvolution(projectPath, llmConfig, input)
      const selected = get().selectedThreadId
      const selectedStillExists = selected && bundle.threads.some((thread) => thread.id === selected)
      set({
        ...applyBundle(bundle),
        selectedThreadId: selectedStillExists ? selected : bundle.threads[0]?.id ?? null,
        running: false,
        error: null,
      })
    } catch (err) {
      set({
        running: false,
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
  ThreadEvolutionLog,
  UserThreadContext,
}
