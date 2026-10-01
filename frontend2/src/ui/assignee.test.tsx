import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import { AssignedToMeChip, AssigneeBadge, countAssignedToMe, isAssignedToMe } from "@/ui/assignee"

const asha = { user_id: "u1", name: "Asha Rao" }
const ravi = { user_id: "u2", name: "Ravi Cell" }

describe("assignee", () => {
  it("knows which rows are mine", () => {
    const rows = [{ assigned_to: asha }, { assigned_to: ravi }, { assigned_to: null }, {}]
    expect(isAssignedToMe(rows[0], "u1")).toBe(true)
    expect(isAssignedToMe(rows[2], "u1")).toBe(false)
    expect(countAssignedToMe(rows, "u1")).toBe(1)
    expect(countAssignedToMe(rows, undefined)).toBe(0)
  })

  it("says You for the viewer and the name for anyone else", () => {
    const { rerender } = render(<AssigneeBadge assignee={asha} me="u1" />)
    expect(screen.getByText("You")).toBeInTheDocument()
    rerender(<AssigneeBadge assignee={ravi} me="u1" />)
    expect(screen.getByText("Ravi Cell")).toBeInTheDocument()
  })

  it("draws nothing for an unassigned claim unless told what to say", () => {
    const { container, rerender } = render(<AssigneeBadge assignee={null} />)
    expect(container).toBeEmptyDOMElement()
    rerender(<AssigneeBadge assignee={null} empty="Not assigned" />)
    expect(screen.getByText("Not assigned")).toBeInTheDocument()
  })

  it("shows the Assigned to me chip with a count, and toggles", async () => {
    const onToggle = vi.fn()
    render(<AssignedToMeChip rows={[{ assigned_to: asha }, { assigned_to: ravi }]} me="u1" active={false} onToggle={onToggle} />)
    const chip = screen.getByRole("button", { name: /Assigned to me/ })
    expect(chip).toHaveTextContent("1")
    await userEvent.click(chip)
    expect(onToggle).toHaveBeenCalled()
  })

  it("hides the chip when nothing is assigned to the viewer", () => {
    const { container } = render(<AssignedToMeChip rows={[{ assigned_to: ravi }]} me="u1" active={false} onToggle={() => {}} />)
    expect(container).toBeEmptyDOMElement()
  })
})
