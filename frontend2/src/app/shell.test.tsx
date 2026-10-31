import { screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return { ...actual, api: vi.fn() }
})

import { api } from "@/lib/api"
import { Shell } from "@/app/shell"
import { FACULTY, fakeApi, renderWithProviders } from "@/test/harness"

/**
 * The frame: a sidebar that remembers whether it is collapsed, a top bar whose
 * search opens the same finder as Ctrl K, and sentence-case section labels.
 * Pages are not mounted; the frame is what is under test.
 */

const SEEN = { ...FACULTY, welcome_seen: true }

function renderShell(onOpenPalette = vi.fn()) {
  vi.mocked(api).mockImplementation(
    fakeApi({
      "/api/auth/me": () => SEEN,
      "/api/institution": () => ({ college_name: "Test College", sign_in_note: "", support_email: "" }),
    })
  )
  const utils = renderWithProviders(<Shell onOpenPalette={onOpenPalette} />, { route: "/papers" })
  return { ...utils, onOpenPalette }
}

describe("app frame", () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it("remembers that the sidebar was collapsed", async () => {
    const user = userEvent.setup()
    const first = renderShell()
    expect(screen.getByText("Publications")).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Collapse sidebar" }))
    expect(localStorage.getItem("sidebar")).toBe("collapsed")
    expect(screen.queryByText("Publications")).toBeNull()
    first.unmount()

    renderShell()
    expect(await screen.findByRole("button", { name: "Expand sidebar" })).toBeInTheDocument()
    expect(screen.queryByText("Publications")).toBeNull()
  })

  it("opens the finder from the top bar search, as Ctrl K does", async () => {
    const user = userEvent.setup()
    const { onOpenPalette } = renderShell()
    const search = screen.getByRole("button", { name: /Search papers, people, claims/ })
    expect(within(search).getByText("Ctrl")).toBeInTheDocument()
    await user.click(search)
    expect(onOpenPalette).toHaveBeenCalledTimes(1)
  })

  it("draws section labels in sentence case, never uppercase", async () => {
    renderShell()
    const nav = await screen.findByRole("navigation", { name: "Main" })
    const labels = Array.from(nav.querySelectorAll("p"))
    expect(labels.length).toBeGreaterThan(0)
    for (const label of labels) {
      expect(label.className).not.toContain("uppercase")
      expect(label.className).toContain("text-xs")
      expect(label.className).toContain("text-fg-subtle")
      expect(label.textContent).not.toBe(label.textContent?.toUpperCase())
    }
  })

  it("marks the current page with the accent wash, not a stripe", async () => {
    renderShell()
    const current = await screen.findByRole("link", { current: "page" })
    expect(current.className).toContain("bg-accent-wash")
    expect(current.className).toContain("text-accent")
    expect(current.className).not.toContain("ring-edge")
  })
})
