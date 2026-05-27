export type KnowledgeThreadStatus = "forming" | "active" | "mature" | "stale" | "archived"

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

export interface KnowledgeThread {
  id: string
  name: string
  summary: string
  coreQuestion: string
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
  priority: "low" | "medium" | "high"
  sourceNodeIds: string[]
  status: "open" | "resolved" | "watching"
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
  contexts: UserThreadContext[]
  logs: ThreadEvolutionLog[]
}

export const EMPTY_KNOWLEDGE_THREAD_BUNDLE: KnowledgeThreadBundle = {
  threads: [],
  nodes: [],
  edges: [],
  gaps: [],
  contexts: [],
  logs: [],
}
