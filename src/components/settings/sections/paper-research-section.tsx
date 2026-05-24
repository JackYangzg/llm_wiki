import { Label } from "@/components/ui/label"
import { useTranslation } from "react-i18next"
import type { DraftSetter, SettingsDraft } from "../settings-types"
import { useState } from "react"
import { Loader2, Plus, Sparkles, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useWikiStore } from "@/stores/wiki-store"
import { recommendMonitorTopics } from "@/lib/paper-monitor"

interface PaperResearchSectionProps {
  draft: SettingsDraft
  setDraft: DraftSetter
}

const ALL_SOURCES: { value: SettingsDraft["paperMonitorSources"][number]; labelKey: string }[] = [
  { value: "arxiv", labelKey: "paperResearch.monitor.sourceArxiv" },
  { value: "openalex", labelKey: "paperResearch.monitor.sourceOpenAlex" },
  { value: "crossref", labelKey: "paperResearch.monitor.sourceCrossref" },
]

export function PaperResearchSection({ draft, setDraft }: PaperResearchSectionProps) {
  const { t } = useTranslation()
  const llmConfig = useWikiStore((s) => s.llmConfig)
  const [newTopic, setNewTopic] = useState("")
  const [recommending, setRecommending] = useState(false)
  const [recommendations, setRecommendations] = useState<string[]>([])
  const [recommendError, setRecommendError] = useState<string | null>(null)

  const toggleSource = (source: typeof ALL_SOURCES[number]["value"]) => {
    const current = draft.paperMonitorSources
    const next = current.includes(source)
      ? current.filter((s) => s !== source)
      : [...current, source]
    setDraft("paperMonitorSources", next)
  }

  const addTopic = (query?: string) => {
    const q = (query ?? newTopic).trim()
    if (!q) return
    const topics = draft.paperMonitorTopics
    setDraft("paperMonitorTopics", [
      ...topics,
      { id: `t${Date.now()}`, query: q, enabled: true },
    ])
    setNewTopic("")
    setRecommendations((prev) => prev.filter((r) => r !== query))
  }

  const removeTopic = (id: string) => {
    setDraft("paperMonitorTopics", draft.paperMonitorTopics.filter((t) => t.id !== id))
  }

  const toggleTopic = (id: string) => {
    setDraft(
      "paperMonitorTopics",
      draft.paperMonitorTopics.map((t) =>
        t.id === id ? { ...t, enabled: !t.enabled } : t,
      ),
    )
  }

  const recommend = async () => {
    const q = newTopic.trim()
    if (!q) return
    setRecommending(true)
    setRecommendations([])
    setRecommendError(null)
    try {
      const result = await recommendMonitorTopics(q, llmConfig)
      if (result.length === 0) {
        setRecommendError(t("paperResearch.monitor.recommendEmpty"))
      } else {
        setRecommendations(result)
      }
    } catch {
      setRecommendError(t("paperResearch.monitor.recommendError"))
    } finally {
      setRecommending(false)
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">{t("paperResearch.settingsTitle")}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("paperResearch.settingsDescription")}
        </p>
      </div>

      <label className="flex items-start gap-3 rounded-md border p-3">
        <input
          type="checkbox"
          checked={draft.paperResearchAutoAnalyze}
          onChange={(e) => setDraft("paperResearchAutoAnalyze", e.target.checked)}
          className="mt-1"
        />
        <span>
          <span className="block text-sm font-medium">{t("paperResearch.settingsAutoAnalyze")}</span>
          <span className="block text-xs text-muted-foreground">
            {t("paperResearch.settingsAutoAnalyzeHelp")}
          </span>
        </span>
      </label>

      <div className="space-y-2">
        <Label>{t("paperResearch.settingsImportDestination")}</Label>
        <select
          value={draft.paperResearchImportDestination}
          onChange={(e) => setDraft("paperResearchImportDestination", e.target.value as SettingsDraft["paperResearchImportDestination"])}
          className="w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring"
        >
          <option value="papers">{t("paperResearch.settingsDestinationPapers")}</option>
          <option value="sources">{t("paperResearch.settingsDestinationSources")}</option>
        </select>
        <p className="text-xs text-muted-foreground">
          {t("paperResearch.settingsImportDestinationHelp")}
        </p>
      </div>

      <div className="space-y-2">
        <Label>{t("paperResearch.settingsQueryCount")}</Label>
        <input
          type="number"
          min={1}
          max={5}
          value={draft.paperResearchLiteratureQueryCount}
          onChange={(e) => setDraft("paperResearchLiteratureQueryCount", Number(e.target.value) || 3)}
          className="w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring"
        />
        <p className="text-xs text-muted-foreground">
          {t("paperResearch.settingsQueryCountHelp")}
        </p>
      </div>

      <div className="border-t pt-6 space-y-6">
        <div>
          <h2 className="text-lg font-semibold">{t("paperResearch.monitor.title")}</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("paperResearch.monitor.description")}
          </p>
        </div>

        <label className="flex items-start gap-3 rounded-md border p-3">
          <input
            type="checkbox"
            checked={draft.paperMonitorEnabled}
            onChange={(e) => setDraft("paperMonitorEnabled", e.target.checked)}
            className="mt-1"
          />
          <span>
            <span className="block text-sm font-medium">{t("paperResearch.monitor.enable")}</span>
            <span className="block text-xs text-muted-foreground">
              {t("paperResearch.monitor.enableHelp")}
            </span>
          </span>
        </label>

        {draft.paperMonitorEnabled && (
          <>
            <div className="space-y-2">
              <Label>{t("paperResearch.monitor.scheduledTime")}</Label>
              <input
                type="time"
                value={draft.paperMonitorScheduledTime}
                onChange={(e) => setDraft("paperMonitorScheduledTime", e.target.value)}
                className="w-40 rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring"
              />
              <p className="text-xs text-muted-foreground">
                {t("paperResearch.monitor.scheduledTimeHelp")}
              </p>
            </div>

            <div className="space-y-3">
              <Label>{t("paperResearch.monitor.topics")}</Label>
              <div className="space-y-2">
                {draft.paperMonitorTopics.map((topic) => (
                  <div key={topic.id} className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={topic.enabled}
                      onChange={() => toggleTopic(topic.id)}
                      className="mt-0.5"
                    />
                    <span className="flex-1 rounded-md border bg-background px-2 py-1 text-sm">
                      {topic.query}
                    </span>
                    <button
                      type="button"
                      onClick={() => removeTopic(topic.id)}
                      className="rounded p-1 text-muted-foreground hover:text-destructive"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                ))}
                {draft.paperMonitorTopics.length === 0 && (
                  <p className="text-xs text-muted-foreground">{t("paperResearch.monitor.noTopics")}</p>
                )}
              </div>
              <div className="flex gap-2">
                <input
                  value={newTopic}
                  onChange={(e) => setNewTopic(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") recommend()
                  }}
                  placeholder={t("paperResearch.monitor.topicPlaceholder")}
                  className="flex-1 rounded-md border bg-background px-3 py-1.5 text-sm outline-none focus:ring-1 focus:ring-ring"
                />
                <Button type="button" variant="outline" size="sm" onClick={() => addTopic()}>
                  <Plus className="h-4 w-4" />
                  {t("paperResearch.monitor.addTopic")}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={recommend}
                  disabled={!newTopic.trim() || recommending}
                >
                  {recommending ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Sparkles className="h-4 w-4" />
                  )}
                  {t("paperResearch.monitor.recommend")}
                </Button>
              </div>
              {recommendations.length > 0 && (
                <div className="space-y-2 rounded-md border bg-muted/30 p-3">
                  <div className="text-xs font-medium text-muted-foreground">
                    {t("paperResearch.monitor.recommendations")}
                  </div>
                  {recommendations.map((rec) => (
                    <div key={rec} className="flex items-center gap-2">
                      <span className="flex-1 text-sm">{rec}</span>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => addTopic(rec)}
                      >
                        <Plus className="h-3 w-3" />
                        {t("paperResearch.monitor.add")}
                      </Button>
                    </div>
                  ))}
                </div>
              )}
              {recommendError && (
                <p className="text-xs text-destructive">{recommendError}</p>
              )}
            </div>

            <div className="space-y-2">
              <Label>{t("paperResearch.monitor.sources")}</Label>
              <div className="space-y-1">
                {ALL_SOURCES.map((s) => (
                  <label key={s.value} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={draft.paperMonitorSources.includes(s.value)}
                      onChange={() => toggleSource(s.value)}
                      className="mt-0.5"
                    />
                    {t(s.labelKey)}
                  </label>
                ))}
              </div>
            </div>

            <div className="space-y-2">
              <Label>{t("paperResearch.monitor.maxDaily")}</Label>
              <input
                type="number"
                min={1}
                max={500}
                value={draft.paperMonitorMaxDailyPapers}
                onChange={(e) => setDraft("paperMonitorMaxDailyPapers", Number(e.target.value) || 50)}
                className="w-32 rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring"
              />
              <p className="text-xs text-muted-foreground">
                {t("paperResearch.monitor.maxDailyHelp")}
              </p>
            </div>

            <label className="flex items-start gap-3 rounded-md border p-3">
              <input
                type="checkbox"
                checked={draft.paperMonitorAutoPush}
                onChange={(e) => setDraft("paperMonitorAutoPush", e.target.checked)}
                className="mt-1"
              />
              <span>
                <span className="block text-sm font-medium">{t("paperResearch.monitor.autoPush")}</span>
                <span className="block text-xs text-muted-foreground">
                  {t("paperResearch.monitor.autoPushHelp")}
                </span>
              </span>
            </label>
          </>
        )}
      </div>
    </div>
  )
}
