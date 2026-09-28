import { useMemo, useState } from "react"
import { Link, Navigate, useNavigate, useSearchParams } from "react-router-dom"
import {
  CloudDownload,
  ClipboardPaste,
  FilePlusCorner,
  FileText,
  Hourglass,
  IndianRupee,
  MoreHorizontal,
  PenLine,
  Search,
  SlidersHorizontal,
  X,
} from "lucide-react"
import { useQueryClient } from "@tanstack/react-query"

import { api } from "@/lib/api"
import { cn } from "@/lib/cn"
import { useApi } from "@/lib/query"
import { Button } from "@/ui/button"
import { Chip } from "@/ui/chip"
import { ConfirmDialog } from "@/ui/dialog"
import { PaperCard } from "@/ui/entity"
import { Input } from "@/ui/field"
import { HeroBand } from "@/ui/hero"
import { Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from "@/ui/menu"
import { money, stageOf } from "@/ui/paper"
import { Avatar, initialsOf } from "@/ui/person"
import { EmptyState, ErrorState, SkeletonRows } from "@/ui/state"
import { toast } from "@/ui/toast"
import { topicPicture } from "@/ui/picture"

/**
 * My papers (docs/ux/03): the person's whole publication record from the
 * Publication/Authorship tables, with each paper's claim as a *state* of the
 * paper rather than the list itself. The old claims-only list lives on at
 * `/papers/claims` (drafts included); `/papers?status=` goes there.
 */

export type RecordAuthor = {
  name: string
  position: number | null
  user_id: string | null
  is_college: boolean
  institution: string | null
  photo_url?: string | null
  initials?: string
}

export type RecordPaper = {
  id: string
  title: string
  year: number | null
  date: string | null
  venue: string | null
  type: string | null
  quartile: string | null
  doi: string | null
  eid: string | null
  openalex_id: string | null
  citations: number | null
  source: string | null
  scopus_indexed?: boolean
  /** True or false only when a source (OpenAlex, the claim) says; null when unknown. */
  corresponding_author?: boolean | null
  author_position: number | null
  total_authors: number
  match_confidence: number | null
  authors: RecordAuthor[]
  /** `id` is null for a paper paid through the ledger with no claim in this app. */
  claim: { id: string | null; stage: string; days_waiting: number | null; amount?: number | null; paid_month?: string | null } | null
  eligible: boolean
  ineligible_reason: string | null
}

type Payload = {
  user: { id: string; name: string }
  metrics: { total_publications: number; total_citations: number; first_year: number | null }
  count: number
  unclaimed: number
  publications: RecordPaper[]
}

export const TABS = [
  { id: "all", label: "All" },
  { id: "unclaimed", label: "Not claimed" },
  { id: "progress", label: "In progress" },
  { id: "paid", label: "Paid" },
  { id: "ineligible", label: "Not eligible" },
] as const
type Tab = (typeof TABS)[number]["id"]

export function tabOf(p: RecordPaper): Exclude<Tab, "all"> {
  if (p.claim) return p.claim.stage === "PAID" ? "paid" : "progress"
  return p.eligible ? "unclaimed" : "ineligible"
}


function csvCell(v: unknown): string {
  const s = v == null ? "" : String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function toCsv(rows: RecordPaper[]): string {
  const head = ["Title", "Venue", "Year", "Type", "Quartile", "DOI", "Author position", "Authors", "Citations", "Claim"]
  const body = rows.map((p) =>
    [
      p.title,
      p.venue,
      p.year,
      p.type,
      p.quartile,
      p.doi,
      p.author_position ? `${p.author_position} of ${p.total_authors}` : "",
      p.authors.map((a) => a.name).join("; "),
      p.citations,
      p.claim ? stageOf(p.claim.stage).label : tabOf(p) === "unclaimed" ? "Not claimed" : "Not eligible",
    ]
      .map(csvCell)
      .join(",")
  )
  return [head.join(","), ...body].join("\n")
}

export function toBibtex(rows: RecordPaper[]): string {
  return rows
    .map((p, i) => {
      const first = (p.authors[0]?.name ?? "anon").split(/\s+/).pop()?.replace(/\W/g, "") || "anon"
      const key = `${first.toLowerCase()}${p.year ?? ""}${i}`
      const kind = /conference|proceeding/i.test(p.type ?? "") ? "inproceedings" : "article"
      const fields = [
        ["title", p.title],
        ["author", p.authors.map((a) => a.name).join(" and ")],
        [kind === "article" ? "journal" : "booktitle", p.venue],
        ["year", p.year],
        ["doi", p.doi],
      ]
        .filter(([, v]) => v != null && v !== "")
        .map(([k, v]) => `  ${k} = {${String(v).replace(/[{}]/g, "")}}`)
      return `@${kind}{${key},\n${fields.join(",\n")}\n}`
    })
    .join("\n\n")
}

function download(name: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }))
  const a = document.createElement("a")
  a.href = url
  a.download = name
  a.click()
  URL.revokeObjectURL(url)
}

