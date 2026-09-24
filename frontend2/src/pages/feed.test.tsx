import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return { ...actual, api: vi.fn() }
})

import { api } from "@/lib/api"
import { Feed } from "@/pages/feed"
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
  it("invites the first post when nobody has posted yet", async () => {
    mount([])
    expect(await screen.findByText("Nothing here yet")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Write the first post" })).toBeInTheDocument()
  })

  it("shows a post the moment it is sent, before the server answers", async () => {
    const user = mount([], {
      // Never answers: whatever appears, appeared optimistically.
      "/api/feed/posts": () => new Promise(() => {}),
    })
    await screen.findByText("Nothing here yet")
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
    await screen.findByText("Nothing here yet")
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
