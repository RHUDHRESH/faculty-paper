import { screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { Route, Routes } from "react-router-dom"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return { ...actual, api: vi.fn() }
})

import type { Me } from "@/app/auth"
import { api } from "@/lib/api"
import { FacultyDirectory } from "@/pages/faculty"
import { FacultyRecord } from "@/pages/faculty-record"
import type { DirectoryPayload, FacultyRecordPayload, FacultyRow, GapsPayload } from "@/pages/faculty-types"
import { fakeApi, renderWithProviders, HOD, FACULTY, type ApiTable } from "@/test/harness"

const OFFICE: Me = { id: "u-office", email: "o@example.edu", name: "Office", role: "RESEARCH_CELL", department: null }

function row(over: Partial<FacultyRow> = {}): FacultyRow {
  return {
    id: "f1",
    name: "Dr K R Devabalaji",
    initials: "KD",
    photo_url: null,
    department: "EEE",
    designation: "Professor",
    active: true,
    role: "FACULTY",
    staff_id: "TSEE001",
    faculty_type: "REGULAR",
    threshold_set: false,
    scopus_author_id: "57200597022",
    scopus_url: "https://www.scopus.com/authid/detail.uri?authorId=57200597022",
    orcid_id: null,
    orcid_url: null,
    papers: 63,
    papers_year: 27,
    citations: 126,
    h_index: 8,
    last_paper_year: 2026,
    last_paper_on: "2026-09-11",
    claims_filed_year: 2,
    claims_done: 5,
    claims_done_year: 1,
    completeness: 43,
    missing: [],
    incentive: { amount: 70382, total_amount: 250723 },
    ...over,
  }
}

function directory(rows: FacultyRow[], money = true): DirectoryPayload {
  return {
    total: rows.length,
    limit: 30,
    offset: 0,
    year: 2026,
    money,
    scope: money ? "college" : "department",
    counts: { people: rows.length, left: 0, research: 1, no_photo: 1, no_scopus: 1, no_papers_year: 2 },
    results: rows,
  }
}

const GAPS: GapsPayload = {
  population: 411,
  any: true,
  categories: [
    {
      key: "photo",
      label: "No photo",
      count: 74,
      who_fixes: "person",
      hint: "Only they can add a photo, so ask them.",
      people: [{ id: "p1", name: "Dr Bare Photo", initials: "BP", photo_url: null, department: "CSE", designation: null, fix_path: "/faculty/p1" }],
    },
    {
      key: "scopus",
      label: "No Scopus ID",
      count: 78,
      who_fixes: "office",
      hint: "Add the Scopus author ID on their account.",
      people: [{ id: "p2", name: "Dr No Scopus", initials: "NS", photo_url: null, department: "ECE", designation: null, fix_path: "/people/p2" }],
    },
    { key: "department", label: "No department", count: 0, who_fixes: "office", hint: "", people: [] },
    { key: "designation", label: "No designation", count: 0, who_fixes: "office", hint: "", people: [] },
  ],
}

function mountDirectory(me: Me, rows: FacultyRow[], money = true, route = "/faculty", extra: ApiTable = {}) {
  vi.mocked(api).mockReset()
  vi.mocked(api).mockImplementation(
    fakeApi({
      "/api/auth/me": () => me,
      "/api/directory/faculty/gaps": () => GAPS,
      "/api/directory/faculty?": () => directory(rows, money),
      "/api/meta/departments": () => ["CSE", "EEE"],
      ...extra,
    })
  )
  renderWithProviders(
    <Routes>
      <Route path="/faculty" element={<FacultyDirectory />} />
      <Route path="/faculty/me" element={<p>My own record</p>} />
    </Routes>,
    { route }
  )
}

