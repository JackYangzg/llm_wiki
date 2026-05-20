import { describe, it, expect } from "vitest"
import {
  isDuplicate,
  markProcessed,
  updateSyncKey,
  type WechatImportDb,
  type WechatProcessedMessage,
} from "../wechat-db"

const EMPTY_DB: WechatImportDb = {
  lastSyncKey: "",
  processedMessages: {},
}

function makeEntry(overrides: Partial<WechatProcessedMessage> = {}): WechatProcessedMessage {
  return {
    msgId: "msg-001",
    msgType: "1",
    importedAt: 1700000000000,
    targetPath: "raw/sources/wechat/2025-01-01-note.md",
    decision: "imported",
    ...overrides,
  }
}

describe("isDuplicate", () => {
  it("returns false for unknown message", () => {
    expect(isDuplicate(EMPTY_DB, "msg-001")).toBe(false)
  })

  it("returns true for already processed message", () => {
    const db = markProcessed(EMPTY_DB, "msg-001", makeEntry())
    expect(isDuplicate(db, "msg-001")).toBe(true)
  })

  it("returns false for different message id", () => {
    const db = markProcessed(EMPTY_DB, "msg-001", makeEntry())
    expect(isDuplicate(db, "msg-002")).toBe(false)
  })
})

describe("markProcessed", () => {
  it("adds entry to empty db", () => {
    const entry = makeEntry()
    const db = markProcessed(EMPTY_DB, "msg-001", entry)
    expect(db.processedMessages["msg-001"]).toEqual(entry)
  })

  it("preserves existing entries", () => {
    const first = makeEntry({ msgId: "msg-001" })
    const second = makeEntry({ msgId: "msg-002" })
    let db = markProcessed(EMPTY_DB, "msg-001", first)
    db = markProcessed(db, "msg-002", second)
    expect(db.processedMessages["msg-001"]).toEqual(first)
    expect(db.processedMessages["msg-002"]).toEqual(second)
  })

  it("does not mutate the original db", () => {
    const original = { ...EMPTY_DB }
    markProcessed(original, "msg-001", makeEntry())
    expect(original.processedMessages["msg-001"]).toBeUndefined()
  })

  it("records skipped messages with reason", () => {
    const entry = makeEntry({
      decision: "skipped",
      skipReason: "filtered",
      targetPath: "",
    })
    const db = markProcessed(EMPTY_DB, "msg-xxx", entry)
    expect(db.processedMessages["msg-xxx"].decision).toBe("skipped")
    expect(db.processedMessages["msg-xxx"].skipReason).toBe("filtered")
  })
})

describe("updateSyncKey", () => {
  it("updates the sync key", () => {
    const db = updateSyncKey(EMPTY_DB, "sync-abc-123")
    expect(db.lastSyncKey).toBe("sync-abc-123")
  })

  it("does not mutate the original db", () => {
    const original = { ...EMPTY_DB }
    updateSyncKey(original, "new-key")
    expect(original.lastSyncKey).toBe("")
  })

  it("preserves processed messages", () => {
    let db = markProcessed(EMPTY_DB, "msg-001", makeEntry())
    db = updateSyncKey(db, "sync-xyz")
    expect(db.processedMessages["msg-001"]).toBeDefined()
    expect(db.lastSyncKey).toBe("sync-xyz")
  })
})
