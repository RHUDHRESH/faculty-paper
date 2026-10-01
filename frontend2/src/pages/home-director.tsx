import { useState } from "react"
import { Link } from "react-router-dom"
import { Stamp } from "lucide-react"

import { useAuth } from "@/app/auth"
import { HOME_DATA } from "@/app/home-data"
import { formatCount } from "@/lib/count"
import { paperTitle } from "@/lib/names"
import { useApi } from "@/lib/query"
import { BulkAuthoriseDialog, type Claim as QueueClaim } from "@/pages/authorisations"
import { greeting, YourPapers, type BudgetSummary, type Claim } from "@/pages/home-staff"
import { HomeTrack } from "@/pages/home-track"
import { MonthPaperwork } from "@/pages/month-paperwork"
import { AmountCell, waitingLabel } from "@/pages/pay-parts"
import { Answer } from "@/ui/answer"
import { Button } from "@/ui/button"
import { ComingUp } from "@/ui/coming-up"
import { PageHeader } from "@/ui/page-header"
import { money } from "@/ui/paper"
import { Avatar, initialsOf } from "@/ui/person"
import { Details, Rows, Section } from "@/ui/section"
import { InlineError, SkeletonRows } from "@/ui/state"
import { Meta } from "@/ui/text"
import { cn } from "@/lib/cn"

/**
 * The Director's first screen: what is waiting on a signature, what it does to
 * the budget, and whether anything about it is unusual.
 *
 * This is the one desk whose silence stops payments outright, so it leads. The
 * four figures are over the whole queue (never a page of it). The sentence
 * under them is the decision in words: what authorising releases, what the
 * year's budget would still have, and which claims are largest. Where the
 * research threshold has already cut an amount, each row says so, so the
 * Director authorises the figure that will be paid and not the policy figure.
 *
 * What the college researches (the subject areas) used to fill half of this
 * screen. It is a real question but not the morning one, so it is one click
 * down, with the share of the record it can classify beside it: an area chart
 * shown without its denominator reads as "this is what we do" when it means
 * "this is what we do, among the half we can classify".
 *
 * Nothing here is a flag. The Director is contest-blind (`core.visibility`).
 */

type DirectorQueue = {
  total: number
  results: (Claim & Partial<QueueClaim>)[]
  /** Over everything that matches, not the page. */
  totals: {
    count: number
    amount: number
    longest_wait_days: number | null
    held_back?: number
    held_back_count?: number
  }
}

type AreasPayload = {
  areas: { key: string; count: number; amount: number; quartiles: Record<string, number> }[]
  distinct: number
  shown: number
  coverage: { classified: number; total: number; unclassified: number; fraction: number }
}

