import { useEffect, useState } from "react"
import { Link, useSearchParams } from "react-router-dom"
import { AlertTriangle, CircleCheck, Download, Pencil, Search } from "lucide-react"

import { can, useAuth } from "@/app/auth"
import { cn } from "@/lib/cn"
import { useApi, useApiMutation } from "@/lib/query"
import { Button } from "@/ui/button"
import { Combobox, type ComboboxOption } from "@/ui/combobox"
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/ui/dialog"
import { Field, Input, Textarea } from "@/ui/field"
import { Pagination } from "@/ui/pagination"
import { EmptyState, ErrorState, InlineError, SkeletonRows } from "@/ui/state"
import { stickyHeadCell, Table, TableScroller } from "@/ui/table"
import { ColumnLabel, Meta, Sub } from "@/ui/text"
import { toast } from "@/ui/toast"
import { AnswerLine, AnswerWord } from "@/ui/answer"
import { PageHeader } from "@/ui/page-header"
import { Details, Rows, Section } from "@/ui/section"
import { n, papersUrl } from "@/pages/principal-parts"
import { Avatar, initialsOf } from "@/ui/person"
import { unshout } from "@/lib/names"

/**
 * The NAAC / NIRF submission, and — the part that makes it a screen rather
 * than a download button — what an assessor would send back.
 *
 * The pack itself was assembled by hand from exports every year out of data
 * the system already held. Handing over a download would only move that job;
 * what actually takes the time is finding the rows with no ISSN, no link or
 * no year and filling them in, so those lead here and the export sits beside
 * them.
 *
 * Gap counts are over the **whole filtered set**, never the page. "412 rows
 * have no ISSN" is a number somebody plans an afternoon around, and a
 * per-page count would understate it by two orders of magnitude.
 *
 * Nothing on this screen carries money, and nothing on it can move a ticket's
 * stage. The editable set is bibliographic only — title, journal, ISSN, year,
 * DOI, link — and the server enforces that whatever is posted.
 */

const PAGE_SIZE = 50

/* ------------------------------------------------------------------------ */
/* Data — read out of pack_rows() in backend/core/api.py                    */
/* ------------------------------------------------------------------------ */

type PackRow = {
  id: string
  ticket_number: string | null
  paper_title: string
  owner_id: string
  owner_name: string
  owner_department: string
  journal_title: string
  publication_year: number | string
  issn: string
  doi: string
  scopus_url: string
  link: string
  /** "Yes" | "No" | "Not checked" — the last when no UGC-CARE list is loaded. */
  ugc_care: string
  /** "claim" (editable here) or "record": a paper on the publication record nobody claimed. */
  source?: "claim" | "record"
  owner_photo_url?: string | null
  /** Human labels for what this row is missing. Empty means it is complete. */
  gaps: string[]
}

type PackRowsPayload = {
  total: number
  limit: number
  offset: number
  results: PackRow[]
  /** Over the whole filtered set, not the page. */
  gaps: { key: string; count: number }[]
  incomplete: number
  ugc_list_loaded: boolean
  /** field name -> the label NAAC uses for it. */
  editable: Record<string, string>
}

// The workbook (xlsx) is the header's one download; these are the same rows in the other formats an office is asked for.
const EXPORT_FORMATS = ["csv", "json", "pdf", "docx"] as const

/* ------------------------------------------------------------------------ */
/* Page                                                                      */
/* ------------------------------------------------------------------------ */

