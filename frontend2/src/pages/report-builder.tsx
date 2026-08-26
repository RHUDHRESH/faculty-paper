import { useState } from "react"
import { useSearchParams } from "react-router-dom"
import { BarChart3, Download, Table2 } from "lucide-react"

import { can, useAuth } from "@/app/auth"
import { cn } from "@/lib/cn"
import { useApi } from "@/lib/query"
import { Button } from "@/ui/button"
import { Combobox, type ComboboxOption } from "@/ui/combobox"
import { money } from "@/ui/paper"
import { Callout, ErrorState, SkeletonRows } from "@/ui/state"
import { stickyHeadCell, TableScroller } from "@/ui/table"
import { ColumnLabel, Meta, PageTitle, SectionTitle, Sub } from "@/ui/text"

/**
 * Build a report, look at it, take it away.
 *
 * The three things a principal asked for are one thing: a report is only
 * useful if what you looked at on screen is exactly what lands in the
 * workbook. So the preview and every download come from the same
 * `/api/reports/build` call, with `fmt` as the only difference between them.
 * Two code paths — one to draw the page, one to write the file — is how a
 * printed figure and a projected figure end up disagreeing in a meeting.
 *
 * The one thing this screen refuses to do is add up money across a dimension
 * where a paper appears more than once. A paper spanning four subject areas
 * has its full amount counted under each, so summing the column gives ₹12.6
 * crore against an actual ₹2.8 crore of payouts. Per-row amounts still mean
 * something; the total does not, and the server returns null for it rather
 * than a number nobody should quote.
 */

/* ------------------------------------------------------------------------ */
/* Data — read out of reports_build() in backend/core/api.py                */
/* ------------------------------------------------------------------------ */

type BuiltRow = { key: string; count: number; amount: number }

type BuiltTable = {
  key: string
  label: string
  rows: BuiltRow[]
  row_count: number
  truncated: number
  /** One paper appears in several rows; the money total is withheld. */
  overlapping: boolean
  totals: { count: number; amount: number | null }
}

type BuildPayload = {
  tables: BuiltTable[]
  filters: { year: number | null; department: string | null; month: string | null }
  subtitle: string
  available: { key: string; label: string }[]
  years: number[]
}

const FORMATS = ["xlsx", "pdf", "docx", "csv", "json"] as const
type Measure = "count" | "amount"
type View = "table" | "bars"

/* ------------------------------------------------------------------------ */
/* Page                                                                      */
/* ------------------------------------------------------------------------ */

