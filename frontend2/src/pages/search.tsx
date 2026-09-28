import { BookOpen, Building2, FilePlusCorner, RotateCw, UsersRound, X } from "lucide-react"
import { useEffect, useMemo, useRef, useState } from "react"
import { useLocation, useNavigate, useSearchParams } from "react-router-dom"

import { useAuth } from "@/app/auth"
import {
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
  type SearchItem,
} from "@/app/search-engine"
import { cn } from "@/lib/cn"
import { useApi } from "@/lib/query"
import { BigSearch, SEARCH_SCOPES, type SearchScope } from "@/ui/big-search"
import { Chip } from "@/ui/chip"
import { ChoiceTile } from "@/ui/choice"
import { ConnectionPath, type Hop } from "@/ui/connection"
import { JournalCard, PaperCard, PersonCard } from "@/ui/entity"
import { initialsOf } from "@/ui/person"
import { Skeleton } from "@/ui/state"

/**
 * /search — "Find anything" (docs/ux/02-search.md). One big box over the
 * college's own data (/api/search/all), pages and actions, with the old
 * Colleagues directory as the People scope with no query. The query lives in
 * the URL (`?q=&scope=`), so Back restores it.
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

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault()
      setActive((i) => Math.min(i + 1, flat.length - 1))
    } else if (e.key === "ArrowUp") {
      e.preventDefault()
      setActive((i) => Math.max(i - 1, -1))
    } else if (e.key === "Enter" && active >= 0 && flat[active]) {
      e.preventDefault()
      pushRecent(term)
      openRow(flat[active], navigate)
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
        <Idle box={box} onTry={(t) => setQ(t)} />
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
              onPick={(row) => {
                pushRecent(term)
                openRow(row, navigate)
              }}
              onScope={(s) => setUrl({ scope: s })}
              meId={me?.id}
            />
          )}
        </>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ idle */

