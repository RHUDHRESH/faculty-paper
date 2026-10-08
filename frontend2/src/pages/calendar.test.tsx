import { fireEvent, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return { ...actual, api: vi.fn() }
})

import type { Me } from "@/app/auth"
import { api } from "@/lib/api"
import { Calendar } from "@/pages/calendar"
import { syncMessage } from "@/pages/calendar/google"
import {
  type GoogleStatus,
  agendaWindow,
  clock,
  googleTemplateUrl,
  iso,
  kindLabelOf,
  kindStyle,
  lanes,
  rangeLabel,
  toItems,
} from "@/pages/calendar/model"
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

/** What /api/calendar/google/status says in each of the five situations a person can be in. */
const SUBSCRIBE = "https://calendar.google.com/calendar/r?cid=webcal%3A%2F%2Fx.edu%2Fapi%2Fcalendar%2Ffeed%2Ftok.ics"
const IDLE: GoogleStatus = {
  configured: false,
  connected: false,
  google_email: null,
  calendar_name: null,
  last_synced: null,
  error: null,
  needs_reconnect: false,
  subscribe_url: SUBSCRIBE,
}
const READY = { ...IDLE, configured: true }
const LINKED = {
  ...READY,
  connected: true,
  google_email: "teacher@gmail.com",
  calendar_name: "Saveetha Publications",
  last_synced: new Date(Date.now() - 5 * 60_000).toISOString(),
}
const LOST = { ...LINKED, needs_reconnect: true, error: "Google no longer lets us in. Connect again to carry on." }
const SLIPPED = { ...LINKED, error: "1 event could not be sent to Google. We will try again at the next sync." }

type Mount = {
  record?: unknown[]
  results?: unknown[]
  visibilities?: string[]
  google?: GoogleStatus
  route?: string
  kinds?: { key: string; label: string }[]
}

function mount(me: Me, { record = [], results = [], visibilities = ["PRIVATE"], google = IDLE, route, kinds = [] }: Mount = {}) {
  vi.mocked(api).mockReset()
  vi.mocked(api).mockImplementation(
    fakeApi({
      "/api/auth/me": () => me,
      "/api/calendar/feed-link": () => ({
        url: "https://x.edu/api/calendar/feed/tok.ics",
        webcal: "webcal://x.edu/api/calendar/feed/tok.ics",
        google_subscribe_url: SUBSCRIBE,
      }),
      "/api/calendar/google/status": () => google,
      "/api/calendar/google/connect": () => ({ url: "https://accounts.google.com/o/oauth2/v2/auth?client_id=x" }),
      "/api/calendar/google/sync": () => ({ created: 3, updated: 1, deleted: 0, failed: 0, status: google }),
      "/api/calendar/google/disconnect": () => ({ ok: true, calendar_removed: true }),
      "/api/claims": () => ({ results: [{ id: "c1", paper_title: "My paper" }] }),
      "/api/calendar": () => ({
        start: "2026-04-27",
        end: "2026-06-07",
        results,
        kinds,
        record,
        record_kinds: [],
        visibilities,
      }),
    })
  )
  return renderWithProviders(<Calendar />, { route: route ?? "/calendar?view=month&date=2026-05-01" })
}

const posted = (path: string) =>
  vi.mocked(api).mock.calls.filter(([p, o]) => p === path && (o as { method?: string } | undefined)?.method === "POST")

afterEach(() => {
  vi.unstubAllGlobals()
})

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

  it("does not break on a kind it has never heard of: it says Event", async () => {
    mount(FACULTY, {
      results: [{ ...windowEvent, id: "ev9", title: "Coding night", kind: "HACKATHON", kind_label: "Hackathon", ends_on: null }],
    })
    const chip = await screen.findByRole("button", { name: /Coding night/ })
    expect(chip.getAttribute("aria-label")).toContain(", Event,")
  })
})

