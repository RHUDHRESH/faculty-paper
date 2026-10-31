import { useEffect, useMemo, useState } from "react"
import { Link, useLocation, useSearchParams } from "react-router-dom"
import { Banknote } from "lucide-react"

import { can, useAuth } from "@/app/auth"
import { formatCount } from "@/lib/count"
import { useApi } from "@/lib/query"
import { Answer } from "@/ui/answer"
import { BatchCheck } from "@/pages/batch-check"
import { BudgetStrip, budgetLine } from "@/pages/budget-strip"
import { BulkPayDialog, SinglePayDialog } from "@/pages/pay-dialogs"
import { Button } from "@/ui/button"
import { ComingUp } from "@/ui/coming-up"
import { Checkbox, Input, Select } from "@/ui/field"
import { filterBar } from "@/ui/filter-bar"
import { paperTitle } from "@/lib/names"
import { OwnPapersNote } from "@/ui/own-papers"
import { PageHeader } from "@/ui/page-header"
import { money } from "@/ui/paper"
import { Pagination } from "@/ui/pagination"
import { Details } from "@/ui/section"
import { ErrorState, NotOpen, SkeletonRows } from "@/ui/state"
import { Table, type Column, type SortDir } from "@/ui/table"
import {
  AmountCell,
  Claimant,
  ClaimNo,
  ErpLegend,
  isPayable,
  isPayableTotals,
  monthKey,
  monthLabel,
  PAYABLE_LIMIT,
  payableKey,
  payablePath,
  payableTotalsOf,
  PaperCell,
  useBudgetNow,
  waitingLabel,
  type PayableTotals,
  type PayoutClaim,
  type PayoutsPage,
} from "@/pages/pay-parts"

export { PaymentsDone } from "@/pages/payments-done"
export { newRequestKey, type PayCheck, type PayProblem } from "@/pages/pay-dialogs"

/**
 * Where money leaves the college: the claims the Director has authorised,
 * waiting on a voucher and a decision (docs/ux/28).
 *
 * The top says three figures and then the one picture the Director's step
 * left for this one: what paying does to the year's budget. The work is the
 * ready claims (one primary button pays them all; tick some to pay those), and
 * the few that are held up, with the reason and no checkbox. After the run the
 * dialog hands over the paper: the bank file and the statement to sign.
 *
 * The figure a reader confirms has to be the figure the server has just
 * recomputed from its own stored, checked columns. `mark-paid` never calls
 * Scopus, so a payment is never blocked by an outage, and that is also why the
 * amount on screen can drift from a formula change or a second approval that
 * landed between page-load and click. A 409 means it moved: the dialogs show
 * both figures and refuse to resend the stale one, on a single payment and on
 * any row a batch skips (`pay-dialogs.tsx`).
 */

/* ------------------------------------------------------------------------ */
/* Why a claim cannot be paid yet                                            */
/* ------------------------------------------------------------------------ */

// Never names the cause beyond "high value": the other cause of a second
// signature is a review flag, and Finance never sees flags.
function heldReason(c: PayoutClaim): string {
  if (c.calc_error) return "No amount could be worked out for this claim. The research office can correct it."
  const clearedBy = c.cleared_by_name || "the person who cleared it"
  return `Needs a second approver, someone other than ${clearedBy}. The research office or a super admin can give it.`
}

type SortKey = "waiting" | "amount"

