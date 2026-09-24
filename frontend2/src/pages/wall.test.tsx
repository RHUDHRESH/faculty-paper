import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return { ...actual, api: vi.fn() }
})

import type { Me } from "@/app/auth"
import { api } from "@/lib/api"
import { ImpactCardPage } from "@/pages/impact"
import { WallOfFame, mayPin, type WallPayload } from "@/pages/wall"
import { FACULTY, HOD, fakeApi, renderWithProviders, type ApiTable } from "@/test/harness"

/**
 * The wall celebrates papers, a month at a time, with nothing about money on
 * it; only a department's own head chooses its paper of the month. The
 * impact card is private until its owner shares it, and the link it offers
 * is on this site's own address.
 */

const WALL: WallPayload = {
  department: "Physics",
  month: "2026-08",
  months: [
    { month: "2026-08", count: 2 },
    { month: "2026-07", count: 1 },
  ],
  pinned: null,
  cards: [
    {
      key: "shared paper",
      title: "Shared paper",
      journal: "Nature Photonics",
      quartile: "Q1",
      year: 2026,
      authors: [
        { id: "u1", name: "Asha Menon", department: "Physics" },
        { id: "u2", name: "Ravi Kumar", department: "Physics" },
      ],
      pinned: false,
    },
    {
      key: "second",
      title: "Second paper",
      journal: "Optics Letters",
      quartile: "Q2",
      year: 2026,
      authors: [{ id: "u3", name: "Meena Iyer", department: "Physics" }],
      pinned: false,
    },
  ],
  departments: ["Chemistry", "Physics"],
}

function mount(ui: React.ReactElement, me: Me, table: ApiTable) {
  vi.mocked(api).mockReset()
  vi.mocked(api).mockImplementation(fakeApi({ "/api/auth/me": () => me, ...table }))
  return renderWithProviders(ui)
}

describe("WallOfFame", () => {
  it("shows one card per paper, with every college author on it", async () => {
    mount(<WallOfFame />, HOD, { "/api/wall": () => WALL })
    const title = await screen.findByText("Shared paper")
    const card = title.closest("li") as HTMLElement
    expect(within(card).getByText("Asha Menon")).toBeInTheDocument()
    expect(within(card).getByText("Ravi Kumar")).toBeInTheDocument()
    expect(within(card).getByText("Q1")).toBeInTheDocument()
    expect(screen.queryByText(/₹/)).toBeNull()
  })

  it("opens on the reader's own department", async () => {
    mount(<WallOfFame />, HOD, { "/api/wall": () => WALL })
    await screen.findByText("Shared paper")
    expect(vi.mocked(api)).toHaveBeenCalledWith("/api/wall?department=Physics")
  })

  it("lets the department's head choose a paper of the month", async () => {
    const pin = vi.fn(() => ({ ok: true }))
    mount(<WallOfFame />, HOD, { "/api/wall/pin": pin, "/api/wall": () => WALL })
    await screen.findByText("Shared paper")
    await userEvent.click(screen.getAllByRole("button", { name: "Make paper of the month" })[0])
    await waitFor(() =>
      expect(vi.mocked(api)).toHaveBeenCalledWith("/api/wall/pin", {
        method: "POST",
        json: { department: "Physics", month: "2026-08", key: "shared paper" },
      })
    )
  })

  it("offers nobody else the pin", async () => {
    mount(<WallOfFame />, { ...FACULTY, department: "Physics" }, { "/api/wall": () => WALL })
    await screen.findByText("Shared paper")
    expect(screen.queryByRole("button", { name: "Make paper of the month" })).toBeNull()
  })

  it("puts the paper of the month first, under its own heading", async () => {
    const pinned = { ...WALL.cards[1], pinned: true }
    mount(<WallOfFame />, HOD, {
      "/api/wall": () => ({ ...WALL, pinned, cards: [pinned, WALL.cards[0]] }),
    })
    const lead = await screen.findByRole("region", { name: "Paper of the month" })
    expect(within(lead).getByText("Second paper")).toBeInTheDocument()
  })
})

describe("mayPin", () => {
  it("mirrors the server: own department's head, the Principal for the college, a super admin anywhere", () => {
    expect(mayPin(HOD, "Physics")).toBe(true)
    expect(mayPin(HOD, "physics")).toBe(true)
    expect(mayPin(HOD, "Chemistry")).toBe(false)
    expect(mayPin(HOD, "")).toBe(false)
    expect(mayPin({ ...FACULTY, department: "Physics" }, "Physics")).toBe(false)
    expect(mayPin({ ...FACULTY, role: "PRINCIPAL" }, "")).toBe(true)
    expect(mayPin({ ...FACULTY, role: "PRINCIPAL" }, "Physics")).toBe(false)
    expect(mayPin({ ...FACULTY, role: "SUPER_ADMIN" }, "Physics")).toBe(true)
  })
})

describe("ImpactCardPage", () => {
  const IMPACT = {
    name: FACULTY.name,
    designation: "Associate Professor",
    department: "Mechanical Engineering",
    college: "Saveetha Engineering College",
    papers: 12,
    q1: 3,
    first_author: 5,
    citations: null,
    rank: 4,
    ranked_among: 31,
    rank_on_card: true,
    top_journal: "Nature Photonics",
    since: 2019,
    as_of: "2026-09-24",
  }

  it("is private until shared, and says what the card leaves out", async () => {
    mount(<ImpactCardPage />, FACULTY, {
      "/api/me/impact": () => ({ ...IMPACT, share: { enabled: false, token: null, path: null } }),
    })
    expect(await screen.findByRole("switch", { name: /^Share my card by link/ })).toHaveAttribute(
      "aria-checked",
      "false"
    )
    expect(screen.getByText(/never shows money/)).toBeInTheDocument()
    expect(screen.queryByRole("link", { name: /api\/share/ })).toBeNull()
  })

  it("offers the link on this site's own address once shared", async () => {
    mount(<ImpactCardPage />, FACULTY, {
      "/api/me/impact": () => ({
        ...IMPACT,
        share: { enabled: true, token: "tok", path: "/api/share/impact/tok" },
      }),
    })
    const link = await screen.findByRole("link", { name: `${window.location.origin}/api/share/impact/tok` })
    expect(link).toHaveAttribute("href", `${window.location.origin}/api/share/impact/tok`)
  })

  it("turns sharing on through the server", async () => {
    const put = vi.fn(() => ({ enabled: true, token: "tok", path: "/api/share/impact/tok" }))
    mount(<ImpactCardPage />, FACULTY, {
      "/api/me/impact/share": put,
      "/api/me/impact": () => ({ ...IMPACT, share: { enabled: false, token: null, path: null } }),
    })
    await userEvent.click(await screen.findByRole("switch", { name: /^Share my card by link/ }))
    await waitFor(() =>
      expect(vi.mocked(api)).toHaveBeenCalledWith("/api/me/impact/share", {
        method: "PUT",
        json: { enabled: true },
      })
    )
  })
})
