import {
  CalendarDays,
  FilePlusCorner,
  Lightbulb,
  MessageCircle,
  UsersRound,
  Library,
  CalendarClock,
  BarChart3,
  BookOpen,
  Building2,
  Calculator,
  ClipboardCheck,
  Coins,
  Database,
  FileCheck,
  FileText,
  FlaskConical,
  Flag,
  History,
  Home,
  Import,
  KeyRound,
  type LucideIcon,
  MessagesSquare,
  Network,
  Receipt,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  Telescope,
  Stamp,
  Trophy,
  UserCheck,
  Users,
  Wallet,
  TriangleAlert,
  RotateCw,
  HeartPulse,
  Route,
  Wrench,
} from "lucide-react"

import type { Role } from "@/app/auth"
import type { Area } from "@/ui/chip"

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
  /** The Convocation area colour (docs/ux/00 §1): heading dot, active wash. */
  area?: Area
  /** Drawn at the foot of the sidebar, above the account block (Calendar). */
  pinned?: boolean
  /** One plain line on what the page is for: hub rows and the palette read it. */
  purpose?: string
  /** Part of a heading the sidebar folds away (an officer's Research group). */
  fold?: boolean
  /**
   * Reached by name (Ctrl K, the title bar, breadcrumbs) and from a link on a
   * related page, but not a sidebar item or a hub row: Your profile, Wall of
   * fame, Notification settings. Declared here so every routed view can be
   * found by name and by job (docs/ux/22), and so the browser tab has a title.
   */
  findOnly?: boolean
}

/**
 * Destinations folded into others by the redesign (docs/ux/00 §9). Each old
 * path redirects, so bookmarks and deep links still land somewhere sensible.
 * Wall of fame stays a real page (`/wall`, TV display) but leaves the nav.
 */
export const REDIRECTS: Record<string, string> = {
  "/u": "/search?scope=people",
  "/network": "/collaborate?view=map",
  "/goals": "/research?tab=me#this-year",
  "/programme": "/research?tab=me",
  "/impact": "/research",
}

const ALL_STAFF: Role[] = [
  "SUPER_ADMIN",
  "RESEARCH_CELL",
  "RESEARCH_COORDINATOR",
  "PRINCIPAL",
  "DIRECTOR",
  "FINANCE",
]
//: Mirrors `track.TRACK_ROLES`: everybody at a desk, and a head of department
//: (who sees only their own department, with no money).
export const TRACK_ROLES: Role[] = [...ALL_STAFF, "HOD"]
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