describe("the faculty directory", () => {
  it("shows a face, identifiers, papers and incentives for the office, with the Scopus ID linked", async () => {
    mountDirectory(OFFICE, [row()])
    const list = await screen.findByRole("list", { name: "Faculty" })
    const item = within(list).getByRole("listitem")
    expect(within(item).getByRole("link", { name: "Dr K R Devabalaji" })).toHaveAttribute("href", "/faculty/f1")
    const scopus = within(item).getByRole("link", { name: /Scopus author page/ })
    expect(scopus).toHaveAttribute("href", expect.stringContaining("authorId=57200597022"))
    expect(within(item).getAllByText("63").length).toBeGreaterThan(0)
    expect(within(item).getAllByText("₹70,382").length).toBeGreaterThan(0)
    expect(screen.getByRole("link", { name: /Export as CSV/ }).getAttribute("href")).toContain("/api/directory/faculty/export.csv")
  })

  it("says whether a research threshold is set, and links the editor to the office", async () => {
    mountDirectory(OFFICE, [
      row({ id: "r1", name: "Dr Research One", faculty_type: "RESEARCH", threshold_set: true, threshold: 4 }),
      row({ id: "r2", name: "Dr Research Two", faculty_type: "RESEARCH", threshold_set: false }),
    ])
    expect(await screen.findByText("Threshold 4 a year")).toBeInTheDocument()
    const unset = screen.getByText("Threshold not set")
    expect(unset.closest("a")).toHaveAttribute("href", "/people/r2")
  })

  it("shows a head no incentives column and no missing panel", async () => {
    mountDirectory(HOD, [row({ incentive: undefined, faculty_type: "RESEARCH", threshold_set: true })], false)
    await screen.findByRole("list", { name: "Faculty" })
    expect(screen.queryByText("Incentives paid")).not.toBeInTheDocument()
    expect(screen.queryByText(/₹/)).not.toBeInTheDocument()
    expect(screen.queryByText("What is missing")).not.toBeInTheDocument()
    expect(screen.getByText("Threshold set")).toBeInTheDocument()
    expect(vi.mocked(api).mock.calls.some(([p]) => String(p).includes("/gaps"))).toBe(false)
  })

  it("gives a head a list of their own department without the department line or a claims column", async () => {
    mountDirectory(HOD, [row({ incentive: undefined })], false)
    const list = await screen.findByRole("list", { name: "Faculty" })
    const item = within(list).getByRole("listitem")
    expect(within(item).queryByText("EEE")).toBeNull()
    expect(screen.queryByText(/Claims in/)).toBeNull()
    expect(screen.queryByText(/claims filed and/)).toBeNull()
    expect(screen.getByText(/with their Scopus ID and papers/)).toBeInTheDocument()
    expect(screen.queryByRole("combobox", { name: "Filter by department" })).toBeNull()
  })

  it("sends faculty to their own record", async () => {
    mountDirectory(FACULTY, [])
    expect(await screen.findByText("My own record")).toBeInTheDocument()
  })

  it("answers at a glance, each figure a link to the list behind it, and says who fixes a gap", async () => {
    mountDirectory(OFFICE, [row({ missing: ["scopus"] })])
    const glance = await screen.findByRole("group", { name: "At a glance" })
    expect(within(glance).getByRole("link", { name: /1 Without a Scopus ID/ })).toHaveAttribute("href", "/faculty?missing=scopus")
    expect(within(glance).getByRole("link", { name: /2 With no paper in 2026/ })).toHaveAttribute("href", "/faculty?nopapers=1")
    // A person's gap is fixed on their account, with a link to it.
    expect(await screen.findByRole("link", { name: "Fix on the account" })).toHaveAttribute("href", "/people/f1")
    expect(screen.queryByText("What is missing")).not.toBeInTheDocument()
  })

  it("says what a missing filter means and asks only for current staff by default", async () => {
    mountDirectory(OFFICE, [row()], true, "/faculty?missing=photo")
    expect(await screen.findByTestId("missing-hint")).toHaveTextContent("Only they can add a photo")
    const calls = vi.mocked(api).mock.calls.map(([p]) => String(p))
    expect(calls.some((p) => p.includes("missing=photo"))).toBe(true)
    expect(calls.some((p) => p.includes("include_left"))).toBe(false)
  })
  it("says so plainly when there are no faculty", async () => {
    mountDirectory(OFFICE, [])
    expect(await screen.findByText("No faculty yet")).toBeInTheDocument()
  })
})

