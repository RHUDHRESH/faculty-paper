import { useEffect, useMemo, useRef, useState } from "react"
import { useNavigate } from "react-router-dom"
import { AlertTriangle, Inbox, PauseCircle, RefreshCw } from "lucide-react"

import { can, useAuth } from "@/app/auth"
import { openShortcuts } from "@/app/shortcuts"
import { cn } from "@/lib/cn"
import { CHAIN, useApi, useApiMutation } from "@/lib/query"
import { countAssignedToMe, isAssignedToMe } from "@/ui/assignee"
import { Button } from "@/ui/button"
import { ClaimNoJump, matchesClaimNo } from "@/ui/claim-number"
import { filterBar } from "@/ui/filter-bar"
import { EmptyState, ErrorState, SkeletonRows } from "@/ui/state"
import { Meta, PageTitle, Sub } from "@/ui/text"
import { money } from "@/ui/paper"
import { useSlashToSearch } from "@/ui/queue-keys"
import { toast } from "@/ui/toast"
import { OwnPapersNote } from "@/ui/own-papers"
import { HeaderSpot } from "@/ui/page-header"
import {
  BulkHoldDialog,
  BulkSummaryDialog,
  NoBulkSendBack,
  QueueTable,
  QuietSelect,
  RowFlag,
  SearchBox,
  SkippedDialog,
  reviewLink,
  useUrlFilters,
  waitTone,
  waitingLabel,
  type SummaryRow,
} from "@/ui/queue"
import { thresholdFlag } from "@/ui/research-threshold"
import { AGE_BUCKETS, ageSplit, inBucket, isAgeBucket, isClean, MonthlyReport } from "@/pages/clearing-desk"
import type { BulkClearResult, QueueClaim } from "@/pages/clearing-actions"

/**
 * The research cell's daily job: every submitted claim, oldest first, and the
 * one screen where a figure turns into a payment on its way.
 *
 * Two things this page cannot afford to get wrong. First, the order:
 * `waiting_days` is the queue's own priority, so nothing here re-sorts what
 * the server already put oldest-first. Second, the amount: the server
 * recomputes it inside the same request, and a bulk clear skips a claim whose
 * amount has moved instead of clearing it at the wrong number.
 *
 * A row opens the full-page review (`/review/:id?queue=clearing`). The old
 * side sheet is gone; its dialogs live on in `clearing-actions.tsx`.
 */

const FILTER_KEYS = ["q", "department", "check", "age", "assigned"] as const

/** Why a claim is not ready to clear, in words for the desk. Empty when it is ready. */
function notReady(c: QueueClaim): string[] {
  const why: string[] = []
  if (c.on_hold) why.push("on hold")
  if (c.verification_ok === false) why.push("checks failed")
  else if (c.verification_ok == null) why.push("not checked yet")
  if (c.duplicate_warning) why.push("possible duplicate")
  if (c.contest_forward) why.push("contested by the claimant")
  if (c.journal_watch) why.push("watched journal")
  if (c.affiliation_ok === false) why.push("affiliation not confirmed")
  if (c.calc_error || c.remuneration == null) why.push("no amount")
  return why
}

/** All checks pass and nothing is watch-listed. */
export function isReady(c: QueueClaim): boolean {
  return !c.on_hold && isClean(c)
}

function summaryRow(c: QueueClaim, withNote: boolean): SummaryRow {
  const why = withNote ? notReady(c) : []
  return { ...c, note: why.length ? why.join(", ") : null }
}

