import { Link } from "react-router-dom"

import { deptLabel } from "@/lib/names"
import { formatCount } from "@/lib/count"
import { useApi } from "@/lib/query"
import { periodQuery, type PeriodState } from "@/pages/period-frame"
import { Chip } from "@/ui/chip"
import { Avatar } from "@/ui/person"
import { money } from "@/ui/paper"
import { Sheet, SheetBody, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/ui/sheet"
import { InlineError, SkeletonRows } from "@/ui/state"
import { Table, type Column } from "@/ui/table"

/**
 * "How this is counted": every paper behind one person's numbers, with the
 * SNIP and amount each adds, where each SNIP came from, any paper counted
 * once because it repeats, and the three sums, so a person can add the columns
 * by hand and reach the figure on the board.
 *
 * The server builds the totals as the sums of these rows (`core/services/top5`),
 * so the sums at the foot are the sums of what is on screen. A head of
 * department gets no amount column, no incentive sum and no word on whether a
 * paper was paid: the server leaves those keys out.
 */

export type PaperRow = {
  title: string
  journal: string | null
  issn: string | null
  doi: string | null
  month_paid: string | null
  snip: number
  snip_source: "settled sheet" | "claim" | "none"
  duplicate_of: string | null
  counted: boolean
  amount?: number
  counted_in?: "paid" | "count only" | "correction"
}

export type PapersPayload = {
  label: string
  money: boolean
  person: {
    user_id: string | null
    key: string
    staff_id: string | null
    name: string
    department: string | null
    designation: string | null
    photo: string | null
    photo_url?: string | null
    initials?: string | null
  }
  papers: PaperRow[]
  totals: { snip: number; count: number; remuneration?: number }
  voided?: { title: string; month_paid: string | null; amount: number }[]
  rules: string
}

export const fmtSnip = (v: number) => v.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })

export function monthPaid(iso: string | null): string | null {
  if (!iso) return null
  const [y, m] = iso.split("-").map(Number)
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleString("en-GB", { month: "short", year: "numeric", timeZone: "UTC" })
}

const SOURCE: Record<PaperRow["snip_source"], string> = {
  "settled sheet": "From the settled sheet",
  claim: "From the claim",
  none: "No SNIP number, adds 0",
}

function columns(withMoney: boolean): Column<PaperRow>[] {
  const cols: Column<PaperRow>[] = [
    {
      key: "month_paid",
      header: "Month paid",
      className: "whitespace-nowrap",
      exportValue: (r) => monthPaid(r.month_paid),
      cell: (r) => monthPaid(r.month_paid),
    },
    {
      key: "title",
      header: "Paper",
      className: "min-w-0 max-w-[22rem]",
      exportValue: (r) => r.title,
      cell: (r) => (
        <div className="min-w-0 space-y-1">
          <p className="text-pretty font-medium text-fg">{r.title}</p>
          {(r.journal || r.issn || r.doi) && (
            <p className="break-words text-xs text-fg-muted">
              {[r.journal, r.issn && `ISSN ${r.issn}`, r.doi && `DOI ${r.doi}`].filter(Boolean).join(" · ")}
            </p>
          )}
          <div className="flex flex-wrap gap-1">
            {r.duplicate_of && (
              <Chip tone="caution" title={`Same title as “${r.duplicate_of}”`}>
                Counted once, repeats an earlier row
              </Chip>
            )}
            {withMoney && r.counted_in === "count only" && <Chip>Counted, nothing paid</Chip>}
            {withMoney && r.counted_in === "correction" && <Chip>Correction to a payment</Chip>}
          </div>
          {r.duplicate_of && (
            <p className="text-xs text-fg-muted">
              Same paper as “{r.duplicate_of}”. It is one paper, so it adds no paper and no SNIP again
              {withMoney ? ", but the amount paid on this row is counted" : ""}.
            </p>
          )}
        </div>
      ),
    },
    {
      key: "snip",
      header: "SNIP",
      label: "SNIP added",
      align: "right",
      className: "whitespace-nowrap",
      exportValue: (r) => r.snip,
      exportKind: "number",
      cell: (r) => (
        <span>
          {fmtSnip(r.snip)}
          <span className="block text-xs font-normal text-fg-muted">
            {r.snip_source === "none" && r.duplicate_of ? "Not added again" : SOURCE[r.snip_source]}
          </span>
        </span>
      ),
    },
  ]
  if (withMoney) {
    cols.push({
      key: "amount",
      header: "Amount",
      label: "Amount paid",
      align: "right",
      className: "whitespace-nowrap",
      exportValue: (r) => r.amount ?? 0,
      exportKind: "money",
      cell: (r) => money(r.amount ?? 0),
    })
  }
  return cols
}

