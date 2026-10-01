import { useEffect, useMemo, useRef, useState } from "react"
import { useLocation, useNavigate } from "react-router-dom"
import * as RadixDialog from "@radix-ui/react-dialog"
import { AnimatePresence, motion } from "motion/react"
import { ArrowRight, History, Search } from "lucide-react"

import { useAuth } from "@/app/auth"
import {
  GROUP_LABEL,
  ResultRow,
  openRow,
  pushRecent,
  readRecent,
  suggestedActions,
  useDebounced,
  useRows,
  useSearchAll,
  type Row,
  type RowGroup,
} from "@/app/search-engine"
import { cn } from "@/lib/cn"
import { formatCount } from "@/lib/count"
import { SEARCH_SCOPES, type SearchScope } from "@/ui/big-search"

/**
 * Ctrl-K (docs/ux/02-search.md): the same engine as /search, in a 640px
 * modal. A combobox with virtual focus — focus never leaves the input, the
 * highlight moves with the arrows and is announced by
 * `aria-activedescendant`. Radix supplies the focus trap, the inert
 * background and Escape.
 *
 * Keys: ↑↓ move, ↵ open, Ctrl/⌘↵ secondary action, ⇧↵ full results on
 * /search, Tab / ⇧Tab cycle the scope, Esc closes.
 */
