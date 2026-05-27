import type {
  CreativeFactory,
  CreativeItemType,
  CreativeMethodology,
  CreativeRouteTarget,
  InspirationItem,
  InspirationRunType,
  InspirationStrategy,
} from "@/lib/inspiration-schema"

export const CREATIVE_PIPELINE_STEPS = [
  "input",
  "context",
  "method",
  "generate",
  "critique",
  "improve",
  "score",
  "route",
  "persist",
] as const

export const CORE_CREATIVE_METHODOLOGIES: CreativeMethodology[] = [
  "double_diamond",
  "scamper",
  "triz",
  "design_thinking",
  "graph_structural_hole",
  "analogy_transfer",
  "counterfactual",
  "evidence_driven",
]

const METHODOLOGY_BY_STRATEGY: Record<InspirationStrategy, CreativeMethodology[]> = {
  community: ["double_diamond", "graph_structural_hole", "evidence_driven"],
  contradiction: ["triz", "evidence_driven"],
  bridge: ["graph_structural_hole", "analogy_transfer", "evidence_driven"],
  analogy: ["analogy_transfer", "scamper", "evidence_driven"],
  timeline: ["design_thinking", "counterfactual", "evidence_driven"],
  gap: ["triz", "graph_structural_hole", "evidence_driven"],
  dream: ["counterfactual", "analogy_transfer", "scamper", "evidence_driven"],
}

export function creativeTypeForItem(item: Pick<InspirationItem, "type" | "origin">): CreativeItemType {
  if (item.type === "dream" || item.origin === "dream") return "dream_idea"
  if (item.type === "theme" || item.origin === "theme_lab") return "topic_idea"
  return "idea"
}

export function sourceFactoryForItem(item: Pick<InspirationItem, "type" | "origin">): CreativeFactory {
  if (item.type === "dream" || item.origin === "dream") return "dream_factory"
  if (item.type === "theme" || item.origin === "theme_lab") return "theme_factory"
  return "idea_factory"
}

export function methodologiesForStrategy(strategy: InspirationStrategy, runType?: InspirationRunType): CreativeMethodology[] {
  if (runType === "theme") {
    return ["design_thinking", "graph_structural_hole", "scamper", "analogy_transfer", "counterfactual", "evidence_driven"]
  }
  if (runType === "dream") {
    return ["counterfactual", "analogy_transfer", "scamper", "evidence_driven"]
  }
  return METHODOLOGY_BY_STRATEGY[strategy] ?? ["double_diamond", "evidence_driven"]
}

export function methodologyExecutionPlan(methodologies: CreativeMethodology[]): string {
  const unique = [...new Set(methodologies)]
  return unique.map((methodology) => {
    if (methodology === "double_diamond") {
      return "- double_diamond: diverge into multiple opportunity angles, then converge to the strongest concrete proposal."
    }
    if (methodology === "scamper") {
      return "- scamper: explicitly test Substitute, Combine, Adapt, Modify, Put-to-other-use, Eliminate, and Reverse; keep the best transformation."
    }
    if (methodology === "triz") {
      return "- triz: identify a core contradiction, name both sides, then propose a breakthrough or trade-off pattern."
    }
    if (methodology === "design_thinking") {
      return "- design_thinking: state user, pain, problem definition, prototype/MVP, and test feedback path."
    }
    if (methodology === "graph_structural_hole") {
      return "- graph_structural_hole: use weak links, bridge nodes, isolated nodes, cross-community paths, or knowledge gaps to create the opportunity."
    }
    if (methodology === "analogy_transfer") {
      return "- analogy_transfer: pick a source-domain mechanism, abstract it, map it to this topic, and explain what changes."
    }
    if (methodology === "counterfactual") {
      return "- counterfactual: pose an extreme 'what if', derive the surprising implication, then translate it back to a realistic idea."
    }
    return "- evidence_driven: list supporting evidence, missing evidence, validation steps, and how the score/routing changes."
  }).join("\n")
}

export function methodologyNames(methodologies: CreativeMethodology[]): string {
  return [...new Set(methodologies)].join(", ")
}

export function routeTargetForItem(item: Pick<InspirationItem, "ideaStage" | "scores" | "type">): CreativeRouteTarget {
  if (item.ideaStage === "archived") return "archive"
  if (item.ideaStage === "mature") return "mature_pool"
  if (item.ideaStage === "validated") return "validation_pool"
  if (item.ideaStage === "incubating") return "incubation_pool"
  if (item.scores.final >= 0.85) return "incubation_pool"
  if (item.scores.final >= 0.7) return "candidate_pool"
  if (item.type === "dream") return "candidate_pool"
  if (item.scores.novelty >= 0.78 && item.scores.groundedness < 0.58) return "dream_factory"
  if (item.scores.groundedness < 0.5) return "research_task"
  if (item.scores.final < 0.5) return "archive"
  return "seed_pool"
}

export function enrichCreativeMetadata<T extends InspirationItem>(
  item: T,
  runType?: InspirationRunType,
): T {
  const routingTarget = item.routingTarget ?? routeTargetForItem(item)
  return {
    ...item,
    creativeType: item.creativeType ?? creativeTypeForItem(item),
    sourceFactory: item.sourceFactory ?? sourceFactoryForItem(item),
    methodologies: item.methodologies?.length ? item.methodologies : methodologiesForStrategy(item.strategy, runType),
    critiques: item.critiques ?? [],
    knowledgeGaps: item.knowledgeGaps ?? [],
    nextTasks: item.nextTasks ?? [],
    routingTarget,
    routingReason: item.routingReason ?? defaultRoutingReason(routingTarget),
  }
}

function defaultRoutingReason(target: CreativeRouteTarget): string {
  if (target === "incubation_pool") return "High-potential item with enough value to keep incubating."
  if (target === "candidate_pool") return "Promising item that needs more structure and evidence."
  if (target === "validation_pool") return "Evidence and maturity are strong enough to validate."
  if (target === "mature_pool") return "The item is close to a complete, actionable proposal."
  if (target === "dream_factory") return "Novel but underspecified; needs nonlinear exploration."
  if (target === "research_task") return "Direction is important but evidence is thin."
  if (target === "archive") return "Low score or weak fit; keep archived for possible reactivation."
  return "Keep as seed until new evidence or user feedback arrives."
}
