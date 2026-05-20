import { writeFileAtomic, createDirectory, writeBinaryFile } from "@/commands/fs"
import { useWikiStore } from "@/stores/wiki-store"
import type { WikiProject } from "@/types/wiki"
import type { LlmConfig } from "@/stores/wiki-store"
import { normalizePath } from "@/lib/path-utils"
import { enqueueSourceIngest } from "@/lib/source-lifecycle"

import {
  syncMessages,
  getLoginQr,
  checkLoginStatus,
  getUserInfo,
  resolveFileTransferUserId,
  downloadAttachment,
  type WechatSession,
  type WechatMessage,
  type LoginQrResponse,
} from "./wechat-login"
export type { WechatSession } from "./wechat-login"
import {
  shouldImportText,
  DEFAULT_FILTER_CONFIG,
  type WechatFilterConfig,
} from "./wechat-filter"
import { fetchUrlContent } from "./wechat-link-fetcher"
import {
  loadWechatDb,
  saveWechatDb,
  isDuplicate,
  markProcessed,
  updateSyncKey,
  saveChatMessages,
  loadChatMessages,
  type WechatImportDb,
  type WechatProcessedMessage,
} from "./wechat-db"

// ── Types ─────────────────────────────────────────────────────────────────

export interface WechatImportConfig {
  enabled: boolean
  pollIntervalMs: number
  filter: WechatFilterConfig
  autoIngest: boolean
}

export const DEFAULT_IMPORT_CONFIG: WechatImportConfig = {
  enabled: false,
  pollIntervalMs: 3000,
  filter: DEFAULT_FILTER_CONFIG,
  autoIngest: true,
}

// ── State ─────────────────────────────────────────────────────────────────

let pollTimer: ReturnType<typeof setInterval> | null = null
let polling = false
let pollInFlight = false
let pollFailures = 0
let currentProjectId = ""
let session: WechatSession | null = null

// ── Public API ────────────────────────────────────────────────────────────

export function isPolling(): boolean {
  return polling
}

export async function startImport(config: WechatImportConfig): Promise<void> {
  if (polling) return

  const store = useWikiStore.getState()
  const project = store.project
  if (!project) return

  currentProjectId = project.id
  polling = true

  const sourcesDir = `${normalizePath(project.path)}/raw/sources/wechat`
  await createDirectory(sourcesDir).catch(() => {})

  const db = await loadWechatDb(project.path)
  await retryPersistedImageMessages(config, project, store.llmConfig, db)

  // Fire first poll immediately, then every pollIntervalMs
  const doPoll = async () => {
    if (!polling || pollInFlight) return

    const currentStore = useWikiStore.getState()
    if (currentStore.project?.id !== currentProjectId) {
      stopImport()
      return
    }

    pollInFlight = true
    try {
      await pollOnce(config, project, currentStore.llmConfig, db)
      pollFailures = 0
    } catch (err) {
      pollFailures++
      // Truncate long error URLs to avoid expensive console rendering
      const msg = String(err).slice(0, 120)
      if (pollFailures <= 2 || pollFailures % 10 === 0) {
        console.error("[wechat-import] poll error:", msg)
      }
    } finally {
      pollInFlight = false
    }
  }

  doPoll()

  pollTimer = setInterval(doPoll, config.pollIntervalMs)
}

export function stopImport(): void {
  polling = false
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
  session = null
}

export function getSession(): WechatSession | null {
  return session
}

export function setSession(s: WechatSession): void {
  session = s
}

// ── Login ─────────────────────────────────────────────────────────────────

export async function startLogin(): Promise<LoginQrResponse> {
  return getLoginQr()
}

