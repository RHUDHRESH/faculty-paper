import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { Route, Routes } from "react-router-dom"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return { ...actual, api: vi.fn() }
})

import type { Me } from "@/app/auth"
import { api } from "@/lib/api"
import { People, Person } from "@/pages/people"
import { fakeApi, renderWithProviders, type ApiTable } from "@/test/harness"

/**
 * Per person the office records three things (the college's rule of
 * 2026-09-23): the role, with a head of department shown as a faculty member
 * who still files papers; whether they are research faculty, with the quota
 * when they are; and that a department has exactly one head.
 */

const SUPER_ADMIN: Me = {
  id: "u-admin",
  email: "admin@example.edu",
  name: "Office Admin",
  role: "SUPER_ADMIN",
  department: null,
}

const CELL: Me = { ...SUPER_ADMIN, id: "u-cell", role: "RESEARCH_CELL", name: "Research Cell" }
const COORDINATOR: Me = {
  ...SUPER_ADMIN,
  id: "u-coord",
  role: "RESEARCH_COORDINATOR",
  name: "Research Coordinator",
}

function account(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: "u-2",
    email: "asha@example.edu",
    name: "Dr Asha Menon",
    role: "FACULTY",
    department: "CSE",
    designation: "Associate Professor",
    staff_id: "STF-2",
    biometric_id: null,
    scopus_author_url: "",
    scopus_author_id: null,
    employee_id: null,
    must_change_password: false,
    active: true,
    faculty_type: "REGULAR",
    stats: { claims: 0, paid_claims: 0, drafts: 0, in_review: 0, last_claim_at: null },
    ...over,
  }
}

const REPORT = {
  faculty: account(),
  totals: { publications: 0, paid_claims: 0, paid_amount: 0, in_review: 0 },
  by_month: [],
  by_quartile: [],
  by_status: [],
  by_year: [],
  by_journal: [],
  by_type: [],
  by_position: [],
  claims: [],
}

const CURRENT_HEAD = {
  id: "u-9",
  email: "head.cse@example.edu",
  name: "Dr Current Head",
  role: "HOD",
  department: "CSE",
  designation: "Professor and Head",
  active: true,
  faculty_type: "REGULAR",
}

function directory(path: string) {
  const q = new URLSearchParams(path.split("?")[1] ?? "")
  if (q.get("role") === "HOD" && q.get("department") === "CSE") {
    return { total: 1, limit: 5, offset: 0, results: [CURRENT_HEAD] }
  }
  return { total: 0, limit: 5, offset: 0, results: [] }
}

function mountPerson(me: Me, detail = account(), extra: ApiTable = {}) {
  vi.mocked(api).mockReset()
  vi.mocked(api).mockImplementation(
    fakeApi({
      "/api/auth/me": () => me,
      "/api/faculty/u-2/report": () => REPORT,
      "/api/admin/users/u-2": () => detail,
      "/api/admin/users?": directory,
      "/api/meta/departments": () => ["CSE", "ECE"],
      ...extra,
    })
  )
  renderWithProviders(
    <Routes>
      <Route path="/people/:id" element={<Person />} />
    </Routes>,
    { route: "/people/u-2" }
  )
}

function patches() {
  return vi
    .mocked(api)
    .mock.calls.filter(
      ([p, options]) =>
        p === "/api/admin/users/u-2" && (options as { method?: string } | undefined)?.method === "PATCH"
    )
    .map(([, options]) => (options as { json: Record<string, unknown> }).json)
}

async function openEditor() {
  const user = userEvent.setup()
  const dialog = await screen.findByRole("form", { name: "Account" })
  await within(dialog).findByText("Role and department")
  return { user, dialog }
}

/** Role changes and deactivation ask again, with the same verb. */
async function confirmWith(user: ReturnType<typeof userEvent.setup>, verb: string) {
  const confirm = await screen.findByRole("dialog")
  await user.click(within(confirm).getByRole("button", { name: verb }))
}

async function pick(
  user: ReturnType<typeof userEvent.setup>,
  dialog: HTMLElement,
  label: string,
  option: string
) {
  await user.click(within(dialog).getByLabelText(label))
  await user.click(within(dialog).getByRole("option", { name: option }))
}