const PAGES: NavItem[] = [
  // ---- the daily work, unlabelled -------------------------------------
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
      "colleagues",
      "people",
      "profiles",
      "directory",
      "find someone",
    ],
  },
  { to: "/", label: "Home", icon: Home, end: true },
  {
    to: "/clearing",
    label: "Clearing queue",
    icon: ClipboardCheck,
    roles: OFFICE,
    keywords: ["check", "review", "approve", "claims", "queue", "waiting", "clear", "send back", "reject"],
  },
  {
    to: "/coordination",
    label: "Coordination",
    icon: Network,
    roles: OFFICE,
    keywords: ["assign", "workload", "throughput", "ageing", "sla", "fyp", "watch-list", "supervise", "who has it", "reassign"],
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
    keywords: ["pay", "disburse", "voucher", "mark paid", "bank file", "payment run"],
  },
  {
    to: "/department",
    label: "My department",
    icon: Building2,
    roles: ["HOD"],
    keywords: [
      "standing", "targets", "quota", "staff", "contribution", "college", "on track", "pace", "who needs a push",
      "remind", "pair", "monthly note", "note for the principal", "records to fix", "missing doi", "scopus id",
    ],
  },
  // ---- Convocation (docs/ux/00 §9): four areas, each with its colour ----
  // RECORD. `rbac.CLAIMANT_ROLES`. A head of department is a faculty member
  // who also heads the department, and keeps filing their own papers; an
  // officer who publishes files theirs here too, under "My research", beside
  // the desk.
  {
    to: "/papers",
    label: "My papers",
    icon: FileText,
    roles: CLAIMANTS,
    group: "Record",
    area: "record",
    groupFor: MY_RESEARCH,
    keywords: ["publications", "tickets", "claims", "my research", "mine"],
  },
  {
    to: "/papers/new",
    label: "File a paper",
    icon: FilePlusCorner,
    roles: CLAIMANTS,
    group: "Record",
    area: "record",
    groupFor: MY_RESEARCH,
    keywords: ["submit", "claim", "new", "my research"],
  },

  // RESEARCH. My research absorbs "The college's research" as a tab
  // (`/research?tab=college`) and "My goals" as a "This year" card.
  {
    to: "/research",
    label: "My research",
    icon: Sparkles,
    group: "Research",
    area: "research",
    keywords: [
      "areas", "field", "trends", "breakthroughs", "programme", "college", "college's research",
      "growing", "fading", "departments", "goals", "targets", "this year", "progress",
    ],
  },
  {
    to: "/discover",
    label: "Discover",
    icon: Lightbulb,
    group: "Research",
    area: "research",
    keywords: ["ideas", "topics", "what is new", "ai"],
  },
  {
    to: "/scout",
    label: "Research scout",
    icon: Telescope,
    group: "Research",
    area: "research",
    keywords: ["scout", "web", "calls", "funding", "special issue", "next", "collaborators", "claude", "ai"],
  },

  // PEOPLE. Who to work with absorbs Colleagues (now Search, people scope)
  // and College network (now its Map view).
  {
    to: "/collaborate",
    label: "Who to work with",
    icon: UsersRound,
    group: "People",
    area: "people",
    keywords: ["collaborators", "co-authors", "graph", "network", "map", "college network", "colleagues"],
  },
  {
    to: "/messages",
    label: "Messages",
    icon: MessageCircle,
    group: "People",
    area: "people",
    keywords: ["direct", "private", "dm", "office", "ask the office", "conversation"],
  },
  {
    to: "/discussions",
    label: "Discussions",
    icon: MessagesSquare,
    group: "People",
    area: "people",
    keywords: ["forum", "ask", "posts", "talk", "feed", "social", "share"],
  },

  // HONOURS. Everybody: paper counts per person and per department, with no
  // money on it at any role. Wall of fame is its tab (`?view=wall`).
  {
    to: "/leaderboard",
    label: "Leaderboard",
    icon: Trophy,
    group: "Honours",
    area: "honours",
    keywords: [
      "ranking", "rank", "top", "standings", "department", "q1", "score", "position",
      "wall of fame", "celebrate", "paper of the month",
    ],
  },

  // TIME. Pinned above the account block rather than in the list.
  {
    to: "/calendar",
    label: "Calendar",
    icon: CalendarDays,
    area: "time",
    pinned: true,
    keywords: ["deadlines", "dates", "payment run"],
  },

  // ---- routed views that are found by name, not listed in a sidebar ------
  {
    to: "/faculty",
    label: "Faculty",
    icon: Users,
    roles: [...OFFICE, "PRINCIPAL"],
    findOnly: true,
    purpose: "Every faculty member with their photo, Scopus ID, papers and claims.",
    keywords: [
      "directory", "roster", "staff", "staff id", "scopus id", "research faculty", "who is missing",
      "no paper", "gaps", "profile", "faculty list", "people",
    ],
  },
  {
    to: "/papers/claims",
    label: "My claims",
    icon: FileText,
    roles: CLAIMANTS,
    findOnly: true,
    purpose: "Every claim you have filed, and where each one stands.",
    keywords: ["status", "where is my claim", "claim number", "filed", "sent back", "paid", "incentive"],
  },
  {
    to: "/papers/appraisal",
    label: "List for appraisal",
    icon: FileText,
    roles: CLAIMANTS,
    findOnly: true,
    purpose: "Your papers as a list to print for appraisal.",
    keywords: ["appraisal", "print", "pdf", "cv", "publication list"],
  },
  {
    to: "/papers/statement",
    label: "Payment statement",
    icon: Receipt,
    roles: CLAIMANTS,
    findOnly: true,
    purpose: "What the college has paid you, month by month.",
    keywords: ["paid", "money", "incentive", "voucher", "bank", "how much"],
  },
  {
    to: "/payments/done",
    label: "Paid",
    icon: Wallet,
    roles: ["FINANCE"],
    findOnly: true,
    purpose: "Claims already paid, with their vouchers.",
    keywords: ["paid", "history", "voucher", "done"],
  },
  {
    to: "/wall",
    label: "Wall of fame",
    icon: Trophy,
    findOnly: true,
    purpose: "The month's best papers, for the common-room screen.",
    keywords: ["celebrate", "paper of the month", "tv", "display", "honours", "best papers"],
  },
  {
    to: "/me",
    label: "Your profile",
    icon: UserCheck,
    findOnly: true,
    purpose: "Your name, photo, Scopus ID and password.",
    keywords: ["account", "profile", "password", "photo", "scopus id", "orcid", "change name", "sign out"],
  },
  {
    to: "/u/me/stats",
    label: "Your stats",
    icon: BarChart3,
    findOnly: true,
    purpose: "Who looked at your profile and how far your posts reached, in the last 30 days.",
    keywords: ["my numbers", "profile views", "reach", "followers", "engagement", "who viewed me"],
  },
  {
    to: "/notifications",
    label: "Notifications",
    icon: MessageCircle,
    findOnly: true,
    purpose: "Everything the system has told you.",
    keywords: ["alerts", "inbox", "unread", "what happened", "bell"],
  },
  {
    to: "/settings/notifications",
    label: "Notification settings",
    icon: Settings2,
    findOnly: true,
    purpose: "Choose which emails and alerts you get.",
    keywords: ["email", "alerts", "mute", "digest", "preferences", "unsubscribe"],
  },
  {
    to: "/messages/office",
    label: "Research office",
    icon: MessageCircle,
    findOnly: true,
    purpose: "Ask the research office a question about a claim.",
    keywords: ["ask", "office", "help desk", "question", "contact"],
  },
  {
    to: "/help",
    label: "Help and guides",
    icon: BookOpen,
    findOnly: true,
    purpose: "How to do each job, step by step.",
    keywords: ["how do i", "guide", "manual", "support", "tutorial", "faq"],
  },
  {
    to: "/privacy",
    label: "Privacy",
    icon: ShieldCheck,
    findOnly: true,
    purpose: "What the system keeps about you and why.",
    keywords: ["data protection", "personal data", "terms"],
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
    label: "Analysis",
    icon: BarChart3,
    roles: [...ALL_STAFF, "HOD"],
    group: "Look at",
    keywords: ["figures", "analysis", "output", "reports", "charts"],
  },
  {
    // `/api/reports/brief` is `can_view_reports` (every staff role, not the
    // head of department, who has their own department page).
    to: "/reports/brief",
    label: "Year brief",
    icon: FileText,
    roles: ALL_STAFF,
    group: "Look at",
    keywords: ["governing council", "naac", "per teacher", "annual", "pdf", "trustees"],
  },
  {
    // The Principal's Q2: which departments need a push, per teacher. Reached
    // from the year brief and her Reports hub; here so Ctrl K finds it.
    to: "/reports/departments",
    label: "Departments, per teacher",
    icon: BarChart3,
    roles: ALL_STAFF,
    findOnly: true,
    purpose: "Which departments need a push, and who is publishing in each.",
    keywords: ["departments", "per teacher", "push", "hod", "lagging", "ranking", "who is publishing"],
  },
  {
    // The list behind every figure on the year brief.
    to: "/reports/papers",
    label: "Papers behind a figure",
    icon: FileText,
    roles: ALL_STAFF,
    findOnly: true,
    purpose: "Every paper the college has published, filtered by year, department or journal quartile.",
    keywords: ["papers", "list", "which papers", "quartile", "no department", "retracted", "download"],
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
    keywords: ["scimago", "quartile", "snip", "journal", "impact", "which journal"],
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
    keywords: ["paid", "vouchers", "history", "money out", "payments made", "paid with no ledger row", "reconcile"],
  },
  {
    to: "/statements",
    label: "Monthly statements",
    icon: FileText,
    // The month the Director signs and Finance sends to the bank: totals,
    // reconciliation with the ledger, the A4 statement and the bank file.
    roles: ["FINANCE", "DIRECTOR", "PRINCIPAL", "SUPER_ADMIN"],
    group: "Look at",
    keywords: ["payout", "statement", "bank", "neft", "reconcile", "month", "sign", "pdf"],
  },
  {
    to: "/duplicates",
    label: "Duplicates",
    icon: Coins,
    // Contested and duplicate flags are hidden from the Director and Finance
    // (the college's rule; enforced on the server too).
    roles: [...OFFICE, "PRINCIPAL"],
    group: "Look at",
    keywords: ["double payment", "repeats", "paid twice", "same paper", "duplicate claim"],
  },
  {
    to: "/flags",
    label: "Flags",
    icon: Flag,
    // `rbac.can_review_flags`. A flag never holds a payment, so the queue is
    // for reading and answering, not for unblocking anything.
    roles: REVIEWERS,
    group: "Look at",
    keywords: ["discrepancy", "mismatch", "question", "concern", "content check", "scanned", "doubt", "problem with a claim"],
  },
  {
    to: "/archive",
    label: "Past claims",
    icon: History,
    roles: REVIEWERS,
    group: "Look at",
    keywords: ["history", "paid", "imported", "erp", "old", "archive", "look back", "missing amount", "untitled", "fix imported"],
  },
  {
    to: "/faults",
    label: "Faults",
    icon: TriangleAlert,
    // `admin_faults` allows the office and the Principal.
    roles: [...OFFICE, "PRINCIPAL"],
    group: "Set up",
    keywords: ["broken", "blocked", "stuck", "unreconciled", "faults", "problems", "nothing is stuck", "stalled"],
  },
  {
    to: "/data/fixes",
    label: "Fix imported claims",
    icon: Wrench,
    // Reading is the office's; only a super admin can save a fix, and the
    // page says so.
    roles: OFFICE,
    group: "Set up",
    keywords: ["old erp", "no amount", "untitled", "quartile", "missing", "paid for nothing", "data fix"],
  },
  {
    to: "/jobs",
    label: "Jobs",
    icon: RotateCw,
    // `core/api/jobs.py` answers the super admin only.
    roles: ["SUPER_ADMIN"],
    group: "Set up",
    keywords: ["background", "queue", "harvest", "backup", "scopus sync", "failed", "retry", "worker", "running", "scheduled", "email delivery"],
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
    keywords: ["who did what", "trail", "who changed", "who changed this", "history of changes", "when", "log", "changes", "sign-in problems"],
  },

  // ---- things you touch when something changes -------------------------
  {
    to: "/people",
    label: "People",
    icon: Users,
    roles: OFFICE,
    group: "Set up",
    keywords: ["users", "accounts", "roles", "sign in", "who can sign in", "dual role", "left", "leavers", "merge accounts", "passwords", "add a person", "chain roles", "director", "finance"],
  },
  {
    to: "/people/passwords",
    label: "Issue passwords",
    icon: KeyRound,
    // The super admin's alone (`POST /api/admin/passwords/issue`): it replaces
    // people's passwords in bulk, which no other office role may do.
    roles: ["SUPER_ADMIN"],
    group: "Set up",
    keywords: [
      "passwords", "credentials", "sign-in list", "sign in list", "cannot sign in", "cant sign in",
      "first password", "one-time password", "temporary password", "hand out passwords", "logins", "download passwords",
    ],
  },
  {
    to: "/people/matches",
    label: "Author matches",
    icon: UserCheck,
    // `rbac.can_admin_portal`: the super admin and the research coordinator.
    roles: OFFICE,
    group: "Set up",
    keywords: ["unmatched", "openalex", "alias", "duplicate accounts", "merge", "orcid", "former staff", "author names", "match authors", "wrong person"],
  },
  {
    to: "/research-faculty",
    label: "Research faculty",
    icon: FlaskConical,
    // `rbac.can_set_research_threshold`: the research coordinator and the
    // super admin. The research cell clears the claims it decides, so it
    // does not set it.
    roles: ["SUPER_ADMIN", "RESEARCH_COORDINATOR"],
    group: "Set up",
    keywords: ["threshold", "research post", "unpaid", "incentive limit", "per year"],
  },
  {
    to: "/requests",
    label: "Profile requests",
    icon: Users,
    roles: OFFICE,
    group: "Set up",
    keywords: ["corrections", "name change", "profile corrections", "staff id change", "scopus id change", "fix my details"],
  },
  {
    to: "/budget",
    label: "Budget",
    icon: Coins,
    roles: [...ALL_STAFF],
    group: "Set up",
    keywords: ["allocation", "spend", "money", "remaining", "committed", "head", "can we afford"],
  },
  {
    to: "/calculator",
    label: "Incentive calculator",
    icon: Calculator,
    // `core/api/calculator.py`: the office and the three chain roles. Not a
    // head of department (no money) and not faculty (the filing form shows
    // them the estimate).
    roles: ALL_STAFF,
    group: "Look at",
    keywords: [
      "calculator", "how much", "price", "pricing", "remuneration", "check amount", "check an amount",
      "what should this pay", "recalculate", "recompute", "wrong amount", "incentive amount", "worked out",
    ],
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
    keywords: ["formula", "rates", "snip", "multiplier", "threshold", "policy version", "before and after", "preview", "why this amount", "research threshold", "incentive amount"],
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
    keywords: ["college", "name", "branding", "support email", "sign-in note", "year setup", "academic year", "financial year", "cutover", "departments", "setup checklist", "logo"],
  },
  {
    to: "/reference",
    label: "Reference data",
    icon: Library,
    // Whoever may load prior payments may load these: it is the same
    // question of who is trusted with the figures behind an amount.
    roles: ["SUPER_ADMIN", "RESEARCH_CELL", "RESEARCH_COORDINATOR"],
    group: "Set up",
    keywords: ["scimago", "snip", "quartile", "journals", "import", "quartiles", "journal list", "reference data"],
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
    keywords: ["erp", "workbook", "xlsx", "roster", "faculty master", "prior payments", "history", "scopus", "verify", "queue", "job", "upload", "import a file", "faculty list", "past payments", "final year projects"],
  },
  {
    to: "/batches",
    label: "Monthly runs",
    icon: CalendarClock,
    // The office runs it and the research cell reads the result: it is the
    // step that turns a month of Scopus rows into priceable papers.
    roles: ["SUPER_ADMIN", "RESEARCH_CELL", "RESEARCH_COORDINATOR"],
    group: "Set up",
    keywords: ["scopus", "batch", "monthly", "import", "run", "scopus run", "monthly run", "new papers", "harvest", "start the run"],
  },
  {
    to: "/data",
    label: "Data",
    icon: Database,
    roles: ["SUPER_ADMIN"],
    group: "Set up",
    keywords: ["tables", "explorer", "delete", "import", "export", "browse data", "database", "csv"],
  },
  {
    to: "/data/health",
    label: "Data health",
    icon: HeartPulse,
    // `_super` in api/data_health.py: the audit, its fixes and the backups.
    roles: ["SUPER_ADMIN"],
    group: "Set up",
    keywords: ["integrity", "audit", "duplicates", "backup", "restore", "orphans", "constraints", "backups", "last backup", "broken links", "missing files", "is anything broken"],
  },
  {
    to: "/data/record",
    label: "Record quality",
    icon: HeartPulse,
    // `_super` in api/record_quality.py: duplicate papers, roster names.
    roles: ["SUPER_ADMIN"],
    group: "Set up",
    keywords: ["duplicate papers", "merge", "roster", "name typo", "spelling", "anomalies", "data quality", "record quality", "odd dates", "misspelt"],
  },

  // ---- the office's doors: pages that gather the rest ------------------
  {
    to: "/track",
    label: "Track",
    icon: Route,
    roles: TRACK_ROLES,
    group: "Look at",
    keywords: [
      "where is", "stage", "funnel", "journey", "pipeline", "stuck", "ageing", "board",
      "status", "progress", "all claims", "claim number", "who has it",
    ],
  },
  {
    to: "/admin",
    label: "Admin",
    icon: Wrench,
    roles: OFFICE,
    group: "Set up",
    keywords: ["set up", "settings", "system", "data", "people and roles", "hub", "everything else", "readiness", "checklist", "is anything broken", "admin", "setup"],
  },
  {
    to: "/money",
    label: "Money",
    icon: Wallet,
    // The super admin and the office reach the same pages under Admin.
    roles: ["PRINCIPAL", "DIRECTOR", "FINANCE"],
    group: "Look at",
    keywords: ["budget", "ledger", "statements", "policy", "spend", "rates", "paid", "money", "how much", "incentive"],
  },
  {
    to: "/reports/all",
    label: "Reports",
    icon: BarChart3,
    roles: [...ALL_STAFF, "HOD"],
    group: "Look at",
    keywords: ["figures", "output", "year brief", "accreditation", "publications", "journals", "download", "reports", "all reports"],
  },
]