export function Palette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { me, signOut } = useAuth()
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const [q, setQ] = useState("")
  const [scope, setScope] = useState<SearchScope>("all")
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const debounced = useDebounced(q)
  const { data, isFetching } = useSearchAll(debounced, scope, 4)

  const go = (to: string) => {
    onClose()
    navigate(to)
  }
  const ctx = { navigate: go, signOut }
  const found = useRows({ q: debounced, scope, data, role: me?.role, perGroup: 4, ctx })

  // Empty query: Recent, then Suggested actions for where the reader is.
  const idle: RowGroup[] = useMemo(() => {
    if (q.trim()) return []
    const recent = readRecent()
    const out: RowGroup[] = []
    if (recent.length)
      out.push({
        kind: "page",
        total: recent.length,
        status: "ok",
        rows: recent.map((r) => ({ key: `recent-${r}`, kind: "page", title: r, chips: [], icon: History, run: () => setQ(r) })),
      })
    out.push({
      kind: "action",
      total: 0,
      status: "ok",
      rows: suggestedActions(pathname, me?.role).map((a) => ({
        key: `suggest-${a.id}`,
        kind: "action",
        title: a.label,
        chips: [],
        icon: a.icon,
        run: () => {
          onClose()
          a.run(ctx)
        },
      })),
    })
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, pathname, me?.role, open])

  const groups = q.trim() ? found : idle
  const seeAll: Row | null =
    q.trim().length >= 2
      ? { key: "see-all", kind: "page", title: `Search everything for “${q.trim()}”`, chips: [], icon: ArrowRight, url: `/search?q=${encodeURIComponent(q.trim())}&scope=${scope}` }
      : null
  const flat = useMemo(() => [...groups.flatMap((g) => g.rows), ...(seeAll ? [seeAll] : [])], [groups, seeAll])

  useEffect(() => {
    if (!open) return
    setQ("")
    setScope("all")
    setActive(0)
  }, [open])
  useEffect(() => setActive(0), [debounced, scope])
  useEffect(() => {
    listRef.current?.querySelector(`[data-i="${active}"]`)?.scrollIntoView({ block: "nearest" })
  }, [active])

  function pick(row: Row) {
    if (q.trim()) pushRecent(q)
    if (row.key.startsWith("recent-")) return row.run?.()
    if (row.run) {
      // Actions close the palette themselves where they navigate.
      onClose()
      return row.run()
    }
    onClose()
    openRow(row, navigate)
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault()
      setActive((i) => Math.min(i + 1, flat.length - 1))
    } else if (e.key === "ArrowUp") {
      e.preventDefault()
      setActive((i) => Math.max(i - 1, 0))
    } else if (e.key === "Tab") {
      e.preventDefault()
      const ids = SEARCH_SCOPES.map((s) => s.id)
      const i = ids.indexOf(scope)
      setScope(ids[(i + (e.shiftKey ? -1 : 1) + ids.length) % ids.length])
    } else if (e.key === "Enter") {
      e.preventDefault()
      if (e.shiftKey && q.trim()) {
        pushRecent(q)
        go(`/search?q=${encodeURIComponent(q.trim())}&scope=${scope}`)
        return
      }
      const row = flat[active]
      if (!row) return
      if ((e.ctrlKey || e.metaKey) && row.secondary) {
        pushRecent(q)
        onClose()
        row.secondary.run()
        return
      }
      pick(row)
    }
  }

  let i = -1
  const loading = q.trim().length >= 2 && isFetching && found.length === 0

  return (
    <RadixDialog.Root open={open} onOpenChange={(v) => !v && onClose()}>
      <AnimatePresence>
        {open && (
          <RadixDialog.Portal forceMount>
            <RadixDialog.Overlay asChild forceMount>
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.12 }}
                className="fixed inset-0 z-[100] bg-black/20"
              />
            </RadixDialog.Overlay>
            <div className="fixed inset-0 z-[100] p-4 pt-[12vh]">
              <RadixDialog.Content
                asChild
                forceMount
                aria-describedby={undefined}
                onOpenAutoFocus={(e) => {
                  e.preventDefault()
                  inputRef.current?.focus()
                }}
              >
                <motion.div
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: 8, transition: { duration: 0.12 } }}
                  transition={{ duration: 0.16, ease: [0.2, 0.8, 0.2, 1] }}
                  className="mx-auto w-full max-w-[640px] overflow-hidden rounded-2xl bg-surface shadow-modal"
                >
                  <RadixDialog.Title className="sr-only">Find anything</RadixDialog.Title>
                  <div className="flex items-center gap-3 border-b border-line px-4">
                    <Search className="size-5 shrink-0 text-fg-subtle" strokeWidth={1.75} aria-hidden />
                    <input
                      ref={inputRef}
                      value={q}
                      onChange={(e) => setQ(e.target.value)}
                      placeholder="Papers, people, journals, topics, departments, pages…"
                      role="combobox"
                      aria-label="Find anything"
                      aria-expanded={flat.length > 0}
                      aria-autocomplete="list"
                      aria-activedescendant={flat[active] ? `palette-${active}` : undefined}
                      aria-controls="palette-list"
                      autoComplete="off"
                      spellCheck={false}
                      className="h-14 w-full bg-transparent text-base outline-none placeholder:text-fg-subtle"
                      onKeyDown={onKeyDown}
                    />
                    <kbd className="shrink-0 rounded-md bg-sunken px-1.5 py-0.5 text-xs text-fg-muted shadow-[inset_0_0_0_1px_var(--color-line)]">
                      Esc
                    </kbd>
                  </div>
                  <div role="tablist" aria-label="Search in" className="flex gap-1.5 overflow-x-auto border-b border-line px-3 py-2">
                    {SEARCH_SCOPES.map((s) => (
                      <button
                        key={s.id}
                        type="button"
                        role="tab"
                        tabIndex={-1}
                        aria-selected={s.id === scope}
                        onClick={() => {
                          setScope(s.id)
                          inputRef.current?.focus()
                        }}
                        className={cn(
                          "h-7 shrink-0 rounded-full px-2.5 text-xs",
                          s.id === scope ? "bg-accent text-accent-fg" : "text-fg-muted hover:bg-hover"
                        )}
                      >
                        {s.label}
                      </button>
                    ))}
                  </div>
                  <div ref={listRef} id="palette-list" role="listbox" aria-label="Results" className="max-h-[56vh] overflow-y-auto p-2">
                    {loading && <p className="px-3 py-6 text-center text-sm text-fg-muted">Searching…</p>}
                    {!loading && q.trim().length >= 2 && groups.length === 0 && !isFetching && (
                      <p className="px-3 py-6 text-center text-sm text-fg-muted">Nothing called “{q.trim()}” here.</p>
                    )}
                    {groups.map((g, gi) => (
                      <div key={`${g.kind}-${gi}`} role="group" aria-label={groupLabel(g, !q.trim(), gi)}>
                        <p className="px-3 pt-2 pb-1 text-sm font-medium text-fg-muted">
                          {groupLabel(g, !q.trim(), gi)}
                          {/* The real total, so four rows read as "four of 44" and not as "all there is". */}
                          {q.trim() && g.kind !== "exact" && g.total > g.rows.length && (
                            <span className="ml-1.5 font-normal text-fg-subtle">{formatCount(g.total)}</span>
                          )}
                          {g.status === "error" && ". Did not load."}
                        </p>
                        {g.rows.map((row) => {
                          i += 1
                          const n = i
                          return (
                            <div key={row.key} data-i={n}>
                              <ResultRow row={row} id={`palette-${n}`} active={n === active} onHover={() => setActive(n)} onPick={() => pick(row)} />
                            </div>
                          )
                        })}
                      </div>
                    ))}
                    {seeAll &&
                      (() => {
                        i += 1
                        const n = i
                        return (
                          <div data-i={n} className="mt-1 border-t border-line pt-1">
                            <ResultRow row={seeAll} id={`palette-${n}`} active={n === active} onHover={() => setActive(n)} onPick={() => pick(seeAll)} />
                          </div>
                        )
                      })()}
                  </div>
                  <p className="flex flex-wrap gap-x-4 border-t border-line px-4 py-2 text-xs text-fg-subtle max-sm:hidden">
                    <span>↑↓ move</span>
                    <span>↵ open</span>
                    <span>Ctrl↵ other action</span>
                    <span>⇧↵ all results</span>
                    <span>Tab scope</span>
                  </p>
                </motion.div>
              </RadixDialog.Content>
            </div>
          </RadixDialog.Portal>
        )}
      </AnimatePresence>
    </RadixDialog.Root>
  )
}

function groupLabel(g: RowGroup, idle: boolean, index: number) {
  if (idle) return g.kind === "action" ? "Suggested actions" : index === 0 ? "Recent" : GROUP_LABEL[g.kind]
  return GROUP_LABEL[g.kind]
}

// The hook lives apart so the first screen can listen for Ctrl K without
// fetching the palette itself.
export { usePalette } from "@/app/palette-hook"
