import { readFile, writeFile } from "@/commands/fs"
import { autoIngest } from "./ingest"
import { useWikiStore } from "@/stores/wiki-store"
import { normalizePath, isAbsolutePath, getFileName } from "@/lib/path-utils"
import { getProjectPathById } from "@/lib/project-identity"
import { hasUsableLlm } from "@/lib/has-usable-llm"
import { addLog } from "@/stores/log-store"

const IMAGE_QUEUE_EXTS = new Set(["jpg", "jpeg", "png", "gif", "webp", "bmp"])

let _concurrencyWatchInstalled = false

/** Deferred from module top-level to avoid circular-dependency init crash. */
export function initConcurrencyWatch() {
  if (_concurrencyWatchInstalled) return
  _concurrencyWatchInstalled = true
  useWikiStore.subscribe((state, prev) => {
    if (state.ingestConcurrency !== prev.ingestConcurrency && currentProjectId) {
      fillPipeline(currentProjectId)
    }
  })
}

// ── Types ─────────────────────────────────────────────────────────────────

export interface IngestTask {
  id: string
  /** Stable project UUID (see project-identity.ts). Prefer this to
   *  `projectPath` because the filesystem location can change — tasks
   *  look up the current path via the registry at run time. */
  projectId: string
  sourcePath: string  // relative to project: "raw/sources/folder/file.pdf"
  folderContext: string  // e.g. "AI-Research > papers" or ""
  status: "pending" | "processing" | "done" | "failed"
  addedAt: number
  error: string | null
  retryCount: number
}

// ── State ─────────────────────────────────────────────────────────────────

let queue: IngestTask[] = []
/** Total tasks enqueued this session. Resets on project switch /
 *  app restart. Used by the UI to show "pending / sessionTotal". */
let sessionTotalEnqueued = 0
/** Active (in-flight) tasks. Size bounded by the configured
 *  `ingestConcurrency`. Each entry tracks its own abort controller
 *  and written-files list so cancellation and cleanup are per-task. */
interface ActiveTask {
  taskId: string
  abortController: AbortController
  writtenFiles: string[]
}
const activeTasks = new Map<string, ActiveTask>()

function activeCount(): number {
  return activeTasks.size
}

function processingCount(): number {
  return queue.filter((t) => t.status === "processing").length
}

function maxConcurrency(): number {
  return Math.max(1, useWikiStore.getState().ingestConcurrency ?? 1)
}

/** Fill the pipeline by starting tasks until we reach the concurrency
 *  limit or run out of pending tasks. Safe to call multiple times. */
function fillPipeline(projectId: string): void {
  while (processingCount() < maxConcurrency()) {
    const pending = queue.find((t) => t.projectId === projectId && t.status === "pending")
    if (!pending) break
    processNext(projectId)
  }
}

/** UUID of the currently-active project. Used as a stale-context guard
 *  in processNext: if this changes mid-ingest (user switched projects),
 *  the orphaned runner bails instead of writing to the old project. */
let currentProjectId = ""
/** Cached filesystem path of the currently-active project. Kept in lock-
 *  step with `currentProjectId` by pauseQueue / restoreQueue so sync
 *  callers (saveQueue, cancelTask, etc.) don't need a registry lookup. */
let currentProjectPath = ""
// Track whether any task has been processed since the last drain.
// Prevents the sweep from running on every idle/no-op call.
let processedSinceDrain = false
// Abort controller for the review-sweep LLM call so switching projects
// cancels a long-running judgment instead of burning tokens.
let sweepAbortController: AbortController | null = null

// ── Persistence ───────────────────────────────────────────────────────────

function queueFilePath(projectPath: string): string {
  return `${normalizePath(projectPath)}/.llm-wiki/ingest-queue.json`
}

async function saveQueue(projectPath: string): Promise<void> {
  try {
    // Only save pending and failed tasks (done tasks are removed)
    const toSave = queue.filter((t) => t.status !== "done")
    await writeFile(queueFilePath(projectPath), JSON.stringify(toSave, null, 2))
  } catch {
    // non-critical
  }
}

