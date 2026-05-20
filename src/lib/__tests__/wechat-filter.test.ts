import { describe, it, expect } from "vitest"
import {
  shouldImportText,
  DEFAULT_FILTER_CONFIG,
  type WechatFilterConfig,
} from "../wechat-filter"
import type { LlmConfig } from "@/stores/wiki-store"

function makeLlmConfig(overrides: Partial<LlmConfig> = {}): LlmConfig {
  return {
    provider: "openai",
    apiKey: "test-key",
    model: "gpt-4",
    ollamaUrl: "http://localhost:11434",
    customEndpoint: "",
    maxContextSize: 204800,
    ...overrides,
  }
}

const prefixOnly: WechatFilterConfig = { mode: "prefix_only", triggerPrefix: "/kb" }
const aiJudge: WechatFilterConfig = { mode: "ai_judge", triggerPrefix: "/kb" }

describe("shouldImportText — prefix_only mode", () => {
  it("imports text starting with trigger prefix", async () => {
    const result = await shouldImportText("/kb Transformer architecture", prefixOnly, null)
    expect(result.import).toBe(true)
    expect(result.reason).toBe("prefix")
    expect(result.strippedText).toBe("Transformer architecture")
  })

  it("skips text without prefix", async () => {
    const result = await shouldImportText("普通消息", prefixOnly, null)
    expect(result.import).toBe(false)
    expect(result.reason).toBe("filtered")
  })

  it("handles prefix with no content after it", async () => {
    const result = await shouldImportText("/kb", prefixOnly, null)
    expect(result.import).toBe(true)
    expect(result.strippedText).toBe("/kb")
  })

  it("strips prefix whitespace", async () => {
    const result = await shouldImportText("/kb  知识内容  ", prefixOnly, null)
    expect(result.import).toBe(true)
    expect(result.strippedText).toBe("知识内容")
  })
})

describe("shouldImportText — ai_judge mode (no LLM)", () => {
  it("falls back to import when no LLM configured", async () => {
    const result = await shouldImportText("一些有用的技术笔记", aiJudge, null)
    expect(result.import).toBe(true)
    expect(result.reason).toBe("no_llm_fallback")
  })

  it("falls back to import when API key is empty", async () => {
    const noKey = makeLlmConfig({ apiKey: "" })
    const result = await shouldImportText("有用内容", aiJudge, noKey)
    expect(result.import).toBe(true)
    expect(result.reason).toBe("no_llm_fallback")
  })
})

describe("shouldImportText — both mode (no LLM)", () => {
  it("skips non-prefixed text when no LLM available", async () => {
    const config: WechatFilterConfig = { mode: "both", triggerPrefix: "/kb" }
    const result = await shouldImportText("普通消息", config, null)
    expect(result.import).toBe(false)
    expect(result.reason).toBe("no_llm")
  })

  it("still imports prefix-triggered text without LLM", async () => {
    const config: WechatFilterConfig = { mode: "both", triggerPrefix: "/kb" }
    const result = await shouldImportText("/kb 知识", config, null)
    expect(result.import).toBe(true)
    expect(result.reason).toBe("prefix")
  })
})

describe("DEFAULT_FILTER_CONFIG", () => {
  it('defaults to "both" mode with /kb prefix', () => {
    expect(DEFAULT_FILTER_CONFIG.mode).toBe("both")
    expect(DEFAULT_FILTER_CONFIG.triggerPrefix).toBe("/kb")
  })
})
