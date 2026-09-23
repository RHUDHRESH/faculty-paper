import { screen, within } from "@testing-library/react"
import { Route, Routes } from "react-router-dom"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return { ...actual, api: vi.fn() }
})

import { api } from "@/lib/api"
import { Person } from "@/pages/people"
import { fakeApi, renderWithProviders } from "@/test/harness"
import type { Me } from "@/app/auth"

/** The office's view of one person carries what Scopus holds for them. */

const OFFICE: Me = {
  id: "u-cell",
  email: "cell@example.edu",
  name: "Research Cell",
  role: "RESEARCH_CELL",
  department: null,
}

const REPORT = {
  faculty: {
    id: "u1", email: "joyal@example.edu", name: "Joyal Isac S", role: "FACULTY",
    department: "EEE", designation: "Assistant Professor",
  },
  totals: { publications: 0, paid_claims: 0, paid_amount: 0, in_review: 0 },
  by_month: [], by_quartile: [], by_status: [], by_year: [], by_journal: [],
  by_type: [], by_position: [], claims: [],
}

const PROFILE = {
  scopus_id: "57983494200",
  url: "https://www.scopus.com/authid/detail.uri?authorId=57983494200",
  author_name: null, affiliation: null,
  publications: 26, citations: 166, h_index: 8,
  publications_by_year: {}, documents_listed: 26,
  source_sheet: "Mr. S. Joyal Isac", imported_at: "2026-09-23T08:00:00Z",
}

function mount(scopus_profile: unknown) {
  vi.mocked(api).mockImplementation(
    fakeApi({
      "/api/auth/me": () => OFFICE,
      "/api/faculty/u1/report": () => ({ ...REPORT, scopus_profile }),
    })
  )
  return renderWithProviders(
    <Routes>
      <Route path="/people/:id" element={<Person />} />
    </Routes>,
    { route: "/people/u1" }
  )
}

describe("a person's record, seen by the office", () => {
  it("shows their Scopus figures and links the id to Scopus", async () => {
    mount(PROFILE)
    const region = await screen.findByRole("region", { name: /scopus profile/i })
    expect(within(region).getByRole("link", { name: /57983494200/ })).toHaveAttribute(
      "href",
      PROFILE.url
    )
    expect(within(region).getByText("166")).toBeInTheDocument()
  })

  it("says when no profile has been imported", async () => {
    mount(null)
    const region = await screen.findByRole("region", { name: /scopus profile/i })
    expect(within(region).getByText(/no scopus profile has been imported/i)).toBeInTheDocument()
  })
})