export function DirectorHome() {
  const { me } = useAuth()
  const D = HOME_DATA

  // The whole queue, not a page of it: the summary sums it, the batch button
  // authorises it, and the list below shows the six that have waited longest.
  const queue = useApi<DirectorQueue>(D.directorQueue.key, D.directorQueue.path)
  const budget = useApi<BudgetSummary>(D.budget.key, D.budget.path)
  const [batchOpen, setBatchOpen] = useState(false)

  const totals = queue.data?.totals
  const longest = totals?.longest_wait_days ?? null
  const waiting = queue.data?.results ?? []
  const largest = [...waiting].sort((a, b) => (b.remuneration || 0) - (a.remuneration || 0)).slice(0, 3)
  const remaining = budget.data?.college.remaining ?? null
  const over = remaining != null && remaining < 0
  const allFetched = (queue.data?.total ?? 0) <= waiting.length
  const year = budget.data?.financial_year ?? "this year"
  const oldestFirst = waiting
    .filter((c) => !me?.id || c.owner_id !== me.id)
    .slice()
    .sort((a, b) => (b.waiting_days ?? 0) - (a.waiting_days ?? 0))

  return (
    <div className="page space-y-10">
      <PageHeader
        title={greeting(me?.name)}
        sub="What needs your authorisation, and what it does to the budget."
        action={
          waiting.length > 0 && allFetched ? (
            <Button kind="primary" size="lg" onClick={() => setBatchOpen(true)}>
              <Stamp />
              Authorise all {formatCount(waiting.length)} · {money(totals?.amount)}
            </Button>
          ) : undefined
        }
        spot="spot-authorisations"
      />

      {queue.isError ? (
        <InlineError message="Could not load the authorisation queue." onRetry={() => void queue.refetch()} />
      ) : (
        <>
          <div className="space-y-3">
            <Answer
              items={[
                {
                  label: "Waiting for you to authorise",
                  value: totals ? totals.count : null,
                  zero: "Nothing is waiting for you",
                  to: "/authorisations",
                },
                { label: "Worth, released to Finance", value: totals ? money(totals.amount) : null, to: "/authorisations" },
                {
                  label: "Days the longest has waited",
                  value: totals ? (longest ?? 0) : null,
                  zero: "Nothing is waiting",
                  tone: longest != null && longest > 30 ? "critical" : undefined,
                  to: "/authorisations",
                },
                budget.isError
                  ? { label: "Budget", value: "Not loaded", to: "/budget" }
                  : {
                      label: over ? "Over the budget, counting these" : "Left in the budget, counting these",
                      value: !budget.data ? null : remaining == null ? "Not set" : money(Math.abs(remaining)),
                      tone: over ? "critical" : undefined,
                      to: "/budget",
                    },
              ]}
            />
            {waiting.length > 0 && (totals?.amount ?? 0) > 0 && (
              <p className="max-w-prose text-pretty text-base text-fg-muted" data-testid="authorising-means">
                {remaining == null
                  ? `No budget is set for ${year}, so there is nothing to weigh the ${money(totals?.amount)} against.`
                  : over
                    ? `The budget for ${year} is already over by ${money(Math.abs(remaining))}, and the ${money(totals?.amount)} waiting is counted in that.`
                    : `Authorising all of it releases ${money(totals?.amount)} to Finance. The budget for ${year} would still have ${money(remaining)} left.`}
                {(totals?.held_back_count ?? 0) > 0 && (
                  <>
                    {" "}
                    The research threshold has already taken {money(totals?.held_back)} off{" "}
                    {formatCount(totals?.held_back_count)} {totals?.held_back_count === 1 ? "claim" : "claims"}; the
                    amounts shown are what will be paid.
                  </>
                )}
                {largest.length > 0 && (
                  <>
                    {" "}
                    The largest {largest.length === 1 ? "is" : "are"}{" "}
                    {largest.map((c, i) => (
                      <span key={c.id}>
                        {i > 0 && (i === largest.length - 1 ? " and " : ", ")}
                        <Link to={`/papers/${c.id}`} className="text-accent underline-offset-4 hover:underline">
                          {c.owner_name || "one"} ({money(c.remuneration)})
                        </Link>
                      </span>
                    ))}
                    .
                  </>
                )}
              </p>
            )}
          </div>

          {batchOpen && (
            <BulkAuthoriseDialog
              claims={waiting as QueueClaim[]}
              onClose={() => setBatchOpen(false)}
              onDone={() => void queue.refetch()}
            />
          )}

          <Section
            title="Longest waiting"
            action={
              <Link to="/authorisations" className="text-accent underline-offset-4 hover:underline">
                {queue.data && queue.data.total > 0 ? `All ${formatCount(queue.data.total)} in Authorisations` : "Authorisations"}
              </Link>
            }
          >
            {queue.isLoading ? (
              <SkeletonRows rows={4} rowHeight={52} />
            ) : oldestFirst.length === 0 ? (
              <div className="space-y-4">
                <p className="text-base text-fg-muted">
                  Nothing is waiting for your signature. Every claim the Principal approved is authorised and with
                  Finance.
                </p>
                <ComingUp desk="director" align="start" />
              </div>
            ) : (
              <Rows>
                {oldestFirst.slice(0, 6).map((c) => (
                  <AuthoriseRow key={c.id} c={c} />
                ))}
              </Rows>
            )}
          </Section>
        </>
      )}

      <MonthPaperwork title="The month's statement" />

      <Details label="what the college researches" className="border-t border-line pt-6">
        <ResearchAreas />
      </Details>

      <Details label="where every claim is">
        <div className="mt-3">
          <HomeTrack heading="Every claim, by stage" />
        </div>
      </Details>

      {/* The Director's own research, after the authorising: another officer
          authorises the Director's own papers, never the Director. */}
      <YourPapers />
    </div>
  )
}

