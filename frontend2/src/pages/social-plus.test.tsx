import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { Route, Routes, useLocation } from "react-router-dom"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return { ...actual, api: vi.fn() }
})

import { api } from "@/lib/api"
import { ChatPage } from "@/pages/chat"
import { Feed } from "@/pages/feed"
import { PublicProfile } from "@/pages/person"
import { MyStats } from "@/pages/stats"
import { layout } from "@/ui/graph"
import { fakeApi, FACULTY, renderWithProviders, type ApiTable } from "@/test/harness"

/**
 * The social layer's second storey, as a colleague meets it: reactions that
 * say more than "like", a chat with read receipts and collaboration cards,
 * "For you", a profile that tells its owner what to fill in next, skills
 * colleagues vouch for, and statistics nobody else can see.
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
    body: "Our thin-film paper is out",
    mentions: [],
    visibility: "EVERYONE",
    department: "Physics",
    link_url: null,
    paper: {
      id: "c1",
      title: "Strain in epitaxial films",
      journal_title: "Physical Review B",
      publication_year: 2025,
      quartile: "Q1",
      doi: null,
      coauthors: [{ id: "u-asha", name: "Asha Menon" }],
    },
    attachment: null,
    created_at: new Date().toISOString(),
    edited_at: null,
    like_count: 1,
    liked: false,
    reactions: { LIKE: 1, CONGRATS: 2, INTERESTED: 0, COLLABORATE: 0 },
    my_reactions: [],
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

function sent(path: string) {
  return vi.mocked(api).mock.calls.filter(([p]) => String(p).startsWith(path))
}

function stub(table: ApiTable) {
  vi.mocked(api).mockReset()
  vi.mocked(api).mockImplementation(
    fakeApi({
      "/api/auth/me": () => FACULTY,
      "/api/feed/reports": () => ({ results: [] }),
      "/api/mentions/search": () => ({ results: [] }),
      "/api/feed/my-papers": () => ({ results: [] }),
      "/api/follows": () => ({ people: [], departments: [], topics: [], journals: [] }),
      ...table,
    })
  )
}

/** Where the app navigated to, shown on the page so a test can read it. */
function Where() {
  const loc = useLocation()
  return <p data-testid="where">{loc.pathname + loc.search}</p>
}

/* ------------------------------------------------------------------------ */

describe("reactions", () => {
  function mountFeed(posts: unknown[], extra: ApiTable = {}) {
    stub({ "/api/feed?": () => ({ tab: "everyone", results: posts, next: null }), ...extra })
    renderWithProviders(
      <Routes>
        <Route path="/discussions" element={<Feed />} />
        <Route path="*" element={<Where />} />
      </Routes>,
      { route: "/discussions" }
    )
    return userEvent.setup()
  }

  it("counts a congrats at once, separately from likes", async () => {
    const user = mountFeed([post()], {
      "/api/feed/posts/p1/reactions/congrats": () => new Promise(() => {}),
    })
    const card = (await screen.findByText("Our thin-film paper is out")).closest("article") as HTMLElement
    const congrats = within(card).getByRole("button", { name: "Congrats" })
    expect(congrats).toHaveAttribute("aria-pressed", "false")
    await user.click(congrats)
    expect(congrats).toHaveAttribute("aria-pressed", "true")
    // One like and two congrats already, and now this one.
    expect(within(card).getByRole("button", { name: /4 reactions/ })).toBeInTheDocument()
    expect(sent("/api/feed/posts/p1/reactions/congrats")[0][1]).toMatchObject({ method: "POST" })
  })

  it("wanting to collaborate opens a message to the author about the post", async () => {
    const user = mountFeed([post()], {
      "/api/feed/posts/p1/reactions/collaborate": () => new Promise(() => {}),
    })
    const card = (await screen.findByText("Our thin-film paper is out")).closest("article") as HTMLElement
    await user.click(within(card).getByRole("button", { name: "Want to collaborate" }))
    expect(await screen.findByTestId("where")).toHaveTextContent("/messages?to=u-ravi&ref=p1")
  })

  it("does not offer to collaborate with yourself", async () => {
    mountFeed([post({ author: { ...RAVI, id: FACULTY.id } })])
    const card = (await screen.findByText("Our thin-film paper is out")).closest("article") as HTMLElement
    expect(within(card).queryByRole("button", { name: "Want to collaborate" })).not.toBeInTheDocument()
    expect(within(card).getByRole("button", { name: "Congrats" })).toBeInTheDocument()
  })

  it("links the paper's college co-authors from the card", async () => {
    mountFeed([post()])
    expect(await screen.findByRole("link", { name: "Asha Menon" })).toHaveAttribute("href", "/u/u-asha")
  })

  it("lists who reacted, by kind", async () => {
    const user = mountFeed([post()], {
      "/api/feed/posts/p1/reactions": () => ({
        results: [{ kind: "CONGRATS", person: { ...RAVI, id: "u-meera", name: "Meera Pillai" }, at: new Date().toISOString() }],
        counts: { LIKE: 1, CONGRATS: 2, INTERESTED: 0, COLLABORATE: 0 },
      }),
    })
    await user.click(await screen.findByRole("button", { name: /3 reactions/ }))
    const dialog = await screen.findByRole("dialog", { name: "Who reacted" })
    expect(await within(dialog).findByRole("link", { name: "Meera Pillai" })).toBeInTheDocument()
  })
})

