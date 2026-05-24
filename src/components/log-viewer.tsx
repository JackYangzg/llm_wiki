import { useTranslation } from "react-i18next"
import { X, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useLogStore } from "@/stores/log-store"

export function LogPanel() {
  const { t } = useTranslation()
  const panelOpen = useLogStore((s) => s.panelOpen)
  const entries = useLogStore((s) => s.entries)
  const clearLogs = useLogStore((s) => s.clearLogs)
  const closePanel = useLogStore((s) => s.closePanel)

  if (!panelOpen) return null

  return (
    <div className="fixed bottom-4 left-[3.5rem] z-50 flex max-h-[60vh] w-96 flex-col rounded-lg border bg-background shadow-xl">
      <div className="flex items-center justify-between border-b px-4 py-3 shrink-0">
        <span className="text-sm font-semibold">{t("log.panelTitle", "系统日志")}</span>
        <div className="flex items-center gap-1">
          {entries.length > 0 && (
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={clearLogs}
              title={t("log.clearAll", "清空")}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          )}
          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={closePanel}>
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto">
        {entries.length === 0 ? (
          <div className="px-4 py-10 text-center text-sm text-muted-foreground">
            {t("log.empty", "暂无日志")}
          </div>
        ) : (
          <div className="divide-y">
            {entries.map((entry) => (
              <div key={entry.id} className="px-4 py-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="text-sm font-medium">{entry.title}</div>
                  <span className="shrink-0 text-[11px] text-muted-foreground">
                    {formatTime(entry.timestamp)}
                  </span>
                </div>
                <div className="mt-1 text-xs text-muted-foreground whitespace-pre-wrap">
                  {entry.content}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function formatTime(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