function Idle({ box, onTry }: { box: React.ReactNode; onTry: (t: string) => void }) {
  const [recent, setRecent] = useState(readRecent)
  return (
    <div className="mx-auto max-w-4xl pt-[120px] max-sm:pt-10">
      <h1 className="mb-6 text-center text-[32px] leading-[38px] font-[650] text-fg">Find anything</h1>
      {box}
      <p className="mt-3 text-sm text-fg-muted">Paste a DOI to check whether a paper exists and who has claimed it.</p>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <span className="text-sm text-fg-subtle">Try:</span>
        {TRY.map((t) => (
          <button key={t} type="button" onClick={() => onTry(t)} className="h-7 rounded-full bg-sunken px-3 text-sm text-fg-muted shadow-[inset_0_0_0_1px_var(--color-line)] hover:bg-hover">
            “{t}”
          </button>
        ))}
      </div>
      <section aria-label="Jump to" className="mt-10">
        <h2 className="mb-3 text-xs font-medium tracking-[0.04em] text-fg-subtle uppercase">Jump to</h2>
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <ChoiceTile to="/papers/new" area="record" icon={FilePlusCorner} title="File a paper" description="Claim a published paper." />
          <ChoiceTile to="/search?scope=people" area="people" icon={UsersRound} title="Browse people" description="Everyone at the college." />
          <ChoiceTile to="/journals" area="research" icon={BookOpen} title="Top journals" description="Quartiles and SNIP." />
          <ChoiceTile to="/search?scope=departments&q=eng" area="people" icon={Building2} title="Departments" description="Who works where." />
        </div>
      </section>
      {recent.length > 0 && (
        <section aria-label="Recent searches" className="mt-8">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-xs font-medium tracking-[0.04em] text-fg-subtle uppercase">Recent searches</h2>
            <button
              type="button"
              onClick={() => {
                clearRecent()
                setRecent([])
              }}
              className="text-sm text-fg-muted hover:text-fg"
            >
              Clear
            </button>
          </div>
          <div className="flex flex-wrap gap-2">
            {recent.map((r) => (
              <button key={r} type="button" onClick={() => onTry(r)} className="h-8 rounded-full bg-surface px-3 text-sm text-fg shadow-[inset_0_0_0_1px_var(--color-line)] hover:bg-hover">
                {r}
              </button>
            ))}
          </div>
        </section>
      )}
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
  meId?: string
}) {
  const total = groups.reduce((n, g) => n + (g.kind === "exact" ? 0 : g.total), 0)
  if (loading)
    return (
      <div className="mt-6 space-y-3" aria-busy="true">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-20 w-full rounded-xl" />
        ))}
      </div>
    )
  if (failed && groups.length === 0)
    return (
      <div role="alert" className="mt-6 flex items-center gap-3 rounded-xl bg-caution-wash px-4 py-3 text-sm text-caution">
        Search did not answer — nothing was lost.
        <button type="button" onClick={onRetry} className="inline-flex items-center gap-1 font-medium underline">
          <RotateCw aria-hidden className="size-4" /> Retry
        </button>
      </div>
    )
  if (groups.length === 0) return <NoResults q={q} onScope={onScope} />

  let i = -1
  return (
    <div className="mt-4 grid gap-6 lg:grid-cols-12">
      <div id="search-results" role="listbox" aria-label={`${total} results`} className="min-w-0 space-y-8 lg:col-span-8">
        <p className="text-sm text-fg-muted">
          {total} {total === 1 ? "result" : "results"} for “{q}”
        </p>
        {groups.map((g) => (
          <section key={g.kind} aria-label={GROUP_LABEL[g.kind]}>
            <header className="mb-2 flex items-center justify-between">
              <h2 className="text-xs font-medium tracking-[0.04em] text-fg-subtle uppercase">
                {GROUP_LABEL[g.kind]} {g.kind !== "exact" && `(${g.total})`}
              </h2>
              {g.total > g.rows.length && scopeOf(g.kind) !== scope && (
                <button type="button" onClick={() => onScope(scopeOf(g.kind))} className="text-sm text-accent hover:underline">
                  See all →
                </button>
              )}
            </header>
            {g.status === "error" && (
              <Chip tone="caution" className="mb-2">
                This part of search is slow right now — showing what answered. <button type="button" onClick={onRetry} className="ml-1 underline">Retry</button>
              </Chip>
            )}
            <div className={cn(g.kind === "person" || g.kind === "journal" ? "grid gap-3 sm:grid-cols-2" : "space-y-2")}>
              {g.rows.map((row) => {
                i += 1
                const n = i
                return (
                  <div
                    key={row.key}
                    id={`search-row-${n}`}
                    role="option"
                    aria-selected={n === active}
                    onMouseEnter={() => onActive(n)}
                    className={cn("rounded-xl", n === active && "ring-2 ring-(--color-accent) ring-offset-2 ring-offset-bg")}
                  >
                    <Entity row={row} meId={meId} onPick={() => onPick(row)} index={n} />
                  </div>
                )
              })}
            </div>
          </section>
        ))}
      </div>
      <aside aria-label="Preview" className="max-lg:hidden lg:col-span-4">
        <div className="sticky top-28">{activeRow && <Preview row={activeRow} meId={meId} />}</div>
      </aside>
    </div>
  )
}

function scopeOf(kind: string): SearchScope {
  return ({ person: "people", paper: "papers", claim: "papers", journal: "journals", topic: "topics", department: "departments", page: "pages", action: "pages" } as Record<string, SearchScope>)[kind] ?? "all"
}

