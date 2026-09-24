import { screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return { ...actual, api: vi.fn() }
})

import type { Me } from "@/app/auth"
import { api } from "@/lib/api"
import { ComingUp } from "@/ui/coming-up"
import { fakeApi, renderWithProviders } from "@/test/harness"

/**
 * An empty desk said "Nothing waiting" and stopped, on a college where
 * thirteen papers sat one step earlier. It now says what is on its way.
 */
const DIRECTOR: Me = { id: "d", email: "d@x.edu", name: "Director", role: "DIRECTOR", department: null }

function mount(counts: Record<string, number>) {
  vi.mocked(api).mockReset()
  vi.mocked(api).mockImplementation(
    fakeApi({
      "/api/auth/me": () => DIRECTOR,
      "/api/claims/counts": () => ({ counts, statuses: {}, stages: {} }),
    })
  )
  renderWithProviders(<ComingUp desk="director" />)
}

describe("ComingUp", () => {
  it("counts what is on its way from the earlier desks", async () => {
    mount({ filed: 13, checked: 2, approved: 0, authorised: 0, paid: 81, sent_back: 0, draft: 0 })
    expect(await screen.findByText("2 papers with the Principal, waiting for approval")).toBeInTheDocument()
    expect(screen.getByText("13 papers with the research office, being checked")).toBeInTheDocument()
    // Not "through the chain": most of them were paid before it existed.
    expect(screen.getByText("81 papers on record as paid.")).toBeInTheDocument()
  })

  it("says when nothing is on its way either", async () => {
    mount({ filed: 0, checked: 0, approved: 0, authorised: 0, paid: 0, sent_back: 0, draft: 0 })
    expect(await screen.findByText(/Nothing earlier in the chain either/)).toBeInTheDocument()
  })
})
