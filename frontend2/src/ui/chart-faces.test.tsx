import { render, screen } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { describe, expect, it } from "vitest"
import { RankedBars } from "./chart"

describe("RankedBars faces", () => {
  it("draws a face beside a person's name", () => {
    render(
      <MemoryRouter>
        <RankedBars
          title="Who publishes here"
          dimension="Author"
          points={[{ key: "u1", label: "Asha Rao", count: 3, to: "/people/u1", face: { name: "Asha Rao", initials: "AR", photo_url: null } }]}
        />
      </MemoryRouter>,
    )
    expect(screen.getAllByText("AR").length).toBeGreaterThan(0)
    expect(screen.getAllByText("Asha Rao").length).toBeGreaterThan(0)
  })
})