/** The whole record as a spreadsheet, for the search palette's "Download my papers". */
export async function downloadMine(): Promise<void> {
  const data = await api<Payload>("/api/me/publications?sort=year")
  download("my-papers.csv", toCsv(data.publications), "text/csv")
}

const selectClass =
  "h-9 w-full rounded-md bg-surface px-2 text-sm text-fg ring-1 ring-inset ring-field focus-visible:ring-2 focus-visible:ring-accent outline-none"

const SORT_LABEL: Record<string, string> = {
  year: "Newest first",
  oldest: "Oldest first",
  citations: "Most cited",
  title: "Title A to Z",
}

/** What a Scopus check changed, in words: "1 new paper, 2 now paid". */
export function describeChange(before: RecordPaper[], after: RecordPaper[]): string {
  const was = new Map(before.map((p) => [p.id, tabOf(p)]))
  const added = after.filter((p) => !was.has(p.id)).length
  const moved: Record<string, number> = {}
  for (const p of after) {
    const w = was.get(p.id)
    const now = tabOf(p)
    if (w && w !== now) moved[now] = (moved[now] ?? 0) + 1
  }
  const parts: string[] = []
  if (added) parts.push(`${added} new ${added === 1 ? "paper" : "papers"}`)
  if (moved.paid) parts.push(`${moved.paid} now paid`)
  if (moved.progress) parts.push(`${moved.progress} now in progress`)
  if (moved.unclaimed) parts.push(`${moved.unclaimed} ready to file`)
  if (moved.ineligible) parts.push(`${moved.ineligible} no longer eligible`)
  return parts.length ? parts.join(", ") : "nothing new"
}

