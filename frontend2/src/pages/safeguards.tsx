import { useState } from "react"
import { Link } from "react-router-dom"
import { CircleCheck, RefreshCw } from "lucide-react"

import { api } from "@/lib/api"
import { cn } from "@/lib/cn"
import { formatCount } from "@/lib/count"
import { queryClient, useApi } from "@/lib/query"
import { AnswerLine, AnswerWord } from "@/ui/answer"
import { Button } from "@/ui/button"
import { Chip } from "@/ui/chip"
import { PageHeader } from "@/ui/page-header"
import { Details, Rows, Section } from "@/ui/section"
import { ErrorState, SkeletonRows } from "@/ui/state"
import { Table, type Column } from "@/ui/table"
import { Meta } from "@/ui/text"
import { toast } from "@/ui/toast"
import { Ago } from "@/ui/when"

/**
 * Safeguards: did the rules that stop money going out twice hold?
 *
 * The database refuses a second payment, the pay button refuses a changed
 * amount, the filing form refuses a repeat. This page is the independent
 * witness: every night the system recomputes from the rows whether any of that
 * was bypassed (an import, a restore, a rule a migration had to skip) and says
 * so here, check by check, with the items and where to put each right.
 *
 * A super admin sees every check. Finance sees the payment checks only, with
 * their own counts: a doubt about a paper is not Finance's to be told
 * (`core.visibility`), so it is not on their page or in their totals.
 */

type Row = { id: string; label: string; href: string }
type CheckResult = {
  key: string
  group: string
  title: string
  severity: "error" | "warning" | "info"
  scope: "money" | "claims"
  count: number
  rows: Row[]
  help: string
  fix_to: string
  fix_label: string
  status: "ok" | "problem" | "look"
}
type Report = {
  ran_at: string
  seconds: number
  by: string
  problems: { error: number; warning: number; info: number }
  checks: CheckResult[]
  history: { ran_at: string; error: number; warning: number; info: number }[]
}
type Answer = { report: Report | null; scope: "all" | "money"; can_run: boolean }

const KEY = ["safeguards"]
const WORD: Record<CheckResult["severity"], string> = { error: "Problem", warning: "Look at it", info: "For the record" }
const CHIP: Record<CheckResult["severity"], "critical" | "caution" | "neutral"> = {
  error: "critical",
  warning: "caution",
  info: "neutral",
}
const RANK = { error: 0, warning: 1, info: 2 } as const

