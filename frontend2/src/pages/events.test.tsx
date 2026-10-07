import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return { ...actual, api: vi.fn() }
})

import { api, ApiError } from "@/lib/api"
import { Events } from "@/pages/events"
import type { EventsPayload, HubEvent } from "@/pages/events-model"
import { CALL, CONFERENCE, FDP, PAST, SEMINAR, WORKSHOP, ev, highlights, listing } from "@/test/events-fixtures"
import { FACULTY, renderWithProviders } from "@/test/harness"

/**
 * The page that makes seminars visible. These pin what a teacher needs from it:
 * what is on this week at the top, the rest by month, narrowing it down, saying
 * they are going, putting it in their own calendar, and posting one of their own.
 */

type Call = { path: string; method: string; body?: Record<string, unknown> }

type Setup = {
  week?: HubEvent[]
  upcoming?: HubEvent[]
  past?: HubEvent[]
  over?: Partial<EventsPayload>
  /** Answers a write; return nothing for a plain success. */
  write?: (call: Call) => unknown
  fail?: boolean
}

function mount(setup: Setup = {}, route = "/events") {
  const week = setup.week ?? [SEMINAR, WORKSHOP]
  const upcoming = setup.upcoming ?? [SEMINAR, WORKSHOP, CALL, CONFERENCE, FDP]
  const past = setup.past ?? [PAST]
  const calls: Call[] = []
  vi.mocked(api).mockReset()
  vi.mocked(api).mockImplementation((async (path: string, options?: { method?: string; json?: Record<string, unknown> }) => {
    const call: Call = { path, method: options?.method ?? "GET", body: options?.json }
    calls.push(call)
    if (path === "/api/auth/me") return FACULTY
    if (path.startsWith("/api/research/highlights")) return highlights()
    if (call.method !== "GET") {
      const out = setup.write?.(call)
      if (out !== undefined) return out
      if (path.endsWith("/going")) return { going: call.method === "POST", going_count: call.method === "POST" ? 5 : 3 }
      return ev({ id: "ev-new", title: String(call.body?.title ?? "New") })
    }
    if (path.startsWith("/api/events?")) {
      if (setup.fail) throw new ApiError(500, "The server did not answer")
      const when = new URL(path, "http://x").searchParams.get("when")
      const rows = when === "week" ? week : when === "past" ? past : upcoming
      return listing(rows, { when: when ?? "upcoming", ...setup.over })
    }
    throw new ApiError(404, `No handler in this test for ${path}`)
  }) as unknown as typeof api)
  const view = renderWithProviders(<Events />, { route })
  return { calls, ...view }
}

const asked = (calls: Call[], needle: string) => calls.filter((c) => c.method === "GET" && c.path.includes(needle))
const card = (title: string) => screen.findByRole("article", { name: title })

describe("Events page: what is on", () => {
  it("is called Events and research, and offers the two halves", async () => {
    mount()
    expect(await screen.findByRole("heading", { level: 1, name: "Events and research" })).toBeInTheDocument()
    const choice = screen.getByRole("radiogroup", { name: "Show" })
    expect(within(choice).getByRole("radio", { name: "Events" })).toBeChecked()
    expect(within(choice).getByRole("radio", { name: "Research showcase" })).not.toBeChecked()
  })

  it("puts this week first, with the day, the time, the place and the speaker", async () => {
    mount()
    const week = await screen.findByRole("region", { name: "This week" })
    const seminar = within(week).getByRole("article", { name: SEMINAR.title })
    expect(seminar).toHaveTextContent("Thu")
    expect(seminar).toHaveTextContent("8")
    expect(seminar).toHaveTextContent("Seminar")
    expect(seminar).toHaveTextContent("3 to 4 pm")
    expect(seminar).toHaveTextContent("Seminar Hall 2")
    expect(seminar).toHaveTextContent("Dr Leela Nair")
    expect(within(week).getByRole("article", { name: WORKSHOP.title })).toHaveTextContent("9:30 am to 12:30 pm")
  })

  it("lists the rest by month, soonest first, without repeating what is already on this week", async () => {
    mount()
    const october = await screen.findByRole("region", { name: "October 2026" })
    const titles = within(october).getAllByRole("article").map((a) => a.getAttribute("aria-label"))
    expect(titles).toEqual([CALL.title, CONFERENCE.title])
    expect(within(october).queryByText(SEMINAR.title)).toBeNull()
    expect(within(await screen.findByRole("region", { name: "November 2026" })).getByRole("article", { name: FDP.title })).toBeInTheDocument()
  })

  it("says how many days are left to send to a call for papers", async () => {
    mount()
    expect(await card(CALL.title)).toHaveTextContent("12 days left")
    expect(await card(CALL.title)).toHaveTextContent("Closes Monday 19 Oct")
  })

  it("shows a run of days on one tile", async () => {
    mount()
    expect(await card(CONFERENCE.title)).toHaveTextContent("22–24")
  })

})

