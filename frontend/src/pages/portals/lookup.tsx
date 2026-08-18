"use client"

import { useEffect, useMemo, useState } from "react"
import { Link, useSearchParams } from "react-router-dom"
import { Download, Search, User2 } from "lucide-react"

import { MixBar, RankedBars, TrendChart } from "@/components/charts"
import { EmptyState, ErrorState, PageHeader, Section, StatStrip } from "@/components/layout/page"
import { Money, StatusChip, formatMoney } from "@/components/ticket-ui"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { API_BASE, type Claim } from "@/lib/api"
import { useApiQuery } from "@/lib/queries"

/**
 * One box that takes whatever somebody has to hand.
 *
 * The oversight portals could count the college but not a person: "how has
 * Dr X done" and "what happened to ticket FP-2026-0412" both meant exporting
 * the ledger and pivoting it by hand. A principal in a meeting has a ticket
 * number off an email or a staff id off a spreadsheet, not a claim UUID, so
 * the same box takes all of them and says which it matched.
 */

type LookupResult = {
  tickets: {
    id: string
    ticket_number: string | null
    paper_title: string
    status: string
    owner_name: string
    remuneration: number | null
  }[]
  faculty: {
    id: string
    name: string
    email?: string | null
    department?: string | null
    staff_id?: string | null
    designation?: string | null
  }[]
}

type Bucket = { key: string; count: number; amount: number }

type FacultyReport = {
  faculty: Record<string, unknown>
  totals: {
    publications: number
    paid_claims: number
    paid_amount: number
    in_review: number
  }
  by_month: Bucket[]
  by_quartile: Bucket[]
  by_status: Bucket[]
  claims: Claim[]
}

function monthLabel(key: string): string {
  const [y, m] = key.split("-").map(Number)
  if (!y || !m) return key
  return new Date(y, m - 1, 1).toLocaleDateString(undefined, {
    month: "short",
    year: "numeric",
  })
}