export function Accreditation() {
  const { me } = useAuth()
  const allowed = can(me?.role).viewReports
  // `pack_row_edit` allows `can_clear_claims` or `can_manage_users` — the
  // office. The Principal and Finance read the submission; correcting a row
  // in it is the research cell's job.
  const mayEdit = can(me?.role).clear

  const [searchParams, setSearchParams] = useSearchParams()
  const year = searchParams.get("year") ?? ""
  const only = searchParams.get("only") ?? ""
  const q = searchParams.get("q") ?? ""
  const page = Math.max(0, Number.parseInt(searchParams.get("page") ?? "0", 10) || 0)

  const [draft, setDraft] = useState(q)
  useEffect(() => setDraft(q), [q])

  useEffect(() => {
    if (draft === q) return
    const t = setTimeout(() => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev)
          if (draft) next.set("q", draft)
          else next.delete("q")
          next.delete("page")
          return next
        },
        { replace: true }
      )
    }, 250)
    return () => clearTimeout(t)
  }, [draft, q, setSearchParams])

  function setParam(key: string, value: string) {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev)
      if (value) next.set(key, value)
      else next.delete(key)
      if (key !== "page") next.delete("page")
      return next
    })
  }

  const filters = new URLSearchParams()
  if (year) filters.set("year", year)
  if (q) filters.set("q", q)

  const rowsQuery = new URLSearchParams(filters)
  if (only) rowsQuery.set("only", only)
  rowsQuery.set("limit", String(PAGE_SIZE))
  rowsQuery.set("offset", String(page * PAGE_SIZE))

  const { data, isLoading, isError, error, refetch } = useApi<PackRowsPayload>(
    ["reports", "pack", "rows", year, only, q, page],
    `/api/reports/pack/rows?${rowsQuery.toString()}`,
    { enabled: allowed, placeholderData: (prev) => prev }
  )

  const [editing, setEditing] = useState<{ row: PackRow; field: string } | null>(null)

  if (!allowed) {
    return (
      <div className="page py-8">
        <ErrorState
          art="closed-gate"
          title="Not open to this account"
          message="The accreditation submission is college-wide. A head of department has their own department's publications instead."
        />
      </div>
    )
  }

  const rows = data?.results ?? []
  const gaps = (data?.gaps ?? []).filter((g) => g.count > 0)
  const total = data?.total ?? 0

  const yearOptions: ComboboxOption[] = [
    { value: "", label: "All years on record" },
    ...recentYears().map((y) => ({ value: String(y), label: String(y) })),
  ]

  return (
    <div className="page space-y-10">
      <PageHeader
        title="Accreditation"
        action={
          <Button kind="primary" asChild>
            <a href={`/api/reports/pack?${new URLSearchParams({ ...(year ? { year } : {}), fmt: "xlsx" }).toString()}`} download>
              <Download />
              Download the NAAC and NIRF workbook
            </a>
          </Button>
        }
      />

      <Standing year={year} ugcLoaded={data?.ugc_list_loaded} gaps={gaps} />

      <Details label="the paper list an assessor would check" count={total}>
      <Section title="The paper list" sub="One row for each college author of each paper, in the order NAAC 3.4.3 asks." className="pt-3">
      <div className="space-y-6">
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <ColumnLabel className="mb-1 block">Publication year</ColumnLabel>
          <Combobox
            value={year}
            onChange={(next) => setParam("year", next)}
            options={yearOptions}
            aria-label="Filter by publication year"
            className="w-48"
          />
        </div>
        <div className="relative w-full max-w-xs">
          <ColumnLabel className="mb-1 block">Search</ColumnLabel>
          <Search
            className="pointer-events-none absolute bottom-2.5 left-2.5 size-4 text-fg-subtle"
            aria-hidden
          />
          <Input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Title, journal, author, ISSN"
            aria-label="Search the submission"
            className="pl-8"
          />
        </div>
        <div className="ml-auto flex items-end gap-2">
          <ExportMenu filters={filters} />
        </div>
      </div>

      {/* Withheld when the request failed with nothing cached behind it.
          `gaps` falls back to an empty array, and an empty `gaps` is what
          `GapStrip` reads as "clean" — so a failed request rendered "0 rows
          in the submission" over "Every row carries everything an assessor
          asks for", in the positive colour, directly above the banner saying
          the server had not answered. The reassurance was the failure. */}
      {!(isError && !data) && (
        <GapStrip
          gaps={gaps}
          total={total}
          incomplete={data?.incomplete ?? 0}
          only={only}
          onSelect={(next) => setParam("only", next)}
          loading={isLoading && !data}
        />
      )}

      {isLoading && !data ? (
        <SkeletonRows rows={10} rowHeight={44} />
      ) : isError ? (
        <ErrorState
          title="Could not load the submission"
          message={
            error?.status === 403
              ? "Not allowed. The submission is open to the office, the Principal and Finance."
              : "The server did not answer. Nothing has been changed."
          }
          onRetry={error?.status === 403 ? false : () => refetch()}
        />
      ) : rows.length === 0 ? (
        <EmptyState
          // A gap filter that comes back empty is work finished, not a
          // search that failed: "Every row is complete" under a drawing of a
          // filter returning nothing reads as though the count was wrong.
          art={only ? "empty-queue" : "no-results"}
          icon={CircleCheck}
          title={
            only === "incomplete"
              ? "Every row is complete"
              : only
                ? `No row is missing ${only.replace(/^No /, "")}`
                : "No publication matches"
          }
          message={
            only
              ? "Nothing here needs filling in. Clear the filter to see the whole submission."
              : "Try a different year, or clear the search."
          }
          action={
            only || q || year ? (
              <Button
                kind="default"
                size="sm"
                onClick={() => setSearchParams(new URLSearchParams())}
              >
                Clear filters
              </Button>
            ) : undefined
          }
        />
      ) : (
        <>
          <PackTable
            rows={rows}
            editable={data?.editable ?? {}}
            mayEdit={mayEdit}
            onEdit={(row, field) => setEditing({ row, field })}
          />
          <Pagination
            page={page}
            pageSize={PAGE_SIZE}
            total={total}
            onChange={(next) => setParam("page", next > 0 ? String(next) : "")}
          />
        </>
      )}

      {editing && (
        <EditFieldDialog
          row={editing.row}
          field={editing.field}
          label={data?.editable[editing.field] ?? editing.field}
          onClose={() => setEditing(null)}
        />
      )}
      </div>
      </Section>
      </Details>
    </div>
  )
}