describe("Events page: narrowing it down", () => {
  it("offers a chip for each kind with how many there are, and filters by it", async () => {
    const user = userEvent.setup()
    const { calls } = mount()
    await screen.findByRole("region", { name: "This week" })
    const seminarChip = screen.getByRole("button", { name: /^Seminar\s*1$/ })
    expect(screen.getByRole("button", { name: /^All\s*5$/ })).toHaveAttribute("aria-pressed", "true")
    expect(screen.getByRole("button", { name: /^Call for papers\s*1$/ })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /^FDP\s*1$/ })).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: /^Workshop/ }))
    await waitFor(() => expect(screen.getByRole("button", { name: /^Workshop/ })).toHaveAttribute("aria-pressed", "true"))
    expect(seminarChip).toHaveAttribute("aria-pressed", "false")
    await waitFor(() => {
      expect(asked(calls, "when=week").some((c) => c.path.includes("kind=WORKSHOP"))).toBe(true)
      expect(asked(calls, "when=upcoming").some((c) => c.path.includes("kind=WORKSHOP"))).toBe(true)
    })
  })

  it("filters by department", async () => {
    const user = userEvent.setup()
    const { calls } = mount()
    await screen.findByRole("region", { name: "This week" })
    await user.selectOptions(screen.getByLabelText("Department"), "ECE")
    await waitFor(() => expect(asked(calls, "when=upcoming").some((c) => c.path.includes("department=ECE"))).toBe(true))
  })

  it("searches, once the person has stopped typing", async () => {
    const user = userEvent.setup()
    const { calls } = mount()
    await screen.findByRole("region", { name: "This week" })
    await user.type(screen.getByRole("searchbox", { name: "Search events" }), "power")
    await waitFor(() => expect(asked(calls, "when=upcoming").some((c) => c.path.includes("q=power"))).toBe(true))
    // Not one request per letter.
    expect(asked(calls, "when=upcoming").filter((c) => c.path.includes("q=")).length).toBeLessThan(5)
  })

  it("says so kindly, and offers to clear the filters, when nothing matches", async () => {
    const user = userEvent.setup()
    mount({ week: [], upcoming: [], over: { counts: {} } }, "/events?kind=WORKSHOP")
    expect(await screen.findByText("Nothing matches that")).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Clear the filters" }))
    await waitFor(() => expect(screen.queryByText("Nothing matches that")).toBeNull())
  })

  it("says the college has nothing on yet, and invites the first event, when there is nothing at all", async () => {
    mount({ week: [], upcoming: [] })
    expect(await screen.findByText("Nothing is on yet")).toBeInTheDocument()
    expect(screen.getAllByRole("button", { name: "Add an event" }).length).toBeGreaterThan(0)
  })

  it("says it could not load, rather than that there are no events, when the server did not answer", async () => {
    mount({ fail: true })
    expect(await screen.findByText("Could not load events")).toBeInTheDocument()
    expect(screen.queryByText("Nothing is on yet")).toBeNull()
  })
})

