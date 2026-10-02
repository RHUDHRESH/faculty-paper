import { render, screen } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { describe, expect, it } from "vitest"

import { estimateEffect, ThresholdCard, type ThresholdSummary } from "@/ui/research-threshold"

/**
 * What the research threshold does to a claim that is about to be filed, in
 * one sentence. Only approved or paid claims are "used"; claims still on the
 * way are ahead of a new one and take their part first. It is the form's own
 * estimate, never the server's decision.
 */

const base: ThresholdSummary = {
  research: true,
  threshold: 300000,
  used: 0,
  on_the_way: 0,
  year: "2026-27",
  message: "You are research faculty. Your threshold this year is ₹3,00,000.",
}

describe("estimateEffect", () => {
  it("says nothing for regular faculty, an unset threshold or no estimate", () => {
    expect(estimateEffect(9000, { research: false })).toBeNull()
    expect(estimateEffect(9000, { ...base, unset: true, threshold: null })).toBeNull()
    expect(estimateEffect(null, base)).toBeNull()
    expect(estimateEffect(0, base)).toBeNull()
    expect(estimateEffect(9000, undefined)).toBeNull()
  })

  it("says a claim inside the threshold pays nothing, and how much is left", () => {
    const e = estimateEffect(9000, { ...base, used: 14958 })
    expect(e).toMatchObject({ absorbed: 9000, payable: 0 })
    expect(e?.sentence).toBe(
      "Inside your research threshold: ₹2,85,042 of the threshold is left this year, so nothing would be paid on this claim."
    )
  })

  it("says a claim that crosses the threshold pays only the part above it", () => {
    const e = estimateEffect(9000, { ...base, used: 295000 })
    expect(e).toMatchObject({ absorbed: 5000, payable: 4000 })
    expect(e?.sentence).toBe(
      "Crosses your research threshold: ₹5,000 of it counts against the threshold, and about ₹4,000 above it would be paid."
    )
  })

  it("says a claim after the threshold is used is paid in full", () => {
    const e = estimateEffect(9000, { ...base, used: 300000 })
    expect(e).toMatchObject({ absorbed: 0, payable: 9000 })
    expect(e?.sentence).toMatch(/already used, so this claim would be paid in full/)
  })

  it("puts claims still on the way ahead of a new one", () => {
    // Nothing is used yet, but earlier claims on the way would take all of it.
    const e = estimateEffect(9000, { ...base, used: 0, on_the_way: 300000 })
    expect(e).toMatchObject({ absorbed: 0, payable: 9000 })
  })
})

describe("ThresholdCard", () => {
  it("is a sentence and a meter on the page, not a panel", () => {
    render(
      <MemoryRouter>
        <ThresholdCard s={{ ...base, used: 14958 }} />
      </MemoryRouter>
    )
    const box = screen.getByTestId("research-threshold")
    expect(box.className).not.toMatch(/bg-sunken/)
    expect(box).toHaveTextContent("Your threshold this year is ₹3,00,000")
    expect(screen.getByRole("meter")).toBeInTheDocument()
    // The hatched explanation only appears when there is something hatched.
    expect(box).not.toHaveTextContent(/Hatched/)
  })

  it("says what hatched means only when claims are on the way", () => {
    render(
      <MemoryRouter>
        <ThresholdCard s={{ ...base, used: 1000, on_the_way: 5000 }} link={false} />
      </MemoryRouter>
    )
    expect(screen.getByTestId("research-threshold")).toHaveTextContent(/Hatched: what claims still on the way would add/)
  })

  it("draws nothing for regular faculty", () => {
    const { container } = render(
      <MemoryRouter>
        <ThresholdCard s={{ research: false }} />
      </MemoryRouter>
    )
    expect(container).toBeEmptyDOMElement()
  })
})
