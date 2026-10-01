import { describe, expect, it } from "vitest"

import { describeImpact, describeRateChanges } from "@/pages/policy"

const current = {
  name: "Policy v1",
  version: 1,
  snip_multiplier: 55000,
  qf_q1: 50000,
  qf_q2: 30000,
  qf_q3: 15000,
  qf_q4: 7000,
  fixed_journal_no_snip: 5000,
  fixed_other_no_snip: 4000,
  fixed_web_of_science: 5000,
  student_project_amount: 15000,
} as Parameters<typeof describeRateChanges>[0]

describe("a policy change, in words", () => {
  it("names each rate that moves, how far and from what", () => {
    expect(describeRateChanges(current, { ...current, qf_q1: 55000 })).toEqual([
      "The Q1 bonus goes up ₹5,000 (₹50,000 to ₹55,000)",
    ])
    expect(describeRateChanges(current, { ...current, snip_multiplier: 50000, qf_q4: 8000 })).toEqual([
      "The rate per SNIP point goes down ₹5,000 (₹55,000 to ₹50,000)",
      "The Q4 bonus goes up ₹1,000 (₹7,000 to ₹8,000)",
    ])
    expect(describeRateChanges(current, { ...current })).toEqual([])
  })

  it("says how many unpaid claims gain, how many lose, and the total", () => {
    const changed = [
      ...Array.from({ length: 34 }, (_, i) => ({ id: `g${i}`, ticket_number: null, title: "t", owner: null, before: 100, after: 5100 })),
      { id: "l1", ticket_number: null, title: "t", owner: null, before: 5000, after: 4000 },
    ]
    const text = describeImpact({ changed, before_total: 100000, after_total: 269000, open_claims: 40 })
    expect(text).toBe("34 unpaid claims gain, 1 loses. The total goes up ₹1,69,000.")
    expect(describeImpact({ changed: [], before_total: 5, after_total: 5, open_claims: 14 })).toBe(
      "None of the 14 unpaid claims changes amount."
    )
  })
})