export function Papers() {
  const [params, setParams] = useSearchParams()
  const qc = useQueryClient()
  const nav = useNavigate()
  const status = params.get("status")
  const tab = ((params.get("tab") ?? params.get("filter") ?? "all") as Tab) || "all"
  const year = params.get("year") ?? ""
  const q = params.get("q") ?? ""
  const quartile = params.get("quartile") ?? ""
  const type = params.get("type") ?? ""
  const role = params.get("role") ?? ""
  const sort = params.get("sort") ?? "year"
  const [hidden, setHidden] = useState<Set<string>>(new Set())
  const [fresh, setFresh] = useState<Set<string>>(new Set())
  const [disputing, setDisputing] = useState<RecordPaper | null>(null)
  const [pulling, setPulling] = useState(false)
  const [pulled, setPulled] = useState<string | null>(null)
  const [showFilters, setShowFilters] = useState(false)

  const query = useApi<Payload>(["me-publications", sort], `/api/me/publications?sort=${sort}`)

  function set(key: string, value: string) {
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        if (value && !(key === "tab" && value === "all") && !(key === "sort" && value === "year")) next.set(key, value)
        else next.delete(key)
        if (key === "tab") next.delete("filter")
        return next
      },
      { replace: true }
    )
  }
  function clearFilters() {
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        for (const k of ["year", "quartile", "type", "role", "sort", "q"]) next.delete(k)
        return next
      },
      { replace: true }
    )
  }

  const all = query.data?.publications ?? []
  const counts = useMemo(() => {
    const c: Record<Tab, number> = { all: all.length, unclaimed: 0, progress: 0, paid: 0, ineligible: 0 }
    for (const p of all) c[tabOf(p)]++
    return c
  }, [all])
  const years = useMemo(
    () => ([...new Set(all.map((p) => p.year).filter(Boolean))] as number[]).sort((a, b) => b - a),
    [all]
  )
  const types = useMemo(() => [...new Set(all.map((p) => p.type).filter(Boolean))] as string[], [all])

  const needle = q.trim().toLowerCase()
  const rows = all.filter(
    (p) =>
      (tab === "all" || tabOf(p) === tab) &&
      (!year || String(p.year) === year) &&
      (!quartile || (quartile === "none" ? !p.quartile : p.quartile === quartile)) &&
      (!type || p.type === type) &&
      (!role || (role === "first" ? p.author_position === 1 : p.author_position !== 1)) &&
      (!needle ||
        p.title.toLowerCase().includes(needle) ||
        (p.venue ?? "").toLowerCase().includes(needle) ||
        p.authors.some((a) => a.name.toLowerCase().includes(needle)))
  )
  const groups = useMemo(() => {
    const g = new Map<string, RecordPaper[]>()
    for (const p of rows) {
      const k = sort === "year" || sort === "oldest" ? String(p.year ?? "Undated") : "all"
      g.set(k, [...(g.get(k) ?? []), p])
    }
    return [...g]
  }, [rows, sort])

  if (status) return <Navigate to={`/papers/claims?status=${encodeURIComponent(status)}`} replace />

  const active: { key: string; label: string }[] = [
    year && { key: "year", label: year },
    quartile && { key: "quartile", label: quartile === "none" ? "No quartile" : quartile },
    type && { key: "type", label: type.replace(/-/g, " ") },
    role && { key: "role", label: role === "first" ? "First author" : "Co-author" },
    sort !== "year" && { key: "sort", label: SORT_LABEL[sort] ?? sort },
  ].filter(Boolean) as { key: string; label: string }[]

  async function pull() {
    setPulling(true)
    setPulled(null)
    try {
      const before = all
      await api("/api/me/scopus-pull")
      const next = await qc.fetchQuery<Payload>({
        queryKey: ["me-publications", sort],
        queryFn: () => api<Payload>(`/api/me/publications?sort=${sort}`),
      })
      const was = new Set(before.map((p) => p.id))
      setFresh(new Set(next.publications.filter((p) => !was.has(p.id)).map((p) => p.id)))
      const said = describeChange(before, next.publications)
      setPulled(said)
      toast.ok(said === "nothing new" ? "Pulled from Scopus: nothing new." : `Pulled from Scopus: ${said}.`)
    } catch (e) {
      toast.fail(e)
    } finally {
      setPulling(false)
    }
  }

  async function dispute(p: RecordPaper) {
    await api(`/api/me/publications/${p.id}/dispute`, { method: "POST", json: { reason: "not_mine" } })
    setHidden((h) => new Set(h).add(p.id))
    toast.ok("Reported as not mine.")
  }

  const m = query.data?.metrics
  const sentence = query.data
    ? `${query.data.count} ${query.data.count === 1 ? "paper" : "papers"} on your record, ${m?.total_citations ?? 0} citations${
        m?.first_year ? `, since ${m.first_year}` : ""
      }.`
    : query.isError
      ? "Your record could not be loaded."
      : "Loading your record."

  return (
    <div className="page space-y-6 pb-24 sm:pb-6" data-area="record">
      <HeroBand
        spot="spot-my-papers"
        area="record"
        title="My papers"
        sentence={sentence}
        actions={
          <>
            <Button onClick={() => void pull()} disabled={pulling}>
              <CloudDownload />
              {pulling ? "Pulling…" : "Pull from Scopus"}
            </Button>
            <Button kind="primary" asChild className="max-sm:hidden">
              <Link to="/papers/new">
                <FilePlusCorner />
                File a paper
              </Link>
            </Button>
            <Button kind="quiet" asChild>
              <Link to="/papers/appraisal">
                <FileText />
                List for appraisal
              </Link>
            </Button>
            <Button kind="quiet" asChild>
              <Link to="/papers/statement">
                <IndianRupee />
                Payment statement
              </Link>
            </Button>
          </>
        }
      >
        {all.length > 0 && (
          <YearBars papers={all} selected={year} onSelect={(y) => set("year", y === year ? "" : y)} />
        )}
      </HeroBand>

      {pulled && (
        <p role="status" className="flex items-center gap-2 text-sm text-fg-muted">
          <CloudDownload aria-hidden className="size-4 text-(--area)" strokeWidth={1.75} />
          Checked Scopus just now: {pulled}.
          <button
            type="button"
            onClick={() => setPulled(null)}
            aria-label="Dismiss"
            className="rounded p-1 hover:bg-hover focus-visible:ring-2 focus-visible:ring-accent outline-none"
          >
            <X className="size-3.5" />
          </button>
        </p>
      )}

      {query.isError ? (
        <ErrorState
          title="Could not load your papers."
          message="The server did not answer. Nothing has been lost."
          onRetry={() => void query.refetch()}
        />
      ) : query.isLoading ? (
        <SkeletonRows rows={6} />
      ) : all.length === 0 ? (
        <EmptyState
          illustration="empty-no-papers"
          title="Your record will build itself"
          message="Once we match you to your Scopus profile, every paper you have published appears here. You will not have to type them in."
          action={
            <div className="flex flex-wrap justify-center gap-2">
              <Button asChild kind="primary">
                <Link to="/me">Connect my Scopus profile</Link>
              </Button>
              <Button asChild>
                <Link to="/papers/new?method=doi">Paste a DOI instead</Link>
              </Button>
            </div>
          }
        />
      ) : (
        <>
          <div className="space-y-3">
            <div
              role="group"
              aria-label="Claim state"
              className="-mx-4 flex overflow-x-auto px-4 sm:mx-0 sm:px-0"
            >
              <div className="inline-flex shrink-0 gap-0.5 rounded-lg bg-sunken p-0.5">
                {TABS.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    aria-pressed={tab === t.id}
                    onClick={() => set("tab", t.id)}
                    className={cn(
                      "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-accent",
                      tab === t.id
                        ? "bg-surface font-medium text-fg shadow-[0_0_0_1px_var(--color-line)]"
                        : "text-fg-muted hover:text-fg"
                    )}
                  >
                    {t.label}
                    <span className={cn("tabular-nums", tab === t.id ? "text-fg-muted" : "text-fg-subtle")}>
                      {counts[t.id]}
                    </span>
                  </button>
                ))}
              </div>
            </div>

            <div className="flex items-center gap-2">
              <label className="relative min-w-0 flex-1 sm:max-w-72">
                <span className="sr-only">Search in my papers</span>
                <Search aria-hidden className="pointer-events-none absolute top-2.5 left-2.5 size-4 text-fg-subtle" />
                <Input
                  value={q}
                  onChange={(e) => set("q", e.target.value)}
                  placeholder="Search title, journal or co-author"
                  className="pl-8"
                />
              </label>
              <Button
                kind="quiet"
                aria-expanded={showFilters}
                aria-controls="paper-filters"
                onClick={() => setShowFilters((s) => !s)}
              >
                <SlidersHorizontal />
                Filters{active.length > 0 && <span className="tabular-nums text-fg-muted">{active.length}</span>}
              </Button>
              <Menu>
                <MenuTrigger asChild>
                  <Button kind="quiet" aria-label="More: export and claims">
                    <MoreHorizontal />
                  </Button>
                </MenuTrigger>
                <MenuContent align="end">
                  <MenuLabel>Download what is shown</MenuLabel>
                  <MenuItem onSelect={() => download("my-papers.csv", toCsv(rows), "text/csv")}>
                    Download as spreadsheet (CSV)
                  </MenuItem>
                  <MenuItem onSelect={() => download("my-papers.bib", toBibtex(rows), "application/x-bibtex")}>
                    Download as BibTeX
                  </MenuItem>
                  <MenuSeparator />
                  <MenuLabel>For appraisal and tax</MenuLabel>
                  <MenuItem onSelect={() => nav("/papers/appraisal")}>Publication list for appraisal (PDF or spreadsheet)</MenuItem>
                  <MenuItem onSelect={() => nav("/papers/statement")}>My payment statement</MenuItem>
                  <MenuSeparator />
                  <MenuItem onSelect={() => nav("/papers/claims")}>All my claims, drafts included</MenuItem>
                </MenuContent>
              </Menu>
            </div>

            {showFilters && (
              <div id="paper-filters" className="grid grid-cols-2 gap-2 sm:grid-cols-5">
                <select aria-label="Year" className={selectClass} value={year} onChange={(e) => set("year", e.target.value)}>
                  <option value="">Any year</option>
                  {years.map((y) => (
                    <option key={y} value={y}>
                      {y}
                    </option>
                  ))}
                </select>
                <select aria-label="Quartile" className={selectClass} value={quartile} onChange={(e) => set("quartile", e.target.value)}>
                  <option value="">Any quartile</option>
                  {["Q1", "Q2", "Q3", "Q4"].map((x) => (
                    <option key={x}>{x}</option>
                  ))}
                  <option value="none">No quartile</option>
                </select>
                <select aria-label="Type" className={selectClass} value={type} onChange={(e) => set("type", e.target.value)}>
                  <option value="">Any type</option>
                  {types.map((t) => (
                    <option key={t} value={t}>
                      {t.replace(/-/g, " ")}
                    </option>
                  ))}
                </select>
                <select aria-label="Author role" className={selectClass} value={role} onChange={(e) => set("role", e.target.value)}>
                  <option value="">First or co-author</option>
                  <option value="first">First author</option>
                  <option value="co">Co-author</option>
                </select>
                <select aria-label="Sort" className={selectClass} value={sort} onChange={(e) => set("sort", e.target.value)}>
                  {Object.entries(SORT_LABEL).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {active.length > 0 && (
              <div className="flex flex-wrap items-center gap-2 text-sm">
                {active.map((f) => (
                  <button
                    key={f.key}
                    type="button"
                    onClick={() => set(f.key, "")}
                    aria-label={`Remove filter ${f.label}`}
                    className="inline-flex h-7 items-center gap-1 rounded-full bg-(--area-wash) px-2.5 text-(--area) outline-none focus-visible:ring-2 focus-visible:ring-accent"
                  >
                    {f.label}
                    <X aria-hidden className="size-3.5" />
                  </button>
                ))}
                <button
                  type="button"
                  onClick={clearFilters}
                  className="rounded px-1 text-fg-muted underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-accent"
                >
                  Clear filters
                </button>
              </div>
            )}
          </div>

          {rows.length === 0 ? (
            tab === "unclaimed" && counts.unclaimed === 0 ? (
              <EmptyState
                illustration="empty-no-papers"
                title="Every eligible paper is filed"
                message="Nothing is waiting to be claimed. New papers appear here after a Scopus pull."
                action={
                  <Button onClick={() => void pull()} disabled={pulling}>
                    <CloudDownload />
                    Pull from Scopus
                  </Button>
                }
              />
            ) : (
              <EmptyState
                art="no-results"
                title={tab === "ineligible" && counts.ineligible === 0 ? "Every paper can be claimed" : "No papers match"}
                message={tab === "ineligible" && counts.ineligible === 0 ? "None of your papers has too many authors for the scheme." : "Try another tab, or clear the filters and search."}
                action={
                  <Button
                    onClick={() => {
                      clearFilters()
                      set("tab", "all")
                    }}
                  >
                    Clear filters
                  </Button>
                }
              />
            )
          ) : (
            <div className="space-y-6">
              {groups.map(([label, list]) => (
                <section key={label} aria-label={label === "all" ? "Papers" : `${label}, ${list.length} papers`}>
                  {label !== "all" && (
                    <h2 className="sticky top-0 z-10 flex items-center gap-3 bg-bg/95 py-2 text-sm font-semibold text-fg backdrop-blur">
                      {label}
                      <span aria-hidden className="h-px flex-1 bg-line" />
                      <span className="font-normal text-fg-muted">
                        {list.length} {list.length === 1 ? "paper" : "papers"}
                      </span>
                    </h2>
                  )}
                  <div className="panel divide-y divide-line overflow-hidden p-0">
                    {list.map((p) => (
                      <RecordCard
                        key={p.id}
                        paper={p}
                        me={query.data!.user.id}
                        showMoney={tab === "paid"}
                        isNew={fresh.has(p.id)}
                        hidden={hidden.has(p.id)}
                        onUndo={() =>
                          setHidden((h) => {
                            const n = new Set(h)
                            n.delete(p.id)
                            return n
                          })
                        }
                        onDispute={() => setDisputing(p)}
                      />
                    ))}
                  </div>
                </section>
              ))}
            </div>
          )}

          <p className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-fg-muted">
            <span>
              A paper is missing?{" "}
              <Link to="/papers/new?method=doi" className="inline-flex items-center gap-1 text-(--area) hover:underline">
                <ClipboardPaste aria-hidden className="size-4" strokeWidth={1.75} />
                Paste its DOI
              </Link>
            </span>
          </p>
        </>
      )}

      <div className="fixed inset-x-0 bottom-0 z-20 border-t border-line bg-bg/95 p-3 backdrop-blur sm:hidden">
        <Button kind="primary" asChild className="w-full">
          <Link to="/papers/new">
            <FilePlusCorner />
            File a paper
          </Link>
        </Button>
      </div>

      <ConfirmDialog
        open={disputing != null}
        onOpenChange={(o) => !o && setDisputing(null)}
        title="Not your paper?"
        description={`"${disputing?.title ?? ""}" will be hidden and reported to the research cell to take off your record.`}
        confirmLabel="Report as not mine"
        onConfirm={async () => {
          if (disputing) await dispute(disputing)
        }}
      />
    </div>
  )
}

