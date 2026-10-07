/**
 * "Your next step" on the leaderboard: who is just ahead of you, by how much,
 * and the smallest piece of work that would put you past them. Pure, so it is
 * tested on its own (leaderboard-next.test.ts).
 */

export type NextRow = {
  rank: number | null
  person: { id: string; name: string }
  value: number
}

export type NextBoard = {
  measure: string
  rows: NextRow[]
  method: { weights: Record<string, number> }
  me: { id: string; rank: number | null; value: number } | null
}

export type NextStep =
  | { kind: "first" }
  | {
      kind: "gap"
      ahead: NextRow
      theirs: number
      yours: number
      gap: number
      /** How many papers of `paper` kind it takes to pass them. */
      papers: number
      /** "Q2 paper", "paper", "Q1 paper", "first-author paper". */
      paper: string
      /** Points one such paper is worth (score only). */
      points: number | null
    }

const STEPPED = new Set(["score", "papers", "q1", "first"])

/** The weights in a fixed, readable order; "other" ties with Q4 and loses to it. */
const ORDER = ["Q4", "other", "Q3", "Q2", "Q1"]

export function nextStep(board: NextBoard): NextStep | null {
  const me = board.me
  if (!me || me.rank == null || !STEPPED.has(board.measure)) return null
  const higher = board.rows.filter((r) => r.rank != null && r.person.id !== me.id && r.value > me.value)
  if (!higher.length) return { kind: "first" }
  // The nearest one ahead: the smallest value still above yours.
  const ahead = higher.reduce((a, r) => (r.value <= a.value ? r : a))
  const gap = ahead.value - me.value
  const need = gap + 1
  if (board.measure !== "score") {
    const paper = board.measure === "q1" ? "Q1 paper" : board.measure === "first" ? "first-author paper" : "paper"
    return { kind: "gap", ahead, theirs: ahead.value, yours: me.value, gap, papers: need, paper, points: null }
  }
  const weights = ORDER.filter((k) => board.method.weights[k] != null).map((k) => ({ k, w: board.method.weights[k] }))
  weights.sort((a, b) => a.w - b.w)
  const one = weights.find((x) => x.w >= need)
  if (one) return { kind: "gap", ahead, theirs: ahead.value, yours: me.value, gap, papers: 1, paper: `${label(one.k)} paper`, points: one.w }
  const best = weights[weights.length - 1] ?? { k: "Q1", w: 4 }
  return {
    kind: "gap", ahead, theirs: ahead.value, yours: me.value, gap,
    papers: Math.ceil(need / best.w), paper: `${label(best.k)} paper`, points: best.w,
  }
}

function label(k: string): string {
  return k === "other" ? "indexed" : k
}

const WORDS = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten"]

/** "One more Q2 paper (3 points) would put you past them." */
export function stepSentence(s: Extract<NextStep, { kind: "gap" }>): string {
  const n = WORDS[s.papers] ?? String(s.papers)
  const what = `${n} more ${s.paper}${s.papers === 1 ? "" : "s"}`
  const pts = s.points != null ? ` (${s.points} ${s.points === 1 ? "point" : "points"}${s.papers === 1 ? "" : " each"})` : ""
  return `${what}${pts} would put you past them.`
}
