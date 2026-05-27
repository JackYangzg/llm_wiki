import { useState, useEffect, useRef, useCallback, memo } from "react"
import { convertFileSrc } from "@tauri-apps/api/core"
import { useWikiStore } from "@/stores/wiki-store"
import {
  startLogin,
  waitForLogin,
  startImport,
  stopImport,
  getSession,
  setSession as setImportSession,
  type WechatSession,
} from "@/lib/wechat-import"
import { sendMessage, tryRestoreSession, downloadAttachment } from "@/lib/wechat-login"
import { loadChatMessages } from "@/lib/wechat-db"
import type { WechatMessage, WechatCardInfo } from "@/lib/wechat-login"
import { writeBinaryFile } from "@/commands/fs"
import { Button } from "@/components/ui/button"
import { QrCode, LogOut, Loader2, AlertTriangle, X, MessageCircle, ImageIcon, FileIcon, Download } from "lucide-react"
import { useTranslation } from "react-i18next"
import { WechatChatInput } from "./wechat-chat-input"

type LoginPhase =
  | "idle"
  | "starting_sidecar"
  | "waiting_scan"
  | "scanned"
  | "logged_in"
  | "error"

// ── Card Bubble ──────────────────────────────────────────────────────────────

const CardBubble = memo(function CardBubble({
  card,
  rawContent,
}: {
  card?: WechatCardInfo
  rawContent: string
}) {
  if (card && (card.title || card.url)) {
    return (
      <a
        href={card.url || "#"}
        target="_blank"
        rel="noopener noreferrer"
        className="block w-64 rounded-lg overflow-hidden border bg-card text-card-foreground shadow-sm hover:shadow-md transition-shadow no-underline"
      >
        {card.thumbUrl && (
          <div className="w-full h-32 bg-muted overflow-hidden">
            <img
              src={card.thumbUrl}
              alt={card.title}
              className="w-full h-full object-cover"
              loading="lazy"
            />
          </div>
        )}
        <div className="p-3">
          <div className="text-sm font-medium leading-snug line-clamp-2">
            {card.title}
          </div>
          {card.description && (
            <div className="text-xs text-muted-foreground mt-1 line-clamp-2">
              {card.description}
            </div>
          )}
          {card.appName && (
            <div className="text-[10px] text-muted-foreground/60 mt-2">
              {card.appName}
            </div>
          )}
        </div>
      </a>
    )
  }

  const urlMatch = rawContent.match(/https?:\/\/[^\s<>"{}|\\^`[\]]+/i)
  if (urlMatch) {
    return (
      <a
        href={urlMatch[0]}
        target="_blank"
        rel="noopener noreferrer"
        className="block max-w-[260px] text-xs text-blue-500 underline break-all"
      >
        {urlMatch[0]}
      </a>
    )
  }

  return <div className="text-xs text-muted-foreground">[File]</div>
})

// ── Image Bubble ──────────────────────────────────────────────────────────

const ImageBubble = memo(function ImageBubble({ content }: { content: string }) {
  const [state, setState] = useState<"loading" | "loaded" | "error">("loading")
  const [imageUrl, setImageUrl] = useState<string | null>(null)
  const projectPath = useWikiStore((s) => s.project?.path)
  const updateWechatMessage = useWikiStore((s) => s.updateWechatMessage)

  useEffect(() => {
    let cancelled = false
    let objectUrl: string | null = null
    const cached = parseCachedImagePath(content)
    if (cached) {
      setImageUrl(convertFileSrc(cached))
      setState("loaded")
      return () => {
        cancelled = true
      }
    }

    downloadAttachment(content, true)
      .then(async (buf) => {
        if (cancelled) return
        const bytes = new Uint8Array(buf)
        const mimeType = detectImageMime(bytes)

        if (projectPath) {
          const hash = simpleHash(bytes)
          const ext = mimeType.split("/")[1] || "jpg"
          const dateStr = new Date().toISOString().slice(0, 10)
          const fileName = `img-${dateStr}-${hash}.${ext}`
          const relDir = "raw/sources/wechat"
          const fullPath = `${projectPath}/${relDir}/${fileName}`
          try {
            await writeBinaryFile(fullPath, bytes)
            if (cancelled) return
            updateCachedContent(content, fullPath, `${relDir}/${fileName}`, updateWechatMessage)
            setImageUrl(convertFileSrc(fullPath))
            setState("loaded")
          } catch {
            if (!cancelled) {
              objectUrl = URL.createObjectURL(new Blob([bytes], { type: mimeType }))
              setImageUrl(objectUrl)
              setState("loaded")
            }
          }
        } else {
          objectUrl = URL.createObjectURL(new Blob([bytes], { type: mimeType }))
          if (!cancelled) {
            setImageUrl(objectUrl)
            setState("loaded")
          }
        }
      })
      .catch(() => {
        if (!cancelled) setState("error")
      })
    return () => {
      cancelled = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [content, projectPath])

  if (state === "loading") {
    return (
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" />
        Loading image...
      </div>
    )
  }

  if (state === "error" || !imageUrl) {
    return (
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <ImageIcon className="h-3 w-3" />
        [Image]
      </div>
    )
  }

  return (
    <img
      src={imageUrl}
      alt="WeChat image"
      className="max-w-[240px] max-h-[240px] rounded-md object-cover cursor-pointer hover:opacity-90 transition-opacity"
      loading="lazy"
      onClick={() => {
        window.open(imageUrl ?? "", "_blank", "noopener,noreferrer")
      }}
    />
  )
})

function simpleHash(data: Uint8Array): string {
  let hash = 0
  for (let i = 0; i < data.length; i++) {
    hash = ((hash << 5) - hash + data[i]) | 0
  }
  return Math.abs(hash).toString(16).padStart(8, "0")
}

function parseMsgIdFromContent(content: string): string {
  try {
    const parsed = JSON.parse(content) as { msgId?: unknown }
    return typeof parsed.msgId === "string" ? parsed.msgId : ""
  } catch {
    return ""
  }
}

function updateCachedContent(
  originalContent: string,
  localPath: string,
  localRelPath: string,
  updateFn: (msgId: string, patch: Partial<WechatMessage>) => void,
): void {
  let newContent: string
  const msgId = parseMsgIdFromContent(originalContent)
  try {
    const parsed = JSON.parse(originalContent) as Record<string, unknown>
    newContent = JSON.stringify({ ...parsed, localPath, localRelPath })
  } catch {
    newContent = JSON.stringify({ msgId, rawContent: originalContent, localPath, localRelPath })
  }
  if (msgId) {
    updateFn(msgId, { content: newContent })
  }
}

function sanitizeFileName(name: string, maxLen: number): string {
  return name
    .replace(/[/\\?%*:|"<>]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, maxLen)
    .replace(/-$/g, "") || "file"
}

function parseCachedImagePath(content: string): string | null {
  try {
    const parsed = JSON.parse(content) as { localPath?: unknown }
    return typeof parsed.localPath === "string" && parsed.localPath
      ? parsed.localPath
      : null
  } catch {
    return null
  }
}

function detectImageMime(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg"
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return "image/png"
  if (bytes[0] === 0x47 && bytes[1] === 0x49) return "image/gif"
  if (bytes[0] === 0x52 && bytes[1] === 0x49) return "image/webp"
  return "image/jpeg"
}

// ── File Bubble ──────────────────────────────────────────────────────────

interface FileInfo {
  fileName?: string
  fileSize?: string
  localPath?: string
  msgId?: string
  mediaId?: string
  rawContent?: string
}

function parseFileInfo(content: string): FileInfo | null {
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>
    if (parsed.fileName && (parsed.mediaId || parsed.rawContent)) {
      return {
        fileName: String(parsed.fileName),
        fileSize: typeof parsed.fileSize === "string" ? String(parsed.fileSize) : undefined,
        localPath: typeof parsed.localPath === "string" ? String(parsed.localPath) : undefined,
        msgId: typeof parsed.msgId === "string" ? String(parsed.msgId) : undefined,
        mediaId: typeof parsed.mediaId === "string" ? String(parsed.mediaId) : undefined,
        rawContent: typeof parsed.rawContent === "string" ? String(parsed.rawContent) : undefined,
      }
    }
    return null
  } catch {
    return null
  }
}

function formatFileSize(sizeStr: string): string {
  const bytes = parseInt(sizeStr, 10)
  if (isNaN(bytes)) return sizeStr
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

const FileBubble = memo(function FileBubble({ content }: { content: string }) {
  const fileInfo = parseFileInfo(content)
  const projectPath = useWikiStore((s) => s.project?.path)
  const updateWechatMessage = useWikiStore((s) => s.updateWechatMessage)
  const [downloadedPath, setDownloadedPath] = useState<string | null>(
    fileInfo?.localPath ?? null,
  )
  const [downloadFailed, setDownloadFailed] = useState(false)
  const downloadingRef = useRef(false)
  const mountedRef = useRef(true)

  const downloadFile = useCallback(() => {
    if (!fileInfo || fileInfo.localPath || !projectPath || downloadingRef.current) return

    downloadingRef.current = true
    setDownloadFailed(false)

    downloadAttachment(content)
      .then(async (buf) => {
        if (!mountedRef.current) return
        const bytes = new Uint8Array(buf)
        if (bytes.byteLength === 0) {
          setDownloadFailed(true)
          return
        }
        const dateStr = new Date().toISOString().slice(0, 10)
        const safeName = sanitizeFileName(String(fileInfo.fileName ?? "file"), 80)
        const fileName = `file-${dateStr}-${safeName}`
        const relDir = "raw/sources/wechat"
        const fullPath = `${projectPath}/${relDir}/${fileName}`
        try {
          await writeBinaryFile(fullPath, bytes)
          if (!mountedRef.current) return
          setDownloadedPath(fullPath)
          updateCachedContent(content, fullPath, `${relDir}/${fileName}`, updateWechatMessage)
        } catch {
          if (mountedRef.current) setDownloadFailed(true)
        }
      })
      .catch(() => {
        if (mountedRef.current) setDownloadFailed(true)
      })
      .finally(() => {
        downloadingRef.current = false
      })
  }, [
    content,
    fileInfo?.fileName,
    fileInfo?.localPath,
    fileInfo?.mediaId,
    fileInfo?.rawContent,
    projectPath,
    updateWechatMessage,
  ])

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  // Update downloadedPath when content changes (e.g. after cacheFilePathOnMessage)
  useEffect(() => {
    if (fileInfo?.localPath) {
      setDownloadedPath(fileInfo.localPath)
      setDownloadFailed(false)
    }
  }, [fileInfo?.localPath])

  // Auto-download if no local cache (runs once per content change)
  useEffect(() => {
    downloadFile()
  }, [downloadFile])

  if (!fileInfo) {
    return <div className="text-xs text-muted-foreground">[File]</div>
  }

  const handleOpen = () => {
    if (downloadedPath) {
      const url = convertFileSrc(downloadedPath)
      window.open(url, "_blank", "noopener,noreferrer")
    }
  }

  return (
    <div className="flex items-center gap-2 max-w-[260px]">
      <div className="flex items-center gap-2 p-2 rounded-md bg-background/50 flex-1 min-w-0">
        <FileIcon className="h-5 w-5 shrink-0 text-blue-500" />
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium truncate">
            {fileInfo.fileName || "Unknown file"}
          </div>
          {fileInfo.fileSize && (
            <div className="text-[10px] text-muted-foreground">
              {formatFileSize(fileInfo.fileSize)}
            </div>
          )}
        </div>
        {downloadedPath ? (
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 shrink-0"
            onClick={handleOpen}
          >
            <Download className="h-3 w-3" />
          </Button>
        ) : downloadFailed ? (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 shrink-0 px-1.5 text-[10px] text-red-500 hover:text-red-600"
            onClick={downloadFile}
          >
            Retry
          </Button>
        ) : (
          <Loader2 className="h-3 w-3 shrink-0 animate-spin text-muted-foreground" />
        )}
      </div>
    </div>
  )
})

// ── Message Row (memo to avoid re-rendering all rows on new message) ─────

const MessageRow = memo(function MessageRow({ msg }: { msg: WechatMessage }) {
  const isFileAttachment = msg.type === 49 && parseFileInfo(msg.content) !== null

  return (
    <div
      className={`flex ${
        msg.fromUser === "self" ? "justify-end" : "justify-start"
      }`}
    >
      <div
        className={`max-w-[85%] rounded-lg px-3 py-2 text-sm ${
          msg.fromUser === "self"
            ? "bg-primary text-primary-foreground"
            : "bg-muted"
        }`}
      >
        {msg.type === 1 ? (
          <p className="whitespace-pre-wrap break-words">{msg.content}</p>
        ) : msg.type === 3 ? (
          <ImageBubble content={msg.content} />
        ) : isFileAttachment ? (
          <FileBubble content={msg.content} />
        ) : msg.type === 49 ? (
          <CardBubble card={msg.card} rawContent={msg.content} />
        ) : (
          <p className="whitespace-pre-wrap break-words">{msg.content}</p>
        )}
      </div>
    </div>
  )
})

// ── Message List ─────────────────────────────────────────────────────────────

const MAX_RENDERED_MESSAGES = 150

const MessageList = memo(function MessageList() {
  const messages = useWikiStore((s) => s.wechatMessages)
  const endRef = useRef<HTMLDivElement>(null)
  const isFirstMount = useRef(true)

  useEffect(() => {
    if (isFirstMount.current) {
      isFirstMount.current = false
      setTimeout(() => endRef.current?.scrollIntoView({ block: "end" }), 50)
    }
  }, [messages.length])

  if (messages.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-xs text-muted-foreground">
        {/* i18n key resolved by parent */}
      </div>
    )
  }

  const visibleMessages =
    messages.length > MAX_RENDERED_MESSAGES
      ? messages.slice(-MAX_RENDERED_MESSAGES)
      : messages

  return (
    <div className="flex-1 overflow-y-auto p-3 space-y-3">
      {visibleMessages.map((msg) => (
        <MessageRow key={msg.msgId} msg={msg} />
      ))}
      <div ref={endRef} />
    </div>
  )
})

// ── Wechat Panel ─────────────────────────────────────────────────────────────

export function WechatPanel() {
  const { t } = useTranslation()
  const project = useWikiStore((s) => s.project)
  const config = useWikiStore((s) => s.wechatImportConfig)
  const wechatDisconnected = useWikiStore((s) => s.wechatDisconnected)
  const setWechatDisconnected = useWikiStore((s) => s.setWechatDisconnected)
  const setWechatPanelOpen = useWikiStore((s) => s.setWechatPanelOpen)
  const hasWechatMessages = useWikiStore((s) => s.wechatMessages.length > 0)
  const setWechatMessages = useWikiStore((s) => s.setWechatMessages)
  const addWechatMessages = useWikiStore((s) => s.addWechatMessages)
  const clearWechatMessages = useWikiStore((s) => s.clearWechatMessages)
  const resetWechatUnread = useWikiStore((s) => s.resetWechatUnread)

  const [phase, setPhase] = useState<LoginPhase>("idle")
  const [qrData, setQrData] = useState<string | null>(null)
  const [session, setSession] = useState<WechatSession | null>(getSession())
  const [error, setError] = useState<string | null>(null)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    resetWechatUnread()
    return () => {
      mountedRef.current = false
    }
  }, [resetWechatUnread])

  // Load persisted chat messages for the active project + WeChat account.
  useEffect(() => {
    if (!project || !session) return
    loadChatMessages(project.path, session.accountId).then((msgs) => {
      if (!mountedRef.current) return
      setWechatMessages(msgs as WechatMessage[])
    }).catch(() => {})
  }, [project?.path, session?.accountId, setWechatMessages])

  // Check for existing session on mount (in-memory + persisted)
  useEffect(() => {
    const existing = getSession()
    if (existing) {
      setSession(existing)
      setPhase("logged_in")
      return
    }
    tryRestoreSession().then((status) => {
      if (!mountedRef.current) return
      if (status.status === "logged_in") {
        const s: WechatSession = {
          token: "filehelper_session",
          nickname: status.nickname || "",
          avatarUrl: status.avatar_url || "",
          accountId: status.wxid || status.nickname || "wechat",
          fileTransferUserId: "filehelper",
        }
        clearWechatMessages()
        setSession(s)
        setPhase("logged_in")
        stopImport()
        setImportSession(s)
        setTimeout(() => {
          startImport(config).catch((err) =>
            console.error("[wechat-panel] startImport failed:", err),
          )
        }, 500)
      }
    }).catch(() => {})
  }, [config])

  const handleLogin = async () => {
    if (!project) return
    setPhase("starting_sidecar")
    setError(null)
    setWechatDisconnected(false)

    try {
      const { qrcode_id, qr_img_url } = await startLogin()
      if (!mountedRef.current) return

      setQrData(qr_img_url)
      setPhase("waiting_scan")

      const s = await waitForLogin(qrcode_id)
      if (!mountedRef.current) return

      if (session?.accountId !== s.accountId) {
        clearWechatMessages()
      }
      setSession(s)
      setPhase("logged_in")
      setQrData(null)

      stopImport()
      setImportSession(s)
      setTimeout(() => {
        startImport(config).catch((err) =>
          console.error("[wechat-panel] startImport failed:", err),
        )
      }, 500)
    } catch (e) {
      if (!mountedRef.current) return
      setError(String(e))
      setPhase("error")
    }
  }

  const handleLogout = useCallback(() => {
    stopImport()
    setSession(null)
    clearWechatMessages()
    setPhase("idle")
    setQrData(null)
    setWechatDisconnected(false)
  }, [setWechatDisconnected, clearWechatMessages])

  const handleSend = useCallback(async (text: string) => {
    // Optimistic: add local message immediately before IPC
    const localMsg = {
      msgId: `local-${Date.now()}`,
      type: 1 as const,
      fromUser: "self" as const,
      toUser: "filehelper",
      content: text,
      createTime: Math.floor(Date.now() / 1000),
    }
    addWechatMessages([localMsg])
    try {
      await sendMessage(text)
    } catch (e) {
      console.error("[wechat-panel] send failed:", e)
    }
  }, [addWechatMessages])

  if (!project) {
    return (
      <div className="flex h-full flex-col">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <div className="flex items-center gap-2 text-sm font-medium">
            <MessageCircle className="h-4 w-4" />
            {t("wechat.panelTitle")}
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={() => setWechatPanelOpen(false)}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
        <div className="flex flex-1 items-center justify-center p-4 text-sm text-muted-foreground">
          {t("wechat.noProject")}
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center justify-between border-b px-4 py-3 shrink-0">
        <div className="flex items-center gap-2 text-sm font-medium">
          <MessageCircle className="h-4 w-4" />
          {t("wechat.panelTitle")}
          {phase === "logged_in" && (
            <span className="flex items-center gap-1 text-xs text-emerald-600">
              <span className="h-2 w-2 rounded-full bg-emerald-500" />
              {t("wechat.connected")}
            </span>
          )}
          {wechatDisconnected && (
            <span className="flex items-center gap-1 text-xs text-amber-600">
              <span className="h-2 w-2 rounded-full bg-amber-500" />
              {t("wechat.disconnected")}
            </span>
          )}
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={() => setWechatPanelOpen(false)}
        >
          <X className="h-4 w-4" />
        </Button>
      </div>

      {/* Disconnect warning */}
      {wechatDisconnected && (
        <div className="flex items-start gap-2 border-b bg-amber-50 px-4 py-2 dark:bg-amber-950 shrink-0">
          <AlertTriangle className="h-4 w-4 text-amber-600 shrink-0 mt-0.5" />
          <div className="flex-1">
            <div className="text-xs font-medium text-amber-800 dark:text-amber-200">
              {t("wechat.disconnected")}
            </div>
          </div>
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs"
            onClick={handleLogin}
          >
            {t("wechat.relogin")}
          </Button>
        </div>
      )}

      {/* Body — child views handle their own scrolling */}
      <div className="flex-1 min-h-0">
        {phase === "logged_in" && session ? (
          <div className="flex flex-col h-full">
            {!hasWechatMessages ? (
              <div className="flex items-center justify-center h-full text-xs text-muted-foreground">
                {t("wechat.noMessages")}
              </div>
            ) : (
              <MessageList />
            )}
            <WechatChatInput
              onSend={handleSend}
              placeholder={t("wechat.typeMessage")}
            />
          </div>
        ) : phase === "error" ? (
          <div className="flex flex-col items-center justify-center h-full gap-3 p-4">
            <div className="p-3 bg-red-50 dark:bg-red-950 rounded-lg text-sm text-red-600 w-full">
              {error || t("wechat.loginFailed")}
            </div>
            <Button onClick={handleLogin} className="w-full">
              <QrCode className="mr-2 h-4 w-4" />
              {t("wechat.relogin")}
            </Button>
          </div>
        ) : phase === "idle" ? (
          <div className="flex flex-col items-center justify-center h-full gap-3 p-4">
            <Button onClick={handleLogin} className="w-full">
              <QrCode className="mr-2 h-4 w-4" />
              {t("wechat.scanPrompt")}
            </Button>
          </div>
        ) : phase === "starting_sidecar" ? (
          <div className="flex items-center justify-center h-full text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            {t("wechat.startingService")}
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center h-full gap-4 p-4">
            {qrData && (
              <div className="flex justify-center">
                <img
                  src={qrData}
                  alt="WeChat QR"
                  className="w-48 h-48 border rounded-lg"
                />
              </div>
            )}
            <div className="flex items-center justify-center text-sm text-muted-foreground">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              {phase === "scanned"
                ? t("wechat.scanConfirm")
                : t("wechat.scanPrompt")}
            </div>
          </div>
        )}
      </div>

      {/* Logout footer (when logged in) */}
      {phase === "logged_in" && session && (
        <div className="border-t px-4 py-2 shrink-0">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="w-7 h-7 rounded-full bg-green-200 flex items-center justify-center text-green-700 font-bold text-xs">
                {session.nickname?.[0] || "W"}
              </div>
              <span className="text-xs font-medium truncate max-w-[120px]">
                {session.nickname || "WeChat"}
              </span>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={handleLogout}
              className="h-7 text-xs text-muted-foreground"
            >
              <LogOut className="mr-1 h-3 w-3" />
              {t("wechat.relogin")}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
