import { useState } from "react"
import { Link, useNavigate } from "react-router-dom"
import { FileText, Stamp } from "lucide-react"

import { useAuth } from "@/app/auth"
import { HOME_DATA } from "@/app/home-data"
import { cn } from "@/lib/cn"
import { formatCount } from "@/lib/count"
import { paperTitle } from "@/lib/names"
import { useApi } from "@/lib/query"
import { AuthoriseDialog, BulkAuthoriseDialog, thresholdClause, type AuthClaim } from "@/pages/authorise-dialogs"
import { BudgetStrip, budgetLine, claimsWord } from "@/pages/budget-strip"
import { greeting, YourPapers, type BudgetSummary, type Claim } from "@/pages/home-staff"
import { MonthPaperwork, useNewestMonth } from "@/pages/month-paperwork"
import { MoneyThread } from "@/pages/money-thread"
import { AnswerLine, AnswerWord, tieNumbers } from "@/ui/answer"
import { Button } from "@/ui/button"
import { ComingUp } from "@/ui/coming-up"
import { PageHeader } from "@/ui/page-header"
import { money } from "@/ui/paper"
import { Avatar, initialsOf } from "@/ui/person"
import { reviewLink, waitTone, waitingLabel } from "@/ui/queue"
import { Details, Section } from "@/ui/section"
import { InlineError, SkeletonRows, SkeletonText } from "@/ui/state"
import { thresholdFlag } from "@/ui/research-threshold"

/**
 * The Director's first screen (docs/ux/28).
 *
 * One sentence says what is waiting for the signature, in the biggest type on
 * the page; the line under it says what authorising does to the year's budget,
 * and the strip beneath draws it (paid, already committed, this batch, left).
 * Then the work: the claims that have waited longest, with a face, the
 * amount (the research threshold beside it where it cut one) and an Authorise
 * button that acts in place. The Thread shows where every claim is with "Your
 * desk" at Approved; the month's statement is one row, with the statement to
 * sign when there is nothing else to do. One primary button at a time:
 * "Authorise all" while claims wait, "Statement to sign" when they do not.
 *
 * What the college researches (the subject areas) used to fill half of this
 * screen. It is a real question but not the morning one, so it is one click
 * down, with the share of the record it can classify beside it.
 *
 * Nothing here is a flag. The Director is contest-blind (`core.visibility`).
 */

type DirectorQueue = {
  total: number
  results: (Claim & Partial<AuthClaim>)[]
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

  // The whole queue, not a page of it: the sentence sums it, the batch button
  // authorises it, and the list below shows the six that have waited longest.
  const queue = useApi<DirectorQueue>(D.directorQueue.key, D.directorQueue.path)
  const budget = useApi<BudgetSummary & { financial_year: string }>(D.budget.key, D.budget.path)
  const counts = useApi<{ counts: Record<string, number> }>(D.stageCounts.key, D.stageCounts.path)
  const newest = useNewestMonth()
  const [batchOpen, setBatchOpen] = useState(false)
  const [acting, setActing] = useState<AuthClaim | null>(null)

  const totals = queue.data?.totals
  const waiting = (queue.data?.results ?? []).filter((c) => !me?.id || c.owner_id !== me.id)
  const allFetched = (queue.data?.total ?? 0) <= (queue.data?.results.length ?? 0)
  const oldestFirst = waiting.slice().sort((a, b) => (b.waiting_days ?? 0) - (a.waiting_days ?? 0))
  const n = totals?.count ?? 0
  const withPrincipal = counts.data?.counts.checked ?? 0
  const line = budgetLine(budget.data, "authorising", n !== 1)
  const stripBudget = budget.data?.college

  const statementPrimary = !!newest.month && n === 0

  return (
    <div className="page space-y-14">
      <PageHeader
        title={greeting(me?.name, me?.placeholder)}
        action={
          n > 0 && allFetched ? (
            <Button kind="primary" size="lg" onClick={() => setBatchOpen(true)}>
              <Stamp />
              Authorise all {formatCount(n)} · {money(totals?.amount)}
            </Button>
          ) : statementPrimary && newest.month ? (
            <Button kind="primary" size="lg" asChild>
              <a href={`/api/payouts/statement.pdf?month=${newest.month.month}`} download>
                <FileText />
                Statement to sign (PDF)
              </a>
            </Button>
          ) : undefined
        }
        spot="spot-authorisations"
      />

      {queue.isError ? (
        <InlineError message="Could not load the authorisation queue." onRetry={() => void queue.refetch()} />
      ) : (
        <>
          <div className="space-y-5">
            <AnswerLine>
              {!totals ? (
                "What needs your signature."
              ) : n === 0 ? (
                tieNumbers(
                  withPrincipal > 0
                    ? `Nothing is waiting for your signature. ${claimsWord(withPrincipal)} ${withPrincipal === 1 ? "is" : "are"} with the Principal.`
                    : "Nothing is waiting for your signature."
                )
              ) : (
                <>
                  {tieNumbers(`${claimsWord(n)}, ${money(totals.amount)}, ${n === 1 ? "is" : "are"}`)}{" "}
                  <AnswerWord tone="clay">waiting for you</AnswerWord>.
                </>
              )}
            </AnswerLine>
            {(n > 0 || (stripBudget?.allocated ?? null) != null) && (
              <div className="max-w-2xl space-y-3">
                <p className="text-lead text-fg-muted" data-testid="authorising-means">
                  {n > 0
                    ? (line ?? " ")
                    : budget.data && stripBudget
                      ? stripBudget.allocated == null
                        ? null
                        : `The ${budget.data.financial_year} budget has ${money(stripBudget.allocated - stripBudget.spent - stripBudget.committed)} left.`
                      : " "}
                </p>
                <BudgetStrip budget={stripBudget} batch={totals?.amount ?? 0} labels="wide" />
              </div>
            )}
          </div>

          {batchOpen && (
            <BulkAuthoriseDialog
              claims={waiting as AuthClaim[]}
              onClose={() => setBatchOpen(false)}
              onDone={() => void queue.refetch()}
            />
          )}
          {acting && <AuthoriseDialog claim={acting} onClose={() => setActing(null)} />}

          <Section
            title="Waiting longest"
            action={
              <Button kind="default" size="sm" asChild>
                <Link to="/authorisations">
                  {queue.data && queue.data.total > 0 ? `All ${formatCount(queue.data.total)} in Authorisations` : "Authorisations"}
                </Link>
              </Button>
            }
          >
            {queue.isLoading ? (
              <SkeletonRows rows={4} rowHeight={64} />
            ) : oldestFirst.length === 0 ? (
              <div className="space-y-4">
                <p className="text-base text-fg-muted">The Principal's next approvals appear here as soon as they are signed.</p>
                <ComingUp desk="director" align="start" />
              </div>
            ) : (
              <ul className="divide-y divide-line">
                {oldestFirst.slice(0, 6).map((c) => (
                  <AuthoriseRow key={c.id} c={c as AuthClaim} onAuthorise={() => setActing(c as AuthClaim)} />
                ))}
              </ul>
            )}
          </Section>
        </>
      )}

      <Section title="Where every claim is">
        <MoneyThread />
      </Section>

      <MonthPaperwork title="The month's statement" primary={statementPrimary} />

      <Details label="what the college researches" className="border-t border-line pt-6">
        <ResearchAreas />
      </Details>

      {/* The Director's own research, after the authorising: another officer
          authorises the Director's own papers, never the Director. */}
      <YourPapers />
    </div>
  )
}

