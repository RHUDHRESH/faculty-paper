import { describe, expect, it } from "vitest"

import { can } from "@/app/auth"
import { activeDoor, HUBS, hubSections, inResearch, isCurrentEntry, NAV, navBadges, navFor, pagesFor, REDIRECTS, reviewsFlags, type HubKey } from "@/app/nav"

/**
 * A head of department is a faculty member who also heads the department
 * (the college's decision of 2026-09-23): they keep filing their own papers.
 * The sidebar has to offer them the same two doors a faculty member has,
 * and `can()` has to agree with `rbac.CLAIMANT_ROLES` on the server.
 */
describe("a head of department files papers", () => {
  const paths = (role: Parameters<typeof navFor>[0]) => pagesFor(role).map((i) => i.to)

  it("offers a head My papers and File a paper, beside their department", () => {
    expect(paths("HOD")).toEqual(expect.arrayContaining(["/papers", "/papers/new", "/department"]))
  })

  it("still offers them to faculty, under Record, as the daily work", () => {
    expect(paths("FACULTY")).toEqual(expect.arrayContaining(["/papers", "/papers/new"]))
    for (const item of navFor("FACULTY").filter((i) => i.to.startsWith("/papers"))) {
      expect(item.group, item.to).toBe("Record")
      expect(item.area, item.to).toBe("record")
    }
  })

  it("puts a head's own papers in the folded Research group, open by default for them", () => {
    const mine = navFor("HOD").filter((i) => i.to.startsWith("/papers"))
    expect(mine.map((i) => i.label)).toEqual(["My papers", "File a paper"])
    for (const item of mine) {
      expect(item.group).toBe("Research")
      expect(item.fold).toBe(true)
    }
  })

  it("offers Flags and Past claims to the desks that judge a paper, and to nobody else", () => {
    for (const role of ["SUPER_ADMIN", "RESEARCH_CELL", "RESEARCH_COORDINATOR", "PRINCIPAL"] as const) {
      expect(paths(role)).toEqual(expect.arrayContaining(["/flags", "/archive"]))
      expect(reviewsFlags(role)).toBe(true)
    }
    // `rbac.can_review_flags`: the Director and Finance are not shown the
    // doubts about what they authorise and pay; a claimant is not shown the
    // doubts about their own paper.
    for (const role of ["DIRECTOR", "FINANCE", "FACULTY", "HOD"] as const) {
      expect(paths(role)).not.toContain("/flags")
      expect(paths(role)).not.toContain("/archive")
      expect(reviewsFlags(role)).toBe(false)
    }
  })

  it("marks a head as somebody who files their own papers, and still money-blind to others", () => {
    expect(can("HOD").fileOwnPapers).toBe(true)
    expect(can("FACULTY").fileOwnPapers).toBe(true)
    expect(can("HOD").seeMoney).toBe(false)
  })
})

/**
 * Everybody with an office role but the super admin is an academic too
 * (`rbac.CLAIMANT_ROLES`): they "must be able to do both — do their own
 * research as well as track others'". The sidebar keeps their office items
 * as they were and adds a "My research" group with the two doors a claimant
 * has.
 */