export async function waitForLogin(
  qrcodeId: string,
): Promise<WechatSession> {
  return new Promise((resolve, reject) => {
    let inFlight = false
    let settled = false
    let interval: ReturnType<typeof setInterval>

    const finish = () => {
      settled = true
      clearInterval(interval)
    }

    interval = setInterval(async () => {
      if (inFlight || settled) return
      inFlight = true

      try {
        const status = await checkLoginStatus(qrcodeId)

        if (status.status === "logged_in") {
          finish()
          const token = status.session_token || ""
          const [userInfo, fileTransferId] = await Promise.all([
            getUserInfo(),
            resolveFileTransferUserId(),
          ])

          session = {
            token,
            nickname: userInfo.nickname || status.nickname || "",
            avatarUrl: userInfo.avatar_url || status.avatar_url || "",
            fileTransferUserId: fileTransferId,
          }
          resolve(session)
        } else if (status.status === "timeout" || status.status === "error") {
          finish()
          reject(new Error(status.message || "Login failed"))
        }
      } catch (err) {
        finish()
        reject(err)
      } finally {
        inFlight = false
      }
    }, 2000)
  })
}

// ── Polling ───────────────────────────────────────────────────────────────

const SOURCE_DIR = "raw/sources/wechat"

async function pollOnce(
  config: WechatImportConfig,
  project: WikiProject,
  llmConfig: LlmConfig,
  db: WechatImportDb,
): Promise<void> {
  if (!session) return

  const resp = await syncMessages()

  // Check for disconnect (retcode != "0" = logged out elsewhere)
  if (resp.retcode && resp.retcode !== "0") {
    console.warn("[wechat-import] disconnected, retcode:", resp.retcode)
    stopImport()
    useWikiStore.getState().setWechatDisconnected?.(true)
    return
  }

  // Push messages to UI store so WechatPanel shows them in real-time
  if (resp.messages.length > 0) {
    const store = useWikiStore.getState()
    store.addWechatMessages(resp.messages)
    // Increment unread count when panel is closed
    if (!store.wechatPanelOpen) {
      store.setWechatUnreadCount(resp.messages.length)
    }
  }

  // selector == "0" means no new messages; any non-zero means we should process
  if (resp.selector === "0") return

  let updatedDb = updateSyncKey(db, resp.syncKey)

  for (const msg of resp.messages) {
    if (isDuplicate(updatedDb, msg.msgId) && !shouldRetryProcessedMessage(updatedDb, msg)) {
      continue
    }

    const entry = await processMessage(msg, config, project, llmConfig)
    updatedDb = markProcessed(updatedDb, msg.msgId, entry)
  }

  await saveWechatDb(project.path, updatedDb)

  // Persist chat messages so they survive restarts
  const latestMessages = useWikiStore.getState().wechatMessages
  saveChatMessages(project.path, latestMessages).catch(() => {})
}

async function processMessage(
  msg: WechatMessage,
  config: WechatImportConfig,
  project: WikiProject,
  llmConfig: LlmConfig,
): Promise<WechatProcessedMessage> {
  const base: Pick<WechatProcessedMessage, "msgId" | "msgType"> = {
    msgId: msg.msgId,
    msgType: String(msg.type),
  }

  switch (msg.type) {
    case 1:
      return handleTextMessage(msg, config, project, llmConfig)
    case 49:
      return handleFileMessage(msg, config, project, llmConfig)
    case 3:
      return handleImageMessage(msg, config, project, llmConfig)
    default:
      return {
        ...base,
        importedAt: Date.now(),
        targetPath: "",
        decision: "skipped",
        skipReason: `unknown_type_${msg.type}`,
      }
  }
}

// ── Message handlers ──────────────────────────────────────────────────────

