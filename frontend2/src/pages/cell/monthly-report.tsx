import { useState } from "react"
import { Link } from "react-router-dom"
import { Download, Printer } from "lucide-react"

import { useApi } from "@/lib/query"
import { Answer } from "@/ui/answer"
import { Button } from "@/ui/button"
import { Input } from "@/ui/field"
import { money } from "@/ui/paper"
import { Section } from "@/ui/section"
import { ErrorState, SkeletonRows } from "@/ui/state"
import { Table, type Column } from "@/ui/table"

/**
 * The monthly processing report (job 9): what to tell the Principal. The month
 * in four figures and one sentence, who decided, how long the waiting claims
 * have waited, and a CSV with one row per decision. Server:
 * GET /api/admin/clearing-report (backend/core/api/research_cell.py).
 */

type Report = {
  month: string
  received: number
  cleared: number
  sent_back: number
  not_accepted: number
  amount_cleared: number
  median_days: number | null
  within_week: number
  decided: number
  waiting_now: number
  by_person: { name: string; cleared: number; sent_back: number; not_accepted: number }[]
  ageing: { bucket: string; count: number }[]
}

const AGE_ID: Record<string, string> = {
  "a week or less": "week",
  "8 to 14 days": "fortnight",
  "15 to 30 days": "month",
  "over 30 days": "older",
}

function thisMonth(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`
}

/** "September 2026". */
export function monthTitle(ym: string): string {
  const [y, m] = ym.split("-").map(Number)
  return new Date(y, (m || 1) - 1, 1).toLocaleDateString("en-IN", { month: "long", year: "numeric" })
}

const n = (v: number) => v.toLocaleString("en-IN")
const cap = (s: string) => s[0].toUpperCase() + s.slice(1)

export function MonthlyReport() {
  const [month, setMonth] = useState(thisMonth())
  const q = useApi<Report>(["clearing-report", month], `/api/admin/clearing-report?month=${month}`)
  const r = q.data

  const people: Column<Report["by_person"][number]>[] = [
    { key: "name", header: "Person", cell: (p) => p.name },
    { key: "cleared", header: "Cleared", align: "right", cell: (p) => n(p.cleared) },
    { key: "sent_back", header: "Sent back", align: "right", cell: (p) => n(p.sent_back) },
    { key: "not_accepted", header: "Not accepted", align: "right", cell: (p) => n(p.not_accepted) },
    { key: "total", header: "In all", align: "right", cell: (p) => n(p.cleared + p.sent_back + p.not_accepted) },
  ]
  const waiting: Column<Report["ageing"][number]>[] = [
    { key: "bucket", header: "Waiting", cell: (a) => cap(a.bucket) },
    { key: "count", header: "Claims", align: "right", cell: (a) => n(a.count) },
    {
      key: "open",
      header: "List",
      label: "Open the list",
      empty: "Nothing to open",
      cell: (a) =>
        a.count > 0 ? (
          <Link to={`/clearing?age=${AGE_ID[a.bucket] ?? ""}`} className="text-accent underline-offset-4 hover:underline">
            Open these {n(a.count)}
          </Link>
        ) : null,
    },
  ]

  return (
    <div className="space-y-8">
      <Section
        title="Monthly processing report"
        action={
          <span className="flex flex-wrap items-center justify-end gap-2">
            <Input
              type="month"
              value={month}
              onChange={(e) => e.target.value && setMonth(e.target.value)}
              aria-label="Month"
              className="w-40"
            />
            <Button kind="default" size="sm" asChild>
              <a href={`/api/admin/clearing-report?month=${month}&format=csv`}>
                <Download aria-hidden />
                Download CSV
              </a>
            </Button>
            <Button kind="quiet" size="sm" onClick={() => window.print()}>
              <Printer aria-hidden />
              Print
            </Button>
          </span>
        }
      >
        {q.isLoading ? (
          <SkeletonRows rows={3} rowHeight={48} />
        ) : q.isError || !r ? (
          <ErrorState title="Could not load the report" message="The server did not answer. Try the month again." onRetry={() => q.refetch()} />
        ) : (
          <div className="space-y-8">
            <Answer
              items={[
                { label: `Came in in ${monthTitle(r.month)}`, value: r.received, zero: "Nothing came in" },
                { label: r.cleared > 0 ? `Cleared, worth ${money(r.amount_cleared)}` : "Cleared", value: r.cleared, zero: "Nothing cleared" },
                { label: "Sent back or not accepted", value: r.sent_back + r.not_accepted, zero: "Nothing sent back", tone: "caution" },
                {
                  label: r.median_days == null ? "Median days to decide" : `Median days from filing to decision`,
                  value: r.median_days == null ? "None decided" : String(r.median_days),
                },
              ]}
            />
            <p className="max-w-3xl text-base text-fg-muted">
              In {monthTitle(r.month)}, {n(r.received)} {r.received === 1 ? "claim" : "claims"} came in and {n(r.cleared)} {r.cleared === 1 ? "was" : "were"} cleared,{" "}
              {n(r.sent_back)} sent back and {n(r.not_accepted)} not accepted.{" "}
              {r.decided > 0
                ? `${n(r.within_week)} of ${n(r.decided)} decisions took a week or less.`
                : "Nothing was decided this month."}{" "}
              {r.waiting_now > 0 ? (
                <>
                  <Link to="/clearing" className="text-accent underline-offset-4 hover:underline">
                    {n(r.waiting_now)} {r.waiting_now === 1 ? "claim is" : "claims are"} waiting now
                  </Link>
                  .
                </>
              ) : (
                "Nothing is waiting now."
              )}
            </p>

            <div className="grid grid-cols-[minmax(0,1fr)] gap-x-12 gap-y-8 lg:grid-cols-2">
              <Section title="Who decided">
                {r.by_person.length === 0 ? (
                  <p className="text-base text-fg-muted">No decisions were made in {monthTitle(r.month)}.</p>
                ) : (
                  <Table rows={r.by_person} columns={people} getKey={(p) => p.name} maxHeight="none" caption="Decisions by person" />
                )}
              </Section>
              <Section title="How long the waiting claims have waited" sub="Claims at the research cell now, whatever month is chosen.">
                <Table rows={r.ageing} columns={waiting} getKey={(a) => a.bucket} maxHeight="none" caption="Waiting claims by age" />
              </Section>
            </div>
          </div>
        )}
      </Section>
    </div>
  )
}
