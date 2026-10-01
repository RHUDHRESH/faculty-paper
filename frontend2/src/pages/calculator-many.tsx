import { useState } from "react"
import { Link, useSearchParams } from "react-router-dom"
import { Download } from "lucide-react"

import { useAuth } from "@/app/auth"
import { useApi } from "@/lib/query"
import { formatCount } from "@/lib/count"
import { ClaimNo, FaceName, IMPORTED_MEANING } from "@/pages/admin-b-parts"
import { monthWord, moreOrLess, type Many, type ManyRow, rs } from "@/pages/calculator-types"
import { claimHref } from "@/pages/track-data"
import { Answer } from "@/ui/answer"
import { Button } from "@/ui/button"
import { Checkbox, Field, Select } from "@/ui/field"
import { Details, Section } from "@/ui/section"
import { ErrorState, SkeletonRows } from "@/ui/state"
import { Table } from "@/ui/table"
import { Meta } from "@/ui/text"

/**
 * Tab 3: check many.
 *
 * Every approved, authorised and paid claim, recomputed against the policy it
 * was priced with, and the ones that differ by more than one rupee, largest
 * first, each with its cause. One request; the server recomputes in memory.
 * A list to read and to download. It changes nothing.
 */

const STAGES = [
  { value: "approved,authorised,paid", label: "Approved, authorised and paid" },
  { value: "approved", label: "Approved, waiting for the Director" },
  { value: "authorised", label: "Authorised, waiting to be paid" },
  { value: "paid", label: "Paid" },
]
const PAGE = 100