function Entity({ row, meId, onPick, index }: { row: Row; meId?: string; onPick: () => void; index: number }) {
  const it = row.item
  const m = it?.meta ?? {}
  if (row.kind === "person" && it) {
    const ext = !!m.external
    return (
      <PersonCard
        person={{ name: it.title, initials: initialsOf(it.title), photo_url: ext ? null : ((m.photo_url as string | null | undefined) ?? null), department: ext ? null : m.department, designation: ext ? null : m.designation }}
        to={it.url || undefined}
        affiliation={ext ? it.chips[0] ?? "External" : "Saveetha"}
        context={personContext(it)}
        messageTo={ext ? undefined : `/messages?to=${it.id}`}
        path={meId && index < 8 ? <PersonConnection meId={meId} to={m.connect} /> : undefined}
      />
    )
  }
  if (row.kind === "paper" && it) {
    const authors = (m.authors ?? []).map((a: { name: string; you: boolean }) => ({ name: a.name, you: a.you }))
    return (
      <PaperCard
        title={it.title}
        to={it.url && !/^https?:/.test(it.url) ? it.url : undefined}
        journal={m.venue}
        year={m.year}
        quartile={m.quartile}
        authors={authors}
        sources={[...(m.mine ? ["Yours"] : []), m.claimed ? "Claimed" : null, m.citations ? `${m.citations} citations` : null].filter(Boolean) as string[]}
        claim={m.mine && !m.claimed ? { unclaimed: true, fileTo: "/papers/new?method=scopus" } : undefined}
      />
    )
  }
  if (row.kind === "journal" && it) {
    return <JournalCard name={it.title} to={it.url} quartile={m.quartile} snip={m.snip} colleagues={m.colleagues} subjects={m.subject ? [m.subject] : []} />
  }
  return (
    <div className="panel p-1">
      <ResultRow row={row} id={`search-inner-${row.key}`} active={false} onPick={onPick} />
    </div>
  )
}

function personContext(it: SearchItem) {
  const m = it.meta ?? {}
  if (m.external) {
    const with_ = (m.college_coauthors ?? []) as { name: string; papers_together: number }[]
    return with_.length
      ? `${m.papers} papers · wrote with ${with_.map((c) => c.name).slice(0, 2).join(", ")}`
      : `${m.papers} papers`
  }
  return m.papers ? `${m.papers} papers` : undefined
}

type ConnectionBody = {
  hops: number | null
  paths: { people: { key: string; user_id: string | null; name: string; via: { id: string }[] }[] }[]
}

/** "You → X → Y" from /api/people/{me}/connection, or "Not connected yet". */
function PersonConnection({ meId, to }: { meId: string; to: string }) {
  const self = to === meId
  const { data, isLoading } = useApi<ConnectionBody>(["connection", meId, to], `/api/people/${meId}/connection?to=${encodeURIComponent(to)}`, {
    enabled: !!to && !self,
    retry: false,
    staleTime: 5 * 60_000,
  })
  if (self || !to) return null
  if (isLoading) return <Skeleton className="h-8 w-48" />
  if (!data || !data.paths.length || data.hops == null || data.hops > 2)
    return <p className="text-sm text-fg-subtle">Not connected yet</p>
  const paths: Hop[][] = data.paths.slice(0, 2).map((p) =>
    p.people.map((h) => ({
      person: { id: h.user_id ?? undefined, name: h.name, initials: initialsOf(h.name), photo_url: null },
      evidence: h.via?.length ? `${h.via.length} ${h.via.length === 1 ? "paper" : "papers"}` : undefined,
    }))
  )
  return <ConnectionPath paths={paths} />
}

function Preview({ row, meId }: { row: Row; meId?: string }) {
  const it = row.item
  const m = it?.meta ?? {}
  return (
    <div className="panel space-y-3 p-5">
      <p className="text-xs font-medium tracking-[0.04em] text-fg-subtle uppercase">{GROUP_LABEL[row.kind]}</p>
      <h3 className="text-lg font-semibold text-fg">{row.title}</h3>
      {row.subtitle && <p className="text-sm text-fg-muted">{row.subtitle}</p>}
      {row.chips.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {row.chips.map((c) => (
            <Chip key={c}>{c}</Chip>
          ))}
        </div>
      )}
      {row.kind === "person" && meId && m.connect && <PersonConnection meId={meId} to={m.connect} />}
      {row.kind === "person" && m.external && (m.college_coauthors ?? []).length > 0 && (
        <p className="text-sm text-fg-muted">
          {(m.college_coauthors as { name: string; papers_together: number }[])
            .map((c) => `${c.papers_together} ${c.papers_together === 1 ? "paper" : "papers"} with ${c.name}`)
            .join("; ")}
        </p>
      )}
      {row.kind === "paper" && m.doi && <p className="text-sm break-all text-fg-muted">DOI {m.doi}</p>}
    </div>
  )
}