/** Everything one person has published and been paid. */
function FacultyReportPanel({ id }: { id: string }) {
  const { data, isLoading, isError, refetch } = useApiQuery<FacultyReport>(
    ["faculty-report", id],
    `/api/faculty/${id}/report`
  )

  if (isError) return <ErrorState onRetry={() => refetch()} />
  if (isLoading || !data) return <Section title="Loading the record…">{null}</Section>

  const f = data.faculty as Record<string, string | null>
  const t = data.totals

  return (
    <div className="space-y-6">
      <Section
        title={f.name || "Faculty"}
        description={[f.designation, f.department, f.staff_id].filter(Boolean).join(" · ")}
        actions={
          <div className="flex gap-2">
            <Button asChild variant="secondary" size="sm">
              <a href={`${API_BASE}/api/faculty/${id}/report/export?fmt=xlsx`}>
                <Download className="size-4" />
                Excel
              </a>
            </Button>
            <Button asChild variant="ghost" size="sm">
              <a href={`${API_BASE}/api/faculty/${id}/report/export?fmt=csv`}>CSV</a>
            </Button>
          </div>
        }
      >
        <StatStrip
          items={[
            { label: "Publications", value: String(t.publications) },
            { label: "Paid claims", value: String(t.paid_claims) },
            { label: "Paid", value: formatMoney(t.paid_amount) },
            { label: "In review", value: String(t.in_review) },
          ]}
        />
      </Section>

      {data.by_month.length ? (
        <TrendChart
          title="Paid by month"
          caption="By the month the college settled it, not the month it was published"
          data={data.by_month.map((b) => ({ ...b, label: monthLabel(b.key) }))}
        />
      ) : null}

      <div className="grid gap-6 lg:grid-cols-2">
        <RankedBars
          title="Where this person publishes"
          caption="Publications by journal quartile"
          data={data.by_quartile}
          unit="count"
        />
        <MixBar
          title="By journal quartile"
          caption="Share of what this person has been paid"
          data={data.by_quartile}
        />
        <RankedBars
          title="By status"
          caption="Where each ticket has got to"
          data={data.by_status}
          unit="count"
        />
      </div>

      <Section title="Every ticket" description="Newest first">
        {data.claims.length === 0 ? (
          <EmptyState title="Nothing filed yet" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[54rem] text-left text-sm">
              <thead className="border-b border-border text-xs uppercase text-muted-foreground">
                <tr>
                  {["Ticket", "Paper", "Journal", "Year", "Quartile", "Amount", "Status"].map(
                    (h) => (
                      <th key={h} className="px-3 py-2 font-medium">
                        {h}
                      </th>
                    )
                  )}
                </tr>
              </thead>
              <tbody>
                {data.claims.map((c) => (
                  <tr key={c.id} className="border-b border-border/50 last:border-0">
                    <td className="px-3 py-2 font-mono text-xs">
                      <Link
                        to={`?ticket=${c.id}`}
                        className="text-primary underline-offset-4 hover:underline"
                      >
                        {c.ticket_number || "—"}
                      </Link>
                    </td>
                    <td className="max-w-[18rem] truncate px-3 py-2">{c.paper_title}</td>
                    <td className="max-w-[12rem] truncate px-3 py-2 text-muted-foreground">
                      {c.journal_title || "—"}
                    </td>
                    <td className="px-3 py-2 tabular-nums">{c.publication_year || "—"}</td>
                    <td className="px-3 py-2">{c.quartile || "—"}</td>
                    <td className="px-3 py-2 font-medium">
                      <Money value={c.remuneration} />
                    </td>
                    <td className="px-3 py-2">
                      <StatusChip status={c.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
    </div>
  )
}

export function LookupPage() {
  const [params, setParams] = useSearchParams()
  const selected = params.get("faculty")
  const [term, setTerm] = useState(params.get("q") || "")
  const [submitted, setSubmitted] = useState(params.get("q") || "")

  // A pasted link with ?q= should search, not just prefill the box.
  useEffect(() => {
    const q = params.get("q") || ""
    setTerm(q)
    setSubmitted(q)
  }, [params])

  const { data, isLoading, isError, refetch } = useApiQuery<LookupResult>(
    ["lookup", submitted],
    `/api/lookup/ticket?q=${encodeURIComponent(submitted)}`,
    { enabled: submitted.trim().length >= 2 }
  )

  const nothing = useMemo(
    () => !!data && data.tickets.length === 0 && data.faculty.length === 0,
    [data]
  )

  if (selected) {
    return (
      <div className="space-y-6">
        <PageHeader
          title="Faculty record"
          subtitle="Everything this person has published and been paid"
          actions={
            <Button variant="ghost" onClick={() => setParams({ q: submitted })}>
              Back to search
            </Button>
          }
        />
        <FacultyReportPanel id={selected} />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Find"
        subtitle="A ticket number, a staff or biometric id, a name, or an email — whichever you have"
      />

      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault()
          setParams(term.trim() ? { q: term.trim() } : {})
        }}
      >
        <div className="min-w-[18rem] flex-1 space-y-1.5">
          <Label htmlFor="lookup-q" className="text-xs">
            Ticket number, staff id, name or email
          </Label>
          <Input
            id="lookup-q"
            value={term}
            onChange={(e) => setTerm(e.target.value)}
            placeholder="FP-2026-0412 · 1042 · Balasundaram"
          />
        </div>
        <Button type="submit" disabled={term.trim().length < 2}>
          <Search className="size-4" />
          Search
        </Button>
      </form>

      {isError ? <ErrorState onRetry={() => refetch()} /> : null}

      {submitted.trim().length < 2 ? (
        <EmptyState
          title="Type at least two characters"
          description="Whatever you have to hand — the box works out which it is."
        />
      ) : isLoading ? null : nothing ? (
        <EmptyState
          title={`Nothing matched “${submitted}”`}
          description="Check the ticket number, or try a surname."
        />
      ) : (
        <div className="space-y-6">
          {data?.faculty.length ? (
            <Section title="Faculty" description="Open a record for the full history">
              <ul className="divide-y divide-border">
                {data.faculty.map((p) => (
                  <li key={p.id}>
                    <button
                      type="button"
                      onClick={() => setParams({ q: submitted, faculty: p.id })}
                      className="interactive flex w-full items-center gap-3 px-1 py-3 text-left hover:bg-accent/30"
                    >
                      <User2 className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">{p.name}</span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {[p.designation, p.department, p.staff_id, p.email]
                            .filter(Boolean)
                            .join(" · ")}
                        </span>
                      </span>
                      <span className="shrink-0 text-xs text-primary">Open record</span>
                    </button>
                  </li>
                ))}
              </ul>
            </Section>
          ) : null}

          {data?.tickets.length ? (
            <Section title="Tickets">
              <div className="overflow-x-auto">
                <table className="w-full min-w-[42rem] text-left text-sm">
                  <thead className="border-b border-border text-xs uppercase text-muted-foreground">
                    <tr>
                      {["Ticket", "Paper", "Faculty", "Amount", "Status"].map((h) => (
                        <th key={h} className="px-3 py-2 font-medium">
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {data.tickets.map((c) => (
                      <tr key={c.id} className="border-b border-border/50 last:border-0">
                        <td className="px-3 py-2 font-mono text-xs">{c.ticket_number || "—"}</td>
                        <td className="max-w-[20rem] truncate px-3 py-2">{c.paper_title}</td>
                        <td className="px-3 py-2">{c.owner_name}</td>
                        <td className="px-3 py-2 font-medium">
                          <Money value={c.remuneration} />
                        </td>
                        <td className="px-3 py-2">
                          <StatusChip status={c.status} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Section>
          ) : null}
        </div>
      )}
    </div>
  )
}
