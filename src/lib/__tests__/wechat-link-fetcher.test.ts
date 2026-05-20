import { describe, it, expect } from "vitest"

// Testing helper functions extracted from wechat-import.ts and wechat-link-fetcher.ts.
// These are tested at the unit level without Tauri dependencies.

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

describe("extractUrl", () => {
  it("extracts plain HTTP URL", () => {
    expect(extractUrl("看看这个 https://example.com/article")).toBe("https://example.com/article")
  })

  it("extracts plain HTTPS URL", () => {
    expect(extractUrl("http://test.org/path?q=1")).toBe("http://test.org/path?q=1")
  })

  it("extracts URL from WeChat XML CDATA", () => {
    const xml = '<msg><url><![CDATA[https://mp.weixin.qq.com/s/abc123]]></url></msg>'
    expect(extractUrl(xml)).toBe("https://mp.weixin.qq.com/s/abc123")
  })

  it("returns null for text without URL", () => {
    expect(extractUrl("这是一条纯文本消息")).toBeNull()
  })

  it("returns null for empty string", () => {
    expect(extractUrl("")).toBeNull()
  })

  it("stops at whitespace", () => {
    expect(extractUrl("看 https://a.com/path 这里")).toBe("https://a.com/path")
  })
})

describe("detectImageExt", () => {
  it("detects JPEG by magic bytes", () => {
    expect(detectImageExt(new Uint8Array([0xff, 0xd8, 0x00]))).toBe("jpg")
  })

  it("detects PNG by magic bytes", () => {
    expect(detectImageExt(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBe("png")
  })

  it("detects GIF by magic bytes", () => {
    expect(detectImageExt(new Uint8Array([0x47, 0x49, 0x46]))).toBe("gif")
  })

  it("detects WebP by magic bytes", () => {
    expect(detectImageExt(new Uint8Array([0x52, 0x49, 0x46, 0x46]))).toBe("webp")
  })

  it("returns null for unknown format", () => {
    expect(detectImageExt(new Uint8Array([0x00, 0x00, 0x00]))).toBeNull()
  })

  it("returns null for empty array", () => {
    expect(detectImageExt(new Uint8Array([]))).toBeNull()
  })
})

describe("hashBuffer", () => {
  it("returns consistent hash for same input", () => {
    const data = new Uint8Array([1, 2, 3, 4, 5])
    expect(hashBuffer(data)).toBe(hashBuffer(data))
  })

  it("returns different hash for different input", () => {
    const a = new Uint8Array([1, 2, 3])
    const b = new Uint8Array([1, 2, 4])
    expect(hashBuffer(a)).not.toBe(hashBuffer(b))
  })

  it("returns 8-char hex string", () => {
    const data = new Uint8Array(100).fill(0x42)
    const h = hashBuffer(data)
    expect(h).toMatch(/^[0-9a-f]{8}$/)
  })
})

describe("resolveUrl", () => {
  it("resolves relative path against base URL", () => {
    expect(resolveUrl("/path/to/page", "https://example.com")).toBe(
      "https://example.com/path/to/page",
    )
  })

  it("keeps absolute URL unchanged", () => {
    expect(resolveUrl("https://other.com/page", "https://example.com")).toBe(
      "https://other.com/page",
    )
  })

  it("returns original string for invalid URL", () => {
    expect(resolveUrl("not-a-url", "bad-base")).toBe("not-a-url")
  })
})

describe("extractSiteName", () => {
  it("extracts hostname from URL", () => {
    expect(extractSiteName("https://www.example.com/page")).toBe("example.com")
  })

  it("strips www prefix", () => {
    expect(extractSiteName("https://www.github.com")).toBe("github.com")
  })

  it("returns original string for invalid URL", () => {
    expect(extractSiteName("not-a-url")).toBe("not-a-url")
  })
})