async function loadQueue(projectPath: string, projectId: string): Promise<IngestTask[]> {
  try {
    const raw = await readFile(queueFilePath(projectPath))
    const tasks = JSON.parse(raw) as IngestTask[]
    // Backfill projectId for tasks persisted before the field existed.
    // Files live inside a specific project, so every task in this file
    // belongs to `projectId` regardless of what's on disk.
    return tasks.map((t) => ({
      ...t,
      projectId: t.projectId ?? projectId,
    }))
  } catch {
    return []
  }
}

// ── Queue Operations ──────────────────────────────────────────────────────

function generateId(): string {
  return `ingest-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function normalizeSourcePathForQueue(sourcePath: string): string {
  const normalized = normalizePath(sourcePath)
  if (currentProjectPath && normalized.startsWith(`${currentProjectPath}/`)) {
    return normalized.slice(currentProjectPath.length + 1)
  }
  return normalized
}

function sameQueuedSourcePath(a: string, b: string): boolean {
  return normalizeSourcePathForQueue(a) === normalizeSourcePathForQueue(b)
}

function upsertQueuedIngestTask(
  projectId: string,
  sourcePath: string,
  folderContext: string,
): string {
  const normalizedSourcePath = normalizeSourcePathForQueue(sourcePath)
  const pendingOrFailed = queue.find((t) =>
    t.projectId === projectId &&
    (t.status === "pending" || t.status === "failed") &&
    sameQueuedSourcePath(t.sourcePath, normalizedSourcePath)
  )

  if (pendingOrFailed) {
    pendingOrFailed.sourcePath = normalizedSourcePath
    pendingOrFailed.folderContext = folderContext || pendingOrFailed.folderContext
    pendingOrFailed.status = "pending"
    pendingOrFailed.error = null
    pendingOrFailed.retryCount = 0
    return pendingOrFailed.id
  }

  const processing = queue.find((t) =>
    t.projectId === projectId &&
    t.status === "processing" &&
    sameQueuedSourcePath(t.sourcePath, normalizedSourcePath)
  )
  const pendingRerun = processing
    ? queue.find((t) =>
        t.projectId === projectId &&
        t.status === "pending" &&
        sameQueuedSourcePath(t.sourcePath, normalizedSourcePath)
      )
    : null

  if (pendingRerun) {
    return pendingRerun.id
  }

  const task: IngestTask = {
    id: generateId(),
    projectId,
    sourcePath: normalizedSourcePath,
    folderContext,
    status: "pending",
    addedAt: Date.now(),
    error: null,
    retryCount: 0,
  }
  queue.push(task)
  return task.id
}

/**
 * Delete files written by a cancelled / failed ingest, AND drop the
 * matching pages' chunks from LanceDB. Called from the cancel paths
 * (cancelTask, cancelAllTasks).
 *
 * Per-file errors are swallowed (best-effort cleanup) — a missing
 * file or LanceDB unavailable shouldn't abort the cancel flow.
 * Structural pages (index/log/overview) aren't embedded, so the
 * cascade no-ops for them.
 */
export async function cleanupWrittenFiles(
  projectPath: string,
  filePaths: string[],
): Promise<void> {
  const { cascadeDeleteWikiPage } = await import("@/lib/wiki-page-delete")
  for (const filePath of filePaths) {
    const fullPath = isAbsolutePath(filePath)
      ? normalizePath(filePath)
      : `${projectPath}/${filePath}`
    try {
      await cascadeDeleteWikiPage(projectPath, fullPath)
    } catch {
      // file may not exist / lancedb unavailable — non-critical
    }
  }
}

/**
 * Add a file to the ingest queue. The project MUST be the currently-
 * active project — switching first is a prerequisite. Returns the new
 * task's id.
 */
export async function enqueueIngest(
  projectId: string,
  sourcePath: string,
  folderContext: string = "",
): Promise<string> {
  if (!currentProjectId || currentProjectId !== projectId) {
    throw new Error(
      `enqueueIngest: project ${projectId} is not the active project (current: ${currentProjectId || "<none>"})`,
    )
  }

  const id = upsertQueuedIngestTask(projectId, sourcePath, folderContext)
  sessionTotalEnqueued++
  await saveQueue(currentProjectPath)

  fillPipeline(currentProjectId)

  return id
}

/**
 * Add multiple files to the queue at once. Same active-project
 * requirement as enqueueIngest.
 */
export async function enqueueBatch(
  projectId: string,
  files: Array<{ sourcePath: string; folderContext: string }>,
): Promise<string[]> {
  if (!currentProjectId || currentProjectId !== projectId) {
    throw new Error(
      `enqueueBatch: project ${projectId} is not the active project (current: ${currentProjectId || "<none>"})`,
    )
  }

  const ids: string[] = []
  for (const file of files) {
    ids.push(upsertQueuedIngestTask(projectId, file.sourcePath, file.folderContext))
  }

  sessionTotalEnqueued += files.length
  await saveQueue(currentProjectPath)
  console.log(`[Ingest Queue] Enqueued ${files.length} files`)
  fillPipeline(currentProjectId)

  return ids
}

/**
 * Retry a failed task. Only valid for tasks in the active project's
 * queue.
 */
export async function retryTask(taskId: string): Promise<void> {
  const task = queue.find((t) => t.id === taskId)
  if (!task) return
  if (task.projectId !== currentProjectId) return

  task.status = "pending"
  task.error = null
  await saveQueue(currentProjectPath)
  fillPipeline(currentProjectId)
}

/**
 * Cancel a pending or processing task.
 * If processing, aborts the LLM call and cleans up generated files.
 */
export async function cancelTask(taskId: string): Promise<void> {
  const task = queue.find((t) => t.id === taskId)
  if (!task) return
  if (task.projectId !== currentProjectId) return

  if (task.status === "processing") {
    // Abort the in-progress LLM call and clean up its output
    const active = activeTasks.get(taskId)
    if (active) {
      active.abortController.abort()
      if (active.writtenFiles.length > 0) {
        await cleanupWrittenFiles(currentProjectPath, active.writtenFiles)
        console.log(`[Ingest Queue] Cleaned up ${active.writtenFiles.length} files from cancelled task`)
      }
      activeTasks.delete(taskId)
    }
  }

  queue = queue.filter((t) => t.id !== taskId)
  await saveQueue(currentProjectPath)
  console.log(`[Ingest Queue] Cancelled: ${task.sourcePath}`)

  fillPipeline(currentProjectId)
}

/**
 * Clear all done/failed tasks from the active project's queue.
 */
export async function clearCompletedTasks(): Promise<void> {
  queue = queue.filter((t) => t.status === "pending" || t.status === "processing")
  await saveQueue(currentProjectPath)
}

/**
 * Cancel everything that's not finished in the active project's queue:
 * aborts the running task (if any), cleans up its partial output, and
 * drops every pending + processing item.
 *
 * Failed tasks are retained so the user can still see / retry them.
 * Returns the number of tasks removed from the queue.
 */
export async function cancelAllTasks(): Promise<number> {
  // Abort all active tasks
  for (const [, active] of activeTasks) {
    active.abortController.abort()
    if (active.writtenFiles.length > 0) {
      await cleanupWrittenFiles(currentProjectPath, active.writtenFiles)
    }
  }
  activeTasks.clear()

  const before = queue.length
  queue = queue.filter((t) => t.status === "failed")
  const removed = before - queue.length

  await saveQueue(currentProjectPath)
  console.log(`[Ingest Queue] Cancelled all: ${removed} tasks removed`)
  return removed
}

/**
 * Get current queue state.
 */
export function getQueue(): readonly IngestTask[] {
  return queue
}

/**
 * Get queue summary.
 */
export function getQueueSummary(): { pending: number; processing: number; failed: number; total: number; sessionTotal: number } {
  return {
    pending: queue.filter((t) => t.status === "pending").length,
    processing: activeCount(),
    failed: queue.filter((t) => t.status === "failed").length,
    total: queue.length,
    sessionTotal: sessionTotalEnqueued,
  }
}

/**
 * Clear all in-memory queue state without touching disk. Used by tests
 * that want a clean slate between cases. **Production code should use
 * `pauseQueue()` on project switch**, which flushes pending state to
 * disk before clearing memory.
 */
export function clearQueueState(): void {
  for (const [, active] of activeTasks) {
    active.abortController.abort()
  }
  activeTasks.clear()
  if (sweepAbortController) {
    sweepAbortController.abort()
  }
  queue = []
  currentProjectId = ""
  currentProjectPath = ""
  sweepAbortController = null
  processedSinceDrain = false
}

/**
 * Project-switch handshake. Flushes the active project's current queue
 * state to its disk file (so pending/failed tasks survive the switch),
 * reverts any processing task to pending, then clears in-memory state
 * so the next `restoreQueue()` can safely load a different project.
 *
 * Must be called before opening or switching to a different project.
 * Must be `await`ed — the disk flush is async.
 */
export async function pauseQueue(): Promise<void> {
  if (!currentProjectId || !currentProjectPath) {
    // Nothing to pause (no active project)
    return
  }

  const pausedProjectPath = currentProjectPath

  for (const [, active] of activeTasks) {
    active.abortController.abort()
  }
  activeTasks.clear()
  if (sweepAbortController) {
    sweepAbortController.abort()
    sweepAbortController = null
  }

  // Revert any in-flight processing task back to pending so when the
  // user returns to this project, the task is re-tried from scratch.
  for (const task of queue) {
    if (task.status === "processing") {
      task.status = "pending"
    }
  }

  // Flush the paused state to THIS project's disk before wiping memory.
  await saveQueue(pausedProjectPath)

  queue = []
  currentProjectId = ""
  currentProjectPath = ""
  processedSinceDrain = false
}

// ── Restore on startup ───────────────────────────────────────────────────

/**
 * Load queue from disk and resume processing. Called on app startup
 * and when opening / switching to a project. `pauseQueue()` must have
 * been called first (or the active project already cleared) so that
 * in-memory state is not contaminated from the previous project.
 */
export async function restoreQueue(
  projectId: string,
  projectPath: string,
): Promise<void> {
  const pp = normalizePath(projectPath)
  // Defensive: reset in-memory state (should already be empty via
  // pauseQueue, but clearing again costs nothing).
  queue = []
  activeTasks.clear()
  currentProjectId = projectId
  currentProjectPath = pp

  const saved = await loadQueue(pp, projectId)

  if (saved.length === 0) return

  // Drop any cross-project contamination (shouldn't happen in practice
  // but defends against a corrupt queue file).
  const mine = saved.filter((t) => t.projectId === projectId)
  if (mine.length !== saved.length) {
    console.warn(
      `[Ingest Queue] Dropped ${saved.length - mine.length} cross-project tasks during restore`,
    )
  }

  // Reset any "processing" tasks back to "pending" (interrupted by app close)
  let restored = 0
  for (const task of mine) {
    if (task.status === "processing") {
      task.status = "pending"
      restored++
    }
  }

  queue = mine
  await saveQueue(pp)

  const pending = queue.filter((t) => t.status === "pending").length
  const failed = queue.filter((t) => t.status === "failed").length

  if (pending > 0 || restored > 0) {
    console.log(`[Ingest Queue] Restored: ${pending} pending, ${failed} failed, ${restored} resumed from interrupted`)
    fillPipeline(projectId)
  }
}

// ── Processing ────────────────────────────────────────────────────────────

const MAX_RETRIES = 3

async function onQueueDrained(projectId: string, projectPath: string): Promise<void> {
  if (!processedSinceDrain) return
  // Stale-context guard — if we switched projects mid-drain, the sweep
  // would burn tokens analyzing the wrong project.
  if (currentProjectId !== projectId) return
  processedSinceDrain = false

  sweepAbortController = new AbortController()
  const signal = sweepAbortController.signal

  try {
    const { sweepResolvedReviews } = await import("@/lib/sweep-reviews")
    await sweepResolvedReviews(projectPath, signal)
  } catch (err) {
    console.error("[Ingest Queue] Failed to load sweep-reviews:", err)
  } finally {
    if (sweepAbortController && sweepAbortController.signal === signal) {
      sweepAbortController = null
    }
  }
}

async function processNext(projectId: string): Promise<void> {
  // Concurrency gate: don't exceed the configured limit.
  if (processingCount() >= maxConcurrency()) return
  // Stale-context guard: processNext may be invoked by an orphaned
  // recursion from a previous project. If we're no longer active, bail.
  if (currentProjectId !== projectId) return

  const next = queue.find((t) => t.projectId === projectId && t.status === "pending")
  if (!next) {
    // Queue drained — trigger review cleanup only when nothing is in flight
    if (processingCount() === 0) {
      const pathAtDrain = currentProjectPath
      onQueueDrained(projectId, pathAtDrain).catch((err) =>
        console.error("[Ingest Queue] sweep failed:", err)
      )
    }
    return
  }

  // Mark as processing immediately so fillPipeline's loop respects
  // the concurrency limit correctly (before any async gap).
  next.status = "processing"

  // Look up the project's current filesystem path from the registry —
  // it may have moved since the task was enqueued. If the project isn't
  // in the registry (was deleted or never registered), mark as failed.
  const registryPath = await getProjectPathById(projectId)
  const pp = registryPath ? normalizePath(registryPath) : ""

  // Check we're still active after the registry await.
  if (currentProjectId !== projectId) return

  if (!pp) {
    next.status = "failed"
    next.error = "Project not found in registry (was it deleted?)"
    await saveQueue(currentProjectPath)
    fillPipeline(projectId)
    return
  }

  await saveQueue(pp)
  if (currentProjectId !== projectId) return

  const llmConfig = useWikiStore.getState().llmConfig

  const isImageTask = (() => {
    const ext = next.sourcePath.split(".").pop()?.toLowerCase() ?? ""
    return IMAGE_QUEUE_EXTS.has(ext)
  })()
  if (!isImageTask && !hasUsableLlm(llmConfig)) {
    next.status = "failed"
    next.error = "LLM not configured — set API key in Settings"
    await saveQueue(pp)
    fillPipeline(projectId)
    return
  }

  const fullSourcePath = isAbsolutePath(next.sourcePath)
    ? normalizePath(next.sourcePath)
    : `${pp}/${next.sourcePath}`

  const pendingCount = queue.filter((t) => t.projectId === projectId && t.status === "pending").length
  console.log(`[Ingest Queue] Processing: ${next.sourcePath} (${pendingCount} remaining, ${processingCount()}/${maxConcurrency()} active)`)

  // Register this task as active before starting work.
  const abortController = new AbortController()
  activeTasks.set(next.id, { taskId: next.id, abortController, writtenFiles: [] })

  try {
    const writtenFiles = await autoIngest(pp, fullSourcePath, llmConfig, abortController.signal, next.folderContext)
    // Stale-context guard: project switched during the long LLM call.
    if (currentProjectId !== projectId) return

    // Update the tracked written files (for potential cleanup on cancel).
    const active = activeTasks.get(next.id)
    if (active) active.writtenFiles = writtenFiles

    // Safety net: autoIngest resolving with zero files means nothing
    // was really ingested. Treat as failure so the task stays in the
    // queue and retries.
    if (writtenFiles.length === 0) {
      throw new Error("Ingest produced no output files")
    }

    // Success: remove from queue
    queue = queue.filter((t) => t.id !== next.id)
    processedSinceDrain = true
    await saveQueue(pp)

    console.log(`[Ingest Queue] Done: ${next.sourcePath}`)
    addLog("分析完成", `文件: ${getFileName(next.sourcePath)}`)
  } catch (err) {
    if (currentProjectId !== projectId) return
    const message = err instanceof Error ? err.message : String(err)
    next.retryCount++
    next.error = message

    if (next.retryCount >= MAX_RETRIES) {
      next.status = "failed"
      console.log(`[Ingest Queue] Failed (${next.retryCount}x): ${next.sourcePath} — ${message}`)
      addLog("分析失败", `文件: ${getFileName(next.sourcePath)}\n错误: ${message}`)
    } else {
      next.status = "pending" // will retry
      console.log(`[Ingest Queue] Error (retry ${next.retryCount}/${MAX_RETRIES}): ${next.sourcePath} — ${message}`)
    }

    await saveQueue(pp)
  } finally {
    // Release the concurrency slot so the next task can start.
    activeTasks.delete(next.id)
  }

  // Refill the pipeline up to the concurrency limit.
  fillPipeline(projectId)
}
