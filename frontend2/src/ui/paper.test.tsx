import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { money, Stage, stageOf, STAGES } from "@/ui/paper"

/**
 * The two pure functions every screen that shows money or progress goes
 * through. Both have failed in production in ways a typecheck cannot see: a
 * missing amount printed as zero, and a status the backend emits falling
 * through to a blank cell on a real ticket.
 */

/* ------------------------------------------------------------------------ */
/* money                                                                     */
/* ------------------------------------------------------------------------ */

describe("money", () => {
  it("says nothing rather than zero when there is no amount", () => {
    // The whole point. "Not calculated yet" and "you are owed ₹0" are
    // different sentences, and a claimant reading the second one when the
    // first is true concludes their paper is worth nothing.
    expect(money(null)).toBe("—")
    expect(money(undefined)).toBe("—")
    expect(money(null)).not.toBe(money(0))
  })

  it("renders a real zero as a real zero", () => {
    expect(money(0)).toBe("₹0")
  })

  it("groups in the Indian system, not in thousands", () => {
    expect(money(50875)).toBe("₹50,875")
    // 2,50,000 — not 250,000. A lakh grouped the western way is the tell
    // that a locale was left at the default somewhere.
    expect(money(250_000)).toBe("₹2,50,000")
    expect(money(12_500_000)).toBe("₹1,25,00,000")
  })

  it("shows paise only when there are paise, and then two digits", () => {
    // 52377.5 came off the payout formula and rendered as "52,377.5" — one
    // stray decimal beside "39,081", which reads as a rounding mistake.
    expect(money(52_377.5)).toBe("₹52,377.50")
    expect(money(50_875.25)).toBe("₹50,875.25")
    expect(money(39_081)).toBe("₹39,081")
    expect(money(50_875)).not.toContain(".")
  })

  it("keeps the sign on a negative amount", () => {
    // A recovery or a correction. Dropping the sign turns money owed back
    // into money owed out.
    expect(money(-1_500)).toBe("₹-1,500")
    expect(money(-1_500.5)).toBe("₹-1,500.50")
    expect(money(-1_500)).not.toBe(money(1_500))
  })
})

/* ------------------------------------------------------------------------ */
/* stageOf                                                                   */
/* ------------------------------------------------------------------------ */

/**
 * Every value `ClaimStatus` in `backend/core/models.py` can hold, including
 * the three legacy ones that no new claim enters but that imported tickets
 * still sit at.
 */
const BACKEND_STATUSES = [
  "DRAFT",
  "SUBMITTED",
  "CLEARED",
  "PRINCIPAL_APPROVED",
  "DIRECTOR_APPROVED",
  "PAID",
  "REJECTED",
  "HOD_APPROVED",
  "RESEARCH_APPROVED",
  "FINANCE_APPROVED",
] as const

/** The two that are legitimately not travelling: a draft and a sent-back
 *  ticket are off the chain, so `step` is null by design. */
const OFF_CHAIN = new Set(["DRAFT", "REJECTED"])

describe("stageOf", () => {
  it.each(BACKEND_STATUSES)("maps %s to a stage the claimant can read", (status) => {
    const stage = stageOf(status)

    // The default arm humanises the raw status and leaves `who` empty. A
    // status that lands there is a blank cell on somebody's ticket, so the
    // test for "is this mapped" is "does it say who is holding it".
    expect(stage.who, `${status} fell through to the default arm`).not.toBe("")
    expect(stage.label).not.toBe("")

    if (OFF_CHAIN.has(status)) {
      expect(stage.step).toBeNull()
    } else {
      expect(STAGES).toContain(stage.step)
    }
  })

  it("puts the legacy statuses on the same steps as their live equivalents", () => {
    // These three are the ones that quietly stopped being mapped when the
    // chain was renamed, and every imported ticket sits at one of them.
    expect(stageOf("HOD_APPROVED").step).toBe(stageOf("SUBMITTED").step)
    expect(stageOf("RESEARCH_APPROVED").step).toBe(stageOf("CLEARED").step)
    expect(stageOf("FINANCE_APPROVED").step).toBe(stageOf("DIRECTOR_APPROVED").step)
  })

  it("keeps the Principal's approval and the Director's authorisation apart", () => {
    // One word covering two desks is what sent claimants to Finance while
    // their ticket was still on the Director's list.
    expect(stageOf("PRINCIPAL_APPROVED").step).toBe("Approved")
    expect(stageOf("PRINCIPAL_APPROVED").who).toMatch(/Director/i)
    expect(stageOf("DIRECTOR_APPROVED").step).toBe("Authorised")
    expect(stageOf("DIRECTOR_APPROVED").who).toMatch(/Finance/i)
  })

  it("still says something for a status this build has never heard of", () => {
    const stage = stageOf("SOME_NEW_STATUS")
    expect(stage.label).toBe("SOME NEW STATUS")
  })
})

/* ------------------------------------------------------------------------ */
/* Stage                                                                     */
/* ------------------------------------------------------------------------ */

describe("Stage", () => {
  it("draws a bar only while there is distance left to travel", () => {
    render(<Stage stage={stageOf("CLEARED")} />)
    const bar = screen.getByRole("progressbar")
    expect(bar).toHaveAttribute("aria-valuenow", String(STAGES.indexOf("Checked") + 1))
    expect(bar).toHaveAttribute("aria-valuemax", String(STAGES.length))
  })

  it("shows no bar beside a settled ticket", () => {
    // "Step 5 of 5" beside a badge already reading Paid is noise on every
    // settled row in the table.
    render(<Stage stage={stageOf("PAID")} />)
    expect(screen.queryByRole("progressbar")).toBeNull()
    expect(screen.getByText("Paid")).toBeInTheDocument()
  })
})