/** One plain line for what each page is for, by route. */
const PURPOSE: Record<string, string> = {
  "/clearing": "Check each filed claim against the record, then clear it or send it back.",
  "/coordination": "Who is holding which claims, how long they have waited, and who to reassign them to.",
  "/approvals": "Approve the claims the research cell has cleared.",
  "/authorisations": "Authorise the claims the Principal approved, against the budget.",
  "/payments": "Pay what the Director authorised, and keep the vouchers.",
  "/department": "Your department's papers, standing and targets.",
  "/track": "Where every claim is, how long it has been there, and who is holding it.",
  "/people": "Accounts, roles, passwords and people who have left.",
  "/people/passwords": "Give people a one-time password to sign in with, and download the list to hand out.",
  "/people/matches": "Match author names on papers to the right person at the college.",
  "/requests": "Name, staff ID and Scopus corrections people cannot make themselves.",
  "/imports": "Bring in the ERP workbook, the faculty list and past payments. Preview before you commit.",
  "/reference": "The journal quartiles and SNIP values that price a claim.",
  "/batches": "The monthly Scopus run that turns new papers into ones that can be priced.",
  "/data/fixes": "Imported claims that are missing an amount, a title or a quartile, one row each to put right.",
  "/data/record": "Duplicate papers, misspelt names and odd dates in the publication record.",
  "/data/health": "Broken links, duplicate IDs and missing files, with fixes, and the backups.",
  "/duplicates": "A paper paid twice, or to two people, waiting for a decision.",
  "/data": "Browse and export any table in the system.",
  "/policy": "The rates and rules that decide an amount. Every change is a new version.",
  "/calculator": "Price a paper, check what one claim should have been paid, or check every claim at once.",
  "/research-faculty": "Set the yearly rupee threshold for each research faculty member, and see how much is used.",
  "/budget": "What is allocated, committed and spent, head by head.",
  "/ledger": "Every payment made, with its voucher and the month it went out.",
  "/statements": "The month's payment statement and the bank file.",
  "/jobs": "Background jobs: what ran, what failed, and a retry where it is safe.",
  "/faults": "Records the system cannot reconcile, and claims that have stopped moving.",
  "/audit": "Who did what, and when.",
  "/settings": "The college's name, branding and sign-in notes.",
  "/reports": "Output by department, journal, quartile and year.",
  "/reports/brief": "One page for the governing council: this year against last, per teacher.",
  "/reports/build": "Choose the columns and download Excel or PDF.",
  "/accreditation": "NAAC and NIRF tables, in the order the submissions ask for.",
  "/publications": "Search every paper the college has claimed or published.",
  "/journals": "A journal's quartile, SNIP and standing, and the college's history with it.",
  "/search": "Papers, journals and colleagues, inside the college and outside it.",
  "/archive": "Every claim ever filed, imported ones included.",
  "/flags": "Doubts raised on claims, and how each was answered.",
  "/admin": "The pages that keep the system right, in four groups.",
  "/money": "What is spent, the rules behind an amount, and the monthly statements.",
  "/reports/all": "Every report and lookup in one place.",
}

