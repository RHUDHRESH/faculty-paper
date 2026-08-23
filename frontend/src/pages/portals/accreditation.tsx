"use client"

import { useEffect, useState } from "react"
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  FileJson,
  FileSpreadsheet,
  FileText,
  FileType,
  Pencil,
} from "lucide-react"
import { toast } from "sonner"

import { DataTable } from "@/components/data-table"
import { JournalLink } from "@/components/journal-link"
import { PaperLink } from "@/components/paper-link"
import { ErrorState, PageHeader, Section } from "@/components/layout/page"
import { LoadingPage } from "@/components/loading"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Pager } from "@/components/ui/pagination"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { api, API_BASE } from "@/lib/api"
import { useApiQuery } from "@/lib/queries"
import { cn } from "@/lib/utils"

/**
 * The submission, as something to work through rather than look at.
 *
 * The pack was a download button at the foot of the reports page, so the only
 * way to see what was in it was to open a workbook. Showing the tables fixed
 * half of that. The other half is what the office actually does with this
 * data:
 *
 * - **Find what will fail.** NAAC 3.4.3 asks for a title, an author, a
 *   department, a journal, a year, an ISSN and a link. A row missing any of
 *   those comes back from the assessor. Fifteen hundred of the college's three
 *   thousand rows are missing at least one, and nothing said which.
 * - **Fix it.** Usually the data exists and the ERP import dropped it. Each
 *   row can be corrected here, one field at a time with a reason, recorded
 *   against the ticket and in the audit log.
 *
 * What cannot be changed from this screen is anything to do with money or a
 * ticket's stage. The pack holds no money, and a screen for tidying a
 * submission must not be able to move a payment. The server enforces that;
 * this page only offers the fields it allows.
 */

type Row = {
  id: string
  ticket_number: string | null
  paper_title: string
  owner_id: string | null
  owner_name: string
  owner_department: string
  journal_title: string
  publication_year: number | string
  issn: string
  doi: string
  scopus_url: string
  link: string
  ugc_care: string
  gaps: string[]
}

type RowsResponse = {
  total: number
  limit: number
  offset: number
  results: Row[]
  gaps: { key: string; count: number }[]
  incomplete: number
  ugc_list_loaded: boolean
  editable: Record<string, string>
}

type Table = {
  name: string
  columns: string[]
  rows: (string | number | null)[][]
  row_count: number
}

const FORMATS = [
  { fmt: "xlsx", label: "Excel", icon: FileSpreadsheet, hint: "Every table, one tab each." },
  { fmt: "pdf", label: "PDF", icon: FileText, hint: "Laid out to read and sign." },
  {
    fmt: "docx",
    label: "Word",
    icon: FileType,
    hint: "Real tables, for pasting into a submission.",
  },
  { fmt: "csv", label: "CSV", icon: FileSpreadsheet, hint: "One table only; it names the rest." },
  { fmt: "json", label: "JSON", icon: FileJson, hint: "For another system to read." },
] as const

const ALL = "__all__"
const ANY_GAP = "__any__"
const PAGE = 50

