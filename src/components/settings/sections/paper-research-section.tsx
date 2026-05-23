import { Label } from "@/components/ui/label"
import { useTranslation } from "react-i18next"
import type { DraftSetter, SettingsDraft } from "../settings-types"

interface PaperResearchSectionProps {
  draft: SettingsDraft
  setDraft: DraftSetter
}

export function PaperResearchSection({ draft, setDraft }: PaperResearchSectionProps) {
  const { t } = useTranslation()

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
    </div>
  )
}
