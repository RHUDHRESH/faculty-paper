"use client"

import { useMemo } from "react"
import { Link, useLocation, useNavigate, useSearchParams } from "react-router-dom"
import { Download, ExternalLink } from "lucide-react"

import { RankedBars, TrendChart } from "@/components/charts"
import { DataTable, type Column } from "@/components/data-table"
import { TicketDialog, useTicketHref } from "@/components/ticket-dialog"
import { EmptyState, ErrorState, PageHeader, Section, StatStrip } from "@/components/layout/page"
import { LoadingPage } from "@/components/loading"
import { Money, StatusChip, TicketProgress, formatMoney } from "@/components/ticket-ui"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { useApiQuery } from "@/lib/queries"
import { useAuth } from "@/components/auth-provider"

type Bucket = { key: string; count: number; amount?: number }

type JournalReport = {
  journal: {
    title: string
    issn: string | null
    indexing: string | null
    engineering_class: string | null
    subject_category: string | null
    snip_on_record: number | null
    snip_year_on_record: number | null
    scimago: {
      sjr: number | null
      year: number
      issn: string | null
      eissn: string | null
      verified_live: boolean
      categories: { category: string; quartile: string }[]
      best_quartile: string | null
    } | null
    snip: { snip: number | null; sjr: number | null; year: number } | null
  }
  totals: {
    publications: number
    authors: number
    departments: number
    paid_claims: number
    paid_amount?: number
    first_year: number | null
    last_year: number | null
  }
  by_year: Bucket[]
  by_quartile: Bucket[]
  by_status: Bucket[]
  by_department: Bucket[]
  authors: { key: string; id: string; department: string; count: number; amount?: number }[]
  claims: {
    id: string
    ticket_number: string | null
    paper_title: string
    publication_year: number | null
    quartile: string | null
    status: string
    remuneration?: number | null
    owner_name?: string
  }[]
}

/** The portal the reader is already inside, so the sidebar keeps working. */
function portalBase(pathname: string): string {
  return `/${pathname.split("/")[1] || "admin"}`
}

