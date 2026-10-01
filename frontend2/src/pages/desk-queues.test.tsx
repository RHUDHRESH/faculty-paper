import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { Route, Routes, useLocation } from "react-router-dom"
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return { ...actual, api: vi.fn() }
})

import { api } from "@/lib/api"
import type { Me } from "@/app/auth"
import { Approvals } from "@/pages/approvals"
import { Authorisations } from "@/pages/authorisations"
import { Clearing } from "@/pages/clearing"
import { renderWithProviders } from "@/test/harness"

/**
 * The three desk queues share one dense table, one bulk vocabulary and one
 * way of remembering filters. What is asserted here is what a reviewer
 * relies on: the columns, the amber and red waiting days, that a row opens
 * the full-page review and not a side sheet, that a filter survives in the
 * address, that "ready" batches leave out exactly what is not ready, and that
 * bulk send back does not exist.
 */

const cell: Me = { id: "u-cell", email: "cell@example.edu", name: "R Cell", role: "RESEARCH_CELL", department: null }
const principal: Me = { id: "u-prin", email: "prin@example.edu", name: "K Principal", role: "PRINCIPAL", department: null }
const director: Me = { id: "u-dir", email: "dir@example.edu", name: "V Director", role: "DIRECTOR", department: null }

type Call = { path: string; method: string; body: unknown }
const calls: Call[] = []

function serve(me: Me, table: Record<string, unknown | (() => unknown)>) {
  calls.length = 0
  vi.mocked(api).mockImplementation((async (path: string, opts?: { method?: string; json?: unknown }) => {
    calls.push({ path, method: opts?.method ?? "GET", body: opts?.json })
    if (path.startsWith("/api/auth/me")) return me
    const key = Object.keys(table)
      .sort((a, b) => b.length - a.length)
      .find((k) => path.startsWith(k))
    if (!key) throw new Error(`No handler in this test for ${path}`)
    const v = table[key]
    return typeof v === "function" ? (v as () => unknown)() : v
  }) as unknown as typeof api)
}

const posted = (path: string) => calls.filter((c) => c.method === "POST" && c.path === path)

/** Puts the current address on screen so a test can read what the page wrote to it. */
function Where() {
  const l = useLocation()
  return <output data-testid="where">{l.pathname + l.search}</output>
}

function at(el: React.ReactElement, path: string) {
  return (
    <>
      <Routes>
        <Route path={path} element={el} />
        <Route path="/review/:id" element={<p>The review workspace</p>} />
      </Routes>
      <Where />
    </>
  )
}

const where = () => screen.getByTestId("where").textContent

/* ------------------------------------------------------------------------ */
/* Clearing                                                                  */
/* ------------------------------------------------------------------------ */

function clearingClaim(over: Record<string, unknown> = {}) {
  return {
    id: "c1",
    ticket_number: "FP-2026-000001",
    paper_title: "Fuzzy control of a grid",
    journal_title: "Nature",
    quartile: "Q1",
    owner_name: "Asha Faculty",
    owner_department: "ECE",
    remuneration: 52_377.5,
    remuneration_is_estimate: false,
    waiting_days: 3,
    verification_ok: true,
    duplicate_warning: false,
    contest_forward: false,
    calc_error: null,
    affiliation_ok: true,
    journal_watch: null,
    quota_applied: false,
    on_hold: false,
    status: "SUBMITTED",
    publication_year: 2026,
    ...over,
  }
}

const QUEUE = [
  clearingClaim({ id: "c1", ticket_number: "FP-2026-000001", waiting_days: 40 }),
  clearingClaim({ id: "c2", ticket_number: "FP-2026-000002", waiting_days: 20, owner_name: "Ravi Other", owner_department: "CSE", remuneration: 10_000 }),
  clearingClaim({ id: "c3", ticket_number: "FP-2026-000003", waiting_days: 5, journal_watch: { id: "w", reason: "Cloned title", title: "Nature" } }),
  clearingClaim({ id: "c4", ticket_number: "ERP-PROCESSED-120", waiting_days: 2, verification_ok: false, duplicate_warning: true }),
]

async function openClearing(route = "/clearing") {
  serve(cell, {
    "/api/admin/clearing-queue": QUEUE,
    "/api/admin/clearing-report": { received: 0, cleared: 0, sent_back: 0, rejected: 0, waiting_now: 4, by_person: [], ageing: [] },
    "/api/admin/bulk-clear": { cleared: 2, skipped: [] },
    "/api/desk/bulk-hold": { held: 2, held_ids: ["c1", "c2"], skipped: [] },
  })
  const view = renderWithProviders(at(<Clearing />, "/clearing"), { route })
  await screen.findByRole("table", { name: "Claims waiting to be cleared" })
  return view
}