function record(over: Partial<FacultyRecordPayload> = {}): FacultyRecordPayload {
  const base = row()
  return {
    person: {
      id: "f1", name: base.name, initials: "KD", photo_url: null, department: "EEE", designation: "Professor",
      active: true, role: "FACULTY", staff_id: "TSEE001", faculty_type: "REGULAR", threshold_set: false,
      scopus_author_id: base.scopus_author_id, scopus_url: base.scopus_url, orcid_id: "0000-0002-1825-0097",
      orcid_url: "https://orcid.org/0000-0002-1825-0097", missing: ["photo"], employee_id: null,
      email: "k@example.edu", phone: null,
    },
    viewer: { is_self: false, money: true, may_edit: true, sees_everyone: true, year: 2026 },
    metrics: { total_publications: 2, total_citations: 9, h_index: 1, i10_index: 0, first_year: 2020, last_year: 2026, papers_this_year: 1 },
    papers: [
      {
        id: "p1", title: "A paid paper", year: 2026, date: "2026-02-01", venue: "J of Tests", type: "article", quartile: "Q1",
        citations: 3, doi: "10.1/x", scopus_indexed: true, author_position: 1, total_authors: 3, corresponding: null, topics: [],
        claim: { id: "c1", claim_no: "FP-2026-000001", stage: "Paid", review_path: "/review/c1", amount: 5162 }, eligible: true,
      },
      {
        id: "p2", title: "An unclaimed paper", year: 2020, date: null, venue: null, type: "article", quartile: null,
        citations: 0, doi: null, scopus_indexed: false, author_position: 2, total_authors: 9, corresponding: null, topics: [],
        claim: null, eligible: false,
      },
    ],
    claims: [
      { id: "c1", claim_no: "FP-2026-000001", title: "A paid paper", journal: "J of Tests", year: 2026, quartile: "Q1", author_position: 1,
        stage: "Paid", filed_on: "2026-03-01", review_path: "/review/c1", amount: 5162 },
    ],
    payments: { total_amount: 5162, this_year: { amount: 5162 }, count: 1, year: 2026, rows: [
      { id: "l1", claim_id: "c1", month: "2026-06", title: "A paid paper", journal: "J of Tests", amount: 5162, voucher: null },
    ] },
    research: { by_year: [{ year: 2026, papers: 1, citations: 3 }], quartiles: [{ name: "Q1", papers: 1 }], topics: [{ name: "Power", papers: 1 }],
      interests: [], coauthors_inside: [], coauthors_outside: [], scopus_profile: null },
    details: { bio: "Works on power electronics.", interests: [], skills: [], joined: "2026-09-23", changes_visible: true, changes: [] },
    ...over,
  }
}

function mountRecord(me: Me, data: FacultyRecordPayload | (() => never)) {
  vi.mocked(api).mockReset()
  vi.mocked(api).mockImplementation(
    fakeApi({
      "/api/auth/me": () => me,
      "/api/directory/faculty/f1": typeof data === "function" ? data : () => data,
    })
  )
  renderWithProviders(
    <Routes>
      <Route path="/faculty/:id" element={<FacultyRecord />} />
    </Routes>,
    { route: "/faculty/f1" }
  )
}

