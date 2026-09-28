import {
  BookOpen,
  Building2,
  CalendarDays,
  CloudDownload,
  CornerDownLeft,
  Download,
  FilePlusCorner,
  FileText,
  Hash,
  type LucideIcon,
  LogOut,
  MessageCircle,
  Quote,
  Sparkles,
  Ticket,
  UserRound,
  UsersRound,
  LifeBuoy,
} from "lucide-react"
import { useEffect, useMemo, useState } from "react"
import { useQuery } from "@tanstack/react-query"

import type { Role } from "@/app/auth"
import { navFor } from "@/app/nav"
import { api } from "@/lib/api"
import type { Area } from "@/ui/chip"
import type { SearchScope } from "@/ui/big-search"

/**
 * One search engine for the /search page and the Ctrl-K palette
 * (docs/ux/02-search.md). The server fans out over the college's own data
 * (`/api/search/all`); pages come from nav.ts and actions from `ACTIONS`,
 * both matched here, instantly, without the network.
 */

export type SearchItem = {
  id: string
  title: string
  subtitle?: string
  url: string
  chips: string[]
  meta?: Record<string, any>
  secondary_action?: { label: string; url?: string; copy?: string } | null
}
export type GroupKind = "exact" | "person" | "paper" | "claim" | "journal" | "topic" | "department" | "page" | "action"
export type SearchGroup = { kind: GroupKind; total: number; items: SearchItem[]; status: "ok" | "partial" | "error" }
export type SearchAll = {
  q: string
  scope: string
  exact: (SearchItem & { kind: string }) | null
  groups: SearchGroup[]
}

export const GROUP_LABEL: Record<GroupKind, string> = {
  exact: "Exact match",
  person: "People",
  paper: "Papers",
  claim: "Your claims",
  journal: "Journals",
  topic: "Topics",
  department: "Departments",
  page: "Pages",
  action: "Actions",
}
export const GROUP_ICON: Record<GroupKind, LucideIcon> = {
  exact: Quote,
  person: UserRound,
  paper: FileText,
  claim: Ticket,
  journal: BookOpen,
  topic: Sparkles,
  department: Building2,
  page: Hash,
  action: CornerDownLeft,
}
export const GROUP_AREA: Partial<Record<GroupKind, Area>> = {
  person: "people",
  paper: "record",
  claim: "record",
  journal: "research",
  topic: "research",
  exact: "record",
}
/** The order groups appear in (docs/ux/02 §Palette). */
export const GROUP_ORDER: GroupKind[] = ["exact", "person", "paper", "claim", "journal", "topic", "department", "page", "action"]

export const DOI_PATTERN = /10\.\d{4,}\/\S+/

/* ---------------------------------------------------------------- actions */

export type ActionContext = {
  navigate: (to: string) => void
  signOut: () => Promise<void>
}
export type SearchAction = {
  id: string
  label: string
  icon: LucideIcon
  keywords: string[]
  /** Offered with an empty query on these path prefixes. */
  suggestOn?: string[]
  roles?: Role[]
  run: (ctx: ActionContext) => void
}

const CLAIMANT_ROLES: Role[] = ["FACULTY", "HOD", "RESEARCH_CELL", "RESEARCH_COORDINATOR", "PRINCIPAL", "DIRECTOR", "FINANCE"]