describe("Events page: going, and a calendar of your own", () => {
  it("says I'm going with one press, and the count follows what the server says", async () => {
    const user = userEvent.setup()
    const { calls } = mount()
    const seminar = await card(SEMINAR.title)
    expect(seminar).toHaveTextContent("4 going")
    const going = within(seminar).getByRole("button", { name: "I'm going" })
    expect(going).toHaveAttribute("aria-pressed", "false")
    await user.click(going)
    await waitFor(() => expect(within(seminar).getByRole("button", { name: "I'm going" })).toHaveAttribute("aria-pressed", "true"))
    expect(calls.find((c) => c.method === "POST")?.path).toBe(`/api/events/${SEMINAR.id}/going`)
    expect(seminar).toHaveTextContent("5 going")
  })

  it("takes it back with a second press", async () => {
    const user = userEvent.setup()
    const { calls } = mount()
    const workshop = await card(WORKSHOP.title)
    const going = within(workshop).getByRole("button", { name: "I'm going" })
    expect(going).toHaveAttribute("aria-pressed", "true")
    await user.click(going)
    await waitFor(() => expect(calls.some((c) => c.method === "DELETE" && c.path === `/api/events/${WORKSHOP.id}/going`)).toBe(true))
    await waitFor(() => expect(within(workshop).getByRole("button", { name: "I'm going" })).toHaveAttribute("aria-pressed", "false"))
  })

  it("adds to your own calendar with a link that downloads the one event", async () => {
    mount()
    const link = within(await card(SEMINAR.title)).getByRole("link", { name: "Add to my calendar" })
    expect(link).toHaveAttribute("href", `/api/events/${SEMINAR.id}.ics`)
    expect(link).toHaveAttribute("download")
  })
})

describe("Events page: more details", () => {
  it("opens a sheet with everything, and the link to register", async () => {
    const user = userEvent.setup()
    mount()
    await user.click(within(await card(WORKSHOP.title)).getByRole("button", { name: "More details" }))
    const sheet = await screen.findByRole("dialog")
    expect(within(sheet).getByText(WORKSHOP.title)).toBeInTheDocument()
    expect(sheet).toHaveTextContent("Saturday 10 Oct, 9:30 am to 12:30 pm")
    expect(sheet).toHaveTextContent("Library, first floor")
    expect(sheet).toHaveTextContent("The research office")
    expect(sheet).toHaveTextContent("Bring a draft.")
    expect(sheet).toHaveTextContent("Everybody at the college")
    expect(sheet).toHaveTextContent("12 going")
    const register = within(sheet).getByRole("link", { name: /Register or read more/ })
    expect(register).toHaveAttribute("href", "https://example.org/register")
    expect(register).toHaveAttribute("rel", expect.stringContaining("noopener"))
    expect(register).toHaveAttribute("target", "_blank")
  })

  it("opens by itself from a link in a notification", async () => {
    mount({}, `/events?event=${CONFERENCE.id}`)
    const sheet = await screen.findByRole("dialog")
    expect(within(sheet).getByText(CONFERENCE.title)).toBeInTheDocument()
    expect(sheet).toHaveTextContent("22 to 24 Oct")
  })

  it("lets only the person who posted it, or the office, change or remove it", async () => {
    const user = userEvent.setup()
    mount()
    await user.click(within(await card(SEMINAR.title)).getByRole("button", { name: "More details" }))
    let sheet = await screen.findByRole("dialog")
    expect(within(sheet).queryByRole("button", { name: "Edit" })).toBeNull()
    expect(within(sheet).queryByRole("button", { name: "Delete" })).toBeNull()
    await user.keyboard("{Escape}")
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
    await user.click(within(await card(WORKSHOP.title)).getByRole("button", { name: "More details" }))
    sheet = await screen.findByRole("dialog")
    expect(within(sheet).getByRole("button", { name: "Edit" })).toBeInTheDocument()
    expect(within(sheet).getByRole("button", { name: "Delete" })).toBeInTheDocument()
  })

  it("asks before it deletes, then does", async () => {
    const user = userEvent.setup()
    const { calls } = mount()
    await user.click(within(await card(WORKSHOP.title)).getByRole("button", { name: "More details" }))
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Delete" }))
    const confirm = await screen.findByRole("dialog", { name: "Delete this event?" })
    await user.click(within(confirm).getByRole("button", { name: "Delete it" }))
    await waitFor(() => expect(calls.some((c) => c.method === "DELETE" && c.path === `/api/events/${WORKSHOP.id}`)).toBe(true))
  })
})