describe("the faculty record", () => {
  it("shows the identifiers, every paper with its claim state, and reviewers' links", async () => {
    mountRecord(OFFICE, record())
    expect(await screen.findByRole("heading", { name: "Dr K R Devabalaji" })).toBeInTheDocument()
    expect(screen.getByRole("link", { name: /Scopus author page/ })).toHaveAttribute("href", expect.stringContaining("57200597022"))
    expect(screen.getByRole("link", { name: /ORCID page/ })).toHaveAttribute("href", "https://orcid.org/0000-0002-1825-0097")
    expect(screen.getByText("k@example.edu")).toBeInTheDocument()
    const papers = screen.getByRole("list", { name: "Papers" })
    expect(within(papers).getByText("A paid paper")).toBeInTheDocument()
    expect(within(papers).getByText("₹5,162")).toBeInTheDocument()
    expect(within(papers).getByText("Too many authors to claim")).toBeInTheDocument()
    expect(within(papers).getByRole("link", { name: "FP-2026-000001" })).toHaveAttribute("href", "/review/c1")
    expect(screen.getByText(/This record is missing something/)).toBeInTheDocument()
  })

  it("opens the claims and payments tabs, and the details", async () => {
    mountRecord(OFFICE, record())
    const user = userEvent.setup()
    await screen.findByRole("heading", { name: "Dr K R Devabalaji" })
    await user.click(screen.getByRole("tab", { name: /Claims/ }))
    expect(within(screen.getByRole("list", { name: "Claims" })).getByRole("link", { name: /FP-2026-000001/ })).toHaveAttribute("href", "/review/c1")
    await user.click(screen.getByRole("tab", { name: "Payments" }))
    expect(screen.getByRole("list", { name: "Payments" })).toBeInTheDocument()
    await user.click(screen.getByRole("tab", { name: "Details" }))
    expect(screen.getByText("Works on power electronics.")).toBeInTheDocument()
  })

  it("has no payments tab and no rupee figure when the server sent no money", async () => {
    const d = record({ payments: null, viewer: { is_self: false, money: false, may_edit: false, sees_everyone: false, year: 2026 } })
    d.papers[0].claim = { id: "c1", claim_no: "FP-2026-000001", stage: "Completed", review_path: null }
    d.claims[0] = { ...d.claims[0], amount: undefined, stage: "Completed", review_path: null }
    mountRecord(HOD, d)
    await screen.findByRole("heading", { name: "Dr K R Devabalaji" })
    expect(screen.queryByRole("tab", { name: "Payments" })).not.toBeInTheDocument()
    expect(screen.queryByText(/₹/)).not.toBeInTheDocument()
    expect(screen.queryByText(/Incentives paid/)).not.toBeInTheDocument()
    expect(screen.queryByRole("link", { name: "Edit account" })).not.toBeInTheDocument()
  })

  it("shows the person their own record without repeating My papers, and names an old ERP claim plainly", async () => {
    const d = record({
      viewer: { is_self: true, money: true, may_edit: false, sees_everyone: false, year: 2026 },
    })
    d.claims[0] = { ...d.claims[0], claim_no: "ERP-RAW-3", review_path: null }
    mountRecord(FACULTY, d)
    await screen.findByRole("heading", { name: "Dr K R Devabalaji" })
    // The paper list, topics and details live on My papers, My research and Your profile.
    expect(screen.queryByRole("tab", { name: /Papers/ })).not.toBeInTheDocument()
    expect(screen.queryByRole("tab", { name: "Research" })).not.toBeInTheDocument()
    expect(screen.queryByRole("tab", { name: "Details" })).not.toBeInTheDocument()
    const glance = screen.getByRole("group", { name: "At a glance" })
    expect(within(glance).getByRole("link", { name: /Papers on record/ })).toHaveAttribute("href", "/papers")
    expect(within(glance).getByRole("link", { name: /Every paper is claimed/ })).toHaveAttribute("href", "/papers?tab=unclaimed")
    expect(screen.getByRole("link", { name: "Edit your profile" })).toHaveAttribute("href", "/me")
    // No "ERP-RAW-3" code on screen.
    expect(screen.getByText("Old ERP, RAW-3")).toBeInTheDocument()
    expect(screen.queryByText("ERP-RAW-3")).not.toBeInTheDocument()
  })

  it("explains a refusal instead of showing an empty record", async () => {
    const { ApiError } = await import("@/lib/api")
    mountRecord(FACULTY, () => {
      throw new ApiError(403, "no")
    })
    expect(await screen.findByText("This record is not open to you")).toBeInTheDocument()
  })
})
