import { screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { useLocation } from "react-router-dom"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return { ...actual, api: vi.fn() }
})

import type { Me } from "@/app/auth"
import { api } from "@/lib/api"
import { claimHref } from "@/pages/track-data"
import { AdminHub, MoneyHub } from "@/pages/hub"
import { Track } from "@/pages/track"
import { fakeApi, failing, HOD, FINANCE, renderWithProviders } from "@/test/harness"

function Where() {
  return <output data-testid="where">{useLocation().search}</output>
}

const CELL: Me = { id: "u-cell", email: "c@example.edu", name: "Research Office", role: "RESEARCH_CELL", department: null }
const SUPER: Me = { id: "u-admin", email: "a@example.edu", name: "Admin", role: "SUPER_ADMIN", department: null }

const AGEING = { week: 1, fortnight: 0, month: 0, older: 1 }
const STAGES = [
  { key: "submitted", label: "Submitted", caption: "Waiting for the research office to clear it", count: 2, amount: 90000, flagged: 1, oldest_days: 41, average_days: 20, ageing: AGEING },
  { key: "checked", label: "Being checked", caption: "With the Principal", count: 1, amount: 30000, flagged: 0, oldest_days: 3, average_days: 3, ageing: { week: 1, fortnight: 0, month: 0, older: 0 } },
  { key: "paid", label: "Paid", caption: "Paid out", count: 4, amount: 250000, flagged: 0, oldest_days: null, average_days: null, ageing: null },
  { key: "sent_back", label: "Sent back", caption: "With the claimant", count: 1, amount: 0, flagged: 0, oldest_days: 2, average_days: 2, ageing: { week: 1, fortnight: 0, month: 0, older: 0 } },
]

const ROW = {
  id: "c1",
  ticket_number: "FP-2026-000101",
  owner_id: "u-fac",
  owner_name: "Dr Meera Nair",
  owner_initials: "MN",
  owner_photo_url: null,
  owner_department: "CSE",
  paper_title: "Grain boundaries in thin copper films",
  journal_title: "Acta Materialia",
  quartile: "Q1",
  publication_year: 2026,
  stage: "submitted",
  stage_label: "Submitted",
  days_in_stage: 41,
  since: "2026-08-20T00:00:00Z",
  is_mine: false,
  amount: 45000,
  open_flags: 1,
  duplicate: false,
}

const requested: string[] = []

function mount(me: Me, ui: React.ReactElement, payload: Record<string, unknown> = {}, route = "/") {
  requested.length = 0
  vi.mocked(api).mockReset()
  vi.mocked(api).mockImplementation((path: string, ...rest: unknown[]) => {
    requested.push(path)
    return fakeApi({
      "/api/auth/me": () => me,
      "/api/track": () => ({
        scope: "college",
        department: null,
        sees_money: true,
        sees_flags: true,
        stages: STAGES,
        total_claims: 8,
        total: 1,
        limit: 25,
        offset: 0,
        departments: ["CSE", "ECE"],
        months: ["2026-09"],
        results: [ROW],
        ...payload,
      }),
      "/api/admin/data-fixes": () => ({
        claims_needing_a_fix: 3,
        total: 3,
        queues: [{ key: "paid_no_amount", label: "Paid with no amount", why: "", count: 3 }],
      }),
      "/api/claims/c1/why-amount": () => ({
        id: "c1",
        ticket_number: "FP-2026-000101",
        paper_title: "Grain boundaries in thin copper films",
        owner_name: "Dr Meera Nair",
        amount: 45000,
        amount_note: null,
        priced: true,
        message: null,
        policy: { name: "Policy v1", version: 1, in_force_now: true, effective_from: null },
        terms: [
          { label: "SNIP", detail: "0.8 x ₹55,000 = ₹44,000", amount: 44000 },
          { label: "Quartile incentive", detail: "Q1 adds ₹50,000", amount: 50000 },
        ],
        quota: null,
        note: null,
        threshold: null,
        ledger: [{ month: "2026-09", voucher: "V-7", amount: 45000, kind: "Payment" }],
        ledger_total: 45000,
      }),
      "/api/admin/readiness": () => ({ checked_at: "", ok: 1, total: 1, items: [] }),
      "/api/admin/hub": () => ({
        counts: {
          "/requests": { count: 3, tone: "caution", note: null },
          "/people": { count: null, tone: null, note: "420 active accounts" },
          "/faults": { count: 5, tone: "critical", note: "2 need attention now" },
        },
      }),
    })(path, ...(rest as []))
  })
  renderWithProviders(ui, { route })
}

