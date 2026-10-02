import { describe, expect, it } from "vitest"

import { budgetLine, stripParts } from "@/pages/budget-strip"

const B = (allocated: number | null, spent: number, committed: number) => ({
  financial_year: "2026-27",
  college: { allocated, spent, committed, remaining: allocated == null ? null : allocated - spent - committed },
})

describe("the budget strip", () => {
  it("carves the batch out of what is already committed, never on top of it", () => {
    const p = stripParts({ allocated: 1_000_000, spent: 400_000, committed: 300_000 }, 100_000)
    expect(p.spent).toBe(400_000)
    expect(p.batch).toBe(100_000)
    expect(p.other).toBe(200_000)
    expect(p.left).toBe(300_000)
    expect(p.over).toBe(false)
  })

  it("never counts more of the batch than is committed", () => {
    const p = stripParts({ allocated: 1_000_000, spent: 0, committed: 50_000 }, 80_000)
    expect(p.batch).toBe(50_000)
    expect(p.other).toBe(0)
  })

  it("says over the allocation in words and by how much", () => {
    expect(budgetLine(B(500_000, 400_000, 200_000), "authorising")).toBe("Authorising them takes the 2026-27 budget ₹1,00,000 over.")
  })

  it("says what is left, in the right number", () => {
    expect(budgetLine(B(1_000_000, 400_000, 300_000), "paying")).toBe("Paying them leaves ₹3,00,000 in the 2026-27 budget.")
    expect(budgetLine(B(1_000_000, 400_000, 300_000), "authorising", false)).toBe("Authorising it leaves ₹3,00,000 in the 2026-27 budget.")
  })

  it("says there is nothing to weigh against when no allocation is set", () => {
    expect(budgetLine(B(null, 400_000, 300_000), "authorising")).toBe(
      "No budget is set for 2026-27, so there is nothing to weigh them against."
    )
  })
})
