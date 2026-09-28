import { fireEvent, render } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { Avatar } from "@/ui/person"

describe("Avatar", () => {
  it("falls back to initials when the photo fails to load", () => {
    const { container } = render(<Avatar person={{ name: "Dr. Asha Rao", initials: "AR", photo_url: "/media/missing.jpg" }} />)
    fireEvent.error(container.querySelector("img")!)
    expect(container.querySelector("img")).toBeNull()
    expect(container.textContent).toBe("AR")
  })
  it("works out initials when none are given", () => {
    const { container } = render(<Avatar person={{ name: "Mr. S. Joyal Isac", initials: "", photo_url: null }} />)
    expect(container.textContent).toBe("SI")
  })
})
