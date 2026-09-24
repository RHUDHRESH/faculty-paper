import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return { ...actual, api: vi.fn() }
})

import { api } from "@/lib/api"
import { NotificationBell } from "@/app/notifications"
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
    const paid = await screen.findByRole("radiogroup", { name: "Paid" })
    expect(within(paid).getByRole("radio", { name: "By email too" })).toHaveAttribute("aria-checked", "true")
    expect(screen.getByRole("heading", { name: "Your papers" })).toBeInTheDocument()
    expect(screen.getByRole("heading", { name: "People" })).toBeInTheDocument()
  })

  it("saves a change at once, for that kind only", async () => {
    stub({ "/api/notifications/preferences": () => PREFS })
    renderWithProviders(<NotificationSettings />, { route: "/settings/notifications" })
    const mentions = await screen.findByRole("radiogroup", { name: "Mentions" })
    await userEvent.click(within(mentions).getByRole("radio", { name: "Off" }))
    await waitFor(() => {
      const put = calls("/api/notifications/preferences").find(
        ([, o]) => (o as { method?: string })?.method === "PUT"
      )
      expect(put?.[1]).toMatchObject({ json: { levels: { mention: "off" } } })
    })
  })

  it("does not offer Off for what must always reach you", async () => {
    stub({ "/api/notifications/preferences": () => PREFS })
    renderWithProviders(<NotificationSettings />, { route: "/settings/notifications" })
    const mod = await screen.findByRole("radiogroup", { name: "Your posts and reports" })
    expect(within(mod).queryByRole("radio", { name: "Off" })).toBeNull()
  })

  it("says plainly when the college has no email set up", async () => {
    stub({ "/api/notifications/preferences": () => ({ ...PREFS, email_available: false }) })
    renderWithProviders(<NotificationSettings />, { route: "/settings/notifications" })
    expect(await screen.findByText(/email is not set up here yet/i)).toBeInTheDocument()
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

  it("filters by tab and marks everything read", async () => {
    stub({
      "/api/notifications/read-all": () => ({ ok: true }),
      "/api/notifications": () => ROWS,
    })
    renderWithProviders(<NotificationsPage />, { route: "/notifications" })
    expect(await screen.findByText(ROWS[0].title)).toBeInTheDocument()
    await userEvent.click(screen.getByRole("tab", { name: "People" }))
    await waitFor(() => expect(calls("/api/notifications?section=people").length).toBeGreaterThan(0))
    await userEvent.click(screen.getByRole("button", { name: "Mark all read" }))
    await waitFor(() => expect(calls("/api/notifications/read-all").length).toBe(1))
  })
})

describe("the bell", () => {
  it("shows the unread count, filters by tab, and says how many a grouped line holds", async () => {
    stub({
      "/api/notifications/unread-count": () => ({ unread: 3 }),
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
})
