import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return { ...actual, api: vi.fn() }
})
vi.mock("@/ui/toast", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/ui/toast")>()
  return { ...actual, toast: { ...actual.toast, ok: vi.fn(), fail: vi.fn() } }
})

import { api, ApiError } from "@/lib/api"
import { Events } from "@/pages/events"
import type { HubEvent, InvitePerson, InvitedPerson, PeoplePayload } from "@/pages/events-model"
import { SEMINAR, WORKSHOP, ev, highlights, listing } from "@/test/events-fixtures"
import { FACULTY, renderWithProviders } from "@/test/harness"
import { toast } from "@/ui/toast"

/**
 * Inviting people to an event, from the "More details" sheet of an editor.
 * These pin what the editor sees and presses, what is sent, and what the
 * invitee sees. The API is a stand-in; the contract is in events-model.ts.
 */

type Call = { path: string; method: string; body?: Record<string, unknown> }

const ASHA: InvitePerson = {
  id: "u-asha", name: "Asha Menon", department: "ECE", designation: null, photo_url: "https://example.org/asha.jpg",
  initials: "AM", why: "Two papers on power electronics", score: 0.9, papers_on_topic: 2, status: "none",
}
const RAVI: InvitePerson = {
  id: "u-ravi2", name: "Ravi Kumar", department: "CSE", designation: null, photo_url: null,
  initials: "RK", why: "Works on EV drives", score: 0.7, papers_on_topic: 1, status: "none",
}
const MEERA: InvitePerson = {
  id: "u-meera", name: "Meera Pillai", department: "ECE", designation: null, photo_url: null,
  initials: "MP", why: "Power converters", score: 0.6, papers_on_topic: 1, status: "invited",
}

type Setup = {
  people?: InvitePerson[]
  topics?: PeoplePayload["topics"]
  ai?: boolean
  counted?: boolean
  week?: HubEvent[]
  /** Answer for POST /invite. */
  invited?: number
  /** Make the people list refuse, e.g. 403 for a non-editor. */
  peopleError?: ApiError
  invitePost?: () => unknown
}

function peopleFor(setup: Setup): PeoplePayload {
  const people = setup.people ?? [ASHA, RAVI, MEERA]
  return {
    event_id: WORKSHOP.id,
    topics: setup.topics ?? [
      { name: "power electronics", papers: 3 },
      { name: "electric vehicles", papers: 1 },
    ],
    ai: setup.ai ?? false,
    counted: setup.counted ?? true,
    people,
    total: people.length,
  }
}

function mount(setup: Setup = {}) {
  const calls: Call[] = []
  const week = setup.week ?? [SEMINAR, WORKSHOP]
  vi.mocked(api).mockReset()
  vi.mocked(toast.ok).mockReset()
  vi.mocked(api).mockImplementation((async (path: string, options?: { method?: string; json?: Record<string, unknown> }) => {
    const call: Call = { path, method: options?.method ?? "GET", body: options?.json }
    calls.push(call)
    if (path === "/api/auth/me") return FACULTY
    if (path.startsWith("/api/research/highlights")) return highlights()
    if (path.startsWith("/api/events?")) {
      const when = new URL(path, "http://x").searchParams.get("when")
      // The page drops from the month list what is already on this week, so
      // upcoming carries the week too, as it does on the server.
      return listing(week, { when: when ?? "upcoming" })
    }
    if (path === `/api/events/${WORKSHOP.id}/people` || path.startsWith(`/api/events/${WORKSHOP.id}/people?`)) {
      if (setup.peopleError) throw setup.peopleError
      return peopleFor(setup)
    }
    if (path === `/api/events/${WORKSHOP.id}/invite` && call.method === "POST") {
      if (setup.invitePost) return setup.invitePost()
      return { invited: setup.invited ?? 2, already: 0, skipped: 0 }
    }
    if (path === `/api/events/${WORKSHOP.id}/invites`) {
      const people: InvitedPerson[] = [{
        id: "u-meera", name: "Meera Pillai", department: "ECE", photo_url: null, initials: "MP",
        invited_at: "2026-10-07T09:00:00", invited_by_name: "Dr Asha Menon", going: false,
      }]
      return { people, counts: { invited: 1, going: 0 } }
    }
    throw new ApiError(404, `No handler in this test for ${path}`)
  }) as unknown as typeof api)
  const view = renderWithProviders(<Events />, { route: "/events" })
  return { calls, ...view }
}