export const NAV: NavItem[] = PAGES.map((p) => ({ ...p, purpose: p.purpose ?? PURPOSE[p.to] }))

/* ------------------------------------------------------------------------ */
/* Hubs: pages that gather the rarely used ones                              */
/* ------------------------------------------------------------------------ */

export type HubKey = "admin" | "money" | "reports" | "claims"
export type HubSection = { title: string; blurb?: string; items: string[] }
export type Hub = { title: string; sub: string; sections: HubSection[] }

/**
 * Which pages each hub lists, by route. The pages themselves (words, icon,
 * who may open them) are declared once, above; a hub only chooses and
 * groups. A page a role may not open drops out for that role, and a section
 * left empty drops out with it.
 */
export const HUBS: Record<HubKey, Hub> = {
  admin: {
    title: "Admin",
    sub: "Everything that keeps the system right, in four groups. A number beside a page is what is waiting on you.",
    sections: [
      {
        title: "People and roles",
        blurb: "Who can sign in, and what they can do.",
        items: ["/people", "/people/passwords", "/people/matches", "/research-faculty", "/requests"],
      },
      {
        title: "Data",
        blurb: "Where the records come from, and whether they are right.",
        items: ["/imports", "/data/fixes", "/batches", "/reference", "/data/record", "/data/health", "/duplicates", "/data"],
      },
      {
        title: "Money",
        blurb: "The rules, and the record of what was spent.",
        items: ["/policy", "/calculator", "/budget", "/ledger", "/statements"],
      },
      {
        title: "System",
        blurb: "What is running, what went wrong, and who did what.",
        items: ["/jobs", "/faults", "/audit", "/settings"],
      },
    ],
  },
  money: {
    title: "Money",
    sub: "What the college spends, the rules behind an amount, and the monthly statements.",
    sections: [
      { title: "Spending", items: ["/budget", "/ledger", "/statements"] },
      { title: "The rules", items: ["/policy", "/calculator"] },
    ],
  },
  reports: {
    title: "Reports",
    sub: "Every report and lookup, and what each is for.",
    sections: [
      {
        title: "Reports",
        blurb: "Figures to read, present or download.",
        items: ["/reports", "/reports/brief", "/reports/build", "/accreditation"],
      },
      {
        title: "Look something up",
        blurb: "Find a paper, a journal or a past claim.",
        items: ["/search", "/publications", "/journals", "/archive"],
      },
    ],
  },
  claims: {
    title: "Also look at",
    sub: "",
    sections: [{ title: "Also look at", items: ["/coordination", "/flags", "/archive", "/duplicates", "/calculator", "/faults", "/audit"] }],
  },
}

