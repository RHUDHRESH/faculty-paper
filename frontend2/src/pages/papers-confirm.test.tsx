import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return { ...actual, api: vi.fn() }
})

import { api } from "@/lib/api"
import { PaperCandidates, ScopusProfileQuestion, type PaperCandidate, type ScopusProfileState } from "@/pages/papers-confirm"
import { fakeApi, renderWithProviders } from "@/test/harness"

const ASKING: ScopusProfileState = {
  scopus_author_id: "57200597022",
  url: "https://www.scopus.com/authid/detail.uri?authorId=57200597022",
  papers_in_scopus: 134,
  papers_on_record: 159,
  status: "",
  checked_at: null,
}

const candidate = (id: string, over: Partial<PaperCandidate["publication"]> = {}): PaperCandidate => ({
  id,
  reason: "name matched",
  source: "openalex",
  publication: {
    id: `pub-${id}`,
    title: `Candidate paper ${id}`,
    year: 2024,
    venue: "Journal of Things",
    doi: null,
    authors: ["Dr Asha Menon", "Ravi Kumar", "Lena Park", "Omar Diaz"],
    author_count: 4,
    ...over,
  },
})

/** The calls made to `api` for a path, with their options. */
function callsTo(path: string) {
  return vi.mocked(api).mock.calls.filter(([p]) => p === path)
}

function mountWith(
  profile: ScopusProfileState,
  candidates: { pending: number; results: PaperCandidate[] } = { pending: 0, results: [] }
) {
  vi.mocked(api).mockReset()
  vi.mocked(api).mockImplementation(
    fakeApi({
      "/api/me/scopus-profile": () => profile,
      "/api/me/paper-candidates/c1/confirm": () => ({ pending: 1 }),
      "/api/me/paper-candidates/c1/reject": () => ({ pending: 1 }),
      "/api/me/paper-candidates": () => candidates,
    })
  )
}

describe("Is this your Scopus profile?", () => {
  it("asks when the profile is unanswered, with the paper count and the author number", async () => {
    mountWith(ASKING)
    renderWithProviders(<ScopusProfileQuestion />)
    expect(await screen.findByText("Is this your Scopus profile?")).toBeInTheDocument()
    expect(
      screen.getByText((_, el) => el?.tagName === "P" && el.textContent === "Scopus has 134 papers under author number 57200597022 (open it)")
    ).toBeInTheDocument()
    const open = screen.getByRole("link", { name: "open it" })
    expect(open).toHaveAttribute("href", ASKING.url)
    expect(open).toHaveAttribute("target", "_blank")
    expect(screen.getByRole("button", { name: "Yes, this is me" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "No, this is wrong" })).toBeInTheDocument()
  })

  it("posts yes and thanks the person, then the panel does not come back", async () => {
    mountWith(ASKING)
    renderWithProviders(<ScopusProfileQuestion />)
    const user = userEvent.setup()
    await user.click(await screen.findByRole("button", { name: "Yes, this is me" }))
    expect(await screen.findByText("Thank you. Your Scopus profile is confirmed.")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Yes, this is me" })).toBeNull()
    const posts = callsTo("/api/me/scopus-profile").filter(([, o]) => o && (o as { method?: string }).method === "POST")
    expect(posts).toHaveLength(1)
    expect(posts[0][1]).toEqual(expect.objectContaining({ json: { answer: "yes" } }))
  })

  it("posts no and tells the person the office will correct the profile", async () => {
    mountWith(ASKING)
    renderWithProviders(<ScopusProfileQuestion />)
    const user = userEvent.setup()
    await user.click(await screen.findByRole("button", { name: "No, this is wrong" }))
    expect(await screen.findByText("Thank you. The research office will correct your profile.")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "No, this is wrong" })).toBeNull()
    const posts = callsTo("/api/me/scopus-profile").filter(([, o]) => o && (o as { method?: string }).method === "POST")
    expect(posts[0][1]).toEqual(expect.objectContaining({ json: { answer: "no" } }))
  })

  it("says the person has no Scopus ID and links to the profile page", async () => {
    mountWith({ ...ASKING, scopus_author_id: null, url: null, status: "no_id" })
    renderWithProviders(<ScopusProfileQuestion />)
    expect(
      await screen.findByText(
        (_, el) =>
          el?.tagName === "P" &&
          el.textContent === "You have no Scopus ID on your account. Add it in your profile so your papers can be found."
      )
    ).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "your profile" })).toHaveAttribute("href", "/profile")
  })

  it("shows nothing once the profile is confirmed or disputed", async () => {
    mountWith({ ...ASKING, status: "confirmed" })
    const { container } = renderWithProviders(<ScopusProfileQuestion />)
    await waitFor(() => expect(callsTo("/api/me/scopus-profile").length).toBeGreaterThan(0))
    expect(container.textContent).toBe("")
  })
})