export function HowCounted({
  who,
  state,
  onClose,
}: {
  /** A person's id, or the key a row carries for someone who left no account; null closes the panel. */
  who: string | null
  state: PeriodState
  onClose: () => void
}) {
  const query = useApi<PapersPayload>(
    ["standing-papers", who, periodQuery(state)],
    `/api/dashboard/standings/${encodeURIComponent(who ?? "")}/papers?${periodQuery(state)}`,
    { enabled: !!who }
  )
  const data = query.data
  const withMoney = !!data?.money

  return (
    <Sheet open={!!who} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="sm:w-[46rem] sm:max-w-[95vw]">
        <SheetHeader>
          <SheetTitle>How this is counted</SheetTitle>
          <SheetDescription>
            {data ? `${data.person.name}, ${data.label}` : "The papers behind these numbers."}
          </SheetDescription>
        </SheetHeader>
        <SheetBody className="space-y-5 text-sm">
          {query.isError ? (
            <InlineError message="Could not load the papers. Nothing has changed." onRetry={() => void query.refetch()} />
          ) : !data ? (
            <SkeletonRows rows={4} rowHeight={48} />
          ) : (
            <>
              <div className="flex items-center gap-3">
                <Avatar
                  size="md"
                  person={{
                    name: data.person.name,
                    initials: data.person.initials ?? "",
                    photo_url: data.person.photo_url ?? data.person.photo ?? null,
                  }}
                />
                <div className="min-w-0">
                  <p className="truncate text-base font-medium text-fg">{data.person.name}</p>
                  <p className="truncate text-fg-muted">
                    {[data.person.designation, data.person.department && deptLabel(data.person.department), data.person.staff_id]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                </div>
                {data.person.user_id && (
                  <Link
                    to={`/faculty/${data.person.user_id}`}
                    className="ml-auto shrink-0 font-medium text-accent underline-offset-2 hover:underline"
                  >
                    Open record
                  </Link>
                )}
              </div>

              <p className="max-w-prose text-pretty text-fg-muted" data-testid="standing-rules">
                {data.rules}
              </p>

              <Table
                rows={data.papers}
                columns={columns(withMoney)}
                getKey={(r) => `${r.month_paid}|${r.title}|${r.amount ?? 0}|${r.duplicate_of ?? ""}`}
                empty={<span>Nothing was settled for this person in this period.</span>}
                footer={{
                  title: `Total, ${formatCount(data.totals.count)} ${data.totals.count === 1 ? "paper" : "papers"}`,
                  snip: fmtSnip(data.totals.snip),
                  ...(withMoney ? { amount: money(data.totals.remuneration ?? 0) } : {}),
                }}
                maxHeight="24rem"
                tools={{
                  id: "standing-papers",
                  title: `How this is counted, ${data.person.name}`,
                  subtitle: data.label,
                }}
              />

              <dl className="grid grid-cols-[minmax(0,1fr)] gap-3 sm:grid-cols-3" data-testid="standing-sums">
                <div>
                  <dt className="text-fg-muted">Papers settled</dt>
                  <dd className="text-base font-semibold tabular">{formatCount(data.totals.count)}</dd>
                  <dd className="text-xs text-fg-muted">Rows that are not repeats</dd>
                </div>
                <div>
                  <dt className="text-fg-muted">Cumulative SNIP</dt>
                  <dd className="text-base font-semibold tabular">{fmtSnip(data.totals.snip)}</dd>
                  <dd className="text-xs text-fg-muted">Sum of the SNIP column</dd>
                </div>
                {withMoney && (
                  <div>
                    <dt className="text-fg-muted">Incentive paid</dt>
                    <dd className="text-base font-semibold tabular">{money(data.totals.remuneration ?? 0)}</dd>
                    <dd className="text-xs text-fg-muted">Sum of the amount column</dd>
                  </div>
                )}
              </dl>

              {withMoney && !!data.voided?.length && (
                <div className="space-y-1">
                  <p className="font-medium text-fg">Not counted: payments that were voided</p>
                  <ul className="list-disc space-y-0.5 pl-5 text-fg-muted">
                    {data.voided.map((v, i) => (
                      <li key={i}>
                        {v.title}, {monthPaid(v.month_paid)}, {money(v.amount)}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}
        </SheetBody>
      </SheetContent>
    </Sheet>
  )
}