/** A hub's sections as this role sees them: only pages it may open. */
export function hubSections(hub: HubKey, role: Role | undefined): { title: string; blurb?: string; items: NavItem[] }[] {
  if (!role) return []
  const mine = new Map(pagesFor(role).map((p) => [p.to, p]))
  return HUBS[hub].sections
    .map((s) => ({ ...s, items: s.items.map((to) => mine.get(to)).filter((p): p is NavItem => !!p) }))
    .filter((s) => s.items.length > 0)
}

/* ------------------------------------------------------------------------ */
/* The office's sidebar: jobs, not a pile                                    */
/* ------------------------------------------------------------------------ */



type Door = NavItem & {
  /** Paths that keep this door lit: the door itself and the pages behind it. */
  covers: string[]
}

/**
 * The few things an office role does, each one a door. The rest sits behind
 * a hub (Admin, Money, Reports) or under Track, and stays one Ctrl K away.
 *
 * Each role gets at most seven, and the desk queue is always the second.
 */
const DOORS: Door[] = [
  { to: "/", label: "Home", icon: Home, end: true, covers: ["/"] },
  {
    to: "/clearing",
    label: "Claims",
    icon: ClipboardCheck,
    roles: OFFICE,
    covers: ["/clearing", "/review", "/coordination", "/flags", "/archive"],
    keywords: ["check", "review", "clear", "queue"],
  },
  {
    to: "/approvals",
    label: "Approvals",
    icon: FileCheck,
    roles: ["PRINCIPAL"],
    covers: ["/approvals", "/review", "/flags", "/archive"],
  },
  {
    to: "/authorisations",
    label: "Authorisations",
    icon: Stamp,
    roles: ["DIRECTOR"],
    covers: ["/authorisations", "/review"],
  },
  { to: "/payments", label: "Payments", icon: Wallet, roles: ["FINANCE"], covers: ["/payments"] },
  { to: "/department", label: "Department", icon: Building2, roles: ["HOD"], covers: ["/department"] },
  { to: "/track", label: "Track", icon: Route, roles: TRACK_ROLES, covers: ["/track"] },
  {
    to: "/faculty",
    label: "Faculty",
    icon: Users,
    roles: [...OFFICE, "PRINCIPAL"],
    covers: ["/faculty"],
    keywords: ["people", "directory", "scopus", "staff"],
  },
  {
    to: "/money",
    label: "Money",
    icon: Coins,
    roles: ["PRINCIPAL", "DIRECTOR", "FINANCE"],
    covers: ["/money", "/budget", "/policy", "/calculator", "/ledger", "/statements"],
  },
  {
    to: "/reports/all",
    label: "Reports",
    icon: BarChart3,
    roles: TRACK_ROLES,
    covers: ["/reports", "/publications", "/journals", "/accreditation", "/search"],
  },
  {
    to: "/admin",
    label: "Admin",
    icon: Wrench,
    roles: OFFICE,
    covers: [
      "/admin", "/people", "/imports", "/reference", "/batches", "/data", "/requests", "/research-faculty", "/settings", "/jobs",
      "/faults", "/audit", "/duplicates", "/budget", "/policy", "/calculator", "/ledger", "/statements",
    ],
  },
]

