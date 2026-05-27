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

function accountSuffix(accountId?: string): string {
  if (!accountId) return ""
  const safe = accountId.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-|-$/g, "")
  return safe ? `-${safe}` : ""
}

function dbPath(projectPath: string, accountId?: string): string {
  return `${normalizePath(projectPath)}/.llm-wiki/wechat-import-db${accountSuffix(accountId)}.json`
}

const EMPTY_DB: WechatImportDb = {
  lastSyncKey: "",
  processedMessages: {},
}

export async function loadWechatDb(projectPath: string, accountId?: string): Promise<WechatImportDb> {
  try {
    const raw = await readFile(dbPath(projectPath, accountId))
    return { ...EMPTY_DB, ...JSON.parse(raw) }
  } catch {
    return { ...EMPTY_DB }
  }
}

export async function saveWechatDb(
  projectPath: string,
  db: WechatImportDb,
  accountId?: string,
): Promise<void> {
  try {
    await writeFile(dbPath(projectPath, accountId), JSON.stringify(db, null, 2))
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

function chatMessagesPath(projectPath: string, accountId?: string): string {
  return `${normalizePath(projectPath)}/.llm-wiki/wechat-messages${accountSuffix(accountId)}.json`
}

export async function saveChatMessages(
  projectPath: string,
  messages: unknown[],
  accountId?: string,
): Promise<void> {
  try {
    await writeFile(chatMessagesPath(projectPath, accountId), JSON.stringify(messages))
  } catch {
    // non-critical
  }
}

export async function loadChatMessages(projectPath: string, accountId?: string): Promise<unknown[]> {
  try {
    const raw = await readFile(chatMessagesPath(projectPath, accountId))
    return JSON.parse(raw)
  } catch {
    return []
  }
}
