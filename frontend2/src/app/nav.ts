import {
  Library,
  CalendarClock,
  BarChart3,
  BookOpen,
  Building2,
  Calendar,
  ClipboardCheck,
  Coins,
  Compass,
  Database,
  FileCheck,
  FileText,
  Flag,
  History,
  Home,
  Import,
  type LucideIcon,
  MessagesSquare,
  Receipt,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  Stamp,
  Users,
  Wallet,
  TriangleAlert,
} from "lucide-react"

import type { Role } from "@/app/auth"

/**
 * Every place in the app, in one list.
 *
 * The old app had five sidebars in five files, and pages that existed three
 * times over because each portal declared its own copy — /admin/reports,
 * /finance/reports and /principal/reports were one page separated by
 * copy-paste. Here a page is declared once and says who it is for, so a role
 * change is an edit to one line and there is no way for two portals to drift.
 *
 * Order is by how often somebody needs the thing, not by how the system is
 * organised internally. The daily work is first and carries no heading,
 * because a heading over the one thing you came to do is furniture.
 */

export type NavItem = {
  to: string
  label: string
  icon: LucideIcon
  /** Absent means everybody who is signed in. */
  roles?: Role[]
  group?: string
  /**
   * A heading for these roles only, in place of `group`. The claimant's two
   * doors are a faculty member's daily work, and so carry no heading; for an
   * officer they are a second errand beside the desk, and sit under one.
   */
  groupFor?: { roles: Role[]; group: string }
  /** Match only this exact path, for an index route. */
  end?: boolean
  /** Shown in the palette even when the sidebar hides it. */
  keywords?: string[]
}

const ALL_STAFF: Role[] = [
  "SUPER_ADMIN",
  "RESEARCH_CELL",
  "RESEARCH_COORDINATOR",
  "PRINCIPAL",
  "DIRECTOR",
  "FINANCE",
]
//: Mirrors `rbac.ADMIN_ROLES`. The research coordinator checks papers at
//: the same step as the admin office, so every office destination is theirs.
const OFFICE: Role[] = ["SUPER_ADMIN", "RESEARCH_CELL", "RESEARCH_COORDINATOR"]
//: The office roles held by people who are academics too: everybody at a
//: desk but the super admin. They "must be able to do both — do their own
//: research as well as track others'".
const OFFICERS: Role[] = ["RESEARCH_CELL", "RESEARCH_COORDINATOR", "PRINCIPAL", "DIRECTOR", "FINANCE"]
//: Mirrors `rbac.CLAIMANT_ROLES`: the people who file their own papers.
const CLAIMANTS: Role[] = ["FACULTY", "HOD", ...OFFICERS]
//: Where an officer's own papers sit in their sidebar, apart from the desk.
const MY_RESEARCH = { roles: OFFICERS, group: "My research" }
//: Mirrors `rbac.can_review_flags`: the desks that judge a paper. Not the
//: Director or Finance, who are not shown the doubts about what they
//: authorise and pay, and not a claimant.
export const REVIEWERS: Role[] = [...OFFICE, "PRINCIPAL"]

/** Raise, read and resolve flags, and browse the whole history. */
export function reviewsFlags(role: Role | undefined): boolean {
  return !!role && REVIEWERS.includes(role)
}