/* ------------------------------------------------------------------------ */

describe("sharing a paper", () => {
  it("opens the composer with the card, the words and the co-authors, still editable", async () => {
    stub({
      "/api/feed?": () => ({ tab: "everyone", results: [], next: null }),
      "/api/feed/share/c9": () => ({
        paper: { id: "c9", title: "Grain boundaries", journal_title: "Acta Materialia", publication_year: 2026, quartile: "Q1", doi: null, coauthors: [{ id: "u-ravi", name: "Ravi Kumar" }] },
        body: 'New paper out: “Grain boundaries” in Acta Materialia, 2026 (Q1).\nWritten with @user:"Ravi Kumar".',
        mention_ids: ["u-ravi"],
      }),
      "/api/feed/posts": () => new Promise(() => {}),
    })
    renderWithProviders(<Feed />, { route: "/discussions?share=c9" })
    const box = await screen.findByRole("combobox", { name: "Write a post" })
    await waitFor(() => expect(box).toHaveValue('New paper out: “Grain boundaries” in Acta Materialia, 2026 (Q1).\nWritten with @user:"Ravi Kumar".'))
    expect(screen.getAllByText("Grain boundaries").length).toBeGreaterThan(0)

    const user = userEvent.setup()
    await user.type(box, " Thank you all!")
    await user.click(screen.getByRole("button", { name: /^Post/ }))
    await waitFor(() => expect(sent("/api/feed/posts")).toHaveLength(1))
    const form = (sent("/api/feed/posts")[0][1] as { body: FormData }).body
    expect(form.get("paper_id")).toBe("c9")
    expect(form.getAll("mention_ids")).toEqual(["u-ravi"])
    expect(String(form.get("body"))).toMatch(/Thank you all!$/)
  })
})

/* ------------------------------------------------------------------------ */

describe("For you", () => {
  it("mixes posts, papers and people, and says why each is there", async () => {
    stub({
      "/api/feed?": () => ({ tab: "everyone", results: [], next: null }),
      "/api/feed/for-you": () => ({
        seed: "x",
        explained: "Chosen from your areas. Nothing is paid for or promoted.",
        items: [
          { kind: "post", why: "Works in Condensed Matter Physics", post: post() },
          {
            kind: "paper",
            why: "New paper in Optics",
            paper: { id: "c2", title: "Photonic lattices", journal_title: "Optica", publication_year: 2026, quartile: "Q1", doi: null, coauthors: [] },
            owner: { ...RAVI, id: "u-meera", name: "Meera Pillai" },
          },
          {
            kind: "person",
            why: "New to the college. Works in Optics.",
            new: true,
            person: { ...RAVI, id: "u-nila", name: "Nila Newcomer", interests: ["Optics"], papers: 0 },
          },
        ],
      }),
    })
    renderWithProviders(<Feed />, { route: "/discussions?tab=for-you" })
    expect(await screen.findByText("Works in Condensed Matter Physics")).toBeInTheDocument()
    expect(screen.getByText("Photonic lattices")).toBeInTheDocument()
    expect(screen.getByText("New to the college. Works in Optics.")).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "Nila Newcomer" })).toHaveAttribute("href", "/u/u-nila")
    expect(screen.getByText(/Nothing is paid for or promoted/)).toBeInTheDocument()
    expect(document.body.textContent).not.toMatch(/₹|Rs\.?\s?\d|INR/)
  })

  it("asks for a different mix on request", async () => {
    stub({
      "/api/feed?": () => ({ tab: "everyone", results: [], next: null }),
      "/api/feed/for-you": () => ({ seed: "x", explained: "", items: [] }),
    })
    renderWithProviders(<Feed />, { route: "/discussions?tab=for-you" })
    const user = userEvent.setup()
    await user.click(await screen.findByRole("button", { name: /Show me something else/ }))
    await waitFor(() => expect(sent("/api/feed/for-you").length).toBeGreaterThan(1))
    const seeds = sent("/api/feed/for-you").map(([p]) => new URL(String(p), "http://x").searchParams.get("seed"))
    expect(new Set(seeds).size).toBeGreaterThan(1)
  })
})

