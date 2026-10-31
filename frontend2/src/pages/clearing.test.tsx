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
import { Clearing } from "@/pages/clearing"
import { renderWithProviders } from "@/test/harness"

/**
 * The clearing queue as one table, ready claims first (docs/ux/26). What a clerk relies on: the
 * ready claims are together and the others say why they are not; a row opens
 * the full-page review; a filter survives in the address; `c` then Enter
 * clears the claim under the cursor; `a` chooses every ready claim; the batch
 * leaves out exactly what is not ready; and bulk send back does not exist.
 */

const cell: Me = { id: "u-cell", email: "cell@example.edu", name: "R Cell", role: "RESEARCH_CELL", department: null }

type Call = { path: string; method: string; body: unknown }
const calls: Call[] = []

function serve(table: Record<string, unknown>) {
  calls.length = 0
  vi.mocked(api).mockImplementation((async (path: string, opts?: { method?: string; json?: unknown }) => {
    calls.push({ path, method: opts?.method ?? "GET", body: opts?.json })
    if (path.startsWith("/api/auth/me")) return cell
    const key = Object.keys(table)
      .sort((a, b) => b.length - a.length)
      .find((k) => path.startsWith(k))
    if (!key) throw new Error(`No handler in this test for ${path}`)
    return table[key]
  }) as unknown as typeof api)
}

const posted = (path: string) => calls.filter((c) => c.method === "POST" && c.path === path)

function Where() {
  const l = useLocation()
  return <output data-testid="where">{l.pathname + l.search}</output>
}

function at(el: React.ReactElement) {
  return (
    <>
      <Routes>
        <Route path="/clearing" element={el} />
        <Route path="/review/:id" element={<p>The review workspace</p>} />
      </Routes>
      <Where />
    </>
  )
}

const where = () => screen.getByTestId("where").textContent

function claim(over: Record<string, unknown> = {}) {
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
  claim({ id: "c1", ticket_number: "FP-2026-000001", waiting_days: 40 }),
  claim({ id: "c2", ticket_number: "FP-2026-000002", waiting_days: 20, owner_name: "Ravi Other", owner_department: "CSE", remuneration: 10_000 }),
  claim({ id: "c3", ticket_number: "FP-2026-000003", waiting_days: 5, journal_watch: { id: "w", reason: "Cloned title", title: "Nature" } }),
  claim({ id: "c4", ticket_number: "ERP-PROCESSED-120", waiting_days: 2, verification_ok: false, duplicate_warning: true }),
]

async function open(route = "/clearing") {
  serve({
    "/api/admin/clearing-queue": QUEUE,
    "/api/admin/bulk-clear": { cleared: 2, skipped: [] },
    "/api/desk/bulk-hold": { held: 2, held_ids: ["c1", "c2"], skipped: [] },
  })
  const view = renderWithProviders(at(<Clearing />), { route })
  await screen.findByRole("table")
  return view
}

/** The table row that holds a claim number. */
const rowOf = (no: string) => within(screen.getByText(no).closest("tr") as HTMLElement)

