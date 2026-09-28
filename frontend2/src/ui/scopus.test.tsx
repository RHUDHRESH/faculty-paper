import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { ScopusProfileCard, type ScopusProfile } from "@/ui/scopus"

const PROFILE: ScopusProfile = {
  scopus_id: "57983494200",
  url: "https://www.scopus.com/authid/detail.uri?authorId=57983494200",
  author_name: null,
  affiliation: null,
  publications: 26,
  citations: 166,
  h_index: 8,
  publications_by_year: { "2024": 3, "2025": 3 },
  documents_listed: 26,
  source_sheet: "Mr. S. Joyal Isac",
  imported_at: "2026-09-23T08:00:00Z",
}

describe("a person's Scopus profile", () => {
  it("links the id to the author's page on Scopus", () => {
    render(<ScopusProfileCard profile={PROFILE} />)
    const link = screen.getByRole("link", { name: /57983494200/ })
    expect(link).toHaveAttribute(
      "href",
      "https://www.scopus.com/authid/detail.uri?authorId=57983494200"
    )
  })

  it("shows publications, citations and the h-index, and when it was imported", () => {
    render(<ScopusProfileCard profile={PROFILE} />)
    expect(screen.getByText("26")).toBeInTheDocument()
    expect(screen.getByText("166")).toBeInTheDocument()
    expect(screen.getByText("8")).toBeInTheDocument()
    expect(screen.getByText(/imported 23 Sept? 2026/i)).toBeInTheDocument()
  })

  it("says none is loaded rather than showing zeros", () => {
    render(<ScopusProfileCard profile={null} />)
    expect(screen.getByText(/no scopus profile has been imported/i)).toBeInTheDocument()
    expect(screen.queryByText("0")).toBeNull()
  })
})
