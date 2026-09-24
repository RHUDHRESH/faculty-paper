/**
 * The author list on the "you and the claim" step.
 *
 * The claimant's position is a term in the payout and the one thing on the
 * form no index can answer for certain, so the list has to show which author
 * the form thinks they are, and make changing it one press -- not a number
 * typed into a box beside a list nobody could see.
 */
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import { AuthorList } from "./authors"

const AUTHORS = [
  { position: 1, name: "R. N. Kavitha", college: "yes" as const },
  { position: 2, name: "C. Valli", college: "no" as const },
  { position: 3, name: "V. UmaDevi", college: null },
]

describe("AuthorList", () => {
  it("lists every author in order and marks the claimant", () => {
    render(<AuthorList authors={AUTHORS} position={1} onPick={() => {}} collegeName="Saveetha Engineering College" />)
    const choices = screen.getAllByRole("radio")
    expect(choices).toHaveLength(3)
    expect(screen.getByRole("radio", { name: /1\. R\. N\. Kavitha/ })).toBeChecked()
    expect(screen.getByRole("radio", { name: /2\. C\. Valli/ })).not.toBeChecked()
    expect(screen.getByText("You")).toBeInTheDocument()
  })

  it("moves the claimant with one press", async () => {
    const onPick = vi.fn()
    render(<AuthorList authors={AUTHORS} position={1} onPick={onPick} collegeName="Saveetha Engineering College" />)
    await userEvent.setup().click(screen.getByRole("radio", { name: /3\. V\. UmaDevi/ }))
    expect(onPick).toHaveBeenCalledWith(3)
  })

  it("says which authors the paper prints the college beside", () => {
    render(<AuthorList authors={AUTHORS} position={2} onPick={() => {}} collegeName="Saveetha Engineering College" />)
    expect(screen.getByRole("radio", { name: /R\. N\. Kavitha.*Saveetha Engineering College/ })).toBeInTheDocument()
    expect(screen.getByRole("radio", { name: /C\. Valli.*another institution/ })).toBeInTheDocument()
  })
})