describe("AccountEditor — the role", () => {
  it("names a head as a faculty member who still files papers", async () => {
    mountPerson(SUPER_ADMIN)
    const { user, dialog } = await openEditor()
    await user.click(within(dialog).getByLabelText("Role"))
    expect(
      within(dialog).getByRole("option", { name: "Head of department (still files papers)" })
    ).toBeInTheDocument()
  })

  it("asks before replacing the head a department already has, and sends the replace flag", async () => {
    mountPerson(SUPER_ADMIN)
    const { user, dialog } = await openEditor()
    await pick(user, dialog, "Role", "Head of department (still files papers)")

    expect(
      await within(dialog).findByText("Dr Current Head is HOD of CSE. Replace them?")
    ).toBeInTheDocument()
    const save = within(dialog).getByRole("button", { name: "Save changes" })
    expect(save).toBeDisabled()

    await user.click(within(dialog).getByRole("checkbox", { name: /Replace Dr Current Head/ }))
    expect(save).toBeEnabled()
    await user.click(save)
    await confirmWith(user, "Change role")

    await waitFor(() => expect(patches()).toHaveLength(1))
    expect(patches()[0]).toEqual({ role: "HOD", replace_hod: true })
  })

  it("says nothing about replacing when the department has no head", async () => {
    mountPerson(SUPER_ADMIN, account({ department: "ECE" }))
    const { user, dialog } = await openEditor()
    await pick(user, dialog, "Role", "Head of department (still files papers)")
    await user.click(within(dialog).getByRole("button", { name: "Save changes" }))
    await confirmWith(user, "Change role")

    await waitFor(() => expect(patches()).toHaveLength(1))
    expect(patches()[0]).toEqual({ role: "HOD" })
    expect(within(dialog).queryByText(/Replace them\?/)).toBeNull()
  })

  it("lets the research cell appoint a head without sending the quota it may not touch", async () => {
    // The quota is super-admin-only on the server, which refuses the whole
    // request if the field is present -- even unchanged. An empty quota must
    // compare equal to an empty quota.
    mountPerson(CELL, account({ department: "ECE" }))
    const { user, dialog } = await openEditor()
    await pick(user, dialog, "Role", "Head of department (still files papers)")
    await user.click(within(dialog).getByRole("button", { name: "Save changes" }))
    await confirmWith(user, "Change role")

    await waitFor(() => expect(patches()).toHaveLength(1))
    expect(patches()[0]).toEqual({ role: "HOD" })
  })

  it("refuses a head of no department before the server has to", async () => {
    mountPerson(SUPER_ADMIN, account({ department: "" }))
    const { user, dialog } = await openEditor()
    await pick(user, dialog, "Role", "Head of department (still files papers)")
    expect(await within(dialog).findByText(/A head needs a department/)).toBeInTheDocument()
    expect(within(dialog).getByRole("button", { name: "Save changes" })).toBeDisabled()
  })
})

describe("AccountEditor — who may appoint what", () => {
  it("offers the office no role that decides whether money moves", async () => {
    mountPerson(CELL)
    const { user, dialog } = await openEditor()
    await user.click(within(dialog).getByLabelText("Role"))
    expect(screen.queryByRole("option", { name: "Finance" })).toBeNull()
    expect(screen.queryByRole("option", { name: "Super admin" })).toBeNull()
    expect(screen.getByRole("option", { name: "Research coordinator" })).toBeInTheDocument()
  })

  it("offers a super admin every role", async () => {
    mountPerson(SUPER_ADMIN)
    const { user, dialog } = await openEditor()
    await user.click(within(dialog).getByLabelText("Role"))
    expect(screen.getByRole("option", { name: "Finance" })).toBeInTheDocument()
  })
})

describe("AccountEditor — switching a head off", () => {
  it("is never held up by the one-head rule: an account switched off holds no post", async () => {
    mountPerson(SUPER_ADMIN, account({ role: "HOD", department: "" }))
    const { user, dialog } = await openEditor()
    await user.click(within(dialog).getByRole("checkbox", { name: /Active/ }))
    const save = within(dialog).getByRole("button", { name: "Save changes" })
    expect(within(dialog).queryByText(/A head needs a department/)).toBeNull()
    expect(save).toBeEnabled()
    await user.click(save)
    await confirmWith(user, "Deactivate")
    await waitFor(() => expect(patches()).toHaveLength(1))
    expect(patches()[0]).toEqual({ active: false })
  })
})