function AuthoriseRow({ c, onAuthorise }: { c: AuthClaim; onAuthorise: () => void }) {
  const navigate = useNavigate()
  const days = c.waiting_days ?? null
  const held = thresholdClause(c) ?? thresholdFlag(c)
  const href = reviewLink(c.id, "authorisations")
  return (
    <li
      onClick={(e) => {
        if ((e.target as HTMLElement).closest("button, a")) return
        navigate(href)
      }}
      className="flex cursor-pointer items-center gap-3 px-1 py-3 hover:bg-hover sm:gap-4"
    >
      <Avatar
        size="md"
        person={{ name: c.owner_name || "", initials: initialsOf(c.owner_name), photo_url: c.owner_photo_url ?? null }}
      />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm">
          <span className="font-medium">{c.owner_name}</span>
          {c.owner_department && <span className="text-fg-muted"> · {c.owner_department}</span>}
        </p>
        <Link to={href} className="block truncate text-base underline-offset-4 hover:underline">
          {paperTitle(c.paper_title)}
        </Link>
        <p className="mt-0.5 text-xs text-fg-muted sm:hidden">
          <span className="tabular font-medium text-fg">{money(c.remuneration)}</span>{" "}
          <span className={cn("tabular", waitTone(days) && `font-medium ${waitTone(days)}`)}>{waitingLabel(days)}</span>
        </p>
        {held && <p className="mt-0.5 text-sm text-caution">{held}</p>}
      </div>
      <span className="hidden w-28 shrink-0 text-right text-base font-medium tabular sm:block">{money(c.remuneration)}</span>
      <span
        className={cn("hidden w-16 shrink-0 text-right text-sm tabular text-fg-muted sm:block", waitTone(days) && `font-medium ${waitTone(days)}`)}
      >
        {waitingLabel(days)}
      </span>
      <Button size="sm" onClick={onAuthorise} aria-label={`Authorise: ${paperTitle(c.paper_title)}`}>
        Authorise
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
        <SkeletonText lines={4} />
      ) : areas.isError ? (
        <InlineError message="Could not load the subject areas." onRetry={() => void areas.refetch()} />
      ) : !areas.data || areas.data.areas.length === 0 ? (
        <p className="text-base text-fg-muted">No paper on record carries a subject area yet.</p>
      ) : (
        <>
          <p className="max-w-prose text-base text-fg-muted">
            {formatCount(areas.data.distinct)} subject areas, the {Math.min(6, areas.data.shown)} largest shown. A paper
            in three areas counts under each.
            {coverage && coverage.fraction < 0.95 && (
              <>
                {" "}
                Known for {formatCount(coverage.classified)} of {formatCount(coverage.total)} papers (
                {Math.round(coverage.fraction * 100)}%); the rest could not be matched to a journal and are in no bar.
              </>
            )}
          </p>
          <AreaBars areas={areas.data.areas.slice(0, 6)} />
          <Button kind="default" size="sm" asChild>
            <Link to="/reports">Build a report</Link>
          </Button>
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
