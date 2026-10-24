import { screen, within } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return { ...actual, api: vi.fn() }
})

import type { Role } from "@/app/auth"
import { api } from "@/lib/api"
import { ResearchTools, ResearchToolsTabs } from "@/pages/research-tools-tabs"
import { FACULTY, fakeApi, renderWithProviders } from "@/test/harness"

function mountAs(role: Role) {
  vi.mocked(api).mockImplementation(
    fakeApi({ "/api/auth/me": () => ({ ...FACULTY, role }) }) as typeof api
  )
}

describe("Research tools tabs", () => {
  it("shows the Research compass tab to a claimant, and the way back to the list", async () => {
    mountAs("FACULTY")
    renderWithProviders(<ResearchToolsTabs />, { route: "/discover" })
    expect(await screen.findByRole("link", { name: "Research compass" })).toHaveAttribute("href", "/compass")
    expect(screen.queryByRole("link", { name: "Compass" })).not.toBeInTheDocument()
    expect(screen.getByRole("link", { name: "All research tools" })).toHaveAttribute("href", "/tools")
  })

  it("hides the compass from the super admin, who files no papers", async () => {
    mountAs("SUPER_ADMIN")
    renderWithProviders(<ResearchToolsTabs />, { route: "/discover" })
    expect(await screen.findByRole("link", { name: "Discover" })).toBeInTheDocument()
    expect(screen.queryByRole("link", { name: "Research compass" })).not.toBeInTheDocument()
  })
})

describe("Research tools page", () => {
  it("lists the three tools a faculty claimant can use, each linking to its page", async () => {
    mountAs("FACULTY")
    renderWithProviders(<ResearchTools />, { route: "/tools" })
    const list = await screen.findByRole("list")
    const items = within(list).getAllByRole("listitem")
    expect(items).toHaveLength(3)
    expect(screen.getByRole("link", { name: "Check a journal" })).toHaveAttribute("href", "/journal-check")
    expect(screen.getByRole("link", { name: "Discover" })).toHaveAttribute("href", "/discover")
    expect(screen.getByRole("link", { name: "Research compass" })).toHaveAttribute("href", "/compass")
    expect(screen.queryByRole("link", { name: "Ask the data" })).not.toBeInTheDocument()
  })

  it("lists four tools for a head of department, who can also ask the data", async () => {
    mountAs("HOD")
    renderWithProviders(<ResearchTools />, { route: "/tools" })
    const items = within(await screen.findByRole("list")).getAllByRole("listitem")
    expect(items).toHaveLength(4)
    expect(screen.getByRole("link", { name: "Ask the data" })).toHaveAttribute("href", "/insights")
  })

  it("leaves the compass row out for a role that cannot use the compass", async () => {
    mountAs("SUPER_ADMIN")
    renderWithProviders(<ResearchTools />, { route: "/tools" })
    const items = within(await screen.findByRole("list")).getAllByRole("listitem")
    expect(items).toHaveLength(3)
    expect(screen.queryByRole("link", { name: "Research compass" })).not.toBeInTheDocument()
    expect(screen.getByRole("link", { name: "Ask the data" })).toHaveAttribute("href", "/insights")
  })
})
