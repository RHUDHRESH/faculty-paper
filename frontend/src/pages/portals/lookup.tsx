"use client"

import { useEffect, useMemo, useState } from "react"
import { Link, Navigate, useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom"
import { Download, Search, User2 } from "lucide-react"

import { MixBar, RankedBars, TrendChart } from "@/components/charts"
import { EmptyState, ErrorState, PageHeader, Section, StatStrip } from "@/components/layout/page"
import { Money, StatusChip, TicketProgress, formatMoney } from "@/components/ticket-ui"
import { DataTable } from "@/components/data-table"
import { TicketDialog, useTicketHref } from "@/components/ticket-dialog"
import { JournalLink } from "@/components/journal-link"
import { LoadingPage } from "@/components/loading"
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
  by_year?: Bucket[]
  by_journal?: Bucket[]
  by_type?: Bucket[]
  by_position?: Bucket[]
  per_paper?: { count: number; mean: number; median: number; min: number; max: number }
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

/** Everything one person has published and been paid, at its own address. */
export function FacultyRecordPage() {
  const { facultyId } = useParams()
  const nav = useNavigate()
  if (!facultyId) return <EmptyState title="No such person" />
  return (
    <div className="space-y-6">
      <PageHeader
        title="Faculty record"
        subtitle="Everything this person has published and been paid"
        actions={
          <Button variant="ghost" onClick={() => nav(-1)}>
            Back
          </Button>
        }
      />
      <FacultyReportPanel id={facultyId} />
    </div>
  )
}

/** Everything one person has published and been paid. */
function FacultyReportPanel({ id }: { id: string }) {
  const loc = useLocation()
  const portal = `/${loc.pathname.split("/")[1] || "admin"}`
  const ticketHref = useTicketHref()
  const { data, isLoading, isError, refetch } = useApiQuery<FacultyReport>(
    ["faculty-report", id],
    `/api/faculty/${id}/report`
  )

  if (isError) return <ErrorState onRetry={() => refetch()} />
  if (isLoading || !data) return <LoadingPage />

  const f = data.faculty as Record<string, string | null>
  const t = data.totals
  // Bound explicitly: a bare `name` resolves to the deprecated window.name,
  // which is typed void, so every drill-down link silently took nothing.
  const personName = f.name || "this person"

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

      {data.by_year?.length ? (
        <TrendChart
          title="Publications by year"
          caption="How many papers, by the year they were published"
          data={data.by_year}
          unit="year"
          // The title says publications, so the axis must count them. It was
          // plotting rupees under a heading that promised papers.
          measure="count"
        />
      ) : null}

      <div className="grid gap-6 lg:grid-cols-2">
        <RankedBars
          title="Where this person publishes"
          caption="Publications by journal quartile — open one to see which papers"
          data={data.by_quartile}
          unit="count"
          dimension="Quartile"
          itemNoun="paper"
          linkFor={(d) =>
            d.key.startsWith("Q")
              ? `${portal}/query?owner=${id}&owner_name=${encodeURIComponent(personName)}&quartile=${d.key}`
              : null
          }
        />
        <MixBar
          title="By journal quartile"
          caption="Share of what this person has been paid"
          data={data.by_quartile}
          dimension="Quartile"
        />
        {data.by_position?.length ? (
          <RankedBars
            title="Position on the author list"
            caption="First authorship is what the policy pays on, and what panels ask about"
            data={data.by_position}
            unit="count"
            dimension="Position"
            itemNoun="paper"
          />
        ) : null}
        {data.by_journal?.length ? (
          <RankedBars
            title="Journals used"
            caption="Most-used first — open one for its ranking and who else publishes there"
            data={data.by_journal}
            unit="count"
            dimension="Journal"
            itemNoun="paper"
            linkFor={(d) =>
              d.key && d.key !== "Not recorded"
                ? `${portal}/journal?title=${encodeURIComponent(d.key)}`
                : null
            }
          />
        ) : null}
        {data.by_type?.length ? (
          <RankedBars
            title="Kind of publication"
            caption="Journal articles, conference proceedings, book chapters"
            data={data.by_type}
            unit="count"
            dimension="Kind"
            itemNoun="paper"
          />
        ) : null}
        <RankedBars
          title="By status"
          caption="Where each ticket has got to — open one to list them"
          data={data.by_status}
          unit="count"
          dimension="Status"
          itemNoun="ticket"
          linkFor={(d) =>
            d.key && d.key !== "—"
              ? `${portal}/query?owner=${id}&owner_name=${encodeURIComponent(personName)}&status=${d.key}`
              : null
          }
        />
      </div>

      {data.per_paper?.count ? (
        <Section title="What one of their papers is worth" description="Across settled payments">
          <StatStrip
            items={[
              { label: "Median", value: formatMoney(data.per_paper.median) },
              { label: "Mean", value: formatMoney(data.per_paper.mean) },
              { label: "Largest", value: formatMoney(data.per_paper.max) },
              { label: "Smallest", value: formatMoney(data.per_paper.min) },
            ]}
          />
        </Section>
      ) : null}

      <Section
        title="Every ticket"
        description="Newest first — each one opens its full history"
        actions={
          <Button asChild variant="ghost" size="sm">
            <Link to={`${portal}/query?owner=${id}&owner_name=${encodeURIComponent(personName)}`}>
              Open all in Query
            </Link>
          </Button>
        }
      >
        <DataTable
          rows={data.claims}
          getKey={(c) => c.id}
          rowLink={(c) => ticketHref(c.id)}
          minWidth="62rem"
          maxHeight="38rem"
          empty="Nothing filed yet"
          columns={[
            {
              key: "ticket",
              header: "Ticket",
              className: "font-mono text-xs",
              cell: (c) => c.ticket_number || "—",
            },
            {
              key: "paper",
              header: "Paper",
              className: "max-w-[22rem]",
              cell: (c) => <span className="line-clamp-2">{c.paper_title || "Untitled"}</span>,
            },
            {
              key: "journal",
              header: "Journal",
              className: "max-w-[14rem]",
              // The name is the door to the journal's own record: its ranking,
              // its SNIP, and everyone else at the college publishing there.
              cell: (c) => <JournalLink title={c.journal_title} portal={portal} />,
            },
            {
              key: "year",
              header: "Year",
              align: "right",
              cell: (c) => c.publication_year || "—",
            },
            { key: "quartile", header: "Quartile", cell: (c) => c.quartile || "—" },
            {
              key: "amount",
              header: "Amount",
              align: "right",
              cell: (c) => <Money value={c.remuneration} />,
            },
            {
              key: "status",
              header: "Status",
              className: "min-w-[11rem]",
              cell: (c) => (
                <div className="space-y-1">
                  <StatusChip status={c.status} />
                  <TicketProgress status={c.status} />
                </div>
              ),
            },
          ]}
        />
      </Section>

      {/* A ticket number on this page opens the ticket, which is what it
          always looked like it would do. */}
      <TicketDialog portal={portal} />
    </div>
  )
}

