import { screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { Route, Routes } from "react-router-dom"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return { ...actual, api: vi.fn() }
})

import type { Me } from "@/app/auth"
import { api } from "@/lib/api"
import { PeopleDirectory, PublicProfile, PublishedWork } from "@/pages/person"

describe("Published work — the full record", () => {
  it("lists the record by year, 10 at a time, with Show more", async () => {
    const papers = Array.from({ length: 23 }, (_, i) => ({
      id: `p${i}`, title: `Paper ${i}`, year: 2026 - Math.floor(i / 5), citations: i, venue: "J Test", quartile: "Q1", doi: null,
    }))
    renderWithProviders(<PublishedWork papers={papers} />)
    expect(screen.getByText("23 papers")).toBeInTheDocument()
    expect(screen.getByRole("heading", { name: "2026" })).toBeInTheDocument()
    expect(screen.getByText("Paper 9")).toBeInTheDocument()
    expect(screen.queryByText("Paper 10")).toBeNull()
    await userEvent.click(screen.getByRole("button", { name: "Show more (13 left)" }))
    expect(screen.getByText("Paper 19")).toBeInTheDocument()
    expect(document.body.textContent).not.toMatch(/₹|Rs\.|remuneration/i)
  })
})
import { fakeApi, FACULTY, renderWithProviders, type ApiTable } from "@/test/harness"

/**
 * A colleague's profile, as the owner described it: like Facebook, for the
 * college. Who they are, what they have published, who they wrote with, what
 * they post -- and never what they were paid.
 */

const COORDINATOR: Me = {
  id: "u-rc",
  email: "rc@example.edu",
  name: "R Coordinator",
  role: "RESEARCH_COORDINATOR",
  department: null,
}

function profile(over: Record<string, unknown> = {}) {
  return {
    person: {
      id: "u-ravi",
      name: "Dr Ravi Kumar",
      initials: "RK",
      photo_url: null,
      department: "Physics",
      designation: "Professor",
      role_label: "Faculty",
      bio: "Thin films, mostly.",
      interests: ["Condensed Matter Physics"],
      scopus_url: "https://www.scopus.com/authid/detail.uri?authorId=1",
      orcid_id: "0000-0002-1825-0097",
      orcid_url: "https://orcid.org/0000-0002-1825-0097",
      research_faculty: false,
    },
    is_me: false,
    papers: [
      {
        id: "c1",
        title: "Strain in epitaxial films",
        journal_title: "Physical Review B",
        publication_year: 2025,
        quartile: "Q1",
        doi: "10.1/x",
        author_position: 1,
        total_authors: 3,
        coauthors: [{ id: "u-asha", name: "Dr Asha Menon" }],
      },
    ],
    counts: { papers: 1, q1: 1, first_author: 1, areas: 1 },
    areas: [{ key: "Condensed Matter Physics", count: 1 }],
    coauthors: [
      {
        id: "u-asha",
        name: "Dr Asha Menon",
        initials: "AM",
        photo_url: null,
        department: "Mechanical Engineering",
        designation: null,
        together: 1,
      },
    ],
    follow: { following: false, followers: 3, following_count: 2 },
    posts: [],
    research_post: null,
    may_open_record: false,
    ...over,
  }
}

function mount(data: ReturnType<typeof profile>, extra: ApiTable = {}, me: Me = FACULTY) {
  vi.mocked(api).mockReset()
  vi.mocked(api).mockImplementation(
    fakeApi({
      "/api/auth/me": () => me,
      "/api/people/u-ravi": () => data,
      "/api/people/me": () => data,
      "/api/people/u-ravi/graph": () => ({ center: "u-ravi", nodes: [], links: [] }),
      "/api/feed": () => ({ tab: "everyone", results: [], next: null }),
      ...extra,
    })
  )
  renderWithProviders(
    <Routes>
      <Route path="/u/:id" element={<PublicProfile />} />
    </Routes>,
    { route: "/u/u-ravi" }
  )
  return userEvent.setup()
}

function sent(path: string) {
  return vi.mocked(api).mock.calls.filter(([p]) => String(p).startsWith(path))
}

