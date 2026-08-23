"use client"

import { useState } from "react"
import { Download, FileJson, FileSpreadsheet, FileText, FileType } from "lucide-react"

import { DataTable } from "@/components/data-table"
import { ErrorState, PageHeader, Section } from "@/components/layout/page"
import { LoadingPage } from "@/components/loading"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { API_BASE } from "@/lib/api"
import { useApiQuery } from "@/lib/queries"
import { cn } from "@/lib/utils"

/**
 * The tables the college has to file, on a page of their own.
 *
 * The pack existed, as a download button at the bottom of the reports page.
 * That meant the only way to find out what was in it — or whether it was the
 * right year — was to download a workbook and open it, which is a poor way to
 * check something before it goes to an assessor.
 *
 * Each table is shown here, capped, with its real row count beside it, and
 * every one of the five formats is a click away. The Notes table is deliberately
 * given the same weight as the data: a figure in an accreditation submission
 * has to be defensible a year later, and the notes are what make it so.
 */

type Table = {
  name: string
  columns: string[]
  rows: (string | number | null)[][]
  row_count: number
}

const FORMATS = [
  {
    fmt: "xlsx",
    label: "Excel",
    icon: FileSpreadsheet,
    hint: "Every table, one tab each. The working copy.",
  },
  {
    fmt: "pdf",
    label: "PDF",
    icon: FileText,
    hint: "Laid out to read and sign. Long tables are cut, and it says so.",
  },
  {
    fmt: "docx",
    label: "Word",
    icon: FileType,
    hint: "Real tables, for pasting into a submission with a covering note.",
  },
  {
    fmt: "csv",
    label: "CSV",
    icon: FileSpreadsheet,
    hint: "One table only — CSV has no second sheet. Names the ones it left out.",
  },
  {
    fmt: "json",
    label: "JSON",
    icon: FileJson,
    hint: "For another system to read. Rows are objects, not positions.",
  },
] as const

const ALL = "__all__"

export function AccreditationPage() {
  const [year, setYear] = useState(ALL)
  const suffix = year === ALL ? "" : `&year=${year}`

  const { data, isLoading, isError, refetch } = useApiQuery<{
    year: number | null
    tables: Table[]
  }>(["accreditation", year], `/api/reports/pack?fmt=preview${suffix}`)

  // Years come off the reports endpoint, which already knows which ones have
  // anything in them — offering a year with no publications would produce an
  // empty pack somebody might file.
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
  if (isLoading || !data) return <LoadingPage />
  // A payload without tables is a server that answered something else. Say so
  // rather than throwing on .map, which takes the whole page white and leaves
  // the reader with no way to tell what happened.
  if (!Array.isArray(data.tables)) {
    return (
      <ErrorState
        title="The pack came back in a shape this page does not recognise"
        description="Nothing was lost. Retry, and if it persists the API and this page are on different versions."
        onRetry={() => refetch()}
      />
    )
  }

  const href = (fmt: string) => `${API_BASE}/api/reports/pack?fmt=${fmt}${suffix}`

  return (
    <div className="space-y-6">
      <PageHeader
        title="Accreditation"
        subtitle="The NAAC and NIRF tables, built from what the system already holds"
        actions={
          <Select value={year} onValueChange={setYear}>
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

      {data.tables.map((t) => (
        <Section
          key={t.name}
          title={t.name}
          description={
            t.name === "Notes"
              ? "What each figure counts, and what could not be produced"
              : `${t.row_count.toLocaleString()} row${t.row_count === 1 ? "" : "s"}${
                  t.row_count > t.rows.length
                    ? ` — the first ${t.rows.length} shown here, all of them in the download`
                    : ""
                }`
          }
        >
          <DataTable
            rows={t.rows}
            getKey={(_r, i) => `${t.name}-${i}`}
            minWidth={t.columns.length > 5 ? "60rem" : undefined}
            maxHeight="26rem"
            empty="No rows for this year"
            columns={t.columns.map((c, i) => ({
              key: `${c}-${i}`,
              header: c,
              className: t.name === "Notes" && i === 0 ? "font-medium" : "max-w-[24rem]",
              // Numbers right so a column of them can be compared; the Notes
              // table is prose and stays left.
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
        anywhere in this system, so NIRF’s quality-of-publication metrics are absent rather
        than estimated, and the UGC-CARE column reads “Not checked” until a UGC-CARE list has
        been loaded. The Notes table above says so in the file
        itself, where an assessor will see it.
      </p>
    </div>
  )
}