/**
 * Papers per year, one labelled bar each, shaded by what happened to them:
 * paid, in progress, not yet claimed, not eligible. Clicking a year filters.
 */
function YearBars({
  papers,
  selected,
  onSelect,
}: {
  papers: RecordPaper[]
  selected: string
  onSelect: (year: string) => void
}) {
  const byYear = new Map<number, Record<Exclude<Tab, "all">, number>>()
  for (const p of papers) {
    if (!p.year) continue
    const r = byYear.get(p.year) ?? { paid: 0, progress: 0, unclaimed: 0, ineligible: 0 }
    r[tabOf(p)]++
    byYear.set(p.year, r)
  }
  const ys = [...byYear.keys()].sort((a, b) => a - b)
  if (ys.length === 0) return null
  const last = new Date().getFullYear()
  const first = Math.max(ys[0], last - 9)
  const span = Array.from({ length: last - first + 1 }, (_, i) => first + i)
  const max = Math.max(1, ...span.map((y) => sum(byYear.get(y))))
  const SEG = [
    { k: "paid", cls: "bg-positive", label: "Paid" },
    { k: "progress", cls: "bg-caution", label: "In progress" },
    { k: "unclaimed", cls: "bg-(--area)", label: "Not claimed" },
    { k: "ineligible", cls: "bg-line", label: "Not eligible" },
  ] as const
  return (
    <figure className="mt-5">
      <figcaption className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-fg-muted">
        <span className="font-medium text-fg">Papers per year</span>
        {SEG.map((s) => (
          <span key={s.k} className="inline-flex items-center gap-1.5">
            <span aria-hidden className={cn("size-2.5 rounded-sm", s.cls)} />
            {s.label}
          </span>
        ))}
      </figcaption>
      <div className="flex h-28 items-end gap-1.5 sm:gap-2">
        {span.map((y) => {
          const r = byYear.get(y)
          const n = sum(r)
          const on = selected === String(y)
          return (
            <button
              key={y}
              type="button"
              aria-pressed={on}
              disabled={n === 0}
              onClick={() => onSelect(String(y))}
              aria-label={`${y}: ${n} ${n === 1 ? "paper" : "papers"}${
                r ? `, ${r.paid} paid, ${r.progress} in progress, ${r.unclaimed} not claimed` : ""
              }. ${on ? "Show all years" : "Show only this year"}`}
              className={cn(
                "group flex h-full min-w-0 flex-1 flex-col items-center justify-end gap-1 rounded-md px-0.5 pt-1 outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-default",
                on ? "bg-(--area-wash)" : "enabled:hover:bg-hover",
                selected && !on && "opacity-50"
              )}
            >
              <span className="text-xs tabular-nums text-fg-muted">{n || ""}</span>
              <span
                className="flex w-full max-w-8 flex-col-reverse overflow-hidden rounded-sm"
                style={{ height: `${(n / max) * 64}px` }}
              >
                {r &&
                  SEG.map((s) =>
                    r[s.k] ? <span key={s.k} className={s.cls} style={{ flexGrow: r[s.k] }} /> : null
                  )}
              </span>
              <span className={cn("text-xs tabular-nums", on ? "font-semibold text-fg" : "text-fg-muted")}>
                {span.length > 6 ? `'${String(y).slice(2)}` : y}
              </span>
            </button>
          )
        })}
      </div>
    </figure>
  )
}