/** Verbs, each with the words people type for it. */
export const ACTIONS: SearchAction[] = [
  { id: "file", label: "File a paper", icon: FilePlusCorner, keywords: ["file", "claim", "new paper", "submit", "add paper"], suggestOn: ["/papers", "/", "/search"], roles: CLAIMANT_ROLES, run: (c) => c.navigate("/papers/new") },
  { id: "scopus", label: "Pull from Scopus", icon: CloudDownload, keywords: ["scopus", "pull", "import", "sync"], suggestOn: ["/papers"], roles: CLAIMANT_ROLES, run: (c) => c.navigate("/papers/new?method=scopus") },
  {
    id: "csv",
    label: "Download my papers (CSV)",
    icon: Download,
    keywords: ["download", "csv", "export", "spreadsheet", "excel"],
    suggestOn: ["/papers"],
    roles: CLAIMANT_ROLES,
    run: () => void import("@/pages/papers").then((m) => m.downloadMine()),
  },
  { id: "message", label: "New message", icon: MessageCircle, keywords: ["message", "chat", "dm", "write to"], suggestOn: ["/messages", "/people"], run: (c) => c.navigate("/messages") },
  { id: "event", label: "Add calendar event", icon: CalendarDays, keywords: ["event", "calendar", "meeting", "deadline", "add"], suggestOn: ["/calendar"], run: (c) => c.navigate("/calendar") },
  { id: "gcal", label: "Subscribe calendar to Google", icon: CalendarDays, keywords: ["google", "subscribe", "ics", "feed"], suggestOn: ["/calendar"], run: (c) => c.navigate("/calendar?subscribe=1") },
  { id: "people", label: "Browse people", icon: UsersRound, keywords: ["colleagues", "directory", "people", "faculty"], run: (c) => c.navigate("/search?scope=people") },
  { id: "help", label: "Help and guides", icon: LifeBuoy, keywords: ["help", "guide", "how do i", "how to", "manual", "support"], run: (c) => c.navigate("/help") },
  { id: "signout", label: "Sign out", icon: LogOut, keywords: ["sign out", "log out", "logout", "exit"], run: (c) => void c.signOut() },
]

function score(label: string, keywords: string[] | undefined, term: string): number {
  const l = label.toLowerCase()
  if (l.startsWith(term)) return 0
  if (l.includes(term)) return 1
  if (keywords?.some((k) => k.includes(term) || term.includes(k))) return 2
  return -1
}

export function actionsFor(role: Role | undefined): SearchAction[] {
  return ACTIONS.filter((a) => !a.roles || (role && a.roles.includes(role)))
}

export function matchActions(q: string, role: Role | undefined): SearchAction[] {
  const term = q.trim().toLowerCase()
  if (!term) return []
  return actionsFor(role)
    .map((a) => ({ a, s: score(a.label, a.keywords, term) }))
    .filter(({ s }) => s >= 0)
    .sort((x, y) => x.s - y.s)
    .map(({ a }) => a)
}

export function suggestedActions(pathname: string, role: Role | undefined): SearchAction[] {
  const all = actionsFor(role)
  const here = all.filter((a) => a.suggestOn?.some((p) => (p === "/" ? pathname === "/" : pathname.startsWith(p))))
  return (here.length ? here : all).slice(0, 4)
}

export function matchPages(q: string, role: Role | undefined) {
  const term = q.trim().toLowerCase()
  if (!term) return []
  return navFor(role)
    .map((item) => ({ item, s: score(item.label, item.keywords, term) }))
    .filter(({ s }) => s >= 0)
    .sort((a, b) => a.s - b.s)
    .map(({ item }) => item)
}

/* ---------------------------------------------------------------- recents */

const RECENT_KEY = "search.recent"

export function readRecent(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) || "[]")
    return Array.isArray(v) ? v.filter((x) => typeof x === "string").slice(0, 5) : []
  } catch {
    return []
  }
}
export function pushRecent(q: string) {
  const term = q.trim()
  if (term.length < 2) return
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify([term, ...readRecent().filter((r) => r !== term)].slice(0, 5)))
  } catch {
    /* private mode: recents are a nicety */
  }
}
export function clearRecent() {
  try {
    localStorage.removeItem(RECENT_KEY)
  } catch {
    /* ignore */
  }
}

/* ------------------------------------------------------------------- data */

/** 150ms debounce; a DOI goes straight through (docs/ux/02 §Interactions). */
export function useDebounced(q: string, ms = 150) {
  const [v, setV] = useState(q)
  useEffect(() => {
    if (DOI_PATTERN.test(q)) {
      setV(q)
      return
    }
    const t = setTimeout(() => setV(q), ms)
    return () => clearTimeout(t)
  }, [q, ms])
  return v
}

