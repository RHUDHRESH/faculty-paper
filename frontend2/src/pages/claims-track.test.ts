import { describe, expect, it } from "vitest"

import {
  amountView,
  filedSentence,
  financialYearOf,
  monthLabel,
  monthPaid,
  needFromYou,
  payoutLine,
  stageWord,
  statementLink,
  type PayoutOutlook,
} from "./claims-track"

const NOW = new Date("2026-09-30T10:00:00Z")
const ago = (days: number) => new Date(NOW.getTime() - days * 86_400_000).toISOString()
const OUTLOOK: PayoutOutlook = {
  pattern: "monthly",
  last_run: "2026-09",
  next_run: "2026-10",
  next_run_label: "October 2026",
  filing_cutoff_day: null,
  sentence: "The college pays in a monthly run.",
}

describe("the claimant's stage", () => {
  it("says the college's words, not the server's older ones", () => {
    expect(stageWord({ faculty_stage: "Under review" })).toBe("Being checked")
    expect(stageWord({ faculty_stage: "Sent back to you" })).toBe("Sent back")
    expect(stageWord({ faculty_stage: "Not accepted" })).toBe("Not accepted")
    expect(stageWord({ status: "PRINCIPAL_APPROVED" })).toBe("Being checked")
  })
})

describe("days since filing", () => {
  it("counts whole days from the filing date", () => {
    expect(filedSentence({ faculty_stage: "Under review", submitted_at: ago(0) }, NOW)).toBe("Filed today")
    expect(filedSentence({ faculty_stage: "Under review", submitted_at: ago(1) }, NOW)).toBe("Filed yesterday")
    expect(filedSentence({ faculty_stage: "Under review", submitted_at: ago(9) }, NOW)).toBe("Filed 9 days ago")
  })
  it("has nothing to count for a draft", () => {
    expect(filedSentence({ faculty_stage: "Draft" }, NOW)).toBe("Not filed yet")
  })
})

describe("what is needed from the claimant", () => {
  const need = (c: Record<string, unknown>) => needFromYou(c, NOW)
  it("is one plain sentence for every stage", () => {
    expect(need({ faculty_stage: "Sent back to you" })).toEqual({
      text: "Fix what was sent back, then send it again.",
      action: true,
    })
    expect(need({ faculty_stage: "Draft" }).action).toBe(true)
    expect(need({ faculty_stage: "Under review", submitted_at: ago(3) })).toEqual({
      text: "Nothing. We'll tell you when it moves.",
      action: false,
    })
    expect(need({ faculty_stage: "Paid" }).text).toMatch(/^Nothing\./)
    expect(need({ faculty_stage: "Not accepted" }).action).toBe(false)
  })
  it("points to the research office, never a desk, when it is slow", () => {
    const slow = need({ faculty_stage: "Under review", submitted_at: ago(20) }).text
    expect(slow).toMatch(/research office/)
    expect(slow).not.toMatch(/principal|director|finance|research cell/i)
  })
})

describe("the amount", () => {
  it("is an estimate until it is paid", () => {
    expect(amountView({ faculty_stage: "Under review", remuneration: 42000, remuneration_is_estimate: true })).toEqual({
      caption: "Expected",
      amount: 42000,
      note: "An estimate until it is paid",
    })
    // Nothing to pay because the yearly threshold took it: say so rather than "No payment due".
    expect(
      amountView({ faculty_stage: "Under review", remuneration: 0, threshold_absorbed: 20000 }).note
    ).toBe("Inside your research threshold")
    expect(amountView({ faculty_stage: "Under review", remuneration: 0 }).note).toBe("No payment due")
    expect(amountView({ faculty_stage: "Paid", remuneration: 33000 })).toEqual({ caption: "Paid", amount: 33000, note: null })
  })
  it("never draws a confident zero for a claim nobody has priced", () => {
    expect(amountView({ faculty_stage: "Draft", remuneration: 0, remuneration_is_estimate: true }).amount).toBeNull()
    expect(amountView({ faculty_stage: "Draft", remuneration: null }).note).toBe("Not worked out yet")
    expect(amountView({ faculty_stage: "Under review", calc_error: "x" }).note).toBe("Could not be worked out")
  })
})

describe("the month paid", () => {
  it("reads the payout month, else the day it was paid", () => {
    expect(monthLabel("2026-09")).toBe("September 2026")
    expect(monthPaid({ faculty_stage: "Paid", payout_month: "2026-09" })).toBe("September 2026")
    expect(monthPaid({ faculty_stage: "Paid", paid_at: "2026-03-14T00:00:00Z" })).toBe("March 2026")
    expect(monthPaid({ faculty_stage: "Under review", payout_month: "2026-09" })).toBeNull()
  })
  it("links to the financial year (April to March) it falls in", () => {
    expect(financialYearOf("2026-09")).toBe(2026)
    expect(financialYearOf("2027-02")).toBe(2026)
    expect(statementLink({ faculty_stage: "Paid", payout_month: "2027-02" })).toBe("/papers/statement?fy=2026")
    expect(statementLink({ faculty_stage: "Paid" })).toBe("/papers/statement")
  })
})

describe("when the money comes", () => {
  it("names the next run from the college's pattern, and promises it only when approved", () => {
    expect(payoutLine({ faculty_stage: "Under review" }, OUTLOOK)).toBe(
      "If it is approved, the next payment run is expected in October 2026."
    )
    expect(payoutLine({ faculty_stage: "Approved for payment" }, OUTLOOK)).toMatch(
      /goes out in the next payment run, expected in October 2026/
    )
    expect(payoutLine({ faculty_stage: "Paid", payout_month: "2026-09" }, OUTLOOK)).toBe("Paid in September 2026.")
    expect(payoutLine({ faculty_stage: "Not accepted" }, OUTLOOK)).toBeNull()
  })
  it("sends to the research office when there is no pattern", () => {
    expect(payoutLine({ faculty_stage: "Under review" }, null)).toMatch(/research office/)
  })
})
