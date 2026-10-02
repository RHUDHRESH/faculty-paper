import { screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return { ...actual, api: vi.fn() }
})

import type { Me } from "@/app/auth"
import { api } from "@/lib/api"
import { Reference } from "@/pages/reference"
import { fakeApi, renderWithProviders } from "@/test/harness"

const ADMIN: Me = { id: "u-a", email: "a@x.edu", name: "Admin", role: "SUPER_ADMIN", department: null }

describe("reference data", () => {
  it("answers how many papers are priced on another year's ranking, and where to start", async () => {
    vi.mocked(api).mockImplementation(
      fakeApi({
        "/api/auth/me": () => ADMIN,
        "/api/admin/scimago/stats": () => ({ count: 32186, years: [2025] }),
        "/api/admin/snip/stats": () => ({ count: 32087, years: [2025] }),
        "/api/reports/build": () => ({
          tables: [{ key: "year", rows: [{ key: "2026", count: 1126 }, { key: "2025", count: 1586 }, { key: "2024", count: 1394 }] }],
        }),
        "/api/admin/audit": () => ({ total: 0, results: [] }),
      })
    )
    renderWithProviders(<Reference />, { route: "/reference" })
    expect(await screen.findAllByText("2,520")).toBeTruthy()
    expect(screen.getByText("Papers priced on another year's quartile")).toBeTruthy()
    // The worst gap is named, not left for the reader to work out.
    expect(screen.getByRole("link", { name: "Load 2024 quartiles" })).toBeTruthy()
    // The 37-row years table is one step away.
    expect(screen.queryByText("Held")).toBeNull()
    expect(screen.getByRole("button", { name: /Show the years loaded/ })).toBeTruthy()
    // The long instructions are one step away, not on the page.
    expect(screen.queryByText(/Use Download data/)).toBeNull()
  })
})
