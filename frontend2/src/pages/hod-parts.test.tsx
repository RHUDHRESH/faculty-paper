import { screen, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return { ...actual, api: vi.fn() }
})

import { api } from "@/lib/api"
import { Department } from "@/pages/department"
import { FINANCE, HOD, fakeApi, failing, renderWithProviders } from "@/test/harness"

/**
 * `/api/hod/brief` answers a head of department only (`_require_hod`). The
 * shared hook asks for it for that role alone, so nobody else makes a request
 * that the server would refuse.
 */

const requested = (prefix: string) => vi.mocked(api).mock.calls.some(([path]) => String(path).startsWith(prefix))

describe("the head's brief", () => {
  it("is not requested by anyone who is not a head of department", async () => {
    vi.mocked(api).mockImplementation(fakeApi({ "/api/auth/me": () => FINANCE, "/api/hod/brief": () => ({}) }))
    renderWithProviders(<Department />)
    expect(
      await screen.findByText(
        "This is a head of department's own view of their department. Everybody else has the college-wide reports."
      )
    ).toBeInTheDocument()
    expect(requested("/api/hod/brief")).toBe(false)
  })

  it("is requested by the head of department", async () => {
    vi.mocked(api).mockImplementation(fakeApi({ "/api/auth/me": () => HOD, "/api/hod/brief": failing(500) }))
    renderWithProviders(<Department />)
    await waitFor(() => expect(requested("/api/hod/brief")).toBe(true))
  })
})