describe("Track", () => {
  it("shows the stages as four figures that filter, with the sums where money may be seen", async () => {
    mount(CELL, <Track />)
    const glance = await screen.findByRole("group", { name: "At a glance" })
    expect(within(glance).getByRole("link", { name: /^2 Submitted, / })).toBeInTheDocument()
    expect(within(glance).getByRole("link", { name: "1 Being checked, ₹30,000" })).toBeInTheDocument()
    expect(screen.queryByText(/Also look at/)).toBeNull()
    expect(screen.queryByText(/on their way/)).toBeNull()
  })

  it("links each figure to its stage, keeping the filters and dropping the page", async () => {
    mount(CELL, <Track />, {}, "/track?q=copper&page=2")
    const glance = await screen.findByRole("group", { name: "At a glance" })
    const href = within(glance).getByRole("link", { name: /^1 Being checked/ }).getAttribute("href") ?? ""
    expect(href).toContain("stage=checked")
    expect(href).toContain("q=copper")
    expect(href).not.toContain("page=")
  })

  it("lists claims with number, claimant, stage and days, opening the review page", async () => {
    mount(CELL, <Track />)
    const link = await screen.findByRole("link", { name: /Grain boundaries/ })
    expect(link).toHaveAttribute("href", "/review/c1")
    expect(screen.getByText("FP-2026-000101")).toBeInTheDocument()
    expect(screen.getByText("Dr Meera Nair")).toBeInTheDocument()
    expect(screen.getByText("41 days")).toBeInTheDocument()
    expect(screen.getByText("Flag")).toBeInTheDocument()
  })

  it("asks the server for a stage when a figure is chosen", async () => {
    mount(CELL, <Track />)
    const glance = await screen.findByRole("group", { name: "At a glance" })
    within(glance).getByRole("link", { name: /^1 Being checked/ }).click()
    await screen.findByRole("combobox", { name: "Stage" })
    await vi.waitFor(() => expect(requested.some((p) => p.includes("stage=checked"))).toBe(true))
  })

  it("has an Export menu and a header sort that changes the URL", async () => {
    mount(CELL, <><Track /><Where /></>)
    await screen.findByRole("link", { name: /Grain boundaries/ })
    expect(screen.getByRole("button", { name: /export/i })).toBeInTheDocument()
    await userEvent.click(within(screen.getByRole("columnheader", { name: /Time in stage/ })).getByRole("button"))
    await vi.waitFor(() => expect(screen.getByTestId("where").textContent).toContain("sort=newest"))
  })

  it("shows a head no money and no flags, and says days since filing", async () => {
    mount(
      HOD,
      <Track />,
      {
        scope: "department",
        department: "CSE",
        sees_money: false,
        sees_flags: false,
        departments: [],
        stages: [
          { key: "review", label: "Under review", caption: "With the college", count: 2, oldest_days: 12, average_days: 9, ageing: AGEING },
          { key: "completed", label: "Completed", caption: "Finished", count: 4, oldest_days: null, average_days: null, ageing: null },
        ],
        results: [{ ...ROW, stage: "review", stage_label: "Under review", amount: undefined, open_flags: undefined, duplicate: undefined }],
      }
    )
    await screen.findByRole("link", { name: /Grain boundaries/ })
    expect(screen.queryByText(/₹/)).toBeNull()
    expect(screen.queryByText("Flag")).toBeNull()
    expect(screen.queryByRole("combobox", { name: "Department" })).toBeNull()
    expect(screen.getByText("Since filed")).toBeInTheDocument()
    expect(screen.getByRole("link", { name: /Grain boundaries/ })).toHaveAttribute("href", "/department/papers/c1")
  })

  it("shows a head the department's stages as figures, in words a head may have", async () => {
    mount(
      HOD,
      <Track />,
      {
        scope: "department", department: "CSE", sees_money: false, sees_flags: false, departments: [],
        stages: [
          { key: "review", label: "Under review", caption: "With the college", count: 3, oldest_days: 91, average_days: 86, ageing: AGEING },
          { key: "approved", label: "Approved", caption: "Payment in progress", count: 1, oldest_days: null, average_days: null, ageing: null },
          { key: "completed", label: "Completed", caption: "Finished", count: 16, oldest_days: null, average_days: null, ageing: null },
        ],
        results: [
          { ...ROW, stage: "completed", stage_label: "Completed", ticket_number: "ERP-PROCESSED-10", amount: undefined, days_in_stage: 7 },
        ],
      }
    )
    const glance = await screen.findByRole("group", { name: "At a glance" })
    expect(within(glance).getByRole("link", { name: "3 Under review" })).toBeInTheDocument()
    expect(within(glance).getByRole("link", { name: "16 Completed" })).toBeInTheDocument()
    expect(document.body.textContent).not.toMatch(/principal|director|finance|research office|₹/i)
    // A finished claim reads "Complete", not the days since an import.
    expect(screen.queryByText("7 days")).toBeNull()
    expect(screen.getByText("Complete", { selector: "span" })).toBeInTheDocument()
  })

  it("does not pass a failed request off as an empty college", async () => {
    mount(CELL, <Track />)
    vi.mocked(api).mockReset()
    vi.mocked(api).mockImplementation(fakeApi({ "/api/auth/me": () => CELL, "/api/track": failing() }) as never)
    renderWithProviders(<Track />)
    expect(await screen.findByText("Could not load the claims")).toBeInTheDocument()
  })
})

