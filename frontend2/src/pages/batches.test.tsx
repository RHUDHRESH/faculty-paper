import { screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return { ...actual, api: vi.fn() }
})

import type { Me } from "@/app/auth"
import { api } from "@/lib/api"
import { Batches } from "@/pages/batches"
import { fakeApi, renderWithProviders } from "@/test/harness"

const ADMIN: Me = { id: "u-a", email: "a@x.edu", name: "Admin", role: "SUPER_ADMIN", department: null }

describe("monthly runs", () => {
  it("says where the latest run stands in words, not a state code", async () => {
    vi.mocked(api).mockImplementation(
      fakeApi({
        "/api/auth/me": () => ADMIN,
        "/api/monthly": () => [
          { id: "b2", name: "March 2026", status: "RUNNING", created_by: "Admin", row_count: 812, created_at: "2026-04-02T08:00:00Z", error_message: null },
          { id: "b1", name: "February 2026", status: "FAILED", created_by: "Admin", row_count: 790, created_at: "2026-03-02T08:00:00Z", error_message: "Scopus refused the key" },
        ],
      })
    )
    renderWithProviders(<Batches />, { route: "/batches" })
    expect((await screen.findAllByText("In progress")).length).toBeGreaterThan(0)
    expect(screen.queryByText(/Running/)).toBeNull()
    expect(screen.getByText("Scopus refused the key")).toBeTruthy()
    expect(screen.getByText("Failed runs")).toBeTruthy()
  })

  it("says what to do when there is no run", async () => {
    vi.mocked(api).mockImplementation(fakeApi({ "/api/auth/me": () => ADMIN, "/api/monthly": () => [] }))
    renderWithProviders(<Batches />, { route: "/batches" })
    expect(await screen.findByText("No monthly run yet")).toBeTruthy()
  })
})
