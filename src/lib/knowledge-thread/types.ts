export type KnowledgeThreadStatus = "forming" | "active" | "mature" | "stale" | "archived"
export type KnowledgeFieldStatus = "pending_llm" | "llm_generated" | "validated" | "needs_repair"
export type ThreadGenerationMode = "llm" | "local_candidate" | "repair"
export type ThreadValidationStatus = "passed" | "failed" | "repaired"

export interface EvidenceRef {
  id: string
  type: "source_page" | "node" | "gap" | "edge" | "thread" | "wiki_excerpt"
  refId: string
  title?: string
  excerpt?: string
  path?: string
}

export type KnowledgeThreadNodeType =
  | "topic"
  | "concept"
  | "question"
  | "method"
  | "claim"
  | "case"
  | "gap"
  | "idea"
  | "source_page"
  | "evolution"

export type KnowledgeThreadEdgeType =
  | "contains"
  | "depends_on"
  | "supports"
  | "contradicts"
  | "evolves_to"
  | "inspires"
  | "gap_to"
  | "derived_from"
  | "should_explore"

export type CoreQuestionType =
  | "mechanism"
  | "tradeoff"
  | "evolution"
  | "contradiction"
  | "application"
  | "gap"

export type ThreadMainlineRole =
  | "background"
  | "core_concept"
  | "key_question"
  | "method"
  | "evidence"
  | "case"
  | "contradiction"
  | "gap"
  | "next_direction"

export type ThreadGapType =
  | "missing_evidence"
  | "unclear_mechanism"
  | "conflicting_views"
  | "weak_connection"
  | "missing_case"
  | "missing_method"
  | "outdated_information"

export type ThreadNextDirectionActionType =
  | "read_more"
  | "ask_user"
  | "web_research"
  | "connect_nodes"
  | "validate_claim"
  | "compare_threads"
  | "generate_idea"
  | "update_schema"

export type KnowledgeThreadRelationType =
  | "overlaps_with"
  | "depends_on"
  | "contradicts"
  | "evolves_to"
  | "complements"
  | "competes_with"
  | "shares_gap"
  | "inspires"

export interface KnowledgeThread {
  id: string
  name: string
  summaryDraft?: string
  summary: string
  summaryEvidenceRefs: EvidenceRef[]
  summaryStatus: KnowledgeFieldStatus
  coreQuestion: string
  coreQuestionType: CoreQuestionType
  coreQuestionEvidenceRefs: EvidenceRef[]
  coreQuestionStatus: KnowledgeFieldStatus
  status: KnowledgeThreadStatus
  rootTopics: string[]
  keyConcepts: string[]
  sourcePages: string[]
  maturityScore: number
  coverageScore: number
  coherenceScore: number
  noveltyScore: number
  activityScore: number
  gaps: string[]
  nextDirections: string[]
  mainlineStepIds: string[]
  nextDirectionIds: string[]
  validationStatus: ThreadValidationStatus
  validationMessages: string[]
  generationMode: ThreadGenerationMode
  createdAt: number
  updatedAt: number
}

export interface KnowledgeThreadNode {
  id: string
  threadId: string
  type: KnowledgeThreadNodeType
  title: string
  summary: string
  sourcePageIds: string[]
  relatedWikiLinks: string[]
  confidence: number
  importance: number
  createdAt: number
  updatedAt: number
}

export interface KnowledgeThreadEdge {
  id: string
  threadId: string
  sourceNodeId: string
  targetNodeId: string
  type: KnowledgeThreadEdgeType
  reason: string
  confidence: number
  createdAt: number
}

export interface KnowledgeThreadGap {
  id: string
  threadId: string
  title: string
  description: string
  gapType: ThreadGapType
  whyItMatters: string
  missingEvidence: string[]
  priority: "low" | "medium" | "high"
  sourceNodeIds: string[]
  sourcePageIds: string[]
  evidenceRefs: EvidenceRef[]
  status: "open" | "investigating" | "resolved" | "dismissed" | "watching"
  createdAt: number
  updatedAt: number
}

export interface ThreadMainlineStep {
  id: string
  threadId: string
  order: number
  nodeId?: string
  title: string
  role: ThreadMainlineRole
  summary: string
  evidenceRefs: EvidenceRef[]
  dependsOnStepIds?: string[]
}

export interface ThreadNextDirection {
  id: string
  threadId: string
  actionType: ThreadNextDirectionActionType
  title: string
  rationale: string
  targetGapIds?: string[]
  targetNodeIds?: string[]
  targetPageIds?: string[]
  expectedOutput: string
  priority: "low" | "medium" | "high"
  effort: "small" | "medium" | "large"
  validationSignal: string
  evidenceRefs: EvidenceRef[]
}

export interface KnowledgeThreadRelation {
  id: string
  sourceThreadId: string
  targetThreadId: string
  type: KnowledgeThreadRelationType
  reason: string
  evidenceRefs: EvidenceRef[]
  confidence: number
  createdAt: number
  updatedAt: number
}

export interface ThreadEvolutionLog {
  id: string
  triggerType:
    | "new_source_ingested"
    | "wiki_page_updated"
    | "user_context_added"
    | "manual_refresh"
    | "scheduled_evolution"
    | "graph_insight"
  triggerRef: string
  affectedThreadIds: string[]
  summary: string
  changeReason: string
  evidenceRefs: EvidenceRef[]
  promptVersion: string
  modelName?: string
  generationMode: ThreadGenerationMode
  validationStatus: ThreadValidationStatus
  validationMessages: string[]
  addedNodes: string[]
  updatedNodes: string[]
  addedEdges: string[]
  newGaps: string[]
  resolvedGaps: string[]
  nextTasks: string[]
  createdAt: number
}

export interface UserThreadContext {
  id: string
  targetType: "global" | "thread" | "node"
  targetId?: string
  content: string
  effect:
    | "direction_hint"
    | "priority_adjustment"
    | "scope_constraint"
    | "correction"
    | "new_question"
    | "new_goal"
  createdAt: number
}

export interface ThreadEvolutionInput {
  triggerType:
    | "new_source_ingested"
    | "user_context_added"
    | "manual_refresh"
    | "scheduled_evolution"
  changedSourcePaths?: string[]
  changedWikiPages?: string[]
  userContext?: UserThreadContext
  targetThreadId?: string
}

export interface KnowledgeThreadBundle {
  threads: KnowledgeThread[]
  nodes: KnowledgeThreadNode[]
  edges: KnowledgeThreadEdge[]
  gaps: KnowledgeThreadGap[]
  mainlineSteps: ThreadMainlineStep[]
  nextDirections: ThreadNextDirection[]
  relations: KnowledgeThreadRelation[]
  contexts: UserThreadContext[]
  logs: ThreadEvolutionLog[]
}

export const EMPTY_KNOWLEDGE_THREAD_BUNDLE: KnowledgeThreadBundle = {
  threads: [],
  nodes: [],
  edges: [],
  gaps: [],
  mainlineSteps: [],
  nextDirections: [],
  relations: [],
  contexts: [],
  logs: [],
}

export interface TrashEntry {
  id: string
  thread: KnowledgeThread
  nodes: KnowledgeThreadNode[]
  edges: KnowledgeThreadEdge[]
  gaps: KnowledgeThreadGap[]
  mainlineSteps?: ThreadMainlineStep[]
  nextDirections?: ThreadNextDirection[]
  relations?: KnowledgeThreadRelation[]
  deletedAt: number
}

export interface KnowledgeThreadTrash {
  entries: TrashEntry[]
}