export function ReportBuilder() {
  const { me } = useAuth()
  const allowed = can(me?.role).viewReports

  const [searchParams, setSearchParams] = useSearchParams()
  const dimensions = searchParams.get("dimensions") || "department"
  const year = searchParams.get("year") ?? ""
  const department = searchParams.get("department") ?? ""
  const [measure, setMeasure] = useState<Measure>("count")
  const [view, setView] = useState<View>("bars")

  function setParam(key: string, value: string) {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev)
      if (value) next.set(key, value)
      else next.delete(key)
      return next
    })
  }

  const chosen = dimensions.split(",").filter(Boolean)

  function toggleDimension(key: string) {
    const next = chosen.includes(key)
      ? chosen.filter((d) => d !== key)
      : [...chosen, key]
    // Never zero: the server refuses an empty breakdown, and a screen that
    // lets you reach a state the server rejects is a screen that breaks.
    setParam("dimensions", next.length ? next.join(",") : key)
  }

  const query = new URLSearchParams({ dimensions, limit: "100" })
  if (year) query.set("year", year)
  if (department) query.set("department", department)

  const { data, isLoading, isError, error, refetch } = useApi<BuildPayload>(
    ["reports", "build", dimensions, year, department],
    `/api/reports/build?${query.toString()}`,
    { enabled: allowed, placeholderData: (prev) => prev }
  )

  const departments = useApi<string[]>(["meta", "departments"], "/api/meta/departments", {
    enabled: allowed,
  })

  if (!allowed) {
    return (
      <div className="page py-8">
        <ErrorState
          title="Not open to this account"
          message="Reports are college-wide. A head of department sees their own department's publications instead."
        />
      </div>
    )
  }

  // The download carries the same filters and the same breakdowns as the
  // screen, because it is literally the same request with a format on it.
  const downloadQuery = new URLSearchParams(query)
  downloadQuery.delete("limit")

  const yearOptions: ComboboxOption[] = [
    { value: "", label: "All years on record" },
    ...(data?.years ?? []).map((y) => ({ value: String(y), label: String(y) })),
  ]
  const departmentOptions: ComboboxOption[] = [
    { value: "", label: "Every department" },
    ...(departments.data ?? []).map((d) => ({ value: d, label: d })),
  ]

  return (
    <div className="page space-y-6">
      <header>
        <PageTitle>Build a report</PageTitle>
        <Sub className="mt-1">
          Choose what to break the figures down by, look at it, and take away exactly what you
          are looking at.
        </Sub>
      </header>

      {/* ---- what to break it down by ---- */}
      <section className="space-y-2">
        <ColumnLabel className="block">Break down by</ColumnLabel>
        <div className="flex flex-wrap gap-1">
          {(data?.available ?? []).map((d) => (
            <Chip
              key={d.key}
              active={chosen.includes(d.key)}
              onClick={() => toggleDimension(d.key)}
            >
              {d.label}
            </Chip>
          ))}
        </div>
      </section>

      {/* ---- filters and presentation ---- */}
      <div className="flex flex-wrap items-end gap-3 border-y border-line py-3">
        <div>
          <ColumnLabel className="mb-1 block">Publication year</ColumnLabel>
          <Combobox
            value={year}
            onChange={(v) => setParam("year", v)}
            options={yearOptions}
            aria-label="Publication year"
            className="w-44"
          />
        </div>
        <div>
          <ColumnLabel className="mb-1 block">Department</ColumnLabel>
          <Combobox
            value={department}
            onChange={(v) => setParam("department", v)}
            options={departmentOptions}
            placeholder="Every department"
            aria-label="Department"
            className="w-52"
          />
        </div>
        <div>
          <ColumnLabel className="mb-1 block">Measure</ColumnLabel>
          <div className="flex gap-1">
            <Chip active={measure === "count"} onClick={() => setMeasure("count")}>
              Publications
            </Chip>
            <Chip active={measure === "amount"} onClick={() => setMeasure("amount")}>
              Amount
            </Chip>
          </div>
        </div>
        <div>
          <ColumnLabel className="mb-1 block">As</ColumnLabel>
          <div className="flex gap-1">
            <Chip active={view === "bars"} onClick={() => setView("bars")}>
              <BarChart3 className="size-3.5" aria-hidden />
              Chart
            </Chip>
            <Chip active={view === "table"} onClick={() => setView("table")}>
              <Table2 className="size-3.5" aria-hidden />
              Table
            </Chip>
          </div>
        </div>

        <div className="ml-auto flex items-end gap-1">
          <Meta className="mr-1 pb-1.5">Download</Meta>
          {FORMATS.map((fmt) => (
            <Button key={fmt} kind={fmt === "xlsx" ? "default" : "quiet"} size="sm" asChild>
              <a
                href={`/api/reports/build?${downloadQuery.toString()}&fmt=${fmt}`}
                download
              >
                {fmt === "xlsx" && <Download />}
                {fmt}
              </a>
            </Button>
          ))}
        </div>
      </div>

      {data?.subtitle && <Meta className="block">{data.subtitle}</Meta>}

      {isLoading && !data ? (
        <SkeletonRows rows={10} rowHeight={32} />
      ) : isError ? (
        <ErrorState
          title="Could not build that report"
          message={
            error?.status === 403
              ? "Not allowed. Reports are open to the office, the Principal, the Director and Finance."
              : error?.message || "The server did not answer."
          }
          onRetry={error?.status === 403 ? undefined : () => refetch()}
        />
      ) : (
        (data?.tables ?? []).map((table) => (
          <ReportTable key={table.key} table={table} measure={measure} view={view} />
        ))
      )}
    </div>
  )
}

/* ------------------------------------------------------------------------ */
/* One breakdown                                                             */
/* ------------------------------------------------------------------------ */

