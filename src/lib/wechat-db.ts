import { readFile, writeFile } from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"

// ── Types ─────────────────────────────────────────────────────────────────

export interface WechatImportDb {
  lastSyncKey: string
  processedMessages: Record<string, WechatProcessedMessage>
}

export interface WechatProcessedMessage {
  msgId: string
  msgType: string
  importedAt: number
  targetPath: string
  ingestTaskId?: string
  decision: "imported" | "skipped"
  skipReason?: string
}

// ── Persistence ───────────────────────────────────────────────────────────

function dbPath(projectPath: string): string {
  return `${normalizePath(projectPath)}/.llm-wiki/wechat-import-db.json`
}

const EMPTY_DB: WechatImportDb = {
  lastSyncKey: "",
  processedMessages: {},
}

export async function loadWechatDb(projectPath: string): Promise<WechatImportDb> {
  try {
    const raw = await readFile(dbPath(projectPath))
    return { ...EMPTY_DB, ...JSON.parse(raw) }
  } catch {
    return { ...EMPTY_DB }
  }
}

export async function saveWechatDb(
  projectPath: string,
  db: WechatImportDb,
): Promise<void> {
  try {
    await writeFile(dbPath(projectPath), JSON.stringify(db, null, 2))
  } catch {
    // non-critical
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────

export function isDuplicate(db: WechatImportDb, msgId: string): boolean {
  return msgId in db.processedMessages
}

export function markProcessed(
  db: WechatImportDb,
  msgId: string,
  entry: WechatProcessedMessage,
): WechatImportDb {
  return {
    ...db,
    processedMessages: {
      ...db.processedMessages,
      [msgId]: entry,
    },
  }
}

export function updateSyncKey(db: WechatImportDb, key: string): WechatImportDb {
  return { ...db, lastSyncKey: key }
}

// ── Chat Message Persistence ────────────────────────────────────────────────

function chatMessagesPath(projectPath: string): string {
  return `${normalizePath(projectPath)}/.llm-wiki/wechat-messages.json`
}

export async function saveChatMessages(
  projectPath: string,
  messages: unknown[],
): Promise<void> {
  try {
    await writeFile(chatMessagesPath(projectPath), JSON.stringify(messages))
  } catch {
    // non-critical
  }
}

export async function loadChatMessages(projectPath: string): Promise<unknown[]> {
  try {
    const raw = await readFile(chatMessagesPath(projectPath))
    return JSON.parse(raw)
  } catch {
    return []
  }
}