export function Payments() {
  const { me } = useAuth()
  const allowed = can(me?.role).pay
  const location = useLocation()

  const [searchParams, setSearchParams] = useSearchParams()
  const page = Math.max(0, Number.parseInt(searchParams.get("page") ?? "0", 10) || 0)

  function goToPage(next: number) {
    setSearchParams((prev) => {
      const params = new URLSearchParams(prev)
      if (next > 0) params.set("page", String(next))
      else params.delete("page")
      return params
    })
  }

  const { data, isLoading, isError, refetch } = useApi<PayoutsPage>(payableKey(page), payablePath(page), {
    enabled: allowed,
    placeholderData: (prev) => prev,
    refetchOnWindowFocus: true,
  })
  const budget = useBudgetNow(allowed)

  const rows = data?.results ?? []
  const total = data?.total ?? 0
  const totals: PayableTotals = isPayableTotals(data?.totals) ? data.totals : payableTotalsOf(rows)

  const ready = useMemo(() => rows.filter(isPayable), [rows])
  const held = useMemo(() => rows.filter((c) => !isPayable(c)), [rows])

  // Full rows, not ids: a review two pages on still needs the title and amount
  // of a row selected on page one.
  const [selected, setSelected] = useState<Map<string, PayoutClaim>>(new Map())
  const [payId, setPayId] = useState<string | null>(null)
  const [bulk, setBulk] = useState<PayoutClaim[] | null>(null)
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir }>({ key: "waiting", dir: "desc" })
  const [search, setSearch] = useState("")
  const [show, setShow] = useState<"all" | "ready" | "held">("all")

  const sorted = useMemo(() => {
    const dir = sort.dir === "asc" ? 1 : -1
    const val = (c: PayoutClaim) => (sort.key === "amount" ? c.remuneration || 0 : c.waiting_days ?? 0)
    return ready.slice().sort((a, b) => (val(a) - val(b)) * dir)
  }, [ready, sort])

  // A link on the answer strip to a part of this page has to scroll there.
  useEffect(() => {
    if (!location.hash) return
    document.getElementById(location.hash.slice(1))?.scrollIntoView({ block: "start" })
  }, [location.hash, data])

  function toggleSelected(c: PayoutClaim) {
    if (!isPayable(c)) return
    setSelected((prev) => {
      const next = new Map(prev)
      if (next.has(c.id)) next.delete(c.id)
      else next.set(c.id, c)
      return next
    })
  }

  const allVisibleSelected = ready.length > 0 && ready.every((c) => selected.has(c.id))
  const someVisibleSelected = ready.some((c) => selected.has(c.id))
  // Anything selected at all, not just on the page in view: the selection
  // survives paging, so the bar that shows it must too.
  const anySelected = selected.size > 0
  const selectedOffPage = selected.size - ready.filter((c) => selected.has(c.id)).length
  const selectedRows = [...selected.values()]
  const selectedTotal = selectedRows.reduce((sum, c) => sum + (c.remuneration || 0), 0)
  const payClaim = payId ? (rows.find((c) => c.id === payId) ?? selected.get(payId) ?? null) : null

  if (!allowed) {
    return (
      <div className="page py-8">
        <NotOpen message="Only Finance can see or process payments." />
      </div>
    )
  }

  // One table: the claims that can be paid first, then the few held up with
  // their reason. A search and a "show" choice narrow what is on the page.
  const needle = search.trim().toLowerCase()
  const matches = (c: PayoutClaim) =>
    !needle || [c.ticket_number, c.paper_title, c.owner_name, c.owner_department, c.staff_id].some((v) => String(v ?? "").toLowerCase().includes(needle))
  const shownReady = show === "held" ? [] : sorted.filter(matches)
  const shownHeld = show === "ready" ? [] : held.filter(matches)
  const tableRows = [...shownReady, ...shownHeld]
  const narrowed = Boolean(needle) || show !== "all"

  const columns: Column<PayoutClaim>[] = [
    {
      key: "select",
      header: (
        <Checkbox
          checked={allVisibleSelected ? true : someVisibleSelected ? "indeterminate" : false}
          disabled={ready.length === 0}
          onCheckedChange={() =>
            setSelected((prev) => {
              const next = new Map(prev)
              if (allVisibleSelected) for (const c of ready) next.delete(c.id)
              else for (const c of ready) next.set(c.id, c)
              return next
            })
          }
          aria-label={allVisibleSelected ? "Deselect all" : `Select all ${ready.length} ready claims`}
        />
      ),
      label: "Select",
      className: "w-10",
      cell: (c) =>
        isPayable(c) ? (
          <Checkbox
            checked={selected.has(c.id)}
            onCheckedChange={() => toggleSelected(c)}
            aria-label={`Select ${c.paper_title || "this claim"}`}
          />
        ) : null,
    },
    {
      key: "claimant",
      header: "Paid to",
      exportValue: (c) => [c.owner_name, c.staff_id ? `Staff id ${c.staff_id}` : null].filter(Boolean).join(", "),
      cell: (c) => <Claimant c={c} size="md" />,
    },
    {
      key: "paper",
      header: "Paper",
      exportValue: (c) => paperTitle(c.paper_title),
      cell: (c) => <PaperCell c={c} />,
    },
    {
      key: "claim_no",
      header: "Claim no.",
      defaultHidden: true,
      exportValue: (c) => c.ticket_number,
      cell: (c) => <ClaimNo no={c.ticket_number} />,
    },
    {
      key: "month",
      header: "Month paid",
      className: "whitespace-nowrap",
      exportValue: (c) => monthLabel(monthKey(c), true),
      cell: (c) => monthLabel(monthKey(c), true),
    },
    {
      key: "waiting",
      header: "Waiting",
      align: "right",
      sortable: true,
      exportValue: (c) => c.waiting_days,
      cell: (c) => (
        <span className={(c.waiting_days ?? 0) > 7 ? "text-caution" : undefined}>{waitingLabel(c.waiting_days)}</span>
      ),
    },
    {
      key: "amount",
      header: "Amount",
      align: "right",
      sortable: true,
      exportKind: "money",
      exportValue: (c) => (c.calc_error ? null : c.remuneration),
      cell: (c) => <AmountCell c={c} />,
    },
    {
      key: "status",
      header: "Status",
      exportValue: (c) => (isPayable(c) ? "Ready to pay" : heldReason(c)),
      cell: (c) => (isPayable(c) ? <span className="text-positive">Ready to pay</span> : <span className="text-caution">{heldReason(c)}</span>),
    },
    {
      key: "pay",
      header: <span className="sr-only">Pay</span>,
      label: "Pay",
      cell: (c) =>
        isPayable(c) ? (
          <Button kind="primary" size="sm" onClick={() => setPayId(c.id)}>
            Pay
          </Button>
        ) : null,
    },
  ]

  const payAll = ready.length > 0 && ready.length === totals.ready_count
  const everyReady = ready

  return (
    <div className="page space-y-6">
      <PageHeader
        title="Payments"
        sub={
          totals.ready_count > 0
            ? `${formatCount(totals.ready_count)} ${totals.ready_count === 1 ? "claim" : "claims"} the Director has authorised ${totals.ready_count === 1 ? "is" : "are"} ready to pay.`
            : "Claims the Director has authorised."
        }
        actions={
          <>
            <Button kind="default" asChild>
              <Link to="/payments/done">See what has been paid</Link>
            </Button>
            {payAll && (
              <Button kind={anySelected ? "default" : "primary"} size="lg" onClick={() => setBulk(everyReady)}>
                Pay all {formatCount(ready.length)} · {money(totals.ready_amount)}
              </Button>
            )}
          </>
        }
      />

      {isLoading ? (
        <SkeletonRows rows={8} rowHeight={56} />
      ) : isError ? (
        <ErrorState
          title="Could not load payments"
          message="The server did not answer. Nothing has been paid or lost."
          onRetry={() => refetch()}
        />
      ) : (
        <>
          {rows.length > 0 && <Answer
            items={[
              {
                label: "Ready to pay",
                value: totals.ready_count,
                zero: "Nothing is ready to pay",
                to: "/payments#ready",
              },
              { label: "Comes to", value: money(totals.ready_amount) },
              {
                label: "Held up",
                value: totals.held_count,
                zero: "Nothing is held up",
                tone: "caution",
                to: totals.held_count ? "/payments#held" : undefined,
              },
            ]}
          />}
          {totals.ready_count > 0 && (
            <div className="max-w-2xl space-y-3">
              <p className="text-base text-fg">{budgetLine(budget.data, "paying", totals.ready_count !== 1) ?? " "}</p>
              <BudgetStrip budget={budget.data?.college} batch={totals.ready_amount} batchLabel="This run" labels="wide" />
              {totals.held_back_count > 0 && (
                <p className="text-sm text-fg-muted">
                  The research threshold holds back {money(totals.held_back)} on {formatCount(totals.held_back_count)}{" "}
                  {totals.held_back_count === 1 ? "claim" : "claims"}; each is marked in the list.
                </p>
              )}
            </div>
          )}
          {totals.count > 0 && <BatchCheck stage="pay" />}

          {rows.length > 0 && (
            <div className={filterBar} role="search">
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search claimant, paper or claim no."
                aria-label="Search the claims on this page"
                className="w-full min-w-0 sm:w-80"
              />
              <Select aria-label="Show" value={show} onChange={(e) => setShow(e.target.value as "all" | "ready" | "held")} className="w-auto max-sm:w-full">
                <option value="all">All claims</option>
                <option value="ready">Ready to pay</option>
                <option value="held">Held up</option>
              </Select>
              {ready.length > 1 && !allVisibleSelected && (
                <Button
                  kind="default"
                  onClick={() =>
                    setSelected((prev) => {
                      const next = new Map(prev)
                      for (const c of ready) next.set(c.id, c)
                      return next
                    })
                  }
                >
                  Select all {formatCount(ready.length)}
                </Button>
              )}
              {narrowed && (
                <Button
                  kind="quiet"
                  onClick={() => {
                    setSearch("")
                    setShow("all")
                  }}
                >
                  Clear filters
                </Button>
              )}
            </div>
          )}

          {anySelected && (
            <div
              role="region"
              aria-label="Selected claims"
              className="sticky top-14 z-20 flex flex-wrap items-center justify-between gap-3 rounded-panel bg-surface px-4 py-3 shadow-pop ring-1 ring-edge md:top-2"
            >
              <p className="text-sm">
                <span className="font-semibold">{formatCount(selected.size)}</span> selected,{" "}
                <span className="font-semibold tabular">{money(selectedTotal)}</span>
                {selectedOffPage > 0 ? (
                  <span className="text-fg-muted">
                    {" "}
                    and {formatCount(selectedOffPage)} on {selectedOffPage === 1 ? "another page" : "other pages"}
                  </span>
                ) : null}
              </p>
              <div className="flex items-center gap-2">
                <Button kind="default" onClick={() => setSelected(new Map())}>
                  Clear selection
                </Button>
                <Button kind="primary" onClick={() => setBulk(selectedRows)}>
                  Pay {formatCount(selected.size)} {selected.size === 1 ? "claim" : "claims"}
                </Button>
              </div>
            </div>
          )}

          <div id="ready" className="scroll-mt-4 space-y-2">
            <span id="held" className="scroll-mt-4" />
            <Table
              rows={tableRows}
              columns={columns}
              getKey={(c) => c.id}
              maxHeight="none"
              caption="Authorised claims, ready ones first"
              sortKey={sort.key}
              sortDir={sort.dir}
              onSort={(k) =>
                setSort((s) => ({ key: k as SortKey, dir: s.key === k && s.dir === "desc" ? "asc" : "desc" }))
              }
              tools={{ id: "payments", title: "Payments" }}
              empty={
                rows.length === 0
                  ? {
                      guide: "pay-claims",
                      icon: Banknote,
                      title: "Nothing waiting on Finance",
                      message: "Every claim the Director has authorised has been paid.",
                      action: (
                        <Button kind="default" asChild>
                          <Link to="/payments/done">See what has been paid</Link>
                        </Button>
                      ),
                    }
                  : {
                      icon: Banknote,
                      title: "No claim matches",
                      message: "Nothing on this page fits the search.",
                      action: (
                        <Button
                          kind="default"
                          onClick={() => {
                            setSearch("")
                            setShow("all")
                          }}
                        >
                          Clear filters
                        </Button>
                      ),
                    }
              }
            />
            <ErpLegend rows={rows} />
          </div>
          {rows.length === 0 && <ComingUp desk="finance" />}

          <Pagination page={page} pageSize={PAYABLE_LIMIT} total={total} onChange={goToPage} />

          {rows.length > 0 && (
            <Details label="how a payment is checked" className="text-sm">
              <ul className="max-w-prose list-disc space-y-1 pl-5 text-fg-muted">
                <li>A claim is paid once. If it already has a payment on the ledger, the server refuses a second.</li>
                <li>
                  The amount is worked out again from the checked figures at the moment you pay. If it moved, nothing is
                  paid and you see both figures.
                </li>
                <li>Nobody pays their own paper, and the person who authorised a claim does not pay it.</li>
                <li>
                  If a payment goes out in error, a super admin undoes it. That writes a balancing row on the ledger and
                  nothing is deleted.
                </li>
              </ul>
              <OwnPapersNote className="mt-2" />
            </Details>
          )}
        </>
      )}

      {payClaim && (
        <SinglePayDialog
          claim={payClaim}
          open={!!payId}
          onOpenChange={(o) => !o && setPayId(null)}
          onPaid={(id) => {
            setSelected((prev) => {
              if (!prev.has(id)) return prev
              const next = new Map(prev)
              next.delete(id)
              return next
            })
          }}
        />
      )}

      <BulkPayDialog
        open={!!bulk}
        onOpenChange={(o) => !o && setBulk(null)}
        rows={bulk ?? []}
        onDone={(paidIds) => {
          setSelected((prev) => {
            const next = new Map(prev)
            for (const id of paidIds) next.delete(id)
            return next
          })
        }}
      />
    </div>
  )
}