describe("an officer files their own papers too", () => {
  const OFFICERS = ["RESEARCH_CELL", "RESEARCH_COORDINATOR", "PRINCIPAL", "DIRECTOR", "FINANCE"] as const
  const OFFICE_DOOR: Record<(typeof OFFICERS)[number], string> = {
    RESEARCH_CELL: "/clearing",
    RESEARCH_COORDINATOR: "/clearing",
    PRINCIPAL: "/approvals",
    DIRECTOR: "/authorisations",
    FINANCE: "/payments",
  }

  it("offers every officer My papers and File a paper under Research, and the desk as a door", () => {
    for (const role of OFFICERS) {
      const items = navFor(role)
      const mine = items.filter((i) => i.to === "/papers" || i.to === "/papers/new")
      expect(mine.map((i) => i.label), role).toEqual(["My papers", "File a paper"])
      for (const item of mine) expect(item.group, `${role} ${item.to}`).toBe("Research")
      // The desk is one of the few doors, with no heading over it.
      expect(items.map((i) => i.to), role).toContain(OFFICE_DOOR[role])
      const door = items.find((i) => i.to === OFFICE_DOOR[role])
      expect(door?.group, role).toBeUndefined()
      expect(door?.fold, role).toBeUndefined()
    }
  })

  it("draws Research as one run of items, so the sidebar heads it once", () => {
    for (const role of [...OFFICERS, "SUPER_ADMIN", "HOD"] as const) {
      const groups = navFor(role).map((i) => i.group)
      const first = groups.indexOf("Research")
      const last = groups.lastIndexOf("Research")
      expect(first, role).toBeGreaterThanOrEqual(0)
      expect(groups.slice(first, last + 1).every((g) => g === "Research"), role).toBe(true)
    }
  })

  it("marks every officer as filing their own papers, and not the super admin", () => {
    for (const role of OFFICERS) expect(can(role).fileOwnPapers, role).toBe(true)
    expect(can("SUPER_ADMIN").fileOwnPapers).toBe(false)
    expect(can(undefined).fileOwnPapers).toBe(false)
    expect(navFor("SUPER_ADMIN").map((i) => i.to)).not.toContain("/papers/new")
    expect(navFor("SUPER_ADMIN").map((i) => i.to)).not.toContain("/papers")
  })
})

/**
 * The office sidebar is jobs, not a pile: a handful of doors per role, the
 * rarely used pages behind three hubs, and not one page lost on the way.
 * Before this the super admin had 37 entries, 14 of them under "Set up".
 */
