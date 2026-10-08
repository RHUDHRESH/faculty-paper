import { screen } from "@testing-library/react"
import { Route, Routes } from "react-router-dom"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return { ...actual, api: vi.fn() }
})

import type { Role } from "@/app/auth"
import { api } from "@/lib/api"
import { ResearchToolsTabs, ToolsRedirect } from "@/pages/research-tools-tabs"
import { FACULTY, fakeApi, renderWithProviders } from "@/test/harness"

function mountAs(role: Role) {
  vi.mocked(api).mockImplementation(
    fakeApi({ "/api/auth/me": () => ({ ...FACULTY, role }) }) as typeof api
  )
}

describe("Research tools tabs", () => {
  it("shows the compass to a claimant", async () => {
    mountAs("FACULTY")
    renderWithProviders(<ResearchToolsTabs />, { route: "/discover" })
    expect(await screen.findByRole("link", { name: "Compass" })).toHaveAttribute("href", "/compass")
  })

  it("hides the compass from the super admin, who files no papers", async () => {
    mountAs("SUPER_ADMIN")
    // The super admin is sent to Discover by /tools, not the compass.
    renderWithProviders(<ResearchToolsTabs />, { route: "/discover" })
    expect(await screen.findByRole("link", { name: "Discover" })).toBeInTheDocument()
    expect(screen.queryByRole("link", { name: "Compass" })).not.toBeInTheDocument()
  })

  it("sends /tools to Discover for the super admin and to the compass for a claimant", async () => {
    mountAs("SUPER_ADMIN")
    const { unmount } = renderWithProviders(
      <Routes>
        <Route path="/tools" element={<ToolsRedirect />} />
        <Route path="/discover" element={<p>Discover page</p>} />
        <Route path="/compass" element={<p>Compass page</p>} />
      </Routes>,
      { route: "/tools" }
    )
    expect(await screen.findByText("Discover page")).toBeInTheDocument()
    unmount()
    mountAs("FACULTY")
    renderWithProviders(
      <Routes>
        <Route path="/tools" element={<ToolsRedirect />} />
        <Route path="/discover" element={<p>Discover page</p>} />
        <Route path="/compass" element={<p>Compass page</p>} />
      </Routes>,
      { route: "/tools" }
    )
    expect(await screen.findByText("Compass page")).toBeInTheDocument()
  })
})
