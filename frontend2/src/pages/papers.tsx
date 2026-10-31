import { useMemo, useState } from "react"
import { Link, Navigate, useNavigate, useSearchParams } from "react-router-dom"
import { CloudDownload, FilePlusCorner, MoreHorizontal, Search } from "lucide-react"
import { useQueryClient } from "@tanstack/react-query"

import { api } from "@/lib/api"
import { cn } from "@/lib/cn"
import { formatCount } from "@/lib/count"
import { useApi } from "@/lib/query"
import { Button } from "@/ui/button"
import { Chip } from "@/ui/chip"
import { ConfirmDialog } from "@/ui/dialog"
import { DetailLink } from "@/ui/detail-sheet"
import { Input, Select } from "@/ui/field"
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/ui/menu"
import { Answer } from "@/ui/answer"
import { filterBar } from "@/ui/filter-bar"
import { Pagination } from "@/ui/pagination"
import { PageHeader } from "@/ui/page-header"
import { money, stageOf } from "@/ui/paper"
import { stageCode, stageName } from "@/ui/journey"
import { SLOW_DAYS } from "@/pages/claims-track"
import { Avatar, initialsOf } from "@/ui/person"
import { useMyThreshold, ThresholdCard } from "@/ui/research-threshold"
import { EmptyState, ErrorState, SkeletonRows } from "@/ui/state"
import { Table, type Column } from "@/ui/table"
import { toast } from "@/ui/toast"
import { PaperCandidates, ScopusProfileQuestion } from "@/pages/papers-confirm"
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

// Which version of a paper leads its group: the claim already moving first, then paid, ready to file, not eligible.
const LEAD: Record<ReturnType<typeof tabOf>, number> = { progress: 0, paid: 1, unclaimed: 2, ineligible: 3 }

function leads(a: RecordPaper, b: RecordPaper): boolean {
  if (LEAD[tabOf(a)] !== LEAD[tabOf(b)]) return LEAD[tabOf(a)] < LEAD[tabOf(b)]
  if (!!a.venue !== !!b.venue) return !!a.venue
  return (a.year ?? 0) > (b.year ?? 0)
}

/** A title with the case, spacing and punctuation taken out, to spot the same paper listed twice. */
function sameTitleKey(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "")
}

/** Levenshtein distance is at most 2. Gives up early once every row is over 2. */
function near(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 2) return false
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    let low = i
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
      low = Math.min(low, cur[j])
    }
    if (low > 2) return false
    prev = cur
  }
  return prev[b.length] <= 2
}

