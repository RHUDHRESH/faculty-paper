import { useMemo, useState } from "react"
import { Link, Navigate, useNavigate, useSearchParams } from "react-router-dom"
import {
  CloudDownload,
  ClipboardPaste,
  FilePlusCorner,
  MoreHorizontal,
  Search,
  SlidersHorizontal,
  X,
} from "lucide-react"
import { useQueryClient } from "@tanstack/react-query"

import { api } from "@/lib/api"
import { cn } from "@/lib/cn"
import { formatCount } from "@/lib/count"
import { useApi } from "@/lib/query"
import { Button } from "@/ui/button"
import { Chip } from "@/ui/chip"
import { ConfirmDialog } from "@/ui/dialog"
import { Input, Select } from "@/ui/field"
import { Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from "@/ui/menu"
import { PageHeader } from "@/ui/page-header"
import { money, stageOf } from "@/ui/paper"
import { stageCode, stageName } from "@/ui/journey"
import { SLOW_DAYS } from "@/pages/claims-track"
import { Avatar, initialsOf } from "@/ui/person"
import { useMyThreshold, ThresholdCard } from "@/ui/research-threshold"
import { Details } from "@/ui/section"
import { Tabs } from "@/ui/tabs"
import { EmptyState, ErrorState, SkeletonRows } from "@/ui/state"
import { Table, type Column } from "@/ui/table"
import { toast } from "@/ui/toast"
import { typeLabel } from "@/pages/record-bits"
import { unshout } from "@/lib/names"
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
  { id: "unclaimed", label: "Ready to file" },
  { id: "progress", label: "With the college" },
  { id: "paid", label: "Paid" },
  { id: "ineligible", label: "Not eligible" },
] as const
type Tab = (typeof TABS)[number]["id"]

export function tabOf(p: RecordPaper): Exclude<Tab, "all"> {
  if (p.claim) return stageCode(p.claim.stage) === "PAID" ? "paid" : "progress"
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
      p.claim ? stageOf(stageCode(p.claim.stage)).label : tabOf(p) === "unclaimed" ? "Not claimed" : "Not eligible",
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

const STEP = 50

/** A title with the case, spacing and punctuation taken out, to spot the same paper listed twice. */
function sameTitleKey(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "")
}

