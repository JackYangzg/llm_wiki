import { invoke } from "@tauri-apps/api/core"

export interface FetchedUrl {
  title: string
  html: string
  final_url: string
}

export interface ParsedLink {
  url: string
  title: string
  markdown: string
  siteName: string
}

/**
 * Fetch a URL via the Rust backend (bypasses CORS, uses system proxy).
 */
export async function fetchUrlContent(url: string): Promise<ParsedLink> {
  const normalizedUrl = normalizeSharedLinkUrl(url)
  const result: FetchedUrl = await invoke("fetch_url_content", { url: normalizedUrl })

  const finalUrl = result.final_url || normalizedUrl
  const markdown = htmlToMarkdown(extractArticleHtml(result.html), finalUrl)
  const siteName = extractSiteName(finalUrl)

  return {
    url: finalUrl,
    title: result.title || siteName,
    markdown,
    siteName,
  }
}

export function normalizeSharedLinkUrl(url: string): string {
  let normalized = url.trim()

  for (let i = 0; i < 5; i++) {
    const next = normalized
      .replace(/&amp;/g, "&")
      .replace(/&#38;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
    if (next === normalized) break
    normalized = next
  }

  return normalized.replace(/<\/url>\s*$/i, "").trim()
}

function extractArticleHtml(html: string): string {
  const contentMatch = html.match(
    /<div[^>]+id=["']js_content["'][^>]*>([\s\S]*?)<\/div>\s*(?:<script|<div[^>]+id=["']js_sg_bar["'])/i,
  )
  return contentMatch ? contentMatch[1] : html
}

// ── Simple HTML → Markdown converter ──────────────────────────────────────

function htmlToMarkdown(html: string, baseUrl: string): string {
  let text = html

  text = text.replace(
    /<(script|style|nav|footer|header|aside|noscript)[^>]*>[\s\S]*?<\/\1>/gi,
    "",
  )

  // Convert block elements to newlines
  text = text.replace(/<\/?(div|p|li|tr|article|section|main)[^>]*>/gi, "\n")
  text = text.replace(/<br\s*\/?>/gi, "\n")
  text = text.replace(/<\/h[1-6]>/gi, "\n\n")
  text = text.replace(/<\/?h[1-6][^>]*>/gi, "\n## ")

  // Convert links: <a href="...">text</a> → [text](href)
  text = text.replace(
    /<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
    (_, href, inner) => {
      const resolved = resolveUrl(href, baseUrl)
      return `[${stripTags(inner)}](${resolved})`
    },
  )

  // Convert images
  text = text.replace(
    /<img[^>]*src=["']([^"']+)["'][^>]*\/?>/gi,
    (_, src) => `![](${resolveUrl(src, baseUrl)})`,
  )

  // Strip remaining tags
  text = text.replace(/<[^>]+>/g, "")

  // Decode common HTML entities
  text = text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")

  // Collapse whitespace
  text = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line, i, arr) => {
      if (line) return true
      if (i > 0 && arr[i - 1] === "") return false
      return true
    })
    .join("\n")
    .trim()

  return text
}

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, "").trim()
}

function resolveUrl(href: string, baseUrl: string): string {
  try {
    return new URL(href, baseUrl).toString()
  } catch {
    return href
  }
}

function extractSiteName(url: string): string {
  try {
    const host = new URL(url).hostname
    return host.replace(/^www\./, "")
  } catch {
    return url
  }
}