describe("Add event", () => {
  it("adds with a title and the day it was started from, and nothing else", async () => {
    mount(FACULTY)
    await userEvent.click(await screen.findByRole("button", { name: /Add an event on .*14 May/ }))
    const dialog = await screen.findByRole("dialog")
    const save = within(dialog).getByRole("button", { name: "Add event" })
    expect(save).toBeDisabled()
    // The server wants at least three letters; so does the button.
    await userEvent.type(within(dialog).getByLabelText("Title"), "ab")
    expect(save).toBeDisabled()
    await userEvent.clear(within(dialog).getByLabelText("Title"))
    await userEvent.type(within(dialog).getByLabelText("Title"), "Send revisions to the editor")
    expect(save).toBeEnabled()
    await userEvent.click(save)

    await waitFor(() => expect(posted("/api/calendar")).toHaveLength(1))
    const body = (posted("/api/calendar")[0][1] as { json: Record<string, unknown> }).json
    expect(body).toMatchObject({
      title: "Send revisions to the editor",
      starts_on: "2026-05-14",
      kind: "OTHER",
      visibility: "PRIVATE",
      all_day: true,
    })
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
  })

  it("adds on Enter, so a title and one key is enough", async () => {
    mount(FACULTY)
    await userEvent.click(await screen.findByRole("button", { name: /Add an event on .*14 May/ }))
    const dialog = await screen.findByRole("dialog")
    await userEvent.type(within(dialog).getByLabelText("Title"), "Book the seminar hall{Enter}")
    await waitFor(() => expect(posted("/api/calendar")).toHaveLength(1))
  })

  it("keeps the rest out of the way until asked, then offers a time", async () => {
    mount(FACULTY)
    await userEvent.click(await screen.findByRole("button", { name: /Add an event on .*14 May/ }))
    const dialog = await screen.findByRole("dialog")
    expect(within(dialog).queryByLabelText("Notes")).toBeNull()
    expect(within(dialog).queryByLabelText("From")).toBeNull()
    await userEvent.click(within(dialog).getByRole("checkbox", { name: "Add a time" }))
    expect(within(dialog).getByLabelText("From")).toHaveValue("10:00")
    await userEvent.click(within(dialog).getByRole("button", { name: /More options/ }))
    expect(within(dialog).getByLabelText("Notes")).toBeInTheDocument()
  })

  it("starts from today when the header button is used on this month", async () => {
    const today = iso(new Date())
    mount(FACULTY, { route: `/calendar?view=month&date=${today}` })
    await screen.findByRole("grid", { name: "Month" })
    await userEvent.click(screen.getAllByRole("button", { name: /Add event/ })[0])
    const dialog = await screen.findByRole("dialog")
    expect(within(dialog).getByDisplayValue(today)).toBeInTheDocument()
  })

  it("offers only the kinds the server knows, in plain words", async () => {
    mount(FINANCE, {
      visibilities: ["PRIVATE", "DEPARTMENT", "PUBLIC", "OFFICE"],
      kinds: [
        { key: "MEETING", label: "Meeting" },
        { key: "SEMINAR", label: "Seminar" },
        { key: "OTHER", label: "Something else" },
      ],
    })
    await userEvent.click(await screen.findByRole("button", { name: /Add an event on .*14 May/ }))
    const dialog = await screen.findByRole("dialog")
    await userEvent.click(within(dialog).getByRole("button", { name: /More options/ }))
    expect(within(dialog).getByLabelText("Seminar")).toBeInTheDocument()
    expect(within(dialog).getByLabelText("Meeting")).toBeInTheDocument()
    expect(within(dialog).getByLabelText("Reminder")).toBeInTheDocument()
    expect(within(dialog).queryByLabelText("Workshop")).toBeNull()
  })
})