export function AccreditationPage() {
  const [year, setYear] = useState(ALL)
  const [q, setQ] = useState("")
  const [debouncedQ, setDebouncedQ] = useState("")
  const [gap, setGap] = useState("")
  const [offset, setOffset] = useState(0)
  const [editing, setEditing] = useState<Row | null>(null)

  useEffect(() => {
    const t = setTimeout(() => {
      setDebouncedQ(q)
      setOffset(0)
    }, 300)
    return () => clearTimeout(t)
  }, [q])

  const suffix = year === ALL ? "" : `&year=${year}`
  const rowsQuery = [
    debouncedQ.trim() ? `q=${encodeURIComponent(debouncedQ.trim())}` : "",
    gap ? `only=${encodeURIComponent(gap === ANY_GAP ? "incomplete" : gap)}` : "",
    `limit=${PAGE}`,
    `offset=${offset}`,
  ]
    .filter(Boolean)
    .join("&")

  const {
    data: rows,
    isLoading,
    isError,
    refetch,
  } = useApiQuery<RowsResponse>(
    ["pack-rows", year, debouncedQ, gap, offset],
    `/api/reports/pack/rows?${rowsQuery}${suffix}`
  )

  const { data: pack } = useApiQuery<{ tables: Table[] }>(
    ["pack-preview", year],
    `/api/reports/pack?fmt=preview${suffix}`
  )

  const { data: report } = useApiQuery<{ by_year?: { key: string }[] }>(
    ["reports", "years"],
    "/api/reports"
  )
  const years = (report?.by_year || [])
    .map((r) => r.key)
    .filter((k) => /^\d{4}$/.test(k))
    .sort()
    .reverse()

  if (isError) return <ErrorState onRetry={() => refetch()} />
  if (isLoading || !rows) return <LoadingPage />

  const href = (fmt: string) => `${API_BASE}/api/reports/pack?fmt=${fmt}${suffix}`
  const complete = rows.total - rows.incomplete

  return (
    <div className="space-y-6">
      <PageHeader
        title="Accreditation"
        subtitle="The NAAC and NIRF tables, built from what the system already holds"
        actions={
          <Select
            value={year}
            onValueChange={(v) => {
              setYear(v)
              setOffset(0)
            }}
          >
            <SelectTrigger className="w-44" aria-label="Publication year">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All years on record</SelectItem>
              {years.map((y) => (
                <SelectItem key={y} value={y}>
                  {y}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        }
      />

      {/* ---- what an assessor would send back ------------------------- */}
      <Section
        title="Before you file it"
        description="Every row NAAC asks a question about that this data cannot answer"
      >
        <div className="surface-card p-5">
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <p className="text-sm">
              <span className="text-2xl font-semibold tabular-nums">
                {complete.toLocaleString()}
              </span>{" "}
              <span className="text-muted-foreground">
                of {rows.total.toLocaleString()} rows are complete
              </span>
            </p>
            {rows.incomplete ? (
              <span className="inline-flex items-center gap-1.5 text-sm text-warning-foreground">
                <AlertTriangle className="size-4" aria-hidden />
                {rows.incomplete.toLocaleString()} would come back
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5 text-sm text-success">
                <CheckCircle2 className="size-4" aria-hidden />
                Nothing missing
              </span>
            )}
          </div>

          <div className="mt-3 h-2 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-success transition-[width] duration-500"
              style={{ width: `${rows.total ? (complete / rows.total) * 100 : 0}%` }}
            />
          </div>

          {/* Each gap is a filter, because "1,412 rows have no ISSN" is only
              useful if the next click is those 1,412 rows. */}
          <div className="mt-4 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => {
                setGap(gap === ANY_GAP ? "" : ANY_GAP)
                setOffset(0)
              }}
              className={cn(
                "interactive rounded-full border px-3 py-1 text-xs",
                gap === ANY_GAP
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-border hover:border-primary/40"
              )}
            >
              Anything missing · {rows.incomplete.toLocaleString()}
            </button>
            {rows.gaps
              .filter((g) => g.count > 0)
              .map((g) => (
                <button
                  key={g.key}
                  type="button"
                  onClick={() => {
                    setGap(gap === g.key ? "" : g.key)
                    setOffset(0)
                  }}
                  className={cn(
                    "interactive rounded-full border px-3 py-1 text-xs",
                    gap === g.key
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-border hover:border-primary/40"
                  )}
                >
                  {g.key} · {g.count.toLocaleString()}
                </button>
              ))}
            {gap ? (
              <button
                type="button"
                onClick={() => {
                  setGap("")
                  setOffset(0)
                }}
                className="interactive text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
              >
                Show all rows
              </button>
            ) : null}
          </div>

          {!rows.ugc_list_loaded ? (
            <p className="mt-4 text-xs text-muted-foreground">
              No UGC-CARE list has been loaded, so that column reads “Not checked” on every row
              — which is the truth, and better than an assessor reading a “No” nobody verified.
              Load one under Journal data and it will answer.
            </p>
          ) : null}
        </div>
      </Section>

      {/* ---- the rows themselves -------------------------------------- */}
      <Section
        title="NAAC 3.4.3"
        description={`${rows.total.toLocaleString()} row${rows.total === 1 ? "" : "s"}${
          gap ? " matching that filter" : ""
        } — click the pencil to correct one`}
        actions={
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Title, author, journal, ticket…"
            className="w-64"
            aria-label="Search the submission rows"
          />
        }
      >
        <DataTable
          rows={rows.results}
          getKey={(r) => r.id}
          minWidth="72rem"
          empty={gap ? "No rows with that gap — nothing to fix here" : "No rows"}
          columns={[
            {
              key: "state",
              header: "",
              className: "w-8",
              cell: (r) =>
                r.gaps.length ? (
                  <span title={r.gaps.join(", ")}>
                    <AlertTriangle className="size-4 text-warning-foreground" aria-hidden />
                  </span>
                ) : (
                  <span title="Complete">
                    <CheckCircle2 className="size-4 text-success/70" aria-hidden />
                  </span>
                ),
            },
            {
              key: "paper",
              header: "Title of paper",
              className: "max-w-[22rem]",
              cell: (r) => (
                <>
                  <span className="line-clamp-2">{r.paper_title || "—"}</span>
                  {r.gaps.length ? (
                    <span className="mt-1 flex flex-wrap gap-1">
                      {r.gaps.map((g) => (
                        <Badge
                          key={g}
                          variant="outline"
                          className="border-warning/30 bg-warning/10 text-[10px] font-normal text-warning-foreground"
                        >
                          {g}
                        </Badge>
                      ))}
                    </span>
                  ) : null}
                </>
              ),
            },
            { key: "author", header: "Author", cell: (r) => r.owner_name || "—" },
            {
              key: "dept",
              header: "Department",
              className: "text-muted-foreground",
              cell: (r) => r.owner_department || "—",
            },
            {
              key: "journal",
              header: "Journal",
              className: "max-w-[14rem]",
              cell: (r) => <JournalLink title={r.journal_title} portal="/admin" />,
            },
            {
              key: "year",
              header: "Year",
              align: "right",
              cell: (r) => r.publication_year || "—",
            },
            {
              key: "issn",
              header: "ISSN",
              className: "font-mono text-xs",
              cell: (r) => r.issn || <span className="text-muted-foreground">—</span>,
            },
            {
              key: "link",
              header: "Link",
              cell: (r) => <PaperLink doi={r.doi} scopusUrl={r.scopus_url} compact />,
            },
            {
              key: "ugc",
              header: "UGC-CARE",
              cell: (r) => (
                <span
                  className={cn(
                    "text-xs",
                    r.ugc_care === "Not checked" && "text-muted-foreground"
                  )}
                >
                  {r.ugc_care}
                </span>
              ),
            },
            {
              key: "edit",
              header: "",
              className: "w-10",
              cell: (r) => (
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  onClick={() => setEditing(r)}
                  aria-label={`Correct ${r.ticket_number || "this row"}`}
                >
                  <Pencil className="size-3.5" />
                </Button>
              ),
            },
          ]}
        />
        <Pager total={rows.total} limit={PAGE} offset={offset} onOffsetChange={setOffset} />
      </Section>

      {/* ---- download ------------------------------------------------- */}
      <Section
        title="Download"
        description="The same tables, in whichever shape the next person needs"
      >
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {FORMATS.map((f) => {
            const Icon = f.icon
            return (
              <a
                key={f.fmt}
                href={href(f.fmt)}
                className={cn(
                  "interactive group flex items-start gap-3 rounded-[var(--radius)] border border-border bg-card p-4",
                  "transition-colors hover:border-primary/40 hover:bg-accent/40"
                )}
              >
                <span className="flex size-9 shrink-0 items-center justify-center rounded-md border border-border bg-muted text-muted-foreground transition-colors group-hover:border-primary/25 group-hover:bg-primary/10 group-hover:text-primary">
                  <Icon className="size-4" aria-hidden />
                </span>
                <span className="min-w-0">
                  <span className="flex items-center gap-1.5 text-sm font-medium">
                    {f.label}
                    <Download className="size-3 text-muted-foreground" aria-hidden />
                  </span>
                  <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">
                    {f.hint}
                  </span>
                </span>
              </a>
            )
          })}
        </div>
      </Section>

      {/* ---- the other sheets ----------------------------------------- */}
      {(pack?.tables || [])
        .filter((t) => t.name !== "NAAC 3.4.3")
        .map((t) => (
          <Section
            key={t.name}
            title={t.name}
            description={
              t.name === "Notes"
                ? "What each figure counts, and what could not be produced"
                : `${t.row_count.toLocaleString()} row${t.row_count === 1 ? "" : "s"}${
                    t.row_count > t.rows.length
                      ? ` — first ${t.rows.length} here, all of them in the download`
                      : ""
                  }`
            }
          >
            <DataTable
              rows={t.rows}
              getKey={(_r, i) => `${t.name}-${i}`}
              minWidth={t.columns.length > 5 ? "60rem" : undefined}
              empty="No rows for this year"
              columns={t.columns.map((c, i) => ({
                key: `${c}-${i}`,
                header: c,
                className: t.name === "Notes" && i === 0 ? "font-medium" : "max-w-[24rem]",
                align:
                  t.name !== "Notes" && t.rows.length && typeof t.rows[0][i] === "number"
                    ? ("right" as const)
                    : undefined,
                cell: (row: (string | number | null)[]) => {
                  const v = row[i]
                  if (v === null || v === undefined || v === "") {
                    return <span className="text-muted-foreground">—</span>
                  }
                  return <span className="line-clamp-3">{String(v)}</span>
                },
              }))}
            />
          </Section>
        ))}

      <p className="text-xs text-muted-foreground">
        Nothing here is invented. Citation counts and top-percentile placement are not held
        anywhere in this system, so NIRF’s quality-of-publication metrics are absent rather than
        estimated. The Notes table says so in the file itself, where an assessor will see it.
      </p>

      <CorrectRowDialog
        row={editing}
        fields={rows.editable}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null)
          refetch()
        }}
      />
    </div>
  )
}