type Report = { paper: RecordPaper; kind: "not_mine" | "duplicate"; of?: RecordPaper }

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
  const [reporting, setReporting] = useState<Report | null>(null)
  const [pulling, setPulling] = useState(false)
  const [pulled, setPulled] = useState<string | null>(null)
  const [showFilters, setShowFilters] = useState(false)
  const [shown, setShown] = useState(STEP)

  const query = useApi<Payload>(["me-publications", sort], `/api/me/publications?sort=${sort}`)
  const threshold = useMyThreshold()

  function set(key: string, value: string) {
    setShown(STEP)
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
    setShown(STEP)
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
  // One count everywhere: Home, this page, My research and the record page
  // read the same server rule, so the tabs are counted from the same rows.
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
  const twins = useMemo(() => {
    const groups = new Map<string, RecordPaper[]>()
    for (const p of all) {
      const k = sameTitleKey(p.title)
      if (k) groups.set(k, [...(groups.get(k) ?? []), p])
    }
    const out = new Map<string, RecordPaper>()
    for (const g of groups.values()) if (g.length > 1) for (const p of g) out.set(p.id, g.find((x) => x.id !== p.id)!)
    return out
  }, [all])

  const needle = q.trim().toLowerCase()
  const matchingAll = all.filter(
    (p) =>
      !hidden.has(p.id) &&
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
  // The job on this page is "which paper do I file?", so on All the papers
  // ready to file come first, then the ones with the college, then the rest;
  // inside each group the order the person chose (newest first by default).
  const rank = { unclaimed: 0, progress: 1, paid: 2, ineligible: 2 } as const
  const matching =
    tab === "all" && sort === "year" ? [...matchingAll].sort((a, b) => rank[tabOf(a)] - rank[tabOf(b)]) : matchingAll
  const rows = matching.slice(0, shown)
  const reported = all.filter((p) => hidden.has(p.id))

  if (status) return <Navigate to={`/papers/claims?status=${encodeURIComponent(status)}`} replace />

  const active: { key: string; label: string }[] = [
    year && { key: "year", label: year },
    quartile && { key: "quartile", label: quartile === "none" ? "No quartile" : quartile },
    type && { key: "type", label: typeLabel(type) ?? type },
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
      toast.ok(said === "nothing new" ? "Pulled from Scopus. Nothing new." : `Pulled from Scopus. ${said}.`)
    } catch (e) {
      toast.fail(e)
    } finally {
      setPulling(false)
    }
  }

  async function report(r: Report) {
    await api(`/api/me/publications/${r.paper.id}/dispute`, {
      method: "POST",
      json: r.kind === "duplicate" ? { reason: "duplicate", duplicate_of: r.of?.id } : { reason: "not_mine" },
    })
    setHidden((h) => new Set(h).add(r.paper.id))
    toast.ok(r.kind === "duplicate" ? "Reported as a duplicate." : "Reported as not mine.")
  }

  const sentence = query.data
    ? answerSentence(query.data.count, counts)
    : query.isError
      ? "Your record could not be loaded."
      : "Loading your record."

  const columns: Column<RecordPaper>[] = [
    {
      key: "paper",
      header: "Paper",
      cell: (p) => (
        <div className="min-w-0">
          <p className="line-clamp-2 text-base font-medium text-fg">{unshout(p.title)}</p>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-fg-muted">
            <span className="min-w-0 break-words">{[p.venue, p.year].filter(Boolean).join(" · ") || "Venue not recorded"}</span>
            {p.quartile && <Chip tone={p.quartile === "Q1" ? "gold" : "neutral"}>{p.quartile}</Chip>}
            {p.citations != null && p.citations > 0 && <span className="tabular">Cited {formatCount(p.citations)}</span>}
            {twins.has(p.id) && <Chip tone="caution">Listed twice</Chip>}
          </p>
        </div>
      ),
    },
    {
      key: "authors",
      header: "Authors",
      className: "w-72",
      cell: (p) => {
        const part = rolePhrase(p)
        const others = p.authors.some((a) => a.user_id !== (query.data?.user.id ?? ""))
        if (!part && !others) return null
        return (
          <div className="min-w-0 space-y-1">
            {part && <p className="text-sm text-fg">{part}</p>}
            <WrittenWith p={p} me={query.data?.user.id ?? ""} />
          </div>
        )
      },
    },    {
      key: "stands",
      header: "Where it stands",
      className: "w-52",
      cell: (p) => <Standing p={p} isNew={fresh.has(p.id)} />,
    },
    {
      key: "more",
      header: <span className="sr-only">More</span>,
      label: "",
      className: "w-12",
      cell: (p) => (
        <Menu>
          <MenuTrigger asChild>
            <Button kind="quiet" size="sm" aria-label={`More for ${p.title}`}>
              <MoreHorizontal />
            </Button>
          </MenuTrigger>
          <MenuContent align="end">
            {paperLink(p) && (
              <MenuItem onSelect={() => window.open(paperLink(p)!, "_blank", "noopener")}>
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
            {paperLink(p) && <MenuSeparator />}
            {twins.has(p.id) && (
              <MenuItem onSelect={() => setReporting({ paper: p, kind: "duplicate", of: twins.get(p.id) })}>
                Same paper is listed twice
              </MenuItem>
            )}
            <MenuItem onSelect={() => setReporting({ paper: p, kind: "not_mine" })}>Not my paper</MenuItem>
          </MenuContent>
        </Menu>
      ),
    },
  ]

  return (
    <div className="page space-y-8 pb-24 sm:pb-6" data-area="record">
      <PageHeader
        // An empty record is its own plate and its own next step (below); a
        // second picture and a second primary button in the header would be two.
        spot={all.length > 0 ? "spot-my-papers" : undefined}
        title="My papers"
        sub={sentence}
        action={
          all.length === 0 ? undefined : (
          <Button kind="primary" asChild className="max-sm:hidden">
            <Link to="/papers/new">
              <FilePlusCorner />
              File a paper
            </Link>
          </Button>
          )
        }
      />

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
          guide="file-a-paper"
          illustration="empty-no-papers"
          title="Your record will build itself"
          message="Once we match you to your Scopus profile, every paper you have published appears here. You will not have to type them in."
          action={
            <div className="flex flex-wrap justify-center gap-2">
              <Button asChild kind="primary">
                <Link to="/papers/new?method=doi">Paste a DOI to file a paper</Link>
              </Button>
              <Button asChild>
                <Link to="/me">Check my Scopus profile</Link>
              </Button>
            </div>
          }
        />
      ) : (
        <>
          <div className="-mt-3 flex flex-wrap gap-2 print:hidden">
            <Button kind="default" size="sm" asChild>
              <Link to="/papers/claims">My claims</Link>
            </Button>
            <Button kind="default" size="sm" asChild>
              <Link to="/papers/appraisal">List for appraisal</Link>
            </Button>
            <Button kind="default" size="sm" asChild>
              <Link to="/papers/statement">Payment statement</Link>
            </Button>
          </div>

          <ThresholdCard s={threshold.data} />

          <section aria-label="Your papers" className="space-y-3">
            <Tabs
              label="Claim state"
              idPrefix="papers"
              value={tab}
              onChange={(v) => set("tab", v)}
              tabs={TABS.filter((t) => t.id !== "ineligible" || counts.ineligible > 0 || tab === "ineligible").map((t) => ({
                id: t.id,
                label: t.label,
                count: counts[t.id],
              }))}
            />

            <div className="flex flex-wrap items-center gap-2">
              <label className="relative min-w-0 flex-1 basis-48 sm:max-w-72 sm:flex-none">
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
              <Button onClick={() => void pull()} disabled={pulling} className="sm:ml-auto">
                <CloudDownload />
                {pulling ? "Pulling…" : "Pull from Scopus"}
              </Button>
              <Menu>
                <MenuTrigger asChild>
                  <Button kind="quiet" aria-label="More: download, appraisal list and statement">
                    <MoreHorizontal />
                  </Button>
                </MenuTrigger>
                <MenuContent align="end">
                  <MenuLabel>Download what is shown</MenuLabel>
                  <MenuItem onSelect={() => download("my-papers.csv", toCsv(matching), "text/csv")}>
                    Download as spreadsheet (CSV)
                  </MenuItem>
                  <MenuItem onSelect={() => download("my-papers.bib", toBibtex(matching), "application/x-bibtex")}>
                    Download as BibTeX
                  </MenuItem>
                  <MenuSeparator />
                  <MenuLabel>For appraisal and tax</MenuLabel>
                  <MenuItem onSelect={() => nav("/papers/appraisal")}>List for appraisal</MenuItem>
                  <MenuItem onSelect={() => nav("/papers/statement")}>Payment statement</MenuItem>
                  <MenuSeparator />
                  <MenuItem onSelect={() => nav("/papers/claims")}>All my claims, drafts included</MenuItem>
                </MenuContent>
              </Menu>
            </div>

            {pulled && (
              <p role="status" className="flex items-center gap-2 text-sm text-fg-muted">
                <CloudDownload aria-hidden className="size-4 text-(--area)" strokeWidth={1.75} />
                Checked Scopus just now: {pulled}.
                <button
                  type="button"
                  onClick={() => setPulled(null)}
                  aria-label="Dismiss"
                  className="rounded-control p-1 hover:bg-hover focus-visible:ring-2 focus-visible:ring-accent outline-none"
                >
                  <X className="size-3.5" />
                </button>
              </p>
            )}

            {showFilters && (
              <div id="paper-filters" className="grid grid-cols-2 gap-2 sm:grid-cols-5">
                <Select aria-label="Year" value={year} onChange={(e) => set("year", e.target.value)}>
                  <option value="">Any year</option>
                  {years.map((y) => (
                    <option key={y} value={y}>
                      {y}
                    </option>
                  ))}
                </Select>
                <Select aria-label="Quartile" value={quartile} onChange={(e) => set("quartile", e.target.value)}>
                  <option value="">Any quartile</option>
                  {["Q1", "Q2", "Q3", "Q4"].map((x) => (
                    <option key={x}>{x}</option>
                  ))}
                  <option value="none">No quartile</option>
                </Select>
                <Select aria-label="Type" value={type} onChange={(e) => set("type", e.target.value)}>
                  <option value="">Any type</option>
                  {types.map((t) => (
                    <option key={t} value={t}>
                      {typeLabel(t)}
                    </option>
                  ))}
                </Select>
                <Select aria-label="Author role" value={role} onChange={(e) => set("role", e.target.value)}>
                  <option value="">First or co-author</option>
                  <option value="first">First author</option>
                  <option value="co">Co-author</option>
                </Select>
                <Select aria-label="Sort" value={sort} onChange={(e) => set("sort", e.target.value)}>
                  {Object.entries(SORT_LABEL).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v}
                    </option>
                  ))}
                </Select>
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
                  className="rounded-control px-1 text-fg-muted underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-accent"
                >
                  Clear filters
                </button>
              </div>
            )}

            {reported.map((p) => (
              <p key={p.id} role="status" className="flex flex-wrap items-center gap-x-3 text-sm text-fg-muted">
                <span className="min-w-0 truncate">Reported to the research office: {p.title}</span>
                <Button
                  kind="quiet"
                  size="sm"
                  onClick={() =>
                    setHidden((h) => {
                      const n = new Set(h)
                      n.delete(p.id)
                      return n
                    })
                  }
                >
                  Show it again
                </Button>
              </p>
            ))}

            {(matching.length !== all.length || rows.length < matching.length) && (
              <p className="text-sm text-fg-muted" aria-live="polite">
                Showing {formatCount(rows.length)} of {formatCount(matching.length)}
                {matching.length === all.length ? " papers" : ` matching papers, ${formatCount(all.length)} on your record`}.
              </p>
            )}

            <Table
              rows={rows}
              columns={columns}
              getKey={(p) => p.id}
              rowLink={(p) => (p.claim?.id ? `/papers/${p.claim.id}` : null)}
              maxHeight="none"
              caption="Your papers and where each claim stands"
              empty={
                tab === "unclaimed" && counts.unclaimed === 0
                  ? {
                      guide: "where-is-my-claim",
                      illustration: "empty-no-papers",
                      title: "Every eligible paper is filed",
                      message: "Nothing is waiting to be claimed. New papers appear here after a Scopus pull.",
                      action: (
                        <Button onClick={() => void pull()} disabled={pulling}>
                          <CloudDownload />
                          Pull from Scopus
                        </Button>
                      ),
                    }
                  : {
                      art: "no-results",
                      title:
                        tab === "ineligible" && counts.ineligible === 0
                          ? "Every paper can be claimed"
                          : tab === "progress" && counts.progress === 0
                            ? "Nothing is in progress"
                            : "No papers match",
                      message:
                        tab === "ineligible" && counts.ineligible === 0
                          ? "None of your papers has too many authors for the scheme."
                          : tab === "progress" && counts.progress === 0
                            ? "No claim of yours is waiting on the college right now. File one from a paper ready to claim."
                            : "Try another state, or clear the filters and search.",
                      action: (
                        <Button
                          onClick={() => {
                            clearFilters()
                            set("tab", "all")
                          }}
                        >
                          Clear filters
                        </Button>
                      ),
                    }
              }
            />
            {rows.length < matching.length && (
              <Button onClick={() => setShown((s) => s + STEP)}>
                Show {formatCount(Math.min(STEP, matching.length - rows.length))} more
              </Button>
            )}
          </section>

          {years.length > 1 && (
            <Details label="papers per year" count={years.length}>
              <YearBars papers={all} selected={year} onSelect={(y) => set("year", y === year ? "" : y)} />
            </Details>
          )}

          <div className="flex flex-wrap gap-2">
            <Button kind="default" size="sm" asChild>
              <Link to="/papers/new?method=doi">
                <ClipboardPaste />A paper is missing? Paste its DOI
              </Link>
            </Button>
            <Button kind="quiet" size="sm" asChild>
              <Link to="/faculty/me">Your full record with the college</Link>
            </Button>
          </div>
        </>
      )}

      <div className="fixed inset-x-0 bottom-0 z-20 border-t border-line bg-bg p-3 sm:hidden">
        <Button kind="primary" asChild className="w-full">
          <Link to="/papers/new">
            <FilePlusCorner />
            File a paper
          </Link>
        </Button>
      </div>

      <ConfirmDialog
        open={reporting != null}
        onOpenChange={(o) => !o && setReporting(null)}
        title={reporting?.kind === "duplicate" ? "Same paper listed twice?" : "Not your paper?"}
        description={
          reporting?.kind === "duplicate"
            ? `"${reporting.paper.title}" is on your record twice. It will be hidden here and reported to the research office to merge.`
            : `"${reporting?.paper.title ?? ""}" will be hidden and reported to the research office to take off your record.`
        }
        confirmLabel={reporting?.kind === "duplicate" ? "Report as a duplicate" : "Report as not mine"}
        onConfirm={async () => {
          if (reporting) await report(reporting)
        }}
      />
    </div>
  )
}

