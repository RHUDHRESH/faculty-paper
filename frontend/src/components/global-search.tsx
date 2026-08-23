"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { useNavigate, useLocation } from "react-router-dom"
import { BookOpen, CornerDownLeft, FileText, Search, User2 } from "lucide-react"

import { useAuth } from "@/components/auth-provider"
import { StatusChip } from "@/components/ticket-ui"
import { api } from "@/lib/api"
import { cn } from "@/lib/utils"

/**
 * One box that finds anything, from anywhere.
 *
 * Every portal had its own search for its own kind of thing, each on its own
 * screen: a ticket number went in one, a person's name in another, and
 * neither was reachable from the page you were on. Somebody holding a ticket
 * number off an email had to work out which screen would accept it first.
 *
 * Ctrl-K, or the button in the header. It searches what the signed-in person
 * is allowed to see — the same scoped endpoint the Find screen uses, so a
 * claimant finds their own tickets and nobody else's, and a head of
 * department is not offered it at all, having no money screens to jump to.
 *
 * The panel itself was a plain white box on a flat scrim with an
 * undifferentiated list: people, tickets and nothing else, each row the same
 * weight, so a search for a surname that matched six papers as well gave you
 * a wall to read rather than an answer to pick. It now speaks the same visual
 * language as the rest of the app's dialogs, groups what it found by what it
 * is, and includes journals — which became records of their own and were
 * missing from the one place you would think to look for them.
 */

type Kind = "person" | "ticket" | "journal"

type Hit = {
  kind: Kind
  id: string
  title: string
  detail: string
  status?: string
  to: string
}

const GROUPS: { kind: Kind; label: string; icon: typeof User2 }[] = [
  { kind: "person", label: "People", icon: User2 },
  { kind: "ticket", label: "Tickets", icon: FileText },
  { kind: "journal", label: "Journals", icon: BookOpen },
]

/** A key, drawn like a key. */
function Key({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded border border-border bg-muted px-1.5 font-sans text-[11px] font-medium text-muted-foreground">
      {children}
    </kbd>
  )
}

