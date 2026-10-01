import { fireEvent, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return { ...actual, api: vi.fn() }
})

import { Palette } from "@/app/palette"
import { api } from "@/lib/api"
import { Search } from "@/pages/search"
import { FACULTY, fakeApi, renderWithProviders } from "@/test/harness"

/**
 * docs/ux/02-search.md acceptance, in the parts a unit test can hold:
 * the idle page teaches, one query answers in groups (people with their
 * connection, papers, journals, pages, actions), a DOI is an exact hit, the
 * People scope with no query is the directory, and the palette runs on the
 * same engine from the keyboard alone.
 */

const mockedApi = vi.mocked(api)

const ALL = {
  q: "kanaga",
  scope: "all",
  exact: null,
  groups: [
    {
      kind: "person",
      total: 2,
      status: "ok",
      items: [
        { id: "u-k", title: "Dr. S. Kanagamalliga", subtitle: "ECE", url: "/people/u-k", chips: ["Saveetha"], meta: { external: false, department: "ECE", papers: 104, connect: "u-k" } },
        { id: "A7", title: "S. Kanagaraj", subtitle: "IIT Madras", url: "/people/u-k", chips: ["IIT Madras"], meta: { external: true, papers: 3, connect: "A7", college_coauthors: [{ user_id: "u-k", name: "Dr. S. Kanagamalliga", papers_together: 3 }] } },
      ],
    },
    {
      kind: "paper",
      total: 1,
      status: "ok",
      items: [{ id: "p1", title: "Kanaga filters for power", subtitle: "IEEE Access · 2024", url: "/research?tab=me&paper=p1", chips: ["Yours"], meta: { venue: "IEEE Access", year: 2024, mine: true, claimed: false, authors: [{ name: "Dr Asha Menon", you: true }] } }],
    },
    { kind: "journal", total: 1, status: "ok", items: [{ id: "1", title: "Kanaga Journal", url: "/journals/Kanaga Journal", chips: ["Q2"], meta: { quartile: "Q2" } }] },
    { kind: "topic", total: 0, status: "ok", items: [] },
  ],
}

const CONNECTION = {
  hops: 2,
  paths: [{ people: [
    { key: "u:u-faculty", user_id: "u-faculty", name: "Dr Asha Menon", via: [] },
    { key: "u:u-j", user_id: "u-j", name: "Dr T. Jaya", via: [{ id: "p" }, { id: "q" }] },
    { key: "u:u-k", user_id: "u-k", name: "Dr. S. Kanagamalliga", via: [{ id: "r" }] },
  ] }],
}

beforeEach(() => {
  localStorage.clear()
  mockedApi.mockReset()
  mockedApi.mockImplementation(
    fakeApi({
      "/api/auth/me": () => FACULTY,
      "/api/search/all": (path) => (path.includes("10.1016") ? { ...ALL, q: "10.1016/j.x.2024.1", groups: [], exact: { kind: "claim", id: "c1", title: "Filed paper", url: "/papers/c1", chips: ["Under review", "Yours"] } } : ALL),
      "/api/people/u-faculty/connection?to=u-k": () => CONNECTION,
      "/api/people/u-faculty/connection": () => ({ hops: null, paths: [] }),
      "/api/people?": () => ({ total: 2, results: [
        { id: "b", name: "Zed Person", initials: "ZP", photo_url: null, department: "ECE", designation: null, papers: 0 },
        { id: "a", name: "Anu Person", initials: "AP", photo_url: null, department: "EEE", designation: null, papers: 2 },
      ] }),
      "/api/meta/departments": () => ["ECE", "EEE"],
    }) as typeof api
  )
})