describe("The event sheet", () => {
  it("shows the details and no edit buttons for somebody else's event", async () => {
    mount(FACULTY, { results: [{ ...windowEvent, description: "Send your papers in this window." }] })
    await userEvent.click((await screen.findAllByRole("button", { name: /Q3 submission window/ }))[0])
    const sheet = await screen.findByRole("dialog")
    expect(within(sheet).getByText("Send your papers in this window.")).toBeInTheDocument()
    expect(within(sheet).getByText(/11–20 May/)).toBeInTheDocument()
    expect(within(sheet).queryByRole("button", { name: "Edit" })).toBeNull()
    expect(within(sheet).queryByRole("button", { name: "Delete" })).toBeNull()
  })

  it("offers the owner Edit and Delete", async () => {
    mount(FACULTY, { results: [{ ...windowEvent, created_by_id: FACULTY.id, created_by: FACULTY.name }] })
    await userEvent.click((await screen.findAllByRole("button", { name: /Q3 submission window/ }))[0])
    const sheet = await screen.findByRole("dialog")
    expect(within(sheet).getByRole("button", { name: "Edit" })).toBeInTheDocument()
    expect(within(sheet).getByRole("button", { name: "Delete" })).toBeInTheDocument()
  })

  it("shows where, who and the link when the event has them", async () => {
    mount(FACULTY, {
      results: [
        {
          ...windowEvent,
          kind: "SEMINAR",
          kind_label: "Seminar",
          venue: "Seminar hall, Block C",
          speaker: "Dr R. Rao",
          link: "https://example.edu/register",
        },
      ],
    })
    await userEvent.click((await screen.findAllByRole("button", { name: /Q3 submission window/ }))[0])
    const sheet = await screen.findByRole("dialog")
    expect(within(sheet).getByText("Seminar hall, Block C")).toBeInTheDocument()
    expect(within(sheet).getByText("Dr R. Rao")).toBeInTheDocument()
    expect(within(sheet).getByRole("link", { name: /Open the event link/ })).toHaveAttribute("href", "https://example.edu/register")
  })

  it("says it is already in Google Calendar once connected, instead of offering to add it", async () => {
    mount(FACULTY, { results: [windowEvent], google: LINKED })
    await userEvent.click((await screen.findAllByRole("button", { name: /Q3 submission window/ }))[0])
    const sheet = await screen.findByRole("dialog")
    expect(within(sheet).queryByRole("link", { name: /Add to Google Calendar/ })).toBeNull()
    expect(within(sheet).getByText(/in your Google Calendar/i)).toBeInTheDocument()
  })
})

describe("The event sheet when Google has ended the connection", () => {
  it("offers to add the event by hand again, because nothing is syncing", async () => {
    mount(FACULTY, { results: [windowEvent], google: LOST })
    await userEvent.click((await screen.findAllByRole("button", { name: /Q3 submission window/ }))[0])
    const sheet = await screen.findByRole("dialog")
    expect(within(sheet).getByRole("link", { name: /Add to Google Calendar/ })).toBeInTheDocument()
    expect(within(sheet).queryByText(/in your Google Calendar/i)).toBeNull()
  })
})

