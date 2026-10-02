import { screen, waitFor, within } from "@testing-library/react"
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
  counts: { open: 1, ambiguous: 0, hidden: 3, open_suggested: 1, open_unsuggested: 0 },
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

function mount(list: unknown = LIST) {
  vi.mocked(api).mockReset()
  vi.mocked(api).mockImplementation(
    fakeApi({
      "/api/auth/me": () => ADMIN,
      "/api/admin/author-matches?": () => list,
      "/api/admin/author-matches/decide": () => ({ ok: true, linked: 7 }),
      "/api/admin/author-matches/rerun": () => ({ ok: true, job_id: "j1" }),
      "/api/admin/author-matches/hide-unsuggested": () => ({ ok: true, count: 2829 }),
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
    await user.click(await screen.findByRole("button", { name: /Match G\. Lavanya to Dr\. G\. Lavanya/ }))
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

  it("sets a name aside with r", async () => {
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

describe("Author matches, the answer first", () => {
  const BIG = {
    total: 2829,
    counts: { open: 2841, ambiguous: 0, hidden: 3, open_suggested: 12, open_unsuggested: 2829 },
    items: [{ key: "k rao", names: ["K Rao"], papers: 68, authorships: 68, suggestions: [] }],
  }

  it("says how many names are left, and the two cuts sit on buttons with their counts", async () => {
    mount(BIG)
    const glance = await screen.findByRole("group", { name: "At a glance" })
    expect(await within(glance).findByRole("link", { name: /2,841 Names to place/ })).toBeInTheDocument()
    expect(within(glance).getAllByRole("link")).toHaveLength(1)
    expect(await screen.findByRole("button", { name: "With a likely match (12)" })).toHaveAttribute("aria-pressed", "true")
    expect(screen.getByRole("button", { name: "Match nobody (2,829)" })).toHaveAttribute("aria-pressed", "false")
  })

  it("opens on the names with a likely match, one click each", async () => {
    mount(BIG)
    await screen.findByText("K Rao")
    expect(vi.mocked(api).mock.calls.some(([p]) => String(p).includes("suggested=yes"))).toBe(true)
  })

  it("sets every name that matches nobody aside, after asking with the count", async () => {
    const user = mount({ ...BIG, counts: { ...BIG.counts, open_suggested: 0, open_unsuggested: 2829 } })
    await user.click(await screen.findByRole("button", { name: /Set all 2,829 aside/ }))
    const dialog = await screen.findByRole("dialog")
    expect(dialog).toHaveTextContent("2,829 names match nobody on the roster")
    await user.click(within(dialog).getByRole("button", { name: "Set 2,829 aside" }))
    await waitFor(() =>
      expect(vi.mocked(api)).toHaveBeenCalledWith("/api/admin/author-matches/hide-unsuggested", {
        method: "POST",
        json: {},
      })
    )
  })
})