describe("AccountEditor — research faculty", () => {
  it("is one tick box, and the rupee threshold is set once it is saved", async () => {
    mountPerson(SUPER_ADMIN)
    const { user, dialog } = await openEditor()
    const tick = within(dialog).getByRole("checkbox", { name: /Research faculty/ })
    expect(tick).not.toBeChecked()
    expect(within(dialog).queryByLabelText(/Papers a year/)).toBeNull()

    await user.click(tick)
    // The old papers-a-year quota is gone from the form.
    expect(within(dialog).queryByLabelText(/Papers a year/)).toBeNull()
    await user.click(within(dialog).getByRole("button", { name: "Save changes" }))

    await waitFor(() => expect(patches()).toHaveLength(1))
    expect(patches()[0]).toEqual({ faculty_type: "RESEARCH" })
  })

  it("is the research coordinator's to set, without opening the rest of who they are", async () => {
    mountPerson(COORDINATOR)
    const { user, dialog } = await openEditor()
    const tick = within(dialog).getByRole("checkbox", { name: /Research faculty/ })
    expect(tick).toBeEnabled()
    expect(within(dialog).getByLabelText("Full name")).toBeDisabled()

    await user.click(tick)
    await user.click(within(dialog).getByRole("button", { name: "Save changes" }))

    await waitFor(() => expect(patches()).toHaveLength(1))
    expect(patches()[0]).toEqual({ faculty_type: "RESEARCH" })
  })

  it("shows the coordinator the threshold of somebody who is research faculty", async () => {
    mountPerson(COORDINATOR, account({ faculty_type: "RESEARCH" }), {
      "/api/research-faculty/u-2/threshold": () => ({
        research: true,
        threshold: 300000,
        unset: false,
        year: "2026-27",
        used: 120000,
        left: 180000,
        on_the_way: 0,
        on_the_way_above: 0,
        history: [],
      }),
    })
    const { dialog } = await openEditor()
    expect(await within(dialog).findByText("₹3,00,000")).toBeInTheDocument()
    expect(within(dialog).getByText(/₹1,20,000 used in 2026-27, ₹1,80,000 left/)).toBeInTheDocument()
    expect(within(dialog).getByRole("button", { name: /Change threshold/ })).toBeInTheDocument()
  })

  it("warns that a threshold is not set, and says the person is paid as regular faculty", async () => {
    mountPerson(SUPER_ADMIN, account({ faculty_type: "RESEARCH" }), {
      "/api/research-faculty/u-2/threshold": () => ({
        research: true,
        threshold: null,
        unset: true,
        year: "2026-27",
        used: 0,
        left: null,
        on_the_way: 0,
        on_the_way_above: 0,
        old_quota: 4,
        needs_rupee_threshold: true,
        history: [],
      }),
    })
    const { dialog } = await openEditor()
    expect(await within(dialog).findByText("Threshold not set")).toBeInTheDocument()
    expect(within(dialog).getByText(/paid as regular faculty/)).toBeInTheDocument()
    expect(within(dialog).getByText(/old rule of 4 papers a year/)).toBeInTheDocument()
  })

  it("stays closed to the research cell, which clears the claims the threshold decides", async () => {
    mountPerson(CELL, account({ faculty_type: "RESEARCH" }))
    const { dialog } = await openEditor()
    expect(within(dialog).getByRole("checkbox", { name: /Research faculty/ })).toBeDisabled()
    expect(within(dialog).queryByRole("button", { name: /threshold/i })).toBeNull()
  })
})

describe("NewAccount — one head per department", () => {
  it("asks before replacing the head, and sends the replace flag with the new account", async () => {
    const user = userEvent.setup()
    vi.mocked(api).mockReset()
    vi.mocked(api).mockImplementation(
      fakeApi({
        "/api/auth/me": () => SUPER_ADMIN,
        "/api/admin/users?": directory,
        "/api/admin/users": () => ({ id: "u-new", email: "new@example.edu", needs_password: true }),
        "/api/meta/departments": () => ["CSE", "ECE"],
      })
    )
    renderWithProviders(<People />, { route: "/people" })

    await user.click(await screen.findByRole("button", { name: /New account/ }))
    const dialog = await screen.findByRole("dialog")
    await user.type(within(dialog).getByLabelText("Email"), "new@example.edu")
    await user.type(within(dialog).getByLabelText("Full name"), "Dr New Head")
    await pick(user, dialog, "Role", "Head of department (still files papers)")
    await pick(user, dialog, "Department", "CSE")

    expect(
      await within(dialog).findByText("Dr Current Head is HOD of CSE. Replace them?")
    ).toBeInTheDocument()
    const create = within(dialog).getByRole("button", { name: "Create the account" })
    expect(create).toBeDisabled()
    await user.click(within(dialog).getByRole("checkbox", { name: /Replace Dr Current Head/ }))
    await user.click(create)

    await waitFor(() =>
      expect(
        vi.mocked(api).mock.calls.filter(
          ([p, o]) => p === "/api/admin/users" && (o as { method?: string })?.method === "POST"
        )
      ).toHaveLength(1)
    )
    const [, options] = vi
      .mocked(api)
      .mock.calls.find(([p, o]) => p === "/api/admin/users" && (o as { method?: string })?.method === "POST")!
    expect((options as { json: Record<string, unknown> }).json).toMatchObject({
      role: "HOD",
      department: "CSE",
      replace_hod: true,
    })
  })
})

