import { render, screen, waitFor, within } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return { ...actual, api: vi.fn() }
})

import type { Me } from "@/app/auth"
import { api } from "@/lib/api"
import { Search } from "@/pages/search"
import { FACULTY, fakeApi, failing, renderWithProviders } from "@/test/harness"

/**
 * The search screen, and the four things about it that are worth a test
 * because each one is invisible when it breaks.
 *
 * 1. An unresolved journal must carry no number. It is the safety rule of the
 *    product: a plausible venue beside a confident figure is how somebody
 *    submits to a journal that does not exist. Asserted over the region's
 *    whole text rather than over one element, so it keeps holding when
 *    somebody adds a field to the row.
 * 2. A partial failure is its own state. Three sources answering and one
 *    failing must say so above the results — a short list presented as a
 *    complete one is how a paper gets filed twice.
 * 3. An error is never an empty state. The two sentences are different and a
 *    reader has to be able to tell them apart.
 * 4. A head of department sees no rupee figure, anywhere on the page.
 */

const HOD: Me = {
  id: "u-hod",
  email: "hod@example.edu",
  name: "Dr S Kumar",
  role: "HOD",
  department: "Mechanical Engineering",
}

const mockedApi = vi.mocked(api)

/** The shape this page is written against. One place, so a change to the
 *  agreed response shape breaks in one place rather than in six. */
function results(over: Partial<Body> = {}): Body {
  return {
    query: "graphene",
    sources: [
      { id: "crossref", label: "Crossref", ok: true, count: 1 },
      { id: "openalex", label: "OpenAlex", ok: true, count: 1 },
      { id: "scopus", label: "Scopus", ok: true, count: 1 },
      { id: "journals", label: "Our journal data", ok: true, count: 1 },
      { id: "college", label: "This college", ok: true, count: 1 },
    ],
    papers: [
      {
        doi: "10.1016/j.carbon.2024.01",
        title: "Graphene oxide membranes for desalination",
        authors: ["A Menon", "B Rao"],
        year: 2024,
        journal_title: "Carbon",
        issn: "0008-6223",
        publication_type: "Journal Article",
        cited_by: 12,
        url: "https://doi.org/10.1016/j.carbon.2024.01",
        found_in: ["Crossref", "OpenAlex"],
        claim: null,
      },
    ],
    venues: {
      resolved: [
        {
          title: "Carbon",
          issn: "0008-6223",
          quartile: "Q1",
          subject: "Materials Chemistry",
          sjr: 1.842,
          snip: 1.63,
          dataset_year: 2024,
          publisher: "Elsevier",
        },
      ],
      unresolved: [
        {
          title: "International Journal of Graphene Advances",
          publisher: null,
          issn: null,
        },
      ],
    },
    people: [
      {
        id: "u-1",
        name: "Dr Asha Menon",
        department: "Mechanical Engineering",
        designation: "Professor",
        papers: 7,
      },
    ],
    tickets: [
      {
        id: "c-1",
        paper_title: "Graphene oxide membranes for desalination",
        doi: "10.1016/j.carbon.2024.01",
        journal_title: "Carbon",
        status: "PAID",
        publication_year: 2024,
        department: "Mechanical Engineering",
        claimant: { id: "u-1", name: "Dr Asha Menon" },
        amount: 125000,
      },
    ],
    ...over,
  }
}

type Body = {
  query: string
  sources: { id: string; label: string; ok: boolean; count?: number | null; detail?: string | null }[]
  papers: unknown[]
  venues: { resolved: unknown[]; unresolved: unknown[] }
  people: unknown[]
  tickets: unknown[]
}

function mount(me: Me, body: unknown, { route = "/search?q=graphene" } = {}) {
  mockedApi.mockImplementation(
    fakeApi({
      "/api/auth/me": () => me,
      "/api/search": () => body,
    })
  )
  return renderWithProviders(<Search />, { route })
}

