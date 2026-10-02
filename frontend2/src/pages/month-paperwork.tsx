import { Link } from "react-router-dom"
import { CheckCircle2, CircleAlert, FileText } from "lucide-react"

import { useAuth } from "@/app/auth"
import { cn } from "@/lib/cn"
import { formatCount } from "@/lib/count"
import { useApi } from "@/lib/query"
import { BankFileButton, type BankExports } from "@/pages/bank-file"
import type { StatementMonth } from "@/pages/statements"
import { Button } from "@/ui/button"
import { money } from "@/ui/paper"
import { Section } from "@/ui/section"
import { InlineError, Skeleton } from "@/ui/state"

/**
 * The month's paper, on the Home of the two people who handle it.
 *
 * The Director signs the payment statement; Finance releases the bank file and
 * hands over the statement. Both used to hunt for it. Here it is the newest
 * month with money in it as one row: how much, whether it agrees with the
 * ledger (or how many lines need explaining first), and for Finance whether
 * the bank file has gone (the bank pays what it is sent, so "not released" and
 * "released 3 Oct by Kavya" are the two facts that stop a month being paid
 * twice). The buttons are the files: the statement to sign, and for Finance the
 * bank file. Older months are one button away. Every figure is the statement's
 * own (`/api/payouts/statement`), never recomputed on the Home.
 */

type StatementLite = {
  month: string
  label: string
  total: number
  count: number
  reconciliation: { balanced: boolean; issues: { ticket: string | null; problem: string }[] }
}

/** The newest month that has money in it, for the Home's one-row summary. */
export function useNewestMonth() {
  const months = useApi<{ months: StatementMonth[] }>(["payouts", "months"], "/api/payouts/months")
  const month = (months.data?.months ?? []).find((m) => m.count > 0)
  return { month, isLoading: months.isLoading, isError: months.isError, refetch: months.refetch }
}

const when = (iso: string) => new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short" })

export function MonthPaperwork({
  title = "The month's paper",
  primary = false,
}: {
  title?: string
  /** The statement is this screen's one primary (nothing else is waiting). */
  primary?: boolean
}) {
  const { me } = useAuth()
  const isFinance = me?.role === "FINANCE" || me?.role === "SUPER_ADMIN"
  const { month: m, isLoading, isError, refetch } = useNewestMonth()
  const st = useApi<StatementLite>(
    ["payouts", "statement", m?.month ?? ""],
    `/api/payouts/statement?month=${m?.month ?? ""}`,
    { enabled: !!m }
  )
  const bank = useApi<BankExports>(["bank-exports", m?.month ?? ""], `/api/payouts/bank-exports?month=${m?.month ?? ""}`, {
    enabled: !!m && isFinance,
  })

  if (isError) {
    return (
      <Section title={title}>
        <InlineError message="Could not load the months." onRetry={() => void refetch()} />
      </Section>
    )
  }

  const issues = st.data?.reconciliation.issues.length ?? 0
  const sent = bank.data?.exports[0]

  return (
    <Section
      title={title}
      action={
        <Button kind="default" size="sm" asChild>
          <Link to="/statements">All months</Link>
        </Button>
      }
    >
      {isLoading ? (
        <Skeleton className="h-16 w-full" />
      ) : !m ? (
        <p className="text-base text-fg-muted">The first month appears here once Finance pays a claim.</p>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
          <div className="min-w-0 basis-72 space-y-1">
            <p className="text-base font-medium">
              {m.label}
              <span className="font-normal text-fg-muted">
                {" "}
                · {money(m.amount)} in {formatCount(m.count)} {m.count === 1 ? "payment" : "payments"}
              </span>
            </p>
            {st.data && (
              <p
                className={cn(
                  "flex items-center gap-1.5 text-sm",
                  st.data.reconciliation.balanced ? "text-positive" : "text-caution"
                )}
              >
                {st.data.reconciliation.balanced ? (
                  <CheckCircle2 className="size-4 shrink-0" aria-hidden />
                ) : (
                  <CircleAlert className="size-4 shrink-0" aria-hidden />
                )}
                {st.data.reconciliation.balanced
                  ? "Agrees with the ledger"
                  : `${formatCount(issues)} ${issues === 1 ? "line" : "lines"} to explain before it is signed`}
              </p>
            )}
            {isFinance && bank.data && (
              <p className={cn("text-sm", sent ? "text-fg-muted" : "text-caution")}>
                {sent
                  ? `Bank file released ${when(sent.created_at)}${sent.by ? ` by ${sent.by}` : ""}`
                  : "Bank file not released yet"}
              </p>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            {isFinance && <BankFileButton month={m.month} />}
            <Button kind={primary ? "primary" : "default"} asChild>
              <a href={`/api/payouts/statement.pdf?month=${m.month}`} download>
                <FileText />
                Statement to sign (PDF)
              </a>
            </Button>
            <Button kind="default" asChild>
              <Link to={`/statements?month=${m.month}`}>Open</Link>
            </Button>
          </div>
        </div>
      )}
    </Section>
  )
}
