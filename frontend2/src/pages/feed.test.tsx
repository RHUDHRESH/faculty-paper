import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return { ...actual, api: vi.fn() }
})

import { api } from "@/lib/api"
import { Feed, PaperCard, recordAsPaper } from "@/pages/feed"
import { fakeApi, FACULTY, renderWithProviders, type ApiTable } from "@/test/harness"

/**
 * The feed, as the owner asked for it: a mini social network for the college.
 * Post, like, comment and mention -- and see it happen at once, not after a
 * round trip.
 */

const RAVI = {
  id: "u-ravi",
  name: "Ravi Kumar",
  initials: "RK",
  photo_url: null,
  department: "Physics",
  designation: "Professor",
}

function post(over: Record<string, unknown> = {}) {
  return {
    id: "p1",
    author: RAVI,
    body: "Seminar on thin films, Friday at 3",
    mentions: [],
    visibility: "EVERYONE",
    department: "Physics",
    link_url: null,
    paper: null,
    attachment: null,
    created_at: new Date().toISOString(),
    edited_at: null,
    like_count: 2,
    liked: false,
    comment_count: 0,
    comments_preview: [],
    hidden: false,
    hidden_reason: null,
    reported_by_me: false,
    may_edit: false,
    may_delete: false,
    may_moderate: false,
    legacy_thread_id: null,
    ...over,
  }
}

function mount(posts: unknown[], extra: ApiTable = {}) {
  vi.mocked(api).mockReset()
  vi.mocked(api).mockImplementation(
    fakeApi({
      "/api/auth/me": () => FACULTY,
      "/api/feed?": () => ({ tab: "everyone", results: posts, next: null }),
      "/api/feed/reports": () => ({ results: [] }),
      "/api/mentions/search": () => ({ results: [] }),
      "/api/feed/my-papers": () => ({ results: [] }),
      ...extra,
    })
  )
  renderWithProviders(<Feed />, { route: "/discussions" })
  return userEvent.setup()
}

function sent(path: string) {
  return vi.mocked(api).mock.calls.filter(([p]) => String(p).startsWith(path))
}