const table = () => screen.getByRole("table", { name: "Claims waiting to be cleared" })

describe("the clearing queue", () => {
  beforeEach(() => vi.clearAllMocks())

  it("shows claim no., claimant, paper, journal with quartile, waiting days, amount and flags", async () => {
    await openClearing()
    const t = within(table())
    for (const h of ["Claim no.", "Claimant", "Paper", "Journal", "Waiting", "Amount", "Flags"]) {
      expect(t.getByRole("columnheader", { name: h })).toBeInTheDocument()
    }
    const row = t.getByText("FP-2026-000001").closest("tr") as HTMLElement
    expect(within(row).getByRole("button", { name: /copy claim no\. FP-2026-000001/i })).toBeInTheDocument()
    expect(within(row).getByText("Asha Faculty")).toBeInTheDocument()
    expect(within(row).getByText("Fuzzy control of a grid")).toBeInTheDocument()
    expect(within(row).getByText("Nature")).toBeInTheDocument()
    expect(within(row).getByText("Q1")).toBeInTheDocument()
    expect(within(row).getByText("₹52,377.50")).toBeInTheDocument()
    const dup = t.getByText("ERP-PROCESSED-120").closest("tr") as HTMLElement
    expect(within(dup).getByText(/Possible duplicate/)).toBeInTheDocument()
    expect(within(dup).getByText("Checks failed")).toBeInTheDocument()
  })

  it("turns waiting days amber after two weeks and red after a month", async () => {
    await openClearing()
    const t = within(table())
    expect(t.getByText("40 days")).toHaveClass("text-critical")
    expect(t.getByText("20 days")).toHaveClass("text-caution")
    const quiet = t.getByText("5 days")
    expect(quiet).not.toHaveClass("text-caution")
    expect(quiet).not.toHaveClass("text-critical")
  })

  it("opens the full-page review from a row, never a side sheet", async () => {
    const user = userEvent.setup()
    await openClearing()
    const link = within(table()).getAllByRole("link", { name: "Fuzzy control of a grid" })[0]
    expect(link).toHaveAttribute("href", "/review/c1?queue=clearing")
    await user.click(within(table()).getAllByText("Asha Faculty")[0])
    expect(await screen.findByText("The review workspace")).toBeInTheDocument()
    expect(where()).toBe("/review/c1?queue=clearing")
    expect(screen.queryByRole("dialog")).toBeNull()
  })

  it("tells the review which filters were on", async () => {
    await openClearing("/clearing?department=CSE")
    expect(within(table()).getByRole("link", { name: "Fuzzy control of a grid" })).toHaveAttribute(
      "href",
      "/review/c2?queue=clearing&filter=department%3DCSE"
    )
  })

  it("keeps a filter in the address and applies one that is there already", async () => {
    await openClearing("/clearing?department=CSE")
    expect(within(table()).getAllByRole("row")).toHaveLength(2) // header and one claim
    expect(within(table()).getByText("FP-2026-000002")).toBeInTheDocument()
    expect(within(table()).queryByText("FP-2026-000001")).toBeNull()
  })

  it("writes what is typed to the address", async () => {
    const user = userEvent.setup()
    await openClearing()
    await user.type(screen.getByRole("textbox", { name: "Filter the queue" }), "Ravi")
    await waitFor(() => expect(where()).toContain("q=Ravi"))
    expect(within(table()).getAllByRole("row")).toHaveLength(2)
  })

  it("finds a claim number however it is typed", async () => {
    const user = userEvent.setup()
    await openClearing()
    await user.type(screen.getByRole("textbox", { name: "Filter the queue" }), "fp 2026 3")
    await waitFor(() => expect(within(table()).getAllByRole("row")).toHaveLength(2))
    expect(within(table()).getByText("FP-2026-000003")).toBeInTheDocument()
  })

  it("offers 'ready to clear' for claims whose checks pass and that are not watch-listed", async () => {
    const user = userEvent.setup()
    await openClearing()
    // c1 and c2 are clean; c3 is on the watch-list; c4 failed its checks.
    expect(screen.getByText(/of 4 shown are ready to clear/)).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Review the 2 ready" }))
    const dialog = await screen.findByRole("dialog", { name: "Clear 2 ready claims?" })
    expect(dialog).toHaveTextContent("2 claims")
    expect(dialog).toHaveTextContent("₹62,377.50")
    expect(dialog).toHaveTextContent("2 left out")
    expect(dialog).toHaveTextContent("1 watched journal")
    expect(dialog).toHaveTextContent("1 checks failed")
    expect(dialog).toHaveTextContent("1 possible duplicate")
    await user.click(within(dialog).getByRole("button", { name: /^Clear 2 for/ }))
    await waitFor(() => expect(posted("/api/admin/bulk-clear")).toHaveLength(1))
    expect(posted("/api/admin/bulk-clear")[0].body).toEqual({ claim_ids: ["c1", "c2"] })
  })

  it("shows what a manual selection contains, including what is not ready", async () => {
    const user = userEvent.setup()
    await openClearing()
    await user.click(within(table()).getByRole("checkbox", { name: /Select Fuzzy control of a grid, FP-2026-000001/ }))
    await user.click(within(table()).getByRole("checkbox", { name: /ERP-PROCESSED-120/ }))
    await user.click(screen.getByRole("button", { name: "Clear 2 claims" }))
    const dialog = await screen.findByRole("dialog", { name: "Clear 2 claims?" })
    expect(dialog).toHaveTextContent("1 claim is worth a second look")
    expect(dialog).toHaveTextContent("checks failed, possible duplicate")
  })

  it("puts a selection on hold with one reason, and has no bulk send back", async () => {
    const user = userEvent.setup()
    await openClearing()
    await user.click(within(table()).getByRole("checkbox", { name: /FP-2026-000001/ }))
    await user.click(within(table()).getByRole("checkbox", { name: /FP-2026-000002/ }))

    // Send back is one at a time, and the page says why.
    expect(screen.queryByRole("button", { name: /send back/i })).toBeNull()
    expect(screen.getByText(/Send back is one claim at a time/)).toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "Put on hold" }))
    const dialog = await screen.findByRole("dialog", { name: "Put 2 claims on hold?" })
    const go = within(dialog).getByRole("button", { name: "Put 2 on hold" })
    expect(go).toBeDisabled()
    await user.type(within(dialog).getByRole("textbox"), "Waiting on the erratum")
    expect(go).toBeEnabled()
    await user.click(go)
    await waitFor(() => expect(posted("/api/desk/bulk-hold")).toHaveLength(1))
    expect(posted("/api/desk/bulk-hold")[0].body).toEqual({ claim_ids: ["c1", "c2"], reason: "Waiting on the erratum" })
  })

  it("does not draw an empty queue when the load fails", async () => {
    serve(cell, {})
    calls.length = 0
    vi.mocked(api).mockImplementation((async (path: string) => {
      if (path.startsWith("/api/auth/me")) return cell
      throw new Error("down")
    }) as unknown as typeof api)
    renderWithProviders(at(<Clearing />, "/clearing"), { route: "/clearing" })
    expect(await screen.findByText("Could not load the queue")).toBeInTheDocument()
  })
})