describe("Person — filing on somebody's behalf", () => {
  it("offers to file for a head, who is a claimant like any faculty member", async () => {
    mountPerson(SUPER_ADMIN, account({ role: "HOD" }), {
      "/api/faculty/u-2/report": () => ({ ...REPORT, faculty: account({ role: "HOD" }) }),
    })
    expect(await screen.findByRole("link", { name: /File a paper for them/ })).toHaveAttribute(
      "href",
      "/papers/new?for=u-2"
    )
  })
})

describe("People — the list", () => {
  function mountList(rows: Record<string, unknown>[]) {
    vi.mocked(api).mockReset()
    vi.mocked(api).mockImplementation(
      fakeApi({
        "/api/auth/me": () => SUPER_ADMIN,
        "/api/admin/users?": () => ({ total: rows.length, limit: 20, offset: 0, results: rows }),
        "/api/meta/departments": () => ["CSE"],
      })
    )
    renderWithProviders(<People />, { route: "/people" })
  }

  it("badges the head and research faculty", async () => {
    mountList([
      { ...CURRENT_HEAD, faculty_type: "RESEARCH" },
      { ...account(), id: "u-3", name: "Dr Plain Faculty" },
    ])
    const headRow = (await screen.findByText("Dr Current Head")).closest("tr")!
    expect(within(headRow).getByText("HOD")).toBeInTheDocument()
    expect(within(headRow).getByText("Research")).toBeInTheDocument()
    const plainRow = screen.getByText("Dr Plain Faculty").closest("tr")!
    expect(within(plainRow).queryByText("HOD")).toBeNull()
    expect(within(plainRow).queryByText("Research")).toBeNull()
  })

  it("shows each research faculty member's threshold beside the badge", async () => {
    mountList([
      { ...account(), id: "u-4", name: "Dr Threshold Three", faculty_type: "RESEARCH", research_threshold: 300000 },
      { ...account(), id: "u-5", name: "Dr Not Set", faculty_type: "RESEARCH", research_threshold: null },
      { ...account(), id: "u-7", name: "Dr Old Rule", faculty_type: "RESEARCH", research_threshold: null, old_quota_only: true },
      { ...account(), id: "u-6", name: "Dr Regular", faculty_type: "REGULAR", research_threshold: null },
    ])
    const three = (await screen.findByText("Dr Threshold Three")).closest("tr")!
    expect(within(three).getByText("Threshold ₹3,00,000 a year")).toBeInTheDocument()
    const none = screen.getByText("Dr Not Set").closest("tr")!
    expect(within(none).getByText("Threshold not set")).toBeInTheDocument()
    const old = screen.getByText("Dr Old Rule").closest("tr")!
    expect(within(old).getByText("Old rule, please set a rupee threshold")).toBeInTheDocument()
    // A regular post has no threshold to show.
    const regular = screen.getByText("Dr Regular").closest("tr")!
    expect(within(regular).queryByText(/Threshold/)).toBeNull()
  })

  it("filters to research faculty on the server", async () => {
    const user = userEvent.setup()
    mountList([])
    await user.click(await screen.findByLabelText("Filter by research faculty"))
    await user.click(screen.getByRole("option", { name: "Research faculty" }))
    await waitFor(() =>
      expect(
        vi
          .mocked(api)
          .mock.calls.some(([p]) => String(p).includes("faculty_type=RESEARCH"))
      ).toBe(true)
    )
  })
})

/* ------------------------------------------------------------------------ */
/* What Scopus holds for the person                                          */
/* ------------------------------------------------------------------------ */

const SCOPUS_PROFILE = {
  scopus_id: "57983494200",
  url: "https://www.scopus.com/authid/detail.uri?authorId=57983494200",
  author_name: null,
  affiliation: null,
  publications: 26,
  citations: 166,
  h_index: 8,
  publications_by_year: {},
  documents_listed: 26,
  source_sheet: "Mr. S. Joyal Isac",
  imported_at: "2026-09-23T08:00:00Z",
}

