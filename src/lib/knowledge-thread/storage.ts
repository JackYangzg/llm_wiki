import { createDirectory, fileExists, readFile, writeFileAtomic } from "@/commands/fs"
import { joinPath, normalizePath } from "@/lib/path-utils"
import {
  EMPTY_KNOWLEDGE_THREAD_BUNDLE,
  type KnowledgeThread,
  type KnowledgeThreadBundle,
  type KnowledgeThreadEdge,
  type KnowledgeThreadGap,
  type KnowledgeThreadNode,
  type KnowledgeThreadTrash,
  type ThreadEvolutionLog,
  type TrashEntry,
  type UserThreadContext,
} from "./types"

const THREAD_DIR = ".llm-wiki/inspiration/knowledge-threads"

const FILES = {
  threads: "threads.json",
  nodes: "thread-nodes.json",
  edges: "thread-edges.json",
  gaps: "thread-gaps.json",
  contexts: "thread-contexts.json",
  logs: "thread-evolution-logs.json",
  trash: "thread-trash.json",
} as const

function baseDir(projectPath: string): string {
  return joinPath(normalizePath(projectPath), THREAD_DIR)
}

function filePath(projectPath: string, key: keyof typeof FILES): string {
  return joinPath(baseDir(projectPath), FILES[key])
}

async function readJsonArray<T>(projectPath: string, key: keyof typeof FILES): Promise<T[]> {
  const path = filePath(projectPath, key)
  try {
    if (!(await fileExists(path))) return []
    const parsed = JSON.parse(await readFile(path))
    return Array.isArray(parsed) ? parsed as T[] : []
  } catch {
    return []
  }
}

async function writeJsonArray<T>(projectPath: string, key: keyof typeof FILES, data: T[]): Promise<void> {
  await writeFileAtomic(filePath(projectPath, key), JSON.stringify(data, null, 2))
}

export async function ensureKnowledgeThreadDir(projectPath: string): Promise<void> {
  await createDirectory(baseDir(projectPath)).catch(() => {})
}

export async function loadKnowledgeThreadBundle(projectPath: string): Promise<KnowledgeThreadBundle> {
  await ensureKnowledgeThreadDir(projectPath)
  const [threads, nodes, edges, gaps, contexts, logs] = await Promise.all([
    readJsonArray<KnowledgeThread>(projectPath, "threads"),
    readJsonArray<KnowledgeThreadNode>(projectPath, "nodes"),
    readJsonArray<KnowledgeThreadEdge>(projectPath, "edges"),
    readJsonArray<KnowledgeThreadGap>(projectPath, "gaps"),
    readJsonArray<UserThreadContext>(projectPath, "contexts"),
    readJsonArray<ThreadEvolutionLog>(projectPath, "logs"),
  ])
  return {
    ...EMPTY_KNOWLEDGE_THREAD_BUNDLE,
    threads,
    nodes,
    edges,
    gaps,
    contexts,
    logs,
  }
}

export async function saveKnowledgeThreadBundle(
  projectPath: string,
  bundle: KnowledgeThreadBundle,
): Promise<void> {
  await ensureKnowledgeThreadDir(projectPath)
  await Promise.all([
    writeJsonArray(projectPath, "threads", bundle.threads),
    writeJsonArray(projectPath, "nodes", bundle.nodes),
    writeJsonArray(projectPath, "edges", bundle.edges),
    writeJsonArray(projectPath, "gaps", bundle.gaps),
    writeJsonArray(projectPath, "contexts", bundle.contexts),
    writeJsonArray(projectPath, "logs", bundle.logs),
  ])
}

export async function loadTrash(projectPath: string): Promise<KnowledgeThreadTrash> {
  await ensureKnowledgeThreadDir(projectPath)
  const entries = await readJsonArray<TrashEntry>(projectPath, "trash")
  return { entries }
}

export async function moveThreadToTrash(
  projectPath: string,
  threadId: string,
  bundle: KnowledgeThreadBundle,
): Promise<KnowledgeThreadBundle> {
  const thread = bundle.threads.find((t) => t.id === threadId)
  if (!thread) return bundle
  const threadNodes = bundle.nodes.filter((n) => n.threadId === threadId)
  const nodeIds = new Set(threadNodes.map((n) => n.id))
  const threadEdges = bundle.edges.filter((e) => e.threadId === threadId)
  const threadGaps = bundle.gaps.filter((g) => g.threadId === threadId)
  const trash = await loadTrash(projectPath)
  const entry: TrashEntry = {
    id: threadId,
    thread,
    nodes: threadNodes,
    edges: threadEdges,
    gaps: threadGaps,
    deletedAt: Date.now(),
  }
  trash.entries.unshift(entry)
  await writeJsonArray(projectPath, "trash", trash.entries.slice(0, 200))
  const next: KnowledgeThreadBundle = {
    threads: bundle.threads.filter((t) => t.id !== threadId),
    nodes: bundle.nodes.filter((n) => n.threadId !== threadId),
    edges: bundle.edges.filter((e) => e.threadId !== threadId && !nodeIds.has(e.sourceNodeId) && !nodeIds.has(e.targetNodeId)),
    gaps: bundle.gaps.filter((g) => g.threadId !== threadId),
    contexts: bundle.contexts.filter((c) => c.targetId !== threadId && !nodeIds.has(c.targetId ?? "")),
    logs: bundle.logs.filter((l) => !l.affectedThreadIds.includes(threadId)),
  }
  await saveKnowledgeThreadBundle(projectPath, next)
  return next
}

export async function restoreThreadFromTrash(
  projectPath: string,
  threadId: string,
): Promise<KnowledgeThreadBundle | null> {
  const trash = await loadTrash(projectPath)
  const index = trash.entries.findIndex((e) => e.id === threadId)
  if (index === -1) return null
  const entry = trash.entries[index]
  trash.entries.splice(index, 1)
  await writeJsonArray(projectPath, "trash", trash.entries)
  const bundle = await loadKnowledgeThreadBundle(projectPath)
  bundle.threads.push(entry.thread)
  bundle.nodes.push(...entry.nodes)
  bundle.edges.push(...entry.edges)
  bundle.gaps.push(...entry.gaps)
  await saveKnowledgeThreadBundle(projectPath, bundle)
  return bundle
}

export async function permanentlyDeleteFromTrash(
  projectPath: string,
  threadId: string,
): Promise<void> {
  const trash = await loadTrash(projectPath)
  trash.entries = trash.entries.filter((e) => e.id !== threadId)
  await writeJsonArray(projectPath, "trash", trash.entries)
}