function ReportTable({
  table,
  measure,
  view,
}: {
  table: BuiltTable
  measure: Measure
  view: View
}) {
  // Money is meaningless as a total on an overlapping dimension, and choosing
  // to look at money there is a fair thing to want — so the rows still show
  // it and only the total is withheld.
  const showMoneyTotal = !table.overlapping && table.totals.amount != null

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <SectionTitle>{table.label}</SectionTitle>
        <Meta className="tabular">
          {table.row_count.toLocaleString("en-IN")} rows ·{" "}
          {table.totals.count.toLocaleString("en-IN")}{" "}
          {table.overlapping ? "appearances" : "publications"}
          {showMoneyTotal ? ` · ${money(table.totals.amount)}` : ""}
        </Meta>
      </div>

      {table.overlapping && (
        <Callout tone="caution" title="One paper appears in more than one row here">
          A paper spanning several {table.label.toLowerCase()}s is counted under each, so the
          rows add to more than the number of papers — and the amounts cannot be added at all.
          The per-row figures are real; there is deliberately no money total.
        </Callout>
      )}

      {table.truncated > 0 && (
        <Meta className="block">
          Showing the {table.rows.length} largest. {table.truncated.toLocaleString("en-IN")} more
          are in the download.
        </Meta>
      )}

      {view === "bars" ? (
        <Bars rows={table.rows} measure={measure} />
      ) : (
        <Rows rows={table.rows} label={table.label} />
      )}
    </section>
  )
}

/**
 * Ranked bars, drawn against the largest row rather than against the total.
 *
 * Against the total, a well-spread breakdown across thirty departments draws
 * thirty bars all under 4% wide, which is a picture of nothing. Against the
 * largest, the shape of the distribution is the thing you see.
 */
function Bars({ rows, measure }: { rows: BuiltRow[]; measure: Measure }) {
  const value = (r: BuiltRow) => (measure === "amount" ? r.amount : r.count)
  const max = Math.max(...rows.map(value), 1)
  const shown = rows.slice(0, 25)

  if (rows.length === 0) {
    return (
      <p className="border-y border-line py-10 text-center text-sm text-fg-muted">
        Nothing matches these filters.
      </p>
    )
  }

  return (
    <ul className="space-y-1.5 border-y border-line py-3">
      {shown.map((r) => (
        <li key={r.key} className="grid grid-cols-[minmax(0,14rem)_1fr_auto] items-center gap-3">
          <span className="truncate text-sm" title={r.key}>
            {r.key}
          </span>
          <span className="h-2 w-full overflow-hidden rounded-full bg-sunken" aria-hidden>
            <span
              className="block h-full rounded-full bg-accent transition-[width] duration-500"
              style={{ width: `${(value(r) / max) * 100}%` }}
            />
          </span>
          <span className="shrink-0 text-sm tabular">
            {measure === "amount" ? money(r.amount) : r.count.toLocaleString("en-IN")}
          </span>
        </li>
      ))}
      {rows.length > shown.length && (
        <li className="pt-1">
          <Meta>
            {rows.length - shown.length} smaller rows not drawn — the table view and the
            download have all of them.
          </Meta>
        </li>
      )}
    </ul>
  )
}

/** Every chart here is also a table, because a bar cannot be read to the rupee. */
function Rows({ rows, label }: { rows: BuiltRow[]; label: string }) {
  if (rows.length === 0) {
    return (
      <p className="border-y border-line py-10 text-center text-sm text-fg-muted">
        Nothing matches these filters.
      </p>
    )
  }

  return (
    <TableScroller minWidth="36rem" maxHeight="min(32rem, 60vh)">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr>
            <th scope="col" className={stickyHeadCell}>
              <ColumnLabel>{label}</ColumnLabel>
            </th>
            <th scope="col" className={cn(stickyHeadCell, "w-32 text-right")}>
              <ColumnLabel>Publications</ColumnLabel>
            </th>
            <th scope="col" className={cn(stickyHeadCell, "w-40 text-right")}>
              <ColumnLabel>Amount</ColumnLabel>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key} className="row border-b border-line last:border-b-0">
              <td className="px-3 py-2 align-middle">{r.key}</td>
              <td className="px-3 py-2 text-right align-middle tabular">
                {r.count.toLocaleString("en-IN")}
              </td>
              <td className="px-3 py-2 text-right align-middle tabular">{money(r.amount)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableScroller>
  )
}

function Chip({
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
        "inline-flex h-7 items-center gap-1.5 rounded-sm px-2 text-sm",
        "transition-colors duration-[var(--dur-1)] ease-out",
        active ? "bg-selected font-medium text-fg" : "text-fg-muted hover:bg-hover hover:text-fg"
      )}
    >
      {children}
    </button>
  )
}
