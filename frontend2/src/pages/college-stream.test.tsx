import { screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return { ...actual, api: vi.fn() }
})

import { api } from "@/lib/api"
import { CollegePapers, PeopleToFollow, congratulate } from "@/pages/college-stream"
import { FACULTY, failing, fakeApi, renderWithProviders } from "@/test/harness"

const owner = { id: "u-ravi", name: "Dr Ravi Kumar", initials: "RK", photo_url: "/media/avatars/r.jpg", department: "EEE", designation: null }
const PAPER = {
  paper: {
    id: "p1",
    title: "Fast charging for light vehicles",
    journal_title: "Energy Reports",
    publication_year: 2026,
    quartile: "Q1",
    doi: null,
    coauthors: [{ id: "u-lila", name: "Dr Lila Rao" }, { id: "u-joe", name: "Dr Joe Paul" }],
  },
  owner,
  filed_at: "2026-09-28T10:00:00Z",
}

function mount(
  college: (path: string) => unknown,
  ui = <CollegePapers />,
  extra: Record<string, (path: string) => unknown> = {}
) {
  vi.mocked(api).mockReset()
  vi.mocked(api).mockImplementation(fakeApi({ "/api/auth/me": () => FACULTY, "/api/feed/college": college, ...extra }))
  return renderWithProviders(ui)
}

describe("College stream", () => {
  it("shows a face, the paper, its co-authors and two ways to respond", async () => {
    mount(() => ({ papers: [PAPER], people: [] }))
    const li = (await screen.findByText("Fast charging for light vehicles")).closest("li") as HTMLElement
    expect(li.querySelector("img")).not.toBeNull()
    expect(within(li).getByRole("link", { name: "Dr Lila Rao" })).toHaveAttribute("href", "/u/u-lila")
    expect(within(li).getByText(/Energy Reports · 2026 · Q1/)).toBeInTheDocument()
    expect(within(li).getByRole("button", { name: "Congratulate" })).toBeInTheDocument()
    expect(within(li).getByRole("button", { name: "Comment" })).toBeInTheDocument()
  })

  it("Congratulate opens the note under that paper, with the colleague named, not somewhere else", async () => {
    mount(() => ({ papers: [PAPER, { ...PAPER, paper: { ...PAPER.paper, id: "p2", title: "Another paper" } }], people: [] }))
    const li = (await screen.findByText("Fast charging for light vehicles")).closest("li") as HTMLElement
    await userEvent.click(within(li).getByRole("button", { name: "Congratulate" }))
    const box = within(li).getByRole("combobox", { name: "Your note to Dr Ravi Kumar" })
    expect(box).toHaveValue("Congratulations @Dr Ravi Kumar on “Fast charging for light vehicles” in Energy Reports, 2026! ")
    const other = screen.getByText("Another paper").closest("li") as HTMLElement
    expect(within(other).queryByRole("combobox")).toBeNull()
  })

  it("posts the note to the feed naming the colleague, then says so where the reader is looking", async () => {
    mount(() => ({ papers: [PAPER], people: [] }), <CollegePapers />, {
      "/api/feed/posts": () => ({ id: "post-9" }),
    })
    const li = (await screen.findByText("Fast charging for light vehicles")).closest("li") as HTMLElement
    await userEvent.click(within(li).getByRole("button", { name: "Comment" }))
    const box = within(li).getByRole("combobox", { name: "Your note to Dr Ravi Kumar" })
    await userEvent.type(box, "the charger design is neat")
    await userEvent.click(within(li).getByRole("button", { name: /^Post/ }))
    const call = vi.mocked(api).mock.calls.find((c) => c[0] === "/api/feed/posts")
    const form = (call?.[1] as { body: FormData }).body
    expect(String(form.get("body"))).toBe('@user:"Dr Ravi Kumar", about “Fast charging for light vehicles”: the charger design is neat')
    expect(form.getAll("mention_ids")).toEqual(["u-ravi"])
    expect(form.get("visibility")).toBe("EVERYONE")
    expect(await within(li).findByText(/Posted to the feed, and Dr Ravi Kumar has been told/)).toBeInTheDocument()
    expect(within(li).getByRole("link", { name: "See your post" })).toHaveAttribute("href", "/discussions/p/post-9")
  })

  it("shows five papers and keeps the rest one press away", async () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ ...PAPER, paper: { ...PAPER.paper, id: `p${i}`, title: `Paper number ${i}` } }))
    mount(() => ({ papers: many, people: [] }))
    expect(await screen.findByText("Paper number 4")).toBeInTheDocument()
    expect(screen.queryByText("Paper number 5")).toBeNull()
    await userEvent.click(screen.getByRole("button", { name: "Show 3 more papers" }))
    expect(screen.getByText("Paper number 7")).toBeInTheDocument()
  })

  it("keeps the draft text helpers for the congratulation", () => {
    expect(congratulate(PAPER).people).toEqual([{ id: "u-ravi", name: "Dr Ravi Kumar" }])
  })

  it("says a failed load failed, and offers a retry", async () => {
    mount(failing())
    expect(await screen.findByText("Could not load the college's new papers.")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument()
  })

  it("lists people to follow with their face, papers and whole department", async () => {
    mount(() => ({ papers: [], people: [{ ...owner, id: "u-x", name: "Dr R. Subhashini", department: "S&H-ENGLISH", papers: 10 }] }), <PeopleToFollow />)
    const card = (await screen.findByText("Dr R. Subhashini")).closest("li") as HTMLElement
    expect(card.querySelector("img")).not.toBeNull()
    expect(within(card).getByText("S&H-ENGLISH · 10 papers")).toBeInTheDocument()
  })
})