/** The record sits under the portal the reader is already in, so the back
 *  button and the sidebar keep working. */
export function facultyRecordBase(pathname: string): string {
  const portal = pathname.split("/")[1] || "admin"
  return `/${portal}/faculty`
}

export function LookupPage() {
  const [params, setParams] = useSearchParams()
  const lookupTicketHref = useTicketHref()
  const lookupPortal = `/${(typeof window === "undefined" ? "/admin" : window.location.pathname).split("/")[1] || "admin"}`
  const recordBase = facultyRecordBase(
    typeof window === "undefined" ? "/admin" : window.location.pathname
  )
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

  // A record used to be shown by swapping this screen out, which meant it had
  // no address of its own. ?faculty= is still honoured so older links work.
  if (selected) {
    return <Navigate to={`${recordBase}/${selected}`} replace />
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
                    <Link
                      to={`${recordBase}/${p.id}`}
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
                    </Link>
                  </li>
                ))}
              </ul>
            </Section>
          ) : null}

          {data?.tickets.length ? (
            <Section title="Tickets" description="Open one for its full history">
              <DataTable
                rows={data.tickets}
                getKey={(c) => c.id}
                // You searched for a ticket. Being shown a row and no way into
                // it was the whole gap this screen had.
                rowLink={(c) => lookupTicketHref(c.id)}
                minWidth="46rem"
                columns={[
                  {
                    key: "ticket",
                    header: "Ticket",
                    className: "font-mono text-xs",
                    cell: (c) => c.ticket_number || "—",
                  },
                  {
                    key: "paper",
                    header: "Paper",
                    className: "max-w-[20rem]",
                    cell: (c) => <span className="line-clamp-2">{c.paper_title}</span>,
                  },
                  { key: "faculty", header: "Faculty", cell: (c) => c.owner_name },
                  {
                    key: "amount",
                    header: "Amount",
                    align: "right",
                    cell: (c) => <Money value={c.remuneration} />,
                  },
                  {
                    key: "status",
                    header: "Status",
                    className: "min-w-[11rem]",
                    cell: (c) => (
                      <div className="space-y-1">
                        <StatusChip status={c.status} />
                        <TicketProgress status={c.status} />
                      </div>
                    ),
                  },
                ]}
              />
            </Section>
          ) : null}
        </div>
      )}

      <TicketDialog portal={lookupPortal} />
    </div>
  )
}
