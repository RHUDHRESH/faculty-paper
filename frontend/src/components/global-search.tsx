"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { useNavigate, useLocation } from "react-router-dom"
import { FileText, Search, User2, X } from "lucide-react"

import { useAuth } from "@/components/auth-provider"
import { Input } from "@/components/ui/input"
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
 */

type Hit = {
  kind: "ticket" | "person"
  id: string
  title: string
  detail: string
  to: string
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
        const res = await api<{
          tickets: { id: string; ticket_number: string | null; paper_title: string; owner_name: string; status: string }[]
          faculty: { id: string; name: string; department?: string | null; designation?: string | null }[]
        }>(`/api/lookup/ticket?q=${encodeURIComponent(q)}`)
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
            to:
              portal === "faculty"
                ? `/faculty?claim=${t.id}`
                : `/${portal === "finance" ? "finance" : "admin"}/clearing?claim=${t.id}`,
          })),
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

  const empty = useMemo(
    () => term.trim().length >= 2 && !busy && hits.length === 0,
    [term, busy, hits]
  )

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
          className="fixed inset-0 z-[60] bg-black/40 p-4 pt-[10vh]"
          onClick={() => setOpen(false)}
        >
          <div
            className="mx-auto w-full max-w-xl overflow-hidden rounded-[var(--radius)] border border-border bg-card shadow-xl"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-label="Search"
          >
            <div className="flex items-center gap-2 border-b border-border px-4">
              <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              <Input
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
                placeholder="A ticket number, a name, a staff id, a paper…"
                className="border-0 shadow-none focus-visible:ring-0"
              />
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="interactive shrink-0 text-muted-foreground hover:text-foreground"
                aria-label="Close"
              >
                <X className="size-4" />
              </button>
            </div>

            <div className="max-h-[50vh] overflow-y-auto">
              {term.trim().length < 2 ? (
                <p className="px-4 py-6 text-center text-sm text-muted-foreground">
                  Type at least two characters. Whatever you have to hand works —
                  a ticket number, a surname, a staff id.
                </p>
              ) : empty ? (
                <p className="px-4 py-6 text-center text-sm text-muted-foreground">
                  Nothing matched “{term.trim()}”.
                </p>
              ) : (
                <ul className="divide-y divide-border">
                  {hits.map((hit, i) => (
                    <li key={`${hit.kind}-${hit.id}`}>
                      <button
                        type="button"
                        onMouseEnter={() => setActive(i)}
                        onClick={() => go(hit)}
                        className={cn(
                          "interactive flex w-full items-center gap-3 px-4 py-3 text-left",
                          i === active ? "bg-accent/50" : "hover:bg-accent/30"
                        )}
                      >
                        {hit.kind === "person" ? (
                          <User2 className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                        ) : (
                          <FileText className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                        )}
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium">
                            {hit.title}
                          </span>
                          <span className="block truncate text-xs text-muted-foreground">
                            {hit.detail}
                          </span>
                        </span>
                        <span className="shrink-0 text-xs text-muted-foreground">
                          {hit.kind === "person" ? "Record" : "Ticket"}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <p className="border-t border-border px-4 py-2 text-xs text-muted-foreground">
              ↑↓ to move · Enter to open · Esc to close
            </p>
          </div>
        </div>
      ) : null}
    </>
  )
}
