import { describe, expect, it } from "vitest"

import { planShare } from "@/pages/coordination-parts"

const rows = (n: number, owner = "x") => Array.from({ length: n }, (_, i) => ({ id: `c${i + 1}`, owner_id: owner }))

describe("sharing claims out evenly", () => {
  it("gives each claim, oldest first, to whoever holds the fewest", () => {
    const plan = planShare(rows(5), ["a", "b"], { a: 0, b: 2 })
    // a holds 0 and b holds 2: a takes three before b gets one, and a tie goes to the first named.
    expect(plan.get("a")).toEqual(["c1", "c2", "c3", "c5"])
    expect(plan.get("b")).toEqual(["c4"])
  })

  it("never gives a person their own claim", () => {
    const plan = planShare([{ id: "c1", owner_id: "a" }, { id: "c2", owner_id: "a" }], ["a", "b"], {})
    expect(plan.get("a")).toEqual([])
    expect(plan.get("b")).toEqual(["c1", "c2"])
  })

  it("leaves a claim un-given when the only reviewer filed it", () => {
    const plan = planShare([{ id: "c1", owner_id: "a" }], ["a"], {})
    expect([...plan.values()].flat()).toEqual([])
  })

  it("shares an even number evenly", () => {
    const plan = planShare(rows(12), ["a", "b", "c"], {})
    expect([...plan.values()].map((v) => v.length)).toEqual([4, 4, 4])
  })
})