const postsTo = (calls: Call[]) => calls.filter((c) => c.method === "POST" && c.path.endsWith("/invite"))

/** Opens the "More details" sheet of one event in the week list. */
async function openSheet(user: ReturnType<typeof userEvent.setup>, title: string) {
  const card = await screen.findByRole("article", { name: title })
  await user.click(within(card).getByRole("button", { name: "More details" }))
  return screen.findByRole("dialog")
}

describe("Inviting people: who may", () => {
  it("shows the editor the way to find people to invite", async () => {
    const user = userEvent.setup()
    mount()
    const sheet = await openSheet(user, WORKSHOP.title)
    expect(within(sheet).getByRole("button", { name: "Find people to invite" })).toBeInTheDocument()
    expect(within(sheet).getByText("0 invited · 12 going")).toBeInTheDocument()
  })

  it("does not show it to somebody who did not post the event", async () => {
    const user = userEvent.setup()
    mount()
    const sheet = await openSheet(user, SEMINAR.title)
    expect(within(sheet).queryByRole("button", { name: "Find people to invite" })).toBeNull()
  })

  it("says so plainly when the server refuses the list", async () => {
    const user = userEvent.setup()
    mount({ peopleError: new ApiError(403, "Forbidden") })
    const sheet = await openSheet(user, WORKSHOP.title)
    await user.click(within(sheet).getByRole("button", { name: "Find people to invite" }))
    expect(await within(sheet).findByText("Only the person who posted this, or the office, can invite people to it.")).toBeInTheDocument()
  })
})