async function handleTextMessage(
  msg: WechatMessage,
  config: WechatImportConfig,
  project: WikiProject,
  llmConfig: LlmConfig,
): Promise<WechatProcessedMessage> {
  const base = { msgId: msg.msgId, msgType: "1" }

  const result = await shouldImportText(msg.content, config.filter, llmConfig)
  if (!result.import) {
    return {
      ...base,
      importedAt: Date.now(),
      targetPath: "",
      decision: "skipped",
      skipReason: result.reason,
    }
  }

  const text = result.strippedText || msg.content
  const slug = text
    .slice(0, 60)
    .replace(/[^a-zA-Z0-9一-鿿]+/g, "-")
    .replace(/^-|-$/g, "")
  const dateStr = new Date(msg.createTime * 1000).toISOString().slice(0, 10)
  const fileName = `${dateStr}-${slug || "note"}.md`
  const targetPath = `${SOURCE_DIR}/${fileName}`

  await writeToProject(project.path, targetPath, text)

  const entry: WechatProcessedMessage = {
    ...base,
    importedAt: Date.now(),
    targetPath,
    decision: "imported",
  }

  if (config.autoIngest) {
    await doEnqueue(project, targetPath, llmConfig, entry)
  }

  return entry
}

async function handleFileMessage(
  msg: WechatMessage,
  config: WechatImportConfig,
  project: WikiProject,
  llmConfig: LlmConfig,
): Promise<WechatProcessedMessage> {
  const base = { msgId: msg.msgId, msgType: "49" }

  if (!session) {
    return {
      ...base,
      importedAt: Date.now(),
      targetPath: "",
      decision: "skipped",
      skipReason: "no_session",
    }
  }

  // Check if bubble already cached this file locally (check store for latest content)
  const latestContent = getLatestMsgContent(msg.msgId) ?? msg.content
  const cachedPath = getMsgLocalPath(latestContent)
  if (cachedPath) {
    const targetPath = cachedPath.startsWith(`${normalizePath(project.path)}/`)
      ? cachedPath.slice(normalizePath(project.path).length + 1)
      : cachedPath
    const entry: WechatProcessedMessage = {
      ...base,
      importedAt: Date.now(),
      targetPath,
      decision: "imported",
    }
    if (config.autoIngest) {
      await doEnqueue(project, targetPath, llmConfig, entry)
    }
    return entry
  }

  // Try to parse CDN info from content (file attachment or iLink file message)
  try {
    const cdnInfo = JSON.parse(msg.content)
    // File attachment from file helper: mediaId may be absent; rawContent can
    // still contain appattach/cdnattachurl download metadata.
    if (cdnInfo.fileName && (cdnInfo.mediaId || cdnInfo.rawContent)) {
      const data = await downloadAttachment(msg.content)
      if (data.byteLength === 0) {
        throw new Error("empty_file_download")
      }
      const dateStr = new Date(msg.createTime * 1000).toISOString().slice(0, 10)
      const safeName = sanitizeFileSegment(String(cdnInfo.fileName), 80)
      const fileName = `file-${dateStr}-${safeName}`
      const targetPath = `${SOURCE_DIR}/${fileName}`
      const fullPath = `${normalizePath(project.path)}/${targetPath}`

      await writeBinaryToProject(project.path, targetPath, new Uint8Array(data))
      cacheFilePathOnMessage(project.path, msg, fullPath, targetPath, cdnInfo).catch(() => {})

      const entry: WechatProcessedMessage = {
        ...base,
        importedAt: Date.now(),
        targetPath,
        decision: "imported",
      }

      if (config.autoIngest) {
        await doEnqueue(project, targetPath, llmConfig, entry)
      }

      return entry
    }
    // iLink file message with encrypt_query_param
    if (cdnInfo.encrypt_query_param) {
      const data = await downloadAttachment(msg.content)
      const dateStr = new Date(msg.createTime * 1000)
        .toISOString()
        .slice(0, 10)
      const fileName = `file-${dateStr}-${msg.msgId}`
      const targetPath = `${SOURCE_DIR}/${fileName}`

      await writeBinaryToProject(
        project.path,
        targetPath,
        new Uint8Array(data),
      )

      const entry: WechatProcessedMessage = {
        ...base,
        importedAt: Date.now(),
        targetPath,
        decision: "imported",
      }

      if (config.autoIngest) {
        await doEnqueue(project, targetPath, llmConfig, entry)
      }

      return entry
    }
  } catch {
    // Not JSON — fallback to URL extraction
  }

  const url = msg.card?.url || extractUrl(msg.content)
  if (url) {
    return handleLinkMessage(msg, url, config, project, llmConfig)
  }

  return {
    ...base,
    importedAt: Date.now(),
    targetPath: "",
    decision: "skipped",
    skipReason: "no_downloadable_content",
  }
}

