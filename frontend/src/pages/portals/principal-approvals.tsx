"use client"

import { useMemo, useState } from "react"

import { asNumber, useUrlState } from "@/lib/url-state"
import { toast } from "sonner"
import { CheckCheck, Clock, RotateCcw, Search, ShieldAlert } from "lucide-react"

import { BatchResult, type Skipped } from "@/components/batch-result"
import { Callout } from "@/components/form/fields"
import { EmptyState, ErrorState, PageHeader, Section } from "@/components/layout/page"
import { Money, StatusChip, formatMoney } from "@/components/ticket-ui"
import { LoadingTable } from "@/components/loading"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Pager } from "@/components/ui/pagination"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { api, type Claim } from "@/lib/api"
import { useApiQuery } from "@/lib/queries"
import { cn } from "@/lib/utils"

/**
 * What the principal approves, and the money it commits.
 *
 * The chain used to run research cell → finance, so the person accountable
 * for the spend could read every figure and authorise none of them. This is
 * that step: nothing reaches finance without an approval taken here.
 *
 * It is a monthly job over a few hundred rows, so the screen answers "which
 * of these first" — longest wait, largest amount, one department — before it
 * answers anything else, and keeps the committed total in front of the
 * person clicking, because that is the number the decision is actually about.
 */

const PAGE = 50
const ALL = "__all__"

type QueueResponse = {
  total: number
  limit: number
  offset: number
  results: Claim[]
  totals: { count: number; amount: number; longest_wait_days: number | null }
  departments: string[]
}

/** A wait is the thing the reader is scanning for, so it reads as words. */
function waitLabel(days: number | null | undefined): string {
  if (days === null || days === undefined) return "—"
  if (days === 0) return "today"
  if (days === 1) return "1 day"
  if (days < 7) return `${days} days`
  if (days < 14) return "over a week"
  if (days < 31) return `${Math.floor(days / 7)} weeks`
  return `over a month`
}

function waitTone(days: number | null | undefined): string {
  if (days === null || days === undefined) return "text-muted-foreground"
  if (days >= 21) return "text-destructive font-medium"
  if (days >= 7) return "text-warning-foreground"
  return "text-muted-foreground"
}

