import type { GraphEdge, GraphNode } from "@/lib/wiki-graph"
import { shouldHideNodeType } from "@/lib/graph-visibility"
import { isSystemManagementId, isSystemManagementPath } from "@/lib/wiki-system-files"

export interface GraphFilterState {
  hiddenTypes: ReadonlySet<string>
  hiddenNodeIds: ReadonlySet<string>
  hideStructural: boolean
  hideIsolated: boolean
  maxLinks?: number
}

export interface FilteredGraph {
  nodes: GraphNode[]
  edges: GraphEdge[]
  hiddenNodeIds: Set<string>
}

export const DEFAULT_GRAPH_FILTERS: GraphFilterState = {
  hiddenTypes: new Set(),
  hiddenNodeIds: new Set(),
  hideStructural: true,
  hideIsolated: false,
  maxLinks: undefined,
}

export function isStructuralGraphNode(node: Pick<GraphNode, "id" | "path" | "type">): boolean {
  if (isSystemManagementId(node.id)) return true
  if (node.type === "overview") return true
  return isSystemManagementPath(node.path)
}

export function applyGraphFilters(
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[],
  filters: GraphFilterState,
): FilteredGraph {
  const hiddenNodeIds = new Set<string>()

  for (const node of nodes) {
    if (filters.hiddenNodeIds.has(node.id)) {
      hiddenNodeIds.add(node.id)
      continue
    }
    if (shouldHideNodeType(node.type, filters.hiddenTypes)) {
      hiddenNodeIds.add(node.id)
      continue
    }
    if (filters.hideStructural && isStructuralGraphNode(node)) {
      hiddenNodeIds.add(node.id)
      continue
    }
    if (filters.hideIsolated && node.linkCount <= 0) {
      hiddenNodeIds.add(node.id)
      continue
    }
    if (filters.maxLinks !== undefined && node.linkCount > filters.maxLinks) {
      hiddenNodeIds.add(node.id)
    }
  }

  const visibleNodes = nodes.filter((node) => !hiddenNodeIds.has(node.id))
  const visibleNodeIds = new Set(visibleNodes.map((node) => node.id))
  const visibleEdges = edges.filter(
    (edge) => visibleNodeIds.has(edge.source) && visibleNodeIds.has(edge.target),
  )

  return { nodes: visibleNodes, edges: visibleEdges, hiddenNodeIds }
}

export function hasActiveGraphFilters(filters: GraphFilterState): boolean {
  return (
    filters.hideStructural ||
    filters.hideIsolated ||
    filters.hiddenTypes.size > 0 ||
    filters.hiddenNodeIds.size > 0 ||
    filters.maxLinks !== undefined
  )
}
