export type InspirationTab = "daily" | "themes" | "dreams" | "feedback"

export type InspirationRunType = "daily" | "factory" | "theme" | "dream"
export type InspirationTriggerType = "manual" | "schedule" | "startup" | "source_watch"
export type InspirationTaskStatus = "queued" | "collecting" | "generating" | "evolving" | "saving" | "done" | "error"

export type InspirationItemType = "theme" | "idea" | "dream"
export type InspirationOrigin = "factory" | "theme_lab" | "dream" | "adopted"
export type IdeaStage = "seed" | "candidate" | "incubating" | "validated" | "mature" | "adopted" | "archived"
export type IdeaTaskType = "structure" | "expand" | "compress" | "score" | "dedup" | "merge" | "validate" | "mature"
export type DreamMode = "free_association" | "future" | "counterfactual" | "metaphor" | "conflict" | "roleplay" | "gap_fill" | "solution_evolution"
export type DreamMaterialRole = "core" | "edge" | "heterogeneous" | "conflict" | "historical" | "user_interest"
export type DreamFragmentType = "scene" | "metaphor" | "conflict" | "transformation" | "future" | "dialogue" | "strange_connection" | "question_mutation" | "solution_variant"
export type DreamInsightType = "product_opportunity" | "research_hypothesis" | "workflow" | "knowledge_gap" | "solution" | "task"
export type InspirationStrategy =
  | "community"
  | "contradiction"
  | "bridge"
  | "analogy"
  | "timeline"
  | "gap"
  | "dream"

export interface InspirationScores {
  groundedness: number
  novelty: number
  goalFit: number
  actionability: number
  diversity: number
  final: number
}

export interface InspirationEvidence {
  id: string
  pagePath: string
  title: string
  role: "support" | "contrast" | "bridge" | "gap"
  snippet: string
  relevanceScore: number
}

export interface DreamMaterial {
  id: string
  role: DreamMaterialRole
  sourceType: "knowledge" | "idea" | "theme" | "dream" | "user" | "external"
  sourceId: string
  title: string
  content: string
  relevanceScore: number
}

export interface DreamFragment {
  id: string
  type: DreamFragmentType
  title: string
  content: string
  relatedEntities: string[]
  sourceMaterialIds: string[]
  imaginationLevel: number
  relevanceScore: number
}

export interface DreamInsight {
  id: string
  type: DreamInsightType
  content: string
  sourceFragmentIds: string[]
  valueScore: number
  convertStatus: "candidate" | "sent_to_factory" | "ignored"
}

export interface DreamOutput {
  id: string
  outputType: "idea" | "solution" | "hypothesis" | "knowledge_gap" | "task" | "report"
  title: string
  content: string
  targetSystem?: "idea_factory" | "deep_research" | "wiki"
  targetId?: string
}

export interface InspirationItem {
  id: string
  runId: string
  type: InspirationItemType
  origin: InspirationOrigin
  title: string
  summary: string
  body: string
  strategy: InspirationStrategy
  themeKey?: string
  ideaStage?: IdeaStage
  maturityLevel?: number
  version?: number
  triggerType?: InspirationTriggerType
  sourceKnowledgeIds?: string[]
  relatedEntities?: string[]
  reasoningPath?: string[]
  lastTaskType?: IdeaTaskType
  reactivationReasons?: string[]
  mergedFrom?: string[]
  markdownPath: string
  evidence: InspirationEvidence[]
  scores: InspirationScores
  reviewState: "new" | "saved" | "formal" | "rejected"
  lifecycleStatus?: "idle" | "exploring" | "evolving" | "done" | "error"
  createdAt: number
  enteredAt: number
  updatedAt: number
  lastEvolvedAt?: number
  evolutionCount: number
  dreamStartedAt?: number
  dreamUntil?: number
  dreamStatus?: "dreaming" | "converging" | "done"
  dreamMode?: DreamMode
  dreamMaterials?: DreamMaterial[]
  dreamFragments?: DreamFragment[]
  dreamInsights?: DreamInsight[]
  dreamOutputs?: DreamOutput[]
  dreamScore?: number
}

export interface InspirationRun {
  id: string
  runType: InspirationRunType
  triggerType: InspirationTriggerType
  topic?: string
  runDate: string
  status: InspirationTaskStatus
  startedAt: number
  finishedAt?: number
  error?: string
  itemIds: string[]
}

export interface InspirationFeedback {
  id: string
  itemId: string
  action:
    | "like"
    | "unlike"
    | "dislike"
    | "undislike"
    | "save"
    | "unsave"
    | "promote"
    | "unpromote"
    | "reject"
    | "expand"
    | "research"
  reasonCode?: string
  createdAt: number
}

export interface InspirationComment {
  id: string
  itemId: string
  body: string
  createdAt: number
}

export interface InspirationSnapshot {
  runs: InspirationRun[]
  items: InspirationItem[]
  feedback: InspirationFeedback[]
  comments: InspirationComment[]
}

export interface InspirationSeed {
  path: string
  title: string
  type: string
  snippet: string
  linkCount: number
  community: number
  modifiedAt?: number
}

export const EMPTY_INSPIRATION_SNAPSHOT: InspirationSnapshot = {
  runs: [],
  items: [],
  feedback: [],
  comments: [],
}

export function blankScores(partial: Partial<InspirationScores> = {}): InspirationScores {
  const scores = {
    groundedness: 0.7,
    novelty: 0.65,
    goalFit: 0.7,
    actionability: 0.6,
    diversity: 0.65,
    ...partial,
  }
  return {
    ...scores,
    final: Number((
      scores.groundedness * 0.3 +
      scores.goalFit * 0.2 +
      scores.novelty * 0.2 +
      scores.actionability * 0.2 +
      scores.diversity * 0.1
    ).toFixed(3)),
  }
}
