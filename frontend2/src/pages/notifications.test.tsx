import { screen, waitFor, within, fireEvent } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return { ...actual, api: vi.fn() }
})

import { api } from "@/lib/api"
import { destinationFor, groupByDay, listPath, NotificationBell, readLabel } from "@/app/notifications"
import { NotificationSettings } from "@/pages/notification-settings"
import { NotificationsPage } from "@/pages/notifications"
import { fakeApi, FACULTY, renderWithProviders, type ApiTable } from "@/test/harness"

/**
 * Alerts a person can trust and control: every kind switched per person
 * (by email, in the app, or off), a bell that can be filtered and grouped,
 * and the Monday summary readable any day of the week as "This week".
 */

function stub(table: ApiTable) {
  vi.mocked(api).mockReset()
  vi.mocked(api).mockImplementation(fakeApi({ "/api/auth/me": () => FACULTY, ...table }))
}

function calls(prefix: string) {
  return vi.mocked(api).mock.calls.filter(([p]) => String(p).startsWith(prefix))
}

const PREFS = {
  email_available: true,
  whatsapp_available: false,
  email: "asha@college.edu",
  has_phone: true,
  count_my_visits: true,
  whatsapp_opt_in: false,
  levels: [
    { value: "email", label: "In the app and by email" },
    { value: "in_app", label: "In the app only" },
    { value: "off", label: "Off" },
  ],
  kinds: [
    {
      key: "claim_paid",
      label: "Paid",
      description: "When the incentive for a paper of yours is paid, with the amount.",
      group: "Your papers",
      level: "email",
      default: "email",
      whatsapp: true,
      can_turn_off: true,
    },
    {
      key: "mention",
      label: "Mentions",
      description: "When somebody names you in a post or a comment.",
      group: "People",
      level: "in_app",
      default: "in_app",
      whatsapp: false,
      can_turn_off: true,
    },
    {
      key: "moderation",
      label: "Your posts and reports",
      description: "When a post of yours is hidden. This one cannot be switched off.",
      group: "People",
      level: "in_app",
      default: "in_app",
      whatsapp: false,
      can_turn_off: false,
    },
  ],
}

