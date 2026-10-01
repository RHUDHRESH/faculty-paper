import { screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return { ...actual, api: vi.fn() }
})

import type { Me } from "@/app/auth"
import { api } from "@/lib/api"
import { AdminHub } from "@/pages/hub"
import { AdminHome } from "@/pages/home-admin"
import { fakeApi, renderWithProviders, type ApiTable } from "@/test/harness"

const ADMIN: Me = { id: "u-admin", email: "a@x.edu", name: "Suresh Admin", role: "SUPER_ADMIN", department: null }

const item = (over: Record<string, unknown>) => ({
  key: "k",
  job: "data",
  severity: "warning",
  title: "A thing",
  why: "Because.",
  to: "/faults",
  count: null,
  action: "Open faults",
  unit: null,
  ...over,
})

function mount(ui: React.ReactElement, extra: ApiTable = {}) {
  vi.mocked(api).mockReset()
  vi.mocked(api).mockImplementation((path: string, ...rest: unknown[]) =>
    fakeApi({
      "/api/auth/me": () => ADMIN,
      "/api/claims/counts": () => ({ counts: { filed: 14 } }),
      "/api/admin/clearing-queue": () => [],
      "/api/track": () => ({ stages: [], results: [], sees_money: true, sees_flags: true }),
      ...extra,
    })(path, ...(rest as []))
  )
  renderWithProviders(ui)
}

describe("the super admin's home", () => {
  it("lists what needs attention with real counts, units and one action each, and no job tag", async () => {
    mount(<AdminHome />, {
      "/api/admin/attention": () => ({
        checked_at: "",
        ok: ["A policy version is active"],
        items: [
          item({ key: "author_matches", title: "College author names nobody has matched", count: 2841, unit: "names", action: "Match names", to: "/people/matches" }),
          item({ key: "one", severity: "critical", title: "Paid with no ledger row", count: 1, unit: "claims", action: "Open faults" }),
        ],
      }),
    })
    expect(await screen.findByText("2 things need attention")).toBeInTheDocument()
    const rows = screen.getAllByTestId(/^attention-/)
    expect(rows).toHaveLength(2)
    // The real number, not "99+"; the unit agrees with the count.
    expect(within(rows[0]).getByText("2,841")).toBeInTheDocument()
    expect(within(rows[0]).getByText("names")).toBeInTheDocument()
    expect(within(rows[1]).getByText("claim")).toBeInTheDocument()
    // Words as well as colour for how urgent it is; never the internal job word.
    expect(within(rows[1]).getByText("Urgent")).toBeInTheDocument()
    expect(screen.queryByText("Running")).toBeNull()
    expect(rows[0]).toHaveAttribute("href", "/people/matches")
    expect(within(rows[0]).getAllByText("Match names").length).toBeGreaterThan(0)
  })

  it("shows five and lets the admin open the rest without leaving", async () => {
    const many = Array.from({ length: 8 }, (_, i) => item({ key: `k${i}`, title: `Thing ${i}` }))
    mount(<AdminHome />, { "/api/admin/attention": () => ({ checked_at: "", ok: [], items: many }) })
    expect(await screen.findByText("8 things need attention")).toBeInTheDocument()
    expect(screen.getAllByTestId(/^attention-/)).toHaveLength(5)
    await userEvent.click(screen.getByRole("button", { name: /Show 3 more/ }))
    expect(screen.getAllByTestId(/^attention-/)).toHaveLength(8)
  })

  it("says so when nothing needs attention", async () => {
    mount(<AdminHome />, { "/api/admin/attention": () => ({ checked_at: "", ok: ["A policy version is active"], items: [] }) })
    expect(await screen.findByText("Nothing needs you")).toBeInTheDocument()
  })
})

describe("the Admin page", () => {
  const readiness = {
    checked_at: "",
    ok: 1,
    total: 2,
    items: [
      { key: "desk_director", label: "Director desk has someone", ok: false, detail: "Nobody holds the Director role.", to: "/people?role=DIRECTOR", fix: "Give the Director role to someone", severity: "warning" },
      { key: "policy", label: "A policy is in force", ok: true, detail: "Policy v1 is in force.", to: "/policy", fix: "See the policy", severity: "warning" },
    ],
  }
  const fixes = {
    claims_needing_a_fix: 3,
    total: 3,
    queues: [{ key: "paid_no_amount", label: "Paid with no amount", why: "Lost in the import.", count: 3 }],
  }

  it("shows the readiness checklist with each red line linking to its fix, and the real hub counts", async () => {
    mount(<AdminHub />, {
      "/api/admin/hub": () => ({ counts: { "/people/matches": { count: 2841, tone: "caution", note: null } } }),
      "/api/admin/readiness": () => readiness,
      "/api/admin/data-fixes": () => fixes,
    })
    expect(await screen.findByText("1 of 2 checks are ready.")).toBeInTheDocument()
    const red = screen.getByTestId("ready-desk_director")
    expect(red).toHaveAttribute("href", "/people?role=DIRECTOR")
    expect(within(red).getByText("Not ready")).toBeInTheDocument()
    expect(within(screen.getByTestId("ready-policy")).getByText("Ready")).toBeInTheDocument()
    // The old cap is gone.
    expect(await screen.findByText("2,841")).toBeInTheDocument()
    expect(screen.queryByText("99+")).toBeNull()
    // The data-fix queue is listed and links to the fix page.
    expect(await screen.findByRole("link", { name: /Paid with no amount/ })).toHaveAttribute(
      "href",
      "/data/fixes?kind=paid_no_amount"
    )
  })
})