describe("the office sidebar", () => {
  const ROLES = ["SUPER_ADMIN", "RESEARCH_CELL", "RESEARCH_COORDINATOR", "PRINCIPAL", "DIRECTOR", "FINANCE", "HOD"] as const
  const doors = (role: (typeof ROLES)[number]) => navFor(role).filter((i) => !i.fold && !i.pinned)
  const labels = (role: (typeof ROLES)[number]) => doors(role).map((i) => i.label)

  it("gives each role the doors on its own work, in this order", () => {
    expect(labels("SUPER_ADMIN")).toEqual(["Home", "Claims", "Track", "Faculty", "Reports", "Ask the data", "Admin"])
    expect(labels("RESEARCH_CELL")).toEqual(["Home", "Claims", "Track", "Faculty", "Reports", "Ask the data", "Admin"])
    expect(labels("RESEARCH_COORDINATOR")).toEqual(["Home", "Claims", "Track", "Faculty", "Reports", "Ask the data", "Admin"])
    expect(labels("PRINCIPAL")).toEqual(["Home", "Approvals", "Track", "Faculty", "Money", "Reports", "Ask the data"])
    expect(labels("DIRECTOR")).toEqual(["Home", "Authorisations", "Track", "Money", "Reports", "Ask the data"])
    expect(labels("FINANCE")).toEqual(["Home", "Payments", "Track", "Money", "Reports", "Ask the data"])
    expect(labels("HOD")).toEqual(["Home", "Department", "Track", "Reports", "Ask the data"])
  })

  it("offers Ask the data to every office seat and a head, and never to faculty", () => {
    // Mirrors `insights.may_ask` on the server: the reports' readers and a head.
    for (const role of ROLES) expect(pagesFor(role).map((i) => i.to), role).toContain("/insights")
    expect(pagesFor("FACULTY").map((i) => i.to)).not.toContain("/insights")
    expect(navFor("FACULTY").map((i) => i.to)).not.toContain("/insights")
    expect(activeDoor("HOD", "/insights")).toBe("/insights")
  })

  it("never has more than seven doors, and the desk queue is always the second", () => {
    for (const role of ROLES) {
      expect(doors(role).length, role).toBeLessThanOrEqual(7)
      expect(["/clearing", "/approvals", "/authorisations", "/payments", "/department"], role).toContain(doors(role)[1].to)
    }
  })

  it("folds the research and community pages under one Research group", () => {
    for (const role of ROLES) {
      const research = navFor(role).filter((i) => i.fold)
      expect(research.every((i) => i.group === "Research"), role).toBe(true)
      expect(research.map((i) => i.to), role).toEqual(expect.arrayContaining(["/research", "/messages", "/leaderboard"]))
    }
    // Calendar stays pinned at the foot.
    for (const role of ROLES) expect(navFor(role).filter((i) => i.pinned).map((i) => i.to)).toEqual(["/calendar"])
  })

  it("keeps Faculty''s sidebar as it was", () => {
    expect(navFor("FACULTY")).toEqual(pagesFor("FACULTY").filter((p) => !p.findOnly))
    expect(navFor("FACULTY").some((i) => i.fold)).toBe(false)
  })

  it("adds Track for every office seat and a head, and Admin for the office alone", () => {
    for (const role of ROLES) expect(pagesFor(role).map((i) => i.to), role).toContain("/track")
    expect(pagesFor("FACULTY").map((i) => i.to)).not.toContain("/track")
    for (const role of ["SUPER_ADMIN", "RESEARCH_CELL", "RESEARCH_COORDINATOR"] as const) {
      expect(pagesFor(role).map((i) => i.to), role).toContain("/admin")
    }
    for (const role of ["PRINCIPAL", "DIRECTOR", "FINANCE", "HOD", "FACULTY"] as const) {
      expect(pagesFor(role).map((i) => i.to), role).not.toContain("/admin")
    }
  })

  // The sidebar door that opens each hub.
  const HUB_DOOR: Record<HubKey, string> = { admin: "/admin", money: "/money", reports: "/reports/all", claims: "/track" }

  it("loses no page: every page a role may open is a door, in Research, pinned, or on a hub it can reach", () => {
    for (const role of ROLES) {
      const sidebar = navFor(role)
      const doorPaths = new Set(sidebar.map((i) => i.to))
      const reachable = new Set(doorPaths)
      for (const hub of Object.keys(HUBS) as HubKey[]) {
        if (!doorPaths.has(HUB_DOOR[hub])) continue
        for (const s of hubSections(hub, role)) for (const p of s.items) reachable.add(p.to)
      }
      // Find-only pages (Your profile, Wall of fame) are reached by name and by
      // link, not from a sidebar or a hub, and are checked by the next test.
      const lost = pagesFor(role).filter((p) => !p.findOnly).map((p) => p.to).filter((to) => !reachable.has(to))
      expect(lost, `${role} cannot reach ${lost.join(", ")}`).toEqual([])
    }
  })

  it("still declares every route the old sidebar offered", () => {
    const OLD = [
      "/search", "/", "/clearing", "/approvals", "/authorisations", "/payments", "/department",
      "/papers", "/papers/new", "/research", "/discover", "/scout", "/collaborate", "/messages",
      "/discussions", "/leaderboard", "/calendar", "/publications", "/reports", "/reports/brief",
      "/reports/build", "/journals", "/accreditation", "/ledger", "/statements", "/duplicates",
      "/flags", "/archive", "/faults", "/jobs", "/audit", "/people", "/people/matches", "/requests",
      "/budget", "/policy", "/settings", "/reference", "/imports", "/batches", "/data",
      "/data/health", "/data/record",
    ]
    const declared = new Set(NAV.map((i) => i.to))
    expect(OLD.filter((to) => !declared.has(to))).toEqual([])
  })

  it("gives every hub row a purpose, in plain sentence case", () => {
    for (const role of ROLES) {
      for (const hub of Object.keys(HUBS) as HubKey[]) {
        for (const s of hubSections(hub, role)) {
          for (const p of s.items) {
            expect(p.purpose, `${p.to}`).toBeTruthy()
            expect(p.purpose, `${p.to}`).not.toMatch(/ — /)
            expect(p.purpose![0], `${p.to}`).toBe(p.purpose![0].toUpperCase())
          }
        }
      }
    }
  })

  it("shows the super admin four admin sections and a research office member only what is theirs", () => {
    expect(hubSections("admin", "SUPER_ADMIN").map((s) => s.title)).toEqual(["People and roles", "Data", "Money", "System"])
    const cell = hubSections("admin", "RESEARCH_CELL").flatMap((s) => s.items.map((p) => p.to))
    expect(cell).toEqual(expect.arrayContaining(["/people", "/imports", "/policy", "/faults", "/audit"]))
    // The job queue, data health and the ledger are the super admin''s.
    for (const to of ["/jobs", "/data/health", "/ledger", "/data"]) expect(cell).not.toContain(to)
  })

  it("lights the door a page belongs to", () => {
    expect(activeDoor("SUPER_ADMIN", "/")).toBe("/")
    expect(activeDoor("SUPER_ADMIN", "/budget")).toBe("/admin")
    expect(activeDoor("PRINCIPAL", "/budget")).toBe("/money")
    expect(activeDoor("FINANCE", "/ledger")).toBe("/money")
    expect(activeDoor("RESEARCH_CELL", "/people/matches")).toBe("/admin")
    expect(activeDoor("RESEARCH_CELL", "/faculty/abc")).toBe("/faculty")
    expect(activeDoor("RESEARCH_CELL", "/review/abc123")).toBe("/clearing")
    expect(activeDoor("PRINCIPAL", "/review/abc123")).toBe("/approvals")
    expect(activeDoor("DIRECTOR", "/journals/Nature")).toBe("/reports/all")
    expect(activeDoor("SUPER_ADMIN", "/papers")).toBeUndefined()
  })
})
/**
 * Seminars, workshops and calls for papers were "practically invisible": the
 * only place they could be was the calendar. The page that shows them is in the
 * Research group, directly under My research, for everybody who has that group,
 * and a person looking for one by name or by job finds it in Ctrl K.
 */