function paperLink(p: RecordPaper): string | null {
  return p.doi ? `https://doi.org/${p.doi}` : p.openalex_id ? `https://openalex.org/${p.openalex_id}` : null
}

/** "First author", "Sole author", "Author 2 of 4": what the person did on the paper. */
export function rolePhrase(p: RecordPaper): string | null {
  if (!p.author_position) return null
  const corr = p.corresponding_author ? ", corresponding" : ""
  if (p.author_position === 1) return p.total_authors <= 1 ? `Sole author${corr}` : `First author${corr}`
  return `Author ${p.author_position} of ${p.total_authors}${corr}`
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
    <figure>
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
                "group flex h-full min-w-0 flex-1 flex-col items-center justify-end gap-1 rounded-control px-0.5 pt-1 outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-default",
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

/** The co-authors from the college with their faces, and a count of those from outside. */
function WrittenWith({ p, me }: { p: RecordPaper; me: string }) {
  const others = p.authors.filter((a) => a.user_id !== me)
  const college = others.filter((a) => a.is_college)
  const external = others.length - college.length
  if (others.length === 0) return null
  return (
    <div className="flex min-w-0 items-center gap-2">
      {college.length > 0 && (
        <span aria-hidden className="flex shrink-0 -space-x-1">
          {college.slice(0, 3).map((a, i) => (
            <Avatar
              key={i}
              size="xs"
              person={{ name: a.name, initials: a.initials ?? initialsOf(a.name), photo_url: a.photo_url ?? null }}
              className="ring-2 ring-bg"
            />
          ))}
        </span>
      )}
      <span className="min-w-0 text-sm text-fg-muted">
        {college.slice(0, 2).map((a, i) => (
          <span key={i}>
            {i > 0 && ", "}
            {a.user_id ? (
              <Link to={`/u/${a.user_id}`} className="text-fg hover:underline hover:underline-offset-4">
                {a.name}
              </Link>
            ) : (
              <span className="text-fg">{a.name}</span>
            )}
          </span>
        ))}
        {college.length > 2 && `, +${college.length - 2} more`}
        {external > 0 && `${college.length > 0 ? ", " : ""}${external} from outside`}
      </span>
    </div>
  )
}

/**
 * Where the paper's claim stands, in words, with the one next action. A paid
 * paper is a quiet line, not a chip: twenty-three green chips down a column
 * say "paid" twenty-three times and bury the one paper that needs filing.
 */
function Standing({ p, isNew }: { p: RecordPaper; isNew: boolean }) {
  const state = tabOf(p)
  const stage = p.claim?.stage ?? null
  const paid = p.claim ? stageCode(p.claim.stage) === "PAID" : false
  const days = p.claim?.days_waiting ?? null
  return (
    <div className="flex min-w-0 flex-col items-start gap-1">
      {isNew && <Chip tone="area">New from Scopus</Chip>}
      {state === "unclaimed" && (
        <Button asChild size="sm">
          <Link to={`/papers/new?publication=${p.id}`}>
            <FilePlusCorner />
            File it
          </Link>
        </Button>
      )}
      {stage && !paid && (
        <span className="text-sm text-fg">
          {stageName(stage)}
          {days != null && <span className={cn("tabular", days > SLOW_DAYS ? "text-caution" : "text-fg-muted")}>{`, ${days} days`}</span>}
        </span>
      )}
      {paid && (
        <span className="text-sm text-fg-muted">
          Paid{p.claim?.paid_month ? ` ${monthName(p.claim.paid_month)}` : ""}
        </span>
      )}
      {paid && !!p.claim?.amount && (
        <span className="text-sm font-medium tabular-nums text-fg">{money(p.claim.amount)} to you</span>
      )}
      {state === "ineligible" && (
        <span className="text-sm text-fg-muted">
          Not eligible: {p.total_authors} authors, and the scheme pays up to {maxAuthors(p.ineligible_reason) ?? "a limited number of"}.
        </span>
      )}
    </div>
  )
}

/** The page's answer, in the order a person needs it. Real counts, and a zero says what it means. */
export function answerSentence(total: number, c: Record<Tab, number>): string {
  const n = (k: number, one: string, many: string) => `${formatCount(k)} ${k === 1 ? one : many}`
  const parts: string[] = []
  if (c.unclaimed) parts.push(`${n(c.unclaimed, "paper is", "papers are")} ready to file`)
  if (c.progress) parts.push(`${n(c.progress, "is", "are")} with the college`)
  if (c.paid) parts.push(`${formatCount(c.paid)} ${c.paid === 1 ? "has" : "have"} been paid`)
  const head = `${n(total, "paper", "papers")} on your record.`
  if (parts.length === 0) return head
  const first = parts[0].charAt(0).toUpperCase() + parts[0].slice(1)
  return `${head} ${[first, ...parts.slice(1)].join(", ")}.`
}

/** "More than 10 authors" -> 10. */
export function maxAuthors(reason: string | null): number | null {
  const m = reason?.match(/(\d+)/)
  return m ? Number(m[1]) : null
}
