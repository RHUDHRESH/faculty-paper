import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return { ...actual, api: vi.fn() }
})

import type { Me } from "@/app/auth"
import { api } from "@/lib/api"
import { Journals } from "@/pages/journals"
import { FINANCE, fakeApi, renderWithProviders } from "@/test/harness"

const CELL: Me = { id: "u-cell", email: "cell@example.edu", name: "Priya Cell", role: "RESEARCH_CELL", department: null }

const WATCH = {
  id: "w1",
  issn: null,
  title: "Lecture Notes in Networks and Systems",
  reason: "Looks like a clone of a discontinued journal",
  added_by_name: "Ravi Cell",
  created_at: "2026-09-20T10:00:00Z",
  waiting: 2,
  claims_total: 7,
  claims_paid: 5,
  journal_titles: ["Lecture Notes in Networks and Systems"],
  waiting_claims: [
    { id: "c1", ticket_number: "ERP-RAW-3", origin: "Imported from the ERP, Raw data sheet", paper_title: "A paper in the clone", owner_name: "Dr Anand K", waiting_days: 40 },
  ],
}

function mount(me: Me, watch: unknown[] = [WATCH]) {
  vi.mocked(api).mockReset()
  vi.mocked(api).mockImplementation(
    fakeApi({
      "/api/auth/me": () => me,
      "/api/admin/journal-watch": () => watch,
      "/api/journals/top": () => ({
        results: [
          { key: "Lecture Notes in Networks and Systems", count: 7, amount: 5665 },
          { key: "Scientific Reports", count: 2, amount: 0 },
        ],
      }),
    })
  )
  renderWithProviders(<Journals />)
}

describe("journals for the research cell", () => {
  it("leads with the watch-list: why, who, and the claims it touches", async () => {
    mount(CELL)
    const watched = (await screen.findByRole("heading", { name: "On the watch-list" })).closest("section")!
    expect(await within(watched).findByText(/Looks like a clone of a discontinued journal/)).toBeInTheDocument()
    expect(within(watched).getByText(/Put there by Ravi Cell/)).toBeInTheDocument()
    expect(within(watched).getByText("2 claims are waiting to be cleared")).toBeInTheDocument()
    expect(within(watched).getByText(/7 claims in all, 5 paid/)).toBeInTheDocument()
    // The figures at the top are the same numbers.
    expect(screen.getByRole("link", { name: "1 Journals on the watch-list" })).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "2 Claims waiting in a watched journal" })).toBeInTheDocument()
  })

  it("opens the claims waiting in a watched journal on the review page", async () => {
    const user = userEvent.setup()
    mount(CELL)
    await user.click(await screen.findByRole("button", { name: /Show the claims waiting/ }))
    expect(screen.getByRole("link", { name: "A paper in the clone" })).toHaveAttribute("href", "/review/c1?queue=clearing")
    expect(screen.getByText("ERP-RAW-3")).toHaveAttribute("title", "Imported from the ERP, Raw data sheet")
  })

  it("marks the watched journal in the list of where the college publishes", async () => {
    mount(CELL)
    const table = await screen.findByRole("table")
    const row = within(table).getByText("Lecture Notes in Networks and Systems").closest("tr")!
    expect(await within(row).findByText("Watched")).toBeInTheDocument()
    const other = within(table).getByText("Scientific Reports").closest("tr")!
    expect(within(other).queryByText("Watched")).toBeNull()
  })

  it("says what taking a journal off will change before it does", async () => {
    const user = userEvent.setup()
    mount(CELL)
    await user.click(await screen.findByRole("button", { name: /Take Lecture Notes.* off the watch-list/ }))
    const dialog = await screen.findByRole("dialog")
    expect(within(dialog).getByText(/2 claims waiting in it will stop carrying a warning/)).toBeInTheDocument()
    await user.click(within(dialog).getByRole("button", { name: "Take it off" }))
    await waitFor(() => {
      const call = vi.mocked(api).mock.calls.find(([path]) => path === "/api/admin/journal-watch/w1")
      expect(call?.[1]).toMatchObject({ method: "DELETE" })
    })
  })

  it("needs a reason before a journal is watched", async () => {
    const user = userEvent.setup()
    mount(CELL, [])
    expect(await screen.findByText("No journal is being watched")).toBeInTheDocument()
    await user.click(screen.getAllByRole("button", { name: /Watch a journal/ })[0])
    const dialog = await screen.findByRole("dialog")
    const go = within(dialog).getByRole("button", { name: "Watch this journal" })
    await user.type(within(dialog).getByLabelText("Journal title"), "Doubtful Letters")
    expect(go).toBeDisabled()
    await user.type(within(dialog).getByLabelText("Why"), "Publisher has complaints")
    expect(go).toBeEnabled()
    await user.click(go)
    await waitFor(() => {
      const call = vi.mocked(api).mock.calls.find(([path, o]) => path === "/api/admin/journal-watch" && (o as { method?: string })?.method === "POST")
      expect(call?.[1]).toMatchObject({ json: { title: "Doubtful Letters", reason: "Publisher has complaints" } })
    })
  })

  it("keeps the plain list, with no watch-list, for Finance", async () => {
    vi.mocked(api).mockReset()
    vi.mocked(api).mockImplementation(
      fakeApi({
        "/api/auth/me": () => FINANCE,
        "/api/journals/top": () => ({ results: [{ key: "Scientific Reports", count: 2, amount: 0 }] }),
      })
    )
    renderWithProviders(<Journals />)
    expect(await screen.findByText("Scientific Reports")).toBeInTheDocument()
    expect(screen.queryByText("On the watch-list")).toBeNull()
    expect(vi.mocked(api).mock.calls.some(([p]) => String(p).startsWith("/api/admin/journal-watch"))).toBe(false)
  })
})
