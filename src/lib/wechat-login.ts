import { invoke } from "@tauri-apps/api/core"

export interface LoginQrResponse {
  qrcode_id: string
  qr_img_url: string
}

export type LoginStatusKind =
  | "waiting"
  | "scanned"
  | "confirmed"
  | "logged_in"
  | "timeout"
  | "error"

export interface LoginStatus {
  status: LoginStatusKind
  message: string
  nickname?: string
  avatar_url?: string
  wxid?: string
  session_token?: string
}

export interface WechatSession {
  token: string
  nickname: string
  avatarUrl: string
  accountId: string
  fileTransferUserId: string
}

export interface WechatCardInfo {
  title: string
  description: string
  url: string
  thumbUrl: string
  appName: string
}

export interface WechatMessage {
  msgId: string
  type: number // 1=text, 3=image, 49=file
  fromUser: string
  toUser: string
  content: string
  createTime: number
  card?: WechatCardInfo
}

export interface SyncResponse {
  messages: WechatMessage[]
  syncKey: string
  continue: boolean
  retcode: string
  selector: string
}

// ── QR Login ──────────────────────────────────────────────────────────────

export async function getLoginQr(): Promise<LoginQrResponse> {
  return invoke("wechat_get_login_qr")
}

export async function checkLoginStatus(
  qrcodeId: string,
): Promise<LoginStatus> {
  return invoke("wechat_check_login", { qrcodeId })
}

export async function getUserInfo(): Promise<{
  nickname: string
  avatar_url: string
  wxid: string
}> {
  return invoke("wechat_get_user_info")
}

// ── Session management ────────────────────────────────────────────────────

export async function resolveFileTransferUserId(): Promise<string> {
  return invoke("wechat_resolve_file_transfer")
}

// ── Message polling ───────────────────────────────────────────────────────

export async function syncMessages(): Promise<SyncResponse> {
  return invoke("wechat_sync_messages")
}

// ── File download ─────────────────────────────────────────────────────────

export async function downloadAttachment(
  cdnInfo: string,
  isImage?: boolean,
): Promise<ArrayBuffer> {
  if (isImage) {
    const inline = decodeInlineImage(cdnInfo)
    if (inline) return inline.buffer as ArrayBuffer
  }

  const bytes: number[] = await invoke("wechat_download_attachment", {
    cdnInfo,
    isImage: isImage ?? false,
    imageAeskey: null,
  })
  return new Uint8Array(bytes).buffer
}

function decodeInlineImage(cdnInfo: string): Uint8Array | null {
  try {
    const parsed = JSON.parse(cdnInfo) as { imageDataBase64?: unknown }
    if (typeof parsed.imageDataBase64 !== "string" || !parsed.imageDataBase64) {
      return null
    }
    const binary = atob(parsed.imageDataBase64)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i)
    }
    return bytes
  } catch {
    return null
  }
}

export async function disconnect(): Promise<void> {
  return invoke("wechat_filehelper_disconnect")
}

export async function sendMessage(content: string): Promise<void> {
  return invoke("wechat_send_message", { content })
}

export async function tryRestoreSession(): Promise<LoginStatus> {
  return invoke("wechat_try_restore_session")
}