/* ------------------------------------------------------------------------ */

function conversation(over: Record<string, unknown> = {}) {
  const sentAt = new Date(Date.now() - 60_000).toISOString()
  return {
    id: "t1",
    is_group: false,
    title: "Ravi Kumar",
    people: [RAVI],
    participants: [
      { ...RAVI, me: false, last_read_at: null },
      { id: FACULTY.id, name: FACULTY.name, initials: "AM", photo_url: null, me: true, last_read_at: sentAt },
    ],
    messages: [
      { id: "m1", author: RAVI, kind: "HUMAN", body: "Shall we write together?", deleted: false, created_at: sentAt, mine: false, collab: null },
      { id: "m2", author: { id: FACULTY.id, name: FACULTY.name, initials: "AM", photo_url: null }, kind: "HUMAN", body: "Yes!", deleted: false, created_at: sentAt, mine: true, collab: null },
    ],
    may_post: true,
    ...over,
  }
}

describe("a direct message", () => {
  function mountChat(data: unknown, extra: ApiTable = {}) {
    stub({ "/api/dm/t1": () => data, ...extra })
    renderWithProviders(
      <Routes>
        <Route path="/messages/c/:id" element={<ChatPage />} />
      </Routes>,
      { route: "/messages/c/t1" }
    )
    return userEvent.setup()
  }

  it("shows the conversation and says the last message was sent, not seen, until it is read", async () => {
    mountChat(conversation())
    expect(await screen.findByText("Shall we write together?")).toBeInTheDocument()
    expect(screen.getByText("Sent")).toBeInTheDocument()
  })

  it("says seen once the other person has read it", async () => {
    const c = conversation()
    c.participants[0].last_read_at = new Date().toISOString()
    mountChat(c)
    expect(await screen.findByText("Seen")).toBeInTheDocument()
  })

  it("sends with Enter and shows the message before the server answers", async () => {
    const user = mountChat(conversation(), { "/api/dm/t1/messages": () => new Promise(() => {}) })
    const box = await screen.findByRole("textbox", { name: "Write a message" })
    await user.type(box, "See you at 3{Enter}")
    expect(await screen.findByText("See you at 3")).toBeInTheDocument()
    expect(sent("/api/dm/t1/messages")[0][1]).toMatchObject({ method: "POST", json: { body: "See you at 3" } })
  })

  it("lets the person asked accept a collaboration request", async () => {
    const card = {
      id: "r1",
      topic: "Thin films",
      journal: "Physical Review B",
      message: null,
      state: "PENDING",
      response_note: null,
      responded_at: null,
      sender: RAVI,
      recipient: { id: FACULTY.id, name: FACULTY.name, initials: "AM", photo_url: null },
      may_respond: true,
      collaboration_id: null,
    }
    const c = conversation()
    c.messages = [{ ...c.messages[0], collab: card }]
    const user = mountChat(c, { "/api/collaborations/requests/r1/respond": () => ({ ...card, state: "ACCEPTED", may_respond: false }) })
    const region = await screen.findByRole("region", { name: "Collaboration request" })
    expect(within(region).getByText("Thin films")).toBeInTheDocument()
    await user.click(within(region).getByRole("button", { name: "Accept" }))
    await waitFor(() => expect(sent("/api/collaborations/requests/r1/respond")).toHaveLength(1))
    expect(sent("/api/collaborations/requests/r1/respond")[0][1]).toMatchObject({ method: "POST", json: { action: "accept" } })
  })

  it("only marks a conversation read when it is on screen", async () => {
    mountChat(conversation())
    await screen.findByText("Shall we write together?")
    // jsdom's document is "visible", so the open conversation asks with read=1.
    expect(sent("/api/dm/t1").some(([p]) => String(p).includes("read=1"))).toBe(true)
  })
})