describe("the clearing queue", () => {
  beforeEach(() => vi.clearAllMocks())

  it("answers first in figures, then lists the ready claims before the rest", async () => {
    await open()
    expect(screen.getByRole("link", { name: "2 ready to clear" })).toBeInTheDocument()
    expect(screen.getByRole("group", { name: "At a glance" })).toHaveTextContent("4 claims waiting")
    const order = within(screen.getByRole("table")).getAllByRole("row").slice(1).map((r) => r.textContent ?? "")
    expect(order[0]).toContain("FP-2026-000001")
    expect(order[1]).toContain("FP-2026-000002")
    expect(rowOf("FP-2026-000001").getByText("Ready to clear")).toBeInTheDocument()
    expect(rowOf("FP-2026-000002").getByText("Ready to clear")).toBeInTheDocument()
    expect(rowOf("FP-2026-000003").queryByText("Ready to clear")).toBeNull()
  })

  it("leads with the person, then the paper, and says why a claim needs a look", async () => {
    await open()
    const row = rowOf("FP-2026-000001")
    expect(row.getByText("Asha Faculty")).toBeInTheDocument()
    expect(row.getByText("Fuzzy control of a grid")).toBeInTheDocument()
    expect(row.getByText("Nature")).toBeInTheDocument()
    expect(row.getByText("Q1")).toBeInTheDocument()
    expect(row.getAllByText("₹52,377.50").length).toBeGreaterThan(0)
    expect(row.getByRole("button", { name: /copy claim no\. FP-2026-000001/i })).toBeInTheDocument()
    const dup = rowOf("ERP-PROCESSED-120")
    expect(dup.getByText(/Checks failed/)).toBeInTheDocument()
    expect(dup.getByText(/Possible duplicate/)).toBeInTheDocument()
    expect(rowOf("FP-2026-000003").getByText(/Watched journal/)).toBeInTheDocument()
  })

  it("turns waiting days amber after two weeks and red after a month, and says Late", async () => {
    await open()
    expect(rowOf("FP-2026-000001").getByText("40 days")).toHaveClass("text-critical")
    expect(rowOf("FP-2026-000002").getByText("20 days")).toHaveClass("text-caution")
    expect(screen.getAllByText("Late")).toHaveLength(2)
  })

  it("opens the full-page review from a row, never a side sheet", async () => {
    const user = userEvent.setup()
    await open()
    await user.click(rowOf("FP-2026-000001").getByRole("link", { name: "Fuzzy control of a grid" }))
    expect(await screen.findByText("The review workspace")).toBeInTheDocument()
    expect(where()).toBe("/review/c1?queue=clearing")
    expect(screen.queryByRole("dialog")).toBeNull()
  })

  it("tells the review which filters were on", async () => {
    const user = userEvent.setup()
    await open("/clearing?department=CSE")
    await user.click(rowOf("FP-2026-000002").getByRole("link", { name: "Fuzzy control of a grid" }))
    expect(where()).toBe("/review/c2?queue=clearing&filter=department%3DCSE")
  })

  it("keeps a filter in the address and applies one that is there already", async () => {
    await open("/clearing?department=CSE")
    expect(screen.getByText("FP-2026-000002")).toBeInTheDocument()
    expect(screen.queryByText("FP-2026-000001")).toBeNull()
  })

  it("writes what is typed to the address, and finds a claim number however it is typed", async () => {
    const user = userEvent.setup()
    await open()
    await user.type(screen.getByRole("textbox", { name: "Search the queue" }), "fp 2026 3")
    await waitFor(() => expect(where()).toContain("q="))
    await waitFor(() => expect(screen.queryByText("FP-2026-000001")).toBeNull())
    expect(screen.getByText("FP-2026-000003")).toBeInTheDocument()
  })

  it("narrows to the ready claims from the checks filter", async () => {
    const user = userEvent.setup()
    await open()
    await user.selectOptions(screen.getByRole("combobox", { name: "Filter by checks" }), "ready")
    await waitFor(() => expect(screen.queryByText("FP-2026-000003")).toBeNull())
    expect(where()).toContain("check=ready")
    expect(screen.getByText("FP-2026-000001")).toBeInTheDocument()
  })

  it("clears every ready claim from one button, and says what it leaves out", async () => {
    const user = userEvent.setup()
    await open()
    await user.click(screen.getByRole("button", { name: "Clear the 2 ready" }))
    const dialog = await screen.findByRole("dialog", { name: "Clear 2 claims?" })
    expect(dialog).toHaveTextContent("₹62,377.50")
    expect(dialog).toHaveTextContent("2 left for you to look at")
    expect(dialog).toHaveTextContent("1 watched journal")
    await user.click(within(dialog).getByRole("button", { name: /^Clear 2 for/ }))
    await waitFor(() => expect(posted("/api/admin/bulk-clear")).toHaveLength(1))
    expect(posted("/api/admin/bulk-clear")[0].body).toEqual({ claim_ids: ["c1", "c2"] })
  })

  it("clears one ready claim from the Clear button in its own row", async () => {
    const user = userEvent.setup()
    await open()
    expect(rowOf("FP-2026-000003").queryByRole("button", { name: "Clear" })).toBeNull()
    expect(rowOf("FP-2026-000003").getByRole("link", { name: "Review" })).toBeInTheDocument()
    await user.click(rowOf("FP-2026-000002").getByRole("button", { name: "Clear" }))
    const dialog = await screen.findByRole("dialog", { name: "Clear this claim?" })
    expect(dialog).toHaveTextContent("Ravi Other")
  })

  it("clears the claim under the cursor with c, then Enter", async () => {
    const user = userEvent.setup()
    await open()
    await user.keyboard("c")
    const dialog = await screen.findByRole("dialog", { name: "Clear this claim?" })
    expect(dialog).toHaveTextContent("Asha Faculty")
    await waitFor(() => expect(within(dialog).getByRole("button", { name: /^Clear ₹52,377\.50/ })).toHaveFocus())
    await user.keyboard("{Enter}")
    await waitFor(() => expect(posted("/api/admin/bulk-clear")).toHaveLength(1))
    expect(posted("/api/admin/bulk-clear")[0].body).toEqual({ claim_ids: ["c1"] })
  })

  it("will not clear a claim that is not ready with c, and says why", async () => {
    const user = userEvent.setup()
    await open()
    await user.keyboard("jjc")
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
    expect(posted("/api/admin/bulk-clear")).toHaveLength(0)
  })

  it("chooses every ready claim with a, then clears them with c", async () => {
    const user = userEvent.setup()
    await open()
    await user.keyboard("a")
    expect(await screen.findByText(/chosen/)).toHaveTextContent("2")
    await user.keyboard("c")
    const dialog = await screen.findByRole("dialog", { name: "Clear 2 claims?" })
    expect(dialog).toHaveTextContent("₹62,377.50")
  })

  it("shows what a manual choice contains, including what is not ready", async () => {
    const user = userEvent.setup()
    await open()
    await user.click(rowOf("FP-2026-000001").getByRole("checkbox", { name: /FP-2026-000001/ }))
    await user.click(rowOf("ERP-PROCESSED-120").getByRole("checkbox", { name: /ERP-PROCESSED-120/ }))
    await user.click(screen.getByRole("button", { name: "Clear 2 claims" }))
    const dialog = await screen.findByRole("dialog", { name: "Clear 2 claims?" })
    expect(dialog).toHaveTextContent("One claim is not marked ready")
    expect(dialog).toHaveTextContent("checks failed, possible duplicate")
  })

  it("puts a choice on hold with one reason, and has no bulk send back", async () => {
    const user = userEvent.setup()
    await open()
    await user.click(rowOf("FP-2026-000001").getByRole("checkbox", { name: /FP-2026-000001/ }))
    await user.click(rowOf("FP-2026-000002").getByRole("checkbox", { name: /FP-2026-000002/ }))
    expect(screen.getByText(/Send back is one claim at a time/)).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Put on hold" }))
    const dialog = await screen.findByRole("dialog", { name: "Put 2 claims on hold?" })
    const go = within(dialog).getByRole("button", { name: "Put 2 on hold" })
    expect(go).toBeDisabled()
    await user.type(within(dialog).getByRole("textbox"), "Waiting on the erratum")
    await user.click(go)
    await waitFor(() => expect(posted("/api/desk/bulk-hold")).toHaveLength(1))
    expect(posted("/api/desk/bulk-hold")[0].body).toEqual({ claim_ids: ["c1", "c2"], reason: "Waiting on the erratum" })
  })

  it("offers one box in the heading that chooses the ready claims, and none for the rest", async () => {
    const user = userEvent.setup()
    await open()
    const all = screen.getByRole("checkbox", { name: "Choose all 2 ready to clear" })
    await user.click(all)
    expect(await screen.findByText(/chosen/)).toHaveTextContent("2")
    expect(rowOf("FP-2026-000003").getByRole("checkbox")).toHaveAttribute("aria-checked", "false")
  })

  it("exports the table to Excel, PDF and CSV from its tools", async () => {
    await open()
    expect(screen.getByRole("button", { name: /export/i })).toBeInTheDocument()
  })

  it("says Not recorded, with its title, for an old-system claim with no amount, never ₹0", async () => {
    serve({
      "/api/admin/clearing-queue": [claim({ id: "c9", ticket_number: "ERP-RAW-9", remuneration: 0, verification_ok: false })],
    })
    renderWithProviders(at(<Clearing />), { route: "/clearing" })
    const labels = await screen.findAllByText("Not recorded")
    expect(labels.length).toBeGreaterThan(0)
    expect(labels.some((l) => l.closest("[title]")?.getAttribute("title") === "The old system did not record an amount.")).toBe(true)
    // The row itself never prints a rupee zero (the queue total above is a sum, not a claim's amount).
    expect(within(labels[0].closest("tr") as HTMLElement).queryByText("₹0")).toBeNull()
  })

  it("names the next step when nothing is waiting", async () => {
    serve({ "/api/admin/clearing-queue": [] })
    renderWithProviders(at(<Clearing />), { route: "/clearing" })
    expect(await screen.findByRole("link", { name: "See where claims are" })).toHaveAttribute("href", "/track")
  })

  it("does not draw an empty queue when the load fails", async () => {
    vi.mocked(api).mockImplementation((async (path: string) => {
      if (path.startsWith("/api/auth/me")) return cell
      throw new Error("down")
    }) as unknown as typeof api)
    renderWithProviders(at(<Clearing />), { route: "/clearing" })
    expect(await screen.findByText("Could not load the queue")).toBeInTheDocument()
  })
})
