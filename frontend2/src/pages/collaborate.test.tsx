import { fireEvent, screen, waitFor, within } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return { ...actual, api: vi.fn() }
})

import { api } from "@/lib/api"
import { Collaborate } from "@/pages/collaborate"
import { FACULTY, failing, fakeApi, renderWithProviders } from "@/test/harness"

const person = (key: string, name: string, over: Record<string, unknown> = {}) => ({
  key,
  user_id: key.startsWith("u-") ? key : null,
  name,
  department: "ECE",
  papers_together: 3,
  first_year_together: 2022,
  last_year_together: 2025,
  institutions: [],
  countries: [],
  has_account: true,
  at_college: true,
  is_college_member: true,
  photo_url: "/media/avatars/x.jpg",
  initials: "XX",
  ...over,
})

const COAUTHORS = {
  user_id: FACULTY.id,
  publications: 9,
  inside_count: 3,
  outside_count: 2,
  inside: [
    person("u-lila", "Dr Lila Rao", { papers_together: 7 }),
    person("u-joe", "Dr Joe Paul"),
    person("u-gone", "Dr Gone Away", { has_account: false, is_college_member: false, user_id: null, key: "A1" }),
  ],
  outside: [
    person("A55", "Prof A Kumar", { has_account: false, at_college: false, is_college_member: false, user_id: null, institutions: ["IIT Madras"], department: null }),
    person("A56", "Prof B Rao", { has_account: false, at_college: false, is_college_member: false, user_id: null, institutions: ["Anna University"], department: null }),
  ],
}

function mount(route = "/collaborate", coauthors: (path: string) => unknown = () => COAUTHORS) {
  vi.mocked(api).mockReset()
  vi.mocked(api).mockImplementation(
    fakeApi({
      "/api/auth/me": () => FACULTY,
      [`/api/people/${FACULTY.id}/coauthors`]: coauthors,
      "/api/people/me/ego": () => ({ center: FACULTY.id, coauthors: 5, capped: false, nodes: [], links: [] }),
      "/api/discover/next": () => ({ people: [] }),
      "/api/search": () => ({ groups: [] }),
    })
  )
  return renderWithProviders(<Collaborate />, { route })
}

describe("Who to work with", () => {
  it("opens with the answer: how many, at the college, not on this app, outside", async () => {
    mount()
    const answer = await screen.findByRole("group", { name: "At a glance" })
    expect(within(answer).getByRole("link", { name: /5 People you have written with/ })).toHaveAttribute("href", "/collaborate")
    expect(within(answer).getByRole("link", { name: /2 Colleagues on this app/ })).toHaveAttribute("href", "/collaborate?show=members")
    expect(within(answer).getByRole("link", { name: /1 Saveetha authors not on this app/ })).toHaveAttribute("href", "/collaborate?show=others")
    expect(within(answer).getByRole("link", { name: /2 Outside, at 2 institutions/ })).toHaveAttribute("href", "/collaborate?show=outside")
  })

  it("shows a face or monogram and a next action on every row", async () => {
    mount()
    const lila = (await screen.findByText("Dr Lila Rao")).closest("li") as HTMLElement
    expect(lila.querySelector("img")).not.toBeNull()
    expect(within(lila).getByRole("link", { name: "Message Dr Lila Rao" })).toHaveAttribute("href", "/messages?to=u-lila")
    const kumar = screen.getByText("Prof A Kumar").closest("li") as HTMLElement
    expect(within(kumar).getByText("IM")).toBeInTheDocument()
  })

  it("filters to the Saveetha authors without an account, and says so on the row", async () => {
    mount("/collaborate?show=others")
    const gone = await screen.findByText("Dr Gone Away")
    expect(within(gone.closest("li") as HTMLElement).getByText(/Saveetha, not on this app/)).toBeInTheDocument()
    expect(screen.queryByText("Dr Lila Rao")).toBeNull()
  })

  it("finds a co-author by name and says when nobody matches", async () => {
    mount()
    await screen.findByText("Dr Lila Rao")
    fireEvent.change(screen.getByLabelText("Find in your co-authors"), { target: { value: "anna" } })
    expect(screen.getByText("Prof B Rao")).toBeInTheDocument()
    expect(screen.queryByText("Dr Lila Rao")).toBeNull()
    fireEvent.change(screen.getByLabelText("Find in your co-authors"), { target: { value: "zzz" } })
    expect(screen.getByText(/Nobody matching/)).toBeInTheDocument()
  })

  it("tells a failure from an empty record", async () => {
    mount("/collaborate", failing())
    expect(await screen.findByText("Could not work out who you have written with")).toBeInTheDocument()
    expect(screen.queryByText("Your co-authors will appear here")).toBeNull()
  })

  it("says what will appear when there is nobody yet", async () => {
    mount("/collaborate", () => ({ ...COAUTHORS, inside: [], outside: [], inside_count: 0, outside_count: 0 }))
    await waitFor(() => expect(screen.getByText("Your co-authors will appear here")).toBeInTheDocument())
    expect(screen.getByRole("link", { name: "Check my record" })).toHaveAttribute("href", "/papers")
  })
})
