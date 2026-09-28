import { useMemo, useState } from "react"
import { Link, Navigate, useSearchParams } from "react-router-dom"
import {
  CloudDownload,
  ClipboardPaste,
  Download,
  FilePlusCorner,
  Hourglass,
  IndianRupee,
  LayoutGrid,
  List,
  MoreHorizontal,
  PenLine,
  Search,
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
import { filterBar } from "@/ui/filter-bar"
import { HeroBand } from "@/ui/hero"
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/ui/menu"
import { money, stageOf } from "@/ui/paper"
import { RecordStrip, type StripMonth } from "@/ui/record-strip"
import { EmptyState, ErrorState, SkeletonRows } from "@/ui/state"
import { TableScroller } from "@/ui/table"
import { toast } from "@/ui/toast"

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
  author_position: number | null
  total_authors: number
  match_confidence: number | null
  authors: RecordAuthor[]
  claim: { id: string; stage: string; days_waiting: number | null; amount?: number | null } | null
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

const SOURCE_LABEL: Record<string, string> = {
  openalex: "OpenAlex",
  scopus_sheet: "Scopus",
  record: "ERP",
  claim: "Claims & ledger",
}

const VIEW_KEY = "papers.view"

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
  "h-9 rounded-md bg-surface px-2 text-sm text-fg ring-1 ring-inset ring-field focus-visible:ring-2 focus-visible:ring-accent outline-none"

export function Papers() {
  const [params, setParams] = useSearchParams()
  const qc = useQueryClient()
  const status = params.get("status")
  const tab = ((params.get("tab") ?? (params.get("filter") === "unclaimed" ? "unclaimed" : "all")) as Tab) || "all"
  const year = params.get("year") ?? ""
  const q = params.get("q") ?? ""
  const quartile = params.get("quartile") ?? ""
  const type = params.get("type") ?? ""
  const role = params.get("role") ?? ""
  const sort = params.get("sort") ?? "year"
  const [view, setViewState] = useState<"cards" | "table">(() =>
    typeof localStorage !== "undefined" && localStorage.getItem(VIEW_KEY) === "table" ? "table" : "cards"
  )
  const [hidden, setHidden] = useState<Set<string>>(new Set())
  const [fresh, setFresh] = useState<Set<string>>(new Set())
  const [disputing, setDisputing] = useState<RecordPaper | null>(null)
  const [pulling, setPulling] = useState(false)

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
  function setView(v: "cards" | "table") {
    setViewState(v)
    try {
      localStorage.setItem(VIEW_KEY, v)
    } catch {
      /* private mode */
    }
  }

  const all = query.data?.publications ?? []
  const counts = useMemo(() => {
    const c: Record<Tab, number> = { all: all.length, unclaimed: 0, progress: 0, paid: 0, ineligible: 0 }
    for (const p of all) c[tabOf(p)]++
    return c
  }, [all])
  const years = useMemo(() => [...new Set(all.map((p) => p.year).filter(Boolean))] as number[], [all])
  const types = useMemo(() => [...new Set(all.map((p) => p.type).filter(Boolean))] as string[], [all])
  const strip: StripMonth[] = useMemo(() => {
    const m = new Map<string, number>()
    for (const p of all) {
      const key = p.date?.slice(0, 7) ?? (p.year ? `${p.year}-01` : null)
      if (key) m.set(key, (m.get(key) ?? 0) + 1)
    }
    return [...m].map(([month, papers]) => ({ month, papers }))
  }, [all])
  const sources = useMemo(() => {
    const c = new Map<string, number>()
    for (const p of all) {
      const label = SOURCE_LABEL[p.source ?? ""] ?? p.source
      if (label) c.set(label, (c.get(label) ?? 0) + 1)
    }
    return [...c]
  }, [all])

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

  async function pull() {
    setPulling(true)
    toast.info("Checking Scopus for new papers…")
    try {
      const before = new Set(all.map((p) => p.id))
      await api("/api/me/scopus-pull")
      const next = await qc.fetchQuery<Payload>({
        queryKey: ["me-publications", sort],
        queryFn: () => api<Payload>(`/api/me/publications?sort=${sort}`),
      })
      const added = next.publications.filter((p) => !before.has(p.id)).map((p) => p.id)
      setFresh(new Set(added))
      toast.ok(added.length ? `Found ${added.length} new ${added.length === 1 ? "paper" : "papers"}.` : "No new papers found.")
    } catch (e) {
      toast.fail(e)
    } finally {
      setPulling(false)
    }
  }

  async function dispute(p: RecordPaper) {
    await api(`/api/me/publications/${p.id}/dispute`, { method: "POST", json: { reason: "not_mine" } })
    setHidden((h) => new Set(h).add(p.id))
  }

  const m = query.data?.metrics
  const sentence = query.data
    ? `${query.data.count} ${query.data.count === 1 ? "paper" : "papers"} on your record · ${m?.total_citations ?? 0} citations${
        m?.first_year ? ` · since ${m.first_year}` : ""
      }`
    : query.isError
      ? "Your record could not be loaded."
      : "Loading your record…"

  return (
    <div className="page space-y-6 pb-24 sm:pb-6" data-area="record">
      <HeroBand
        area="record"
        title="My papers"
        sentence={sentence}
        actions={
          <>
            <Button onClick={() => void pull()} disabled={pulling}>
              <CloudDownload />
              {pulling ? "Checking…" : "Pull from Scopus"}
            </Button>
            <Button kind="primary" asChild className="max-sm:hidden">
              <Link to="/papers/new">
                <FilePlusCorner />
                File a paper
              </Link>
            </Button>
          </>
        }
      >
        {all.length > 0 && (
          <div className="mt-5 space-y-3">
            <RecordStrip
              data={strip}
              variant="compact"
              years={Math.min(10, Math.max(3, new Date().getFullYear() - (m?.first_year ?? 2020) + 1))}
              onSelect={(month) => set("year", month.slice(0, 4))}
              label="Your papers by month"
              className="max-w-full overflow-x-auto"
            />
            <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-fg-muted">
              <span>Sources:</span>
              {sources.map(([s, n]) => (
                <span key={s} className="inline-flex items-center gap-1">
                  <span aria-hidden className="size-2 rounded-full bg-(--area-fill)" />
                  {s} {n}
                </span>
              ))}
              <details className="inline">
                <summary className="cursor-pointer text-(--area) underline-offset-4 hover:underline">What's this?</summary>
                <span className="mt-1 block max-w-prose">
                  We build your record from Scopus, OpenAlex and the college's ERP. A paper appears once any one of
                  them lists you as an author. If something is wrong, report it on the paper.
                </span>
              </details>
            </p>
          </div>
        )}
      </HeroBand>

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
          art="nothing-filed"
          title="Your record will build itself"
          message="Once we match you to your Scopus profile, every paper you've published appears here — you won't have to type them in."
          action={
            <div className="flex flex-wrap justify-center gap-2">
              <Button asChild kind="primary">
                <Link to="/profile">Connect my Scopus profile</Link>
              </Button>
              <Button asChild>
                <Link to="/papers/new?method=doi">Paste a DOI instead</Link>
              </Button>
            </div>
          }
        />
      ) : (
        <>
          <div
            role="group"
            aria-label="Claim state"
            className="-mx-4 flex gap-1 overflow-x-auto px-4 sm:mx-0 sm:px-0"
          >
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                aria-pressed={tab === t.id}
                onClick={() => set("tab", t.id)}
                className={cn(
                  "inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full px-3 text-sm font-medium",
                  tab === t.id
                    ? "bg-(--area-wash) text-(--area) shadow-[inset_0_0_0_1px_var(--area-line)]"
                    : "text-fg-muted hover:bg-hover"
                )}
              >
                {t.label}
                <span className="tabular-nums">{counts[t.id]}</span>
                {t.id === "unclaimed" && counts.unclaimed > 0 && (
                  <span aria-hidden className="size-2 rounded-full bg-area-honours-fill" />
                )}
              </button>
            ))}
          </div>

          <div className={filterBar}>
            <label className="relative sm:w-64">
              <span className="sr-only">Search in my papers</span>
              <Search aria-hidden className="pointer-events-none absolute top-2.5 left-2.5 size-4 text-fg-subtle" />
              <Input
                value={q}
                onChange={(e) => set("q", e.target.value)}
                placeholder="Search in my papers"
                className="pl-8"
              />
            </label>
            <select aria-label="Year" className={selectClass} value={year} onChange={(e) => set("year", e.target.value)}>
              <option value="">Any year</option>
              {years.map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </select>
            <select
              aria-label="Quartile"
              className={selectClass}
              value={quartile}
              onChange={(e) => set("quartile", e.target.value)}
            >
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
            <select aria-label="Role" className={selectClass} value={role} onChange={(e) => set("role", e.target.value)}>
              <option value="">First or co-author</option>
              <option value="first">First author</option>
              <option value="co">Co-author</option>
            </select>
            <select aria-label="Sort" className={selectClass} value={sort} onChange={(e) => set("sort", e.target.value)}>
              <option value="year">Newest first</option>
              <option value="oldest">Oldest first</option>
              <option value="citations">Most cited</option>
              <option value="title">Title A–Z</option>
            </select>
            <div className="flex items-center gap-2 sm:ml-auto">
              <div role="group" aria-label="View" className="flex rounded-md ring-1 ring-edge ring-inset max-sm:hidden">
                <Button
                  kind="quiet"
                  size="sm"
                  aria-pressed={view === "cards"}
                  aria-label="Cards"
                  className={cn(view === "cards" && "bg-hover text-fg")}
                  onClick={() => setView("cards")}
                >
                  <LayoutGrid />
                </Button>
                <Button
                  kind="quiet"
                  size="sm"
                  aria-pressed={view === "table"}
                  aria-label="Table"
                  className={cn(view === "table" && "bg-hover text-fg")}
                  onClick={() => setView("table")}
                >
                  <List />
                </Button>
              </div>
              <Menu>
                <MenuTrigger asChild>
                  <Button kind="quiet" size="sm">
                    <Download />
                    Export
                  </Button>
                </MenuTrigger>
                <MenuContent align="end">
                  <MenuItem onSelect={() => download("my-papers.csv", toCsv(rows), "text/csv")}>CSV</MenuItem>
                  <MenuItem onSelect={() => download("my-papers.bib", toBibtex(rows), "application/x-bibtex")}>
                    BibTeX
                  </MenuItem>
                </MenuContent>
              </Menu>
            </div>
          </div>

          {rows.length === 0 ? (
            <EmptyState
              title={tab === "unclaimed" && counts.unclaimed === 0 ? "Every paper on your record is claimed. ✓" : "No papers match"}
              message={tab === "unclaimed" && counts.unclaimed === 0 ? "Nothing waiting to be filed." : "Try a different filter or search."}
            />
          ) : view === "table" ? (
            <PapersTable rows={rows} showMoney={tab === "paid"} />
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
                  <div className="space-y-3">
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
            <Link to="/papers/claims" className="text-(--area) hover:underline">
              All my claims, drafts included
            </Link>
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

function coAuthors(p: RecordPaper, me: string) {
  const others = p.authors.filter((a) => a.user_id !== me)
  const college = others.filter((a) => a.is_college)
  const external = others.length - college.length
  if (others.length === 0) return null
  return (
    <span>
      With:{" "}
      {college.map((a, i) => (
        <span key={i}>
          {i > 0 && " · "}
          {a.user_id ? (
            <Link to={`/u/${a.user_id}`} className="text-fg hover:underline hover:underline-offset-4">
              {a.name}
            </Link>
          ) : (
            a.name
          )}
          <span className="text-fg-subtle"> (Saveetha)</span>
        </span>
      ))}
      {external > 0 && (
        <span className="text-fg-subtle">
          {college.length > 0 && " · "}
          {college.length > 0 ? `+${external} external` : `${external} external ${external === 1 ? "co-author" : "co-authors"}`}
        </span>
      )}
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
      <div className="panel flex items-center justify-between gap-3 p-4 opacity-40 hover:opacity-100">
        <span className="line-clamp-1 text-sm text-fg-muted">Hidden — reported as not yours · {p.title}</span>
        <Button kind="quiet" size="sm" onClick={onUndo}>
          Undo
        </Button>
      </div>
    )
  const state = tabOf(p)
  const stage = p.claim ? stageOf(p.claim.stage) : null
  const open = p.doi ? `https://doi.org/${p.doi}` : p.openalex_id ? `https://openalex.org/${p.openalex_id}` : null
  return (
    <PaperCard
      title={p.title}
      journal={p.venue}
      year={p.year}
      quartile={p.quartile}
      citations={p.citations}
      position={p.author_position ? { index: p.author_position, of: p.total_authors } : null}
      authorLine={
        <span className="flex flex-wrap gap-x-2">
          {p.author_position && (
            <span className="inline-flex items-center gap-1">
              {p.author_position === 1 && <PenLine aria-hidden className="size-4" strokeWidth={1.75} />}
              author {p.author_position} of {p.total_authors}
            </span>
          )}
          {coAuthors(p, me)}
        </span>
      }
      claim={state === "unclaimed" ? { unclaimed: true, fileTo: `/papers/new?publication=${p.id}` } : undefined}
      className={cn(state === "unclaimed" && "shadow-[inset_3px_0_0_var(--color-area-honours-fill)]")}
      actions={
        <Menu>
          <MenuTrigger asChild>
            <Button kind="quiet" size="sm" aria-label={`More for ${p.title}`}>
              <MoreHorizontal />
            </Button>
          </MenuTrigger>
          <MenuContent align="end">
            <MenuItem onSelect={onDispute}>Not my paper</MenuItem>
            {p.doi && (
              <MenuItem
                onSelect={() => {
                  void navigator.clipboard?.writeText(p.doi!)
                  toast.ok("DOI copied")
                }}
              >
                Copy DOI
              </MenuItem>
            )}
            {open && (
              <>
                <MenuSeparator />
                <MenuItem onSelect={() => window.open(open, "_blank", "noopener")}>
                  {p.doi ? "Open the paper" : "Open on OpenAlex"}
                </MenuItem>
              </>
            )}
          </MenuContent>
        </Menu>
      }
    >
      <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
        {isNew && <Chip tone="area">New</Chip>}
        {stage && p.claim && (
          <Link to={`/papers/${p.claim.id}`} className="inline-flex items-center gap-2 hover:underline">
            <Chip tone={p.claim.stage === "PAID" ? "positive" : "area"} icon={p.claim.stage === "PAID" ? IndianRupee : Hourglass}>
              {stage.label}
              {p.claim.days_waiting != null && ` · ${p.claim.days_waiting} days`}
            </Chip>
            <span className="text-(--area)">View claim</span>
          </Link>
        )}
        {showMoney && p.claim?.amount != null && (
          <span className="font-medium tabular-nums text-fg">{money(p.claim.amount)}</span>
        )}
        {state === "unclaimed" && <span className="text-fg-muted">Not claimed yet · eligible ✓</span>}
        {state === "ineligible" && (
          <Chip tone="neutral">Not eligible{p.ineligible_reason ? ` — ${p.ineligible_reason}` : ""}</Chip>
        )}
      </div>
    </PaperCard>
  )
}

function PapersTable({ rows, showMoney }: { rows: RecordPaper[]; showMoney: boolean }) {
  return (
    <TableScroller>
      <table className="w-full min-w-[760px] text-sm">
        <thead>
          <tr className="text-left text-xs tracking-wide text-fg-muted uppercase">
            <th className="px-3 py-2 font-medium">Title</th>
            <th className="px-3 py-2 font-medium">Venue</th>
            <th className="px-3 py-2 font-medium">Year</th>
            <th className="px-3 py-2 font-medium">Q</th>
            <th className="px-3 py-2 font-medium">Pos</th>
            <th className="px-3 py-2 text-right font-medium">Cites</th>
            <th className="px-3 py-2 font-medium">Claim state</th>
            {showMoney && <th className="px-3 py-2 text-right font-medium">Amount</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => {
            const state = tabOf(p)
            return (
              <tr key={p.id} className="h-10 border-t border-line">
                <td className="max-w-[28rem] px-3 py-2">
                  <span className="line-clamp-1">{p.title}</span>
                </td>
                <td className="max-w-[14rem] px-3 py-2 text-fg-muted">
                  <span className="line-clamp-1">{p.venue ?? "—"}</span>
                </td>
                <td className="px-3 py-2 tabular-nums">{p.year ?? "—"}</td>
                <td className="px-3 py-2">{p.quartile ?? "—"}</td>
                <td className="px-3 py-2 tabular-nums">
                  {p.author_position ? `${p.author_position}/${p.total_authors}` : "—"}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">{p.citations ?? "—"}</td>
                <td className="px-3 py-2">
                  {p.claim ? (
                    <Link to={`/papers/${p.claim.id}`} className="text-(--area) hover:underline">
                      {stageOf(p.claim.stage).label}
                    </Link>
                  ) : state === "unclaimed" ? (
                    <Link to={`/papers/new?publication=${p.id}`} className="font-medium text-(--area) hover:underline">
                      File it
                    </Link>
                  ) : (
                    <span className="text-fg-muted">Not eligible</span>
                  )}
                </td>
                {showMoney && (
                  <td className="px-3 py-2 text-right tabular-nums">{money(p.claim?.amount ?? null)}</td>
                )}
              </tr>
            )
          })}
        </tbody>
      </table>
    </TableScroller>
  )
}
