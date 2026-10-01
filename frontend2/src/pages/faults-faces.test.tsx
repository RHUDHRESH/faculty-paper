import { render, screen } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { describe, expect, it } from "vitest"
import { FaultPeople } from "./faults"

describe("FaultPeople", () => {
  it("shows names with a face and links to the profile, not the email", () => {
    render(
      <MemoryRouter>
        <FaultPeople people={[{ user_id: "u1", name: "Asha Rao", email: "a@x.edu", initials: "AR", photo_url: null }]} />
      </MemoryRouter>,
    )
    const link = screen.getByRole("link", { name: /Asha Rao/ })
    expect(link.getAttribute("href")).toBe("/u/u1")
    expect(screen.getByText("AR")).toBeTruthy()
    expect(screen.queryByText("a@x.edu")).toBeNull()
  })
})