function NoResults({ q, onScope }: { q: string; onScope: (s: SearchScope) => void }) {
  return (
    <div className="mx-auto mt-10 flex max-w-md flex-col items-center text-center">
      <div data-area="record" className="rounded-3xl bg-(--area-wash) p-4">
        <img src="/illustrations/empty-search.svg" alt="" width={200} height={125} />
      </div>
      <h2 className="mt-5 text-lg font-semibold text-fg">Nothing called “{q}” here or in the literature.</h2>
      <p className="mt-2 text-sm text-fg-muted">
        Check the spelling, try a DOI, or search only{" "}
        <button type="button" className="text-accent underline" onClick={() => onScope("people")}>
          People
        </button>{" "}
        /{" "}
        <button type="button" className="text-accent underline" onClick={() => onScope("papers")}>
          Papers
        </button>
        .
      </p>
      {DOI_PATTERN.test(q) && <p className="mt-2 text-sm text-fg-muted">This DOI is not in the college's record yet.</p>}
    </div>
  )
}

/* ------------------------------------------------------------- directory */

type Card = { id: string; name: string; initials: string; photo_url: string | null; department: string | null; designation: string | null; papers: number }

/** The People scope with no query: the old Colleagues directory. */
function Directory({ dept, onDept }: { dept: string; onDept: (d: string) => void }) {
  const [limit, setLimit] = useState(48)
  const depts = useApi<string[]>(["meta", "departments"], "/api/meta/departments")
  const { data, isLoading, isError, refetch } = useApi<{ total: number; results: Card[] }>(
    ["people-directory", dept, limit],
    `/api/people?limit=${limit}${dept ? `&department=${encodeURIComponent(dept)}` : ""}`,
    { placeholderData: (p) => p }
  )
  const people = useMemo(() => [...(data?.results ?? [])].sort((a, b) => a.name.localeCompare(b.name)), [data])
  return (
    <section data-area="people" className="mt-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-fg-muted">
          Everyone at the college — {data ? data.total : "—"} people. Filter by department, or type a name.
        </p>
        <label className="flex items-center gap-2 text-sm text-fg-muted">
          Department
          <select
            value={dept}
            onChange={(e) => onDept(e.target.value)}
            className="h-9 max-w-56 rounded-md bg-surface px-2 text-sm text-fg shadow-[inset_0_0_0_1px_var(--color-field)]"
          >
            <option value="">All departments</option>
            {(depts.data ?? []).map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
          {dept && (
            <button type="button" aria-label="Clear department" onClick={() => onDept("")} className="rounded p-1 hover:bg-hover">
              <X className="size-4" />
            </button>
          )}
        </label>
      </div>
      {isError && (
        <p role="alert" className="mt-4 text-sm text-critical">
          The directory did not load. Nothing was lost.{" "}
          <button type="button" className="underline" onClick={() => void refetch()}>
            Retry
          </button>
        </p>
      )}
      <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {isLoading
          ? Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-28 rounded-xl" />)
          : people.map((p) => (
              <PersonCard key={p.id} person={p} to={`/people/${p.id}`} messageTo={`/messages?to=${p.id}`} context={p.papers ? `${p.papers} papers` : undefined} />
            ))}
      </div>
      {data && data.total > people.length && limit < 60 && (
        <p className="mt-4 text-center text-sm text-fg-muted">
          Showing {people.length} of {data.total}. Type a name to find anyone else.
        </p>
      )}
      {data && data.total > people.length && limit < 60 && (
        <div className="mt-2 text-center">
          <button type="button" onClick={() => setLimit(60)} className="text-sm text-accent hover:underline">
            Show more
          </button>
        </div>
      )}
    </section>
  )
}