function sum(r?: Record<string, number>) {
  return r ? Object.values(r).reduce((a, b) => a + b, 0) : 0
}

/** "2025-03" -> "Mar 2025". */
function monthName(ym: string): string {
  const [y, m] = ym.split("-").map(Number)
  return y && m ? new Date(y, m - 1, 1).toLocaleDateString("en-IN", { month: "short", year: "numeric" }) : ym
}

function coAuthors(p: RecordPaper, me: string) {
  const others = p.authors.filter((a) => a.user_id !== me)
  const college = others.filter((a) => a.is_college)
  const external = others.length - college.length
  if (others.length === 0) return <span>Sole author</span>
  return (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
      {college.length > 0 && (
        <span aria-hidden className="flex -space-x-1.5">
          {college.slice(0, 4).map((a, i) => (
            <Avatar
              key={i}
              size="xs"
              person={{ name: a.name, initials: a.initials ?? initialsOf(a.name), photo_url: a.photo_url ?? null }}
              className="ring-2 ring-bg"
            />
          ))}
        </span>
      )}
      <span>
        {college.length > 0 && "With "}
        {college.map((a, i) => (
          <span key={i}>
            {i > 0 && (i === college.length - 1 && external === 0 ? " and " : ", ")}
            {a.user_id ? (
              <Link to={`/u/${a.user_id}`} className="text-fg hover:underline hover:underline-offset-4">
                {a.name}
              </Link>
            ) : (
              <span className="text-fg">{a.name}</span>
            )}
          </span>
        ))}
        {external > 0 && (
          <span>
            {college.length > 0
              ? ` and ${external} from outside`
              : `${external} ${external === 1 ? "co-author" : "co-authors"} from outside the college`}
          </span>
        )}
      </span>
    </span>
  )
}