describe("Google Calendar strip", () => {
  it("without a client secret still gives a one-click way in, and says how often Google looks", async () => {
    mount(FACULTY, { google: IDLE })
    const add = await screen.findByRole("link", { name: /Add to Google Calendar/ })
    expect(add).toHaveAttribute("href", SUBSCRIBE)
    expect(add).toHaveAttribute("target", "_blank")
    expect(screen.getByText("Google refreshes subscribed calendars about once a day.")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Connect Google Calendar" })).toBeNull()
  })

  it("offers Outlook and Apple, the link and the reset from one menu", async () => {
    mount(FACULTY, { google: IDLE })
    await userEvent.click(await screen.findByRole("button", { name: /Other calendar apps/ }))
    const outlook = await screen.findByRole("menuitem", { name: /Outlook or Apple/ })
    expect(outlook).toBeInTheDocument()
    expect(screen.getByRole("menuitem", { name: /Copy calendar link/ })).toBeInTheDocument()
    expect(screen.getByRole("menuitem", { name: /Reset link/ })).toBeInTheDocument()
  })

  it("offers Connect Google Calendar when it can connect and has not, and the connect runs", async () => {
    const assign = vi.fn()
    vi.stubGlobal("location", { ...window.location, assign })
    mount(FACULTY, { google: READY })
    const connect = await screen.findByRole("button", { name: "Connect Google Calendar" })
    expect(screen.queryByRole("link", { name: /Add to Google Calendar/ })).toBeNull()
    expect(screen.getByText(/Saveetha Publications/)).toBeInTheDocument()
    await userEvent.click(connect)
    await waitFor(() => expect(assign).toHaveBeenCalledWith("https://accounts.google.com/o/oauth2/v2/auth?client_id=x"))
    expect(vi.mocked(api).mock.calls.some(([p]) => p === "/api/calendar/google/connect")).toBe(true)
  })

  it("keeps the page's primary button on Add event; Connect Google Calendar is an ordinary button", async () => {
    mount(FACULTY, { google: READY })
    const connect = await screen.findByRole("button", { name: "Connect Google Calendar" })
    expect(connect.className).not.toContain("bg-action")
    expect(screen.getAllByRole("button", { name: /Add event/ })[0].className).toContain("bg-action")
  })

  it("shows who it is connected as, when it last synced, and Sync now and Disconnect", async () => {
    mount(FACULTY, { google: LINKED })
    expect(await screen.findByText("Connected as teacher@gmail.com")).toBeInTheDocument()
    expect(screen.getByText(/5 minutes ago/)).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Sync now" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Disconnect" })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Connect Google Calendar" })).toBeNull()
  })

  it("Sync now asks the server to sync", async () => {
    mount(FACULTY, { google: LINKED })
    await userEvent.click(await screen.findByRole("button", { name: "Sync now" }))
    await waitFor(() => expect(posted("/api/calendar/google/sync")).toHaveLength(1))
  })

  it("Disconnect asks first, and says what it removes", async () => {
    mount(FACULTY, { google: LINKED })
    await userEvent.click(await screen.findByRole("button", { name: "Disconnect" }))
    const dialog = await screen.findByRole("dialog")
    expect(within(dialog).getByText(/removes the .*Saveetha Publications.* calendar/i)).toBeInTheDocument()
    expect(posted("/api/calendar/google/disconnect")).toHaveLength(0)
    await userEvent.click(within(dialog).getByRole("button", { name: "Disconnect" }))
    await waitFor(() => expect(posted("/api/calendar/google/disconnect")).toHaveLength(1))
  })

  it("says when Google has ended the connection, and offers Connect again", async () => {
    mount(FACULTY, { google: LOST })
    expect(await screen.findByText(/Google no longer lets us in/)).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Connect again" })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Sync now" })).toBeNull()
  })

  it("shows a sync that slipped without pretending the connection is gone", async () => {
    mount(FACULTY, { google: SLIPPED })
    expect(await screen.findByText(/1 event could not be sent to Google/)).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Sync now" })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Connect again" })).toBeNull()
  })

  it("says plainly why a connect did not happen when Google sends them back", async () => {
    mount(FACULTY, {
      google: READY,
      route: "/calendar?view=month&date=2026-05-01&google=failed&why=You%20chose%20not%20to%20allow%20it%2C%20so%20nothing%20was%20connected.",
    })
    expect(await screen.findByText("You chose not to allow it, so nothing was connected.")).toBeInTheDocument()
  })

  it("never prints a reason somebody else wrote into the address", async () => {
    mount(FACULTY, {
      google: READY,
      route: "/calendar?view=month&date=2026-05-01&google=failed&why=Your%20account%20is%20locked.%20Call%20this%20number.",
    })
    expect(await screen.findByText("Google Calendar could not be connected. Please try again.")).toBeInTheDocument()
    expect(screen.queryByText(/Call this number/)).toBeNull()
  })
})

describe("Calendar on a phone", () => {
  function phone() {
    vi.spyOn(window, "matchMedia").mockImplementation(
      (query: string) =>
        ({
          matches: true,
          media: query,
          onchange: null,
          addListener: () => {},
          removeListener: () => {},
          addEventListener: () => {},
          removeEventListener: () => {},
          dispatchEvent: () => false,
        }) as MediaQueryList
    )
  }

  it("opens on the agenda, with today marked, and not on a grid", async () => {
    phone()
    const today = iso(new Date())
    mount(FACULTY, {
      route: "/calendar",
      results: [{ ...windowEvent, id: "t1", title: "Reviewer deadline", kind: "DEADLINE", starts_on: today, ends_on: null, visibility: "PRIVATE" }],
    })
    // The header's "Next:" line names it too; the agenda's row is the one inside a day.
    const rows = await screen.findAllByRole("button", { name: /Reviewer deadline/ })
    const row = rows.find((b) => b.closest("section"))!
    expect(row).toBeDefined()
    expect(screen.queryByRole("grid", { name: "Month" })).toBeNull()
    const day = row.closest("section")!
    expect(within(day).getByText("Today")).toBeInTheDocument()
    expect(screen.getByRole("radio", { name: "Agenda" })).toBeChecked()
  })

  it("keeps Add event one tap away", async () => {
    phone()
    mount(FACULTY, { route: "/calendar" })
    await screen.findByRole("radio", { name: "Agenda" })
    const fab = screen.getAllByRole("button", { name: "Add event" }).find((b) => b.className.includes("fixed"))
    expect(fab).toBeDefined()
  })
})

