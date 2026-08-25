import { useEffect, useMemo, useRef, useState } from "react"
import { useNavigate } from "react-router-dom"
import { AnimatePresence, motion } from "motion/react"
import { CornerDownLeft, FileText, Hash, Search, User2 } from "lucide-react"

import { useAuth } from "@/app/auth"
import { navFor, type NavItem } from "@/app/nav"
import { api } from "@/lib/api"
import { cn } from "@/lib/cn"

/**
 * Ctrl-K, as the way around rather than as a search box.
 *
 * Linear's model: the palette knows every place you can go and every thing
 * you can open, it is one keystroke from anywhere, and it never requires the
 * mouse. Typing filters across all of it at once — a page, a person, a ticket
 * number off an email — because a reader holding a ticket number should not
 * first have to work out which screen accepts one.
 *
 * The rules that make it feel instant:
 *
 * - Pages are matched locally and shown immediately. They are a known list;
 *   waiting on the network to tell you where "Reports" is would be absurd.
 * - Records are fetched, debounced, and folded in underneath as they arrive,
 *   so the list never empties and re-fills while somebody is reading it.
 * - Arrow keys move a highlight; focus never leaves the input, so typing
 *   continues to work at every point. Announced with aria-activedescendant.
 */

type Hit = {
  id: string
  kind: "page" | "ticket" | "person" | "journal"
  title: string
  detail?: string
  to: string
}

const KIND_ICON = {
  page: Hash,
  ticket: FileText,
  person: User2,
  journal: FileText,
} as const

const KIND_LABEL = {
  page: "Go to",
  ticket: "Papers",
  person: "People",
  journal: "Journals",
} as const

