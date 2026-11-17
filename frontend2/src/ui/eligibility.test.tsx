import { render, screen } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { describe, expect, it } from "vitest"

import { ClaimEligibilityGate, ConditionTickList } from "@/ui/eligibility"

/** Three boxes that all say "I confirm this is true" are three unnamed boxes to a screen reader. */
describe("the filing confirmations", () => {
  it("each tick box is named for the condition it confirms (tick list)", () => {
    render(
      <MemoryRouter>
        <ConditionTickList ticks={{}} onChange={() => {}} />
      </MemoryRouter>
    )
    const boxes = screen.getAllByRole("checkbox")
    expect(boxes.length).toBeGreaterThanOrEqual(3)
    const names = boxes.map((b) => b.getAttribute("aria-label"))
    expect(names.every((n) => /^I confirm: .{10,}/.test(n ?? ""))).toBe(true)
    expect(new Set(names).size).toBe(names.length)
  })

  it("each acknowledgement in the gate is named too, and the names differ", () => {
    render(
      <MemoryRouter>
        <ClaimEligibilityGate onAcknowledge={() => {}} />
      </MemoryRouter>
    )
    const names = screen.getAllByRole("checkbox").map((b) => b.getAttribute("aria-label"))
    expect(names.length).toBeGreaterThanOrEqual(3)
    expect(names.every((n) => !!n && n.startsWith("I confirm: "))).toBe(true)
    expect(new Set(names).size).toBe(names.length)
  })
})