describe("Search", () => {
  it("gives the box a real accessible name and reads the query out of the URL", async () => {
    mount(FACULTY, results())
    const box = screen.getByRole("searchbox", {
      name: /search papers, journals, people and claims/i,
    })
    expect(box).toHaveValue("graphene")
  })

  it("shows no figure of any kind beside a journal it could not resolve", async () => {
    mount(FACULTY, results())

    const journals = await screen.findByRole("region", { name: "Journals" })

    // The resolved one keeps its quartile and its metrics.
    expect(within(journals).getByText("Carbon")).toBeInTheDocument()
    expect(within(journals).getByText("Q1")).toBeInTheDocument()

    // The unresolved one is named, marked unconfirmed, and carries nothing
    // numeric. Read off the list item so a number elsewhere in the region
    // cannot make this pass by accident.
    const unverified = within(journals)
      .getByText("International Journal of Graphene Advances")
      .closest("li")
    expect(unverified).not.toBeNull()
    const text = unverified?.textContent ?? ""
    expect(text).toMatch(/unconfirmed/i)
    expect(text).not.toMatch(/\d/)
    expect(text).not.toMatch(/Q[1-4]/)
  })

  it("says so above the results when one source is down, rather than presenting a short list", async () => {
    mount(
      FACULTY,
      results({
        sources: [
          { id: "crossref", label: "Crossref", ok: true, count: 1 },
          { id: "openalex", label: "OpenAlex", ok: true, count: 1 },
          { id: "journals", label: "Our journal data", ok: true, count: 1 },
          {
            id: "scopus",
            label: "Scopus",
            ok: false,
            detail: "Scopus rate limit — wait and retry",
          },
        ],
      })
    )

    expect(await screen.findByText(/this is not the whole search/i)).toBeInTheDocument()
    expect(screen.getByText(/scopus rate limit/i)).toBeInTheDocument()
    // The results are still shown; a partial answer is worth having.
    expect(screen.getByRole("region", { name: "Papers" })).toBeInTheDocument()
  })

  it("treats every source failing as a failure, not as a result set", async () => {
    mount(
      FACULTY,
      results({
        sources: [
          { id: "crossref", label: "Crossref", ok: false, detail: "did not answer" },
          { id: "openalex", label: "OpenAlex", ok: false, detail: "did not answer" },
        ],
        papers: [],
        venues: { resolved: [], unresolved: [] },
        people: [],
        tickets: [],
      })
    )

    expect(await screen.findByText(/nothing could be searched/i)).toBeInTheDocument()
    expect(screen.queryByText(/nothing matched that/i)).not.toBeInTheDocument()
  })

  it("never renders a failed request as an empty result", async () => {
    mockedApi.mockImplementation(
      fakeApi({
        "/api/auth/me": () => FACULTY,
        "/api/search": failing(500, "The server did not answer"),
      })
    )
    renderWithProviders(<Search />, { route: "/search?q=graphene" })

    expect(await screen.findByText(/the search did not run/i)).toBeInTheDocument()
    expect(screen.queryByText(/nothing matched/i)).not.toBeInTheDocument()
  })

  it("distinguishes an empty search from an error and from a search not yet made", async () => {
    mount(
      FACULTY,
      results({
        papers: [],
        venues: { resolved: [], unresolved: [] },
        people: [],
        tickets: [],
      })
    )
    expect(await screen.findByText(/nothing matched that/i)).toBeInTheDocument()

    // No query at all is neither of those: nobody has asked anything.
    mount(FACULTY, results(), { route: "/search" })
    expect(await screen.findAllByText(/search for anything/i)).not.toHaveLength(0)
  })

  it("shows a head of department no rupee figure", async () => {
    const { container } = mount(HOD, results())

    await screen.findByRole("region", { name: "Claims filed here" })
    await waitFor(() => {
      expect(container.textContent).not.toMatch(/₹/)
    })
    expect(container.textContent).not.toMatch(/1,25,000/)
  })

  it("hands a paper off to the filing form rather than filing it here", async () => {
    mount(FACULTY, results())

    const papers = await screen.findByRole("region", { name: "Papers" })
    const link = within(papers).getByRole("link", { name: /file a claim/i })
    const href = link.getAttribute("href") ?? ""
    expect(href).toContain("/papers/new?")
    expect(href).toContain(`doi=${encodeURIComponent("10.1016/j.carbon.2024.01")}`)
    expect(href).toContain("journal=Carbon")
  })

  it("links a paper already claimed here to its claim instead of offering a second one", async () => {
    mount(
      FACULTY,
      results({
        papers: [
          {
            doi: "10.1016/j.carbon.2024.01",
            title: "Graphene oxide membranes for desalination",
            authors: [],
            year: 2024,
            journal_title: "Carbon",
            issn: "0008-6223",
            publication_type: "Journal Article",
            cited_by: null,
            url: null,
            found_in: ["Crossref"],
            claim: { id: "c-1", status: "PAID", mine: true },
          },
        ],
      })
    )

    const papers = await screen.findByRole("region", { name: "Papers" })
    expect(within(papers).getByText(/already filed here/i)).toBeInTheDocument()
    expect(within(papers).queryByRole("link", { name: /file a claim/i })).not.toBeInTheDocument()
  })

  it("opens a colleague's public profile, which every role may see", async () => {
    // `/people/{id}` is the office's account screen and refuses a claimant,
    // so a name found here must lead to the profile anybody can open.
    mount(FACULTY, results())
    const link = await screen.findByRole("link", { name: "Dr Asha Menon" })
    expect(link).toHaveAttribute("href", "/u/u-1")
  })

  it("does not ask the server anything until there is something to search for", async () => {
    render(<div />)
    mockedApi.mockImplementation(
      fakeApi({
        "/api/auth/me": () => FACULTY,
        "/api/search": () => results(),
      })
    )
    renderWithProviders(<Search />, { route: "/search?q=g" })

    await screen.findByText(/keep typing/i)
    expect(
      mockedApi.mock.calls.filter(([path]) => String(path).startsWith("/api/search"))
    ).toHaveLength(0)
  })
})
