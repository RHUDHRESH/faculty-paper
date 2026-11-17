import { plural } from "@/lib/count"
import { useMemo, useState } from "react"
import { BarChart3, ChartLine, ChartPie, Play, Table2 } from "lucide-react"

import { printTable, type ExportFormat } from "@/lib/table-export"
import { Segmented } from "@/ui/toggle"
import { Callout, EmptyState, InlineError, SkeletonRows } from "@/ui/state"
import { Table, type Column } from "@/ui/table"
import { TableToolbar, useTablePrefs } from "@/ui/table-tools"
import { chartColumns, chartKindOf, chartPoints, ResultChart, type ChartKind } from "./result-chart"
import { formatCell, rowObjects, type RunResult } from "./model"

type Row = Record<string, unknown>

/**
 * Step 3: the answer. One table, as big as the page allows, with the same
 * tools every table in the app has (choose columns, grid lines, export), a
 * summary sentence above it, an optional chart, and a plain warning when the
 * server cut the rows short.
 *
 * The Export menu here is the report's own: it asks the server for the whole
 * report as a file, not for the rows that happen to be on screen.
 */
export function StepResult({
  result,
  summary,
  pending,
  error,
  stale,
  title,
  onExport,
}: {
  result: RunResult | null
  summary: string
  pending: boolean
  error: string | null
  /** The report was changed after this result was made. */
  stale: boolean
  title: string
  onExport: (format: ExportFormat | "print") => Promise<unknown> | void
}) {
  if (pending) {
    return (
      <div aria-busy="true" aria-label="Making your report" role="status">
        <SkeletonRows rows={6} />
      </div>
    )
  }
  return (
    <div className="space-y-4">
      {error && <InlineError message={error} />}
      {!result && !error && (
        <EmptyState
          size="compact"
          icon={Play}
          title="Your report will appear here"
          message="Choose what you want in the steps on the left, then press Run report."
        />
      )}
      {result && (
        <>
          <p className="text-lg font-semibold text-fg" role="status" data-testid="result-summary">
            {summary}
          </p>
          {stale && (
            <Callout tone="caution">You have changed the report since this was made. Press Run report to see the new figures.</Callout>
          )}
          {result.truncated && (
            <Callout tone="caution" title="This is not every row">
              Showing the first {result.rows.length.toLocaleString("en-IN")} of {plural(result.total_rows, "row")}. Add a
              condition under “Only where” to narrow it, or use Export to get the whole report in a file.
            </Callout>
          )}
          <ResultView key={result.columns.map((c) => c.key).join("|")} result={result} title={title} onExport={onExport} />
        </>
      )}
    </div>
  )
}

const CHARTS: { id: ChartKind; label: string; icon: React.ReactNode }[] = [
  { id: "bar", label: "Bars", icon: <BarChart3 /> },
  { id: "line", label: "Line", icon: <ChartLine /> },
  { id: "pie", label: "Pie", icon: <ChartPie /> },
]

function ResultView({
  result,
  title,
  onExport,
}: {
  result: RunResult
  title: string
  onExport: (format: ExportFormat | "print") => Promise<unknown> | void
}) {
  const [shape, setShape] = useState<"table" | ChartKind>("table")
  const rows = useMemo(() => rowObjects(result), [result])
  const index = useMemo(() => new Map(rows.map((r, i) => [r, i])), [rows])
  const canChart = chartColumns(result) !== null && chartPoints(result).length > 0
  const suggested = chartKindOf(result.chart_hint)

  const columns: Column<Row>[] = result.columns.map((c) => ({
    key: c.key,
    header: c.label,
    label: c.label,
    align: c.type === "number" || c.type === "money" ? "right" : "left",
    empty: "Not recorded",
    cell: (row) => formatCell(c.type, row[c.key]),
  }))

  const prefs = useTablePrefs(
    "report-studio-result",
    result.columns.map((c) => c.key)
  )
  const shown = columns.filter((c, i) => i === 0 || !prefs.hidden.has(c.key))

  return (
    <div className="space-y-4">
      {canChart && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <span className="text-base font-medium">Show as</span>
          <Segmented
            label="Show the report as a table or a chart"
            value={shape}
            onChange={(id) => setShape(id as "table" | ChartKind)}
            items={[
              { id: "table", label: "Table only", icon: <Table2 /> },
              ...CHARTS.map((c) => ({
                id: c.id,
                label: suggested === c.id ? `${c.label} (best fit)` : c.label,
                icon: c.icon,
              })),
            ]}
          />
        </div>
      )}
      {shape !== "table" && canChart && <ResultChart result={result} kind={shape} />}

      <div className="table-with-tools">
        <div className="hidden print:mb-3 print:block">
          <p className="text-base font-medium">{title}</p>
        </div>
        <TableToolbar
          columns={columns.map((c) => ({ key: c.key, label: c.label ?? c.key }))}
          prefs={prefs}
          onExport={(format) => (format === "print" ? printTable(title) : onExport(format))}
        />
        <Table<Row>
          rows={rows}
          columns={shown}
          getKey={(r) => String(index.get(r))}
          maxHeight="min(70vh, 48rem)"
          minWidth="40rem"
          caption={title}
          empty={{ title: "No rows match", message: "Nothing fits these conditions. Loosen one under “Only where” and run it again." }}
          tableAttrs={{
            "data-grid": prefs.grid ? "true" : undefined,
            "data-density": prefs.density === "compact" ? "compact" : undefined,
          }}
        />
      </div>
    </div>
  )
}