describe("what Sync now says", () => {
  it("names what it did, and says so when it is not finished", () => {
    const base = { created: 0, updated: 0, deleted: 0, failed: 0 }
    expect(syncMessage(base)).toBe("Your Google Calendar is already up to date.")
    expect(syncMessage({ ...base, created: 3, updated: 1 })).toBe("Synced: 3 added, 1 updated.")
    expect(syncMessage({ ...base, deleted: 2 })).toBe("Synced: 2 removed.")
    expect(syncMessage({ ...base, busy: true })).toMatch(/already running/)
    expect(syncMessage({ ...base, created: 1, partial: true })).toMatch(/Still syncing/)
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

  it("says payment, not payout, for the college's own dates and never rewrites a paper title", () => {
    const rec = { starts_on: "2026-06-01", count: 1, amount: null, claim_id: null, titles: [], whole_month: false }
    const items = toItems({
      start: "", end: "", kinds: [],
      results: [],
      record: [
        { ...rec, id: "r1", kind: "PAYOUT", kind_label: "Payout run", title: "College payout run" },
        { ...rec, id: "r2", kind: "CUTOFF", kind_label: "Filing cutoff", title: "Filing cutoff for this month's payout" },
        { ...rec, id: "r3", kind: "PUBLISHED", kind_label: "Published", title: "Payout models in game theory" },
      ],
    } as never)
    expect(items.map((i) => i.title)).toEqual([
      "College payment run",
      "Filing cutoff for this month's payment",
      "Payout models in game theory",
    ])
    expect(items[0].kindLabel).toBe("Payment run")
  })

  it("stacks overlapping items into separate lanes", () => {
    const items = toItems({
      start: "", end: "", kinds: [],
      results: [windowEvent, { ...windowEvent, id: "ev2", starts_on: "2026-05-12", ends_on: null }] as never,
    })
    const placed = lanes(items, "2026-05-11", "2026-05-17")
    expect(placed.map((p) => p.lane).sort()).toEqual([0, 1])
  })

  it("names every kind it knows, including the new ones, and calls anything else an Event", () => {
    expect(kindLabelOf("SEMINAR")).toBe("Seminar")
    expect(kindLabelOf("WORKSHOP")).toBe("Workshop")
    expect(kindLabelOf("CONFERENCE")).toBe("Conference")
    expect(kindLabelOf("FDP")).toBe("Faculty development programme")
    expect(kindLabelOf("CALL_FOR_PAPERS")).toBe("Call for papers")
    expect(kindLabelOf("PAYOUT_RUN")).toBe("Payment run")
    expect(kindLabelOf("HACKATHON")).toBe("Event")
  })

  it("gives every kind its own shape, so colour is never the only clue", () => {
    const kinds = ["DEADLINE", "SUBMISSION_WINDOW", "PAYOUT_RUN", "MEETING", "SEMINAR", "WORKSHOP", "CONFERENCE", "FDP", "CALL_FOR_PAPERS", "REMINDER", "OTHER"]
    const icons = kinds.map((k) => kindStyle(k).icon)
    expect(new Set(icons).size).toBe(kinds.length)
    // Unknown is the plain calendar, not a crash.
    expect(kindStyle("HACKATHON").icon).toBe(kindStyle("OTHER").icon)
  })

  it("says the time the way people read it", () => {
    expect(clock("14:30")).toBe("2:30 pm")
    expect(clock("09:00")).toBe("9:00 am")
    expect(clock("00:15")).toBe("12:15 am")
    expect(clock("12:00")).toBe("12:00 pm")
    expect(clock("14:30", true)).toBe("2:30pm")
    expect(clock("09:00", true)).toBe("9am")
  })

  it("says a span of days as short as it can", () => {
    const now = new Date(2026, 9, 7)
    expect(rangeLabel("2026-10-12", "2026-10-24", now)).toBe("12–24 Oct")
    expect(rangeLabel("2026-10-30", "2026-11-03", now)).toBe("30 Oct – 3 Nov")
    expect(rangeLabel("2026-12-30", "2027-01-02", now)).toBe("30 Dec 2026 – 2 Jan 2027")
    expect(rangeLabel("2026-10-12", "2026-10-12", now)).toBe("12 Oct")
    expect(rangeLabel("2027-02-01", "2027-02-01", now)).toBe("1 Feb 2027")
  })
})