describe("Events and research", () => {
  const ROLES = ["FACULTY", "HOD", "PRINCIPAL", "DIRECTOR", "FINANCE", "RESEARCH_CELL", "RESEARCH_COORDINATOR", "SUPER_ADMIN"] as const

  it("sits right under My research in the Research group, for every role", () => {
    for (const role of ROLES) {
      const research = navFor(role).filter((i) => i.group === "Research")
      const at = research.findIndex((i) => i.to === "/research")
      expect(at, `${role} has My research`).toBeGreaterThanOrEqual(0)
      expect(research[at + 1]?.to, role).toBe("/events")
      expect(research[at + 1]?.label, role).toBe("Events and research")
    }
  })

  it("is not a find-only page: it is in the sidebar, with the research colour", () => {
    const item = NAV.find((i) => i.to === "/events")
    expect(item?.findOnly).toBeFalsy()
    expect(item?.area).toBe("research")
    expect(item?.roles).toBeUndefined() // everybody signed in
  })

  it("is found in Ctrl K by what people call these things", () => {
    for (const role of ROLES) {
      const page = pagesFor(role).find((i) => i.to === "/events")
      expect(page, role).toBeDefined()
      const words = [page!.label, ...(page!.keywords ?? [])].join(" ").toLowerCase()
      for (const word of ["seminar", "workshop", "conference", "call for papers", "fdp", "going", "showcase"]) {
        expect(words, `${role} ${word}`).toContain(word)
      }
      expect(page!.purpose).toBeTruthy()
      expect(page!.purpose).not.toMatch(/ — /)
    }
  })
})

/**
 * The sidebar says how much is waiting at the reader's own desk, so the queue
 * is one glance away from any page -- and says nothing about anybody else's.
 */
describe("nav badges", () => {
  const counts = { draft: 2, filed: 13, checked: 3, approved: 4, authorised: 5, paid: 81, sent_back: 1 }

  it("counts each desk's own queue", () => {
    expect(navBadges("RESEARCH_CELL", counts)).toEqual({ "/clearing": 13 })
    expect(navBadges("SUPER_ADMIN", counts)).toEqual({ "/clearing": 13 })
    expect(navBadges("PRINCIPAL", counts)).toEqual({ "/approvals": 3 })
    expect(navBadges("DIRECTOR", counts)).toEqual({ "/authorisations": 4 })
    expect(navBadges("FINANCE", counts)).toEqual({ "/payments": 5 })
  })

  it("tells a claimant only what has come back to them", () => {
    expect(navBadges("FACULTY", counts)).toEqual({ "/papers": 1 })
    expect(navBadges("HOD", counts)).toEqual({ "/papers": 1 })
  })

  it("draws nothing for an empty queue or before the counts arrive", () => {
    expect(navBadges("PRINCIPAL", { ...counts, checked: 0 })).toEqual({})
    expect(navBadges("PRINCIPAL", undefined)).toEqual({})
  })
})

