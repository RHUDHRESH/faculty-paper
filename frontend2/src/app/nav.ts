import {
  BarChart3,
  BookOpen,
  Calendar,
  ClipboardCheck,
  Coins,
  Compass,
  Database,
  FileCheck,
  FileText,
  Home,
  type LucideIcon,
  MessagesSquare,
  Receipt,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
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
  /** Match only this exact path, for an index route. */
  end?: boolean
  /** Shown in the palette even when the sidebar hides it. */
  keywords?: string[]
}

const ALL_STAFF: Role[] = ["SUPER_ADMIN", "RESEARCH_CELL", "PRINCIPAL", "FINANCE"]
const OFFICE: Role[] = ["SUPER_ADMIN", "RESEARCH_CELL"]

export const NAV: NavItem[] = [
  // ---- the daily work, unlabelled -------------------------------------
  { to: "/", label: "Home", icon: Home, end: true },
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
    to: "/payments",
    label: "Payment orders",
    icon: Wallet,
    roles: ["FINANCE"],
    keywords: ["pay", "disburse", "voucher"],
  },
  {
    to: "/papers",
    label: "My papers",
    icon: FileText,
    roles: ["FACULTY"],
    keywords: ["publications", "tickets", "claims"],
  },
  {
    to: "/papers/new",
    label: "File a paper",
    icon: FileText,
    roles: ["FACULTY"],
    keywords: ["submit", "claim", "new"],
  },

  // ---- what faculty come back for -------------------------------------
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
    roles: ["FINANCE", "SUPER_ADMIN"],
    group: "Look at",
    keywords: ["paid", "vouchers", "history"],
  },
  {
    to: "/duplicates",
    label: "Duplicates",
    icon: Coins,
    roles: ALL_STAFF,
    group: "Look at",
    keywords: ["double payment", "repeats"],
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
    roles: [...OFFICE, "PRINCIPAL", "FINANCE"],
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
    roles: OFFICE,
    group: "Set up",
    keywords: ["formula", "rates", "snip", "multiplier"],
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
  return NAV.filter((item) => !item.roles || item.roles.includes(role))
}