describe("Track, for the office", () => {
  const PAID_NO_AMOUNT = {
    ...ROW,
    id: "c2",
    ticket_number: "ERP-PROCESSED-60",
    stage: "paid",
    stage_label: "Paid",
    paper_title: "-",
    journal_title: "-",
    quartile: "-",
    publication_year: null,
    owner_name: "Not Found",
    owner_department: "Not Found",
    amount: null,
    amount_note: "Not recorded",
    paid_on: "2026-09-01",
    paid_month_only: true,
    days_in_stage: 6,
    fixes: ["Amount not recorded", "No title"],
  }
  const COUNTED = { ...PAID_NO_AMOUNT, id: "c3", ticket_number: "ERP-PROCESSED-10", amount_note: "₹0", amount_reason: "counted only", fixes: [], paper_title: "A real title" }

  it("says why an amount is empty, when it was paid, and never draws a lone dash", async () => {
    mount(CELL, <Track />, { results: [PAID_NO_AMOUNT, COUNTED] })
    await screen.findByText("Title not recorded")
    expect(screen.getByText("Not recorded")).toBeInTheDocument()
    expect(screen.getByText("₹0")).toBeInTheDocument()
    expect(screen.getByText("counted only")).toBeInTheDocument()
    expect(screen.getAllByText("Paid Sep 2026")).toHaveLength(2)
    expect(screen.queryByText("Untitled")).toBeNull()
    expect(screen.getAllByText("Journal not recorded")).toHaveLength(2)
    expect(screen.getAllByText("Claimant not identified")).toHaveLength(2)
    // No "6 days" on a paid row.
    expect(screen.queryByText("6 days")).toBeNull()
  })

  it("names every column", async () => {
    mount(CELL, <Track />, { results: [PAID_NO_AMOUNT] })
    await screen.findByText("Title not recorded")
    for (const h of ["Claim no.", "Claimant", "Paper", "Where it stands", "Time in stage", "Amount"]) {
      expect(screen.getAllByText(h).length).toBeGreaterThan(0)
    }
    expect(screen.getByText("Needs fixing")).toBeInTheDocument()
  })

  it("offers the data-fix list from Track, and filters to it", async () => {
    mount(CELL, <Track />)
    const line = await screen.findByTestId("track-fixes")
    expect(line).toHaveTextContent("3 claims from the old ERP need fixing")
    expect(within(line).getByRole("link", { name: "Show them here" })).toHaveAttribute("href", "/track?fix=1")
    expect(within(line).getByRole("link", { name: "Open the fix list" })).toHaveAttribute("href", "/data/fixes")
  })

  it("opens Why this amount with the policy, the terms and the ledger", async () => {
    mount(CELL, <Track />, {}, "/?why=c1")
    expect(await screen.findByText("Why this amount", { selector: "h2" })).toBeInTheDocument()
    expect(await screen.findByText("Priced under Policy v1, the policy in force now.")).toBeInTheDocument()
    expect(screen.getByText("0.8 x ₹55,000 = ₹44,000")).toBeInTheDocument()
    expect(screen.getByText("V-7")).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "Open the claim" })).toHaveAttribute("href", "/review/c1")
  })

  it("does not offer the explainer, or the fix list, to a head of department", async () => {
    mount(HOD, <Track />, { scope: "department", sees_money: false, sees_flags: false, departments: [], results: [{ ...ROW, amount: undefined }] })
    await screen.findByRole("link", { name: /Grain boundaries/ })
    expect(screen.queryByText("Why this amount")).toBeNull()
    expect(screen.queryByTestId("track-fixes")).toBeNull()
  })
})