async function handleLinkMessage(
  msg: WechatMessage,
  url: string,
  config: WechatImportConfig,
  project: WikiProject,
  llmConfig: LlmConfig,
): Promise<WechatProcessedMessage> {
  const base = { msgId: msg.msgId, msgType: "49" }

  try {
    const parsed = await fetchUrlContent(url)
    const dateStr = new Date(msg.createTime * 1000).toISOString().slice(0, 10)
    const fileName = buildLinkFileName(dateStr, parsed.title, parsed.url)
    const targetPath = `${SOURCE_DIR}/${fileName}`

    const content = `# ${parsed.title || "Link"}\n\n> Source: ${parsed.url}\n\n${parsed.markdown}`
    await writeToProject(project.path, targetPath, content)

    const entry: WechatProcessedMessage = {
      ...base,
      importedAt: Date.now(),
      targetPath,
      decision: "imported",
    }

    if (config.autoIngest) {
      await doEnqueue(project, targetPath, llmConfig, entry)
    }

    return entry
  } catch (err) {
    const dateStr = new Date(msg.createTime * 1000).toISOString().slice(0, 10)
    const targetPath = `${SOURCE_DIR}/${buildLinkFileName(dateStr, "unreadable", url)}`
    const content = [
      "# Link",
      "",
      `> Source: ${url}`,
      "",
      "The link could not be read automatically.",
      "",
      `Reason: ${String(err).slice(0, 500)}`,
    ].join("\n")
    await writeToProject(project.path, targetPath, content)

    const entry: WechatProcessedMessage = {
      ...base,
      importedAt: Date.now(),
      targetPath,
      decision: "imported",
      skipReason: "fetch_failed",
    }

    if (config.autoIngest) {
      await doEnqueue(project, targetPath, llmConfig, entry)
    }

    return entry
  }
}

function buildLinkFileName(dateStr: string, topic: string, url: string): string {
  const safeTopic = sanitizeFileSegment(topic || "link", 80)
  const safeUrl = sanitizeFileSegment(url || "url", 120)
  return `link-${dateStr}-content-${safeTopic}-${safeUrl}.md`
}