/* ------------------------------------------------------------------------ */
/* Approvals                                                                 */
/* ------------------------------------------------------------------------ */

function approvalClaim(over: Record<string, unknown> = {}) {
  return {
    ...clearingClaim({ status: "CLEARED" }),
    cleared_by_name: "R Cell",
    needs_second_approval: false,
    second_approved_by_name: null,
    open_flags: 0,
    ...over,
  }
}

const PRINCIPAL_QUEUE = {
  total: 3,
  limit: 200,
  offset: 0,
  results: [
    approvalClaim({ id: "a1", ticket_number: "FP-2026-000011", waiting_days: 33 }),
    approvalClaim({ id: "a2", ticket_number: "FP-2026-000012", open_flags: 2, needs_second_approval: true, waiting_days: 4 }),
    approvalClaim({ id: "a3", ticket_number: "FP-2026-000013", remuneration: 20_000, waiting_days: 1 }),
  ],
  totals: { count: 3, amount: 124_755, longest_wait_days: 33 },
  departments: ["CSE", "ECE"],
}

async function openApprovals(route = "/approvals") {
  serve(principal, {
    "/api/principal/queue": PRINCIPAL_QUEUE,
    "/api/principal/bulk-approve": { approved: 2, total: 72_377.5, skipped: [] },
    "/api/desk/bulk-hold": { held: 1, held_ids: ["a1"], skipped: [] },
  })
  renderWithProviders(at(<Approvals />, "/approvals"), { route })
  await screen.findByRole("table", { name: "Claims waiting for approval" })
}
const aTable = () => screen.getByRole("table", { name: "Claims waiting for approval" })