/* ------------------------------------------------------------------------ */

function me(over: Record<string, unknown> = {}) {
  return {
    person: {
      id: FACULTY.id,
      name: FACULTY.name,
      initials: "AM",
      photo_url: null,
      department: "Mechanical Engineering",
      designation: null,
      role_label: "Faculty",
      bio: null,
      interests: [],
      scopus_url: null,
      orcid_id: null,
      orcid_url: null,
      research_faculty: false,
    },
    is_me: true,
    papers: [],
    counts: { papers: 0, q1: 0, first_author: 0, areas: 0 },
    areas: [],
    coauthors: [],
    follow: { following: false, followers: 2, following_count: 1 },
    posts: [],
    research_post: null,
    may_open_record: false,
    skills: [],
    pinned: [],
    collaborations: [],
    completeness: {
      score: 29,
      items: [
        { key: "photo", label: "A photo", done: true, next_step: "Add a photo so colleagues recognise you.", action: "edit" },
        { key: "bio", label: "A few lines about you", done: false, next_step: "Say what you work on.", action: "edit" },
        { key: "scopus", label: "Scopus link", done: false, next_step: "Ask the research office to add your Scopus author link.", action: "/me" },
      ],
    },
    stats: { followers: 2, following: 1, profile_views_30d: 7, reach_30d: 12, engagement_rate: 0.25 },
    ...over,
  }
}

describe("your own profile", () => {
  function mountProfile(data: unknown, extra: ApiTable = {}, route = "/u/me") {
    stub({
      "/api/people/me": () => data,
      "/api/people/u-ravi": () => data,
      "/api/people/u-faculty/graph": () => ({ center: FACULTY.id, nodes: [], links: [] }),
      "/api/people/u-ravi/graph": () => ({ center: "u-ravi", nodes: [], links: [] }),
      "/api/feed?": () => ({ tab: "everyone", results: [], next: null }),
      ...extra,
    })
    renderWithProviders(
      <Routes>
        <Route path="/u/:id" element={<PublicProfile />} />
      </Routes>,
      { route }
    )
    return userEvent.setup()
  }

  it("shows how complete it is, with the next step for each missing part", async () => {
    mountProfile(me())
    expect(await screen.findByText("Your profile is 29% complete")).toBeInTheDocument()
    expect(screen.getByRole("progressbar", { name: "Profile completeness" })).toHaveAttribute("aria-valuenow", "29")
    expect(screen.getByText(/Say what you work on/)).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "Ask the office" })).toHaveAttribute("href", "/me")
    // A part already done is not nagged about.
    expect(screen.queryByText(/Add a photo so colleagues/)).not.toBeInTheDocument()
  })

  it("shows the owner a small stats card, private to them", async () => {
    mountProfile(me())
    const card = await screen.findByRole("region", { name: "Your stats" })
    expect(within(card).getByText("7")).toBeInTheDocument()
    expect(within(card).getByText("Only you see this")).toBeInTheDocument()
    expect(within(card).getByRole("link", { name: /All your stats/ })).toHaveAttribute("href", "/u/me/stats")
  })

  it("shows nobody else a completeness meter or stats", async () => {
    mountProfile(me({ is_me: false, completeness: null, stats: null }), {}, "/u/u-ravi")
    await screen.findByRole("heading", { name: FACULTY.name })
    expect(screen.queryByText(/% complete/)).not.toBeInTheDocument()
    expect(screen.queryByRole("region", { name: "Your stats" })).not.toBeInTheDocument()
  })

  it("keeps the profile up when the network drawing gets an answer it cannot draw", async () => {
    mountProfile(me(), { "/api/people/u-faculty/graph": () => ({}) })
    expect(await screen.findByRole("heading", { name: FACULTY.name })).toBeInTheDocument()
    expect(await screen.findByText("No network here yet")).toBeInTheDocument()
  })

  it("lets a colleague endorse a skill at once", async () => {
    const skill = { id: "s1", name: "X-ray diffraction", count: 1, coauthor_count: 0, endorsed_by_me: false, endorsers: [], may_endorse: true }
    const user = mountProfile(
      me({ is_me: false, completeness: null, stats: null, skills: [skill] }),
      { "/api/skills/s1/endorse": () => new Promise(() => {}) },
      "/u/u-ravi"
    )
    const button = await screen.findByRole("button", { name: /Endorse/ })
    await user.click(button)
    expect(await screen.findByRole("button", { name: "Endorsed" })).toBeInTheDocument()
    expect(screen.getByText("2 endorsements")).toBeInTheDocument()
    expect(sent("/api/skills/s1/endorse")[0][1]).toMatchObject({ method: "POST" })
  })
})

