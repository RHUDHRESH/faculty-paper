import { describe, expect, it } from "vitest"
import { nextStep, stepSentence, type NextBoard } from "@/pages/leaderboard-next"

const W = { Q1: 4, Q2: 3, Q3: 2, Q4: 1, other: 1 }
const r = (id: string, rank: number | null, value: number) => ({ rank, person: { id, name: `Dr ${id}` }, value })

function b(measure: string, rows: ReturnType<typeof r>[], meId: string): NextBoard {
  const me = rows.find((x) => x.person.id === meId)!
  return { measure, rows, method: { weights: W }, me: { id: meId, rank: me.rank, value: me.value } }
}

describe("nextStep", () => {
  it("finds the cheapest paper that strictly passes the next person on score", () => {
    const s = nextStep(b("score", [r("a", 1, 20), r("x", 2, 9), r("me", 3, 8)], "me"))
    expect(s).toMatchObject({ kind: "gap", gap: 1, papers: 1, paper: "Q3 paper", points: 2 })
    expect(s?.kind === "gap" && s.ahead.person.id).toBe("x")
    const t = nextStep(b("score", [r("x", 1, 10), r("me", 2, 8)], "me"))
    expect(t).toMatchObject({ papers: 1, paper: "Q2 paper", points: 3 })
    expect(stepSentence(t as never)).toBe("One more Q2 paper (3 points) would put you past them.")
  })

  it("asks for several of the best kind when one paper is not enough", () => {
    const s = nextStep(b("score", [r("x", 1, 20), r("me", 2, 8)], "me"))
    expect(s).toMatchObject({ gap: 12, papers: 4, paper: "Q1 paper", points: 4 })
    expect(stepSentence(s as never)).toBe("Four more Q1 papers (4 points each) would put you past them.")
  })

  it("counts papers, Q1 and first-author papers one at a time", () => {
    expect(nextStep(b("papers", [r("x", 1, 5), r("me", 2, 3)], "me"))).toMatchObject({ papers: 3, paper: "paper" })
    expect(nextStep(b("q1", [r("x", 1, 2), r("me", 2, 1)], "me"))).toMatchObject({ papers: 2, paper: "Q1 paper" })
    expect(nextStep(b("first", [r("x", 1, 2), r("me", 2, 1)], "me"))).toMatchObject({ paper: "first-author paper" })
  })

  it("says first when nobody is ahead, including a tie at the top", () => {
    expect(nextStep(b("score", [r("me", 1, 9), r("x", 2, 3)], "me"))).toEqual({ kind: "first" })
    expect(nextStep(b("score", [r("x", 1, 9), r("me", 1, 9)], "me"))).toEqual({ kind: "first" })
  })

  it("skips people level with you and aims at the next higher value", () => {
    const s = nextStep(b("score", [r("y", 1, 12), r("x", 2, 8), r("me", 2, 8)], "me"))
    expect(s?.kind === "gap" && s.ahead.person.id).toBe("y")
  })

  it("has nothing to say for unranked people or other boards", () => {
    expect(nextStep(b("cited", [r("x", 1, 5), r("me", 2, 3)], "me"))).toBeNull()
    expect(nextStep(b("score", [r("x", 1, 5), r("me", null, 0)], "me"))).toBeNull()
  })
})
