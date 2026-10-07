import { screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { AlreadyFiled } from "@/pages/filing/finder"
import { renderWithProviders } from "@/test/harness"

describe("the filing form, the moment a paper is picked", () => {
  it("says a paper already claimed cannot be filed again, in the server's words, and links to the claim", () => {
    renderWithProviders(
      <AlreadyFiled
        found={{
          id: "c1",
          ticket_number: "FP-2026-000007",
          is_draft: false,
          code: "filed",
          blocks: true,
          message: "You have already claimed this paper (claim FP-2026-000007). It is under review.",
        }}
      />
    )
    expect(screen.getByText("This paper cannot be filed again")).toBeInTheDocument()
    expect(screen.getByText(/It is under review/)).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "Open that claim" })).toHaveAttribute("href", "/papers/c1")
    // No desk, no colleague.
    expect(document.body.textContent).not.toMatch(/research office|principal|director|finance|clearing/i)
  })

  it("says a paper that was paid, with no claim to open when it was paid in the old workbook", () => {
    renderWithProviders(
      <AlreadyFiled
        found={{
          id: null,
          ticket_number: null,
          is_draft: false,
          code: "paid_before",
          blocks: true,
          message: "The college's payment record shows this paper was paid to you in March 2025. A paper is paid once.",
        }}
      />
    )
    expect(screen.getByText(/paid to you in March 2025/)).toBeInTheDocument()
    expect(screen.queryByRole("link")).toBeNull()
  })

  it("points a draft at the draft", () => {
    renderWithProviders(
      <AlreadyFiled found={{ id: "d1", ticket_number: null, is_draft: true, code: "draft", blocks: true, message: "This paper is already one of your drafts. Open it to carry on." }} />
    )
    expect(screen.getByRole("link", { name: "Open the draft" })).toHaveAttribute("href", "/papers/d1/edit")
  })

  it("still reads for an older server that sends no sentence", () => {
    renderWithProviders(<AlreadyFiled found={{ id: "c2", ticket_number: "T-1", is_draft: false }} />)
    expect(screen.getByText(/It is claim T-1/)).toBeInTheDocument()
  })
})
