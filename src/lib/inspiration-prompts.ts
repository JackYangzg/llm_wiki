import { buildLanguageDirective } from "@/lib/output-language"
import { methodologiesForStrategy, methodologyExecutionPlan, methodologyNames } from "@/lib/creative-pipeline"
import type { InspirationSeed, InspirationStrategy } from "@/lib/inspiration-schema"

export function themeMiningPrompt(
  guidance: string,
  seeds: InspirationSeed[],
): { system: string; user: string } {
  const system = [
    "You are a knowledge-base theme compiler.",
    "You can only derive themes from the provided evidence. Do not invent facts.",
    buildLanguageDirective(guidance || seeds.map((s) => s.title).join("\n")),
    "Return strict JSON with this shape:",
    `{"themes":[{"title":"string","summary":"string","tension":"string","opportunity":"string","gap":"string","evidenceIndexes":[1,2],"confidence":"low|medium|high"}]}`,
  ].join("\n\n")
  const user = [
    guidance ? "Factory guidance:" : "",
    guidance || "",
    guidance ? "" : "",
    "Evidence seeds:",
    ...seeds.map((seed, index) => [
      `[${index + 1}] ${seed.title}`,
      `type=${seed.type}; community=${seed.community}; links=${seed.linkCount}`,
      seed.snippet,
    ].join("\n")),
    "",
    "Mine 3 to 8 themes. Prefer themes that connect multiple pages, expose tensions, or reveal knowledge gaps.",
  ].join("\n")
  return { system, user }
}

export function ideaGenerationPrompt(
  topic: string,
  strategy: InspirationStrategy,
  seeds: InspirationSeed[],
  guidance = "",
): { system: string; user: string } {
  const methodologies = methodologiesForStrategy(strategy)
  const system = [
    "You are an evidence-grounded ideation designer for a persistent wiki.",
    "Act as a unified Creative Item pipeline: Generate → Critique → Improve → Score → Route.",
    `You must execute these methodologies, not merely label them: ${methodologyNames(methodologies)}.`,
    methodologyExecutionPlan(methodologies),
    "Generate durable ideas, but every idea must point back to provided evidence indexes.",
    "Generated pages are inspiration, not primary evidence.",
    buildLanguageDirective(topic),
    "Return strict JSON with this shape:",
    `{"ideas":[{"title":"string","one_liner":"string","problem":"string","solution":"string","target_users":["string"],"value":"string","why_interesting":"string","source_knowledge":["string"],"related_entities":["string"],"methodologies":["double_diamond|scamper|triz|design_thinking|graph_structural_hole|analogy_transfer|counterfactual|evidence_driven"],"critique":["string"],"improvement_summary":"string","routing":{"target":"seed_pool|candidate_pool|incubation_pool|validation_pool|mature_pool|dream_factory|research_task|merge|archive","reason":"string"},"knowledge_gaps":["string"],"next_actions":["string"],"risks":["string"],"scores":{"novelty":0.7,"value":0.7,"feasibility":0.7,"relevance":0.7,"evidence":0.7,"differentiation":0.7,"actionability":0.7,"maturity":0.4},"evidenceIndexes":[1,2],"confidence":"low|medium|high"}]}`,
  ].join("\n\n")
  const user = [
    `Topic: ${topic}`,
    `Strategy: ${strategy}`,
    `Required methodologies: ${methodologyNames(methodologies)}`,
    guidance ? "" : "",
    guidance ? "Factory guidance:" : "",
    guidance,
    "",
    "Methodology execution checklist:",
    methodologyExecutionPlan(methodologies),
    "",
    "Strategy guide:",
    "- combination: combine two or more entities into a new opportunity.",
    "- problem: extract unresolved pain points and propose a practical solution.",
    "- contradiction: identify productive tensions or unresolved conflicts.",
    "- bridge: connect distant evidence into a testable hypothesis.",
    "- analogy: borrow a pattern from one area and apply it to another.",
    "- timeline: project how the topic could evolve over time.",
    "- gap: turn missing evidence into research questions and experiments.",
    "- trend: connect outside or newly imported signals with internal knowledge.",
    "- counterfactual: ask what changes if a cost, capability, or workflow constraint disappears.",
    "- dream: narrate a traceable associative path through the wiki.",
    "",
    "Evidence seeds:",
    ...seeds.map((seed, index) => [
      `[${index + 1}] ${seed.title}`,
      `type=${seed.type}; community=${seed.community}; links=${seed.linkCount}`,
      seed.snippet,
    ].join("\n")),
    "",
    "Generate 2 to 5 non-duplicate ideas. Prefer fewer ideas that can evolve through seed, candidate, incubation, validation, and maturity.",
    "For each idea, do not stop at generation: include critique, improved framing, score, and routing.",
  ].join("\n")
  return { system, user }
}

export function dreamReplayPrompt(
  topic: string,
  path: { title: string; reason: string; snippet: string }[],
): { system: string; user: string } {
  const system = [
    "You are a Dream Space engine for a persistent knowledge system.",
    "Do not directly brainstorm ideas first. First simulate nonlinear dream exploration, then perform wake-up review.",
    "The dream may use memory recombination, metaphor, counterfactuals, future projection, conflict, role-play, and weak graph connections.",
    "Every fragment must remain traceable to provided path indexes or prior ideas.",
    buildLanguageDirective(topic),
    "Return strict JSON with this shape:",
    `{"title":"string","summary":"string","dreamMode":"free_association|future|counterfactual|metaphor|conflict|roleplay|gap_fill|solution_evolution","fragments":[{"type":"scene|metaphor|conflict|transformation|future|dialogue|strange_connection|question_mutation|solution_variant","title":"string","content":"string","relatedEntities":["string"],"sourceIndexes":[1,2],"imaginationLevel":0.8,"relevanceScore":0.7}],"walk":["string"],"afterReview":{"insights":[{"type":"product_opportunity|research_hypothesis|workflow|knowledge_gap|solution|task","content":"string","sourceFragmentIndexes":[1],"valueScore":0.8}],"usableCreatives":["string"],"solutions":["string"],"hypotheses":["string"],"knowledgeGaps":["string"],"nextTasks":["string"],"dreamBornIdeas":[{"title":"string","description":"string","problem":"string","solution":"string","nextStep":"string"}]},"dreamScore":0.75}`,
  ].join("\n\n")
  const user = [
    `Starting topic: ${topic}`,
    "",
    "Walk path:",
    ...path.map((step, index) => [
      `[${index + 1}] ${step.title}`,
      `jump_reason=${step.reason}`,
      step.snippet,
    ].join("\n")),
    "",
    "Build a dream material pool implicitly: core, edge, heterogeneous, conflict, historical, and user-interest signals.",
    "Generate 6 to 10 dream fragments, continue a compact dream walk, then perform wake-up review.",
    "The final output must include usable creatives, solution sketches, hypotheses, knowledge gaps, next tasks, and dream-born ideas that can enter the Idea Factory.",
  ].join("\n")
  return { system, user }
}
