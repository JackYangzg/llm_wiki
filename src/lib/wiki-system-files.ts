import { normalizePath } from "@/lib/path-utils"

const SYSTEM_FILE_NAMES = new Set(["index.md", "log.md", "overview.md", "purpose.md", "schema.md"])
const SYSTEM_STEM_IDS = new Set(["index", "log", "overview", "purpose", "schema"])

export function isSystemManagementPath(path: string): boolean {
  const normalized = normalizePath(path).toLowerCase()
  const name = normalized.split("/").pop() ?? ""
  if (SYSTEM_FILE_NAMES.has(name)) return true
  return (
    normalized.endsWith("/wiki/index.md") ||
    normalized.endsWith("/wiki/log.md") ||
    normalized.endsWith("/wiki/overview.md") ||
    normalized.endsWith("/purpose.md") ||
    normalized.endsWith("/schema.md")
  )
}

export function isSystemManagementId(id: string): boolean {
  return SYSTEM_STEM_IDS.has(id.toLowerCase())
}

export function isKnowledgeProcessingEligiblePath(path: string): boolean {
  const normalized = normalizePath(path).toLowerCase()
  if (isSystemManagementPath(normalized)) return false
  if (normalized.includes("/wiki/inspirations/")) return false
  if (normalized.includes("/wiki/media/")) return false
  return normalized.endsWith(".md")
}