describe("notification settings", () => {
  it("lists each kind under its heading with its current setting", async () => {
    stub({ "/api/notifications/preferences": () => PREFS })
    renderWithProviders(<NotificationSettings />, { route: "/settings/notifications" })
    const paidEmail = await screen.findByRole("switch", { name: "Paid: email" })
    expect(paidEmail).toHaveAttribute("aria-checked", "true")
    expect(screen.getByRole("switch", { name: "Mentions: email" })).toHaveAttribute("aria-checked", "false")
    expect(screen.getByRole("switch", { name: "Mentions: in app" })).toHaveAttribute("aria-checked", "true")
    expect(screen.getByRole("heading", { name: "Your papers" })).toBeInTheDocument()
    expect(screen.getByRole("heading", { name: "People" })).toBeInTheDocument()
  })

  it("saves a change at once, for that kind only", async () => {
    stub({ "/api/notifications/preferences": () => PREFS })
    renderWithProviders(<NotificationSettings />, { route: "/settings/notifications" })
    await userEvent.click(await screen.findByRole("switch", { name: "Mentions: in app" }))
    await waitFor(() => {
      const put = calls("/api/notifications/preferences").find(
        ([, o]) => (o as { method?: string })?.method === "PUT"
      )
      expect(put?.[1]).toMatchObject({ json: { levels: { mention: "off" } } })
    })
  })

  it("does not let you switch off what must always reach you", async () => {
    stub({ "/api/notifications/preferences": () => PREFS })
    renderWithProviders(<NotificationSettings />, { route: "/settings/notifications" })
    expect(await screen.findByRole("switch", { name: "Your posts and reports: in app" })).toBeDisabled()
  })

  it("says plainly when the college has no email set up, and offers the calendar feed", async () => {
    stub({
      "/api/notifications/preferences": () => ({ ...PREFS, email_available: false }),
      "/api/calendar/feed-link": () => ({ url: "https://x.edu/api/calendar/feed/tok.ics" }),
    })
    renderWithProviders(<NotificationSettings />, { route: "/settings/notifications" })
    // The email notice is one step away (it is not what she came to change); a faculty member
    // cannot set up a mail server, so it does not mention one.
    fireEvent.click(await screen.findByRole("button", { name: /about email/i }))
    expect(await screen.findByText(/Email is not switched on for the college yet/i)).toBeInTheDocument()
    expect(screen.queryByText(/SMTP/)).toBeNull()
    expect(await screen.findByDisplayValue("https://x.edu/api/calendar/feed/tok.ics")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Copy link" })).toBeEnabled()
  })

  it("lets the super admin send a test notification and says which channels are set up", async () => {
    const smtp = { configured: false, host: "", port: null, from_email: "x@y", line: "The mail server (SMTP) is not set up, so nothing is emailed yet." }
    stub({
      "/api/notifications/preferences": () => ({ ...PREFS, smtp }),
      "/api/notifications/test": () => ({
        in_app: { ok: true, message: "It is in your notifications now." },
        email: { configured: false, sent: false, message: smtp.line },
        whatsapp: { configured: false, has_phone: false, opted_in: false, sent: false, message: "WhatsApp is not set up (WHATSAPP_TOKEN and WHATSAPP_PHONE_ID)." },
        smtp,
      }),
    })
    renderWithProviders(<NotificationSettings />, { route: "/settings/notifications" })
    await userEvent.click(await screen.findByRole("button", { name: "Send me a test notification" }))
    const result = await screen.findByRole("status")
    expect(result).toHaveTextContent("It is in your notifications now.")
    expect(result).toHaveTextContent("not set up, so nothing is emailed")
    expect(result).toHaveTextContent("WhatsApp is not set up")
    expect(calls("/api/notifications/test")).toHaveLength(1)
  })

  it("shows no test panel to anybody else", async () => {
    stub({ "/api/notifications/preferences": () => PREFS })
    renderWithProviders(<NotificationSettings />, { route: "/settings/notifications" })
    await screen.findByText("Paid")
    expect(screen.queryByRole("button", { name: "Send me a test notification" })).toBeNull()
  })
})

const WEEK = {
  eligible: true,
  week_of: "28 September 2026",
  standing: { rank: 3, was: 5, of: 40, score: 9, line: "You are 3rd of 40 this academic year, up 2 places since last week." },
  department: {
    name: "Mechanical",
    count: 1,
    papers: [{ title: "Heat in thin walls", person: "Ravi Kumar", journal: "Thermal Science", href: "/papers/c9" }],
  },
  collaborator: {
    id: "u7",
    name: "Kiran Rao",
    department: "Civil",
    why: "Publishes in Journal of Heat, as you do, in Civil.",
    href: "/u/u7",
  },
  open_items: [{ title: "My draft", state: "Draft, not filed yet", reason: "", href: "/papers/c1/edit" }],
  scoring: "The leaderboard's score.",
  level: "email",
}

const ROWS = [
  {
    id: "n1",
    title: "Asha and 2 others reacted to your post",
    body: null,
    href: "/discussions/p/p1",
    read: false,
    created_at: new Date().toISOString(),
    kind: "reaction",
    section: "people",
    count: 3,
    actors: ["Asha", "Ravi", "Meera"],
    emailed: false,
  },
]

describe("the notifications screen", () => {
  it("shows this week's summary on its own tab", async () => {
    stub({
      "/api/notifications/digest": () => WEEK,
      "/api/notifications": () => ROWS,
    })
    renderWithProviders(<NotificationsPage />, { route: "/notifications?tab=week" })
    expect(await screen.findByText(WEEK.standing.line)).toBeInTheDocument()
    expect(screen.getByText("Heat in thin walls")).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "Kiran Rao" })).toHaveAttribute("href", "/u/u7")
    expect(screen.getByText("My draft")).toBeInTheDocument()
  })

  it("filters by tab and marks that tab read", async () => {
    stub({
      "/api/notifications/read-all": () => ({ ok: true }),
      "/api/notifications": () => ROWS,
    })
    renderWithProviders(<NotificationsPage />, { route: "/notifications" })
    expect(await screen.findByText(ROWS[0].title)).toBeInTheDocument()
    await userEvent.click(screen.getByRole("tab", { name: "People" }))
    await waitFor(() => expect(calls("/api/notifications?section=people").length).toBeGreaterThan(0))
    await userEvent.click(await screen.findByRole("button", { name: "Mark all read" }))
    await waitFor(() => expect(calls("/api/notifications/read-all?section=people").length).toBe(1))
  })
})