export function ManyTab() {
  const { me } = useAuth()
  const [params, setParams] = useSearchParams()
  const stage = params.get("stage") ?? "approved,authorised,paid"
  const submitted = params.get("submitted") === "1"
  const department = params.get("department") ?? ""
  const month = params.get("month") ?? ""
  const cause = params.get("cause") ?? ""
  const direction = params.get("direction") ?? ""
  const [shown, setShown] = useState(PAGE)

  function setFilter(next: Record<string, string | null>) {
    const p = new URLSearchParams(params)
    p.set("tab", "many")
    for (const [k, v] of Object.entries(next)) {
      if (v) p.set(k, v)
      else p.delete(k)
    }
    setParams(p, { replace: true })
    setShown(PAGE)
  }

  const qs = new URLSearchParams()
  qs.set("stage", stage)
  if (submitted) qs.set("submitted", "true")
  if (department) qs.set("department", department)
  if (month) qs.set("month", month)
  if (cause) qs.set("cause", cause)
  if (direction) qs.set("direction", direction)
  const listQs = new URLSearchParams(qs)
  listQs.set("limit", String(shown))

  const q = useApi<Many>(["calculator", "many", listQs.toString()], `/api/calculator/many?${listQs}`)
  const d = q.data
  const t = d?.totals

  const filtered = !!(department || month || cause || direction)
  const link = (extra: Record<string, string>) => {
    const p = new URLSearchParams(params)
    p.set("tab", "many")
    p.delete("cause")
    p.delete("direction")
    for (const [k, v] of Object.entries(extra)) p.set(k, v)
    return `/calculator?${p}#differences`
  }

  return (
    <div className="space-y-8">
      <div className="well flex flex-wrap items-end gap-x-4 gap-y-3 p-3">
        <Field label="Which claims" className="min-w-0 sm:w-64">
          <Select size="sm" value={stage} onChange={(e) => setFilter({ stage: e.target.value })}>
            {STAGES.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Department" className="min-w-0 sm:w-44">
          <Select size="sm" value={department} onChange={(e) => setFilter({ department: e.target.value })}>
            <option value="">All departments</option>
            {(d?.departments ?? []).map((x) => (
              <option key={x} value={x}>
                {x}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Month" className="min-w-0 sm:w-40">
          <Select size="sm" value={month} onChange={(e) => setFilter({ month: e.target.value })}>
            <option value="">Any month</option>
            {(d?.months ?? []).map((x) => (
              <option key={x} value={x}>
                {monthWord(x)}
              </option>
            ))}
          </Select>
        </Field>
        <div className="pb-1">
          <Checkbox
            checked={submitted}
            onCheckedChange={(v) => setFilter({ submitted: v === true ? "1" : null })}
            label="Include claims still being checked"
          />
        </div>
      </div>

      {q.isError ? (
        <ErrorState what="the check" onRetry={() => void q.refetch()} />
      ) : !d || !t ? (
        <SkeletonRows rows={6} rowHeight={48} />
      ) : (
        <>
          <div className="space-y-3">
            <Answer
              items={[
                { value: t.checked, label: "Claims checked", zero: "No claims in these stages" },
                {
                  value: t.differ,
                  label: `Differ by more than ₹1 from the formula`,
                  zero: "Every claim agrees with its price",
                  to: link({}),
                  tone: t.differ > 0 ? "caution" : "positive",
                },
                {
                  value: rs(t.under),
                  label: "Recorded below the formula, in all",
                  to: link({ direction: "under" }),
                },
                {
                  value: rs(t.over),
                  label: "Recorded above the formula, in all",
                  to: link({ direction: "over" }),
                },
              ]}
            />
            <p className="max-w-prose text-pretty text-sm text-fg-muted" data-testid="many-note">
              {sentence(t, d.policy)}
            </p>
          </div>

          <Section
            id="differences"
            title={filtered ? `The ${formatCount(d.row_total)} that differ, filtered` : "Claims that differ"}
            sub="Largest difference first. Amounts are what the claim records against what the formula gives."
            action={
              d.row_total > 0 && (
                <Button kind="default" size="sm" asChild>
                  <a href={`/api/calculator/many.csv?${qs}`} download>
                    <Download aria-hidden />
                    Download {formatCount(d.row_total)} {d.row_total === 1 ? "row" : "rows"} (CSV)
                  </a>
                </Button>
              )
            }
          >
            {(cause || direction) && (
              <p className="mb-3 text-sm text-fg-muted">
                Showing{" "}
                {[direction === "under" ? "recorded below the formula" : direction === "over" ? "recorded above the formula" : null, cause ? (d.causes.find((c) => c.cause === cause)?.label ?? cause) : null]
                  .filter(Boolean)
                  .join(", ")}
                .{" "}
                <button type="button" className="underline underline-offset-2" onClick={() => setFilter({ cause: null, direction: null })}>
                  Show all
                </button>
              </p>
            )}
            <Table<ManyRow>
              rows={d.rows}
              getKey={(r) => r.id}
              caption="Claims whose recorded amount differs from the formula"
              empty={{
                art: t.differ === 0 && !filtered ? "empty-queue" : "no-results",
                title: filtered ? "No claim differs under these filters" : "Every claim agrees with its price",
                message: filtered
                  ? "Clear a filter to look at more claims."
                  : `${formatCount(t.checked)} claims were recomputed against the policy they were priced with, and none is more than ₹1 away.`,
              }}
              footer={{
                claim: `Total, ${formatCount(d.listed.count)} ${d.listed.count === 1 ? "claim" : "claims"}`,
                recorded: rs(d.listed.recorded),
                formula: rs(d.listed.formula),
                difference: moreOrLess(d.listed.difference),
              }}
              columns={[
                {
                  key: "claim",
                  header: "Claim no.",
                  cell: (r) => (
                    <div className="space-y-0.5">
                      <Link
                        to={`/calculator?tab=claim&q=${encodeURIComponent(r.ticket_number ?? "")}`}
                        className="whitespace-nowrap underline-offset-2 hover:underline"
                      >
                        <ClaimNo no={r.ticket_number} />
                      </Link>
                      <Meta className="block text-xs">
                        {r.status}, {monthWord(r.month)}
                      </Meta>
                    </div>
                  ),
                },
                { key: "who", header: "Claimant", cell: (r) => <FaceName person={r} /> },
                { key: "title", header: "Paper", truncate: true, className: "sm:max-w-[11rem]", cell: (r) => r.title },
                { key: "recorded", header: "Recorded", align: "right", cell: (r) => rs(r.recorded) },
                { key: "formula", header: "Formula", align: "right", cell: (r) => rs(r.formula) },
                { key: "difference", header: "Difference", align: "right", cell: (r) => moreOrLess(r.difference) },
                {
                  key: "cause",
                  header: "Cause and where to fix it",
                  cell: (r) => (
                    <div className="space-y-0.5">
                      <span title={r.cause_text ?? undefined} className="block text-sm">
                        {r.cause_label}
                      </span>
                      <FixLink r={r} role={me?.role} mine={me?.id === r.user_id} />
                    </div>
                  ),
                },
              ]}
            />
            {d.row_total > d.rows.length && (
              <div className="mt-3">
                <Button kind="default" onClick={() => setShown((n) => n + PAGE)}>
                  Show {formatCount(Math.min(PAGE, d.row_total - d.rows.length))} more
                </Button>
                <Meta className="ml-3 text-xs">
                  {formatCount(d.rows.length)} of {formatCount(d.row_total)} shown
                </Meta>
              </div>
            )}
            {d.rows.some((r) => r.imported) && <p className="mt-3 text-xs text-fg-muted">{IMPORTED_MEANING}</p>}
          </Section>

          {d.causes.length > 0 && (
            <Details label="the causes" count={d.causes.length}>
              <Table
                rows={d.causes}
                getKey={(c) => c.cause}
                columns={[
                  {
                    key: "cause",
                    header: "Cause",
                    cell: (c) => (
                      <Link className="underline-offset-2 hover:underline" to={causeLink(params, c.cause)}>
                        {c.label}
                      </Link>
                    ),
                  },
                  { key: "count", header: "Claims", align: "right", cell: (c) => formatCount(c.count) },
                  { key: "under", header: "Recorded below the formula", align: "right", cell: (c) => rs(c.under) },
                  { key: "over", header: "Recorded above the formula", align: "right", cell: (c) => rs(c.over) },
                ]}
              />
            </Details>
          )}

          {t.left_out + t.threshold_claims + t.policy_moved > 0 && (
            <Details label="what was left out on purpose">
              <ul className="list-disc space-y-1 pl-5 text-sm text-fg-muted">
                {t.left_out > 0 && (
                  <li>
                    {formatCount(t.left_out)} {t.left_out === 1 ? "claim was" : "claims were"} paid nothing on purpose (counted
                    only, or under the old papers-a-year quota).
                  </li>
                )}
                {t.threshold_claims > 0 && (
                  <li>
                    {formatCount(t.threshold_claims)} {t.threshold_claims === 1 ? "claim was" : "claims were"} paid {rs(t.threshold_total)} less
                    in all because of a research threshold. That is compared before the threshold, so it is not a difference.
                  </li>
                )}
                {t.policy_moved > 0 && (
                  <li>
                    {formatCount(t.policy_moved)} {t.policy_moved === 1 ? "claim would" : "claims would"} price differently under{" "}
                    {d.policy}, the policy in force now. Each keeps the price it was made under.
                  </li>
                )}
              </ul>
            </Details>
          )}
        </>
      )}
    </div>
  )
}

function causeLink(params: URLSearchParams, cause: string): string {
  const p = new URLSearchParams(params)
  p.set("tab", "many")
  p.set("cause", cause)
  p.delete("direction")
  return `/calculator?${p}#differences`
}

function sentence(t: Many["totals"], policy: string): string {
  if (t.checked === 0) return "There are no claims in these stages to check."
  if (t.differ === 0) return `All ${formatCount(t.checked)} claims agree with the policy they were priced with. The policy in force now is ${policy}.`
  return `${formatCount(t.differ)} of ${formatCount(t.checked)} claims are more than ₹1 away from what the formula gives. Net, the records are ${
    t.net < 0 ? `${rs(-t.net)} below` : `${rs(t.net)} above`
  } the formula.`
}

function FixLink({ r, role, mine }: { r: ManyRow; role: string | undefined; mine: boolean }) {
  const office = role === "SUPER_ADMIN" || role === "RESEARCH_CELL" || role === "RESEARCH_COORDINATOR"
  if (r.fix === "data" && office) {
    return (
      <Link to="/data/fixes?kind=paid_no_amount" className="text-sm underline underline-offset-2">
        Fix imported claims
      </Link>
    )
  }
  return (
    <Link
      to={claimHref(role as Parameters<typeof claimHref>[0], { id: r.id, is_mine: mine })}
      className="text-sm underline underline-offset-2"
    >
      Open the claim
    </Link>
  )
}
