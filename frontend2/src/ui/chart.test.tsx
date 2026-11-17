import { render } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { RankedBars, Trend } from "@/ui/chart"

/**
 * The time axis of a trend: enough labels to orient, never two on top of each
 * other. The last period is always labelled, right-aligned to the end of the
 * axis, so the label before it has to leave room for a whole label, not half.
 */

describe("Trend's time axis", () => {
  afterEach(() => vi.restoreAllMocks())

  it("never puts a label on top of the last one on a phone-width chart", () => {
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(390)
    const points = Array.from({ length: 30 }, (_, i) => ({ key: `d${i}`, label: `Day ${i}`, count: i % 3 }))
    const { container } = render(<Trend title="Profile views" dimension="day" points={points} height={160} />)

    const labels = [...container.querySelectorAll("text")]
      .filter((t) => (t.textContent ?? "").startsWith("Day "))
      .map((t) => Number(t.getAttribute("x")))
      .sort((a, b) => a - b)
    expect(labels.length).toBeGreaterThan(2)
    const last = labels[labels.length - 1]
    const before = labels[labels.length - 2]
    // A 12px date is about 56px wide: a centred label needs half of that to
    // its right, the right-aligned last label all of it to its left.
    expect(last - before).toBeGreaterThanOrEqual(56 * 1.5)
  })
})

describe("RankedBars overflow note", () => {
  it("says how many more there are in plain words, with no dash", () => {
    const points = Array.from({ length: 14 }, (_, i) => ({ key: `k${i}`, label: `Row ${i}`, count: 20 - i }))
    const { container } = render(<RankedBars title="Papers" dimension="department" points={points} />)
    expect(container.textContent).toContain("4 more in the numbers below.")
    expect(container.textContent).not.toContain(" — ")
  })
})

describe("RankedBars with an unknown bucket", () => {
  it("lists what is unknown last and always, however large and however many rows there are", () => {
    const points = [
      ...Array.from({ length: 14 }, (_, i) => ({ key: `k${i}`, label: `Row ${i}`, count: 100 - i })),
      { key: "none", label: "No department on the account (900)", count: 900, unknown: true },
    ]
    const { container } = render(<RankedBars title="Papers" dimension="department" points={points} />)
    const names = [...container.querySelectorAll("li")].map((li) => li.textContent ?? "")
    expect(names).toHaveLength(10)
    expect(names[0]).toContain("Row 0")
    expect(names[9]).toContain("No department on the account (900)")
    expect(names.filter((n) => n.includes("No department"))).toHaveLength(1)
  })
})