function RecordCard({
  paper: p,
  me,
  showMoney,
  isNew,
  hidden,
  onUndo,
  onDispute,
}: {
  paper: RecordPaper
  me: string
  showMoney: boolean
  isNew: boolean
  hidden: boolean
  onUndo: () => void
  onDispute: () => void
}) {
  if (hidden)
    return (
      <div className="flex items-center justify-between gap-3 px-4 py-3">
        <span className="line-clamp-1 text-sm text-fg-muted">Reported as not yours: {p.title}</span>
        <Button kind="quiet" size="sm" onClick={onUndo}>
          Undo
        </Button>
      </div>
    )
  const state = tabOf(p)
  const stage = p.claim ? stageOf(p.claim.stage) : null
  const paid = p.claim?.stage === "PAID"
  const open = p.doi ? `https://doi.org/${p.doi}` : p.openalex_id ? `https://openalex.org/${p.openalex_id}` : null
  const paidLabel = `Paid${p.claim?.paid_month ? ` ${monthName(p.claim.paid_month)}` : ""}`
  return (
    <PaperCard
      title={p.title}
      to={p.claim?.id ? `/papers/${p.claim.id}` : undefined}
      journal={p.venue}
      year={p.year}
      quartile={p.quartile}
      citations={p.citations}
      position={p.author_position ? { index: p.author_position, of: p.total_authors } : null}
      authorLine={
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {p.author_position && (
            <span className="inline-flex items-center gap-1">
              {p.author_position === 1 && <PenLine aria-hidden className="size-4" strokeWidth={1.75} />}
              {p.author_position === 1 ? "First author" : `Author ${p.author_position}`} of {p.total_authors}
            </span>
          )}
          {coAuthors(p, me)}
        </span>
      }
      claim={state === "unclaimed" ? { unclaimed: true, fileTo: `/papers/new?publication=${p.id}` } : undefined}
      picture={topicPicture(p.title, p.venue)}
      className="!rounded-none !border-0 !bg-transparent !shadow-none !ring-0"
      actions={
        <Menu>
          <MenuTrigger asChild>
            <Button kind="quiet" size="sm" aria-label={`More for ${p.title}`}>
              <MoreHorizontal />
            </Button>
          </MenuTrigger>
          <MenuContent align="end">
            {open && (
              <MenuItem onSelect={() => window.open(open, "_blank", "noopener")}>
                {p.doi ? "Open the paper" : "Open on OpenAlex"}
              </MenuItem>
            )}
            {p.doi && (
              <MenuItem
                onSelect={() => {
                  void navigator.clipboard?.writeText(p.doi!)
                  toast.ok("DOI copied.")
                }}
              >
                Copy DOI
              </MenuItem>
            )}
            {(open || p.doi) && <MenuSeparator />}
            <MenuItem onSelect={onDispute}>Not my paper</MenuItem>
          </MenuContent>
        </Menu>
      }
    >
      {(isNew || stage || state === "ineligible") && (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
          {isNew && <Chip tone="area">New from Scopus</Chip>}
          {paid && !p.claim?.id && (
            <Chip tone="positive" icon={IndianRupee}>
              {paidLabel}
            </Chip>
          )}
          {stage && p.claim?.id && (
            <Link
              to={`/papers/${p.claim.id}`}
              className="inline-flex items-center gap-2 rounded-md outline-none hover:underline focus-visible:ring-2 focus-visible:ring-accent"
            >
              <Chip tone={paid ? "positive" : "area"} icon={paid ? IndianRupee : Hourglass}>
                {paid ? paidLabel : stage.label}
                {!paid && p.claim.days_waiting != null && `, ${p.claim.days_waiting} days`}
              </Chip>
              <span className="text-(--area)">View claim</span>
            </Link>
          )}
          {showMoney && !!p.claim?.amount && (
            <span className="font-medium tabular-nums text-fg">{money(p.claim.amount)} to you</span>
          )}
          {state === "ineligible" && (
            <span className="text-fg-muted">
              Not eligible for a claim: {p.total_authors} authors listed, and the scheme pays up to{" "}
              {maxAuthors(p.ineligible_reason) ?? "a limited number of"} authors.
            </span>
          )}
        </div>
      )}
    </PaperCard>
  )
}

/** "More than 10 authors" -> 10. */
export function maxAuthors(reason: string | null): number | null {
  const m = reason?.match(/(\d+)/)
  return m ? Number(m[1]) : null
}