describe("Inviting people: the panel", () => {
  it("lists the people with a face, their department and why they fit", async () => {
    const user = userEvent.setup()
    mount()
    const sheet = await openSheet(user, WORKSHOP.title)
    await user.click(within(sheet).getByRole("button", { name: "Find people to invite" }))
    expect(await within(sheet).findByRole("checkbox", { name: "Invite Asha Menon" })).toBeInTheDocument()
    expect(within(sheet).getByText("Two papers on power electronics")).toBeInTheDocument()
    expect(within(sheet).getByText("Works on EV drives")).toBeInTheDocument()
    // A photo where there is one, initials where there is not.
    expect(sheet.querySelector('img[src="https://example.org/asha.jpg"]')).not.toBeNull()
    expect(within(sheet).getByText("RK")).toBeInTheDocument()
  })

  it("marks the ones already invited with a chip, not a checkbox", async () => {
    const user = userEvent.setup()
    mount()
    const sheet = await openSheet(user, WORKSHOP.title)
    await user.click(within(sheet).getByRole("button", { name: "Find people to invite" }))
    await within(sheet).findByRole("checkbox", { name: "Invite Asha Menon" })
    expect(within(sheet).queryByRole("checkbox", { name: "Invite Meera Pillai" })).toBeNull()
    expect(within(sheet).getByText("Invited")).toBeInTheDocument()
  })

  it("ticks two people and sends one invitation for both, then says so", async () => {
    const user = userEvent.setup()
    const { calls } = mount()
    const sheet = await openSheet(user, WORKSHOP.title)
    await user.click(within(sheet).getByRole("button", { name: "Find people to invite" }))
    await user.click(await within(sheet).findByRole("checkbox", { name: "Invite Asha Menon" }))
    await user.click(within(sheet).getByRole("checkbox", { name: "Invite Ravi Kumar" }))
    await user.click(within(sheet).getByRole("button", { name: "Invite 2 people" }))
    await waitFor(() => expect(postsTo(calls)).toHaveLength(1))
    expect(postsTo(calls)[0].path).toBe(`/api/events/${WORKSHOP.id}/invite`)
    expect(postsTo(calls)[0].body).toEqual({ user_ids: ["u-asha", "u-ravi2"] })
    await waitFor(() => expect(toast.ok).toHaveBeenCalledWith("Invited 2 people"))
  })

  it("asks for a tick before it lets anybody be invited", async () => {
    const user = userEvent.setup()
    mount()
    const sheet = await openSheet(user, WORKSHOP.title)
    await user.click(within(sheet).getByRole("button", { name: "Find people to invite" }))
    expect(await within(sheet).findByText("Tick the people to invite")).toBeInTheDocument()
    expect(within(sheet).getByRole("button", { name: "Invite people" })).toBeDisabled()
  })

  it("select all ticks only the people not yet invited", async () => {
    const user = userEvent.setup()
    mount()
    const sheet = await openSheet(user, WORKSHOP.title)
    await user.click(within(sheet).getByRole("button", { name: "Find people to invite" }))
    await user.click(await within(sheet).findByRole("button", { name: "Select all 3 shown" }))
    expect(within(sheet).getByRole("checkbox", { name: "Invite Asha Menon" })).toBeChecked()
    expect(within(sheet).getByRole("checkbox", { name: "Invite Ravi Kumar" })).toBeChecked()
    expect(within(sheet).getByRole("button", { name: "Invite 2 people" })).toBeEnabled()
  })

  it("says the people came from AI, and to check them, when the topic was not in the words", async () => {
    const user = userEvent.setup()
    mount({ ai: true, counted: false })
    const sheet = await openSheet(user, WORKSHOP.title)
    await user.click(within(sheet).getByRole("button", { name: "Find people to invite" }))
    expect(
      await within(sheet).findByText(
        "Matched by AI from the event's topic: power electronics, electric vehicles. Check the list before inviting."
      )
    ).toBeInTheDocument()
  })

  it("says the people matched the topic words when they were counted", async () => {
    const user = userEvent.setup()
    mount({ ai: false, counted: true })
    const sheet = await openSheet(user, WORKSHOP.title)
    await user.click(within(sheet).getByRole("button", { name: "Find people to invite" }))
    expect(
      await within(sheet).findByText("Matched by the event's topic words: power electronics, electric vehicles.")
    ).toBeInTheDocument()
  })

  it("names the first three topics and counts the rest", async () => {
    const user = userEvent.setup()
    mount({
      topics: [
        { name: "power electronics", papers: 3 },
        { name: "electric vehicles", papers: 2 },
        { name: "battery management", papers: 2 },
        { name: "motor drives", papers: 1 },
        { name: "solar inverters", papers: 1 },
      ],
    })
    const sheet = await openSheet(user, WORKSHOP.title)
    await user.click(within(sheet).getByRole("button", { name: "Find people to invite" }))
    expect(
      await within(sheet).findByText(
        "Matched by the event's topic words: power electronics, electric vehicles, battery management and 2 more."
      )
    ).toBeInTheDocument()
  })

  it("says nobody matched when there are no topics", async () => {
    const user = userEvent.setup()
    mount({ topics: [], people: [] })
    const sheet = await openSheet(user, WORKSHOP.title)
    await user.click(within(sheet).getByRole("button", { name: "Find people to invite" }))
    expect(
      await within(sheet).findByText(
        "No one matched this event's topic yet. Add a description with the topic, or search by name."
      )
    ).toBeInTheDocument()
  })
})

describe("Inviting people: who is invited, and the invitee", () => {
  it("lists who is invited, on request", async () => {
    const user = userEvent.setup()
    mount()
    const sheet = await openSheet(user, WORKSHOP.title)
    await user.click(within(sheet).getByRole("button", { name: "Show who is invited (0)" }))
    expect(await within(sheet).findByText("Meera Pillai")).toBeInTheDocument()
    expect(within(sheet).getByRole("button", { name: "Hide who is invited" })).toBeInTheDocument()
  })

  it("tells an invitee who asked them", async () => {
    const invited: HubEvent = ev({ ...WORKSHOP, can_edit: false, invited_by: { id: "u-ravi", name: "Dr Ravi Kumar" } })
    mount({ week: [invited] })
    const card = await screen.findByRole("article", { name: WORKSHOP.title })
    expect(within(card).getByText("Invited by Dr Ravi Kumar")).toBeInTheDocument()
  })
})
