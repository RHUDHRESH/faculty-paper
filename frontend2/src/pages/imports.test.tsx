import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return { ...actual, api: vi.fn() }
})

import { api } from "@/lib/api"
import { Imports } from "@/pages/imports"
import { fakeApi, renderWithProviders, type ApiTable } from "@/test/harness"
import type { Me } from "@/app/auth"

/**
 * The two rosters the office loads besides the ERP workbook: the final-year
 * project teams, and the Scopus author profiles -- each with the list of
 * things the office has to put right afterwards, kept on the page rather
 * than in a toast.
 */

const OFFICE: Me = {
  id: "u-cell",
  email: "cell@example.edu",
  name: "Research Cell",
  role: "RESEARCH_CELL",
  department: null,
}

const STATS = {
  faculty_master: 435, claims: 10, claims_paid: 2, prior_payments: 0,
  paid_ledger: 0, scimago: 0, snip: 0, users: 411,
}

const UNMATCHED = [
  { code: "PR26EC0027", faculty_id: "TSEC066", mentor_name: "Ms. Gomathi V", department: "ECE" },
  { code: "PR26BM0003", faculty_id: "TSMED34", mentor_name: "Dr.R.Helen", department: "BME" },
]

const SUMMARY = {
  teams: 494,
  imported: 494,
  academic_years: ["2025-26"],
  last_imported_at: "2026-09-23T08:00:00Z",
  claimed: 3,
  mentors_unmatched: UNMATCHED,
}

const VERIFICATION = {
  profiles: 2,
  last_imported_at: "2026-09-23T08:00:00Z",
  profiles_without_account: [
    { scopus_id: "57527550200", url: "https://www.scopus.com/authid/detail.uri?authorId=57527550200",
      sheet: "General", author_name: null, publications: 49, citations: 170 },
  ],
  ambiguous: [],
  faculty_without_scopus: [
    { user_id: "u9", name: "No Id Yet", email: "noid@example.edu", department: "EEE",
      staff_id: "TSEE009", faculty_master_scopus_id: "22222222222" },
  ],
  name_mismatches: [
    { user_id: "u1", name: "Joyal Isac S", email: "joyal@example.edu", department: "EEE",
      staff_id: "TSEE001", stored_scopus_id: "11111111111", sheet_scopus_id: "57983494200",
      sheet: "Mr. S. Joyal Isac", sheet_url: "https://www.scopus.com/authid/detail.uri?authorId=57983494200" },
  ],
}

function mount(over: ApiTable = {}) {
  vi.mocked(api).mockImplementation(
    fakeApi({
      "/api/auth/me": () => OFFICE,
      "/api/admin/erp-stats": () => STATS,
      "/api/admin/faculty-master": () => [],
      "/api/admin/process": () => [],
      "/api/admin/fyp-teams": () => SUMMARY,
      "/api/admin/scopus-profiles/verification": () => VERIFICATION,
      ...over,
    })
  )
  return renderWithProviders(<Imports />, { route: "/imports" })
}

function section(name: RegExp) {
  return screen.findByRole("region", { name })
}

describe("the final-year project roster", () => {
  it("says what is loaded and lists the mentors with no account", async () => {
    mount()
    const region = await section(/final-year project teams/i)
    expect(await within(region).findByText(/494 teams/)).toBeInTheDocument()
    expect(within(region).getByText("TSEC066")).toBeInTheDocument()
    expect(within(region).getByText("Ms. Gomathi V")).toBeInTheDocument()
    expect(within(region).getByText("PR26BM0003")).toBeInTheDocument()
  })

  it("uploads the workbook and keeps the counts on the page", async () => {
    const user = userEvent.setup()
    mount({
      "/api/admin/fyp-teams/import": () => ({
        sheet: "25-26", academic_year: "2025-26", teams: 494, created: 490, updated: 3,
        unchanged: 1, mentors_unmatched: UNMATCHED, skipped: [],
      }),
    })
    const region = await section(/final-year project teams/i)
    await user.upload(
      within(region).getByLabelText(/roster workbook/i),
      new File(["x"], "roster.xlsx")
    )
    await user.click(within(region).getByRole("button", { name: /import the teams/i }))

    await waitFor(() =>
      expect(
        vi.mocked(api).mock.calls.some(
          ([p, o]) =>
            p === "/api/admin/fyp-teams/import" &&
            (o as { method?: string; body?: unknown })?.method === "POST" &&
            (o as { body?: unknown }).body instanceof FormData
        )
      ).toBe(true)
    )
    const status = await within(region).findByRole("status")
    expect(status).toHaveTextContent("490 created")
    expect(status).toHaveTextContent("3 updated")
    expect(status).toHaveTextContent("1 unchanged")
    expect(status).toHaveTextContent("2 mentors")
  })
})

describe("the Scopus profiles and what to put right", () => {
  it("lists profiles no account claims, faculty with no id, and ids that disagree", async () => {
    mount()
    const region = await section(/scopus author profiles/i)
    expect(await within(region).findByText("57527550200")).toBeInTheDocument()
    expect(within(region).getByText("No Id Yet")).toBeInTheDocument()
    expect(within(region).getByText(/22222222222/)).toBeInTheDocument()
    expect(within(region).getByText("Joyal Isac S")).toBeInTheDocument()
    expect(within(region).getByText("11111111111")).toBeInTheDocument()
    expect(within(region).getByText("57983494200")).toBeInTheDocument()
  })

  it("uploads the profile workbook and reports what matched", async () => {
    const user = userEvent.setup()
    mount({
      "/api/admin/scopus-profiles/import": () => ({
        sheets: 2, created: 2, updated: 0, linked: 1,
        unmatched: [{ scopus_id: "57527550200", sheet: "General", author_name: null }],
        ambiguous: [], warnings: [],
      }),
    })
    const region = await section(/scopus author profiles/i)
    await user.upload(
      within(region).getByLabelText(/profile workbook/i),
      new File(["x"], "profiles.xlsx")
    )
    await user.click(within(region).getByRole("button", { name: /import the profiles/i }))
    const status = await within(region).findByRole("status")
    expect(status).toHaveTextContent("2 created")
    expect(status).toHaveTextContent("1 linked")
    expect(status).toHaveTextContent("57527550200")
  })
})