describe("PublicProfile", () => {
  it("shows who they are and their own work, with the college co-authors linked", async () => {
    mount(profile())
    expect(await screen.findByRole("heading", { name: "Dr Ravi Kumar" })).toBeInTheDocument()
    expect(await screen.findByText("Strain in epitaxial films")).toBeInTheDocument()
    expect(screen.getByText("Thin films, mostly.")).toBeInTheDocument()
    expect(screen.getByRole("link", { name: /ORCID/ })).toHaveAttribute(
      "href",
      "https://orcid.org/0000-0002-1825-0097"
    )
    const coauthorLinks = screen.getAllByRole("link", { name: "Dr Asha Menon" })
    expect(coauthorLinks[0]).toHaveAttribute("href", "/u/u-asha")
  })

  it("never shows a rupee figure", async () => {
    mount(profile())
    await screen.findByRole("heading", { name: "Dr Ravi Kumar" })
    expect(document.body.textContent).not.toMatch(/₹|Rs\.?\s?\d|INR/)
  })

  it("follows at once", async () => {
    const user = mount(profile(), {
      "/api/follows/people/u-ravi": () => new Promise(() => {}),
    })
    const follow = await screen.findByRole("button", { name: "Follow" })
    await user.click(follow)
    expect(await screen.findByRole("button", { name: "Following" })).toBeInTheDocument()
    expect(screen.getByText("4")).toBeInTheDocument()
    expect(sent("/api/follows/people/u-ravi")[0][1]).toMatchObject({ method: "POST" })
  })

  it("offers a private message addressed to them", async () => {
    mount(profile())
    expect(await screen.findByRole("link", { name: /Message/ })).toHaveAttribute(
      "href",
      "/messages?to=u-ravi"
    )
  })

  it("shows a colleague only a badge for a research post", async () => {
    mount(profile({ person: { ...profile().person, research_faculty: true } }))
    expect(await screen.findByText("Research faculty")).toBeInTheDocument()
    expect(screen.queryByText(/quota/i)).not.toBeInTheDocument()
  })

  it("shows the person their own threshold and how much is used", async () => {
    mount(
      profile({
        is_me: true,
        person: { ...profile().person, research_faculty: true },
        research_post: {
          research_faculty: true,
          may_edit: false,
          may_set_threshold: false,
          threshold: {
            research: true,
            threshold: 300000,
            unset: false,
            year: "2026-27",
            used: 120000,
            on_the_way: 0,
            on_the_way_above: 0,
            left: 180000,
            message:
              "You are research faculty. Your threshold this year is ₹3,00,000; ₹1,20,000 used, ₹1,80,000 before incentives are paid.",
          },
        },
      })
    )
    expect(
      await screen.findByText(
        "You are research faculty. Your threshold this year is ₹3,00,000; ₹1,20,000 used, ₹1,80,000 before incentives are paid."
      )
    ).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Edit profile" })).toBeInTheDocument()
  })

  it("lets the research coordinator tick research faculty", async () => {
    const user = mount(
      profile({
        research_post: {
          research_faculty: false,
          may_edit: true,
          may_set_threshold: true,
          threshold: null,
        },
      }),
      { "/api/admin/users/u-ravi": () => ({ id: "u-ravi" }) },
      COORDINATOR
    )
    await user.click(await screen.findByRole("checkbox", { name: /^Research faculty/ }))
    expect(screen.queryByRole("spinbutton", { name: /Papers a year/ })).toBeNull()
    await user.click(screen.getByRole("button", { name: "Save research post" }))

    await waitFor(() => expect(sent("/api/admin/users/u-ravi")).toHaveLength(1))
    expect(sent("/api/admin/users/u-ravi")[0][1]).toMatchObject({
      method: "PATCH",
      json: { faculty_type: "RESEARCH" },
    })
  })
})

describe("PeopleDirectory", () => {
  it("finds colleagues and links each to their profile", async () => {
    vi.mocked(api).mockReset()
    vi.mocked(api).mockImplementation(
      fakeApi({
        "/api/auth/me": () => FACULTY,
        "/api/meta/departments": () => ["Physics"],
        "/api/people": () => ({
          total: 1,
          limit: 24,
          offset: 0,
          results: [
            {
              id: "u-ravi",
              name: "Dr Ravi Kumar",
              initials: "RK",
              photo_url: null,
              department: "Physics",
              designation: "Professor",
              interests: ["Condensed Matter Physics"],
              papers: 7,
              following: false,
            },
          ],
        }),
      })
    )
    renderWithProviders(<PeopleDirectory />, { route: "/u" })
    const user = userEvent.setup()
    await user.type(await screen.findByRole("searchbox", { name: /Search people/ }), "ravi")
    expect(await screen.findByRole("link", { name: /Dr Ravi Kumar/ })).toHaveAttribute("href", "/u/u-ravi")
    await waitFor(() => expect(sent("/api/people?").some(([p]) => String(p).includes("q=ravi"))).toBe(true))
  })
})
