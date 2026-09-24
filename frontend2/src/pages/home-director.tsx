import { useState } from "react"
import { Link } from "react-router-dom"
import { BarChart3, FileCheck, Stamp } from "lucide-react"

import { useAuth } from "@/app/auth"
import { HOME_DATA } from "@/app/home-data"
import { useApi } from "@/lib/query"
import { Button } from "@/ui/button"
import { ComingUp } from "@/ui/coming-up"
import { BulkAuthoriseDialog, type Claim as QueueClaim } from "@/pages/authorisations"
import { money } from "@/ui/paper"
import { Callout, ErrorState, InlineError, SkeletonRows } from "@/ui/state"
import { PageTitle, SectionTitle, Sub } from "@/ui/text"
import { cn } from "@/lib/cn"
import {
  ClaimRow,
  Figure,
  QueueRow,
  Waiting,
  greeting,
  type BudgetSummary,
  type Claim,
  collegeSince,
} from "@/pages/home-staff"

/**
 * The Director's executive summary.
 *
 * A director arrives with two questions, and neither is anybody else's. The
 * first is "what is waiting on my signature and what is it worth" — this is
 * the one desk whose silence stops payments outright, so it leads the page.
 * The second is "what is this institution actually researching", which no
 * other screen in the app answers at all.
 *
 * The second question is the one to be careful with. Subject areas are known
 * only for a paper whose journal could be matched against our Scimago rows —
 * about half the record — so the coverage figure sits next to the chart
 * rather than in a footnote. An area chart shown without its denominator
 * reads as "this is what we do" when it means "this is what we do, among the
 * half we can classify", and a research priority set on that difference would
 * be a decision the data cannot support.
 */

type DirectorQueue = {
  total: number
  results: (Claim & Partial<QueueClaim>)[]
  /** Over everything that matches, not the page. */
  totals: { count: number; amount: number; longest_wait_days: number | null }
}

type AreasPayload = {
  areas: { key: string; count: number; amount: number; quartiles: Record<string, number> }[]
  distinct: number
  shown: number
  coverage: { classified: number; total: number; unclassified: number; fraction: number }
}

type CollegeTotals = {
  by_status: Record<string, number>
  total_paid: number
  ledger_total?: number
  ledger_since?: string | null
}

