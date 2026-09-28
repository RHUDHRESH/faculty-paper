import { screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return { ...actual, api: vi.fn() }
})

import type { Me } from "@/app/auth"
import { api } from "@/lib/api"
import { AuthorMatches } from "@/pages/author-matches"
import { fakeApi, renderWithProviders } from "@/test/harness"

const ADMIN: Me = { id: "u-a", email: "a@x.edu", name: "Admin", role: "SUPER_ADMIN", department: null }

const LIST = {
  total: 1,
  counts: { open: 1, ambiguous: 0, hidden: 3 },
  items: [
    {
      key: "g lavanya",
      names: ["G. Lavanya", "Lavanya G"],
      papers: 7,
      authorships: 8,
      suggestions: [{ id: "u-l", name: "Dr. G. Lavanya", department: "CSE", email: "l@x.edu", score: 1 }],
    },
  ],
}

function mount() {
  vi.mocked(api).mockReset()
  vi.mocked(api).mockImplementation(
    fakeApi({
      "/api/auth/me": () => ADMIN,
      "/api/admin/author-matches?": () => LIST,
      "/api/admin/author-matches/decide": () => ({ ok: true, linked: 7 }),
      "/api/admin/author-matches/rerun": () => ({ ok: true, job_id: "j1" }),
      "/api/admin/duplicate-accounts": () => ({ groups: [] }),
    })
  )
  renderWithProviders(<AuthorMatches />, { route: "/people/matches" })
  return userEvent.setup()
}

describe("Author matches", () => {
  it("lists a grouped name with its paper count", async () => {
    mount()
    expect(await screen.findByText("G. Lavanya")).toBeInTheDocument()
    expect(screen.getByText("Also written Lavanya G")).toBeInTheDocument()
    expect(screen.getByText("7 papers")).toBeInTheDocument()
    expect(document.body.textContent).not.toMatch(/₹/)
  })

  it("links a name to the suggested person", async () => {
    const user = mount()
    await user.click(await screen.findByRole("button", { name: /This is Dr\. G\. Lavanya/ }))
    await waitFor(() =>
      expect(vi.mocked(api)).toHaveBeenCalledWith("/api/admin/author-matches/decide", {
        method: "POST",
        json: { key: "g lavanya", status: "MATCHED", user_id: "u-l" },
      })
    )
  })

  it("queues a re-run", async () => {
    const user = mount()
    await user.click(await screen.findByRole("button", { name: /Re-run matching/ }))
    await waitFor(() =>
      expect(vi.mocked(api)).toHaveBeenCalledWith("/api/admin/author-matches/rerun", { method: "POST", json: {} })
    )
  })

  it("accepts the first suggestion from the keyboard", async () => {
    const user = mount()
    const row = await screen.findByRole("listitem", { name: /G. Lavanya, 7 papers/ })
    row.focus()
    await user.keyboard("a")
    await waitFor(() =>
      expect(vi.mocked(api)).toHaveBeenCalledWith("/api/admin/author-matches/decide", {
        method: "POST",
        json: { key: "g lavanya", status: "MATCHED", user_id: "u-l" },
      })
    )
  })

  it("rejects with r", async () => {
    const user = mount()
    const row = await screen.findByRole("listitem", { name: /G. Lavanya/ })
    row.focus()
    await user.keyboard("r")
    await waitFor(() =>
      expect(vi.mocked(api)).toHaveBeenCalledWith("/api/admin/author-matches/decide", {
        method: "POST",
        json: { key: "g lavanya", status: "NOT_ROSTER" },
      })
    )
  })
})
