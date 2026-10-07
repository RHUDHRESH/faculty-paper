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
  name: "Research Office",
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
  return renderWithProviders(<Imports />, { route: "/imports?open=fyp-roster,scopus-profiles,harvest" })
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

describe("the publication harvest (super admin)", () => {
  const ADMIN: Me = { id: "u-sa", email: "sa@example.edu", name: "Admin", role: "SUPER_ADMIN", department: null }

  it("queues OpenAlex and Scopus jobs and shows the status", async () => {
    const user = userEvent.setup()
    mount({
      "/api/auth/me": () => ADMIN,
      "/api/admin/publications/status": () => ({
        publications: 1200, authorships: 4000, college_authorships: 900, college_matched: 850,
        users_with_publications: 300, unmatched_college_names: [],
        last_run: { action: "PUBLICATION_HARVEST_QUEUED", at: "2026-09-20T10:00:00Z", detail: {} },
      }),
      "/api/admin/publications/harvest": () => ({ ok: true, queued: true, job_id: "abc123456" }),
      "/api/admin/publications/scopus-sync": () => ({ ok: true, queued: true, job_id: "def" }),
    })
    const region = await section(/publication record/i)
    expect(await within(region).findByText(/1,200 papers/)).toBeInTheDocument()
    expect(within(region).getByText(/publication harvest queued/i)).toBeInTheDocument()
    await user.click(within(region).getByRole("button", { name: /Refresh from OpenAlex/ }))
    await user.click(within(region).getByRole("button", { name: /Sync Scopus/ }))
    await waitFor(() => {
      const calls = vi.mocked(api).mock.calls
      const hit = (path: string) =>
        calls.some(([p, o]) => p === path && (o as { method?: string })?.method === "POST")
      expect(hit("/api/admin/publications/harvest")).toBe(true)
      expect(hit("/api/admin/publications/scopus-sync")).toBe(true)
    })
  })

  it("answers first, and opens each importer only on request", async () => {
    const user = userEvent.setup()
    vi.mocked(api).mockImplementation(
      fakeApi({
        "/api/auth/me": () => OFFICE,
        "/api/admin/erp-stats": () => STATS,
        "/api/admin/audit/origins": () => ({ events: [] }),
        "/api/admin/faculty-master": () => [],
      })
    )
    renderWithProviders(<Imports />, { route: "/imports" })
    expect(await screen.findByText("People on the roster")).toBeInTheDocument()
    // The form is not on the page until it is asked for.
    expect(screen.queryByLabelText(/roster csv/i)).toBeNull()
    await user.click(screen.getByRole("button", { name: /Faculty roster/ }))
    expect(await screen.findByLabelText(/roster csv/i)).toBeInTheDocument()
    // The warning that it overwrites is on the form itself.
    expect(screen.getByText(/replaces rows it already has/i)).toBeInTheDocument()
  })

  it("is not shown to the office", async () => {
    mount()
    await section(/final-year project teams/i)
    expect(screen.queryByRole("region", { name: /publication record/i })).toBeNull()
  })
})

describe("restoring a full export (super admin)", () => {
  const ADMIN: Me = { id: "u-sa", email: "sa@example.edu", name: "Admin", role: "SUPER_ADMIN", department: null }
  const RUN = {
    filename: "export.jsonl.gz", status: "running", phase: "load", done: 45000, total: 160524, loaded: 45000,
    kept_existing: 0, model: "core.authorship", links: 0, dropped: {}, chain: 1, seconds: 20, error: "",
    percent: 28, stalled: false, file_kept: true, fixups: 0,
  }
  const base = (run: unknown): ApiTable => ({
    "/api/auth/me": () => ADMIN,
    "/api/admin/erp-stats": () => STATS,
    "/api/admin/faculty-master": () => [],
    "/api/admin/process": () => [],
    "/api/admin/restore/status": () => ({ run }),
  })

  it("opens by itself and shows real progress while a restore runs", async () => {
    vi.mocked(api).mockImplementation(fakeApi(base(RUN)))
    renderWithProviders(<Imports />, { route: "/imports" })
    const bar = await screen.findByRole("progressbar", { name: /restore progress/i })
    expect(bar).toHaveAttribute("aria-valuenow", "28")
    expect(screen.getByText(/45,000 of 1,60,524 records/)).toBeInTheDocument()
    expect(screen.getByText(/now authorship/)).toBeInTheDocument()
    expect(screen.getByText(/1 follow-up job/)).toBeInTheDocument()
    // no second upload while it is live
    expect(screen.queryByLabelText(/export file/i)).toBeNull()
  })

  it("offers to continue a stopped restore from the kept file", async () => {
    const user = userEvent.setup()
    vi.mocked(api).mockImplementation(
      fakeApi({
        ...base({ ...RUN, status: "failed", error: "the host restarted" }),
        "/api/admin/restore/resume": () => ({ ok: true, queued: true, job_id: "j" }),
      })
    )
    renderWithProviders(<Imports />, { route: "/imports" })
    expect(await screen.findByText("the host restarted")).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: /continue where it stopped/i }))
    await waitFor(() =>
      expect(
        vi.mocked(api).mock.calls.some(
          ([p, o]) => p === "/api/admin/restore/resume" && (o as { method?: string })?.method === "POST"
        )
      ).toBe(true)
    )
  })

  it("asks for the same file again when the server's copy is gone", async () => {
    vi.mocked(api).mockImplementation(fakeApi(base({ ...RUN, status: "failed", file_kept: false })))
    renderWithProviders(<Imports />, { route: "/imports" })
    expect(await screen.findByText(/uploaded copy is gone/i)).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /continue where it stopped/i })).toBeNull()
    expect(screen.getByLabelText(/export file/i)).toBeInTheDocument()
  })
})