export function DirectorHome() {
  const { me } = useAuth()
  const D = HOME_DATA

  // The whole queue, not a page of it: the summary sums it, the batch button
  // authorises it, and the list below shows the six that have waited longest.
  const queue = useApi<DirectorQueue>(D.directorQueue.key, D.directorQueue.path)
  const [batchOpen, setBatchOpen] = useState(false)
  const areas = useApi<AreasPayload>(D.areas.key, D.areas.path)
  // The publication count is every filed paper, which the stage counts
  // already hold. It was read off the full report -- thirty-five queries for
  // one number, on the home screen of the person who opens it most.
  const college = useApi<CollegeTotals>(D.collegeTotals.key, D.collegeTotals.path)
  const budget = useApi<BudgetSummary>(D.budget.key, D.budget.path)
  const publications = college.data
    ? Object.entries(college.data.by_status)
        .filter(([status]) => status !== "DRAFT")
        .reduce((sum, [, n]) => sum + n, 0)
    : null

  const totals = queue.data?.totals
  const longest = totals?.longest_wait_days ?? null
  const coverage = areas.data?.coverage
  const waiting = queue.data?.results ?? []
  const byQuartile = ["Q1", "Q2", "Q3", "Q4"].map((q) => ({
    q,
    n: waiting.filter((c) => (c.quartile || "").toUpperCase() === q).length,
  }))
  const unranked = waiting.length - byQuartile.reduce((s, x) => s + x.n, 0)
  const largest = [...waiting].sort((a, b) => (b.remuneration || 0) - (a.remuneration || 0)).slice(0, 3)
  const remaining = budget.data?.college.remaining ?? null
  const allFetched = (queue.data?.total ?? 0) <= waiting.length

  return (
    <div className="page space-y-10">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <PageTitle>{greeting(me?.name)}</PageTitle>
          <Sub className="mt-1">
            What is waiting on your authorisation, what it would mean, and what the
            institution is publishing.
          </Sub>
        </div>
        {waiting.length > 0 && allFetched && (
          <Button kind="primary" size="lg" onClick={() => setBatchOpen(true)}>
            <Stamp />
            Authorise all {waiting.length} · {money(totals?.amount)}
          </Button>
        )}
      </header>

      {waiting.length > 0 && (
        <section aria-label="What authorising would mean" className="grid gap-px overflow-hidden rounded-lg bg-line ring-1 ring-line md:grid-cols-3">
          <div className="bg-surface p-5">
            <p className="text-sm text-fg-muted">Budget left this year</p>
            {remaining == null ? (
              <>
                <p className="figure mt-1 text-2xl text-fg-subtle">Not set</p>
                <p className="mt-1 text-sm text-fg-muted">No allocation entered for {budget.data?.financial_year ?? "this year"}.</p>
              </>
            ) : (
              <>
                <p className={cn("figure mt-1 text-2xl", remaining < 0 ? "text-critical" : "text-positive")}>
                  {remaining < 0 ? "Over by " : ""}{money(Math.abs(remaining))}
                </p>
                <p className="mt-1 text-sm text-fg-muted">
                  Already sets aside the {money(totals?.amount)} waiting on you.
                </p>
              </>
            )}
          </div>
          <div className="bg-surface p-5">
            <p className="text-sm text-fg-muted">What is waiting, by quartile</p>
            <p className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-base">
              {byQuartile.map(({ q, n }) => (
                <span key={q}>
                  <span className={cn("figure", q === "Q1" && n > 0 && "text-positive")}>{n}</span>{" "}
                  <span className="text-fg-muted">{q}</span>
                </span>
              ))}
              {unranked > 0 && (
                <span>
                  <span className="figure">{unranked}</span> <span className="text-fg-muted">unranked</span>
                </span>
              )}
            </p>
            <p className="mt-1 text-sm text-fg-muted">Already counted in the accreditation tables, which count every filed paper; authorising changes the spend, not the count.</p>
          </div>
          <div className="bg-surface p-5">
            <p className="text-sm text-fg-muted">Largest amounts waiting</p>
            <ul className="mt-2 space-y-1 text-sm">
              {largest.map((c) => (
                <li key={c.id} className="flex items-baseline justify-between gap-3">
                  <Link to={`/papers/${c.id}`} className="min-w-0 truncate hover:underline">
                    {c.owner_name || c.paper_title}
                  </Link>
                  <span className="figure shrink-0">{money(c.remuneration)}</span>
                </li>
              ))}
            </ul>
          </div>
        </section>
      )}

      {batchOpen && (
        <BulkAuthoriseDialog
          claims={waiting as QueueClaim[]}
          onClose={() => setBatchOpen(false)}
          onDone={() => void queue.refetch()}
        />
      )}

      {/* Waiting on you, first: this is the only desk whose silence stops a
          payment outright. */}
      <section className="grid gap-x-10 gap-y-6 sm:grid-cols-3">
        <Figure
          label="Waiting on you"
          value={totals ? totals.count.toLocaleString("en-IN") : "—"}
          hint="Approved, not yet authorised"
          loading={queue.isLoading}
          muted={totals?.count === 0}
        />
        <Figure
          label="Worth"
          value={money(totals?.amount)}
          hint="Finance cannot pay any of it until you authorise"
          loading={queue.isLoading}
        />
        <Figure
          label="Longest wait"
          value={longest === null ? "—" : `${longest} ${longest === 1 ? "day" : "days"}`}
          hint={longest === null ? "Nothing waiting" : "Since the Principal approved it"}
          tone={longest !== null && longest > 30 ? "critical" : undefined}
          loading={queue.isLoading}
        />
      </section>

      {queue.isError ? (
        <InlineError
          message="Could not load the authorisation queue."
          onRetry={() => queue.refetch()}
        />
      ) : (queue.data?.total ?? 0) === 0 && !queue.isLoading ? (
        <div className="space-y-4">
          <Callout tone="positive" title="Nothing is waiting on your signature">
            Every approved claim has been authorised and is with Finance.
          </Callout>
          <ComingUp desk="director" align="start" />
        </div>
      ) : (
        <Waiting>
          <div className="flex items-baseline justify-between gap-3">
            <SectionTitle>Longest waiting</SectionTitle>
            <Link
              to="/authorisations"
              className="text-sm text-accent underline-offset-4 hover:underline"
            >
              Authorisations{queue.data ? ` (${queue.data.total})` : ""}
            </Link>
          </div>
          {queue.isLoading ? (
            <ul className="divide-y divide-line border-y border-line">
              {Array.from({ length: 4 }).map((_, i) => (
                <li key={i} className="h-[3.25rem] animate-pulse bg-sunken" />
              ))}
            </ul>
          ) : (
            <ul className="divide-y divide-line border-y border-line">
              {queue.data?.results.slice(0, 6).map((c) => (
                <ClaimRow key={c.id} claim={c} />
              ))}
            </ul>
          )}
        </Waiting>
      )}

      {/* ---- what the institution researches ---- */}
      <section className="space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <SectionTitle>What we research</SectionTitle>
          <Link to="/reports" className="text-sm text-accent underline-offset-4 hover:underline">
            Build a report
          </Link>
        </div>

        {areas.isLoading ? (
          <SkeletonRows rows={8} rowHeight={28} />
        ) : areas.isError ? (
          <InlineError
            message="Could not load the subject areas."
            onRetry={() => areas.refetch()}
          />
        ) : !areas.data || areas.data.areas.length === 0 ? (
          <p className="border-y border-line py-8 text-center text-sm text-fg-muted">
            No paper on record carries a subject area yet.
          </p>
        ) : (
          <>
            <p className="max-w-3xl text-base text-fg-muted">
              {areas.data.distinct.toLocaleString("en-IN")} subject areas across the record,
              showing the {areas.data.shown} largest. A paper spanning three areas is counted
              under each, so these add to more than the number of papers.
            </p>

            <AreaBars areas={areas.data.areas} />

            {coverage && coverage.fraction < 0.95 && (
              <Callout tone="caution" title="This covers part of the record, not all of it">
                Subject areas are known for {coverage.classified.toLocaleString("en-IN")} of{" "}
                {coverage.total.toLocaleString("en-IN")} papers —{" "}
                {Math.round(coverage.fraction * 100)}%. The other{" "}
                {coverage.unclassified.toLocaleString("en-IN")} are papers whose journal could
                not be matched against our reference data. They are absent from every bar
                above rather than counted as unclassified.
              </Callout>
            )}
          </>
        )}
      </section>

      {/* ---- the institution's position ---- */}
      <section className="space-y-3">
        <SectionTitle>The institution</SectionTitle>
        {college.isError || budget.isError ? (
          // Every figure below degrades to an em dash or "Not set" on
          // failure, so a dropped request read as "nothing published, no
          // budget allocated" -- to the one person whose job is deciding
          // whether the institution can afford the next payment.
          <ErrorState
            title="Could not load the institution's position"
            message="The server did not answer. These figures are unavailable, not zero."
            onRetry={() => {
              void college.refetch()
              void budget.refetch()
            }}
          />
        ) : (
        <div className="grid gap-x-10 gap-y-6 sm:grid-cols-2 lg:grid-cols-4">
          <Figure
            label="Publications"
            value={publications != null ? publications.toLocaleString("en-IN") : "—"}
            loading={college.isLoading}
          />
          <Figure
            label="Paid to date"
            value={money(college.data?.ledger_total ?? college.data?.total_paid)}
            hint={collegeSince(college.data?.ledger_since)}
            loading={college.isLoading}
          />
          <Figure
            label="Committed"
            value={money(budget.data?.college.committed)}
            hint="Approved or authorised, not yet paid"
            loading={budget.isLoading}
          />
          <Figure
            label="Left this year"
            value={
              budget.data?.college.remaining == null
                ? "Not set"
                : money(Math.abs(budget.data.college.remaining))
            }
            muted={budget.data?.college.remaining == null}
            tone={
              budget.data?.college.remaining == null
                ? undefined
                : budget.data.college.remaining < 0
                  ? "critical"
                  : "positive"
            }
            loading={budget.isLoading}
          />
        </div>
        )}
      </section>

      <section className="space-y-2">
        <SectionTitle>Look further</SectionTitle>
        <ul className="divide-y divide-line border-y border-line">
          <QueueRow
            icon={BarChart3}
            label="Reports"
            count={null}
            detail="Build one by year, department, quartile or subject area — and download it"
            to="/reports"
          />
          <QueueRow
            icon={FileCheck}
            label="Accreditation"
            count={null}
            detail="The NAAC and NIRF tables, and the rows that would be sent back"
            to="/accreditation"
          />
        </ul>
      </section>
    </div>
  )
}