/** The name of each office door by path, for breadcrumbs ("Admin / Imports"). */
export const DOOR_LABELS: Record<string, string> = Object.fromEntries(DOORS.map((d) => [d.to, d.label]))

/** The pages an office role reaches through the folded Research group. */
const RESEARCH_PAGES = [
  "/papers", "/papers/new", "/research", "/discover", "/scout",
  "/collaborate", "/messages", "/discussions", "/leaderboard",
]

const STAFF_SIDEBAR: Role[] = [...ALL_STAFF, "HOD"]

function covers(door: Door, pathname: string): number {
  let best = -1
  for (const c of door.covers) {
    const hit = c === "/" ? pathname === "/" : pathname === c || pathname.startsWith(c + "/")
    if (hit) best = Math.max(best, c.length)
  }
  return best
}

/** The door that should be lit at this path, for this role, if any. */
export function activeDoor(role: Role | undefined, pathname: string): string | undefined {
  if (!role) return undefined
  let best: { to: string; len: number } | undefined
  for (const d of DOORS) {
    if (d.roles && !d.roles.includes(role)) continue
    const len = covers(d, pathname)
    if (len >= 0 && (!best || len > best.len)) best = { to: d.to, len }
  }
  return best?.to
}

/** True when this path lies inside the folded Research group. */
export function inResearch(pathname: string): boolean {
  return RESEARCH_PAGES.some((p) => pathname === p || pathname.startsWith(p + "/"))
}

