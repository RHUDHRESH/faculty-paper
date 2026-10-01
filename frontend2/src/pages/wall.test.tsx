import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return { ...actual, api: vi.fn() }
})

import type { Me } from "@/app/auth"
import { api } from "@/lib/api"
import { WallBoard, mayPin, type WallPayload } from "@/pages/wall"

const Board = () => <WallBoard department="" month="" onMonth={() => {}} />
import { FACULTY, HOD, fakeApi, renderWithProviders, type ApiTable } from "@/test/harness"

/**
 * The wall celebrates papers, a month at a time, with nothing about money on
 * it; only a department's own head chooses its paper of the month.
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
    mount(<Board />, HOD, { "/api/wall": () => WALL })
    const title = await screen.findByText("Shared paper")
    const card = title.closest("li") as HTMLElement
    expect(within(card).getByText("Asha Menon")).toBeInTheDocument()
    expect(within(card).getByText("Ravi Kumar")).toBeInTheDocument()
    expect(within(card).getByText("Q1")).toBeInTheDocument()
    expect(screen.queryByText(/₹/)).toBeNull()
  })

  it("opens on the whole college", async () => {
    mount(<Board />, HOD, { "/api/wall": () => WALL })
    await screen.findByText("Shared paper")
    expect(vi.mocked(api)).toHaveBeenCalledWith("/api/wall")
  })

  it("lets the department's head choose a paper of the month", async () => {
    const pin = vi.fn(() => ({ ok: true }))
    mount(<Board />, HOD, { "/api/wall/pin": pin, "/api/wall": () => WALL })
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
    mount(<Board />, { ...FACULTY, department: "Physics" }, { "/api/wall": () => WALL })
    await screen.findByText("Shared paper")
    expect(screen.queryByRole("button", { name: "Make paper of the month" })).toBeNull()
  })

  it("puts the paper of the month first, under its own heading", async () => {
    const pinned = { ...WALL.cards[1], pinned: true }
    mount(<Board />, HOD, {
      "/api/wall": () => ({ ...WALL, pinned, cards: [pinned, WALL.cards[0]] }),
    })
    await screen.findByText("Second paper")
    const titles = screen.getAllByText(/paper$/).map((n) => n.textContent)
    expect(titles.indexOf("Second paper")).toBeLessThan(titles.indexOf("Shared paper"))
    expect(screen.getAllByText("Paper of the month").length).toBeGreaterThan(0)
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