export function Palette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { me } = useAuth()
  const nav = useNavigate()
  const [q, setQ] = useState("")
  const [remote, setRemote] = useState<Hit[]>([])
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const pages = useMemo(() => navFor(me?.role), [me?.role])

  // Pages match locally and appear on the first keystroke.
  const pageHits: Hit[] = useMemo(() => {
    const term = q.trim().toLowerCase()
    const score = (item: NavItem) => {
      const label = item.label.toLowerCase()
      if (!term) return 0
      if (label.startsWith(term)) return 0
      if (label.includes(term)) return 1
      if (item.keywords?.some((k) => k.includes(term))) return 2
      return -1
    }
    return pages
      .map((item) => ({ item, s: score(item) }))
      .filter(({ s }) => s >= 0)
      .sort((a, b) => a.s - b.s)
      .slice(0, term ? 6 : 8)
      .map(({ item }) => ({
        id: item.to,
        kind: "page" as const,
        title: item.label,
        detail: item.group,
        to: item.to,
      }))
  }, [pages, q])

  useEffect(() => {
    if (!open) return
    setQ("")
    setRemote([])
    setActive(0)
    const t = setTimeout(() => inputRef.current?.focus(), 20)
    return () => clearTimeout(t)
  }, [open])

  // Records arrive underneath, debounced. Failure is silent on purpose: the
  // pages still work, and an error banner over a search box is noise.
  useEffect(() => {
    const term = q.trim()
    if (term.length < 2) {
      setRemote([])
      return
    }
    let cancelled = false
    const t = setTimeout(async () => {
      try {
        const res = await api<{
          tickets: { id: string; ticket_number: string | null; paper_title: string; owner_name: string }[]
          faculty: { id: string; name: string; department?: string | null }[]
        }>(`/api/lookup/ticket?q=${encodeURIComponent(term)}`)
        if (cancelled) return
        setRemote([
          ...res.faculty.slice(0, 5).map((p) => ({
            id: `p-${p.id}`,
            kind: "person" as const,
            title: p.name,
            detail: p.department || undefined,
            to: `/people/${p.id}`,
          })),
          ...res.tickets.slice(0, 6).map((t2) => ({
            id: `t-${t2.id}`,
            kind: "ticket" as const,
            title: t2.paper_title,
            detail: [t2.ticket_number, t2.owner_name].filter(Boolean).join(" · "),
            to: `/papers/${t2.id}`,
          })),
        ])
      } catch {
        if (!cancelled) setRemote([])
      }
    }, 180)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [q])

  const hits = useMemo(() => [...pageHits, ...remote], [pageHits, remote])

  useEffect(() => setActive(0), [q])
  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-i="${active}"]`)
      ?.scrollIntoView({ block: "nearest" })
  }, [active])

  const grouped = useMemo(() => {
    const out: { kind: Hit["kind"]; rows: { hit: Hit; i: number }[] }[] = []
    hits.forEach((hit, i) => {
      const last = out[out.length - 1]
      if (last && last.kind === hit.kind) last.rows.push({ hit, i })
      else out.push({ kind: hit.kind, rows: [{ hit, i }] })
    })
    return out
  }, [hits])

  function go(hit: Hit) {
    onClose()
    nav(hit.to)
  }

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.12 }}
          className="fixed inset-0 z-[100] bg-black/20 p-4 pt-[14vh]"
          onClick={onClose}
        >
          <motion.div
            initial={{ opacity: 0, y: -8, scale: 0.985 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -8, scale: 0.985 }}
            transition={{ duration: 0.16, ease: [0.16, 1, 0.3, 1] }}
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-label="Search and go to"
            className="mx-auto w-full max-w-xl overflow-hidden rounded-[--radius-xl] bg-[--color-surface] shadow-[--shadow-modal]"
          >
            <div className="flex items-center gap-2.5 border-b border-[--color-line] px-4">
              <Search className="size-4 shrink-0 text-[--color-fg-subtle]" aria-hidden />
              <input
                ref={inputRef}
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Go to a page, or find a paper, a person, a ticket number…"
                aria-activedescendant={hits[active] ? `palette-${active}` : undefined}
                aria-controls="palette-list"
                className="h-12 w-full bg-transparent text-base outline-none placeholder:text-[--color-fg-subtle]"
                onKeyDown={(e) => {
                  if (e.key === "ArrowDown") {
                    e.preventDefault()
                    setActive((i) => Math.min(i + 1, hits.length - 1))
                  } else if (e.key === "ArrowUp") {
                    e.preventDefault()
                    setActive((i) => Math.max(i - 1, 0))
                  } else if (e.key === "Enter" && hits[active]) {
                    e.preventDefault()
                    go(hits[active])
                  } else if (e.key === "Escape") {
                    e.preventDefault()
                    onClose()
                  }
                }}
              />
            </div>

            <div ref={listRef} id="palette-list" role="listbox" className="max-h-[52vh] overflow-y-auto p-1.5">
              {hits.length === 0 ? (
                <p className="px-3 py-8 text-center text-sm text-[--color-fg-muted]">
                  {q.trim().length < 2
                    ? "Type to search. A page name, a surname, a ticket number."
                    : `Nothing matched “${q.trim()}”.`}
                </p>
              ) : (
                grouped.map((group) => (
                  <div key={`${group.kind}-${group.rows[0].i}`}>
                    <p className="px-2.5 pb-1 pt-2 text-xs font-medium text-[--color-fg-subtle]">
                      {KIND_LABEL[group.kind]}
                    </p>
                    {group.rows.map(({ hit, i }) => {
                      const Icon = KIND_ICON[hit.kind]
                      const on = i === active
                      return (
                        <button
                          key={hit.id}
                          id={`palette-${i}`}
                          data-i={i}
                          role="option"
                          aria-selected={on}
                          type="button"
                          onMouseEnter={() => setActive(i)}
                          onClick={() => go(hit)}
                          className={cn(
                            "flex w-full items-center gap-2.5 rounded-[--radius] px-2.5 py-2 text-left",
                            on ? "bg-[--color-hover]" : ""
                          )}
                        >
                          <Icon className="size-4 shrink-0 text-[--color-fg-subtle]" aria-hidden />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm">{hit.title}</span>
                            {hit.detail && (
                              <span className="block truncate text-xs text-[--color-fg-muted]">
                                {hit.detail}
                              </span>
                            )}
                          </span>
                          {on && (
                            <CornerDownLeft
                              className="size-3.5 shrink-0 text-[--color-fg-subtle]"
                              aria-hidden
                            />
                          )}
                        </button>
                      )
                    })}
                  </div>
                ))
              )}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

/** Ctrl-K / Cmd-K from anywhere, and Escape to leave. */
export function usePalette() {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault()
        setOpen((v) => !v)
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])
  return { open, setOpen }
}