/**
 * Subject areas as ranked bars.
 *
 * Drawn here rather than with `RankedBars` from `@/ui/chart` because the
 * quartile split inside each bar is the part a director actually reads: a
 * hundred papers in an area is a different fact depending on whether they are
 * Q1 or Q4, and a length-only bar cannot say which.
 */
function AreaBars({ areas }: { areas: AreasPayload["areas"] }) {
  const max = Math.max(...areas.map((a) => a.count), 1)

  return (
    <ul className="space-y-2 border-y border-line py-3">
      {areas.map((a) => {
        const q1 = a.quartiles.Q1 ?? 0
        const known = Object.values(a.quartiles).reduce((sum, n) => sum + n, 0)
        return (
          <li key={a.key} className="grid grid-cols-[1fr_auto] items-center gap-x-4 gap-y-1">
            <span className="min-w-0 truncate text-base">{a.key}</span>
            <span className="shrink-0 text-sm tabular text-fg-muted">
              {q1 > 0 && <span className="text-positive">{q1} Q1 · </span>}
              {a.count}
            </span>
            <span
              className="col-span-2 flex h-1.5 w-full overflow-hidden rounded-full bg-sunken"
              aria-hidden
            >
              <span className="block bg-positive" style={{ width: `${(q1 / max) * 100}%` }} />
              <span
                className="block bg-accent"
                style={{ width: `${((a.count - q1) / max) * 100}%` }}
              />
            </span>
            <span className="sr-only">
              {a.key}: {a.count} papers, {q1} of them Q1
              {known < a.count ? `, quartile not known for ${a.count - known}` : ""}
            </span>
          </li>
        )
      })}
    </ul>
  )
}