export const NAV: NavItem[] = [
  // ---- the daily work, unlabelled -------------------------------------
  { to: "/", label: "Home", icon: Home, end: true },
  // Everybody signed in, and second only to Home: it is the one destination
  // that answers a question asked before anything has been filed — does this
  // paper exist, is that journal real, has somebody here claimed it already.
  // `/publications` below is the *filterable list of our own claims*; this is
  // the literature and our own records at once, which is a different errand.
  {
    to: "/search",
    label: "Search",
    icon: Search,
    keywords: [
      "find",
      "look up",
      "doi",
      "crossref",
      "openalex",
      "scopus",
      "journal",
      "everything",
    ],
  },
  {
    to: "/clearing",
    label: "Clearing queue",
    icon: ClipboardCheck,
    roles: OFFICE,
    keywords: ["check", "review", "approve"],
  },
  {
    to: "/approvals",
    label: "Approvals",
    icon: FileCheck,
    roles: ["PRINCIPAL"],
    keywords: ["release", "sign off"],
  },
  {
    to: "/authorisations",
    label: "Authorisations",
    icon: Stamp,
    roles: ["DIRECTOR"],
    keywords: ["authorise", "release", "sign off", "director"],
  },
  {
    to: "/payments",
    label: "Payments",
    icon: Wallet,
    roles: ["FINANCE"],
    keywords: ["pay", "disburse", "voucher"],
  },
  {
    to: "/department",
    label: "My department",
    icon: Building2,
    roles: ["HOD"],
    keywords: ["standing", "targets", "quota", "staff", "contribution", "college"],
  },
  // `rbac.CLAIMANT_ROLES`. A head of department is a faculty member who also
  // heads the department, and keeps filing their own papers; an officer who
  // publishes files theirs here too, under "My research", beside the desk.
  {
    to: "/papers",
    label: "My papers",
    icon: FileText,
    roles: CLAIMANTS,
    groupFor: MY_RESEARCH,
    keywords: ["publications", "tickets", "claims", "my research", "mine"],
  },
  {
    to: "/papers/new",
    label: "File a paper",
    icon: FileText,
    roles: CLAIMANTS,
    groupFor: MY_RESEARCH,
    keywords: ["submit", "claim", "new", "my research"],
  },

  // ---- what faculty come back for -------------------------------------
  {
    to: "/programme",
    label: "My research",
    icon: Sparkles,
    group: "Research",
    keywords: ["areas", "field", "trends", "breakthroughs", "who to work with", "programme"],
  },
  {
    to: "/discover",
    label: "Discover",
    icon: Sparkles,
    group: "Research",
    keywords: ["ideas", "topics", "what is new", "ai"],
  },
  {
    to: "/collaborate",
    label: "Who to work with",
    icon: Compass,
    group: "Research",
    keywords: ["collaborators", "co-authors", "graph", "network"],
  },
  {
    to: "/discussions",
    label: "Discussions",
    icon: MessagesSquare,
    group: "Research",
    keywords: ["forum", "ask", "posts", "talk"],
  },
  {
    to: "/calendar",
    label: "Calendar",
    icon: Calendar,
    group: "Research",
    keywords: ["deadlines", "dates", "payout run"],
  },

  // ---- looking at the college -----------------------------------------
  // A head reaches these two through a different door.
  //
  // `/api/reports` and `/api/reports/search` both refuse an HOD outright —
  // `can_view_reports` is SUPER_ADMIN, RESEARCH_CELL, PRINCIPAL and FINANCE,
  // and a head is none of them. They have `/api/hod/overview` and
  // `/api/hod/publications`, which are scoped to their own department and
  // carry no money. So these items stay in a head's sidebar, because the
  // question is legitimate, but whoever builds the screens must branch on the
  // role and call the hod endpoints — pointing them at the general ones gives
  // a head a menu item that 403s. Verified by request, not by reading.
  {
    to: "/publications",
    label: "Publications",
    icon: Search,
    roles: [...ALL_STAFF, "HOD"],
    group: "Look at",
    keywords: ["search", "query", "find", "everything"],
  },
  {
    to: "/reports",
    label: "Reports",
    icon: BarChart3,
    roles: [...ALL_STAFF, "HOD"],
    group: "Look at",
    keywords: ["figures", "analysis", "output"],
  },
  {
    to: "/reports/build",
    label: "Build a report",
    icon: BarChart3,
    roles: ALL_STAFF,
    group: "Look at",
    keywords: ["export", "excel", "xlsx", "pdf", "chart", "breakdown", "custom"],
  },
  {
    to: "/journals",
    label: "Journals",
    icon: BookOpen,
    roles: [...ALL_STAFF, "HOD"],
    group: "Look at",
    keywords: ["scimago", "quartile", "snip"],
  },
  {
    to: "/accreditation",
    label: "Accreditation",
    icon: FileCheck,
    roles: ALL_STAFF,
    group: "Look at",
    keywords: ["naac", "nirf", "submission"],
  },
  {
    to: "/ledger",
    label: "Ledger",
    icon: Receipt,
    // The Director authorises payments against what has already gone out, so
    // the ledger is part of the job rather than a courtesy. `can_view_reports`
    // allows them; leaving them out meant the one role that must say "yes,
    // the institution can afford this" could not see what it had spent.
    roles: ["FINANCE", "DIRECTOR", "SUPER_ADMIN"],
    group: "Look at",
    keywords: ["paid", "vouchers", "history"],
  },
  {
    to: "/duplicates",
    label: "Duplicates",
    icon: Coins,
    // Contested and duplicate flags are hidden from the Director and Finance
    // (the college's rule; enforced on the server too).
    roles: [...OFFICE, "PRINCIPAL"],
    group: "Look at",
    keywords: ["double payment", "repeats"],
  },
  {
    to: "/flags",
    label: "Flags",
    icon: Flag,
    // `rbac.can_review_flags`. A flag never holds a payment, so the queue is
    // for reading and answering, not for unblocking anything.
    roles: REVIEWERS,
    group: "Look at",
    keywords: ["discrepancy", "mismatch", "question", "concern", "content check", "scanned"],
  },
  {
    to: "/archive",
    label: "Past claims",
    icon: History,
    roles: REVIEWERS,
    group: "Look at",
    keywords: ["history", "paid", "imported", "erp", "old", "archive", "look back"],
  },
  {
    to: "/faults",
    label: "Faults",
    icon: TriangleAlert,
    // `admin_faults` allows the office and the Principal.
    roles: [...OFFICE, "PRINCIPAL"],
    group: "Set up",
    keywords: ["broken", "blocked", "stuck", "unreconciled"],
  },
  {
    to: "/audit",
    label: "Audit log",
    icon: ShieldCheck,
    // `rbac.can_view_audit` is wider than the office — the Principal and
    // Finance may read the audit log, and were being offered no way in.
    // The Director works from a summary and Finance only pays; the trail
    // belongs to the office and the Principal.
    roles: [...OFFICE, "PRINCIPAL"],
    group: "Look at",
    keywords: ["who did what", "trail"],
  },

  // ---- things you touch when something changes -------------------------
  {
    to: "/people",
    label: "People",
    icon: Users,
    roles: OFFICE,
    group: "Set up",
    keywords: ["users", "accounts", "roles"],
  },
  {
    to: "/requests",
    label: "Profile requests",
    icon: Users,
    roles: OFFICE,
    group: "Set up",
    keywords: ["corrections", "name change"],
  },
  {
    to: "/budget",
    label: "Budget",
    icon: Coins,
    roles: [...ALL_STAFF],
    group: "Set up",
    keywords: ["allocation", "spend"],
  },
  {
    to: "/policy",
    label: "Policy",
    icon: Settings2,
    // Read and write are different sets here, and the sidebar has to cover
    // the union of them. `can_view_reports` reads the sheet (the office, the
    // Principal, Finance); `can_edit_formula` is FINANCE and SUPER_ADMIN
    // *only* — not the research cell. Gating this to OFFICE alone left the
    // one role that can change what the college pays with no route to the
    // screen, and gave the research cell a menu item they can only look at
    // without ever saying so. Verified against rbac.py, not assumed.
    roles: [...OFFICE, "FINANCE", "PRINCIPAL"],
    group: "Set up",
    keywords: ["formula", "rates", "snip", "multiplier", "threshold"],
  },
  {
    to: "/settings",
    label: "Institution",
    icon: Building2,
    // Mirrors `rbac.can_admin_portal` on GET/PUT /admin/settings. This entry
    // was once a copy of Policy's, which offered the Principal, Director and
    // Finance a page the server then refused.
    roles: OFFICE,
    group: "Set up",
    keywords: ["college", "name", "branding", "support email", "sign-in note"],
  },
  {
    to: "/reference",
    label: "Reference data",
    icon: Library,
    // Whoever may load prior payments may load these: it is the same
    // question of who is trusted with the figures behind an amount.
    roles: ["SUPER_ADMIN", "RESEARCH_CELL", "RESEARCH_COORDINATOR"],
    group: "Set up",
    keywords: ["scimago", "snip", "quartile", "journals", "import"],
  },
  {
    to: "/imports",
    label: "Imports",
    icon: Import,
    // Every reading on that page -- erp-stats, the faculty master, the
    // faculty picker, the process queue and the job poller -- is behind
    // `rbac.can_admin_portal`, which is exactly ADMIN_ROLES. The three
    // uploads are behind `can_import_prior`, which also allows the
    // Principal; but a Principal is refused all five readings, so the item
    // would be a screen of upload boxes with nothing on it to say what they
    // had done. Gated to the narrower of the two, deliberately.
    roles: OFFICE,
    group: "Set up",
    keywords: ["erp", "workbook", "xlsx", "roster", "faculty master", "prior payments", "history", "scopus", "verify", "queue", "job"],
  },
  {
    to: "/batches",
    label: "Monthly runs",
    icon: CalendarClock,
    // The office runs it and the research cell reads the result: it is the
    // step that turns a month of Scopus rows into priceable papers.
    roles: ["SUPER_ADMIN", "RESEARCH_CELL", "RESEARCH_COORDINATOR"],
    group: "Set up",
    keywords: ["scopus", "batch", "monthly", "import", "run"],
  },
  {
    to: "/data",
    label: "Data",
    icon: Database,
    roles: ["SUPER_ADMIN"],
    group: "Set up",
    keywords: ["tables", "explorer", "delete", "import"],
  },
]

export function navFor(role: Role | undefined): NavItem[] {
  if (!role) return []
  return NAV.filter((item) => !item.roles || item.roles.includes(role)).map((item) =>
    item.groupFor?.roles.includes(role) ? { ...item, group: item.groupFor.group } : item
  )
}