function AuthoriseRow({ c }: { c: Claim & Partial<QueueClaim> }) {
  const days = c.waiting_days ?? null
  return (
    <li className="flex items-center gap-3 py-3 sm:gap-4">
      <Avatar
        size="md"
        person={{ name: c.owner_name || "", initials: initialsOf(c.owner_name), photo_url: c.owner_photo_url ?? null }}
      />
      <div className="min-w-0 flex-1">
        <Link to={`/papers/${c.id}`} className="block truncate text-base font-medium underline-offset-4 hover:underline">
          {paperTitle(c.paper_title)}
        </Link>
        <Meta className="block truncate">{[c.owner_name, c.owner_department].filter(Boolean).join(" · ")}</Meta>
        <div className="sm:hidden">
          <AmountCell c={c} className="text-left" />
        </div>
      </div>
      <div className="hidden w-56 shrink-0 sm:block">
        <AmountCell c={c} />
      </div>
      <span
        className={cn(
          "hidden w-16 shrink-0 text-right text-sm tabular text-fg-muted sm:block",
          days != null && days > 30 && "font-medium text-critical",
          days != null && days > 14 && days <= 30 && "text-caution"
        )}
      >
        {waitingLabel(days)}
      </span>
      <Button size="sm" asChild>
        <Link to="/authorisations" aria-label={`Authorise: ${paperTitle(c.paper_title)}`}>
          Authorise
        </Link>
      </Button>
    </li>
  )
}

/** Only fetched when opened, so the morning screen does not wait for it. */
function ResearchAreas() {
  const areas = useApi<AreasPayload>(HOME_DATA.areas.key, HOME_DATA.areas.path)
  const coverage = areas.data?.coverage
  return (
    <div className="mt-3 space-y-3">
      {areas.isLoading ? (
        <SkeletonRows rows={6} rowHeight={28} />
      ) : areas.isError ? (
        <InlineError message="Could not load the subject areas." onRetry={() => void areas.refetch()} />
      ) : !areas.data || areas.data.areas.length === 0 ? (
        <p className="text-base text-fg-muted">No paper on record carries a subject area yet.</p>
      ) : (
        <>
          <p className="max-w-prose text-base text-fg-muted">
            {formatCount(areas.data.distinct)} subject areas across the record, showing the{" "}
            {Math.min(6, areas.data.shown)} largest. A paper spanning three areas is counted under each, so these add
            to more than the number of papers.
            {coverage && coverage.fraction < 0.95 && (
              <>
                {" "}
                Subject areas are known for {formatCount(coverage.classified)} of {formatCount(coverage.total)} papers,{" "}
                {Math.round(coverage.fraction * 100)}%. The other {formatCount(coverage.unclassified)} could not be
                matched to a journal and are absent from every bar, not counted as unclassified.
              </>
            )}
          </p>
          <AreaBars areas={areas.data.areas.slice(0, 6)} />
          <Link to="/reports" className="text-sm text-accent underline-offset-4 hover:underline">
            Build a report
          </Link>
        </>
      )}
    </div>
  )
}

/**
 * Subject areas as ranked bars. Drawn here rather than with `RankedBars`
 * because the quartile split inside each bar is the part a director reads: a
 * hundred papers in an area is a different fact depending on whether they are
 * Q1 or Q4, and a length-only bar cannot say which.
 */
function AreaBars({ areas }: { areas: AreasPayload["areas"] }) {
  const max = Math.max(...areas.map((a) => a.count), 1)
  return (
    <ul className="space-y-2">
      {areas.map((a) => {
        const q1 = a.quartiles.Q1 ?? 0
        const known = Object.values(a.quartiles).reduce((sum, n) => sum + n, 0)
        return (
          <li key={a.key} className="grid grid-cols-[1fr_auto] items-center gap-x-4 gap-y-1">
            <span className="min-w-0 truncate text-base">{a.key}</span>
            <span className="shrink-0 text-sm tabular text-fg-muted">
              {q1 > 0 && <span className="text-positive">{q1} in Q1 · </span>}
              {a.count} papers
            </span>
            <span className="col-span-2 flex h-1.5 w-full overflow-hidden rounded-full bg-sunken" aria-hidden>
              <span className="block bg-positive" style={{ width: `${(q1 / max) * 100}%` }} />
              <span className="block bg-accent" style={{ width: `${((a.count - q1) / max) * 100}%` }} />
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
