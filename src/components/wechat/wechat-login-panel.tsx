import { useState, useEffect, useRef } from "react"
import { useWikiStore } from "@/stores/wiki-store"
import {
  startLogin,
  waitForLogin,
  startImport,
  stopImport,
  getSession,
  type WechatSession,
} from "@/lib/wechat-import"
import { Button } from "@/components/ui/button"
import { QrCode, LogOut, Loader2, AlertTriangle } from "lucide-react"

type LoginPhase =
  | "idle"
  | "starting_sidecar"
  | "waiting_scan"
  | "scanned"
  | "logged_in"
  | "error"

export function WechatLoginPanel() {
  const project = useWikiStore((s) => s.project)
  const config = useWikiStore((s) => s.wechatImportConfig)
  const wechatDisconnected = useWikiStore((s) => s.wechatDisconnected)
  const setWechatDisconnected = useWikiStore((s) => s.setWechatDisconnected)
  const [phase, setPhase] = useState<LoginPhase>("idle")
  const [qrData, setQrData] = useState<string | null>(null)
  const [session, setSession] = useState<WechatSession | null>(getSession())
  const [error, setError] = useState<string | null>(null)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const handleLogin = async () => {
    if (!project) return
    setPhase("starting_sidecar")
    setError(null)
    setWechatDisconnected(false)

    const { qrcode_id, qr_img_url } = await startLogin()
    if (!mountedRef.current) return

    setQrData(qr_img_url)
    setPhase("waiting_scan")

    waitForLogin(qrcode_id)
      .then((s) => {
        if (!mountedRef.current) return
        setSession(s)
        setPhase("logged_in")
        setQrData(null)
        // Delay import start so the UI settles first
        setTimeout(() => {
          startImport(config).catch((err) =>
            console.error("[wechat-login] startImport failed:", err),
          )
        }, 500)
      })
      .catch((e) => {
        if (!mountedRef.current) return
        setError(String(e))
        setPhase("error")
      })
  }

  const handleLogout = () => {
    stopImport()
    setSession(null)
    setPhase("idle")
    setQrData(null)
    setWechatDisconnected(false)
  }

  useEffect(() => {
    const existing = getSession()
    if (existing) {
      setSession(existing)
      setPhase("logged_in")
    }
  }, [])

  if (!project) {
    return (
      <div className="text-sm text-muted-foreground p-4">
        请先打开项目
      </div>
    )
  }

  return (
    <div className="space-y-4 p-4">
      <div>
        <h3 className="text-lg font-semibold">WeChat 登录</h3>
        <p className="text-sm text-muted-foreground">
          扫码登录后，文件传输助手消息将自动导入知识库
        </p>
      </div>

      {wechatDisconnected && (
        <div className="p-3 bg-amber-50 dark:bg-amber-950 rounded-lg flex items-start gap-3">
          <AlertTriangle className="h-5 w-5 text-amber-600 shrink-0 mt-0.5" />
          <div className="flex-1">
            <div className="text-sm font-medium text-amber-800 dark:text-amber-200">
              已掉线
            </div>
            <div className="text-xs text-amber-600 dark:text-amber-400 mt-1">
              微信连接已断开，请重新登录
            </div>
          </div>
        </div>
      )}

      {phase === "logged_in" && session ? (
        <div className="space-y-3">
          <div className="flex items-center gap-3 p-3 bg-green-50 dark:bg-green-950 rounded-lg">
            <div className="w-10 h-10 rounded-full bg-green-200 flex items-center justify-center text-green-700 font-bold">
              {session.nickname?.[0] || "W"}
            </div>
            <div>
              <div className="font-medium">{session.nickname || "微信用户"}</div>
              <div className="text-xs text-green-600">已登录</div>
            </div>
          </div>
          <Button
            variant="outline"
            onClick={handleLogout}
            className="w-full"
          >
            <LogOut className="mr-2 h-4 w-4" />
            退出登录
          </Button>
        </div>
      ) : phase === "error" ? (
        <div className="space-y-3">
          <div className="p-3 bg-red-50 dark:bg-red-950 rounded-lg text-sm text-red-600">
            {error}
          </div>
          <Button onClick={handleLogin} className="w-full">
            <QrCode className="mr-2 h-4 w-4" />
            重新登录
          </Button>
        </div>
      ) : phase === "idle" ? (
        <Button onClick={handleLogin} className="w-full">
          <QrCode className="mr-2 h-4 w-4" />
          扫码登录
        </Button>
      ) : phase === "starting_sidecar" ? (
        <div className="flex items-center justify-center p-8 text-muted-foreground">
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          正在启动服务...
        </div>
      ) : (
        <div className="space-y-4">
          {qrData && (
            <div className="flex justify-center">
              <img
                src={qrData}
                alt="微信登录二维码"
                className="w-48 h-48 border rounded-lg"
              />
            </div>
          )}
          <div className="flex items-center justify-center text-sm text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            {phase === "scanned" ? "已扫描，请在手机上确认" : "请使用微信扫描二维码"}
          </div>
        </div>
      )}
    </div>
  )
}
