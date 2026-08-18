"use client"

import { useMemo, useState } from "react"
import { Download } from "lucide-react"

import { EmptyState, ErrorState, PageHeader, Section, StatStrip } from "@/components/layout/page"
import { Money } from "@/components/ticket-ui"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { API_BASE } from "@/lib/api"
import { useApiQuery } from "@/lib/queries"
import { cn } from "@/lib/utils"

type Row = { key: string; count: number; amount: number; label?: string }

type ReportData = {
  totals: {
    publications: number
    count_only: number
    paid_claims: number
    paid_amount: number
    awaiting_payment: number
    committed_amount: number
  }
  by_department: Row[]
  by_quartile: Row[]
  by_category: Row[]
  by_engineering: Row[]
  by_status: Row[]
  by_month: Row[]
  years: number[]
}

const ALL = "__all__"

/**
 * A breakdown that reads counts and money side by side.
 *
 * The scheme records every publication but pays only some, so "how much did we
 * publish" and "how much did we spend" are different questions. Showing one
 * without the other is what sent people to the ledger export to pivot by hand.
 */
function Breakdown({
  title,
  rows,
  showAmount = true,
  empty = "Nothing recorded yet",
}: {
  title: string
  rows: Row[]
  showAmount?: boolean
  empty?: string
}) {
  const max = Math.max(1, ...rows.map((r) => r.count))
  return (
    <Section title={title}>
      <div className="overflow-hidden surface-card">
        {rows.length === 0 ? (
          <p className="px-4 py-6 text-center text-sm text-muted-foreground">{empty}</p>
        ) : (
          <ul className="divide-y divide-border">
            {rows.map((r) => (
              <li key={r.key} className="px-4 py-2.5">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="min-w-0 truncate text-sm text-foreground" title={r.label || r.key}>
                    {r.label || r.key}
                  </span>
                  <span className="flex shrink-0 items-baseline gap-3 text-sm tabular-nums">
                    <span className="font-medium">{r.count}</span>
                    {showAmount ? (
                      <span className="w-24 text-right text-muted-foreground">
                        <Money value={r.amount} />
                      </span>
                    ) : null}
                  </span>
                </div>
                {/* Proportion at a glance — the ranking matters more than the bar. */}
                <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full bg-primary/60"
                    style={{ width: `${Math.round((r.count / max) * 100)}%` }}
                  />
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Section>
  )
}

export function ReportsPage() {
  const [year, setYear] = useState(ALL)
  const [department, setDepartment] = useState(ALL)

  const query = useMemo(() => {
    const qs = new URLSearchParams()
    if (year !== ALL) qs.set("year", year)
    if (department !== ALL) qs.set("department", department)
    const s = qs.toString()
    return s ? `?${s}` : ""
  }, [year, department])

  const { data, isLoading: loading, isError, refetch } = useApiQuery<ReportData>(
    ["reports", year, department],
    `/api/reports${query}`
  )
  const { data: departments = [] } = useApiQuery<string[]>(
    ["meta", "departments"],
    "/api/meta/departments"
  )

  const t = data?.totals

  return (
    <div className="space-y-6">
      <PageHeader
        title="Reports"
        subtitle="Publication output and payouts across the college"
        actions={
          <div className="flex gap-2">
            <Button asChild variant="secondary">
              <a href={`${API_BASE}/api/reports/export${query}`}>
                <Download className="size-4" />
                CSV
              </a>
            </Button>
            <Button asChild variant="secondary">
              {/* A real workbook — the office re-imported the CSV into Excel
                  by hand every month, mangling ISSNs into dates on the way. */}
              <a
                href={`${API_BASE}/api/reports/export${query}${query ? "&" : "?"}fmt=xlsx`}
              >
                <Download className="size-4" />
                Excel
              </a>
            </Button>
          </div>
        }
      />

      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="rep-year" className="text-xs">
            Publication year
          </Label>
          <Select value={year} onValueChange={setYear}>
            <SelectTrigger id="rep-year" className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All years</SelectItem>
              {(data?.years || []).map((y) => (
                <SelectItem key={y} value={String(y)}>
                  {y}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="rep-dept" className="text-xs">
            Department
          </Label>
          <Select value={department} onValueChange={setDepartment}>
            <SelectTrigger id="rep-dept" className="w-56">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All departments</SelectItem>
              {departments.map((d) => (
                <SelectItem key={d} value={d}>
                  {d}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {loading ? (
        <div className="space-y-4">
          <Skeleton className="h-20 w-full rounded-[var(--radius)]" />
          <Skeleton className="h-64 w-full rounded-[var(--radius)]" />
        </div>
      ) : isError ? (
        <ErrorState
          title="Could not load reports"
          description="The server did not respond."
          onRetry={() => refetch()}
        />
      ) : !data ? (
        <EmptyState title="No report data" description="Nothing has been filed yet." />
      ) : (
        <>
          <Section title="Totals">
            <StatStrip
              items={[
                { label: "Publications", value: t?.publications ?? 0 },
                { label: "Count only", value: t?.count_only ?? 0 },
                { label: "Paid claims", value: t?.paid_claims ?? 0 },
                { label: "Awaiting payment", value: t?.awaiting_payment ?? 0 },
              ]}
            />
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              {[
                { label: "Paid to date", value: t?.paid_amount ?? 0, tone: "success" },
                { label: "Cleared, not yet paid", value: t?.committed_amount ?? 0, tone: "warning" },
              ].map((card) => (
                <div
                  key={card.label}
                  className={cn(
                    "rounded-[var(--radius)] border px-5 py-4",
                    card.tone === "success"
                      ? "border-success/25 bg-surface-success/40"
                      : "border-warning/30 bg-surface-warning/40"
                  )}
                >
                  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    {card.label}
                  </p>
                  <p className="mt-1 text-2xl font-semibold tabular-nums text-foreground">
                    <Money value={card.value} />
                  </p>
                </div>
              ))}
            </div>
          </Section>

          <div className="grid gap-6 lg:grid-cols-2">
            <Breakdown title="By department" rows={data.by_department} />
            <Breakdown title="By remuneration category" rows={data.by_category} />
            <Breakdown title="By quartile" rows={data.by_quartile} />
            <Breakdown
              title="Engineering / Non-Engineering"
              rows={data.by_engineering}
              showAmount={false}
            />
            <Breakdown title="By status" rows={data.by_status} showAmount={false} />
            <Breakdown
              title="Paid by month"
              rows={data.by_month}
              empty="No payments recorded yet"
            />
          </div>
        </>
      )}
    </div>
  )
}