describe("the approvals queue", () => {
  beforeEach(() => vi.clearAllMocks())

  it("shows amounts and the research cell's flags to the Principal", async () => {
    await openApprovals()
    const t = within(aTable())
    expect(t.getByRole("columnheader", { name: "Amount" })).toBeInTheDocument()
    expect(t.getByRole("columnheader", { name: "Flags" })).toBeInTheDocument()
    const flagged = t.getByText("FP-2026-000012").closest("tr") as HTMLElement
    expect(within(flagged).getByText("2 open flags")).toBeInTheDocument()
    expect(within(flagged).getByText("Needs a second signature")).toBeInTheDocument()
    expect(t.getByText("33 days")).toHaveClass("text-critical")
  })

  it("opens the full-page review with the queue named", async () => {
    const user = userEvent.setup()
    await openApprovals()
    await user.click(within(aTable()).getByText("FP-2026-000013").closest("tr")!.querySelector("td:nth-child(3)")!)
    expect(await screen.findByText("The review workspace")).toBeInTheDocument()
    expect(where()).toBe("/review/a3?queue=approvals")
    expect(screen.queryByRole("dialog")).toBeNull()
  })

  it("sends its filters to the server and keeps them in the address", async () => {
    await openApprovals("/approvals?department=ECE&quartile=Q1&waiting_over=14")
    const asked = calls.find((c) => c.path.startsWith("/api/principal/queue"))!.path
    expect(asked).toContain("department=ECE")
    expect(asked).toContain("quartile=Q1")
    expect(asked).toContain("waiting_over=14")
  })

  it("counts as ready only a claim with no open flag, no duplicate and an amount", async () => {
    const user = userEvent.setup()
    await openApprovals()
    expect(screen.getByText(/of 3 shown are ready to approve/)).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Review the 2 ready" }))
    const dialog = await screen.findByRole("dialog", { name: "Approve 2 ready claims?" })
    expect(dialog).toHaveTextContent("₹72,377.50")
    expect(dialog).toHaveTextContent("1 left out")
    expect(dialog).toHaveTextContent("1 open flag")
    await user.click(within(dialog).getByRole("button", { name: /^Approve 2 for/ }))
    await waitFor(() => expect(posted("/api/principal/bulk-approve")).toHaveLength(1))
    expect(posted("/api/principal/bulk-approve")[0].body).toEqual({ claim_ids: ["a1", "a3"] })
  })

  it("has bulk hold and no bulk send back", async () => {
    const user = userEvent.setup()
    await openApprovals()
    await user.click(within(aTable()).getByRole("checkbox", { name: /FP-2026-000011/ }))
    expect(screen.getByRole("button", { name: "Put on hold" })).toBeInTheDocument()
    // The selection bar has none; send back lives on each row, one at a time.
    const bar = screen.getByText(/1 selected|selected/).closest(".sticky") as HTMLElement
    expect(within(bar).queryByRole("button", { name: /send back/i })).toBeNull()
    expect(screen.getByText(/Send back is one claim at a time/)).toBeInTheDocument()
  })

  it("approves one claim on its own row, at the figure shown", async () => {
    const user = userEvent.setup()
    await openApprovals()
    serve(principal, {
      "/api/principal/queue": PRINCIPAL_QUEUE,
      "/api/claims/a3/principal-approve": { ...approvalClaim({ id: "a3", remuneration: 20_000 }), status: "PRINCIPAL_APPROVED" },
    })
    const row = within(aTable()).getByText("FP-2026-000013").closest("tr") as HTMLElement
    await user.click(within(row).getByRole("button", { name: /^Approve$/ }))
    const dialog = await screen.findByRole("dialog", { name: "Approve this spend?" })
    await user.click(within(dialog).getByRole("button", { name: /^Approve ₹20,000/ }))
    await waitFor(() => expect(posted("/api/claims/a3/principal-approve")).toHaveLength(1))
    expect(posted("/api/claims/a3/principal-approve")[0].body).toEqual({ expected_amount: 20_000 })
  })

  it("sends one claim back with its own reason, from its row", async () => {
    const user = userEvent.setup()
    await openApprovals()
    serve(principal, {
      "/api/principal/queue": PRINCIPAL_QUEUE,
      "/api/claims/a1/principal-reject": { ...approvalClaim({ id: "a1" }), status: "SUBMITTED" },
    })
    const row = within(aTable()).getByText("FP-2026-000011").closest("tr") as HTMLElement
    await user.click(within(row).getByRole("button", { name: "Send back" }))
    const dialog = await screen.findByRole("dialog", { name: "Send back to the research cell?" })
    const send = within(dialog).getByRole("button", { name: "Send back" })
    expect(send).toBeDisabled()
    await user.type(within(dialog).getByRole("textbox", { name: "Reason" }), "Author position does not match the paper")
    await user.click(send)
    await waitFor(() => expect(posted("/api/claims/a1/principal-reject")).toHaveLength(1))
    expect(posted("/api/claims/a1/principal-reject")[0].body).toEqual({ note: "Author position does not match the paper" })
  })
})

