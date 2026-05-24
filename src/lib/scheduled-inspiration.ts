import { hasUsableLlm } from "@/lib/has-usable-llm"
import { loadInspirationSnapshot } from "@/lib/inspiration-persist"
import { useInspirationStore } from "@/stores/inspiration-store"
import type { InspirationConfig, LlmConfig } from "@/stores/wiki-store"

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

let timer: ReturnType<typeof setInterval> | null = null
let evolutionTimer: ReturnType<typeof setInterval> | null = null
let dreamTimer: ReturnType<typeof setInterval> | null = null
let activeProjectPath: string | null = null
let activeConfig: InspirationConfig | null = null
let activeLlmConfig: LlmConfig | null = null

function currentHm(): string {
  const now = new Date()
  return `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`
}

async function hasDailyRunToday(projectPath: string): Promise<boolean> {
  const snapshot = await loadInspirationSnapshot(projectPath)
  const inMemoryRuns = useInspirationStore.getState().runs
  return [...inMemoryRuns, ...snapshot.runs].some((run) =>
    run.runType === "daily" &&
    run.runDate === today() &&
    (run.status === "done" || run.status === "collecting" || run.status === "generating" || run.status === "saving"),
  )
}

async function hasDreamRunToday(projectPath: string): Promise<boolean> {
  const snapshot = await loadInspirationSnapshot(projectPath)
  const inMemoryRuns = useInspirationStore.getState().runs
  return [...inMemoryRuns, ...snapshot.runs].some((run) =>
    run.runType === "dream" &&
    run.runDate === today() &&
    (run.status === "done" || run.status === "collecting" || run.status === "generating" || run.status === "saving"),
  )
}

async function maybeRunDaily(
  projectPath: string,
  llmConfig: LlmConfig,
  trigger: "startup" | "schedule",
): Promise<void> {
  if (!hasUsableLlm(llmConfig)) return
  if (await hasDailyRunToday(projectPath)) return
  const store = useInspirationStore.getState()
  if (store.loading) return
  await store.run(projectPath, llmConfig, "daily", trigger)
  if (!(await hasDreamRunToday(projectPath))) {
    const afterFactory = useInspirationStore.getState()
    if (!afterFactory.loading) {
      await afterFactory.run(
        projectPath,
        llmConfig,
        "dream",
        trigger,
        "每日自动造梦：从导入知识、用户对话和当前点子池选择起点",
      )
    }
  }
}

export function stopScheduledInspiration(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
  if (evolutionTimer) {
    clearInterval(evolutionTimer)
    evolutionTimer = null
  }
  if (dreamTimer) {
    clearInterval(dreamTimer)
    dreamTimer = null
  }
  activeProjectPath = null
  activeConfig = null
  activeLlmConfig = null
}

export function startScheduledInspiration(
  projectPath: string,
  llmConfig: LlmConfig,
  config: InspirationConfig,
): void {
  stopScheduledInspiration()
  activeProjectPath = projectPath
  activeLlmConfig = llmConfig
  activeConfig = config

  if (!config.enabled) return

  if (config.runOnStartup) {
    void maybeRunDaily(projectPath, llmConfig, "startup")
  }

  if (config.continuousEvolutionEnabled) {
    evolutionTimer = setInterval(() => {
      if (!activeProjectPath || !activeLlmConfig || !activeConfig?.enabled || !activeConfig.continuousEvolutionEnabled) return
      const store = useInspirationStore.getState()
      if (store.loading || store.evolving) return
      void store.evolve(activeProjectPath, activeLlmConfig)
    }, Math.max(5, config.evolutionIntervalMinutes || 120) * 60_000)
  }

  if (config.continuousEvolutionEnabled) {
    dreamTimer = setInterval(() => {
      if (!activeProjectPath || !activeLlmConfig || !activeConfig?.enabled || !activeConfig.continuousEvolutionEnabled) return
      const store = useInspirationStore.getState()
      if (store.loading || store.evolving) return
      void store.continueDreams(activeProjectPath, activeLlmConfig)
    }, Math.max(1, config.dreamStepIntervalMinutes || 5) * 60_000)
  }

  if (!config.dailyEnabled) return

  timer = setInterval(() => {
    if (!activeProjectPath || !activeLlmConfig || !activeConfig?.enabled || !activeConfig.dailyEnabled) return
    if (currentHm() !== activeConfig.dailyTime) return
    void maybeRunDaily(activeProjectPath, activeLlmConfig, "schedule")
  }, 30_000)
}