/**
 * One field, one reason, recorded.
 *
 * Following the data explorer rather than inventing a second convention: a
 * grid that lets somebody change forty things and press save produces an audit
 * entry nobody can reconstruct a decision from.
 */
function CorrectRowDialog({
  row,
  fields,
  onClose,
  onSaved,
}: {
  row: Row | null
  fields: Record<string, string>
  onClose: () => void
  onSaved: () => void
}) {
  const names = Object.keys(fields || {})
  const [field, setField] = useState(names[0] || "paper_title")
  const [value, setValue] = useState("")
  const [reason, setReason] = useState("")
  const [busy, setBusy] = useState(false)
  const rowId = row?.id

  // Reopening on a different row must not carry the last row's typing over.
  useEffect(() => {
    if (!row) return
    const first = names[0] || "paper_title"
    setField(first)
    setValue(String((row as unknown as Record<string, unknown>)[first] ?? ""))
    setReason("")
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rowId])

  useEffect(() => {
    if (!row) return
    setValue(String((row as unknown as Record<string, unknown>)[field] ?? ""))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [field])

  if (!row) return null

  async function save() {
    if (!row) return
    setBusy(true)
    try {
      await api(`/api/reports/pack/rows/${row.id}`, {
        method: "PATCH",
        body: JSON.stringify({ field, value, reason }),
      })
      toast.success("Corrected — recorded against the ticket")
      onSaved()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save that")
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={(v) => (v ? null : onClose())}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-left leading-snug">Correct this row</DialogTitle>
          <DialogDescription className="text-left">
            <span className="font-mono">{row.ticket_number || "—"}</span> · {row.owner_name}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <p className="line-clamp-2 rounded-[var(--radius)] border border-border bg-muted/40 px-3 py-2 text-sm">
            {row.paper_title || "Untitled"}
          </p>

          <div className="space-y-1.5">
            <Label>What is wrong</Label>
            <Select value={field} onValueChange={setField}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {names.map((f) => (
                  <SelectItem key={f} value={f}>
                    {fields[f]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="pack-value">{fields[field]}</Label>
            <Input
              id="pack-value"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="Leave blank to clear it"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="pack-reason">Why</Label>
            <Input
              id="pack-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. ISSN taken from the printed copy"
            />
            <p className="text-xs text-muted-foreground">
              Recorded against the ticket and in the audit log. Money and the ticket’s stage
              cannot be changed from here.
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={save} disabled={busy || reason.trim().length < 5}>
            {busy ? "Saving…" : "Save correction"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
