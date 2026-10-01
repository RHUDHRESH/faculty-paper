import { BookOpen, Building2, FilePlusCorner, MessageCircle, RotateCw, UsersRound, X } from "lucide-react"
import { useInfiniteQuery } from "@tanstack/react-query"
import { useEffect, useMemo, useRef, useState } from "react"
import { Link, useLocation, useNavigate, useSearchParams } from "react-router-dom"

import { useAuth } from "@/app/auth"
import { api } from "@/lib/api"
import { formatCount } from "@/lib/count"
import {
  ConnectionLine,
  DOI_PATTERN,
  GROUP_LABEL,
  ResultRow,
  clearRecent,
  openRow,
  pushRecent,
  readRecent,
  useDebounced,
  useRows,
  useSearchAll,
  type Row,
  type RowGroup,
} from "@/app/search-engine"
import { RowLead, subtitleOf } from "@/app/search-row"
import { useApi } from "@/lib/query"
import { BigSearch, SEARCH_SCOPES, type SearchScope } from "@/ui/big-search"
import { Chip } from "@/ui/chip"
import { Select } from "@/ui/field"
import { Avatar } from "@/ui/person"
import { Picture } from "@/ui/picture"
import { Skeleton } from "@/ui/state"
import { unshout } from "@/lib/names"

/**
 * /search — "Find anything" (docs/ux/02-search.md). One big box over the
 * college's own data (/api/search/all), pages and actions, with the old
 * Colleagues directory as the People scope with no query. Results arrive as
 * you type; the rows are the same ones the Ctrl-K palette shows, only roomier.
 * The query lives in the URL (`?q=&scope=`), so Back restores it.
 */

const TRY = ["10.1109/ACCESS.2024.", "Kanagamalliga", "IEEE Access", "federated learning"]
const PER_GROUP = 5

function useScope(): [SearchScope, string, string, (next: Partial<{ q: string; scope: SearchScope; dept: string }>) => void] {
  const [params, setParams] = useSearchParams()
  const raw = params.get("scope") ?? "all"
  const scope = (SEARCH_SCOPES.some((s) => s.id === raw) ? raw : "all") as SearchScope
  const set = (next: Partial<{ q: string; scope: SearchScope; dept: string }>) =>
    setParams(
      (prev) => {
        const p = new URLSearchParams(prev)
        for (const [k, v] of Object.entries(next)) {
          if (v && !(k === "scope" && v === "all")) p.set(k, v)
          else p.delete(k)
        }
        return p
      },
      { replace: true }
    )
  return [scope, params.get("q") ?? "", params.get("dept") ?? "", set]
}