/* ------------------------------------------------------------------------ */
/* Authorisations                                                            */
/* ------------------------------------------------------------------------ */

const DIRECTOR_QUEUE = {
  total: 2,
  limit: 50,
  offset: 0,
  results: [
    {
      id: "d1",
      ticket_number: "FP-2026-000021",
      paper_title: "Fuzzy control of a grid",
      journal_title: "Nature",
      quartile: "Q1",
      owner_name: "Asha Faculty",
      owner_department: "ECE",
      status: "PRINCIPAL_APPROVED",
      remuneration: 52_377.5,
      calc_error: null,
      cleared_by_name: "R Cell",
      principal_approved_by_name: "K Principal",
      principal_approved_at: "2026-09-01T00:00:00Z",
      waiting_days: 29,
    },
    {
      id: "d2",
      ticket_number: "FP-2026-000022",
      paper_title: "A paper without an amount",
      journal_title: null,
      quartile: null,
      owner_name: "Ravi Other",
      owner_department: "CSE",
      status: "PRINCIPAL_APPROVED",
      remuneration: null,
      calc_error: "No quartile on record",
      cleared_by_name: "R Cell",
      principal_approved_by_name: "K Principal",
      principal_approved_at: "2026-09-10T00:00:00Z",
      waiting_days: 4,
    },
  ],
  totals: { count: 2, amount: 52_377.5, longest_wait_days: 29 },
  departments: ["CSE", "ECE"],
  by_department: [],
}

async function openAuthorisations(route = "/authorisations") {
  serve(director, {
    "/api/director/queue": DIRECTOR_QUEUE,
    "/api/budgets": { financial_year: "2026-27", college: { department: null, allocated: null, spent: 0, committed: 0, remaining: null, used_fraction: null }, departments: [] },
  })
  renderWithProviders(at(<Authorisations />, "/authorisations"), { route })
  await screen.findByRole("table", { name: "Claims waiting to be authorised" })
}
const dTable = () => screen.getByRole("table", { name: "Claims waiting to be authorised" })

describe("the authorisations queue", () => {
  beforeEach(() => vi.clearAllMocks())

  it("shows the amount to the Director and never a flags column", async () => {
    await openAuthorisations()
    const t = within(dTable())
    expect(t.getByRole("columnheader", { name: "Amount" })).toBeInTheDocument()
    expect(t.queryByRole("columnheader", { name: "Flags" })).toBeNull()
    expect(t.getByText("₹52,377.50")).toBeInTheDocument()
    expect(t.getByText("29 days")).toHaveClass("text-caution")
  })

  it("opens the full-page review from a row", async () => {
    const user = userEvent.setup()
    await openAuthorisations()
    expect(within(dTable()).getByRole("link", { name: "Fuzzy control of a grid" })).toHaveAttribute(
      "href",
      "/review/d1?queue=authorisations"
    )
    await user.click(within(dTable()).getByText("Asha Faculty"))
    expect(await screen.findByText("The review workspace")).toBeInTheDocument()
    expect(where()).toBe("/review/d1?queue=authorisations")
  })

  it("keeps a claim with no amount out of the ready batch", async () => {
    await openAuthorisations()
    expect(screen.getByText(/on this page is ready to authorise/)).toBeInTheDocument()
    expect(within(dTable()).getByRole("checkbox", { name: /A paper without an amount/ })).toBeDisabled()
    expect(within(dTable()).getByText(/could not be worked out/)).toBeInTheDocument()
  })

  it("passes the search to the server, claim number included", async () => {
    const user = userEvent.setup()
    await openAuthorisations()
    await user.type(screen.getByRole("textbox", { name: "Search the queue" }), "fp 2026 21")
    await waitFor(() => expect(where()).toContain("q=fp+2026+21"))
    await waitFor(() =>
      expect(calls.some((c) => c.path.startsWith("/api/director/queue") && c.path.includes("q=fp+2026+21"))).toBe(true)
    )
  })
})