describe("/search", () => {
  it("idle: the big box, scope chips, try-chips and jump tiles", async () => {
    renderWithProviders(<Search />, { route: "/search" })
    expect(await screen.findByRole("heading", { name: "Find anything" })).toBeInTheDocument()
    expect(screen.getByRole("combobox", { name: "Find anything" })).toBeInTheDocument()
    expect(screen.getByRole("tab", { name: "People" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /Kanagamalliga/ })).toBeInTheDocument()
    expect(screen.getByRole("link", { name: /File a paper/ })).toHaveAttribute("href", "/papers/new")
  })

  it("a query answers in groups: people with a connection path, external co-author, papers, journals", async () => {
    renderWithProviders(<Search />, { route: "/search?q=kanaga" })
    expect(await screen.findByRole("region", { name: "People" })).toBeInTheDocument()
    expect(screen.getByRole("region", { name: "Papers" })).toBeInTheDocument()
    expect(screen.getByRole("region", { name: "Journals" })).toBeInTheDocument()
    expect(screen.queryByRole("region", { name: "Topics" })).toBeNull()
    expect(screen.getAllByText(/IIT Madras · 3 papers/).length).toBeGreaterThan(0)
    expect(screen.getByText(/Wrote with Dr. S. Kanagamalliga/)).toBeInTheDocument()
    await waitFor(() => expect(screen.getAllByText(/2 steps away via/).length).toBeGreaterThan(0))
    expect(screen.getAllByText("Dr T. Jaya").length).toBeGreaterThan(0)
    expect(screen.getByRole("link", { name: "Message Dr. S. Kanagamalliga" })).toHaveAttribute("href", "/messages?to=u-k")
    expect(screen.getAllByText("Yours").length).toBeGreaterThan(0)
  })

  it("keyboard: Enter opens the best match, Esc clears", async () => {
    renderWithProviders(<Search />, { route: "/search?q=kanaga" })
    await screen.findByRole("region", { name: "People" })
    const input = screen.getByRole("combobox", { name: "Find anything" })
    fireEvent.keyDown(input, { key: "ArrowDown" })
    expect(input.getAttribute("aria-activedescendant")).toBe("search-row-0")
    fireEvent.keyDown(input, { key: "Escape" })
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Find anything" })).toHaveValue(""))
  })

  it("a DOI is an exact hit at the top", async () => {
    renderWithProviders(<Search />, { route: "/search?q=10.1016/j.x.2024.1" })
    expect(await screen.findByRole("region", { name: "Exact match" })).toHaveTextContent("Filed paper")
  })

  it("People with no query is the directory, a hairline list with the department filter", async () => {
    renderWithProviders(<Search />, { route: "/search?scope=people" })
    expect(await screen.findByText(/2 people at the college/)).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "Message Anu Person" })).toHaveAttribute("href", expect.stringContaining("/messages?to="))
    expect(screen.getByRole("link", { name: "Message Zed Person" })).toBeInTheDocument()
    expect(screen.getByRole("combobox", { name: /Department/ })).toBeInTheDocument()
    // The old wall of cards said "Saveetha" on every one.
    expect(screen.queryByText("Saveetha")).toBeNull()
  })

  it("no results says so and offers the narrower scopes", async () => {
    mockedApi.mockImplementation(fakeApi({ "/api/auth/me": () => FACULTY, "/api/search/all": () => ({ q: "zzqx", scope: "all", exact: null, groups: [] }) }) as typeof api)
    renderWithProviders(<Search />, { route: "/search?q=zzqx" })
    expect(await screen.findByText(/Nothing found for “zzqx”/)).toBeInTheDocument()
  })
})

describe("Ctrl-K palette", () => {
  it("same groups, pages and actions; arrows and Enter open a result", async () => {
    const onClose = vi.fn()
    renderWithProviders(<Palette open onClose={onClose} />, { route: "/papers" })
    const input = await screen.findByRole("combobox", { name: "Find anything" })
    // Empty query: suggested actions for /papers.
    expect(screen.getByText("Download my papers (CSV)")).toBeInTheDocument()
    fireEvent.change(input, { target: { value: "kanaga" } })
    expect(await screen.findByText("Dr. S. Kanagamalliga")).toBeInTheDocument()
    expect(screen.getByRole("group", { name: "People" })).toBeInTheDocument()
    fireEvent.keyDown(input, { key: "ArrowDown" })
    expect(input.getAttribute("aria-activedescendant")).toBe("palette-1")
    fireEvent.keyDown(input, { key: "Enter" })
    expect(onClose).toHaveBeenCalled()
    expect(JSON.parse(localStorage.getItem("search.recent") || "[]")).toEqual(["kanaga"])
  })

  it("actions match by keyword and Tab cycles the scope", async () => {
    renderWithProviders(<Palette open onClose={() => {}} />, { route: "/" })
    const input = await screen.findByRole("combobox", { name: "Find anything" })
    fireEvent.change(input, { target: { value: "file" } })
    expect(await screen.findByText("File a paper")).toBeInTheDocument()
    fireEvent.keyDown(input, { key: "Tab" })
    expect(screen.getByRole("tab", { name: "Papers" })).toHaveAttribute("aria-selected", "true")
  })
})
