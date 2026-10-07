/**
 * Research compass: the shapes `/api/compass` answers with, and the few
 * rules the page and the cards that point at it share.
 */

export type Evidence = { kind: "paper" | "journal" | "person" | "metric"; id: string; label: string }

export type TopicCount = { name: string; papers: number }

export type Portrait = {
  headline: string
  strengths: { text: string; evidence: Evidence[] }[]
  topics: TopicCount[]
  standing: string
  /** True when it was written from the record alone, without the model. */
  counted: boolean
}

export type Metric = { label: string; now: number; target: number; unit: string }

export type Path = {
  key: string
  name: string
  why: string
  evidence: Evidence[]
  metrics: Metric[]
  peers: { id: string; name: string; dept: string }[]
}

export type ActionKind = "journal" | "person" | "topic" | "goal" | "deadline"

export type JournalRef = { journal_id?: string | null; name: string; quartile?: string | null; snip?: number | null }
export type PersonRef = { user_id: string; name: string; dept?: string | null }
export type TopicRef = { name: string }
export type GoalRef = { metric: string; target: number; year: number }
export type DeadlineRef = { date: string; url?: string | null; title: string }

export type Action = {
  id: string
  kind: ActionKind
  title: string
  why: string
  ref: JournalRef | PersonRef | TopicRef | GoalRef | DeadlineRef
  done: boolean
}

export type CompassFacts = {
  papers: number
  citations: number | null
  h_index: number | null
  rank: number | null
  q1: number
  first_author_share: number | null
  journal_share: number | null
  topics: TopicCount[]
}

export type CompassState = {
  ai: boolean
  facts: CompassFacts
  portrait: Portrait | null
  paths: Path[] | null
  chosen_path: string | null
  plan: Action[] | null
}

export type CompassSummary = {
  headline: string | null
  path_name: string | null
  progress: { done: number; total: number } | null
  next_action: Action | null
}

export type AskAnswer = { answer: string; evidence: Evidence[]; counted: boolean }

export const STEPS = ["Who you are", "What you could be", "Your next steps", "Ask"] as const

/** The furthest step the record says this person has reached. */
export function furthestStep(s: Pick<CompassState, "portrait" | "paths" | "plan">): number {
  if (s.plan && s.plan.length > 0) return 2
  if (s.paths && s.paths.length > 0) return 1
  return 0
}

export function progressLine(p: { done: number; total: number }): string {
  return `${p.done} of ${p.total} done`
}

/** Where an evidence chip leads, or null for a figure with nowhere to go. */
export function evidenceHref(e: Evidence): string | null {
  if (e.kind === "person") return `/u/${e.id}`
  // A faculty member has no journal page of their own; the journal search
  // is the one that opens for everybody.
  if (e.kind === "journal") return `/search?scope=journals&q=${encodeURIComponent(e.label)}`
  if (e.kind === "paper") return "/research"
  return null
}