describe("Feed", () => {
  it("shows who asked each thread, with a face, and whether it is answered", async () => {
    const user = mount([], {
      "/api/threads": () => ({
        results: [
          { id: "t1", title: "Which journal for signal processing?", visibility: "PUBLIC", department: null, topic: null,
            last_post_at: "2026-09-01", post_count: 2, resolved: true, created_by: "Dr Lila Rao", created_by_id: "u-lila",
            created_by_photo_url: "/media/avatars/l.jpg", created_by_initials: "LR" },
        ],
      }),
    })
    await user.click(await screen.findByRole("button", { name: "Questions" }))
    const row = (await screen.findByRole("link", { name: /Which journal for signal processing/ })) as HTMLElement
    expect(row.querySelector("img")).not.toBeNull()
    expect(row).toHaveTextContent("Asked by Dr Lila Rao")
    expect(row).toHaveTextContent("2 replies")
    expect(row).toHaveTextContent("Answered")
  })

  it("keeps People to follow beside the posts and has one title with one sentence of purpose", async () => {
    mount([], { "/api/feed/college": () => ({ papers: [], people: [{ id: "u-x", name: "Dr New", initials: "DN", photo_url: null, department: "CSE", designation: null, papers: 3 }] }) })
    expect(screen.getByRole("heading", { level: 1, name: "Discussions" })).toBeInTheDocument()
    expect(await screen.findByRole("complementary", { name: "Beside the feed" })).toHaveTextContent("Dr New")
  })

  it("lists public discussion threads under the Questions switch", async () => {
    const user = mount([], {
      "/api/threads": () => ({
        results: [
          { id: "t1", title: "Which journals turn papers around fastest?", visibility: "PUBLIC", department: null,
            topic: null, last_post_at: "2026-09-01", post_count: 4, resolved: false },
          { id: "t2", title: "A private chat", visibility: "DIRECT", department: null,
            topic: null, last_post_at: "2026-09-01", post_count: 1, resolved: false },
        ],
      }),
    })
    await user.click(await screen.findByRole("button", { name: "Questions" }))
    const [link] = await screen.findAllByRole("link", { name: /Which journals turn papers around fastest/ })
    expect(link).toHaveAttribute("href", "/discussions/t1")
    expect(screen.queryByText("A private chat")).toBeNull()
  })

  it("lets anybody ask a question for everybody from the Questions switch", async () => {
    const user = mount([])
    // The table helper answers by path only; this one needs the verb too.
    vi.mocked(api).mockImplementation(async (path: string, opts?: { method?: string }) => {
      if (String(path) === "/api/threads" && opts?.method === "POST") return { id: "t9" }
      if (String(path).startsWith("/api/threads")) return { results: [] }
      if (String(path) === "/api/auth/me") return FACULTY
      return { results: [], next: null }
    })
    await user.click(await screen.findByRole("button", { name: "Questions" }))
    await user.click(await screen.findByRole("button", { name: "Ask a question" }))
    const dialog = await screen.findByRole("dialog")
    const post = within(dialog).getByRole("button", { name: "Post the question" })
    expect(post).toBeDisabled()
    await user.type(within(dialog).getByLabelText("Title"), "Which journal is quickest?")
    await user.type(within(dialog).getByRole("combobox", { name: "Your question" }), "For a Q2 paper in signal processing.")
    await user.click(post)
    await waitFor(() => expect(sent("/api/threads").some(([, o]) => (o as { method?: string })?.method === "POST")).toBe(true))
    const call = sent("/api/threads").find(([, o]) => (o as { method?: string })?.method === "POST")!
    expect(call[1]).toMatchObject({
      json: { title: "Which journal is quickest?", body: "For a Q2 paper in signal processing.", visibility: "PUBLIC" },
    })
  })

  it("shares a record paper that is not filed yet as a paper card", () => {
    expect(recordAsPaper({ id: "pub1", title: "T", venue: "J", year: 2025, doi: "10.1/x" })).toMatchObject({
      id: "pub1", journal_title: "J", publication_year: 2025, from_record: true, doi: "10.1/x",
    })
    expect(recordAsPaper({ id: "claim-1", title: "T", venue: null, year: null, doi: null })).toBeNull()
  })

  it("shows a record paper card with its topic picture", () => {
    renderWithProviders(
      <PaperCard paper={{ id: "p", title: "Deep learning for crops", journal_title: "J AI", publication_year: 2025, quartile: null, doi: null }} />
    )
    expect(screen.getByText("Deep learning for crops")).toBeInTheDocument()
    expect(screen.getByText("J AI · 2025")).toBeInTheDocument()
  })

  it("invites the first post when nobody has posted yet", async () => {
    mount([])
    expect(await screen.findByText("No posts from colleagues yet")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Write a post" })).toBeInTheDocument()
  })

  it("shows a post the moment it is sent, before the server answers", async () => {
    const user = mount([], {
      // Never answers: whatever appears, appeared optimistically.
      "/api/feed/posts": () => new Promise(() => {}),
    })
    await screen.findByText("No posts from colleagues yet")
    await user.click(screen.getByRole("button", { name: "Start a post" }))
    await user.type(screen.getByRole("combobox", { name: "Write a post" }), "Hello, college")
    await user.click(screen.getByRole("button", { name: "Post" }))

    expect(await screen.findByText("Hello, college")).toBeInTheDocument()
    const [, init] = sent("/api/feed/posts")[0] as [string, { method: string; body: FormData }]
    expect(init.method).toBe("POST")
    expect(init.body.get("body")).toBe("Hello, college")
    expect(init.body.get("visibility")).toBe("EVERYONE")
  })

  it("sends a department-only post when My department is chosen", async () => {
    const user = mount([], { "/api/feed/posts": () => new Promise(() => {}) })
    await screen.findByText("No posts from colleagues yet")
    await user.click(screen.getByRole("button", { name: "Start a post" }))
    await user.type(screen.getByRole("combobox", { name: "Write a post" }), "Lab keys are with me")
    await user.click(screen.getByRole("radio", { name: /Mechanical Engineering only/ }))
    await user.click(screen.getByRole("button", { name: "Post" }))

    const [, init] = sent("/api/feed/posts")[0] as [string, { body: FormData }]
    expect(init.body.get("visibility")).toBe("DEPARTMENT")
  })

  it("counts a like at once", async () => {
    // A like is one of the reactions now (`pages/reactions.tsx`), sent to the
    // same endpoint as the other three.
    const user = mount([post()], {
      "/api/feed/posts/p1/reactions/like": () => new Promise(() => {}),
    })
    const card = (await screen.findByText("Seminar on thin films, Friday at 3")).closest("article")!
    const like = within(card as HTMLElement).getByRole("button", { name: /like/i })
    expect(like).toHaveAttribute("aria-pressed", "false")

    await user.click(like)
    expect(like).toHaveAttribute("aria-pressed", "true")
    expect(within(card as HTMLElement).getByText("3")).toBeInTheDocument()
    expect(sent("/api/feed/posts/p1/reactions/like")[0][1]).toMatchObject({ method: "POST" })
  })

  it("links the author to their profile", async () => {
    mount([post()])
    const link = await screen.findByRole("link", { name: "Ravi Kumar" })
    expect(link).toHaveAttribute("href", "/u/u-ravi")
  })

  it("adds a comment underneath straight away", async () => {
    const user = mount([post()], {
      "/api/feed/posts/p1/comments": () => new Promise(() => {}),
    })
    const card = (await screen.findByText("Seminar on thin films, Friday at 3")).closest("article")!
    await user.click(within(card as HTMLElement).getByRole("button", { name: /comment/i }))
    await user.type(within(card as HTMLElement).getByRole("combobox", { name: "Write a comment" }), "Count me in")
    await user.click(within(card as HTMLElement).getByRole("button", { name: "Reply" }))

    await waitFor(() => expect(within(card as HTMLElement).getByText("Count me in")).toBeInTheDocument())
    expect(sent("/api/feed/posts/p1/comments")[0][1]).toMatchObject({
      method: "POST",
      json: { body: "Count me in", mention_ids: [] },
    })
  })
})

describe("Discussions, reworked", () => {
  const college = (extra = {}) => ({
    "/api/feed/college": () => ({
      papers: [
        { paper: { id: "pp1", title: "Thin films for solar cells", journal_title: "J Solar", publication_year: 2026, quartile: "Q1", doi: null, coauthors: [] },
          owner: RAVI, filed_at: new Date().toISOString() },
      ],
      people: [],
    }),
    "/api/leaderboard": () => ({ rows: [{ rank: 1, person: { ...RAVI, id: "u-r2", name: "Meena Iyer" }, value: 5 }] }),
    ...extra,
  })

  it("is never dead: record cards and Most improved show among the posts", async () => {
    mount([post()], college())
    expect(await screen.findByText("Seminar on thin films, Friday at 3")).toBeInTheDocument()
    expect(await screen.findByText("Thin films for solar cells")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Congratulate" })).toBeInTheDocument()
    expect(await screen.findByRole("region", { name: "Most improved" })).toHaveTextContent("Meena Iyer")
  })

  it("keeps the empty feed alive with the record's cards", async () => {
    mount([], college())
    expect(await screen.findByText("No posts from colleagues yet")).toBeInTheDocument()
    expect(await screen.findByText("Thin films for solar cells")).toBeInTheDocument()
  })

  it("offers four kinds of post and changes the box for each", async () => {
    const user = mount([], college())
    for (const name of ["Ask a question", "Share a paper", "Announce a seminar or event", "Say well done"]) {
      expect(await screen.findByRole("button", { name })).toBeInTheDocument()
    }
    await user.click(screen.getByRole("button", { name: "Say well done" }))
    const box = await screen.findByRole("combobox", { name: "Write a post" })
    expect(box).toHaveValue("Well done ")
    expect(box).toHaveAttribute("placeholder", expect.stringContaining("worth celebrating"))
    await user.click(screen.getByRole("button", { name: "Announce a seminar or event" }))
    expect(screen.getByLabelText("Date and time")).toBeInTheDocument()
    expect(screen.getByLabelText("Place")).toBeInTheDocument()
  })

  it("posts an event with a readable block in its words", async () => {
    const user = mount([], college({ "/api/feed/posts": () => new Promise(() => {}) }))
    await user.click(await screen.findByRole("button", { name: "Announce a seminar or event" }))
    await user.type(screen.getByRole("combobox", { name: "Write a post" }), "Thin films talk")
    await user.type(screen.getByLabelText("Date and time"), "2026-10-17T15:00")
    await user.type(screen.getByLabelText("Place"), "Block C")
    await user.click(screen.getByRole("button", { name: "Post" }))
    const [, init] = sent("/api/feed/posts")[0] as [string, { body: FormData }]
    expect(init.body.get("body")).toBe("Thin films talk\n\n— Event —\nWhen: 2026-10-17 15:00\nWhere: Block C")
  })

  it("shows an event post as a card with its when and where", async () => {
    mount([post({ body: "Talk\n\n— Event —\nWhen: 2026-10-17 15:00\nWhere: Block C" })], college())
    expect(await screen.findByText("Block C")).toBeInTheDocument()
    expect(screen.getByText("Event")).toBeInTheDocument()
    expect(screen.queryByText(/— Event —/)).toBeNull()
  })

  it("filters: Questions switch lists threads, My department asks that tab", async () => {
    const user = mount([], college({ "/api/threads": () => ({ results: [] }) }))
    const questions = await screen.findByRole("button", { name: "Questions" })
    await user.click(questions)
    expect(questions).toHaveAttribute("aria-pressed", "true")
    expect(await screen.findByText("No open questions yet")).toBeInTheDocument()
    await user.click(screen.getByRole("radio", { name: "My department" }))
    await waitFor(() => expect(sent("/api/feed?").some(([p]) => String(p).includes("tab=department"))).toBe(true))
  })
})