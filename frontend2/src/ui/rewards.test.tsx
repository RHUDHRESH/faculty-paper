import { screen, waitFor, within } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return { ...actual, api: vi.fn() }
})

import { api } from "@/lib/api"
import { BadgeShelf, type Badge } from "@/ui/badge-shelf"
import { Celebrations } from "@/ui/celebrations"
import { GoalRings, type Goal } from "@/ui/goal-rings"
import { FACULTY, failing, fakeApi, renderWithProviders, type ApiTable } from "@/test/harness"

/**
 * The three pieces other pages mount with one line: a badge shelf, the
 * one-time celebration, and goal rings. Each must fetch its own data, and
 * each must draw nothing when its request fails -- they sit on pages whose
 * real job is something else, and must never be the thing that makes those
 * pages look broken.
 */

function badge(over: Partial<Badge> = {}): Badge {
  return {
    id: "b1",
    kind: "FIRST_Q1",
    key: "FIRST_Q1",
    label: "First Q1 paper",
    description: "A paper in a top-quartile journal.",
    detail: "",
    earned_on: "2024-03-01",
    evidence: { title: "Thin films under strain", journal: "Nature Photonics", year: 2024 },
    claim_id: null,
    ...over,
  }
}

function goal(over: Partial<Goal> = {}): Goal {
  return {
    metric: "PAPERS",
    label: "Papers",
    target: 4,
    done: 3,
    available: true,
    fraction: 0.75,
    met: false,
    built_in: false,
    ...over,
  }
}

function mount(ui: React.ReactElement, table: ApiTable) {
  vi.mocked(api).mockReset()
  vi.mocked(api).mockImplementation(fakeApi({ "/api/auth/me": () => FACULTY, ...table }))
  return renderWithProviders(ui)
}

describe("BadgeShelf", () => {
  it("names the paper each badge was earned by, and the month", async () => {
    mount(<BadgeShelf userId="u-2" />, {
      "/api/users/u-2/badges": () => ({ user: {}, badges: [badge()], catalogue: [] }),
    })
    const shelf = await screen.findByRole("region", { name: "Badges" })
    expect(await within(shelf).findByText("First Q1 paper")).toBeInTheDocument()
    expect(within(shelf).getByText("Thin films under strain")).toBeInTheDocument()
    expect(within(shelf).getByText("Mar 2024")).toBeInTheDocument()
  })

  it("links the owner's own badge to the claim that earned it", async () => {
    mount(<BadgeShelf userId="u-faculty" own />, {
      "/api/users/u-faculty/badges": () => ({ user: {}, badges: [badge({ claim_id: "c9" })], catalogue: [] }),
    })
    const link = await screen.findByRole("link", { name: "Thin films under strain" })
    expect(link).toHaveAttribute("href", "/papers/c9")
  })

  it("draws nothing on somebody else's page when they have no badges", async () => {
    const { container } = mount(<BadgeShelf userId="u-2" />, {
      "/api/users/u-2/badges": () => ({ user: {}, badges: [], catalogue: [] }),
    })
    await waitFor(() => expect(vi.mocked(api)).toHaveBeenCalledWith("/api/users/u-2/badges"))
    await waitFor(() => expect(container.querySelector("section")).toBeNull())
  })

  it("says how badges are earned on the person's own page", async () => {
    mount(<BadgeShelf userId="u-faculty" own />, {
      "/api/users/u-faculty/badges": () => ({ user: {}, badges: [], catalogue: [] }),
    })
    expect(await screen.findByText(/No badges yet/)).toBeInTheDocument()
  })

  it("draws nothing at all when the request fails", async () => {
    const { container } = mount(<BadgeShelf userId="u-2" own />, {
      "/api/users/u-2/badges": failing(),
    })
    await waitFor(() => expect(vi.mocked(api)).toHaveBeenCalledWith("/api/users/u-2/badges"))
    await waitFor(() => expect(container.querySelector("section")).toBeNull())
    expect(screen.queryByText(/could not/i)).toBeNull()
  })
})

describe("Celebrations", () => {
  const ITEM = {
    id: "cel1",
    kind: "BADGE",
    title: "New badge: First Q1 paper",
    body: "Thin films under strain",
    created_at: "2026-09-20T10:00:00Z",
    badge: badge(),
  }

  it("shows the news once and tells the server it has been shown", async () => {
    const seen = vi.fn(() => ({ ok: true, marked: 1 }))
    mount(<Celebrations />, {
      "/api/me/celebrations/seen": seen,
      "/api/me/celebrations": () => ({ celebrations: [ITEM] }),
    })
    expect(await screen.findByText("New badge: First Q1 paper")).toBeInTheDocument()
    await waitFor(() =>
      expect(vi.mocked(api)).toHaveBeenCalledWith("/api/me/celebrations/seen", {
        method: "POST",
        json: { ids: ["cel1"] },
      })
    )
  })

  it("does not use it up while a super admin is viewing as the person", async () => {
    mount(<Celebrations />, {
      "/api/auth/me": () => ({ ...FACULTY, impersonated_by: { id: "a", name: "Admin", email: "a@x" } }),
      "/api/me/celebrations": () => ({ celebrations: [ITEM] }),
    })
    expect(await screen.findByText("New badge: First Q1 paper")).toBeInTheDocument()
    expect(vi.mocked(api)).not.toHaveBeenCalledWith("/api/me/celebrations/seen", expect.anything())
  })

  it("draws nothing when there is nothing to celebrate", async () => {
    const { container } = mount(<Celebrations />, {
      "/api/me/celebrations": () => ({ celebrations: [] }),
    })
    await waitFor(() => expect(vi.mocked(api)).toHaveBeenCalledWith("/api/me/celebrations"))
    expect(container.querySelector("section")).toBeNull()
  })
})

describe("GoalRings", () => {
  it("writes the numbers beside every ring, and says when one is met", async () => {
    mount(<GoalRings />, {
      "/api/me/goals": () => ({
        year: 2026,
        years: [2026],
        goals: [goal(), goal({ metric: "Q1", label: "Q1 papers", target: 1, done: 1, fraction: 1, met: true })],
        metrics: [],
        citations_available: false,
      }),
    })
    expect(await screen.findByRole("img", { name: "Papers: 3 of 4" })).toBeInTheDocument()
    expect(screen.getByText("1 of 1 · met")).toBeInTheDocument()
  })

  it("offers to set goals when there are none, and nags about nothing", async () => {
    mount(<GoalRings />, {
      "/api/me/goals": () => ({ year: 2026, years: [2026], goals: [], metrics: [], citations_available: false }),
    })
    expect(await screen.findByRole("link", { name: "Set goals" })).toHaveAttribute("href", "/goals")
  })

  it("says a citation goal is not counted yet rather than showing zero", async () => {
    mount(<GoalRings />, {
      "/api/me/goals": () => ({
        year: 2026,
        years: [2026],
        goals: [goal({ metric: "CITATIONS", label: "Citations", done: null, available: false, fraction: null })],
        metrics: [],
        citations_available: false,
      }),
    })
    expect(await screen.findByRole("img", { name: "Citations: Not counted yet" })).toBeInTheDocument()
  })
})