describe("Events page: posting one", () => {
  it("has a button for it, and opens a form that is ready to go with only a title", async () => {
    const user = userEvent.setup()
    const { calls } = mount()
    await user.click(await screen.findByRole("button", { name: "Add an event" }))
    const dialog = await screen.findByRole("dialog", { name: "Add an event" })
    expect(within(dialog).getByLabelText("Kind")).toHaveValue("SEMINAR")
    // Tomorrow, at three: a seminar is usually in the afternoon, and the day is not today.
    expect(within(dialog).getByLabelText("Day")).toHaveValue("2026-10-08")
    expect(within(dialog).getByLabelText("From")).toHaveValue("15:00")
    expect(within(dialog).getByLabelText("To")).toHaveValue("16:00")
    expect(within(dialog).getByRole("radio", { name: "My department (Mechanical Engineering)" })).toBeChecked()
    const post = within(dialog).getByRole("button", { name: "Post event" })
    expect(post).toBeDisabled()
    await user.type(within(dialog).getByLabelText("Title"), "Seminar on grid storage")
    await user.type(within(dialog).getByLabelText("Venue"), "Seminar Hall 1")
    await user.type(within(dialog).getByLabelText("Speaker"), "Dr Leela Nair")
    expect(post).toBeEnabled()
    await user.click(post)
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.path === "/api/events")).toBe(true))
    const body = calls.find((c) => c.method === "POST" && c.path === "/api/events")?.body
    expect(body).toMatchObject({
      title: "Seminar on grid storage", kind: "SEMINAR", starts_on: "2026-10-08", starts_at: "15:00", ends_at: "16:00",
      all_day: false, venue: "Seminar Hall 1", speaker: "Dr Leela Nair", visibility: "DEPARTMENT",
    })
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Add an event" })).toBeNull())
  })

  it("offers the whole college only to somebody allowed to tell it", async () => {
    const user = userEvent.setup()
    mount({ over: { audiences: [{ key: "DEPARTMENT", label: "My department (Mechanical Engineering)" }] } })
    await user.click(await screen.findByRole("button", { name: "Add an event" }))
    const dialog = await screen.findByRole("dialog", { name: "Add an event" })
    expect(within(dialog).queryByRole("radio", { name: "The whole college" })).toBeNull()
  })

  it("posts for the whole college when that is chosen", async () => {
    const user = userEvent.setup()
    const { calls } = mount()
    await user.click(await screen.findByRole("button", { name: "Add an event" }))
    const dialog = await screen.findByRole("dialog", { name: "Add an event" })
    await user.type(within(dialog).getByLabelText("Title"), "Annual research day")
    await user.click(within(dialog).getByRole("radio", { name: "The whole college" }))
    await user.click(within(dialog).getByRole("button", { name: "Post event" }))
    await waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true))
    expect(calls.find((c) => c.method === "POST")?.body).toMatchObject({ visibility: "PUBLIC" })
  })

  it("asks the office which department, since they may post for any", async () => {
    const user = userEvent.setup()
    const { calls } = mount({ over: { can_pick_department: true } })
    await user.click(await screen.findByRole("button", { name: "Add an event" }))
    const dialog = await screen.findByRole("dialog", { name: "Add an event" })
    await user.type(within(dialog).getByLabelText("Title"), "CSE guest talk")
    await user.selectOptions(within(dialog).getByLabelText("Which department"), "CSE")
    await user.click(within(dialog).getByRole("button", { name: "Post event" }))
    await waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true))
    expect(calls.find((c) => c.method === "POST")?.body).toMatchObject({ visibility: "DEPARTMENT", department: "CSE" })
  })

  it("asks for a deadline, not a time, when it is a call for papers", async () => {
    const user = userEvent.setup()
    const { calls } = mount()
    await user.click(await screen.findByRole("button", { name: "Add an event" }))
    const dialog = await screen.findByRole("dialog", { name: "Add an event" })
    await user.selectOptions(within(dialog).getByLabelText("Kind"), "CALL_FOR_PAPERS")
    expect(within(dialog).getByLabelText("Deadline")).toBeInTheDocument()
    expect(within(dialog).queryByLabelText("From")).toBeNull()
    await user.type(within(dialog).getByLabelText("Title"), "Special issue on batteries")
    await user.click(within(dialog).getByRole("button", { name: "Post event" }))
    await waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true))
    expect(calls.find((c) => c.method === "POST")?.body).toMatchObject({ kind: "CALL_FOR_PAPERS", all_day: true })
  })

  it("does not offer it to somebody who may not post", async () => {
    mount({ over: { can_add: false, audiences: [] } })
    await screen.findByRole("region", { name: "This week" })
    expect(screen.queryByRole("button", { name: "Add an event" })).toBeNull()
  })

  it("shows what the server refused, and keeps the form", async () => {
    const user = userEvent.setup()
    mount({
      write: (call) => {
        if (call.method === "POST") throw new ApiError(403, "You can post for your own department.")
        return undefined
      },
    })
    await user.click(await screen.findByRole("button", { name: "Add an event" }))
    const dialog = await screen.findByRole("dialog", { name: "Add an event" })
    await user.type(within(dialog).getByLabelText("Title"), "Annual research day")
    await user.click(within(dialog).getByRole("button", { name: "Post event" }))
    expect(await within(dialog).findByText("You can post for your own department.")).toBeInTheDocument()
    expect(screen.getByRole("dialog", { name: "Add an event" })).toBeInTheDocument()
  })

  it("edits one that is yours, starting from what it says now", async () => {
    const user = userEvent.setup()
    const { calls } = mount()
    await user.click(within(await card(WORKSHOP.title)).getByRole("button", { name: "More details" }))
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Edit" }))
    const dialog = await screen.findByRole("dialog", { name: "Edit event" })
    expect(within(dialog).getByLabelText("Title")).toHaveValue(WORKSHOP.title)
    expect(within(dialog).getByLabelText("Venue")).toHaveValue("Library, first floor")
    expect(within(dialog).queryByRole("radio", { name: "The whole college" })).toBeNull()
    await user.clear(within(dialog).getByLabelText("Venue"))
    await user.type(within(dialog).getByLabelText("Venue"), "Room 5")
    await user.click(within(dialog).getByRole("button", { name: "Save changes" }))
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true))
    const patch = calls.find((c) => c.method === "PATCH")
    expect(patch?.path).toBe(`/api/events/${WORKSHOP.id}`)
    expect(patch?.body).toMatchObject({ title: WORKSHOP.title, venue: "Room 5", starts_at: "09:30" })
  })
})

