import { screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return { ...actual, api: vi.fn() }
})

import { api } from "@/lib/api"
import { AdminDirectory } from "@/pages/admin-directory"
import { FACULTY, fakeApi, renderWithProviders } from "@/test/harness"

describe("Admin directory gate", () => {
  it("shows NotOpen to a role without the Admin page, and never calls /api/admin/hub", async () => {
    vi.mocked(api).mockReset()
    vi.mocked(api).mockImplementation(
      fakeApi({
        "/api/auth/me": () => FACULTY,
        "/api/admin/hub": () => ({ counts: {} }),
      })
    )
    renderWithProviders(<AdminDirectory />, { route: "/admin" })

    expect(await screen.findByText("Ask the research office if you think it should be yours.")).toBeInTheDocument()
    const hubCalls = vi.mocked(api).mock.calls.filter(([p]) => String(p).startsWith("/api/admin/hub"))
    expect(hubCalls).toHaveLength(0)
  })
})
