import { useWikiStore } from "@/stores/wiki-store"
import { isPolling, startImport, stopImport } from "@/lib/wechat-import"
import type { FilterMode } from "@/lib/wechat-filter"
import { saveWechatImportConfig } from "@/lib/project-store"
import { Label } from "@/components/ui/label"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Play, Square, Wifi } from "lucide-react"
import { useState, useEffect, useCallback } from "react"

type Draft = ReturnType<typeof useWikiStore.getState>["wechatImportConfig"]

export function WechatImportSection() {
  const saved = useWikiStore((s) => s.wechatImportConfig)
  const setConfig = useWikiStore((s) => s.setWechatImportConfig)
  const project = useWikiStore((s) => s.project)
  const [running, setRunning] = useState(isPolling())
  const [draft, setDraft] = useState<Draft>(saved)
  const [savedFlag, setSavedFlag] = useState(false)

  useEffect(() => {
    const t = setInterval(() => setRunning(isPolling()), 500)
    return () => clearInterval(t)
  }, [])

  const handleSave = useCallback(async () => {
    setConfig(draft)
    await saveWechatImportConfig(draft)
    setSavedFlag(true)
    setTimeout(() => setSavedFlag(false), 2000)
  }, [draft, setConfig])

  const handleToggle = async () => {
    if (running) {
      stopImport()
      setRunning(false)
    } else {
      await startImport(draft)
      setRunning(true)
    }
  }

  if (!project) return null

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold">WeChat 导入</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          扫码登录微信后，自动将文件传输助手中的内容导入知识库
        </p>
      </div>

      <div className="flex items-center gap-2">
        <Wifi className={`h-4 w-4 ${running ? "text-green-500" : "text-muted-foreground"}`} />
        <span className="text-sm">
          状态: {running ? "运行中" : "已停止"}
        </span>
        <Button
          variant={running ? "destructive" : "default"}
          size="sm"
          onClick={handleToggle}
          className="ml-auto"
        >
          {running ? (
            <>
              <Square className="mr-2 h-3 w-3" />
              停止
            </>
          ) : (
            <>
              <Play className="mr-2 h-3 w-3" />
              启动
            </>
          )}
        </Button>
      </div>

      <div className="space-y-2">
        <Label>轮询间隔 (毫秒)</Label>
        <Input
          type="number"
          value={draft.pollIntervalMs}
          onChange={(e) =>
            setDraft({
              ...draft,
              pollIntervalMs: Math.max(1000, Number(e.target.value)),
            })
          }
          min={1000}
          max={30000}
        />
      </div>

      <div className="space-y-2">
        <Label>过滤模式</Label>
        <select
          value={draft.filter.mode}
          onChange={(e) =>
            setDraft({
              ...draft,
              filter: {
                ...draft.filter,
                mode: e.target.value as FilterMode,
              },
            })
          }
          className="w-full h-10 rounded-md border border-input bg-background px-3 text-sm"
        >
          <option value="prefix_only">仅前缀触发</option>
          <option value="ai_judge">AI 自动判断</option>
          <option value="both">前缀 + AI 判断</option>
        </select>
      </div>

      <div className="space-y-2">
        <Label>触发前缀</Label>
        <Input
          value={draft.filter.triggerPrefix}
          onChange={(e) =>
            setDraft({
              ...draft,
              filter: { ...draft.filter, triggerPrefix: e.target.value },
            })
          }
          placeholder="进知识库分析"
        />
        <p className="text-xs text-muted-foreground">
          以此前缀开头的文字消息将强制导入知识库
        </p>
      </div>

      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={draft.autoIngest}
          onChange={(e) =>
            setDraft({ ...draft, autoIngest: e.target.checked })
          }
          className="h-4 w-4"
        />
        <span className="text-sm">自动 ingest（导入后立即进行 LLM 分析）</span>
      </label>

      <div className="flex items-center justify-between gap-4 pt-4 border-t">
        <p className="text-xs text-muted-foreground">
          {savedFlag ? "已保存" : ""}
        </p>
        <Button onClick={handleSave}>保存</Button>
      </div>
    </div>
  )
}
