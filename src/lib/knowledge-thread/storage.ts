import { createDirectory, fileExists, readFile, writeFileAtomic } from "@/commands/fs"
import { joinPath, normalizePath } from "@/lib/path-utils"
import {
  EMPTY_KNOWLEDGE_THREAD_BUNDLE,
  type KnowledgeThread,
  type KnowledgeThreadBundle,
  type KnowledgeThreadEdge,
  type KnowledgeThreadGap,
  type KnowledgeThreadNode,
  type ThreadEvolutionLog,
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