/* ------------------------------------------------------------------------ */
/* Where we stand                                                            */
/* ------------------------------------------------------------------------ */

type Summary = {
  year: number
  teachers: number
  naac_331: { from: number; to: number; papers: number; teachers: number; per_teacher: number | null; band: number }
  table: {
    year: number
    papers: number
    per_teacher: number | null
    record_papers: number
    scopus: number
    top_quartile: number
    retraction_signals: number
  }[]
  scopus_share: number
  retraction_signals: number
  retraction_examples: { id: string; year: number; title: string; phrase: string }[]
  ugc_list_loaded: boolean
}

/**
 * The answer before the rows (docs/jtbd/principal.md, Q4).
 *
 * The Principal is asked one thing of this page: "where do we stand for NAAC
 * 3.3.1 and NIRF, and what would weaken it?" The rows below answer a different
 * question, the research cell's ("which entries would an assessor send
 * back?"), and led the page, so the answer sat under a 6,330-row list. The
 * figures are the brief's own (one service), plus what NIRF reads: Scopus
 * listing, the top-quartile share, and papers whose title carries a
 * retraction notice, which NIRF now penalises.
 */
function Standing({
  year,
  ugcLoaded,
  gaps,
}: {
  year: string
  ugcLoaded: boolean | undefined
  gaps: { key: string; count: number }[]
}) {
  const s = useApi<Summary>(["reports", "accreditation", year], `/api/reports/accreditation${year ? `?year=${year}` : ""}`)
  const d = s.data
  if (s.isError) return <InlineError message="Could not load where the college stands." onRetry={() => s.refetch()} />
  const missing = (label: string) => gaps.find((g) => g.key === label)?.count ?? 0
  const last = d?.table[d.table.length - 1]
  const perTeacher = d?.naac_331.per_teacher
  const loaded = d?.ugc_list_loaded ?? ugcLoaded
  const weakCount = (!loaded ? 1 : 0) + (missing("No ISSN") ? 1 : 0) + (missing("No link to the paper") ? 1 : 0) + ((d?.retraction_signals ?? 0) > 0 ? 1 : 0)

  return (
    <div className="space-y-8">
      <div className="space-y-4">
        <AnswerLine>
          {!d ? (
            "Where the college stands."
          ) : (
            <>
              NAAC 3.3.1: {perTeacher == null ? "no papers" : `${perTeacher} papers per teacher`}, band {d.naac_331.band} of 4.
            </>
          )}
        </AnswerLine>
        {d && (
          <p className="max-w-[40rem] text-lead text-fg-muted">
            Five years, {d.naac_331.from} to {d.naac_331.to}.{" "}
            {weakCount === 0 ? (
              <AnswerWord tone="sage">Nothing could weaken it</AnswerWord>
            ) : (
              <>
                {weakCount} {weakCount === 1 ? "thing" : "things"} could weaken it.
              </>
            )}
          </p>
        )}
        {d && (
          <Rows className="max-w-xl">
            {[
              { label: "Of the record's papers, listed in Scopus (NIRF reads Scopus)", value: `${d.scopus_share}%`, to: papersUrl({ year: d.year }) },
              {
                label: `Of ${d.year}'s papers, in Q1 or Q2 journals (the NIRF quality measure)`,
                value: last && last.record_papers ? `${Math.round((100 * last.top_quartile) / last.record_papers)}%` : "None",
                to: papersUrl({ year: d.year, quartile: "top" }),
              },
              { label: "Papers with a retraction notice in the title", value: d.retraction_signals ? n(d.retraction_signals) : "None", to: d.retraction_signals ? "/reports/papers?q=retract" : "" },
            ].map((x) => (
              <li key={x.label}>
                {x.to ? (
                  <Link to={x.to} className="row flex items-baseline justify-between gap-4 px-1 py-2.5 sm:px-2">
                    <span className="text-base">{x.label}</span>
                    <span className="tabular text-base font-medium">{x.value}</span>
                  </Link>
                ) : (
                  <div className="flex items-baseline justify-between gap-4 px-1 py-2.5 sm:px-2">
                    <span className="text-base">{x.label}</span>
                    <span className="tabular text-base font-medium">{x.value}</span>
                  </div>
                )}
              </li>
            ))}
          </Rows>
        )}
      </div>

      <Section title="What would weaken it">
        <Rows>
          <Check
            ok={loaded === true}
            label="The UGC-CARE list is loaded"
            detail={
              loaded
                ? "Loaded, so the UGC-CARE column answers yes or no."
                : "Not loaded. NAAC 3.3.1 counts UGC-CARE journals only, so the figure above is a ceiling, and every row's UGC-CARE column reads “Not checked”, which is not the same as “not listed”."
            }
            to={loaded ? undefined : "/reference"}
          />
          <Check
            ok={missing("No ISSN") === 0}
            label="Every row has an ISSN"
            detail={missing("No ISSN") ? `${missing("No ISSN").toLocaleString("en-IN")} rows have no ISSN, so an assessor cannot check the journal.` : "Every row has one."}
          />
          <Check
            ok={missing("No link to the paper") === 0}
            label="Every row links to the paper"
            detail={
              missing("No link to the paper")
                ? `${missing("No link to the paper").toLocaleString("en-IN")} rows have no link. NAAC does not count a paper it cannot open.`
                : "Every row has one."
            }
          />
          <Check
            ok={(d?.retraction_signals ?? 0) === 0}
            label="No paper looks retracted"
            detail={
              d?.retraction_signals
                ? `${d.retraction_signals} titles carry a retraction or withdrawal notice. NIRF takes marks off for retracted papers.`
                : "No title carries a retraction notice. A quiet retraction would not show here."
            }
            to={d?.retraction_signals ? "/reports/papers?q=retract" : undefined}
          />
        </Rows>
        {d && d.retraction_examples.length > 0 && (
          <Details className="mt-2" count={d.retraction_examples.length} label="titles with a notice">
            <Rows>
              {d.retraction_examples.map((r) => (
                <li key={r.id} className="px-1 py-2 text-sm sm:px-2">
                  {unshout(r.title)} <Meta>({r.year})</Meta>
                </li>
              ))}
            </Rows>
          </Details>
        )}
      </Section>

      <Section title="Five years, as the assessors ask">
        <Table
          rows={d ? [...d.table].reverse() : []}
          columns={[
            { key: "year", header: "Year", cell: (r) => String(r.year) },
            { key: "papers", header: "Papers", align: "right", cell: (r) => (
              <Link to={papersUrl({ year: r.year })} className="underline-offset-4 hover:underline">{n(r.papers)}</Link>
            ) },
            { key: "per", header: "Per teacher", align: "right", cell: (r) => n(r.per_teacher) },
            { key: "scopus", header: "In Scopus", align: "right", empty: "None", cell: (r) => (r.scopus ? n(r.scopus) : null) },
            { key: "top", header: "In Q1 or Q2", align: "right", empty: "None", cell: (r) => (r.top_quartile ? n(r.top_quartile) : null) },
            { key: "ret", header: "Retraction notices", align: "right", empty: "None", cell: (r) => (r.retraction_signals ? n(r.retraction_signals) : null) },
          ]}
          getKey={(r) => String(r.year)}
          maxHeight="none"
          caption="Five years of papers for NAAC and NIRF"
          empty={{ title: "No papers on record", message: "Nothing has been published in these years." }}
        />
        <Details label="how these are counted" className="mt-2">
          <Sub className="pt-2 text-sm">
            Papers and the rate per teacher come from the year brief; Scopus, Q1 or Q2 and retraction columns count the papers on the publication record. Teachers are today&apos;s roll of {d ? n(d.teachers) : "…"}; earlier years are divided by it, because no headcount history is kept.
          </Sub>
        </Details>
      </Section>
    </div>
  )
}

