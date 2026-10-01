import { Link } from "react-router-dom"
import { CheckCircle2, Download, FileText } from "lucide-react"

import { useAuth } from "@/app/auth"
import { formatCount } from "@/lib/count"
import { useApi } from "@/lib/query"
import { Button } from "@/ui/button"
import { money } from "@/ui/paper"
import { Rows, Section } from "@/ui/section"
import { InlineError, Skeleton } from "@/ui/state"
import { Meta } from "@/ui/text"
import type { StatementMonth } from "@/pages/statements"

/**
 * The month's paper, on the Home of the two people who handle it.
 *
 * The Director signs the payment statement and Finance sends the bank file and
 * reconciles it. Both used to hunt for it: Finance under Money, the Director
 * under a Help guide called "Sign the monthly payout statement". Here it is the
 * newest months with money in them, each with the file for the person's job,
 * and, for the newest, the one sentence a signer needs: does it agree with the
 * ledger, or what has to be explained first. The figures are the statement's
 * own (`/api/payouts/statement`), never recomputed on the Home.
 */

type StatementLite = {
  month: string
  label: string
  total: number
  count: number
  reconciliation: { balanced: boolean; issues: { ticket: string | null; problem: string }[] }
}

export function MonthPaperwork({ title = "The month's paper" }: { title?: string }) {
  const { me } = useAuth()
  const isFinance = me?.role === "FINANCE" || me?.role === "SUPER_ADMIN"
  const months = useApi<{ months: StatementMonth[] }>(["payouts", "months"], "/api/payouts/months")
  const list = (months.data?.months ?? []).filter((m) => m.count > 0).slice(0, 2)
  const newest = list[0]
  const st = useApi<StatementLite>(
    ["payouts", "statement", newest?.month ?? ""],
    `/api/payouts/statement?month=${newest?.month ?? ""}`,
    { enabled: !!newest }
  )

  if (months.isError) {
    return (
      <Section title={title}>
        <InlineError message="Could not load the months." onRetry={() => void months.refetch()} />
      </Section>
    )
  }

  return (
    <Section
      title={title}
      sub={
        isFinance
          ? "Send the bank file, then file the statement the Director signs."
          : "The payment statement for the month, with the ledger check beside it."
      }
      action={
        <Link to="/statements" className="text-accent underline-offset-4 hover:underline">
          All months
        </Link>
      }
    >
      {months.isLoading ? (
        <Skeleton className="h-16 w-full" />
      ) : list.length === 0 ? (
        <p className="text-base text-fg-muted">
          No payment has been made yet. The first month appears here once Finance pays a claim.
        </p>
      ) : (
        <Rows>
          {list.map((m, i) => (
            <li key={m.month} className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 py-3">
              <div className="min-w-0 basis-64">
                <p className="text-base font-medium">{m.label}</p>
                <Meta className="block">
                  {money(m.amount)} in {formatCount(m.count)} {m.count === 1 ? "payment" : "payments"}
                </Meta>
                {i === 0 && st.data && (
                  <p className={st.data.reconciliation.balanced ? "mt-1 flex items-start gap-1.5 text-sm text-positive" : "mt-1 text-sm text-caution"}>
                    {st.data.reconciliation.balanced ? (
                      <>
                        <CheckCircle2 className="mt-0.5 size-4 shrink-0" aria-hidden />
                        <span>Agrees with the ledger: every claim paid has one ledger row for the same amount.</span>
                      </>
                    ) : (
                      <span>
                        {formatCount(st.data.reconciliation.issues.length)}{" "}
                        {st.data.reconciliation.issues.length === 1 ? "line needs" : "lines need"} explaining before this
                        month is signed.
                      </span>
                    )}
                  </p>
                )}
              </div>
              <span className="flex flex-wrap gap-2">
                {isFinance && (
                  <Button kind="default" size="sm" asChild>
                    <a href={`/api/payouts/statement.csv?month=${m.month}`} download>
                      <Download />
                      Bank file (CSV)
                    </a>
                  </Button>
                )}
                <Button kind={isFinance ? "default" : "primary"} size="sm" asChild>
                  <a href={`/api/payouts/statement.pdf?month=${m.month}`} download>
                    <FileText />
                    Statement to sign (PDF)
                  </a>
                </Button>
                <Button kind="quiet" size="sm" asChild>
                  <Link to={`/statements?month=${m.month}`}>Open</Link>
                </Button>
              </span>
            </li>
          ))}
        </Rows>
      )}
    </Section>
  )
}