describe("where a claim opens", () => {
  it("sends each seat to the page it can use, and your own claim to the claim page", () => {
    const row = { id: "x", is_mine: false }
    expect(claimHref("RESEARCH_CELL", row)).toBe("/review/x")
    expect(claimHref("PRINCIPAL", row)).toBe("/review/x")
    expect(claimHref("SUPER_ADMIN", row)).toBe("/review/x")
    expect(claimHref("DIRECTOR", row)).toBe("/papers/x")
    expect(claimHref("FINANCE", row)).toBe("/papers/x")
    expect(claimHref("HOD", row)).toBe("/department/papers/x")
    expect(claimHref("PRINCIPAL", { id: "x", is_mine: true })).toBe("/papers/x")
  })
})

describe("the Admin hub", () => {
  it("lists every page in one table, grouped by kind of work, with what needs attention", async () => {
    mount(SUPER, <AdminHub />)
    // The four groups are the "Kind of work" filter's choices, and a column of the table.
    const kind = await screen.findByRole("combobox", { name: "Kind of work" })
    for (const title of ["People and roles", "Data", "Money", "System"]) {
      expect(within(kind).getByRole("option", { name: title })).toBeInTheDocument()
    }
    const faults = screen.getByRole("link", { name: /Faults/ })
    // The purpose is now its own column in the table, beside the page it describes.
    expect(faults).toBeInTheDocument()
    expect(screen.getAllByText(/cannot reconcile/).length).toBeGreaterThan(0)
    expect(await screen.findByLabelText("5 need attention")).toBeInTheDocument()
    expect(screen.getAllByText(/420 active accounts/).length).toBeGreaterThan(0)
  })

  it("is not open to a Finance officer", async () => {
    mount(FINANCE, <AdminHub />)
    expect(await screen.findByText("Not open to this account")).toBeInTheDocument()
  })

  it("gives Finance the Money hub, with no admin counts asked for", async () => {
    mount(FINANCE, <MoneyHub />)
    expect(await screen.findByRole("link", { name: /Ledger/ })).toBeInTheDocument()
    expect(requested).not.toContain("/api/admin/hub")
  })
})