export function PrincipalApprovalsPage() {
  // In the address bar, so a narrowed queue can be sent to somebody and the
  // back button walks out of a filter rather than off the screen.
  const [state, setState] = useUrlState({
    q: "",
    department: ALL,
    quartile: ALL,
    waitingOver: ALL,
    sort: "waiting",
    offset: "0",
  })
  const { department, quartile, waitingOver, sort } = state
  const term = state.q
  const offset = asNumber(state.offset, 0)
  const [q, setQ] = useState(state.q)

  const setDepartment = (v: string) => setState({ department: v })
  const setQuartile = (v: string) => setState({ quartile: v })
  const setWaitingOver = (v: string) => setState({ waitingOver: v })
  const setSort = (v: string) => setState({ sort: v })
  const setTerm = (v: string) => setState({ q: v })
  const setOffset = (v: number) => setState({ offset: String(v) })
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ done: number; skipped: Skipped[] } | null>(null)
  const [sendBack, setSendBack] = useState<Claim | null>(null)
  const [reason, setReason] = useState("")

  const query = useMemo(() => {
    const p = new URLSearchParams({
      sort,
      limit: String(PAGE),
      offset: String(offset),
    })
    if (term.trim()) p.set("q", term.trim())
    if (department !== ALL) p.set("department", department)
    if (quartile !== ALL) p.set("quartile", quartile)
    if (waitingOver !== ALL) p.set("waiting_over", waitingOver)
    return p.toString()
  }, [term, department, quartile, waitingOver, sort, offset])

  const { data, isLoading, isError, refetch } = useApiQuery<QueueResponse>(
    ["principal-queue", query],
    `/api/principal/queue?${query}`
  )

  // Approving commits money, so what is left has to be on this screen rather
  // than one click away on a page nobody opens mid-batch.
  const { data: budget } = useApiQuery<{
    financial_year: string
    college: { allocated: number | null; remaining: number | null; committed: number }
  }>(["budget", "current"], "/api/budgets")

  const rows = data?.results || []

  const selected = useMemo(
    () => rows.filter((r) => picked.has(r.id)),
    [rows, picked]
  )
  const selectedAmount = selected.reduce((sum, r) => sum + (r.remuneration || 0), 0)
  const selectedLongest = selected.reduce(
    (max, r) => Math.max(max, ((r as unknown as Record<string, number>).waiting_days) || 0),
    0
  )
  const selectedDepartments = new Set(
    selected.map((r) => r.owner_department).filter(Boolean)
  ).size

  const filtersActive = !!(
    term ||
    department !== ALL ||
    quartile !== ALL ||
    waitingOver !== ALL
  )
  const clearFilters = () => {
    setQ("")
    setState({
      q: "",
      department: ALL,
      quartile: ALL,
      waitingOver: ALL,
      offset: "0",
    })
  }

  function toggle(id: string) {
    setPicked((s) => {
      const next = new Set(s)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function toggleAllOnPage() {
    const ids = rows.map((r) => r.id)
    const allPicked = ids.every((id) => picked.has(id))
    setPicked((s) => {
      const next = new Set(s)
      for (const id of ids) {
        if (allPicked) next.delete(id)
        else next.add(id)
      }
      return next
    })
  }

  async function approve(ids: string[]) {
    if (!ids.length) return
    setBusy(true)
    try {
      const res = await api<{
        approved: number
        total: number
        skipped: { id: string; reason: string }[]
      }>(
        "/api/principal/bulk-approve",
        { method: "POST", json: { claim_ids: ids } }
      )
      if (res.approved) {
        toast.success(
          `${res.approved} approved · ${formatMoney(res.total)} released to finance`
        )
      }
      // Kept on screen rather than fired as toasts: a reason that fades in
      // four seconds, while the reader is still looking at the list, is a
      // reason nobody ever reads.
      setResult({ done: res.approved, skipped: res.skipped || [] })
      // Whatever was refused stays selected. Clearing the lot meant a batch
      // where one row drifted lost the other hundred-and-ninety-nine, and the
      // rows that need looking at are exactly the ones that were dropped.
      const refused = new Set((res.skipped || []).map((s) => s.id))
      setPicked((current) => new Set([...current].filter((id) => refused.has(id))))
      await refetch()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not approve")
    } finally {
      setBusy(false)
    }
  }

  async function doSendBack() {
    if (!sendBack) return
    if (reason.trim().length < 5) {
      toast.error("Say why it is going back")
      return
    }
    setBusy(true)
    try {
      await api(`/api/claims/${sendBack.id}/principal-reject`, {
        method: "POST",
        json: { note: reason.trim() },
      })
      toast.success("Sent back to the research cell")
      setSendBack(null)
      setReason("")
      await refetch()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not send it back")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-6 pb-32">
      <PageHeader
        title="Approvals"
        subtitle="Cleared by the research cell and waiting on you — nothing reaches finance without this"
      />

      {data?.totals ? (
        <Section title="Waiting on you">
          <div className="grid gap-3 sm:grid-cols-3">
            {[
              { label: "Tickets", value: String(data.totals.count) },
              { label: "Total to commit", value: formatMoney(data.totals.amount) },
              {
                label: "Longest wait",
                value: waitLabel(data.totals.longest_wait_days),
              },
            ].map((s) => (
              <div key={s.label} className="rounded-[var(--radius)] border border-border bg-card px-5 py-4">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {s.label}
                </p>
                <p className="mt-1 text-2xl font-semibold tabular-nums text-foreground">
                  {s.value}
                </p>
              </div>
            ))}
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            Across everything matching the filters below, not just this page.
          </p>
          {budget?.college?.allocated ? (
            <p className="mt-2 text-sm">
              <span className="text-muted-foreground">
                Budget {budget.financial_year}:{" "}
              </span>
              <span
                className={cn(
                  "font-semibold tabular-nums",
                  (budget.college.remaining ?? 0) < 0 && "text-destructive"
                )}
              >
                {formatMoney(budget.college.remaining ?? 0)}
              </span>
              <span className="text-muted-foreground"> left of </span>
              <span className="tabular-nums">{formatMoney(budget.college.allocated)}</span>
              <span className="text-muted-foreground">
                {" "}— {formatMoney(budget.college.committed)} of that is already committed.
              </span>
            </p>
          ) : (
            <p className="mt-2 text-xs text-muted-foreground">
              No allocation is set for this year, so nothing here can say what remains.
            </p>
          )}
        </Section>
      ) : null}

      <div className="flex flex-wrap items-end gap-3">
        <form
          className="flex items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            setTerm(q)
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="pq-search" className="text-xs">
              Search
            </Label>
            <div className="relative w-56">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                id="pq-search"
                className="pl-9"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Title, ticket, person"
              />
            </div>
          </div>
          <Button type="submit" variant="secondary">
            Search
          </Button>
        </form>

        <div className="space-y-1.5">
          <Label htmlFor="pq-dept" className="text-xs">
            Department
          </Label>
          <Select value={department} onValueChange={setDepartment}>
            <SelectTrigger id="pq-dept" className="w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All departments</SelectItem>
              {(data?.departments || []).map((d) => (
                <SelectItem key={d} value={d}>
                  {d}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="pq-quartile" className="text-xs">
            Quartile
          </Label>
          <Select value={quartile} onValueChange={setQuartile}>
            <SelectTrigger id="pq-quartile" className="w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>Any</SelectItem>
              {["Q1", "Q2", "Q3", "Q4"].map((qt) => (
                <SelectItem key={qt} value={qt}>
                  {qt}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="pq-wait" className="text-xs">
            Waiting
          </Label>
          <Select value={waitingOver} onValueChange={setWaitingOver}>
            <SelectTrigger id="pq-wait" className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>Any time</SelectItem>
              <SelectItem value="7">Over a week</SelectItem>
              <SelectItem value="14">Over two weeks</SelectItem>
              <SelectItem value="30">Over a month</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="pq-sort" className="text-xs">
            Sort
          </Label>
          <Select value={sort} onValueChange={setSort}>
            <SelectTrigger id="pq-sort" className="w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="waiting">Longest waiting first</SelectItem>
              <SelectItem value="recent">Most recently cleared</SelectItem>
              <SelectItem value="amount">Largest amount</SelectItem>
              <SelectItem value="amount_asc">Smallest amount</SelectItem>
              <SelectItem value="department">Department</SelectItem>
              <SelectItem value="title">Title</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {result ? (
        <BatchResult
          done={result.done}
          doneLabel={result.done === 1 ? "approved" : "approved"}
          skipped={result.skipped}
          onDismiss={() => setResult(null)}
        />
      ) : null}

      {isError ? (
        <ErrorState onRetry={() => refetch()} />
      ) : isLoading ? (
        <LoadingTable rows={8} columns={7} caption="Loading what is waiting on you…" />
      ) : rows.length === 0 ? (
        <EmptyState
          title={
            filtersActive ? "Nothing matches those filters" : "Nothing waiting on you"
          }
          description={
            filtersActive
              ? "There are tickets waiting, but none match all of these at once."
              : "Everything the research cell has cleared is already approved."
          }
          action={
            filtersActive ? (
              <Button variant="secondary" onClick={clearFilters}>
                Clear the filters
              </Button>
            ) : undefined
          }
        />
      ) : (
        <>
          {/* Phones get cards; the table needs a thousand pixels and a phone
              has under four hundred. */}
          <ul className="space-y-3 lg:hidden">
            {rows.map((r) => {
              const days = (r as unknown as Record<string, number>).waiting_days
              const isPicked = picked.has(r.id)
              const flagged = !!(r as unknown as Record<string, unknown>)
                .override_duplicate
              return (
                <li
                  key={r.id}
                  className={cn(
                    "rounded-[var(--radius)] border p-4",
                    isPicked ? "border-primary bg-surface-brand/40" : "border-border bg-card",
                    days >= 21 && "border-l-4 border-l-destructive",
                    days >= 7 && days < 21 && "border-l-4 border-l-warning"
                  )}
                >
                  <div className="flex items-start gap-3">
                    <Checkbox
                      checked={isPicked}
                      onCheckedChange={() => toggle(r.id)}
                      aria-label={`Select ${r.ticket_number}`}
                      className="mt-1"
                    />
                    <div className="min-w-0 flex-1">
                      <p className="font-mono text-xs text-muted-foreground">
                        {r.ticket_number}
                      </p>
                      <p className="mt-0.5 font-medium leading-snug">{r.paper_title}</p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {r.owner_name}
                        {r.owner_department ? ` · ${r.owner_department}` : ""}
                        {r.quartile ? ` · ${r.quartile}` : ""}
                      </p>
                      {flagged ? (
                        <span className="mt-2 inline-flex items-center gap-1 rounded-full bg-warning/15 px-2 py-0.5 text-xs text-warning-foreground">
                          <ShieldAlert className="size-3" aria-hidden />
                          Payment-history warning set aside
                        </span>
                      ) : null}
                    </div>
                  </div>

                  <div className="mt-3 flex items-center justify-between gap-3 border-t border-border/60 pt-3">
                    <span className={cn("text-xs", waitTone(days))}>
                      <Clock className="mr-1 inline size-3.5" aria-hidden />
                      {waitLabel(days)}
                    </span>
                    <span className="text-lg font-semibold tabular-nums">
                      <Money value={r.remuneration} />
                    </span>
                  </div>

                  <div className="mt-3 flex gap-2">
                    <Button
                      className="flex-1"
                      size="sm"
                      disabled={busy}
                      onClick={() => approve([r.id])}
                    >
                      Approve
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => setSendBack(r)}
                    >
                      <RotateCcw className="size-3.5" />
                      Back
                    </Button>
                  </div>
                </li>
              )
            })}
          </ul>

          <div className="hidden overflow-x-auto rounded-[var(--radius)] border border-border lg:block">
            <table className="w-full min-w-[62rem] text-left text-sm">
              <thead className="border-b border-border bg-muted/30 text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="px-3 py-2">
                    <Checkbox
                      checked={rows.every((r) => picked.has(r.id))}
                      onCheckedChange={toggleAllOnPage}
                      aria-label="Select every ticket on this page"
                    />
                  </th>
                  {["Ticket", "Paper", "Faculty", "Quartile", "Waiting", "Amount"].map((h) => (
                    <th key={h} className="px-3 py-2 font-medium">
                      {h}
                    </th>
                  ))}
                  {/* Pinned: the table is wider than the pane, and an action
                      that scrolls off the right edge is an action nobody
                      finds. */}
                  <th className="sticky right-0 bg-muted/30 px-3 py-2 font-medium" />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const days = (r as unknown as Record<string, number>).waiting_days
                  const isPicked = picked.has(r.id)
                  return (
                    <tr
                      key={r.id}
                      className={cn(
                        "border-b border-border/50 last:border-0",
                        isPicked ? "bg-surface-brand/40" : "hover:bg-accent/30",
                        // A queue of two hundred identical grey rows makes the
                        // one that has waited five weeks look exactly like the
                        // one filed this morning. The eye needs somewhere to
                        // land before the reader starts reading dates.
                        days >= 21 && "border-l-2 border-l-destructive",
                        days >= 7 && days < 21 && "border-l-2 border-l-warning"
                      )}
                    >
                      <td className="px-3 py-2">
                        <Checkbox
                          checked={isPicked}
                          onCheckedChange={() => toggle(r.id)}
                          aria-label={`Select ${r.ticket_number}`}
                        />
                      </td>
                      <td className="px-3 py-2 font-mono text-xs">{r.ticket_number}</td>
                      <td className="max-w-[22rem] px-3 py-2">
                        <span className="block truncate">{r.paper_title}</span>
                        {/* Somebody decided the college had not already paid for
                            this. The person approving the spend is exactly who
                            should be told that. */}
                        {(r as unknown as Record<string, unknown>).override_duplicate ? (
                          <span className="mt-0.5 inline-flex items-center gap-1 rounded-full bg-warning/15 px-2 py-0.5 text-xs text-warning-foreground">
                            <ShieldAlert className="size-3" aria-hidden />
                            Payment-history warning set aside
                          </span>
                        ) : null}
                      </td>
                      <td className="px-3 py-2">
                        <div>{r.owner_name}</div>
                        <div className="text-xs text-muted-foreground">
                          {r.owner_department}
                        </div>
                      </td>
                      <td className="px-3 py-2">{r.quartile || "—"}</td>
                      <td className={cn("px-3 py-2 whitespace-nowrap", waitTone(days))}>
                        <Clock className="mr-1 inline size-3.5" aria-hidden />
                        {waitLabel(days)}
                      </td>
                      <td className="px-3 py-2 font-semibold tabular-nums">
                        <Money value={r.remuneration} />
                      </td>
                      <td
                        className={cn(
                          "sticky right-0 px-3 py-2",
                          isPicked ? "bg-surface-brand" : "bg-card"
                        )}
                      >
                        <div className="flex justify-end gap-1.5">
                          <Button
                            size="xs"
                            disabled={busy}
                            onClick={() => approve([r.id])}
                          >
                            Approve
                          </Button>
                          <Button
                            size="xs"
                            variant="ghost"
                            disabled={busy}
                            onClick={() => setSendBack(r)}
                          >
                            <RotateCcw className="size-3.5" />
                            Back
                          </Button>
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          <Pager
            total={data?.total || 0}
            limit={PAGE}
            offset={offset}
            onOffsetChange={setOffset}
          />
        </>
      )}

      {/* The committed figure follows the person clicking. Selection survives
          paging, so a total computed from the visible page would understate
          what is about to be approved. */}
      {picked.size ? (
        <div className="pointer-events-none fixed inset-x-0 bottom-0 z-40 flex justify-end p-4 sm:p-6">
          <div className="pointer-events-auto w-full max-w-md rounded-[var(--radius)] border border-border bg-card p-4 shadow-lg">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Selected
                </p>
                <p className="mt-0.5 text-2xl font-semibold tabular-nums text-foreground">
                  {formatMoney(selectedAmount)}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {selected.length} ticket{selected.length === 1 ? "" : "s"}
                  {selectedDepartments
                    ? ` · ${selectedDepartments} department${selectedDepartments === 1 ? "" : "s"}`
                    : ""}
                  {selectedLongest ? ` · longest ${waitLabel(selectedLongest)}` : ""}
                </p>
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setPicked(new Set())}
                aria-label="Clear the selection"
              >
                Clear
              </Button>
            </div>
            {budget?.college?.remaining !== null && budget?.college?.remaining !== undefined ? (
              <p className="mt-2 text-xs text-muted-foreground">
                Approving this leaves{" "}
                <span
                  className={cn(
                    "font-medium tabular-nums",
                    budget.college.remaining - selectedAmount < 0 && "text-destructive"
                  )}
                >
                  {formatMoney(budget.college.remaining - selectedAmount)}
                </span>{" "}
                of this year's budget.
              </p>
            ) : null}
            <Button
              className="mt-3 w-full"
              disabled={busy}
              onClick={() => approve(selected.map((s) => s.id))}
            >
              <CheckCheck className="size-4" />
              {busy
                ? "Approving…"
                : `Approve ${selected.length} · ${formatMoney(selectedAmount)}`}
            </Button>
            <p className="mt-2 text-center text-xs text-muted-foreground">
              Approving releases these to finance for payment.
            </p>
          </div>
        </div>
      ) : null}

      <Dialog open={!!sendBack} onOpenChange={(o) => !o && setSendBack(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Send back to the research cell</DialogTitle>
            <DialogDescription>
              {sendBack?.ticket_number} — {sendBack?.paper_title}
            </DialogDescription>
          </DialogHeader>
          <Callout tone="info" title="This goes to the research cell, not the claimant">
            What you are querying is the checking. A claimant told only that it came
            back will file the same thing again.
          </Callout>
          <Textarea
            rows={3}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. the quartile does not match the journal for that year"
            aria-label="Reason for sending it back"
          />
          <DialogFooter>
            <Button variant="ghost" onClick={() => setSendBack(null)}>
              Cancel
            </Button>
            <Button variant="destructive" disabled={busy} onClick={doSendBack}>
              Send back
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