export function Search() {
  const { me, signOut } = useAuth()
  const navigate = useNavigate()
  const { key: locationKey } = useLocation()
  const [scope, urlQ, dept, setUrl] = useScope()
  const [q, setQ] = useState(urlQ)
  const inputRef = useRef<HTMLInputElement>(null)
  const debounced = useDebounced(q)

  // Back/forward: the URL is the truth.
  useEffect(() => setQ(urlQ), [urlQ, locationKey])
  useEffect(() => {
    if (debounced.trim() !== urlQ) setUrl({ q: debounced.trim() })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced])

  const { data, isFetching, isError, refetch } = useSearchAll(debounced, scope, PER_GROUP)
  const ctx = { navigate, signOut }
  const groups = useRows({ q: debounced, scope, data, role: me?.role, perGroup: PER_GROUP, ctx })
  const flat = useMemo(() => groups.flatMap((g) => g.rows), [groups])
  const [active, setActive] = useState(-1)
  useEffect(() => setActive(-1), [debounced, scope])
  const activeRow = flat[active] ?? flat[0]

  const term = q.trim()
  const searching = term.length >= 2
  const directory = scope === "people" && !term

  function scrollTo(n: number) {
    document.getElementById(`search-row-${n}`)?.scrollIntoView({ block: "nearest" })
  }
  function pick(row: Row) {
    pushRecent(term)
    openRow(row, navigate)
  }
  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault()
      const n = Math.min(active + 1, flat.length - 1)
      setActive(n)
      scrollTo(n)
    } else if (e.key === "ArrowUp") {
      e.preventDefault()
      const n = Math.max(active - 1, -1)
      setActive(n)
      scrollTo(n)
    } else if (e.key === "Enter" && flat.length > 0 && searching) {
      // Enter opens the highlighted row, or the best match when none is.
      e.preventDefault()
      pick(flat[Math.max(active, 0)])
    } else if (e.key === "Escape" && q) {
      e.preventDefault()
      e.stopPropagation()
      setQ("")
      setUrl({ q: "" })
    }
  }

  const box = (
    <BigSearch
      ref={inputRef}
      value={q}
      onChange={setQ}
      onSubmit={(v) => pushRecent(v)}
      scope={scope}
      onScope={(s) => setUrl({ scope: s, dept: "" })}
      placeholder="Papers, people, journals, topics, departments, pages…"
      label="Find anything"
    />
  )
  // The combobox wiring, on BigSearch's own input.
  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.setAttribute("role", "combobox")
    el.setAttribute("aria-controls", "search-results")
    el.setAttribute("aria-expanded", String(flat.length > 0))
    if (active >= 0) el.setAttribute("aria-activedescendant", `search-row-${active}`)
    else el.removeAttribute("aria-activedescendant")
  })

  return (
    <div className="page" onKeyDownCapture={(e) => e.target === inputRef.current && onKeyDown(e as React.KeyboardEvent<HTMLInputElement>)}>
      {!searching && !directory ? (
        <Idle box={box} onTry={(t) => setQ(t)} meId={me?.id} department={me?.department ?? ""} />
      ) : (
        <>
          <h1 className="sr-only">Find anything</h1>
          <div className="sticky top-0 z-10 -mx-4 bg-bg/95 px-4 pt-2 pb-3 backdrop-blur sm:-mx-8 sm:px-8">{box}</div>
          {directory ? (
            <Directory dept={dept} onDept={(d) => setUrl({ dept: d })} />
          ) : (
            <Results
              q={term}
              scope={scope}
              groups={groups}
              loading={isFetching && groups.length === 0}
              failed={isError}
              onRetry={() => void refetch()}
              active={active}
              activeRow={activeRow}
              onActive={setActive}
              onPick={pick}
              onScope={(s) => setUrl({ scope: s })}
              onTry={(t) => setQ(t)}
              meId={me?.id}
            />
          )}
        </>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ idle */

type Card = { id: string; name: string; initials: string; photo_url: string | null; department: string | null; designation: string | null; papers: number }

/** The four places people most often mean when they open Search and are not sure. */
const JUMPS = [
  { to: "/papers/new", icon: FilePlusCorner, title: "File a paper", description: "Claim a published paper." },
  { to: "/search?scope=people", icon: UsersRound, title: "Everyone at the college", description: "Browse by department." },
  { to: "/journals", icon: BookOpen, title: "Top journals", description: "Quartiles and SNIP." },
  { to: "/search?scope=departments&q=eng", icon: Building2, title: "Departments", description: "Who works where." },
]

const pill = "h-8 rounded-full px-3 text-sm shadow-[inset_0_0_0_1px_var(--color-line)] hover:bg-hover focus-visible:ring-2 focus-visible:ring-(--color-accent) outline-none"

function Idle({ box, onTry, meId, department }: { box: React.ReactNode; onTry: (t: string) => void; meId?: string; department: string }) {
  const [recent, setRecent] = useState(readRecent)
  const suggested = useApi<{ total: number; results: Card[] }>(
    ["people-suggested", department],
    `/api/people?limit=7${department ? `&department=${encodeURIComponent(department)}` : ""}`
  )
  const people = (suggested.data?.results ?? []).filter((p) => p.id !== meId).slice(0, 6)
  return (
    <div className="mx-auto max-w-4xl pt-[96px] max-sm:pt-8">
      <h1 className="mb-6 display text-center text-[2rem] leading-[2.5rem] text-fg">Find anything</h1>
      {box}
      <p className="mt-3 text-sm text-fg-muted">Results appear as you type. Paste a DOI to see whether a paper is already in the record and who has claimed it.</p>

      {recent.length > 0 ? (
        <section aria-label="Recent searches" className="mt-8">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-sm font-medium text-fg">Recent searches</h2>
            <button
              type="button"
              onClick={() => {
                clearRecent()
                setRecent([])
              }}
              className="rounded text-sm text-fg-muted outline-none hover:text-fg focus-visible:ring-2 focus-visible:ring-(--color-accent)"
            >
              Clear recent searches
            </button>
          </div>
          <div className="flex flex-wrap gap-2">
            {recent.map((r) => (
              <button key={r} type="button" onClick={() => onTry(r)} className={`${pill} bg-surface text-fg`}>
                {r}
              </button>
            ))}
          </div>
        </section>
      ) : (
        <div className="mt-6 flex flex-wrap items-center gap-2">
          <span className="text-sm text-fg-subtle">Try</span>
          {TRY.map((t) => (
            <button key={t} type="button" onClick={() => onTry(t)} className={`${pill} bg-sunken text-fg-muted`}>
              “{t}”
            </button>
          ))}
        </div>
      )}

      {people.length > 0 && (
        <section aria-label="People you might look for" className="mt-10">
          <div className="mb-3 flex items-baseline justify-between">
            <h2 className="text-sm font-medium text-fg">{department ? `People in ${department}` : "People at the college"}</h2>
            <Link to="/search?scope=people" className="rounded text-sm text-accent outline-none hover:underline focus-visible:ring-2 focus-visible:ring-(--color-accent)">
              Browse everyone
            </Link>
          </div>
          <ul className="grid gap-x-6 sm:grid-cols-2">
            {people.map((p) => (
              <li key={p.id} className="border-b border-line last:border-0 sm:[&:nth-last-child(2):nth-child(odd)]:border-0">
                <Link to={`/people/${p.id}`} className="flex items-center gap-4 rounded-xl px-2 py-3 outline-none hover:bg-hover/60 focus-visible:ring-2 focus-visible:ring-(--color-accent)">
                  <Avatar person={p} size="lg" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[15px] font-medium text-fg">{p.name}</span>
                    <span className="block truncate text-sm text-fg-muted">{[p.designation, p.papers ? papersOf(p.papers) : null].filter(Boolean).join(" · ")}</span>
                    {meId && (
                      <span className="mt-1 flex">
                        <ConnectionLine meId={meId} to={p.id} />
                      </span>
                    )}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section aria-label="Jump to" className="mt-10">
        <h2 className="mb-1 text-sm font-medium text-fg">Or go straight to</h2>
        <ul className="divide-y divide-line">
          {JUMPS.map((j) => (
            <li key={j.to}>
              <Link to={j.to} className="flex items-center gap-3 rounded-control px-2 py-3 outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-(--color-accent)">
                <j.icon aria-hidden className="size-5 shrink-0 text-fg-subtle" strokeWidth={1.75} />
                <span className="min-w-0 flex-1">
                  <span className="font-medium text-fg">{j.title}</span>
                  <span className="ml-2 text-sm text-fg-muted">{j.description}</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}

/* --------------------------------------------------------------- results */

function Results({
  q,
  scope,
  groups,
  loading,
  failed,
  onRetry,
  active,
  activeRow,
  onActive,
  onPick,
  onScope,
  onTry,
  meId,
}: {
  q: string
  scope: SearchScope
  groups: RowGroup[]
  loading: boolean
  failed: boolean
  onRetry: () => void
  active: number
  activeRow: Row | undefined
  onActive: (i: number) => void
  onPick: (row: Row) => void
  onScope: (s: SearchScope) => void
  onTry: (t: string) => void
  meId?: string
}) {
  const total = groups.reduce((n, g) => n + (g.kind === "exact" ? 0 : g.total), 0)
  if (loading)
    return (
      <div className="mt-6 space-y-3" aria-busy="true">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="flex items-center gap-4 px-3 py-3">
            <Skeleton className="size-16 rounded-full" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-4 w-1/2" />
              <Skeleton className="h-3 w-1/3" />
            </div>
          </div>
        ))}
      </div>
    )
  if (failed && groups.length === 0)
    return (
      <div role="alert" className="mt-6 flex items-center gap-3 rounded-xl bg-caution-wash px-4 py-3 text-sm text-caution">
        Could not load the results for “{q}”. Nothing was lost.
        <button type="button" onClick={onRetry} className="inline-flex items-center gap-1 font-medium underline">
          <RotateCw aria-hidden className="size-4" /> Try again
        </button>
      </div>
    )
  if (groups.length === 0) return <NoResults q={q} scope={scope} onScope={onScope} onTry={onTry} />

  let i = -1
  return (
    <div className="mt-4 grid grid-cols-[minmax(0,1fr)] gap-8 lg:grid-cols-12">
      <div id="search-results" role="listbox" aria-label={`${total} results`} className="min-w-0 space-y-8 lg:col-span-8">
        <p className="text-sm text-fg-muted" aria-live="polite">
          {total} {total === 1 ? "result" : "results"} for “{q}” <span className="text-fg-subtle max-sm:hidden">· ↑↓ to move, Enter to open, Esc to clear</span>
        </p>
        {groups.map((g) => (
          <section key={g.kind} aria-label={GROUP_LABEL[g.kind]}>
            <header className="mb-1 flex items-baseline justify-between pb-1">
              <h2 className="text-sm font-medium text-fg">
                {GROUP_LABEL[g.kind]}
                {g.kind !== "exact" && <span className="ml-1.5 font-normal text-fg-subtle">{g.total}</span>}
              </h2>
              {g.total > g.rows.length && scopeOf(g.kind) !== scope && (
                <button type="button" onClick={() => onScope(scopeOf(g.kind))} className="rounded text-sm text-accent outline-none hover:underline focus-visible:ring-2 focus-visible:ring-(--color-accent)">
                  See all {g.total} {GROUP_LABEL[g.kind].toLowerCase()}
                </button>
              )}
            </header>
            {g.status === "error" && (
              <Chip tone="caution" className="my-2">
                {GROUP_LABEL[g.kind]} did not load, so this shows the rest.{" "}
                <button type="button" onClick={onRetry} className="ml-1 underline">
                  Try again
                </button>
              </Chip>
            )}
            <div className="divide-y divide-line">
              {g.rows.map((row) => {
                i += 1
                const n = i
                const m = row.item?.meta ?? {}
                const messageTo = row.kind === "person" && !m.external && m.connect !== meId ? `/messages?to=${row.item!.id}` : null
                return (
                  <ResultRow
                    key={row.key}
                    row={row}
                    id={`search-row-${n}`}
                    active={n === active}
                    onHover={() => onActive(n)}
                    onPick={() => onPick(row)}
                    roomy
                    meId={meId}
                    trailing={
                      messageTo ? (
                        <Link
                          to={messageTo}
                          onClick={(e) => e.stopPropagation()}
                          aria-label={`Message ${row.title}`}
                          className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full px-3 text-sm text-fg-muted shadow-[inset_0_0_0_1px_var(--color-line)] outline-none hover:bg-surface hover:text-fg focus-visible:ring-2 focus-visible:ring-(--color-accent) max-sm:w-9 max-sm:justify-center max-sm:px-0"
                        >
                          <MessageCircle aria-hidden className="size-4" />
                          <span className="max-sm:sr-only">Message</span>
                        </Link>
                      ) : undefined
                    }
                  />
                )
              })}
            </div>
          </section>
        ))}
      </div>
      <aside aria-label="Preview" className="max-lg:hidden lg:col-span-4">
        <div className="sticky top-28">{activeRow && <Preview row={activeRow} meId={meId} onOpen={() => onPick(activeRow)} />}</div>
      </aside>
    </div>
  )
}

function scopeOf(kind: string): SearchScope {
  return ({ person: "people", paper: "papers", claim: "papers", journal: "journals", topic: "topics", department: "departments", page: "pages", action: "pages" } as Record<string, SearchScope>)[kind] ?? "all"
}

function Preview({ row, meId, onOpen }: { row: Row; meId?: string; onOpen: () => void }) {
  const it = row.item
  const m = it?.meta ?? {}
  const isPerson = row.kind === "person"
  const authors = (row.kind === "paper" ? (m.authors ?? []) : []) as { name: string; you: boolean; photo_url?: string | null; initials?: string }[]
  const college = (m.college_coauthors ?? []) as { name: string; papers_together: number }[]
  const openLabel = row.run ? row.title : isPerson ? (m.external ? null : "Open profile") : row.kind === "paper" ? (row.url && /^https?:/.test(row.url) ? "Open at publisher" : "Open paper") : "Open"
  return (
    <div className="panel p-6">
      <div className="flex flex-col items-start gap-4">
        <RowLead row={row} roomy />
        <div className="min-w-0">
          <p className="text-xs text-fg-subtle">{GROUP_LABEL[row.kind].replace(/s$/, "")}</p>
          <h3 className="mt-0.5 text-lg leading-snug font-semibold text-fg">{unshout(row.title)}</h3>
          {subtitleOf(row) && <p className="mt-1 text-sm text-fg-muted">{subtitleOf(row)}</p>}
        </div>
      </div>
      {isPerson && meId && m.connect && !m.external && (
        <div className="mt-4 border-t border-line pt-3">
          <ConnectionLine meId={meId} to={m.connect} />
        </div>
      )}
      {isPerson && m.external && (
        <p className="mt-4 border-t border-line pt-3 text-sm text-fg-muted">
          {college.length
            ? college.map((c) => `${c.papers_together} ${c.papers_together === 1 ? "paper" : "papers"} with ${c.name}`).join("; ")
            : "Outside the college. Not yet a co-author of anyone here."}
        </p>
      )}
      {authors.length > 0 && (
        <ul className="mt-4 space-y-1.5 border-t border-line pt-3">
          {authors.slice(0, 4).map((a) => (
            <li key={a.name} className="flex items-center gap-2 text-sm text-fg">
              <Avatar person={{ name: a.name, initials: a.initials ?? a.name.slice(0, 2).toUpperCase(), photo_url: a.photo_url ?? null }} size="xs" />
              <span className="truncate">{a.you ? `${a.name} (you)` : a.name}</span>
            </li>
          ))}
          {authors.length > 4 && <li className="text-xs text-fg-subtle">and {authors.length - 4} more</li>}
        </ul>
      )}
      {row.kind === "paper" && m.doi && <p className="mt-3 text-sm break-all text-fg-muted">DOI {m.doi}</p>}
      {row.kind === "journal" && (m.snip || m.colleagues) && (
        <p className="mt-3 text-sm text-fg-muted">{[m.snip ? `SNIP ${m.snip}` : null, m.colleagues ? `${m.colleagues} colleagues published here` : null].filter(Boolean).join(" · ")}</p>
      )}
      {openLabel && (row.url || row.run) && (
        <button type="button" onClick={onOpen} className="mt-5 inline-flex h-9 items-center rounded-full bg-accent px-4 text-sm font-medium text-accent-fg outline-none hover:opacity-90 focus-visible:ring-2 focus-visible:ring-(--color-accent) focus-visible:ring-offset-2">
          {openLabel}
        </button>
      )}
    </div>
  )
}

/** Fixes worth trying: a shorter word, a wider scope, a DOI. */
function NoResults({ q, scope, onScope, onTry }: { q: string; scope: SearchScope; onScope: (s: SearchScope) => void; onTry: (t: string) => void }) {
  const words = q.split(/\s+/).filter((w) => w.length >= 3)
  const longest = [...words].sort((a, b) => b.length - a.length)[0] ?? q
  const shorter = longest.length > 4 ? longest.slice(0, Math.max(4, longest.length - 1)) : null
  const fix = "rounded text-accent underline outline-none focus-visible:ring-2 focus-visible:ring-(--color-accent)"
  return (
    <div className="mx-auto mt-10 flex max-w-md flex-col items-center text-center">
      <Picture name="empty-no-results" className="h-40 w-64" />
      <h2 className="mt-5 text-lg font-semibold text-fg">Nothing found for “{q}”.</h2>
      <ul className="mt-3 space-y-1.5 text-sm text-fg-muted">
        {shorter && (
          <li>
            Try a shorter spelling:{" "}
            <button type="button" className={fix} onClick={() => onTry(shorter)}>
              {shorter}
            </button>
          </li>
        )}
        {scope !== "all" && (
          <li>
            <button type="button" className={fix} onClick={() => onScope("all")}>
              Search everything
            </button>{" "}
            instead of only {SEARCH_SCOPES.find((s) => s.id === scope)?.label.toLowerCase()}
          </li>
        )}
        <li>Names work without titles: “Kumar”, not “Dr. Kumar”.</li>
        <li>For a paper, paste its DOI.</li>
      </ul>
      {DOI_PATTERN.test(q) && <p className="mt-3 text-sm text-fg-muted">This DOI is not in the college's record yet. You can file it as a paper.</p>}
    </div>
  )
}

/* ------------------------------------------------------------- directory */

const PAGE = 60

/**
 * The People scope with no query: everyone at the college, fullest profiles
 * first. A hairline list, not a wall of cards: 414 identical boxes each with
 * two buttons buried the one thing a reader came for, the name and face.
 */
function Directory({ dept, onDept }: { dept: string; onDept: (d: string) => void }) {
  const depts = useApi<string[]>(["meta", "departments"], "/api/meta/departments")
  const list = useInfiniteQuery({
    queryKey: ["people-directory", dept],
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      api<{ total: number; results: Card[] }>(`/api/people?limit=${PAGE}&offset=${pageParam}${dept ? `&department=${encodeURIComponent(dept)}` : ""}`),
    getNextPageParam: (last, all) => {
      const seen = all.reduce((n, p) => n + p.results.length, 0)
      return seen < last.total ? seen : undefined
    },
  })
  const people = list.data?.pages.flatMap((p) => p.results) ?? []
  const total = list.data?.pages[0]?.total
  return (
    <section data-area="people" className="mt-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-fg-muted">
          {total == null ? "Everyone at the college." : `${formatCount(total)} ${total === 1 ? "person" : "people"}${dept ? ` in ${dept}` : " at the college"}.`} Type a name above to find one person.
        </p>
        <label className="flex items-center gap-2 text-sm text-fg-muted">
          Department
          <Select value={dept} onChange={(e) => onDept(e.target.value)} className="w-auto max-w-56">
            <option value="">All departments</option>
            {(depts.data ?? []).map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </Select>
          {dept && (
            <button type="button" aria-label="Clear department" onClick={() => onDept("")} className="rounded-control p-2 hover:bg-hover">
              <X className="size-4" />
            </button>
          )}
        </label>
      </div>
      {list.isError && (
        <p role="alert" className="mt-4 text-sm text-critical">
          Could not load the list of people. Nothing was lost.{" "}
          <button type="button" className="underline" onClick={() => void list.refetch()}>
            Try again
          </button>
        </p>
      )}
      <ul className="mt-3 divide-y divide-line">
        {list.isLoading
          ? Array.from({ length: 6 }, (_, i) => (
              <li key={i} className="py-3">
                <Skeleton className="h-12 rounded-control" />
              </li>
            ))
          : people.map((p) => (
              <li key={p.id} className="flex items-center gap-4 py-3">
                <Link to={`/people/${p.id}`} className="flex min-w-0 flex-1 items-center gap-4 rounded-control outline-none hover:bg-hover/60 focus-visible:ring-2 focus-visible:ring-(--color-accent)">
                  <Avatar person={p} size="lg" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[15px] font-medium text-fg">{p.name}</span>
                    <span className="block truncate text-sm text-fg-muted">{[p.department, p.designation].filter(Boolean).join(" · ") || "Not recorded"}</span>
                  </span>
                  <span className="shrink-0 text-sm text-fg-muted tabular max-sm:hidden">{p.papers ? papersOf(p.papers) : "No papers yet"}</span>
                </Link>
                <Link
                  to={`/messages?to=${p.id}`}
                  aria-label={`Message ${p.name}`}
                  className="inline-flex h-10 shrink-0 items-center gap-1.5 rounded-control px-3 text-sm text-fg-muted shadow-[inset_0_0_0_1px_var(--color-line)] outline-none hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-(--color-accent) max-sm:w-10 max-sm:justify-center max-sm:px-0"
                >
                  <MessageCircle aria-hidden className="size-4" />
                  <span className="max-sm:sr-only">Message</span>
                </Link>
              </li>
            ))}
      </ul>
      {list.hasNextPage && (
        <div className="mt-4 text-center">
          <p className="text-sm text-fg-muted">
            Showing {formatCount(people.length)} of {formatCount(total ?? people.length)}.
          </p>
          <button type="button" disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()} className="mt-1 inline-flex h-10 items-center rounded-control px-4 text-sm font-medium text-accent hover:bg-hover disabled:opacity-60">
            {list.isFetchingNextPage ? "Loading" : `Show ${Math.min(PAGE, (total ?? 0) - people.length)} more`}
          </button>
        </div>
      )}
    </section>
  )
}

/** "1 paper", "12 papers". */
function papersOf(n: number) {
  return `${n} ${n === 1 ? "paper" : "papers"}`
}