describe("Events page: the ones that are over", () => {
  it("keeps them folded away, with how many seminars there have been this year", async () => {
    mount()
    await screen.findByRole("region", { name: "This week" })
    expect(screen.getByText("Seminars so far this year: 12")).toBeInTheDocument()
    expect(screen.queryByText(PAST.title)).toBeNull()
  })

  it("opens the archive on request, and only then asks for it", async () => {
    const user = userEvent.setup()
    const { calls } = mount()
    await screen.findByRole("region", { name: "This week" })
    expect(asked(calls, "when=past")).toHaveLength(0)
    await user.click(screen.getByRole("button", { name: "Past events" }))
    expect(await screen.findByText(PAST.title)).toBeInTheDocument()
    expect(asked(calls, "when=past").length).toBeGreaterThan(0)
    // Nothing to go to, so no "I'm going" on something that is over.
    expect(within(await card(PAST.title)).queryByRole("button", { name: "I'm going" })).toBeNull()
  })
})

describe("Events page: the two halves", () => {
  it("switches to the research showcase, and back", async () => {
    const user = userEvent.setup()
    mount()
    await screen.findByRole("region", { name: "This week" })
    await user.click(screen.getByRole("radio", { name: "Research showcase" }))
    await waitFor(() => expect(screen.getByRole("radio", { name: "Research showcase" })).toBeChecked())
    expect(screen.queryByRole("region", { name: "This week" })).toBeNull()
    expect(await screen.findByText("New in Q1 journals")).toBeInTheDocument()
    await user.click(screen.getByRole("radio", { name: "Events" }))
    expect(await screen.findByRole("region", { name: "This week" })).toBeInTheDocument()
  })
})