export function Safeguards() {
  const { data, isLoading, error, refetch } = useApi<Answer>(KEY, "/api/safeguards")
  const [running, setRunning] = useState(false)

  async function runNow() {
    setRunning(true)
    try {
      const fresh = await api<Answer>("/api/safeguards/run", { method: "POST" })
      queryClient.setQueryData(KEY, fresh)
      toast.ok("Checked again")
    } catch (e) {
      toast.fail(e, "The check did not run")
    } finally {
      setRunning(false)
    }
  }

  const report = data?.report ?? null
  const checks = report?.checks ?? []
  const found = checks
    .filter((c) => c.count > 0)
    .sort((a, b) => RANK[a.severity] - RANK[b.severity] || b.count - a.count)
  const passed = checks.filter((c) => c.count === 0)
  const groups = new Map<string, CheckResult[]>()
  for (const c of found) groups.set(c.group, [...(groups.get(c.group) ?? []), c])
  const errors = report?.problems.error ?? 0
  const looks = (report?.problems.warning ?? 0) + (report?.problems.info ?? 0)

  return (
    <div className="page space-y-14">
      <PageHeader
        title="Safeguards"
        sub={
          data?.scope === "money"
            ? "Did every payment keep the rules that stop money going out twice?"
            : "Did every payment and claim keep the rules that stop money going out twice?"
        }
        action={
          data?.can_run ? (
            <Button kind="primary" onClick={() => void runNow()} disabled={running}>
              <RefreshCw aria-hidden className={cn(running && "animate-spin")} />
              {running ? "Checking" : "Check now"}
            </Button>
          ) : undefined
        }
      />

      {isLoading ? (
        <SkeletonRows rows={8} />
      ) : error ? (
        <ErrorState
          what="the safeguards"
          title="Could not load the safeguards"
          message="The server did not answer. Nothing has been changed. Try again."
          onRetry={() => void refetch()}
        />
      ) : !report ? (
        <div className="space-y-3">
          <AnswerLine>
            The checks <AnswerWord tone="amber">have not run</AnswerWord> yet.
          </AnswerLine>
          <p className="text-fg-muted">
            They run every night. {data?.can_run ? "Press Check now to run them once, now." : "Ask a super admin to run them once."}
          </p>
        </div>
      ) : (
        <>
          <section aria-label="The answer" className="space-y-3">
            <AnswerLine>
              {errors === 0 ? (
                <>
                  Every payment rule <AnswerWord tone="sage">held</AnswerWord>.
                  {looks > 0 && ` ${formatCount(looks)} ${looks === 1 ? "thing is" : "things are"} worth a look.`}
                </>
              ) : (
                <>
                  {formatCount(errors)} {errors === 1 ? "check" : "checks"} found a <AnswerWord tone="crimson">problem</AnswerWord>.
                </>
              )}
            </AnswerLine>
            <p className="text-sm text-fg-muted">
              Checked <Ago iso={report.ran_at} />
              {report.by ? `, by ${report.by.toLowerCase().startsWith("the ") ? report.by.toLowerCase() : report.by}` : ""}.{" "}
              {formatCount(checks.length)} checks, every night.
            </p>
          </section>

          {found.length === 0 ? (
            <p className="rounded-panel bg-sunken px-4 py-8 text-center text-sm text-fg-muted">
              Every check found nothing. No payment was doubled, changed after it was authorised, or made without a
              record.
            </p>
          ) : (
            [...groups.entries()].map(([group, items]) => (
              <Section key={group} title={group}>
                <Rows>
                  {items.map((c) => (
                    <CheckRow key={c.key} c={c} />
                  ))}
                </Rows>
              </Section>
            ))
          )}

          {passed.length > 0 && (
            <Details label="the checks that found nothing" count={passed.length}>
              <Rows>
                {passed.map((c) => (
                  <li key={c.key} className="flex items-start gap-2 py-2.5 text-sm">
                    <CircleCheck aria-hidden className="mt-0.5 size-4 shrink-0 text-positive" />
                    <span className="flex-1">
                      <span className="block">{c.title}</span>
                      <Meta className="block">{c.group}</Meta>
                    </span>
                    <span className="text-fg-muted">Nothing found</span>
                  </li>
                ))}
              </Rows>
            </Details>
          )}

          {report.history.length > 1 && (
            <Details label="earlier runs" count={report.history.length}>
              <HistoryTable runs={[...report.history].reverse()} />
            </Details>
          )}
        </>
      )}
    </div>
  )
}

function CheckRow({ c }: { c: CheckResult }) {
  return (
    <li className="py-4">
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-2">
        <div className="min-w-0 flex-1 basis-72">
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="font-medium">{c.title}</span>
            <Chip tone={CHIP[c.severity]}>{WORD[c.severity]}</Chip>
          </p>
          <p className="mt-1 max-w-prose text-sm text-fg-muted">{c.help}</p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-3">
          <span className={cn("figure text-figure tabular", c.severity === "error" ? "text-critical" : "text-fg")}>
            {formatCount(c.count)}
          </span>
          {c.fix_to && (
            <Button kind="default" asChild>
              <Link to={c.fix_to}>{c.fix_label || "Open"}</Link>
            </Button>
          )}
        </div>
      </div>
      {c.rows.length > 0 && (
        <Details label="the items" count={c.count} className="mt-2">
          <ul className="space-y-1.5 text-sm">
            {c.rows.map((r) => (
              <li key={r.id} className="truncate">
                {r.href ? (
                  <Link className="text-accent underline-offset-2 hover:underline" to={r.href}>
                    {r.label}
                  </Link>
                ) : (
                  r.label
                )}
              </li>
            ))}
            {c.count > c.rows.length && (
              <Meta className="block">
                Showing {formatCount(c.rows.length)} of {formatCount(c.count)}. Put these right and check again to see
                the rest.
              </Meta>
            )}
          </ul>
        </Details>
      )}
    </li>
  )
}

function HistoryTable({ runs }: { runs: Report["history"] }) {
  const cols: Column<Report["history"][number]>[] = [
    { key: "when", header: "Checked", cell: (r) => new Date(r.ran_at).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" }) },
    { key: "error", header: "Problems", align: "right", cell: (r) => formatCount(r.error) },
    { key: "warning", header: "To look at", align: "right", cell: (r) => formatCount(r.warning + r.info) },
  ]
  return <Table rows={runs.slice(0, 14)} columns={cols} getKey={(r) => r.ran_at} caption="Earlier runs of the safeguards check" />
}