export function GlobalSearch() {
  const { user } = useAuth()
  const nav = useNavigate()
  const { pathname } = useLocation()
  const [open, setOpen] = useState(false)
  const [term, setTerm] = useState("")
  const [hits, setHits] = useState<Hit[]>([])
  const [active, setActive] = useState(0)
  const [busy, setBusy] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const portal = pathname.split("/")[1] || "faculty"
  // A head of department has no ticket or record screens to land on, so the
  // shortcut would only ever find them a locked door.
  const available = !!user && user.role !== "HOD"

  useEffect(() => {
    if (!available) return
    function onKey(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault()
        setOpen((v) => !v)
      }
      if (e.key === "Escape") setOpen(false)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [available])

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 30)
    else {
      setTerm("")
      setHits([])
      setActive(0)
    }
  }, [open])

  useEffect(() => {
    const q = term.trim()
    if (q.length < 2) {
      setHits([])
      return
    }
    let cancelled = false
    setBusy(true)
    // Debounced: a query per keystroke over three thousand tickets is a query
    // per keystroke the server did not need to run.
    const timer = setTimeout(async () => {
      try {
        const [res, journals] = await Promise.all([
          api<{
            tickets: {
              id: string
              ticket_number: string | null
              paper_title: string
              owner_name: string
              status: string
            }[]
            faculty: {
              id: string
              name: string
              department?: string | null
              designation?: string | null
            }[]
          }>(`/api/lookup/ticket?q=${encodeURIComponent(q)}`),
          // A journal is a record now. Failing to find one should not take
          // the people and tickets down with it, so it resolves to empty.
          api<{ results: { key: string; count: number }[] }>(
            `/api/journals/top?q=${encodeURIComponent(q)}&limit=5`
          ).catch(() => ({ results: [] as { key: string; count: number }[] })),
        ])
        if (cancelled) return
        const found: Hit[] = [
          ...res.faculty.map((p) => ({
            kind: "person" as const,
            id: p.id,
            title: p.name,
            detail: [p.designation, p.department].filter(Boolean).join(" · "),
            to: `/${portal}/faculty/${p.id}`,
          })),
          ...res.tickets.map((t) => ({
            kind: "ticket" as const,
            id: t.id,
            title: t.paper_title,
            detail: [t.ticket_number, t.owner_name].filter(Boolean).join(" · "),
            status: t.status,
            to:
              portal === "faculty"
                ? `/faculty?claim=${t.id}`
                : `/${portal === "finance" ? "finance" : "admin"}/clearing?claim=${t.id}`,
          })),
          ...(portal === "faculty"
            ? []
            : journals.results.map((j) => ({
                kind: "journal" as const,
                id: j.key,
                title: j.key,
                detail: `${j.count} publication${j.count === 1 ? "" : "s"} from the college`,
                to: `/${portal}/journal?title=${encodeURIComponent(j.key)}`,
              }))),
        ]
        setHits(found)
        setActive(0)
      } catch {
        setHits([])
      } finally {
        if (!cancelled) setBusy(false)
      }
    }, 250)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [term, portal])

  // Grouped for reading, flat for the keyboard: arrow keys move down the
  // whole list regardless of which heading a row sits under.
  const grouped = useMemo(() => {
    let i = 0
    return GROUPS.map((g) => ({
      ...g,
      rows: hits
        .filter((h) => h.kind === g.kind)
        .map((h) => ({ hit: h, index: i++ })),
    })).filter((g) => g.rows.length)
  }, [hits])

  const empty = term.trim().length >= 2 && !busy && hits.length === 0

  // Keep the highlighted row on screen when the arrows run past the fold.
  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-index="${active}"]`)
      ?.scrollIntoView({ block: "nearest" })
  }, [active])

  if (!available) return null

  function go(hit: Hit) {
    setOpen(false)
    nav(hit.to)
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="interactive flex w-full items-center gap-2 rounded-lg border border-border bg-card px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground"
        aria-label="Search everything"
      >
        <Search className="size-4" aria-hidden />
        <span className="flex-1 text-left">Search</span>
        {/* The hint is for people who have a keyboard. */}
        <kbd className="hidden rounded border border-border px-1.5 text-xs sm:inline">
          Ctrl K
        </kbd>
      </button>

      {open ? (
        <div
          className="fixed inset-0 z-[60] animate-in bg-black/45 p-4 pt-[12vh] fade-in-0 duration-100"
          onClick={() => setOpen(false)}
        >
          <div
            className={cn(
              "mx-auto w-full max-w-2xl overflow-hidden outline-none",
              "rounded-[min(var(--radius-4xl),24px)] bg-popover text-popover-foreground",
              "shadow-xl ring-1 ring-foreground/5 dark:ring-foreground/10",
              "animate-in fade-in-0 zoom-in-95 duration-100"
            )}
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-label="Search"
          >
            <div className="flex items-center gap-3 border-b border-border px-5">
              <Search
                className={cn(
                  "size-4 shrink-0 transition-colors",
                  busy ? "animate-pulse text-primary" : "text-muted-foreground"
                )}
                aria-hidden
              />
              <input
                ref={inputRef}
                value={term}
                onChange={(e) => setTerm(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "ArrowDown") {
                    e.preventDefault()
                    setActive((i) => Math.min(i + 1, hits.length - 1))
                  }
                  if (e.key === "ArrowUp") {
                    e.preventDefault()
                    setActive((i) => Math.max(i - 1, 0))
                  }
                  if (e.key === "Enter" && hits[active]) go(hits[active])
                }}
                placeholder="A ticket number, a name, a staff id, a journal…"
                className="h-14 w-full border-0 bg-transparent text-base outline-none placeholder:text-muted-foreground/70"
              />
              <Key>Esc</Key>
            </div>

            <div ref={listRef} className="max-h-[52vh] overflow-y-auto py-2">
              {term.trim().length < 2 ? (
                <div className="px-5 py-8 text-center">
                  <p className="text-sm text-muted-foreground">
                    Whatever you have to hand works.
                  </p>
                  <div className="mt-3 flex flex-wrap justify-center gap-1.5">
                    {["a ticket number", "a surname", "a staff id", "a journal"].map((h) => (
                      <span
                        key={h}
                        className="rounded-full border border-border px-2.5 py-1 text-xs text-muted-foreground"
                      >
                        {h}
                      </span>
                    ))}
                  </div>
                </div>
              ) : empty ? (
                <p className="px-5 py-8 text-center text-sm text-muted-foreground">
                  Nothing matched “{term.trim()}”.
                </p>
              ) : (
                grouped.map((g) => (
                  <div key={g.kind} className="pb-1">
                    <p className="px-5 pb-1 pt-2 text-[0.7rem] font-medium uppercase tracking-wide text-muted-foreground/70">
                      {g.label}
                    </p>
                    <ul>
                      {g.rows.map(({ hit, index }) => {
                        const Icon = g.icon
                        const on = index === active
                        return (
                          <li key={`${hit.kind}-${hit.id}`}>
                            <button
                              type="button"
                              data-index={index}
                              onMouseEnter={() => setActive(index)}
                              onClick={() => go(hit)}
                              className={cn(
                                "interactive mx-2 flex w-[calc(100%-1rem)] items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors",
                                on ? "bg-accent" : "hover:bg-accent/50"
                              )}
                            >
                              <span
                                className={cn(
                                  "flex size-8 shrink-0 items-center justify-center rounded-md border transition-colors",
                                  on
                                    ? "border-primary/25 bg-primary/10 text-primary"
                                    : "border-border bg-muted text-muted-foreground"
                                )}
                              >
                                <Icon className="size-4" aria-hidden />
                              </span>
                              <span className="min-w-0 flex-1">
                                <span className="block truncate text-sm font-medium">
                                  {hit.title}
                                </span>
                                <span className="block truncate text-xs text-muted-foreground">
                                  {hit.detail}
                                </span>
                              </span>
                              {hit.status ? (
                                <StatusChip status={hit.status} className="shrink-0" />
                              ) : null}
                              {/* Only the row you would land on says so. */}
                              {on ? (
                                <CornerDownLeft
                                  className="size-3.5 shrink-0 text-muted-foreground"
                                  aria-hidden
                                />
                              ) : null}
                            </button>
                          </li>
                        )
                      })}
                    </ul>
                  </div>
                ))
              )}
            </div>

            <div className="flex items-center gap-4 border-t border-border px-5 py-2.5 text-xs text-muted-foreground">
              <span className="flex items-center gap-1.5">
                <Key>↑</Key>
                <Key>↓</Key>
                move
              </span>
              <span className="flex items-center gap-1.5">
                <Key>↵</Key>
                open
              </span>
              {hits.length ? (
                <span className="ml-auto tabular-nums">
                  {hits.length} result{hits.length === 1 ? "" : "s"}
                </span>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
    </>
  )
}