export function JournalRecordPage() {
  const [params] = useSearchParams()
  const title = params.get("title") || ""
  const nav = useNavigate()
  const loc = useLocation()
  const base = portalBase(loc.pathname)
  const { user } = useAuth()
  const blind = user?.role === "HOD"
  const ticketHref = useTicketHref()

  const { data, isLoading, isError, refetch } = useApiQuery<JournalReport>(
    ["journal-report", title],
    `/api/journals/report?title=${encodeURIComponent(title)}`
  )

  const claimColumns = useMemo<Column<JournalReport["claims"][number]>[]>(() => {
    const cols: Column<JournalReport["claims"][number]>[] = [
      {
        key: "ticket",
        header: "Ticket",
        className: "font-mono text-xs",
        cell: (c) => c.ticket_number || "—",
      },
      {
        key: "paper",
        header: "Paper",
        className: "max-w-[24rem]",
        cell: (c) => <span className="line-clamp-2">{c.paper_title || "Untitled"}</span>,
      },
      {
        key: "author",
        header: "Author",
        className: "max-w-[12rem] truncate text-muted-foreground",
        cell: (c) => c.owner_name || "—",
      },
      { key: "year", header: "Year", align: "right", cell: (c) => c.publication_year || "—" },
      { key: "quartile", header: "Quartile", cell: (c) => c.quartile || "—" },
    ]
    if (!blind) {
      cols.push({
        key: "amount",
        header: "Amount",
        align: "right",
        cell: (c) => <Money value={c.remuneration} />,
      })
    }
    cols.push({
      key: "status",
      header: "Status",
      className: "min-w-[10rem]",
      cell: (c) => (
        <div className="space-y-1">
          <StatusChip status={c.status} />
          <TicketProgress status={c.status} />
        </div>
      ),
    })
    return cols
  }, [blind])

  if (!title) return <EmptyState title="No journal named" />
  if (isError)
    return (
      <ErrorState
        title="No publication on record names that journal"
        onRetry={() => refetch()}
      />
    )
  if (isLoading || !data) return <LoadingPage />

  const j = data.journal
  const t = data.totals
  const sc = j.scimago
  const years =
    t.first_year && t.last_year
      ? t.first_year === t.last_year
        ? String(t.first_year)
        : `${t.first_year}–${t.last_year}`
      : "—"

  return (
    <div className="space-y-6">
      <PageHeader
        title={j.title}
        subtitle="What this journal is, and what the college has published in it"
        actions={
          <Button variant="ghost" onClick={() => nav(-1)}>
            Back
          </Button>
        }
      />

      {/* ---- what the journal is, per the reference data ---------------- */}
      <Section
        title="About this journal"
        description={
          sc
            ? `SCImago ${sc.year}${j.snip?.year ? ` · SNIP ${j.snip.year}` : ""}`
            : "Not matched to the reference data"
        }
        actions={
          <Button asChild variant="ghost" size="sm">
            <a
              href={`https://www.scimagojr.com/journalsearch.php?q=${encodeURIComponent(j.title)}`}
              target="_blank"
              rel="noreferrer noopener"
            >
              <ExternalLink className="size-4" />
              SCImago
            </a>
          </Button>
        }
      >
        <div className="flex flex-wrap items-center gap-2">
          {sc?.best_quartile ? (
            <Badge className="border-primary/20 bg-primary/10 text-primary">
              {sc.best_quartile} at its best subject
            </Badge>
          ) : null}
          {j.indexing ? <Badge variant="outline">{j.indexing}</Badge> : null}
          {j.engineering_class ? <Badge variant="outline">{j.engineering_class}</Badge> : null}
          {j.issn ? (
            <Badge variant="outline" className="font-mono text-[11px]">
              ISSN {j.issn}
            </Badge>
          ) : null}
        </div>

        <div className="mt-4">
        <StatStrip
          items={[
            { label: "SJR", value: sc?.sjr != null ? sc.sjr.toFixed(3) : "Not matched" },
            {
              label: "SNIP",
              value: j.snip?.snip != null ? j.snip.snip.toFixed(3) : "Not matched",
            },
            {
              label: "SNIP the college paid on",
              value: j.snip_on_record != null ? j.snip_on_record.toFixed(3) : "Not recorded",
            },
            { label: "Subject areas", value: String(sc?.categories.length || 0) },
          ]}
        />
        </div>

        {sc?.categories.length ? (
          <div className="mt-4">
            <p className="text-eyebrow">Quartile by subject area</p>
            <p className="mt-1 text-xs text-muted-foreground">
              A journal sits in several subjects and can rank differently in each. The policy
              pays on the best of them.
            </p>
            <ul className="mt-3 grid gap-2 sm:grid-cols-2">
              {sc.categories.map((c) => (
                <li
                  key={c.category}
                  className="flex items-center justify-between gap-3 rounded-[var(--radius)] border border-border px-3 py-2"
                >
                  <span className="min-w-0 truncate text-sm" title={c.category}>
                    {c.category}
                  </span>
                  <Badge
                    variant="outline"
                    className={
                      c.quartile === "Q1"
                        ? "border-success/30 bg-success/10 text-success"
                        : undefined
                    }
                  >
                    {c.quartile}
                  </Badge>
                </li>
              ))}
            </ul>
          </div>
        ) : !sc ? (
          <p className="mt-4 text-sm text-muted-foreground">
            No row in the SCImago dump matches this title or its ISSN, so nothing here is
            claimed about its standing. That is usually a conference proceedings series, or a
            title recorded differently on the ticket than in the dump.
          </p>
        ) : null}
      </Section>

      {/* ---- what the college did with it ------------------------------- */}
      <Section title="The college's record here" description={`Publications ${years}`}>
        <StatStrip
          items={[
            { label: "Publications", value: String(t.publications) },
            { label: "Authors", value: String(t.authors) },
            { label: "Departments", value: String(t.departments) },
            // A head of department gets the same three counts and no fourth:
            // the money is not theirs to see, here as anywhere else.
            ...(blind
              ? []
              : [{ label: "Paid", value: formatMoney(t.paid_amount ?? 0) }]),
          ]}
        />
      </Section>

      {data.by_year.length > 1 ? (
        <TrendChart
          title="Publications by year"
          caption="How many papers the college placed here, by year of publication"
          data={data.by_year}
          unit="year"
          measure="count"
        />
      ) : null}

      <div className="grid gap-6 lg:grid-cols-2">
        {data.by_department.length ? (
          <RankedBars
            title="Which departments publish here"
            dimension="Department"
            caption="Most first"
            data={data.by_department}
            unit="count"
            itemNoun="paper"
          />
        ) : null}
        {data.by_quartile.length ? (
          <RankedBars
            title="Quartile recorded on the tickets"
            dimension="Quartile"
            caption="What the college's own records say, which can lag the current ranking"
            data={data.by_quartile}
            unit="count"
            itemNoun="paper"
          />
        ) : null}
      </div>

      <Section title="Who publishes here" description="Most papers first — open anyone's record">
        <DataTable
          rows={data.authors}
          getKey={(a) => a.id}
          rowLink={(a) => `${base}/faculty/${a.id}`}
          minWidth="34rem"
          empty="Nobody on record"
          columns={[
            { key: "name", header: "Name", cell: (a) => a.key },
            {
              key: "dept",
              header: "Department",
              className: "text-muted-foreground",
              cell: (a) => a.department,
            },
            { key: "count", header: "Papers", align: "right", cell: (a) => a.count },
            ...(blind
              ? []
              : [
                  {
                    key: "amount",
                    header: "Paid",
                    align: "right" as const,
                    cell: (a: { amount?: number }) => <Money value={a.amount ?? 0} />,
                  },
                ]),
          ]}
        />
      </Section>

      <Section
        title="Every publication here"
        description="Newest first"
        actions={
          blind ? null : (
            <Button asChild variant="ghost" size="sm">
              <Link to={`${base}/query?q=${encodeURIComponent(j.title)}`}>
                <Download className="size-4" />
                Open in Query
              </Link>
            </Button>
          )
        }
      >
        <DataTable
          rows={data.claims}
          getKey={(c) => c.id}
          rowLink={(c) => ticketHref(c.id)}
          minWidth="60rem"
          maxHeight="40rem"
          empty="Nothing filed"
          columns={claimColumns}
        />
      </Section>

      <TicketDialog portal={base} />
    </div>
  )
}
