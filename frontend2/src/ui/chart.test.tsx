import { render } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { Trend } from "@/ui/chart"

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
