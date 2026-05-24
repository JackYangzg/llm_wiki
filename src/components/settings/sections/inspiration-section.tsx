import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { useWikiStore } from "@/stores/wiki-store"
import { useInspirationStore } from "@/stores/inspiration-store"
import type { DraftSetter, SettingsDraft } from "../settings-types"
import { Lightbulb, Loader2, Play } from "lucide-react"

interface Props {
  draft: SettingsDraft
  setDraft: DraftSetter
}

export function InspirationSection({ draft, setDraft }: Props) {
  const { t } = useTranslation()
  const project = useWikiStore((s) => s.project)
  const llmConfig = useWikiStore((s) => s.llmConfig)
  const loading = useInspirationStore((s) => s.loading)
  const activeStatus = useInspirationStore((s) => s.activeStatus)
  const run = useInspirationStore((s) => s.run)

  async function runNow() {
    if (!project || loading) return
    await run(project.path, llmConfig, "daily", "manual")
    useWikiStore.getState().bumpDataVersion()
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold">
          {t("settings.sections.inspiration.title", { defaultValue: "灵思妙想" })}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("settings.sections.inspiration.description", {
            defaultValue: "配置每日主题、奇思妙想和梦境回放的后台触发方式。任务在全局后台运行，切换页面不会中断。",
          })}
        </p>
      </div>

      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={draft.inspirationEnabled}
          onChange={(e) => setDraft("inspirationEnabled", e.target.checked)}
          className="h-4 w-4"
        />
        <span className="text-sm">
          {t("settings.sections.inspiration.enable", { defaultValue: "启用后台触发" })}
        </span>
      </label>

      <div className="space-y-3 rounded-lg border p-3">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={draft.inspirationRunOnStartup}
            onChange={(e) => setDraft("inspirationRunOnStartup", e.target.checked)}
            disabled={!draft.inspirationEnabled}
            className="h-4 w-4"
          />
          <span className="text-sm">
            {t("settings.sections.inspiration.runOnStartup", { defaultValue: "App 启动或项目打开时触发每日构建" })}
          </span>
        </label>
        <p className="text-xs text-muted-foreground">
          {t("settings.sections.inspiration.runOnStartupHelp", {
            defaultValue: "同一天已有成功或正在运行的每日构建时不会重复触发。",
          })}
        </p>
      </div>

      <div className="space-y-3 rounded-lg border p-3">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={draft.inspirationDailyEnabled}
            onChange={(e) => setDraft("inspirationDailyEnabled", e.target.checked)}
            disabled={!draft.inspirationEnabled}
            className="h-4 w-4"
          />
          <span className="text-sm">
            {t("settings.sections.inspiration.daily", { defaultValue: "每日固定时间触发" })}
          </span>
        </label>
        <div className="space-y-2">
          <Label htmlFor="inspiration-daily-time">
            {t("settings.sections.inspiration.dailyTime", { defaultValue: "触发时间" })}
          </Label>
          <Input
            id="inspiration-daily-time"
            type="time"
            value={draft.inspirationDailyTime}
            onChange={(e) => setDraft("inspirationDailyTime", e.target.value)}
            disabled={!draft.inspirationEnabled || !draft.inspirationDailyEnabled}
            className="w-36"
          />
        </div>
        <p className="text-xs text-muted-foreground">
          {t("settings.sections.inspiration.dailyHelp", {
            defaultValue: "使用本机本地时间。应用需要保持运行，桌面端关闭后不会作为系统守护进程继续触发。",
          })}
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="inspiration-ideas-path">
          {t("settings.sections.inspiration.ideasPath", { defaultValue: "Idea 存放路径" })}
        </Label>
        <Input
          id="inspiration-ideas-path"
          value={draft.inspirationIdeasPath}
          onChange={(e) => setDraft("inspirationIdeasPath", e.target.value)}
          placeholder="wiki/ideas"
          disabled={!draft.inspirationEnabled}
        />
        <p className="text-xs text-muted-foreground">
          {t("settings.sections.inspiration.ideasPathHelp", {
            defaultValue: "每日构建和主题发散生成的 idea_card 会写入这里。路径相对于项目根目录，默认为 wiki/ideas。",
          })}
        </p>
      </div>

      <div className="space-y-3 rounded-lg border p-3">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={draft.inspirationContinuousEvolutionEnabled}
            onChange={(e) => setDraft("inspirationContinuousEvolutionEnabled", e.target.checked)}
            disabled={!draft.inspirationEnabled}
            className="h-4 w-4"
          />
          <span className="text-sm">
            {t("settings.sections.inspiration.continuousEvolution", { defaultValue: "开启后台持续演进" })}
          </span>
        </label>
        <div className="space-y-2">
          <Label htmlFor="inspiration-evolution-interval">
            {t("settings.sections.inspiration.evolutionInterval", { defaultValue: "演进间隔（分钟）" })}
          </Label>
          <Input
            id="inspiration-evolution-interval"
            type="number"
            min={5}
            max={1440}
            value={draft.inspirationEvolutionIntervalMinutes}
            onChange={(e) => {
              const value = parseInt(e.target.value, 10)
              if (!Number.isNaN(value)) setDraft("inspirationEvolutionIntervalMinutes", value)
            }}
            disabled={!draft.inspirationEnabled || !draft.inspirationContinuousEvolutionEnabled}
            className="w-32"
          />
        </div>
        <p className="text-xs text-muted-foreground">
          {t("settings.sections.inspiration.continuousEvolutionHelp", {
            defaultValue: "应用运行时会定期挑选未采纳/未驳回的 idea、主题和梦境追加演化记录并更新时间，不会覆盖你的手写改动。",
          })}
        </p>
      </div>

      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={draft.inspirationAutoDeepResearchEnabled}
          onChange={(e) => setDraft("inspirationAutoDeepResearchEnabled", e.target.checked)}
          disabled={!draft.inspirationEnabled || !draft.inspirationContinuousEvolutionEnabled}
          className="h-4 w-4"
        />
        <span className="text-sm">
          {t("settings.sections.inspiration.autoDeepResearch", { defaultValue: "演进时允许自动发起 Deep Research" })}
        </span>
      </label>

      <div className="space-y-3 rounded-lg border p-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="inspiration-dream-duration">
              {t("settings.sections.inspiration.dreamDuration", { defaultValue: "梦境最短运行时长（分钟）" })}
            </Label>
            <Input
              id="inspiration-dream-duration"
              type="number"
              min={60}
              max={1440}
              value={draft.inspirationDreamMinDurationMinutes}
              onChange={(e) => {
                const value = parseInt(e.target.value, 10)
                if (!Number.isNaN(value)) setDraft("inspirationDreamMinDurationMinutes", value)
              }}
              disabled={!draft.inspirationEnabled}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="inspiration-dream-step">
              {t("settings.sections.inspiration.dreamStep", { defaultValue: "做梦步进间隔（分钟）" })}
            </Label>
            <Input
              id="inspiration-dream-step"
              type="number"
              min={1}
              max={120}
              value={draft.inspirationDreamStepIntervalMinutes}
              onChange={(e) => {
                const value = parseInt(e.target.value, 10)
                if (!Number.isNaN(value)) setDraft("inspirationDreamStepIntervalMinutes", value)
              }}
              disabled={!draft.inspirationEnabled}
            />
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          {t("settings.sections.inspiration.dreamHelp", {
            defaultValue: "主题梦境或每日梦境启动后，会持续扩散、补支撑并逐步收敛，最短运行 60 分钟。",
          })}
        </p>
      </div>

      <div className="flex items-center gap-3">
        <Button variant="outline" size="sm" onClick={runNow} disabled={!project || loading}>
          {loading ? <Loader2 className="animate-spin" /> : <Play />}
          {loading
            ? t("settings.sections.inspiration.running", { defaultValue: "运行中：{{status}}", status: activeStatus ?? "queued" })
            : t("settings.sections.inspiration.runNow", { defaultValue: "立即运行每日构建" })}
        </Button>
        <div className="flex items-center gap-1 text-xs text-muted-foreground">
          <Lightbulb className="h-3.5 w-3.5" />
          {t("settings.sections.inspiration.backgroundNote", {
            defaultValue: "进入其他页面后任务仍会继续执行，并在完成后写回 wiki/inspirations。",
          })}
        </div>
      </div>
    </div>
  )
}