export function useSearchAll(q: string, scope: SearchScope, limit: number) {
  const term = q.trim()
  const serverScope = scope === "pages" ? null : scope
  return useQuery<SearchAll>({
    queryKey: ["search-all", term, serverScope, limit],
    queryFn: () =>
      api<SearchAll>(`/api/search/all?q=${encodeURIComponent(term)}&scope=${serverScope}&limit=${limit}`),
    enabled: term.length >= 2 && serverScope !== null,
    placeholderData: (prev) => prev,
    staleTime: 30_000,
  })
}

/** One flat, keyboard-navigable list: exact hit, server groups, pages, actions. */
export type Row = {
  key: string
  kind: GroupKind
  title: string
  subtitle?: string
  chips: string[]
  icon: LucideIcon
  url?: string
  run?: () => void
  secondary?: { label: string; run: () => void }
  item?: SearchItem
}
export type RowGroup = { kind: GroupKind; total: number; status: SearchGroup["status"]; rows: Row[] }

export function useRows({
  q,
  scope,
  data,
  role,
  perGroup,
  ctx,
}: {
  q: string
  scope: SearchScope
  data: SearchAll | undefined
  role: Role | undefined
  perGroup: number
  ctx: ActionContext
}): RowGroup[] {
  return useMemo(() => {
    const out: RowGroup[] = []
    const term = q.trim()
    if (term.length < 2 && !(term && scope === "pages")) return out
    const toRow = (kind: GroupKind, it: SearchItem): Row => ({
      key: `${kind}-${it.id}`,
      kind,
      title: it.title,
      subtitle: it.subtitle,
      chips: it.chips ?? [],
      icon: GROUP_ICON[kind],
      url: it.url || undefined,
      item: it,
      secondary: it.secondary_action
        ? {
            label: it.secondary_action.label,
            run: () => {
              const s = it.secondary_action!
              if (s.copy) void navigator.clipboard?.writeText(s.copy)
              else if (s.url) ctx.navigate(s.url)
            },
          }
        : undefined,
    })
    if (data && data.q.trim() === term) {
      if (data.exact) out.push({ kind: "exact", total: 1, status: "ok", rows: [toRow("exact", data.exact)] })
      for (const kind of GROUP_ORDER) {
        const g = data.groups.find((x) => x.kind === kind)
        if (!g || (g.items.length === 0 && g.status === "ok")) continue
        out.push({ kind, total: g.total, status: g.status, rows: g.items.slice(0, perGroup).map((it) => toRow(kind, it)) })
      }
    }
    if (scope === "all" || scope === "pages") {
      const pages = matchPages(term, role)
      if (pages.length)
        out.push({
          kind: "page",
          total: pages.length,
          status: "ok",
          rows: pages.slice(0, perGroup).map((p) => ({
            key: `page-${p.to}`,
            kind: "page",
            title: p.label,
            subtitle: p.group,
            chips: [],
            icon: p.icon,
            url: p.to,
          })),
        })
      const acts = matchActions(term, role).filter((a) => !pages.some((p) => p.label === a.label))
      if (acts.length)
        out.push({
          kind: "action",
          total: acts.length,
          status: "ok",
          rows: acts.slice(0, perGroup).map((a) => ({
            key: `action-${a.id}`,
            kind: "action",
            title: a.label,
            chips: [],
            icon: a.icon,
            run: () => a.run(ctx),
          })),
        })
    }
    return out
    // ctx is recreated each render by callers; its functions are stable in behaviour.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, scope, data, role, perGroup])
}

/* --------------------------------------------------------------- renderer */

export { ConnectionLine, ResultRow } from "@/app/search-row"

/** Open a row: in-app route, outside link, or action. */
export function openRow(row: Row, navigate: (to: string) => void) {
  if (row.run) return row.run()
  if (!row.url) return
  if (/^https?:/.test(row.url)) window.open(row.url, "_blank", "noopener")
  else navigate(row.url)
}
