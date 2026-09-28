import { fireEvent, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return { ...actual, api: vi.fn() }
})

import type { Me } from "@/app/auth"
import { api } from "@/lib/api"
import { Calendar } from "@/pages/calendar"
import { agendaWindow, googleTemplateUrl, lanes, toItems } from "@/pages/calendar/model"
import { FACULTY, fakeApi, renderWithProviders } from "@/test/harness"

const FINANCE: Me = { id: "u-fin", email: "f@x.edu", name: "Finance", role: "FINANCE", department: null }

const paidMonth = {
  id: "record-paid-2026-05",
  kind: "PAID",
  kind_label: "Payments made",
  title: "112 papers paid for",
  starts_on: "2026-05-01",
  count: 112,
  amount: 713718,
  claim_id: null,
  titles: [],
  whole_month: true,
}

const windowEvent = {
  id: "ev1",
  title: "Q3 submission window",
  kind: "SUBMISSION_WINDOW",
  kind_label: "Submission window",
  starts_on: "2026-05-11",
  ends_on: "2026-05-20",
  starts_at: null,
  ends_at: null,
  all_day: true,
  description: null,
  visibility: "PUBLIC",
  department: null,
  thread_id: null,
  claim_id: null,
  claim_title: null,
  created_by: "Office",
  created_by_id: "u-office",
}

function mount(me: Me, { record = [] as unknown[], results = [] as unknown[], visibilities = ["PRIVATE"] } = {}) {
  vi.mocked(api).mockReset()
  vi.mocked(api).mockImplementation(
    fakeApi({
      "/api/auth/me": () => me,
      "/api/calendar/feed-link": () => ({
        url: "https://x.edu/api/calendar/feed/tok.ics",
        webcal: "webcal://x.edu/api/calendar/feed/tok.ics",
        google_subscribe_url: "https://calendar.google.com/calendar/r?cid=webcal%3A%2F%2Fx.edu",
      }),
      "/api/claims": () => ({ results: [{ id: "c1", paper_title: "My paper" }] }),
      "/api/calendar": () => ({
        start: "2026-04-27",
        end: "2026-06-07",
        results,
        kinds: [],
        record,
        record_kinds: [],
        visibilities,
      }),
    })
  )
  renderWithProviders(<Calendar />, { route: "/calendar?view=month&date=2026-05-01" })
}

describe("Calendar", () => {
  it("draws a month grid with a spanning window bar and the record", async () => {
    mount(FACULTY, { results: [windowEvent], record: [paidMonth] })
    expect(await screen.findByRole("grid", { name: "Month" })).toBeInTheDocument()
    expect(screen.getByRole("heading", { name: "May 2026" })).toBeInTheDocument()
    // One bar for a window spanning two weeks: one chip per week row.
    expect(screen.getAllByRole("button", { name: /Q3 submission window/ })).toHaveLength(2)
    expect(screen.getByRole("button", { name: /112 papers paid for/ })).toBeInTheDocument()
  })

  it("shows finance the month's total, and the event offers Add to Google Calendar", async () => {
    mount(FINANCE, { record: [paidMonth] })
    await userEvent.click(await screen.findByRole("button", { name: /112 papers paid for/ }))
    const dialog = await screen.findByRole("dialog")
    expect(within(dialog).getByText("₹7,13,718")).toBeInTheDocument()
    const g = within(dialog).getByRole("link", { name: /Add to Google Calendar/ })
    expect(g.getAttribute("href")).toContain("https://calendar.google.com/calendar/render?action=TEMPLATE")
    expect(g.getAttribute("href")).toContain("dates=20260501%2F20260502")
    expect(within(dialog).getByRole("link", { name: "Open ledger" })).toHaveAttribute("href", "/ledger?month=2026-05")
  })

  it("lets faculty add only a private event: no audience choice, prefilled with the day", async () => {
    mount(FACULTY)
    await userEvent.click(await screen.findByRole("button", { name: /Add an event on .*14 May/ }))
    const dialog = await screen.findByRole("dialog")
    expect(within(dialog).getByText("Only you see this.")).toBeInTheDocument()
    expect(within(dialog).queryByText("Who sees it")).toBeNull()
    expect(within(dialog).getByDisplayValue("2026-05-14")).toBeInTheDocument()
  })

  it("offers the office a choice of audience", async () => {
    mount(FINANCE, { visibilities: ["PRIVATE", "DEPARTMENT", "PUBLIC", "OFFICE"] })
    await userEvent.click(await screen.findByRole("button", { name: /Add an event on .*14 May/ }))
    const dialog = await screen.findByRole("dialog")
    expect(within(dialog).getByText("Who sees it")).toBeInTheDocument()
    expect(within(dialog).getByLabelText("College")).toBeInTheDocument()
  })

  it("moves by month with the arrow keys", async () => {
    mount(FACULTY)
    await screen.findByRole("heading", { name: "May 2026" })
    fireEvent.keyDown(window, { key: "ArrowRight" })
    expect(await screen.findByRole("heading", { name: "June 2026" })).toBeInTheDocument()
  })
})

describe("calendar model", () => {
  it("agenda on the current month runs from today through the Next horizon", () => {
    expect(agendaWindow("2026-08-31", "2026-10-04", "2026-09-29", "2026-10-29", true)).toEqual(["2026-09-29", "2026-10-29"])
    expect(agendaWindow("2026-10-26", "2026-12-06", "2026-09-29", "2026-10-29", false)).toEqual(["2026-10-26", "2026-12-06"])
  })

  it("builds a timed Google template in the college's zone", () => {
    const [item] = toItems({
      start: "", end: "", kinds: [],
      results: [{ ...windowEvent, ends_on: null, all_day: false, starts_at: "10:00", ends_at: "11:30", visibility: "PRIVATE", kind: "OTHER" }] as never,
    })
    const url = new URL(googleTemplateUrl(item, "https://x.edu"))
    expect(url.searchParams.get("dates")).toBe("20260511T100000/20260511T113000")
    expect(url.searchParams.get("ctz")).toBe("Asia/Kolkata")
    expect(item.kindLabel).toBe("Reminder")
  })

  it("stacks overlapping items into separate lanes", () => {
    const items = toItems({
      start: "", end: "", kinds: [],
      results: [windowEvent, { ...windowEvent, id: "ev2", starts_on: "2026-05-12", ends_on: null }] as never,
    })
    const placed = lanes(items, "2026-05-11", "2026-05-17")
    expect(placed.map((p) => p.lane).sort()).toEqual([0, 1])
  })
})