/** Long keys that differ by a typo (at most 2 letters) fold into the first key that matches them. */
function nearTitleKeys(keys: string[]): Map<string, string> {
  const canon = new Map<string, string>()
  const kept: string[] = []
  for (const k of new Set(keys)) {
    if (!k) continue
    const hit = k.length >= 40 ? kept.find((c) => c.length >= 40 && c.slice(0, 20) === k.slice(0, 20) && near(c, k)) : undefined
    if (hit) canon.set(k, hit)
    else kept.push(k)
  }
  return canon
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
  const page = Math.max(0, Number.parseInt(params.get("page") ?? "0", 10) || 0)
  const size = [30, 50, 100].includes(Number(params.get("size"))) ? Number(params.get("size")) : 30
  const [open, setOpen] = useState<Set<string>>(new Set())

  function toggleVersions(key: string) {
    setOpen((s) => {
      const n = new Set(s)
      if (n.has(key)) n.delete(key)
      else n.add(key)
      return n
    })
  }

  const query = useApi<Payload>(["me-publications", sort], `/api/me/publications?sort=${sort}`)
  const threshold = useMyThreshold()

  function setPaging(key: "page" | "size", value: string) {
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        if (value) next.set(key, value)
        else next.delete(key)
        if (key === "size") next.delete("page")
        return next
      },
      { replace: true }
    )
  }
  function set(key: string, value: string) {
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        next.delete("page")
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
  const titleKeys = useMemo(() => nearTitleKeys(all.map((p) => sameTitleKey(p.title))), [all])
  const keyOf = (title: string) => {
    const k = sameTitleKey(title)
    return titleKeys.get(k) ?? k
  }
  const twins = useMemo(() => {
    const groups = new Map<string, RecordPaper[]>()
    for (const p of all) {
      const k = keyOf(p.title)
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
  // Versions of one paper fold under a representative. The others are listed
  // only when their group is open. Groups are made from the rows that pass the
  // filters, so a filtered-out version never hides the one that is shown.
  const groups = new Map<string, RecordPaper[]>()
  for (const p of matching) {
    const k = keyOf(p.title)
    if (k) groups.set(k, [...(groups.get(k) ?? []), p])
  }
  const repOf = new Map<string, RecordPaper>()
  const folded = new Set<string>()
  for (const [k, g] of groups) {
    if (g.length < 2) continue
    const lead = g.reduce((best, p) => (leads(p, best) ? p : best))
    repOf.set(k, lead)
    for (const p of g) if (p.id !== lead.id) folded.add(p.id)
  }
  const listed: RecordPaper[] = []
  for (const p of matching) {
    if (folded.has(p.id)) continue
    listed.push(p)
    const k = keyOf(p.title)
    if (repOf.get(k)?.id === p.id && open.has(k)) listed.push(...groups.get(k)!.filter((v) => v.id !== p.id))
  }
  const maxPage = Math.max(0, Math.ceil(listed.length / size) - 1)
  const rows = listed.slice(Math.min(page, maxPage) * size, (Math.min(page, maxPage) + 1) * size)
  const reported = all.filter((p) => hidden.has(p.id))

  if (status) return <Navigate to={`/papers/claims?status=${encodeURIComponent(status)}`} replace />

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

  function sortBy(key: string) {
    if (key === "paper") set("sort", "title")
    else if (key === "year") set("sort", sort === "year" ? "oldest" : "year")
    else if (key === "cited") set("sort", "citations")
  }
  const sortKey = sort === "title" ? "paper" : sort === "citations" ? "cited" : "year"
  const sortDir = sort === "year" || sort === "citations" ? "desc" : "asc"
  const statusText = (p: RecordPaper) =>
    p.claim ? stageOf(stageCode(p.claim.stage)).label : tabOf(p) === "unclaimed" ? "Not claimed" : "Not eligible"

  const columns: Column<RecordPaper>[] = [
    {
      key: "paper",
      header: "Paper",
      sortable: true,
      exportValue: (p) => p.title,
      cell: (p) => (
        <div className="min-w-0">
          <p className="line-clamp-2 text-base font-medium text-fg">
            <DetailLink kind="paper" id={p.id}>
              {unshout(p.title)}
            </DetailLink>
          </p>
          {(repOf.get(keyOf(p.title))?.id === p.id || folded.has(p.id)) && (
            <p className="mt-0.5 flex flex-wrap items-center gap-2 text-sm text-fg-muted">
              {repOf.get(keyOf(p.title))?.id === p.id && (
                <Button
                  kind="quiet"
                  size="sm"
                  aria-expanded={open.has(keyOf(p.title))}
                  onClick={() => toggleVersions(keyOf(p.title))}
                >
                  {groups.get(keyOf(p.title))!.length} versions
                </Button>
              )}
              {folded.has(p.id) && <Chip>Another version</Chip>}
            </p>
          )}
        </div>
      ),
    },
    {
      key: "journal",
      header: "Journal",
      exportValue: (p) => p.venue,
      cell: (p) => (
        <span className="inline-flex flex-wrap items-center gap-2">
          {p.venue && <DetailLink kind="journal" name={p.venue} />}
          {p.quartile && <Chip tone={p.quartile === "Q1" ? "gold" : "neutral"}>{p.quartile}</Chip>}
        </span>
      ),
    },
    {
      key: "year",
      header: "Year",
      sortable: true,
      exportValue: (p) => p.year,
      cell: (p) => (p.year ? <span className="tabular">{p.year}</span> : null),
    },
    {
      key: "cited",
      header: "Cited",
      align: "right",
      sortable: true,
      exportKind: "number",
      exportValue: (p) => p.citations,
      cell: (p) => (p.citations != null ? <span className="tabular">{formatCount(p.citations)}</span> : null),
    },
    {
      key: "authors",
      header: "Authors",
      exportValue: (p) => p.authors.map((a) => a.name).join("; "),
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
    },
    {
      key: "doi",
      header: "DOI",
      defaultHidden: true,
      exportValue: (p) => p.doi,
      cell: (p) => p.doi,
    },
    {
      key: "stands",
      header: "Where it stands",
      exportValue: statusText,
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
        title="My papers"
        sub="Every paper on your record and where its claim stands."
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

      <ScopusProfileQuestion />
      <PaperCandidates />

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
          <ThresholdCard s={threshold.data} />

          <Answer
            items={TABS.filter((t) => t.id !== "all" && (t.id !== "ineligible" || counts.ineligible > 0 || tab === t.id)).map(
              (t) => ({ value: counts[t.id], label: t.label, to: tab === t.id ? "/papers" : `/papers?tab=${t.id}` })
            )}
          />

          <section aria-label="Your papers" className="space-y-3">
            <div className={filterBar} role="search">
              <label className="relative sm:w-72">
                <span className="sr-only">Search in my papers</span>
                <Search aria-hidden className="pointer-events-none absolute top-3 left-2.5 size-4 text-fg-subtle" />
                <Input
                  value={q}
                  onChange={(e) => set("q", e.target.value)}
                  placeholder="Search title, journal or co-author"
                  className="pl-8"
                />
              </label>
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
              <Select aria-label="Author role" value={role} onChange={(e) => set("role", e.target.value)}>
                <option value="">First or co-author</option>
                <option value="first">First author</option>
                <option value="co">Co-author</option>
              </Select>
              {(tab !== "all" || year || quartile || type || role || q) && (
                <Button
                  kind="quiet"
                  onClick={() => {
                    clearFilters()
                    set("tab", "all")
                  }}
                >
                  Clear
                </Button>
              )}
              <Button onClick={() => void pull()} disabled={pulling} className="sm:ml-auto">
                <CloudDownload />
                {pulling ? "Pulling…" : "Pull from Scopus"}
              </Button>
              <Menu>
                <MenuTrigger asChild>
                  <Button kind="quiet" aria-label="More: BibTeX, appraisal list and statement">
                    <MoreHorizontal />
                  </Button>
                </MenuTrigger>
                <MenuContent align="end">
                  <MenuItem onSelect={() => download("my-papers.bib", toBibtex(matching), "application/x-bibtex")}>
                    Download as BibTeX
                  </MenuItem>
                  <MenuSeparator />
                  <MenuItem onSelect={() => nav("/papers/appraisal")}>List for appraisal</MenuItem>
                  <MenuItem onSelect={() => nav("/papers/statement")}>Payment statement</MenuItem>
                  <MenuItem onSelect={() => nav("/papers/locker")}>Proof locker</MenuItem>
                  <MenuItem onSelect={() => nav("/papers/claims")}>All my claims, drafts included</MenuItem>
                  <MenuItem onSelect={() => nav("/papers/new?method=doi")}>A paper is missing? Paste its DOI</MenuItem>
                </MenuContent>
              </Menu>
            </div>

            {pulled && (
              <p role="status" className="text-sm text-fg-muted">
                Checked Scopus just now: {pulled}.
              </p>
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

            <Table
              rows={rows}
              columns={columns}
              getKey={(p) => p.id}
              rowLink={(p) => (p.claim?.id ? `/papers/${p.claim.id}` : null)}
              maxHeight="none"
              caption="Your papers and where each claim stands"
              sortKey={sortKey}
              sortDir={sortDir}
              onSort={sortBy}
              tools={{ id: "my-papers", title: "My papers", getAllRows: async () => listed }}
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
            <div className="flex flex-wrap items-center justify-between gap-3">
              <Pagination page={page} pageSize={size} total={listed.length} onChange={(n) => setPaging("page", n ? String(n) : "")} />
              <Select
                aria-label="Rows per page"
                value={String(size)}
                onChange={(e) => setPaging("size", e.target.value === "30" ? "" : e.target.value)}
                className="w-auto"
              >
                {[30, 50, 100].map((n) => (
                  <option key={n} value={n}>
                    {n} per page
                  </option>
                ))}
              </Select>
            </div>
          </section>
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
          {p.ineligible_reason === "Retracted"
            ? "Not eligible: the title says this paper was retracted."
            : `Not eligible: ${p.total_authors} authors, and the scheme pays up to ${maxAuthors(p.ineligible_reason) ?? "a limited number of"}.`}
        </span>
      )}
    </div>
  )
}

/** "More than 10 authors" -> 10. */
export function maxAuthors(reason: string | null): number | null {
  const m = reason?.match(/(\d+)/)
  return m ? Number(m[1]) : null
}
