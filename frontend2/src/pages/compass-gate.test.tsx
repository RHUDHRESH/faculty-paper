import { screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return { ...actual, api: vi.fn() }
})

import { api } from "@/lib/api"
import { Compass } from "@/pages/compass"
import { FACULTY, fakeApi, renderWithProviders } from "@/test/harness"

describe("Research compass gate", () => {
  it("shows NotOpen to a role that cannot use the compass, and never calls /api/compass", async () => {
    const superAdmin = { ...FACULTY, id: "u-sa", name: "Super Admin", role: "SUPER_ADMIN" as const }
    vi.mocked(api).mockReset()
    vi.mocked(api).mockImplementation(
      fakeApi({
        "/api/auth/me": () => superAdmin,
        "/api/compass": () => ({}),
      })
    )
    renderWithProviders(<Compass />, { route: "/compass" })

    expect(await screen.findByText("The research compass is for people who file their own papers.")).toBeInTheDocument()
    const compassCalls = vi.mocked(api).mock.calls.filter(([p]) => String(p).startsWith("/api/compass"))
    expect(compassCalls).toHaveLength(0)
  })
})