function sanitizeFileSegment(value: string, maxLength: number): string {
  const normalized = value
    .replace(/https?:\/\//i, "")
    .replace(/[/\\?%*:|"<>#=&]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, maxLength)
    .replace(/-$/g, "")

  return normalized || "link"
}

async function handleImageMessage(
  msg: WechatMessage,
  config: WechatImportConfig,
  project: WikiProject,
  llmConfig: LlmConfig,
): Promise<WechatProcessedMessage> {
  const base = { msgId: msg.msgId, msgType: "3" }

  if (!session) {
    return {
      ...base,
      importedAt: Date.now(),
      targetPath: "",
      decision: "skipped",
      skipReason: "no_session",
    }
  }

  // Check if bubble already cached this image locally (check store for latest content)
  const latestContent = getLatestMsgContent(msg.msgId) ?? msg.content
  const cachedPath = getMsgLocalPath(latestContent)
  if (cachedPath) {
    const targetPath = cachedPath.startsWith(`${normalizePath(project.path)}/`)
      ? cachedPath.slice(normalizePath(project.path).length + 1)
      : cachedPath
    const entry: WechatProcessedMessage = {
      ...base,
      importedAt: Date.now(),
      targetPath,
      decision: "imported",
    }
    if (config.autoIngest) {
      await doEnqueue(project, targetPath, llmConfig, entry)
    }
    return entry
  }

  try {
    const inlineBytes = getInlineImageByteLength(msg.content)
    if (inlineBytes > 0) {
      console.info(
        `[wechat-import] using inline image buffer for ${msg.msgId} (${inlineBytes} bytes)`,
      )
    }
    const data = await downloadAttachment(msg.content, true)
    if (data.byteLength === 0) {
      throw new Error("empty_image_download")
    }
    const ext = detectImageExt(new Uint8Array(data)) || "jpg"
    const dateStr = new Date(msg.createTime * 1000).toISOString().slice(0, 10)
    const hash = hashBuffer(new Uint8Array(data))
    const fileName = `img-${dateStr}-${hash}.${ext}`
    const targetPath = `${SOURCE_DIR}/${fileName}`
    const fullPath = `${normalizePath(project.path)}/${targetPath}`

    await writeBinaryToProject(project.path, targetPath, new Uint8Array(data))
    cacheImagePathOnMessage(project.path, msg, fullPath, targetPath).catch(() => {})

    const entry: WechatProcessedMessage = {
      ...base,
      importedAt: Date.now(),
      targetPath,
      decision: "imported",
    }

    if (config.autoIngest) {
      await doEnqueue(project, targetPath, llmConfig, entry)
    }

    return entry
  } catch (err) {
    console.warn(
      "[wechat-import] image download/import failed:",
      err instanceof Error ? err.message : err,
    )
    return {
      ...base,
      importedAt: Date.now(),
      targetPath: "",
      decision: "skipped",
      skipReason: "download_failed",
    }
  }
}

async function cacheImagePathOnMessage(
  projectPath: string,
  msg: WechatMessage,
  localPath: string,
  localRelPath: string,
): Promise<void> {
  let content = msg.content
  try {
    const parsed = JSON.parse(msg.content) as Record<string, unknown>
    content = JSON.stringify({
      ...parsed,
      localPath,
      localRelPath,
    })
  } catch {
    content = JSON.stringify({
      msgId: msg.msgId,
      rawContent: msg.content,
      localPath,
      localRelPath,
    })
  }

  msg.content = content
  const store = useWikiStore.getState()
  store.updateWechatMessage?.(msg.msgId, { content })

  const persisted = (await loadChatMessages(projectPath).catch(() => [])) as WechatMessage[]
  const seen = new Set<string>()
  const updated = persisted.map((item) => {
    seen.add(item.msgId)
    return item.msgId === msg.msgId ? { ...item, content } : item
  })
  if (!seen.has(msg.msgId)) {
    updated.push({ ...msg, content })
  }
  await saveChatMessages(projectPath, updated.slice(-500))
}

async function cacheFilePathOnMessage(
  projectPath: string,
  msg: WechatMessage,
  localPath: string,
  localRelPath: string,
  cdnInfo: Record<string, unknown>,
): Promise<void> {
  let content = msg.content
  try {
    const parsed = JSON.parse(msg.content) as Record<string, unknown>
    content = JSON.stringify({
      ...parsed,
      localPath,
      localRelPath,
      fileName: cdnInfo.fileName,
      fileSize: cdnInfo.fileSize,
    })
  } catch {
    content = JSON.stringify({
      msgId: msg.msgId,
      rawContent: msg.content,
      localPath,
      localRelPath,
      fileName: cdnInfo.fileName,
      fileSize: cdnInfo.fileSize,
    })
  }

  msg.content = content
  const store = useWikiStore.getState()
  store.updateWechatMessage?.(msg.msgId, { content })

  const persisted = (await loadChatMessages(projectPath).catch(() => [])) as WechatMessage[]
  const seen = new Set<string>()
  const updated = persisted.map((item) => {
    seen.add(item.msgId)
    return item.msgId === msg.msgId ? { ...item, content } : item
  })
  if (!seen.has(msg.msgId)) {
    updated.push({ ...msg, content })
  }
  await saveChatMessages(projectPath, updated.slice(-500))
}

// ── Helpers ───────────────────────────────────────────────────────────────

function getLatestMsgContent(msgId: string): string | null {
  const store = useWikiStore.getState()
  const latest = store.wechatMessages.find((m) => m.msgId === msgId)
  return latest?.content ?? null
}

function getMsgLocalPath(content: string): string | null {
  try {
    const parsed = JSON.parse(content) as { localPath?: unknown }
    return typeof parsed.localPath === "string" && parsed.localPath
      ? parsed.localPath
      : null
  } catch {
    return null
  }
}

async function writeToProject(
  projectPath: string,
  relPath: string,
  content: string,
): Promise<void> {
  const fullPath = `${normalizePath(projectPath)}/${relPath}`
  await writeFileAtomic(fullPath, content)
}

async function writeBinaryToProject(
  projectPath: string,
  relPath: string,
  data: Uint8Array,
): Promise<void> {
  const fullPath = `${normalizePath(projectPath)}/${relPath}`
  await writeBinaryFile(fullPath, data)
}

function shouldRetryProcessedMessage(
  db: WechatImportDb,
  msg: WechatMessage,
): boolean {
  const previous = db.processedMessages[msg.msgId]
  if (previous?.skipReason === "download_failed") {
    return msg.type === 3 || msg.type === 49
  }
  return false
}

async function retryPersistedImageMessages(
  config: WechatImportConfig,
  project: WikiProject,
  llmConfig: LlmConfig,
  db: WechatImportDb,
): Promise<void> {
  const persisted = await loadChatMessages(project.path).catch(() => [])
  const imageMessages = (persisted as WechatMessage[])
    .filter((msg) => {
      if (msg?.type !== 3) return false
      if (!isDuplicate(db, msg.msgId)) return true
      return shouldRetryProcessedMessage(db, msg) && getInlineImageByteLength(msg.content) > 0
    })
    .slice(-20)
  if (imageMessages.length === 0) return

  let updatedDb = db
  for (const msg of imageMessages) {
    const entry = await processMessage(msg, config, project, llmConfig)
    updatedDb = markProcessed(updatedDb, msg.msgId, entry)
  }
  Object.assign(db, updatedDb)
  await saveWechatDb(project.path, updatedDb)
}

function getInlineImageByteLength(content: string): number {
  try {
    const parsed = JSON.parse(content) as { imageDataBase64?: unknown }
    if (typeof parsed.imageDataBase64 !== "string" || !parsed.imageDataBase64) {
      return 0
    }
    return Math.floor((parsed.imageDataBase64.length * 3) / 4)
  } catch {
    return 0
  }
}

function extractUrl(text: string): string | null {
  const xmlMatch = text.match(
    /<url>[^<]*<!\[CDATA\[([^\]]*)\]\]><\/url>/i,
  )
  if (xmlMatch) return xmlMatch[1]

  const urlMatch = text.match(/https?:\/\/[^\s<>"{}|\\^`[\]]+/i)
  return urlMatch ? urlMatch[0] : null
}

function detectImageExt(data: Uint8Array): string | null {
  if (data[0] === 0xff && data[1] === 0xd8) return "jpg"
  if (data[0] === 0x89 && data[1] === 0x50) return "png"
  if (data[0] === 0x47 && data[1] === 0x49) return "gif"
  if (data[0] === 0x52 && data[1] === 0x49) return "webp"
  return null
}

function hashBuffer(data: Uint8Array): string {
  let hash = 0
  for (let i = 0; i < data.length; i++) {
    const ch = data[i]
    hash = ((hash << 5) - hash + ch) | 0
  }
  return Math.abs(hash).toString(16).padStart(8, "0")
}

async function doEnqueue(
  project: WikiProject,
  sourcePath: string,
  llmConfig: LlmConfig,
  entry: WechatProcessedMessage,
): Promise<void> {
  try {
    const ids = await enqueueSourceIngest(project, [sourcePath], llmConfig)
    if (ids.length > 0) {
      entry.ingestTaskId = ids[0]
    }
  } catch {
    // enqueue failed, file is still saved
  }
}