function Check({ ok, label, detail, to }: { ok: boolean; label: string; detail: string; to?: string }) {
  return (
    <li className="flex items-start gap-3 px-1 py-2.5 sm:px-2">
      {ok ? (
        <CircleCheck className="mt-0.5 size-4 shrink-0 text-positive" aria-hidden />
      ) : (
        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-caution" aria-hidden />
      )}
      <span className="min-w-0 flex-1">
        <span className="block text-base">
          {label}
          <span className={cn("ml-2 text-sm", ok ? "text-positive" : "text-caution")}>{ok ? "Ready" : "To settle"}</span>
        </span>
        <span className="block text-sm text-fg-muted">{detail}</span>
      </span>
      {to && (
        <Button kind="default" size="sm" asChild className="shrink-0">
          <Link to={to}>Open</Link>
        </Button>
      )}
    </li>
  )
}

/* ------------------------------------------------------------------------ */
/* The gaps                                                                  */
/* ------------------------------------------------------------------------ */

/**
 * What is missing, and how much of it — as filters, because every one of
 * these is a job somebody is about to do.
 *
 * "No ISSN · 412" is not a statistic on this screen, it is a worklist: press
 * it and you have exactly the 412 rows to go and find ISSNs for.
 */
function GapStrip({
  gaps,
  total,
  incomplete,
  only,
  onSelect,
  loading,
}: {
  gaps: { key: string; count: number }[]
  total: number
  incomplete: number
  only: string
  onSelect: (value: string) => void
  loading: boolean
}) {
  if (loading) return <SkeletonRows rows={1} rowHeight={40} />

  const clean = gaps.length === 0

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1">
        <div>
          <ColumnLabel className="block">
            {only ? "Rows matching this filter" : "Rows in the submission"}
          </ColumnLabel>
          <p className="text-2xl font-semibold tabular">{total.toLocaleString("en-IN")}</p>
        </div>
        {clean ? (
          <Meta className="text-positive">
            Every row carries everything an assessor asks for.
          </Meta>
        ) : (
          <Meta>
            {incomplete.toLocaleString("en-IN")} would be sent back. Each button below is the
            list of rows to fix, across the whole filter rather than this page.
          </Meta>
        )}
      </div>

      {!clean && (
        <div className="flex flex-wrap items-center gap-1">
          <GapChip active={only === ""} onClick={() => onSelect("")}>
            Everything
          </GapChip>
          <GapChip active={only === "incomplete"} onClick={() => onSelect("incomplete")}>
            Anything missing · {incomplete}
          </GapChip>
          {gaps.map((g) => (
            <GapChip key={g.key} active={only === g.key} onClick={() => onSelect(g.key)}>
              {g.key} · {g.count}
            </GapChip>
          ))}
        </div>
      )}
    </div>
  )
}