/* ------------------------------------------------------------------------ */

describe("your stats page", () => {
  it("shows your numbers and every notification switch", async () => {
    stub({
      "/api/people/me/stats": () => ({
        days: 30,
        followers: 4,
        following: 2,
        new_followers_30d: 1,
        profile_views_30d: 9,
        profile_visits_30d: 11,
        views_by_day: [{ day: "2026-09-23", count: 3 }],
        posts: { count: 2, count_30d: 2, reach: 20, reach_30d: 20, reactions: 3, reactions_by_kind: { LIKE: 1, CONGRATS: 2 }, comments: 1, engagement_rate: 0.2 },
        top_posts: [{ id: "p1", excerpt: "My best post", created_at: new Date().toISOString(), visibility: "EVERYONE", reach: 12, reactions: 3, comments: 1, engaged: 3, engagement_rate: 0.25 }],
        privacy: "Only you see these numbers. Nobody is shown who visited their profile.",
      }),
      "/api/people/me/social-settings": () => ({
        notifications: [
          { kind: "message", label: "Somebody sends you a direct message", on: true },
          { kind: "reaction", label: "Somebody congratulates you", on: false },
        ],
        count_my_visits: true,
      }),
    })
    renderWithProviders(<MyStats />, { route: "/u/me/stats" })
    expect(await screen.findByText("Only you see these numbers. Nobody is shown who visited their profile.")).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "My best post" })).toHaveAttribute("href", "/discussions/p/p1")
    // A switch's hint sits inside its label, so names are matched from the start.
    const switchFor = (name: string) => screen.getByRole("switch", { name: new RegExp(`^${name}`) })
    expect(await screen.findByRole("switch", { name: "Somebody sends you a direct message" })).toHaveAttribute("aria-checked", "true")
    expect(switchFor("Somebody congratulates you")).toHaveAttribute("aria-checked", "false")
    expect(switchFor("Count my visits in colleagues' stats")).toHaveAttribute("aria-checked", "true")
  })

  it("switches a kind of notification off at once", async () => {
    stub({
      "/api/people/me/stats": () => new Promise(() => {}),
      "/api/people/me/social-settings": (path) =>
        path
          ? {
              notifications: [{ kind: "message", label: "Somebody sends you a direct message", on: true }],
              count_my_visits: true,
            }
          : null,
    })
    renderWithProviders(<MyStats />, { route: "/u/me/stats" })
    const user = userEvent.setup()
    await user.click(await screen.findByRole("switch", { name: "Somebody sends you a direct message" }))
    await waitFor(() =>
      expect(sent("/api/people/me/social-settings").some(([, o]) => (o as { method?: string })?.method === "PUT")).toBe(true)
    )
    const put = sent("/api/people/me/social-settings").find(([, o]) => (o as { method?: string })?.method === "PUT")!
    expect(put[1]).toMatchObject({ json: { muted: ["message"] } })
  })
})

/* ------------------------------------------------------------------------ */

describe("the network layout", () => {
  const nodes = [
    { id: "a", name: "A", degree: 2 },
    { id: "b", name: "B", degree: 1 },
    { id: "c", name: "C", degree: 1 },
  ]
  const links = [
    { source: "a", target: "b", papers: 1, kind: "coauthor" as const },
    { source: "a", target: "c", papers: 0, kind: "collab" as const },
  ]

  it("draws the same picture every time for the same people", () => {
    const one = layout(nodes, links)
    const two = layout(nodes, links)
    for (const n of nodes) expect(one.get(n.id)).toEqual(two.get(n.id))
  })

  it("keeps the person a profile is about in the middle", () => {
    expect(layout(nodes, links, "a").get("a")).toEqual({ x: 500, y: 350 })
  })

  it("keeps everybody inside the drawing", () => {
    for (const p of layout(nodes, links).values()) {
      expect(p.x).toBeGreaterThanOrEqual(20)
      expect(p.x).toBeLessThanOrEqual(980)
      expect(p.y).toBeGreaterThanOrEqual(20)
      expect(p.y).toBeLessThanOrEqual(680)
    }
  })
})