/**
 * Convocation (docs/ux/00 §9): a faculty sidebar of four coloured groups,
 * Search and Home above them and Calendar pinned below. Folded destinations
 * redirect rather than 404.
 */
describe("the Convocation sidebar", () => {
  it("gives faculty Search, Home, three groups and a pinned Calendar", () => {
    const items = navFor("FACULTY")
    expect(items.map((i) => i.label)).toEqual([
      "Search", "Home",
      "My papers", "File a paper",
      "My research", "Events and research", "Research tools",
      "Who to work with", "Messages", "Discussions", "Leaderboard",
      "Calendar",
    ])
    expect([...new Set(items.map((i) => i.group).filter(Boolean))]).toEqual(["Record", "Research", "People"])
    expect(items.find((i) => i.to === "/calendar")?.pinned).toBe(true)
  })

  it("colours every grouped item with its group's area, Leaderboard keeping the honours colour", () => {
    const area = { Record: "record", Research: "research", People: "people" } as const
    for (const i of navFor("FACULTY")) if (i.group && i.to !== "/leaderboard") expect(i.area, i.label).toBe(area[i.group as keyof typeof area])
    expect(NAV.find((i) => i.to === "/leaderboard")?.area).toBe("honours")
  })

  it("keeps the three research tools routed and findable, but out of the sidebar", () => {
    for (const to of ["/discover", "/journal-check", "/compass"]) {
      expect(NAV.find((i) => i.to === to)?.findOnly, to).toBe(true)
      expect(navFor("FACULTY").map((i) => i.to)).not.toContain(to)
    }
    expect(pagesFor("FACULTY").map((i) => i.to)).toEqual(expect.arrayContaining(["/discover", "/journal-check", "/compass"]))
  })

  it("lights Research tools on each of its three pages", () => {
    const tools = NAV.find((i) => i.to === "/tools")!
    for (const path of ["/compass", "/discover", "/journal-check", "/scout", "/tools"]) {
      expect(isCurrentEntry(tools, path), path).toBe(true)
    }
    expect(isCurrentEntry(tools, "/events")).toBe(false)
    expect(isCurrentEntry(tools, "/discoverx")).toBe(false)
  })

  it("opens the staff Research fold on the research tools, including /discover", () => {
    for (const path of ["/discover", "/compass", "/journal-check", "/scout"]) {
      expect(inResearch(path), path).toBe(true)
    }
    expect(inResearch("/discoverx")).toBe(false)
  })

  it("folds Research tools into the staff Research group in place of the three tools", () => {
    const labels = navFor("PRINCIPAL").map((i) => i.label)
    expect(labels).toContain("Research tools")
    expect(labels).not.toContain("Discover")
    expect(labels).not.toContain("Research compass")
    expect(navFor("HOD").filter((i) => i.fold).map((i) => i.label)).toEqual([
      "My papers", "File a paper", "My research", "Events and research", "Research tools",
      "Who to work with", "Messages", "Discussions", "Leaderboard",
    ])
  })

  it("drops the folded destinations from the sidebar and redirects them", () => {
    const to = NAV.map((i) => i.to)
    for (const gone of ["/u", "/network", "/goals", "/programme", "/impact"]) expect(to).not.toContain(gone)
    // The wall stays a real page, found by name and not listed in a sidebar.
    expect(NAV.find((i) => i.to === "/wall")?.findOnly).toBe(true)
    expect(REDIRECTS).toEqual({
      "/u": "/search?scope=people",
      "/network": "/collaborate?view=map",
      "/goals": "/research?tab=me#this-year",
      "/programme": "/research?tab=me",
      "/impact": "/research",
    })
  })

  it("keeps the old words findable in the palette", () => {
    const kw = (to: string) => NAV.find((i) => i.to === to)?.keywords ?? []
    expect(kw("/search")).toContain("colleagues")
    expect(kw("/research")).toContain("goals")
    expect(kw("/collaborate")).toContain("college network")
    expect(kw("/leaderboard")).toContain("wall of fame")
  })
})