function mountRecord(scopus_profile: unknown) {
  vi.mocked(api).mockImplementation(
    fakeApi({
      "/api/auth/me": () => CELL,
      "/api/faculty/u-2/report": () => ({ ...REPORT, scopus_profile }),
    })
  )
  return renderWithProviders(
    <Routes>
      <Route path="/people/:id" element={<Person />} />
    </Routes>,
    { route: "/people/u-2" }
  )
}

describe("a person's record, seen by the office, carries their Scopus profile", () => {
  it("shows their Scopus figures and links the id to Scopus", async () => {
    mountRecord(SCOPUS_PROFILE)
    const region = await screen.findByRole("region", { name: /scopus profile/i })
    expect(within(region).getByRole("link", { name: /57983494200/ })).toHaveAttribute(
      "href",
      SCOPUS_PROFILE.url
    )
    expect(within(region).getByText("166")).toBeInTheDocument()
  })

  it("says when no profile has been imported", async () => {
    mountRecord(null)
    const region = await screen.findByRole("region", { name: /scopus profile/i })
    expect(within(region).getByText(/no scopus profile has been imported/i)).toBeInTheDocument()
  })
})

describe("People — the answer first", () => {
  it("says the roster in one line and raises only a desk with nobody on it", async () => {
    vi.mocked(api).mockReset()
    vi.mocked(api).mockImplementation(
      fakeApi({
        "/api/auth/me": () => SUPER_ADMIN,
        "/api/admin/users?": () => ({
          total: 1, limit: 20, offset: 0, results: [account()],
          counts: { active: 413, left: 1, research: 0, desks_empty: 2 },
        }),
        "/api/meta/departments": () => ["CSE"],
      })
    )
    renderWithProviders(<People />, { route: "/people" })
    const glance = await screen.findByRole("group", { name: "At a glance" })
    expect(await within(glance).findByRole("link", { name: /2 Desks with nobody on them/ })).toHaveAttribute("href", "/admin")
    expect(within(glance).getAllByRole("link")).toHaveLength(1)
    expect(screen.getByText("413 active, 1 has left.")).toBeInTheDocument()
  })

  it("shows no figures at all when every desk has a person", async () => {
    vi.mocked(api).mockReset()
    vi.mocked(api).mockImplementation(
      fakeApi({
        "/api/auth/me": () => SUPER_ADMIN,
        "/api/admin/users?": () => ({
          total: 1, limit: 20, offset: 0, results: [account()],
          counts: { active: 417, left: 0, research: 0, desks_empty: 0 },
        }),
        "/api/meta/departments": () => ["CSE"],
      })
    )
    renderWithProviders(<People />, { route: "/people" })
    expect(await screen.findByText("417 active, nobody has left.")).toBeInTheDocument()
    expect(screen.queryByRole("group", { name: "At a glance" })).toBeNull()
  })

  it("asks the server for leavers only when the status is chosen", async () => {
    vi.mocked(api).mockReset()
    vi.mocked(api).mockImplementation(
      fakeApi({
        "/api/auth/me": () => SUPER_ADMIN,
        "/api/admin/users?": () => ({ total: 0, limit: 20, offset: 0, results: [] }),
        "/api/meta/departments": () => ["CSE"],
      })
    )
    renderWithProviders(<People />, { route: "/people?status=inactive" })
    await screen.findByText("Nobody matches")
    expect(vi.mocked(api).mock.calls.some(([p]) => String(p).includes("active=false"))).toBe(true)
  })
})

describe("Person — the office reads the record where it is kept", () => {
  it("shows the record's own counts with a link to it, not the claim-only zeros", async () => {
    mountPerson(SUPER_ADMIN, account(), {
      "/api/directory/faculty/u-2": () => ({
        person: account(),
        viewer: { year: 2026, money: true, may_edit: true, sees_everyone: true, is_self: false },
        metrics: { total_publications: 62, total_citations: 287, h_index: 8, i10_index: 7, papers_this_year: 20 },
        claims: [],
        papers: [],
        payments: null,
      }),
    })
    const region = await screen.findByRole("region", { name: "Their record" })
    expect(await within(region).findByRole("link", { name: /62 Papers on record/ })).toHaveAttribute("href", "/faculty/u-2")
    expect(within(region).getByRole("link", { name: "Open the full record" })).toHaveAttribute("href", "/faculty/u-2")
    expect(screen.queryByText("Publications over time")).toBeNull()
  })
})