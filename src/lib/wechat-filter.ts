import type { LlmConfig } from "@/stores/wiki-store"

// ── Types ─────────────────────────────────────────────────────────────────

export type FilterMode = "prefix_only" | "ai_judge" | "both"

export interface WechatFilterConfig {
  mode: FilterMode
  triggerPrefix: string
}

export interface FilterResult {
  import: boolean
  reason: string
  strippedText?: string
}

export const DEFAULT_FILTER_CONFIG: WechatFilterConfig = {
  mode: "both",
  triggerPrefix: "/kb",
}

// ── Knowledge value judge ─────────────────────────────────────────────────

const JUDGE_PROMPT = `判断以下微信消息是否值得导入个人知识库。
值得导入：包含事实、观点、技术知识、决策理由、学习笔记等
不值得：日常提醒、临时备忘、纯情绪、无信息量内容

消息: "{text}"
答: YES 或 NO`

async function aiJudgeText(
  text: string,
  llmConfig: LlmConfig,
): Promise<boolean> {
  const prompt = JUDGE_PROMPT.replace("{text}", text)

  const body = buildLlmBody(llmConfig, prompt)
  const endpoint = getLlmEndpoint(llmConfig)

  try {
    const resp = await fetch(endpoint, {
      method: "POST",
      headers: getLlmHeaders(llmConfig),
      body: JSON.stringify(body),
    })
    const data = await resp.json()
    const answer = extractAnswer(data)
    return answer.toUpperCase().includes("YES")
  } catch {
    return false
  }
}

// ── Main filter ───────────────────────────────────────────────────────────

export async function shouldImportText(
  text: string,
  config: WechatFilterConfig,
  llmConfig: LlmConfig | null,
): Promise<FilterResult> {
  // 1. Check trigger prefix
  if (text.startsWith(config.triggerPrefix)) {
    const stripped = text.slice(config.triggerPrefix.length).trim()
    return {
      import: true,
      reason: "prefix",
      strippedText: stripped || text,
    }
  }

  // 2. Prefix-only mode: skip everything without prefix
  if (config.mode === "prefix_only") {
    return { import: false, reason: "filtered" }
  }

  // 3. AI judgment needed but no LLM configured
  if (!llmConfig || !llmConfig.apiKey) {
    if (config.mode === "ai_judge") {
      return { import: true, reason: "no_llm_fallback" }
    }
    return { import: false, reason: "no_llm" }
  }

  // 4. AI judgment
  const shouldImport = await aiJudgeText(text, llmConfig)
  return {
    import: shouldImport,
    reason: shouldImport ? "ai_yes" : "ai_no",
    strippedText: text,
  }
}

// ── LLM helpers ───────────────────────────────────────────────────────────

function getLlmEndpoint(config: LlmConfig): string {
  switch (config.provider) {
    case "openai":
      return "https://api.openai.com/v1/chat/completions"
    case "anthropic":
      return "https://api.anthropic.com/v1/messages"
    case "google":
      return `https://generativelanguage.googleapis.com/v1beta/models/${config.model}:generateContent`
    case "ollama":
      return `${config.ollamaUrl}/api/chat`
    case "custom":
      return config.customEndpoint
    default:
      return config.customEndpoint || `${config.ollamaUrl}/api/chat`
  }
}

function getLlmHeaders(config: LlmConfig): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" }

  if (config.provider === "anthropic") {
    headers["x-api-key"] = config.apiKey
    headers["anthropic-version"] = "2023-06-01"
  } else if (config.provider !== "google") {
    headers["Authorization"] = `Bearer ${config.apiKey}`
  }

  return headers
}

function buildLlmBody(config: LlmConfig, prompt: string): unknown {
  if (config.provider === "anthropic") {
    return {
      model: config.model,
      max_tokens: 10,
      messages: [{ role: "user", content: prompt }],
    }
  }
  if (config.provider === "google") {
    return {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: 10 },
    }
  }
  return {
    model: config.model,
    max_tokens: 10,
    messages: [{ role: "user", content: prompt }],
  }
}

function extractAnswer(data: Record<string, unknown>): string {
  if (data.choices && Array.isArray(data.choices) && data.choices[0]?.message?.content) {
    return String(data.choices[0].message.content)
  }
  if (data.content && Array.isArray(data.content) && data.content[0]?.text) {
    return String(data.content[0].text)
  }
  if (data.candidates && Array.isArray(data.candidates) && data.candidates[0]?.content?.parts?.[0]?.text) {
    return String(data.candidates[0].content.parts[0].text)
  }
  return ""
}
