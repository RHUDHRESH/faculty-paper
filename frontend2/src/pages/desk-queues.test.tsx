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
import { renderWithProviders } from "@/test/harness"

/**
 * The three desk queues share one dense table, one bulk vocabulary and one
 * way of remembering filters. What is asserted here is what a reviewer
 * relies on: the columns, the amber and red waiting days, that a row opens
 * the full-page review and not a side sheet, that a filter survives in the
 * address, that "ready" batches leave out exactly what is not ready, and that
 * bulk send back does not exist.
 */

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
  await screen.findByRole("region", { name: "Ready to approve" })
}
/** A claim's row, by its claim number (rows are in two lanes: ready, and needs a look). */
const row = (no: string) => document.querySelector(`[data-claim="${no}"]`) as HTMLElement

describe("the approvals queue", () => {
  beforeEach(() => vi.clearAllMocks())

  it("shows amounts and the research cell's flags to the Principal", async () => {
    await openApprovals()
    // The claim that needs her eyes is in its own lane and says why, in words, on its row.
    const look = within(screen.getByRole("region", { name: "Needs a look" }))
    const flagged = within(look.getByText("FP-2026-000012").closest("li") as HTMLElement)
    expect(flagged.getByText(/2 open flags/)).toBeInTheDocument()
    expect(flagged.getByText(/Your approval is the second signature/)).toBeInTheDocument()
    // Amounts are shown, and a month-old wait is red.
    expect(within(row("FP-2026-000013")).getAllByText("₹20,000")[0]).toBeInTheDocument()
    for (const el of within(row("FP-2026-000011")).getAllByText("33 days")) expect(el).toHaveClass("text-critical")
  })

  it("opens the full-page review with the queue named", async () => {
    const user = userEvent.setup()
    await openApprovals()
    await user.click(within(row("FP-2026-000013")).getByText("Asha Faculty"))
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
    expect(where()).toContain("department=ECE")
  })

  it("counts as ready only a claim with no open flag, no duplicate and an amount", async () => {
    const user = userEvent.setup()
    await openApprovals()
    expect(screen.getByText(/2 are ready; 1 need a look/)).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Approve the 2 ready" }))
    const dialog = await screen.findByRole("dialog", { name: "Approve 2 claims?" })
    expect(dialog).toHaveTextContent("₹72,377.50")
    expect(dialog).toHaveTextContent("1 left for you to look at")
    expect(dialog).toHaveTextContent("1 open flag")
    await user.click(within(dialog).getByRole("button", { name: /^Approve 2 for/ }))
    await waitFor(() => expect(posted("/api/principal/bulk-approve")).toHaveLength(1))
    expect(posted("/api/principal/bulk-approve")[0].body).toEqual({ claim_ids: ["a1", "a3"] })
  })

  it("has bulk hold and no bulk send back", async () => {
    const user = userEvent.setup()
    await openApprovals()
    await user.click(within(row("FP-2026-000011")).getByRole("checkbox", { name: /FP-2026-000011/ }))
    expect(screen.getByRole("button", { name: "Put on hold" })).toBeInTheDocument()
    // The selection bar has none; send back lives on each row, one at a time.
    const bar = screen.getByText(/chosen/).closest(".sticky") as HTMLElement
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
    // (a row holds one button for a phone and one for a desk; the stylesheet shows the right one)
    await user.click(within(row("FP-2026-000013")).getAllByRole("button", { name: /^Approve: / })[0])
    const dialog = await screen.findByRole("dialog", { name: "Approve this claim?" })
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
    await user.click(within(row("FP-2026-000011")).getAllByRole("button", { name: "Send back" })[0])
    const dialog = await screen.findByRole("dialog", { name: "Send this claim back?" })
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
  await screen.findByRole("list", { name: "Claims ready to authorise" })
}
const dTable = () => screen.getByRole("list", { name: "Claims ready to authorise" })

describe("the authorisations queue", () => {
  beforeEach(() => vi.clearAllMocks())

  it("shows the amount to the Director and never a flags column", async () => {
    await openAuthorisations()
    const t = within(dTable())
    // A face-led list, not a table: no Flags column, and none of the words a flag is made of.
    expect(screen.queryByRole("table")).toBeNull()
    expect(screen.queryByText(/flag|duplicate|watch/i)).toBeNull()
    expect(t.getAllByText("₹52,377.50")[0]).toBeInTheDocument()
    expect(t.getAllByText("29 days")[0]).toHaveClass("text-caution")
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
    expect(screen.getByRole("heading", { name: /Ready to authorise \(1\)/ })).toBeInTheDocument()
    const stuck = screen.getByRole("list", { name: "Claims that cannot be authorised yet" })
    expect(within(stuck).queryByRole("checkbox")).toBeNull()
    expect(within(stuck).getByText(/could not be worked out/)).toBeInTheDocument()
    expect(within(dTable()).queryByText("A paper without an amount")).toBeNull()
  })

  it("says what authorising does to the budget before anything is pressed, and again in the confirm", async () => {
    const user = userEvent.setup()
    serve(director, {
      "/api/director/queue": DIRECTOR_QUEUE,
      "/api/budgets": {
        financial_year: "2026-27",
        college: { department: null, allocated: 1_000_000, spent: 400_000, committed: 300_000, remaining: 300_000, used_fraction: 0.7 },
        departments: [],
      },
      "/api/director/bulk-approve": { approved: 1, total: 52_377.5, skipped: [] },
    })
    renderWithProviders(at(<Authorisations />, "/authorisations"), { route: "/authorisations" })
    await screen.findByRole("list", { name: "Claims ready to authorise" })
    expect(await screen.findAllByText("Authorising them leaves ₹3,00,000 in the 2026-27 budget.")).toHaveLength(1)
    expect(screen.getByRole("img", { name: /Budget: ₹4,00,000 paid/ })).toBeInTheDocument()
    // One primary button authorises every ready claim; the confirm repeats the effect and takes Enter.
    await user.click(screen.getByRole("button", { name: /Authorise all 1 · ₹52,377.50/ }))
    const dialog = await screen.findByRole("dialog")
    expect(within(dialog).getByText(/Authorising it leaves ₹3,00,000/)).toBeInTheDocument()
    await user.keyboard("{Enter}")
    await waitFor(() => expect(posted("/api/director/bulk-approve")).toHaveLength(1))
    expect(posted("/api/director/bulk-approve")[0].body).toMatchObject({ claim_ids: ["d1"] })
  })

  it("authorises the claim under the cursor on the key a, and every ready claim on shift and a", async () => {
    const user = userEvent.setup()
    serve(director, {
      "/api/director/queue": DIRECTOR_QUEUE,
      "/api/budgets": { financial_year: "2026-27", college: { department: null, allocated: null, spent: 0, committed: 0, remaining: null, used_fraction: null }, departments: [] },
      "/api/claims/d1/director-approve": { remuneration: 52_377.5 },
    })
    renderWithProviders(at(<Authorisations />, "/authorisations"), { route: "/authorisations" })
    await screen.findByRole("list", { name: "Claims ready to authorise" })
    await user.keyboard("a")
    expect(await screen.findByRole("heading", { name: "Authorise this claim?" })).toBeInTheDocument()
    await user.keyboard("{Enter}")
    await waitFor(() => expect(posted("/api/claims/d1/director-approve")).toHaveLength(1))
    expect(posted("/api/claims/d1/director-approve")[0].body).toMatchObject({ expected_amount: 52_377.5 })
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
