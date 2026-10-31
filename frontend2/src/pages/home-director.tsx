import { useState } from "react"
import { Link } from "react-router-dom"
import { FileText, Stamp } from "lucide-react"

import { useAuth } from "@/app/auth"
import { HOME_DATA } from "@/app/home-data"
import { formatCount } from "@/lib/count"
import { deptLabel, paperTitle } from "@/lib/names"
import { useApi } from "@/lib/query"
import { AuthoriseDialog, BulkAuthoriseDialog, thresholdClause, type AuthClaim } from "@/pages/authorise-dialogs"
import { BudgetStrip, budgetLine } from "@/pages/budget-strip"
import { YourPapers, type BudgetSummary, type Claim } from "@/pages/home-staff"
import { MonthPaperwork, useNewestMonth } from "@/pages/month-paperwork"
import { Answer } from "@/ui/answer"
import { Button } from "@/ui/button"
import { PageHeader } from "@/ui/page-header"
import { money } from "@/ui/paper"
import { reviewLink, waitTone, waitingLabel } from "@/ui/queue"
import { Section } from "@/ui/section"
import { InlineError, SkeletonRows } from "@/ui/state"
import { Table, type Column } from "@/ui/table"
import { thresholdFlag } from "@/ui/research-threshold"

/**
 * The Director's first screen.
 *
 * Four numbers say what is waiting for the signature, what it comes to, what
 * is left in the year's budget and what is still with the Principal. One
 * table lists the claims that have waited longest, each with an Authorise
 * button that acts in place. The month's statement is below it, with the
 * statement to sign as the main button when nothing else is waiting.
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

const SHOWN = 10

export function DirectorHome() {
  const { me } = useAuth()
  const D = HOME_DATA

  // The whole queue, not a page of it: the numbers sum it, the batch button
  // authorises it, and the table shows the ten that have waited longest.
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
  const left = stripBudget && stripBudget.allocated != null ? stripBudget.allocated - stripBudget.spent - stripBudget.committed : null
  const longest = totals?.longest_wait_days ?? null

  const statementPrimary = !!newest.month && n === 0

  const columns: Column<Claim & Partial<AuthClaim>>[] = [
    {
      key: "owner",
      header: "Claimant",
      exportValue: (c) => [c.owner_name, c.owner_department].filter(Boolean).join(", "),
      cell: (c) => (
        <>
          <span className="font-medium">{c.owner_name}</span>
          {c.owner_department && <span className="block text-sm text-fg-muted">{deptLabel(c.owner_department)}</span>}
        </>
      ),
    },
    {
      key: "paper",
      header: "Paper",
      truncate: true,
      exportValue: (c) => paperTitle(c.paper_title),
      cell: (c) => paperTitle(c.paper_title),
    },
    {
      key: "amount",
      header: "Amount",
      align: "right",
      exportKind: "money",
      exportValue: (c) => c.remuneration,
      cell: (c) => {
        const held = thresholdClause(c as AuthClaim) ?? thresholdFlag(c as AuthClaim)
        return (
          <>
            {money(c.remuneration)}
            {held && <span className="block text-sm font-normal text-caution">{held}</span>}
          </>
        )
      },
    },
    {
      key: "wait",
      header: "Waiting",
      exportValue: (c) => waitingLabel(c.waiting_days ?? null),
      cell: (c) => {
        const tone = waitTone(c.waiting_days ?? null)
        return <span className={tone ? `font-medium ${tone}` : "text-fg-muted"}>{waitingLabel(c.waiting_days ?? null)}</span>
      },
    },
    {
      key: "act",
      header: "Action",
      label: "Authorise",
      cell: (c) => (
        <Button onClick={() => setActing(c as AuthClaim)} aria-label={`Authorise: ${paperTitle(c.paper_title)}`}>
          Authorise
        </Button>
      ),
    },
  ]

  return (
    <div className="page space-y-8">
      <PageHeader
        title="Home"
        sub="Claims waiting for your signature and the budget they use."
        action={
          n > 0 && allFetched ? (
            <Button kind="primary" onClick={() => setBatchOpen(true)}>
              <Stamp />
              Authorise all {formatCount(n)} · {money(totals?.amount)}
            </Button>
          ) : statementPrimary && newest.month ? (
            <Button kind="primary" asChild>
              <a href={`/api/payouts/statement.pdf?month=${newest.month.month}`} download>
                <FileText />
                Statement to sign (PDF)
              </a>
            </Button>
          ) : undefined
        }
      />

      {queue.isError ? (
        <InlineError message="Could not load the authorisation queue." onRetry={() => void queue.refetch()} />
      ) : (
        <>
          <Answer
            items={[
              {
                value: totals ? n : null,
                label: `${n === 1 ? "claim" : "claims"} waiting for your signature`,
                zero: "Nothing is waiting for your signature",
                to: "/authorisations",
                tone: n > 0 ? "caution" : "neutral",
              },
              {
                value: totals ? money(totals.amount) : null,
                label: "to authorise",
                to: "/authorisations",
                tone: longest != null && longest > 30 ? "critical" : "neutral",
              },
              {
                value: budget.data ? (left != null ? money(left) : "Not set") : null,
                label: budget.data ? `left in the ${budget.data.financial_year} budget` : "left in the budget",
                to: "/budget",
              },
              {
                value: counts.data ? withPrincipal : null,
                label: "with the Principal",
                zero: "Nothing with the Principal",
                to: "/track",
              },
            ]}
          />

          {(n > 0 || (stripBudget?.allocated ?? null) != null) && (
            <div className="max-w-2xl space-y-3">
              <p className="text-sm text-fg-muted" data-testid="authorising-means">
                {n > 0
                  ? (line ?? " ")
                  : budget.data && stripBudget
                    ? stripBudget.allocated == null
                      ? null
                      : `The ${budget.data.financial_year} budget has ${money(stripBudget.allocated - stripBudget.spent - stripBudget.committed)} left.`
                    : " "}
              </p>
              <BudgetStrip budget={stripBudget} batch={totals?.amount ?? 0} labels="wide" />
            </div>
          )}

          {batchOpen && (
            <BulkAuthoriseDialog
              claims={waiting as AuthClaim[]}
              onClose={() => setBatchOpen(false)}
              onDone={() => void queue.refetch()}
            />
          )}
          {acting && <AuthoriseDialog claim={acting} onClose={() => setActing(null)} />}

          <Section title="Waiting longest">
            {queue.isLoading ? (
              <SkeletonRows rows={4} rowHeight={56} />
            ) : (
              <>
                <Table
                  rows={oldestFirst.slice(0, SHOWN)}
                  columns={columns}
                  getKey={(c) => c.id}
                  rowLink={(c) => reviewLink(c.id, "authorisations")}
                  tools={{ id: "director-home-authorisations", title: "Claims waiting for authorisation" }}
                  empty={{
                    title: "No claim to authorise",
                    message: "The Principal's next approvals appear here as soon as they are signed.",
                  }}
                />
                <p className="mt-2 text-sm">
                  <Link to="/authorisations" className="text-accent underline-offset-4 hover:underline">
                    {queue.data && queue.data.total > SHOWN ? `View all ${formatCount(queue.data.total)} in Authorisations` : "View in Authorisations"}
                  </Link>
                </p>
              </>
            )}
          </Section>
        </>
      )}

      <MonthPaperwork title="The month's statement" />

      {/* The Director's own research, after the authorising: another officer
          authorises the Director's own papers, never the Director. */}
      <YourPapers />
    </div>
  )
}
