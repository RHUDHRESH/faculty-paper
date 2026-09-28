import { render, screen } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { describe, expect, it } from "vitest"
import { RecordStrip } from "./record-strip"

describe("RecordStrip tap target", () => {
  it("keeps the 12 px square and adds a 40 px hit area", () => {
    render(
      <MemoryRouter>
        <RecordStrip data={[{ month: "2025-03", papers: 2 }]} years={1} endYear={2025} variant="compact" />
      </MemoryRouter>,
    )
    const cell = screen.getByRole("button", { name: "March 2025, 2 papers" })
    expect(cell.className).toContain("size-3")
    expect(cell.className).toContain("before:size-10")
    expect(cell.className).toContain("relative")
  })
})