/**
 * The count beside a sidebar entry: what is waiting at the reader's own desk
 * (from `/api/claims/counts`, grouped as the server groups stages), and for a
 * claimant how many of their papers have come back to them. Nobody is shown a
 * count for somebody else's desk.
 */
const BADGE: Partial<Record<Role, [to: string, stage: string]>> = {
  SUPER_ADMIN: ["/clearing", "filed"],
  RESEARCH_CELL: ["/clearing", "filed"],
  RESEARCH_COORDINATOR: ["/clearing", "filed"],
  PRINCIPAL: ["/approvals", "checked"],
  DIRECTOR: ["/authorisations", "approved"],
  FINANCE: ["/payments", "authorised"],
  FACULTY: ["/papers", "sent_back"],
  HOD: ["/papers", "sent_back"],
}

export function navBadges(
  role: Role | undefined,
  counts: Record<string, number> | undefined
): Record<string, number> {
  const entry = role ? BADGE[role] : undefined
  const n = entry && counts ? counts[entry[1]] ?? 0 : 0
  return entry && n > 0 ? { [entry[0]]: n } : {}
}

/**
 * Every page this role may open, sidebar or not. The palette searches these,
 * the not-found page checks against them, and the hubs choose from them.
 */
export function pagesFor(role: Role | undefined): NavItem[] {
  if (!role) return []
  return NAV.filter((item) => !item.roles || item.roles.includes(role)).map((item) =>
    item.groupFor?.roles.includes(role) ? { ...item, group: item.groupFor.group } : item
  )
}

/**
 * What the sidebar draws.
 *
 * A faculty member keeps the four coloured groups. Everybody else (each
 * office seat and a head of department) gets a handful of doors on their
 * work, then one folded "Research" group for their own papers and the
 * community, then Calendar. The rest is a hub or Ctrl K away, and no page
 * was dropped: `pagesFor` lists all of them.
 */
export function navFor(role: Role | undefined): NavItem[] {
  if (!role) return []
  if (!STAFF_SIDEBAR.includes(role)) return pagesFor(role).filter((p) => !p.findOnly)

  const doors = DOORS.filter((d) => !d.roles || d.roles.includes(role)).map(
    ({ covers: _covers, ...item }) => item as NavItem
  )
  const all = pagesFor(role).filter((p) => !p.findOnly)
  const research = RESEARCH_PAGES.map((to) => all.find((p) => p.to === to))
    .filter((p): p is NavItem => !!p)
    .map((p) => ({ ...p, group: "Research", fold: true, groupFor: undefined }))
  const pinned = all.filter((p) => p.pinned)
  return [...doors, ...research, ...pinned]
}