export function Clearing() {
  const { me } = useAuth()
  const allowed = can(me?.role).clear
  const navigate = useNavigate()

  const {
    data: claims,
    isLoading,
    isError,
    isFetching,
    refetch,
  } = useApi<QueueClaim[]>(["clearing-queue"], "/api/admin/clearing-queue?status=SUBMITTED", {
    enabled: allowed,
    placeholderData: (prev) => prev,
  })
  const all = useMemo(() => claims ?? [], [claims])

  // Filters live in the address, so a saved link brings the same view back.
  const { values, set, clear, active: filtered } = useUrlFilters(FILTER_KEYS)
  const { q, department, check, assigned } = values
  const age = isAgeBucket(values.age) ? values.age : ""
  const searchRef = useRef<HTMLInputElement>(null)
  useSlashToSearch(searchRef)

  const needle = q.trim().toLowerCase()
  // Narrowing only: the server's oldest-first order is never re-sorted.
  const rows = all.filter(
    (c) =>
      (!department || (c.owner_department || "No department") === department) &&
      inBucket(c.waiting_days, age) &&
      (!assigned ||
        (assigned === "me" && isAssignedToMe(c, me?.id)) ||
        (assigned === "none" && !c.assigned_to)) &&
      (!check ||
        (check === "passed" && c.verification_ok === true) ||
        (check === "failed" && c.verification_ok === false) ||
        (check === "ready" && isReady(c)) ||
        (check === "flagged" && (c.duplicate_warning || c.contest_forward || !!c.journal_watch))) &&
      (!needle ||
        matchesClaimNo(c.ticket_number, q) ||
        [c.paper_title, c.ticket_number, c.owner_name, c.journal_title]
          .filter(Boolean)
          .some((v) => String(v).toLowerCase().includes(needle)))
  )
  const byDept = [
    ...all.reduce(
      (m, c) => m.set(c.owner_department || "No department", (m.get(c.owner_department || "No department") || 0) + 1),
      new Map<string, number>()
    ),
  ].sort((a, b) => b[1] - a[1])
  const queueTotal = all.reduce((s, c) => s + (c.remuneration || 0), 0)
  const priced = all.filter((c) => c.remuneration != null).length
  const oldest = all.reduce((m, c) => Math.max(m, c.waiting_days ?? 0), 0)
  const ready = rows.filter(isReady)

  // Whole rows, not ids: a row that has left this fetch still has to be able
  // to say its own title and amount in the bar and the summary.
  const [selected, setSelected] = useState<Map<string, QueueClaim>>(new Map())
  const [activeRow, setActiveRow] = useState(0)
  const [dialog, setDialog] = useState<null | "ready" | "selected" | "hold">(null)
  const [result, setResult] = useState<{ result: BulkClearResult; lookup: Map<string, QueueClaim> } | null>(null)
  const [holdResult, setHoldResult] = useState<{ skipped: { id: string; reason: string }[]; lookup: Map<string, QueueClaim> } | null>(null)

  const href = (c: QueueClaim) => reviewLink(c.id, "clearing", filtered ? currentFilters() : undefined)
  function currentFilters() {
    const p = new URLSearchParams()
    for (const k of FILTER_KEYS) if (values[k]) p.set(k, values[k])
    return p
  }

  useEffect(() => {
    setActiveRow((i) => Math.min(i, Math.max(0, rows.length - 1)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows.length])

  function toggleSelected(c: QueueClaim) {
    setSelected((prev) => {
      const next = new Map(prev)
      if (next.has(c.id)) next.delete(c.id)
      else next.set(c.id, c)
      return next
    })
  }
  function toggleAllVisible() {
    setSelected((prev) => {
      const next = new Map(prev)
      const every = rows.length > 0 && rows.every((c) => next.has(c.id))
      for (const c of rows) {
        if (every) next.delete(c.id)
        else next.set(c.id, c)
      }
      return next
    })
  }

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (dialog) return
      const target = e.target as HTMLElement | null
      const tag = target?.tagName
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target?.isContentEditable) return
      if (document.querySelector('[role="dialog"]')) return
      if (rows.length === 0) return
      if (e.key === "j" || e.key === "ArrowDown") {
        e.preventDefault()
        setActiveRow((i) => Math.min(i + 1, rows.length - 1))
      } else if (e.key === "k" || e.key === "ArrowUp") {
        e.preventDefault()
        setActiveRow((i) => Math.max(i - 1, 0))
      } else if (e.key === "x") {
        e.preventDefault()
        const row = rows[activeRow]
        if (row) toggleSelected(row)
      } else if (e.key === "Enter") {
        e.preventDefault()
        const row = rows[activeRow]
        if (row) navigate(href(row))
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, activeRow, dialog])

  const bulkClear = useApiMutation<{ claim_ids: string[]; note?: string }, BulkClearResult>("/api/admin/bulk-clear", {
    invalidates: [...CHAIN],
  })

  if (!allowed) {
    return (
      <div className="page py-8">
        <ErrorState title="Not open to this account" message="Only the research cell and a super admin can clear claims." />
      </div>
    )
  }

  const selectedRows = [...selected.values()]
  const selectedTotal = selectedRows.reduce((sum, c) => sum + (c.remuneration || 0), 0)
  const selectedNotReady = selectedRows.filter((c) => !isReady(c)).length
  const selectedOffList = selected.size - rows.filter((c) => selected.has(c.id)).length

  /** What the ready batch leaves out, by reason, for the summary. */
  function leftOutOf(pool: QueueClaim[], batch: Set<string>) {
    const rest = pool.filter((c) => !batch.has(c.id))
    const tally = new Map<string, number>()
    for (const c of rest) for (const w of notReady(c)) tally.set(w, (tally.get(w) ?? 0) + 1)
    return {
      count: rest.length,
      reasons: [...tally].sort((a, b) => b[1] - a[1]).map(([label, count]) => ({ label, count })),
    }
  }

  async function runBulkClear(batch: QueueClaim[]) {
    const ids = batch.map((c) => c.id)
    const lookup = new Map(batch.map((c) => [c.id, c]))
    try {
      const res = await bulkClear.mutateAsync({ claim_ids: ids })
      const skippedIds = new Set(res.skipped.map((s) => s.id))
      setSelected((prev) => {
        const next = new Map(prev)
        for (const id of ids) if (!skippedIds.has(id)) next.delete(id)
        return next
      })
      if (res.skipped.length === 0) {
        toast.ok(`Cleared. ${res.cleared} ${res.cleared === 1 ? "claim" : "claims"} sent to the Principal`)
      } else {
        setResult({ result: res, lookup })
      }
    } catch (err) {
      toast.fail(err)
      throw err
    }
  }

  const readyIds = new Set(ready.map((c) => c.id))
  const flagsFor = (c: QueueClaim) => (
    <>
      {c.on_hold && (
        <RowFlag tone="caution">
          <PauseCircle className="size-3" aria-hidden /> On hold
        </RowFlag>
      )}
      {c.duplicate_warning && (
        <RowFlag tone="critical">
          <AlertTriangle className="size-3" aria-hidden /> Possible duplicate
        </RowFlag>
      )}
      {c.contest_forward && <RowFlag tone="caution">Contested</RowFlag>}
      {c.journal_watch && <RowFlag tone="critical">Watched journal</RowFlag>}
      {thresholdFlag(c) && <RowFlag tone="caution">{thresholdFlag(c)}</RowFlag>}
      {c.owner_threshold_unset && <RowFlag tone="caution">Research faculty, threshold not set</RowFlag>}
      {(c.calc_error || c.remuneration == null) && <RowFlag tone="critical">No amount</RowFlag>}
      {!c.calc_error && c.remuneration_is_estimate && <RowFlag tone="caution">Estimate</RowFlag>}
      {c.verification_ok === false && <RowFlag tone="critical">Checks failed</RowFlag>}
    </>
  )

  return (
    <div className="page space-y-5">
      <header className="page-head">
        <div>
          <PageTitle>Clearing queue</PageTitle>
          <Sub className="mt-1">Submitted claims, oldest first. The one that has waited longest is next.</Sub>
          <OwnPapersNote className="mt-1" />
        </div>
        <Button kind="quiet" size="sm" onClick={() => void refetch()} disabled={isFetching}>
          <RefreshCw className={cn("size-4", isFetching && "animate-spin")} />
          Refresh
        </Button>
        <HeaderSpot name="spot-approvals" />
      </header>

      {all.length > 0 && (
        <section aria-label="The queue at a glance" className="space-y-3">
          <p className="text-sm text-fg-muted">
            <span className="font-semibold text-fg">{all.length}</span> waiting ·{" "}
            {priced === 0 ? (
              "amounts not worked out yet"
            ) : (
              <>
                <span className="tabular font-semibold text-fg">{money(queueTotal)}</span>{" "}
                {priced < all.length ? `across the ${priced} priced` : "in all"}
              </>
            )}{" "}
            · oldest{" "}
            <span className={cn("font-semibold", waitTone(oldest) || "text-fg")}>{waitingLabel(oldest).toLowerCase()}</span>
          </p>

          <div className={filterBar}>
            <SearchBox
              inputRef={searchRef}
              value={q}
              onCommit={(next) => set({ q: next })}
              placeholder="Claim no., title, claimant or journal"
              label="Filter the queue"
            />
            <QuietSelect value={department} onChange={(v) => set({ department: v })} label="Filter by department">
              <option value="">All departments</option>
              {byDept.map(([d, n]) => (
                <option key={d} value={d}>
                  {d} ({n})
                </option>
              ))}
            </QuietSelect>
            <QuietSelect value={age} onChange={(v) => set({ age: v })} label="Filter by how long it has waited">
              <option value="">Any wait</option>
              {ageSplit(all).map((b) => (
                <option key={b.id} value={b.id} disabled={b.n === 0 && age !== b.id}>
                  {AGE_BUCKETS.find((x) => x.id === b.id)?.label} ({b.n})
                </option>
              ))}
            </QuietSelect>
            <QuietSelect value={check} onChange={(v) => set({ check: v })} label="Filter by checks">
              <option value="">Any checks</option>
              <option value="ready">Ready to clear</option>
              <option value="passed">Checks passed</option>
              <option value="failed">Checks failed</option>
              <option value="flagged">Duplicate, contested or watched</option>
            </QuietSelect>
            <QuietSelect value={assigned} onChange={(v) => set({ assigned: v })} label="Filter by who it is given to">
              <option value="">Given to anyone</option>
              <option value="me">Given to me ({countAssignedToMe(all, me?.id)})</option>
              <option value="none">Not given to anyone ({all.filter((c) => !c.assigned_to).length})</option>
            </QuietSelect>
            {filtered && (
              <Button kind="quiet" size="sm" onClick={clear}>
                Show all {all.length}
              </Button>
            )}
            <Button kind="quiet" size="sm" className="ml-auto" onClick={() => downloadQueue(rows)}>
              Download these {rows.length} as CSV
            </Button>
          </div>
          <ClaimNoJump term={q} skip={new Set(all.map((c) => c.id))} />
        </section>
      )}

      {ready.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg bg-sunken px-4 py-3">
          <p className="text-sm">
            <span className="font-semibold">{ready.length}</span> of {rows.length} shown {ready.length === 1 ? "is" : "are"} ready to clear.{" "}
            <span className="text-fg-muted">Every check passed and no journal is on the watch-list.</span>
          </p>
          <Button kind="primary" size="sm" className="ml-auto" onClick={() => setDialog("ready")}>
            Review the {ready.length} ready
          </Button>
        </div>
      )}

      <Meta className="hidden md:block">
        <kbd className="rounded border border-edge px-1 text-[10px]">j</kbd>/
        <kbd className="rounded border border-edge px-1 text-[10px]">k</kbd> to move ·{" "}
        <kbd className="rounded border border-edge px-1 text-[10px]">x</kbd> to select ·{" "}
        <kbd className="rounded border border-edge px-1 text-[10px]">Enter</kbd> to open ·{" "}
        <kbd className="rounded border border-edge px-1 text-[10px]">/</kbd> to search ·{" "}
        <button type="button" onClick={openShortcuts} className="underline underline-offset-2">
          all shortcuts
        </button>
      </Meta>

      {selected.size > 0 && (
        <div className="sticky top-14 z-20 space-y-2 rounded-lg bg-accent-wash px-4 py-3 shadow-pop md:top-2">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm">
              <span className="font-semibold">{selected.size}</span> selected ·{" "}
              <span className="font-semibold tabular">{money(selectedTotal)}</span>
              {selectedOffList > 0 && <span className="text-fg-muted"> · {selectedOffList} not in view</span>}
              {selectedNotReady > 0 && <span className="text-fg-muted"> · {selectedNotReady} not ready</span>}
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <Button kind="quiet" size="sm" onClick={() => setSelected(new Map())}>
                Clear selection
              </Button>
              <Button kind="default" size="sm" onClick={() => setDialog("hold")}>
                Put on hold
              </Button>
              <Button kind="primary" size="sm" onClick={() => setDialog("selected")}>
                Clear {selected.size} {selected.size === 1 ? "claim" : "claims"}
              </Button>
            </div>
          </div>
          <NoBulkSendBack />
        </div>
      )}

      {isLoading ? (
        <>
          <SkeletonRows rows={8} rowHeight={52} className="hidden md:block" />
          <SkeletonRows rows={5} rowHeight={96} className="md:hidden" />
        </>
      ) : isError ? (
        <ErrorState
          title="Could not load the queue"
          message="The server did not answer. Nothing has been lost or cleared."
          onRetry={() => refetch()}
        />
      ) : all.length > 0 && rows.length === 0 ? (
        <EmptyState icon={Inbox} title="No claim matches these filters" message={`${all.length} are waiting in all.`} />
      ) : rows.length === 0 ? (
        <EmptyState
          guide="clear-a-claim"
          art="empty-queue"
          icon={Inbox}
          title="Nothing waiting"
          message="Every submitted claim has been checked. Come back when the next one lands."
        />
      ) : (
        <QueueTable
          label="Claims waiting to be cleared"
          rows={rows}
          reviewHref={href}
          showAmount
          flags={flagsFor}
          active={activeRow}
          onActive={setActiveRow}
          select={{
            selected: new Set(selected.keys()),
            onToggle: toggleSelected,
            onToggleAll: toggleAllVisible,
          }}
        />
      )}

      <MonthlyReport />

      <BulkSummaryDialog
        open={dialog === "ready"}
        onOpenChange={(o) => setDialog(o ? "ready" : null)}
        title={`Clear ${ready.length} ready ${ready.length === 1 ? "claim" : "claims"}?`}
        rows={ready.map((c) => summaryRow(c, false))}
        showMoney
        leftOut={leftOutOf(rows, readyIds)}
        confirmLabel={`Clear ${ready.length} for ${money(ready.reduce((s, c) => s + (c.remuneration || 0), 0))}`}
        footnote="Each claim is checked again as it clears. One whose amount has moved is skipped, not cleared at the wrong number."
        onConfirm={() => runBulkClear(ready)}
      />
      <BulkSummaryDialog
        open={dialog === "selected"}
        onOpenChange={(o) => setDialog(o ? "selected" : null)}
        title={`Clear ${selectedRows.length} ${selectedRows.length === 1 ? "claim" : "claims"}?`}
        rows={selectedRows.map((c) => summaryRow(c, true))}
        showMoney
        confirmLabel={`Clear ${selectedRows.length} for ${money(selectedTotal)}`}
        footnote="Each claim is checked again as it clears. A claim on a watched journal is skipped."
        onConfirm={() => runBulkClear(selectedRows)}
      />
      <BulkHoldDialog
        open={dialog === "hold"}
        onOpenChange={(o) => setDialog(o ? "hold" : null)}
        rows={selectedRows}
        onDone={(res) => {
          const held = new Set(res.held_ids)
          const lookup = new Map(selectedRows.map((c) => [c.id, c]))
          setSelected((prev) => {
            const next = new Map(prev)
            for (const id of held) next.delete(id)
            return next
          })
          if (res.skipped.length > 0) setHoldResult({ skipped: res.skipped, lookup })
        }}
      />

      {result && (
        <SkippedDialog
          title={`Cleared ${result.result.cleared} of ${result.result.cleared + result.result.skipped.length}`}
          description="The rest were skipped, each for its own reason below. Nothing was cleared at a wrong figure."
          skipped={result.result.skipped}
          lookup={result.lookup}
          onClose={() => setResult(null)}
        />
      )}
      {holdResult && (
        <SkippedDialog
          title="Some could not be put on hold"
          description="The others are on hold. These were left as they were."
          skipped={holdResult.skipped}
          lookup={holdResult.lookup}
          onClose={() => setHoldResult(null)}
        />
      )}
    </div>
  )
}

/** The queue as it stands on screen, for the office's own spreadsheet. */
function downloadQueue(rows: QueueClaim[]) {
  const head = ["Claim no.", "Paper", "Claimant", "Department", "Journal", "Quartile", "Waiting days", "Amount", "Checks"]
  const cell = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`
  const body = rows.map((c) =>
    [
      c.ticket_number,
      c.paper_title,
      c.owner_name,
      c.owner_department,
      c.journal_title,
      c.quartile,
      c.waiting_days,
      c.remuneration,
      c.verification_ok === true ? "passed" : c.verification_ok === false ? "failed" : "not checked",
    ]
      .map(cell)
      .join(",")
  )
  const blob = new Blob(["﻿" + [head.map(cell).join(","), ...body].join("\r\n")], { type: "text/csv;charset=utf-8" })
  const a = document.createElement("a")
  a.href = URL.createObjectURL(blob)
  a.download = `clearing-queue-${new Date().toISOString().slice(0, 10)}.csv`
  a.click()
  URL.revokeObjectURL(a.href)
}