function GapChip({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "h-7 rounded-sm px-2 text-sm transition-colors duration-[var(--dur-1)] ease-out",
        active ? "bg-selected font-medium text-fg" : "text-fg-muted hover:bg-hover hover:text-fg"
      )}
    >
      {children}
    </button>
  )
}

/* ------------------------------------------------------------------------ */
/* The rows                                                                  */
/* ------------------------------------------------------------------------ */

const COLUMNS: { field: string; header: string; width?: string }[] = [
  { field: "paper_title", header: "Title of paper" },
  { field: "owner_name", header: "Author", width: "w-44" },
  { field: "journal_title", header: "Journal", width: "w-56" },
  { field: "publication_year", header: "Year", width: "w-20" },
  { field: "issn", header: "ISSN", width: "w-28" },
  { field: "link", header: "Link", width: "w-24" },
  { field: "ugc_care", header: "UGC-CARE", width: "w-24" },
]

function PackTable({
  rows,
  editable,
  mayEdit,
  onEdit,
}: {
  rows: PackRow[]
  editable: Record<string, string>
  mayEdit: boolean
  onEdit: (row: PackRow, field: string) => void
}) {
  return (
    <TableScroller minWidth="72rem">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr>
            {COLUMNS.map((c) => (
              <th key={c.field} scope="col" className={cn(stickyHeadCell, c.width)}>
                <ColumnLabel>{c.header}</ColumnLabel>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} className="row border-b border-line last:border-b-0">
              {COLUMNS.map((c) => {
                const raw = row[c.field as keyof PackRow]
                const value = raw === null || raw === undefined ? "" : String(raw)
                // A gap is not a blank cell; it is the specific thing an
                // assessor will name when they send the row back. So it is
                // shown in their words, in the critical colour, in place of
                // the empty string.
                const gap = gapFor(c.field, row)
                const canEdit = mayEdit && row.source !== "record" && Boolean(editable[editableFieldFor(c.field)])

                return (
                  <td key={c.field} className="max-w-[24rem] px-3 py-2 align-middle">
                    <span className="flex items-center gap-1">
                      <span className="min-w-0 flex-1 truncate">
                        {gap ? (
                          <span className="text-critical">{gap}</span>
                        ) : c.field === "link" && value ? (
                          <a
                            href={value}
                            target="_blank"
                            rel="noreferrer noopener"
                            className="text-accent underline-offset-2 hover:underline"
                          >
                            Open
                          </a>
                        ) : c.field === "ugc_care" ? (
                          <span
                            className={cn(
                              value === "Yes" && "text-positive",
                              value === "Not checked" && "text-fg-subtle"
                            )}
                          >
                            {value}
                          </span>
                        ) : c.field === "owner_name" && value ? (
                          <span className="flex min-w-0 items-center gap-2">
                            <Avatar
                              person={{ name: value, initials: initialsOf(value), photo_url: row.owner_photo_url ?? null }}
                              size="xs"
                            />
                            <span className="truncate">{value}</span>
                          </span>
                        ) : c.field === "paper_title" && row.source === "record" ? (
                          <span title="On the college publication record; nobody has filed a claim for it">
                            {value}
                            <Meta className="ml-1.5">not claimed</Meta>
                          </span>
                        ) : (
                          value || "Not recorded"
                        )}
                      </span>
                      {canEdit && (
                        <button
                          type="button"
                          onClick={() => onEdit(row, editableFieldFor(c.field))}
                          className="reveal shrink-0 text-fg-subtle hover:text-fg"
                          aria-label={`Correct ${c.header} on ${row.paper_title || "this row"}`}
                        >
                          <Pencil className="size-3.5" />
                        </button>
                      )}
                    </span>
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </TableScroller>
  )
}

/** The link column is stored as `scopus_url`; everything else edits itself. */
function editableFieldFor(column: string): string {
  return column === "link" ? "scopus_url" : column
}

/** The assessor's own words for what this cell is missing, or null. */
function gapFor(column: string, row: PackRow): string | null {
  const labels: Record<string, string> = {
    paper_title: "No title",
    owner_name: "No author",
    journal_title: "No journal",
    publication_year: "No year",
    issn: "No ISSN",
    link: "No link to the paper",
  }
  const label = labels[column]
  return label && row.gaps.includes(label) ? label : null
}

/* ------------------------------------------------------------------------ */
/* Correcting one field                                                      */
/* ------------------------------------------------------------------------ */

function EditFieldDialog({
  row,
  field,
  label,
  onClose,
}: {
  row: PackRow
  field: string
  label: string
  onClose: () => void
}) {
  const before = String(row[field as keyof PackRow] ?? "")
  const [value, setValue] = useState(before)
  const [reason, setReason] = useState("")

  const edit = useApiMutation<{ field: string; value: string; reason: string }, unknown>(
    `/api/reports/pack/rows/${row.id}`,
    { method: "PATCH", invalidates: [["reports", "pack"]] }
  )

  const trimmed = reason.trim()
  const tooShort = trimmed.length > 0 && trimmed.length < 5
  const canSubmit = trimmed.length >= 5 && value !== before && !edit.isPending

  async function submit() {
    try {
      await edit.mutateAsync({ field, value: value.trim(), reason: trimmed })
      toast.ok(`Corrected. ${label} on “${short(row.paper_title)}”`)
      onClose()
    } catch (err) {
      toast.fail(err)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>Correct {label.toLowerCase()}</DialogTitle>
          <DialogDescription>
            On “{short(row.paper_title)}”
            {row.owner_name ? `, ${row.owner_name}` : ""}. This corrects the publication record
            itself, not just the submission — and it cannot touch the amount or the stage.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          <Field label={label}>
            <Input value={value} onChange={(e) => setValue(e.target.value)} autoFocus />
          </Field>
          <Field
            label="Reason"
            hint="Where the correct value came from. Written to the audit log."
            error={tooShort ? "At least 5 characters." : undefined}
          >
            <Textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={2}
              placeholder="ISSN taken from the journal's own site"
            />
          </Field>
        </DialogBody>
        <DialogFooter>
          <Button kind="quiet" onClick={onClose} disabled={edit.isPending}>
            Cancel
          </Button>
          <Button kind="primary" disabled={!canSubmit} onClick={() => void submit()}>
            {edit.isPending ? "Saving…" : "Save the correction"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/* ------------------------------------------------------------------------ */
/* Export                                                                    */
/* ------------------------------------------------------------------------ */

/**
 * The pack, in whichever format the office is asked for it in this year.
 *
 * The export follows the year filter but deliberately **not** the gap filter:
 * a submission containing only the broken rows is not a submission, and a
 * button that quietly wrote one would be found out at the worst moment.
 */
function ExportMenu({ filters }: { filters: URLSearchParams }) {
  return (
    <div className="flex items-center gap-1">
      <Meta className="mr-1">Also download as</Meta>
      {EXPORT_FORMATS.map((fmt) => {
        const query = new URLSearchParams(filters)
        query.delete("q")
        query.set("fmt", fmt)
        return (
          <Button key={fmt} kind="quiet" size="sm" asChild>
            <a href={`/api/reports/pack?${query.toString()}`} download>
              {fmt}
            </a>
          </Button>
        )
      })}
    </div>
  )
}

/* ------------------------------------------------------------------------ */
/* Helpers                                                                   */
/* ------------------------------------------------------------------------ */

/** The window an accreditation cycle ever asks about. */
function recentYears(): number[] {
  const now = new Date().getFullYear()
  return Array.from({ length: 12 }, (_, i) => now - i)
}

function short(title: string): string {
  const t = (title || "Untitled").trim()
  return t.length > 52 ? `${t.slice(0, 49)}…` : t
}