describe("grouping and faces", () => {
  it("groups by Today, Earlier this week and Older", () => {
    const now = new Date(2026, 8, 30, 12) // a Wednesday
    const at = (d: number) => ({ created_at: new Date(2026, 8, d, 9).toISOString() })
    const groups = groupByDay([at(30), at(28), at(27)], now)
    expect(groups.map(([label, g]) => [label, g.length])).toEqual([
      ["Today", 1],
      ["Earlier this week", 1],
      ["Older", 1],
    ])
  })

  it("shows the actor's face and an unread dot", async () => {
    stub({
      "/api/notifications": () => [
        { ...ROWS[0], actor: { user_id: "u1", name: "Asha", initials: "A", photo_url: null } },
      ],
    })
    renderWithProviders(<NotificationsPage />, { route: "/notifications" })
    expect(await screen.findByText(ROWS[0].title)).toBeInTheDocument()
    // Unread says so in words, not only in colour.
    expect(screen.getAllByText("Unread").length).toBeGreaterThan(0)
    expect(screen.getAllByText("just now").length).toBeGreaterThan(0)
    expect(screen.getByRole("heading", { name: "Today" })).toBeInTheDocument()
  })

  it("says it in one sentence when there is nothing", async () => {
    stub({ "/api/notifications": () => [] })
    renderWithProviders(<NotificationsPage />, { route: "/notifications" })
    expect(await screen.findByText("You are all caught up.")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Mark all read" })).toBeNull()
  })
})

describe("the bell", () => {
  it("shows the unread count, filters by tab, and says how many a grouped line holds", async () => {
    stub({
      "/api/shell/badges": () => ({
        stage_counts: { counts: {} },
        notifications: { unread: 3 },
        dm: { unread: 0, conversations: 0 },
      }),
      "/api/notifications": () => ROWS,
    })
    renderWithProviders(<NotificationBell />)
    const bell = await screen.findByRole("button", { name: "Notifications, 3 unread" })
    await userEvent.click(bell)
    const panel = await screen.findByRole("dialog", { name: "Notifications" })
    expect(await within(panel).findByText(ROWS[0].title)).toBeInTheDocument()
    expect(within(panel).getByText("3")).toBeInTheDocument()
    await userEvent.click(within(panel).getByRole("tab", { name: "Papers" }))
    await waitFor(() => expect(calls("/api/notifications?section=papers").length).toBeGreaterThan(0))
    expect(within(panel).getByRole("link", { name: "Settings" })).toHaveAttribute("href", "/settings/notifications")
  })

  it("reads the badge again once everything is marked read, and takes no count request of its own", async () => {
    stub({
      "/api/shell/badges": () => ({
        stage_counts: { counts: {} },
        notifications: { unread: 3 },
        dm: { unread: 0, conversations: 0 },
      }),
      "/api/notifications/read-all": () => ({ ok: true }),
      "/api/notifications": () => ROWS,
    })
    renderWithProviders(<NotificationBell />)
    await userEvent.click(await screen.findByRole("button", { name: "Notifications, 3 unread" }))
    const panel = await screen.findByRole("dialog", { name: "Notifications" })
    await within(panel).findByText(ROWS[0].title)
    expect(calls("/api/shell/badges")).toHaveLength(1)
    expect(calls("/api/notifications/unread-count")).toHaveLength(0)

    await userEvent.click(within(panel).getByRole("button", { name: /Mark all read/ }))
    await waitFor(() => expect(calls("/api/shell/badges")).toHaveLength(2))
  })
})


const SENT_BACK = {
  id: "n2",
  title: "FP-2026-000009 · Sent back to you",
  body: "Attach the paper as a PDF.",
  href: "/papers/c9",
  read: false,
  read_at: null,
  created_at: new Date().toISOString(),
  kind: "claim_sent_back",
  section: "papers",
  count: 1,
  actors: [],
  emailed: false,
}
const READ_ONE = {
  ...SENT_BACK,
  id: "n3",
  title: "FP-2026-000008 · Paid",
  body: "₹5,000 for your paper has been paid.",
  href: "/papers/c8",
  read: true,
  read_at: "2026-11-12T09:00:00Z",
  kind: "claim_paid",
}
const READ_OLD = { ...READ_ONE, id: "n4", title: "An old one", read_at: null }
const DELETED = { ...SENT_BACK, id: "n5", title: "FP-2026-000001 · On hold", href: null, gone: true, read: true }

function badges(unread: number) {
  return { stage_counts: { counts: {} }, notifications: { unread }, dm: { unread: 0, conversations: 0 } }
}

describe("rows you can trust", () => {
  it("reads every row plainly: unread marked in words, read with its date or just Read, never Not recorded", async () => {
    stub({ "/api/shell/badges": () => badges(1), "/api/notifications": () => [SENT_BACK, READ_ONE, READ_OLD] })
    renderWithProviders(<NotificationsPage />, { route: "/notifications" })
    await screen.findByText(SENT_BACK.title)
    expect(screen.getAllByText("Unread").length).toBeGreaterThan(0)
    expect(screen.getAllByText(readLabel(READ_ONE)).length).toBeGreaterThan(0)
    expect(readLabel(READ_ONE)).toMatch(/^Read 1\d Nov$/)
    expect(screen.getAllByText("Read").length).toBeGreaterThan(0)
    expect(screen.queryByText(/Not recorded/)).toBeNull()
    // Read rows are not faded: no opacity, no disabled look.
    const readRow = screen.getByText(READ_ONE.title).closest("a")!
    expect(readRow.className).not.toMatch(/opacity|pointer-events-none/)
  })

  it("each row links to what it is about, and opening it marks it read", async () => {
    stub({
      "/api/shell/badges": () => badges(1),
      "/api/notifications/n2/read": () => ({ ok: true, unread: 0 }),
      "/api/notifications": () => [SENT_BACK],
    })
    renderWithProviders(<NotificationsPage />, { route: "/notifications" })
    const link = await screen.findByRole("link", { name: new RegExp(SENT_BACK.title) })
    expect(link).toHaveAttribute("href", "/papers/c9")
    await userEvent.click(link)
    await waitFor(() => expect(calls("/api/notifications/n2/read")).toHaveLength(1))
  })

  it("a row about something deleted says so, goes nowhere, and can still be read", async () => {
    stub({
      "/api/shell/badges": () => badges(0),
      "/api/notifications/n5/read": () => ({ ok: true, unread: 0 }),
      "/api/notifications": () => [{ ...DELETED, read: false }],
    })
    renderWithProviders(<NotificationsPage />, { route: "/notifications" })
    const title = await screen.findByText(DELETED.title)
    expect(screen.getByText("No longer available.")).toBeInTheDocument()
    expect(title.closest("a")).toBeNull()
    await userEvent.click(title)
    await waitFor(() => expect(calls("/api/notifications/n5/read")).toHaveLength(1))
  })

  it("filters read and unread on the server and says so in one sentence when none match", async () => {
    stub({
      "/api/shell/badges": () => badges(1),
      "/api/notifications": (path) => (path.includes("state=read") ? [] : [SENT_BACK, READ_ONE]),
    })
    renderWithProviders(<NotificationsPage />, { route: "/notifications" })
    await screen.findByText(SENT_BACK.title)
    await userEvent.click(screen.getByRole("button", { name: "Unread" }))
    await waitFor(() => expect(calls("/api/notifications?state=unread").length).toBeGreaterThan(0))
    await userEvent.click(screen.getByRole("button", { name: "Read" }))
    await waitFor(() => expect(calls("/api/notifications?state=read").length).toBeGreaterThan(0))
    expect(await screen.findByText("Nothing has been read yet.")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Mark all read" })).toBeNull()
  })

  it("shows Mark all read as a live button only when something is unread, and it works", async () => {
    let unread = 2
    stub({
      "/api/shell/badges": () => badges(unread),
      "/api/notifications/read-all": () => {
        unread = 0
        return { ok: true, marked: 2, unread: 0 }
      },
      "/api/notifications": () => [SENT_BACK, { ...SENT_BACK, id: "n6", title: "Second" }],
    })
    renderWithProviders(<NotificationsPage />, { route: "/notifications" })
    const button = await screen.findByRole("button", { name: "Mark all read" })
    expect(button).toBeEnabled()
    expect(await screen.findByText("2 unread.")).toBeInTheDocument()
    await userEvent.click(button)
    await waitFor(() => expect(calls("/api/notifications/read-all")).toHaveLength(1))
    expect(await screen.findByText("Nothing unread.")).toBeInTheDocument()
  })

  it("asks for one row more than it shows, and offers older ones", async () => {
    const many = Array.from({ length: 31 }, (_, i) => ({ ...READ_ONE, id: "m" + i, title: "Row " + i }))
    stub({ "/api/shell/badges": () => badges(0), "/api/notifications": () => many })
    renderWithProviders(<NotificationsPage />, { route: "/notifications" })
    await screen.findByText("Row 0")
    expect(calls("/api/notifications?limit=31").length).toBeGreaterThan(0)
    expect(screen.queryByText("Row 30")).toBeNull()
    await userEvent.click(screen.getByRole("button", { name: "Show older" }))
    await waitFor(() => expect(calls("/api/notifications?limit=61").length).toBeGreaterThan(0))
  })
})

describe("the badge", () => {
  it("drops at once when a row is read, on the bell and the heading, without a reload", async () => {
    let unread = 2
    stub({
      "/api/shell/badges": () => badges(unread),
      "/api/notifications/n2/read": () => {
        unread = 1
        return { ok: true, unread: 1 }
      },
      "/api/notifications": () => [SENT_BACK, { ...SENT_BACK, id: "n6", title: "Second" }],
    })
    renderWithProviders(
      <>
        <NotificationBell />
        <NotificationsPage />
      </>,
      { route: "/notifications" }
    )
    expect(await screen.findByRole("button", { name: "Notifications, 2 unread" })).toBeInTheDocument()
    await userEvent.click(await screen.findByRole("link", { name: new RegExp(SENT_BACK.title) }))
    expect(await screen.findByRole("button", { name: "Notifications, 1 unread" })).toBeInTheDocument()
    expect(await screen.findByText("1 unread.")).toBeInTheDocument()
  })

  it("asks for lists by tab, read state and size", () => {
    expect(listPath("", "unread", 31)).toBe("/api/notifications?state=unread&limit=31")
    expect(listPath("papers", "")).toBe("/api/notifications?section=papers")
    expect(listPath("")).toBe("/api/notifications")
  })
})

describe("the bell panel", () => {
  it("hangs from the bell and ends at its right edge, so it is never above the top of the screen", async () => {
    stub({ "/api/shell/badges": () => badges(1), "/api/notifications": () => [SENT_BACK] })
    renderWithProviders(<NotificationBell />)
    await userEvent.click(await screen.findByRole("button", { name: "Notifications, 1 unread" }))
    const panel = await screen.findByRole("dialog", { name: "Notifications" })
    expect(panel.className).toMatch(/\btop-full\b/)
    expect(panel.className).toMatch(/\bright-0\b/)
    expect(panel.className).not.toMatch(/bottom-full/)
  })

  it("says a deleted subject is gone, still lets it be read, and does not navigate", async () => {
    stub({
      "/api/shell/badges": () => badges(1),
      "/api/notifications/n5/read": () => ({ ok: true, unread: 0 }),
      "/api/notifications": () => [{ ...DELETED, read: false }],
    })
    renderWithProviders(<NotificationBell />)
    await userEvent.click(await screen.findByRole("button", { name: "Notifications, 1 unread" }))
    const panel = await screen.findByRole("dialog", { name: "Notifications" })
    expect(await within(panel).findByText("No longer available.")).toBeInTheDocument()
    await userEvent.click(within(panel).getByText(DELETED.title))
    await waitFor(() => expect(calls("/api/notifications/n5/read")).toHaveLength(1))
    expect(screen.getByRole("dialog", { name: "Notifications" })).toBeInTheDocument()
  })
})

describe("where each alert leads", () => {
  const CLAIM = "c".repeat(32)
  it("a paper opens the paper", () => {
    expect(destinationFor(`/papers/${CLAIM}`, "FACULTY")).toBe(`/papers/${CLAIM}`)
  })
  it("a desk alert opens the paper in the review page, with the queue it came from", () => {
    expect(destinationFor(`/admin/clearing?claim=${CLAIM}`, "SUPER_ADMIN")).toBe(`/review/${CLAIM}?queue=clearing`)
    expect(destinationFor(`/principal?claim=${CLAIM}`, "PRINCIPAL")).toBe(`/review/${CLAIM}?queue=approvals`)
    expect(destinationFor(`/approvals?claim=${CLAIM}`, "PRINCIPAL")).toBe(`/review/${CLAIM}?queue=approvals`)
    expect(destinationFor(`/authorisations?claim=${CLAIM}`, "DIRECTOR")).toBe(`/review/${CLAIM}?queue=authorisations`)
  })
  it("Finance, who has no review page, goes to what it pays", () => {
    expect(destinationFor(`/finance?claim=${CLAIM}`, "FINANCE")).toBe(`/payments?claim=${CLAIM}`)
  })
  it("older paths still land on a page that exists", () => {
    expect(destinationFor("/admin/profile-requests", "SUPER_ADMIN")).toBe("/requests")
    expect(destinationFor("/faculty/profile", "FACULTY")).toBe("/me")
    expect(destinationFor("/finance", "FINANCE")).toBe("/payments")
  })
  it("people, posts, chats, events, flags, batches and imports keep their own addresses", () => {
    for (const href of [
      "/u/abc", "/discussions/p/abc", "/discussions/abc", "/messages/c/abc", "/events?event=abc",
      "/flags?claim=abc", "/batches/abc", "/imports", "/papers", "/me", "/notifications?tab=week", "/safeguards",
    ]) {
      expect(destinationFor(href, "SUPER_ADMIN")).toBe(href)
    }
  })
  it("no link, no destination", () => {
    expect(destinationFor(null)).toBeNull()
  })
})