describe("Papers we are not sure about", () => {
  it("lists each candidate with the paper, the first names and the two answers", async () => {
    mountWith(ASKING, { pending: 2, results: [candidate("c1"), candidate("c2")] })
    renderWithProviders(<PaperCandidates />)
    expect(await screen.findByText("Papers we are not sure about")).toBeInTheDocument()
    expect(
      screen.getByText(
        "These papers were once on your list because the name matched, but Scopus does not show them under your profile. Tell us which are yours."
      )
    ).toBeInTheDocument()
    expect(screen.getByText("2 left")).toBeInTheDocument()
    const table = screen.getByRole("table", { name: "Papers to confirm" })
    const [first] = within(table).getAllByRole("row").slice(1)
    expect(within(first).getByText("Journal of Things, 2024")).toBeInTheDocument()
    expect(within(first).getByText("Asha, Ravi, +2 more")).toBeInTheDocument()
    expect(within(first).getByRole("button", { name: "This is mine" })).toBeInTheDocument()
    expect(within(first).getByRole("button", { name: "Not mine" })).toBeInTheDocument()
  })

  it("confirms a paper: posts to the confirm URL and removes the row", async () => {
    mountWith(ASKING, { pending: 2, results: [candidate("c1"), candidate("c2")] })
    renderWithProviders(<PaperCandidates />)
    const user = userEvent.setup()
    const table = await screen.findByRole("table", { name: "Papers to confirm" })
    const first = within(table).getAllByRole("row")[1]
    await user.click(within(first).getByRole("button", { name: "This is mine" }))
    await waitFor(() => expect(within(table).getAllByRole("row")).toHaveLength(2))
    expect(callsTo("/api/me/paper-candidates/c1/confirm")).toHaveLength(1)
    expect(within(table).queryByText("Candidate paper c1")).toBeNull()
    expect(screen.getByText("1 left")).toBeInTheDocument()
  })

  it("rejects a paper: posts to the reject URL and removes the row", async () => {
    mountWith(ASKING, { pending: 2, results: [candidate("c1"), candidate("c2")] })
    renderWithProviders(<PaperCandidates />)
    const user = userEvent.setup()
    const table = await screen.findByRole("table", { name: "Papers to confirm" })
    const first = within(table).getAllByRole("row")[1]
    await user.click(within(first).getByRole("button", { name: "Not mine" }))
    await waitFor(() => expect(within(table).getAllByRole("row")).toHaveLength(2))
    expect(callsTo("/api/me/paper-candidates/c1/reject")).toHaveLength(1)
    expect(callsTo("/api/me/paper-candidates/c1/confirm")).toHaveLength(0)
  })

  it("renders nothing when no candidates are left", async () => {
    mountWith(ASKING, { pending: 0, results: [] })
    const { container } = renderWithProviders(<PaperCandidates />)
    await waitFor(() => expect(callsTo("/api/me/paper-candidates").length).toBeGreaterThan(0))
    expect(container.textContent).toBe("")
    expect(screen.queryByText("Papers we are not sure about")).toBeNull()
  })
})
