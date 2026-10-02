import { useEffect, useMemo, useRef, useState } from "react"
import { useNavigate } from "react-router-dom"
import { Inbox, ListFilter } from "lucide-react"

import { can, useAuth } from "@/app/auth"
import { openShortcuts } from "@/app/shortcuts"
import { cn } from "@/lib/cn"
import { CHAIN, useApi, useApiMutation } from "@/lib/query"
import { countAssignedToMe, isAssignedToMe } from "@/ui/assignee"
import { AnswerLine, AnswerWord, tieNumbers } from "@/ui/answer"
import { Button } from "@/ui/button"
import { ClaimNoJump, matchesClaimNo } from "@/ui/claim-number"
import { Checkbox } from "@/ui/field"
import { OwnPapersNote } from "@/ui/own-papers"
import { PageHeader } from "@/ui/page-header"
import { money } from "@/ui/paper"
import { useSlashToSearch } from "@/ui/queue-keys"
import {
  BulkHoldDialog,
  NoBulkSendBack,
  QuietSelect,
  SearchBox,
  SkippedDialog,
  reviewLink,
  useUrlFilters,
  waitingLabel,
} from "@/ui/queue"
import { Rows } from "@/ui/section"
import { EmptyState, ErrorState, SkeletonRows } from "@/ui/state"
import { Meta } from "@/ui/text"
import { toast } from "@/ui/toast"
import { AGE_BUCKETS, ageSplit, inBucket, isAgeBucket } from "@/pages/clearing-desk"
import type { BulkClearResult, QueueClaim } from "@/pages/clearing-actions"
import { ClearConfirmDialog } from "@/pages/cell/clear-confirm"
import { ClearingRow, isReady, notReady } from "@/pages/cell/clearing-rows"

/**
 * The research cell's daily job: every submitted claim, oldest first, in two
 * lanes (docs/ux/26). **Ready to clear** is the batch: every check passed, no
 * journal watched, an amount worked out. **Needs a look** is the job, each row
 * saying why in a phrase. The cursor walks both, ready first.
 *
 * Two things this page cannot afford to get wrong. First, the order:
 * `waiting_days` is the queue's own priority, so nothing here re-sorts what
 * the server already put oldest-first; the lanes only split it. Second, the
 * amount: the server recomputes it inside the same request, and a bulk clear
 * skips a claim whose amount has moved instead of clearing it at the wrong
 * number.
 *
 * Keys: j/k move, x chooses, a chooses every ready claim, c clears the chosen
 * (or the claim under the cursor, if it is ready), s opens the claim to send
 * back, h holds, Enter opens, / searches.
 */

export { isReady } from "@/pages/cell/clearing-rows"

const FILTER_KEYS = ["q", "department", "check", "age", "assigned"] as const

export function Clearing() {
  const { me } = useAuth()
  const allowed = can(me?.role).clear
  const navigate = useNavigate()

  const {
    data: claims,
    isLoading,
    isError,
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
  const [showFilters, setShowFilters] = useState(false)

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
        (check === "ready" && isReady(c)) ||
        (check === "passed" && c.verification_ok === true) ||
        (check === "failed" && c.verification_ok === false) ||
        (check === "flagged" && (c.duplicate_warning || c.contest_forward || !!c.journal_watch))) &&
      (!needle ||
        matchesClaimNo(c.ticket_number, q) ||
        [c.paper_title, c.ticket_number, c.owner_name, c.journal_title]
          .filter(Boolean)
          .some((v) => String(v).toLowerCase().includes(needle)))
  )
  const ready = rows.filter(isReady)
  const rest = rows.filter((c) => !isReady(c))
  // The cursor's order is the screen's order: the ready lane, then the rest.
  const ordered = useMemo(() => [...ready, ...rest], [ready, rest]) // eslint-disable-line react-hooks/exhaustive-deps

  const byDept = [
    ...all.reduce(
      (m, c) => m.set(c.owner_department || "No department", (m.get(c.owner_department || "No department") || 0) + 1),
      new Map<string, number>()
    ),
  ].sort((a, b) => b[1] - a[1])
  const queueTotal = all.reduce((s, c) => s + (c.remuneration || 0), 0)
  const priced = all.filter((c) => c.remuneration != null).length
  const oldest = all.reduce((m, c) => Math.max(m, c.waiting_days ?? 0), 0)
  const late = all.filter((c) => (c.waiting_days ?? 0) > 14).length
  const readyAll = all.filter(isReady)
  const readyTotal = ready.reduce((s, c) => s + (c.remuneration || 0), 0)

  // Whole rows, not ids: a row that has left this fetch still has to be able
  // to say its own title and amount in the dialog and the summary.
  const [selected, setSelected] = useState<Map<string, QueueClaim>>(new Map())
  const [activeRow, setActiveRow] = useState(0)
  const [dialog, setDialog] = useState<null | { kind: "clear"; rows: QueueClaim[] } | { kind: "hold" }>(null)
  const [result, setResult] = useState<{ result: BulkClearResult; lookup: Map<string, QueueClaim> } | null>(null)
  const [holdResult, setHoldResult] = useState<{ skipped: { id: string; reason: string }[]; lookup: Map<string, QueueClaim> } | null>(null)

  const href = (c: QueueClaim) => reviewLink(c.id, "clearing", filtered ? currentFilters() : undefined)
  function currentFilters() {
    const p = new URLSearchParams()
    for (const k of FILTER_KEYS) if (values[k]) p.set(k, values[k])
    return p
  }

  useEffect(() => {
    setActiveRow((i) => Math.min(i, Math.max(0, ordered.length - 1)))
  }, [ordered.length])

  function toggleSelected(c: QueueClaim) {
    setSelected((prev) => {
      const next = new Map(prev)
      if (next.has(c.id)) next.delete(c.id)
      else next.set(c.id, c)
      return next
    })
  }
  function toggleLane(lane: QueueClaim[]) {
    setSelected((prev) => {
      const next = new Map(prev)
      const every = lane.length > 0 && lane.every((c) => next.has(c.id))
      for (const c of lane) {
        if (every) next.delete(c.id)
        else next.set(c.id, c)
      }
      return next
    })
  }

  const selectedRows = [...selected.values()]
  const selectedTotal = selectedRows.reduce((sum, c) => sum + (c.remuneration || 0), 0)

  /** `c`: clear what is chosen, or the claim under the cursor if it is ready. */
  function clearKey() {
    if (selectedRows.length > 0) return setDialog({ kind: "clear", rows: selectedRows })
    const row = ordered[activeRow]
    if (!row) return
    if (!isReady(row)) {
      toast.info(`${row.ticket_number ?? "This claim"} is not ready: ${notReady(row).join(", ").toLowerCase()}. Press Enter to look at it.`)
      return
    }
    setDialog({ kind: "clear", rows: [row] })
  }

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.ctrlKey || e.metaKey || e.altKey) return
      if (dialog || result || holdResult) return
      const target = e.target as HTMLElement | null
      const tag = target?.tagName
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target?.isContentEditable) return
      if (document.querySelector('[role="dialog"]')) return
      if (ordered.length === 0) return
      const row = ordered[activeRow]
      if (e.key === "j" || e.key === "ArrowDown") {
        e.preventDefault()
        setActiveRow((i) => Math.min(i + 1, ordered.length - 1))
      } else if (e.key === "k" || e.key === "ArrowUp") {
        e.preventDefault()
        setActiveRow((i) => Math.max(i - 1, 0))
      } else if (e.key === "x" && row) {
        e.preventDefault()
        toggleSelected(row)
      } else if (e.key === "a") {
        e.preventDefault()
        toggleLane(ready)
      } else if (e.key === "c") {
        e.preventDefault()
        clearKey()
      } else if (e.key === "s" && row) {
        e.preventDefault()
        navigate(`${href(row)}&do=sendback`)
      } else if (e.key === "h") {
        e.preventDefault()
        if (selected.size === 0 && row) toggleSelected(row)
        setDialog({ kind: "hold" })
      } else if (e.key === "Enter" && row) {
        e.preventDefault()
        navigate(href(row))
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ordered, activeRow, dialog, result, holdResult, selected])

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

  /** What a batch leaves out, by reason, for the dialog. */
  function leftOutOf(pool: QueueClaim[], batch: Set<string>) {
    const left = pool.filter((c) => !batch.has(c.id))
    const tally = new Map<string, number>()
    for (const c of left) for (const w of notReady(c)) tally.set(w.toLowerCase(), (tally.get(w.toLowerCase()) ?? 0) + 1)
    return {
      count: left.length,
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
      const sum = batch.filter((c) => !skippedIds.has(c.id)).reduce((s, c) => s + (c.remuneration || 0), 0)
      if (res.skipped.length === 0) {
        toast.stamp(
          "Cleared",
          res.cleared === 1
            ? `${money(sum)} sent to the Principal${batch[0].ticket_number ? `. ${batch[0].ticket_number}` : ""}.`
            : `${res.cleared} claims, ${money(sum)}, sent to the Principal.`
        )
      } else {
        if (res.cleared > 0) toast.stamp("Cleared", `${res.cleared} claims, ${money(sum)}, sent to the Principal.`)
        setResult({ result: res, lookup })
      }
    } catch (err) {
      toast.fail(err)
      throw err
    }
  }

  const dialogRows = dialog?.kind === "clear" ? dialog.rows : []
  const dialogIds = new Set(dialogRows.map((c) => c.id))
  const notReadyInBatch = dialogRows.filter((c) => !isReady(c)).map((c) => ({ id: c.id, note: `${c.ticket_number ?? c.paper_title}: ${notReady(c).join(", ").toLowerCase()}` }))

  // The answer, in a sentence. Two short clauses, at most.
  const answer =
    all.length === 0 ? (
      <>Nothing is waiting. The desk is clear.</>
    ) : readyAll.length > 0 ? (
      <>
        {readyAll.length} of {all.length} are <AnswerWord tone="sage">ready to clear</AnswerWord>.
      </>
    ) : (
      <>
        None of the {all.length} is <AnswerWord tone="amber">ready</AnswerWord> yet.
      </>
    )

  let cursor = -1
  const lane = (list: QueueClaim[], isReadyLane: boolean) => (
    <Rows>
      {list.map((c) => {
        cursor += 1
        const i = cursor
        return (
          <ClearingRow
            key={c.id}
            claim={c}
            ready={isReadyLane}
            active={i === activeRow}
            selected={selected.has(c.id)}
            onToggle={() => toggleSelected(c)}
            onActive={() => setActiveRow(i)}
            href={href(c)}
          />
        )
      })}
    </Rows>
  )

  const laneHead = (title: string, list: QueueClaim[], hint: string) => (
    <div className="mb-1 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-1">
      <div className="flex items-baseline gap-3">
        <h2 className="text-lg font-semibold">{title}</h2>
        <span className="tabular text-sm text-fg-muted">
          {list.length}
          {list.some((c) => c.remuneration != null) && ` · ${money(list.reduce((s, c) => s + (c.remuneration || 0), 0))}`}
        </span>
      </div>
      <div className="flex items-center gap-3">
        <Meta className="hidden sm:inline">{hint}</Meta>
        <label className="flex cursor-pointer items-center gap-2 text-sm text-fg-muted">
          <Checkbox
            checked={list.length > 0 && list.every((c) => selected.has(c.id))}
            onCheckedChange={() => toggleLane(list)}
            aria-label={`Choose all ${list.length} in ${title.toLowerCase()}`}
          />
          Choose all
        </label>
      </div>
    </div>
  )

  return (
    <div className="page space-y-10">
      <PageHeader
        title="Clearing queue"
        action={
          ready.length > 0 ? (
            <Button kind="primary" onClick={() => setDialog({ kind: "clear", rows: ready })}>
              Clear the {ready.length} ready
            </Button>
          ) : undefined
        }
      />

      <div className="space-y-3">
        <AnswerLine>{answer}</AnswerLine>
        {all.length > 0 && (
          <p className="text-sm text-fg-muted">
            {priced === 0 ? (
              "Amounts are not worked out yet. "
            ) : (
              <>
                <span className="tabular text-fg">{money(queueTotal)}</span>{" "}
                {priced < all.length ? `across the ${priced} priced. ` : "in all. "}
              </>
            )}
            Oldest {waitingLabel(oldest).toLowerCase()}.{" "}
            {late > 0 && (
              <span className="text-critical">
                {tieNumbers(`${late} past 14 days`)}.
              </span>
            )}
          </p>
        )}
      </div>

      {all.length > 0 && (
        <section aria-label="Find and narrow" className="space-y-3">
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex w-full items-center gap-2 sm:w-auto">
              <SearchBox
                inputRef={searchRef}
                value={q}
                onCommit={(next) => set({ q: next })}
                placeholder="Claim no., title, claimant or journal"
                label="Search the queue"
                className="min-w-0 flex-1 sm:w-80"
              />
              <Button kind="default" size="icon" className="sm:hidden" aria-label="Filters" aria-expanded={showFilters} onClick={() => setShowFilters((v) => !v)}>
                <ListFilter />
              </Button>
            </div>
            <div className={cn("gap-3", showFilters ? "grid w-full grid-cols-2 sm:contents" : "hidden sm:contents")}>
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
            </div>
          </div>
          <ClaimNoJump term={q} skip={new Set(all.map((c) => c.id))} />
          <Meta className="hidden md:block">
            <Kbd>j</Kbd> <Kbd>k</Kbd> move · <Kbd>c</Kbd> clear · <Kbd>a</Kbd> choose the ready · <Kbd>x</Kbd> choose one ·{" "}
            <Kbd>s</Kbd> send back · <Kbd>Enter</Kbd> open · <Kbd>/</Kbd> search ·{" "}
            <button type="button" onClick={openShortcuts} className="underline underline-offset-2">
              all shortcuts
            </button>
          </Meta>
        </section>
      )}

      {selected.size > 0 && (
        <div className="sticky top-14 z-20 space-y-2 rounded-panel bg-surface px-4 py-3 shadow-pop ring-1 ring-edge md:top-2">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm">
              <span className="font-semibold">{selected.size}</span> chosen ·{" "}
              <span className="tabular font-semibold">{money(selectedTotal)}</span>
              {selectedRows.some((c) => !isReady(c)) && (
                <span className="text-caution"> · {selectedRows.filter((c) => !isReady(c)).length} not ready</span>
              )}
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <Button kind="quiet" size="sm" onClick={() => setSelected(new Map())}>
                Choose none
              </Button>
              <Button kind="default" size="sm" onClick={() => setDialog({ kind: "hold" })}>
                Put on hold
              </Button>
              <Button kind="primary" size="sm" onClick={() => setDialog({ kind: "clear", rows: selectedRows })}>
                Clear {selected.size} {selected.size === 1 ? "claim" : "claims"}
              </Button>
            </div>
          </div>
          <NoBulkSendBack />
        </div>
      )}

      {isLoading ? (
        <>
          <SkeletonRows rows={8} rowHeight={72} className="hidden md:block" />
          <SkeletonRows rows={5} rowHeight={112} className="md:hidden" />
        </>
      ) : isError ? (
        <ErrorState
          title="Could not load the queue"
          message="The server did not answer. Nothing has been lost or cleared."
          onRetry={() => refetch()}
        />
      ) : all.length > 0 && rows.length === 0 ? (
        <EmptyState size="region" icon={Inbox} title="No claim matches these filters" message={`${all.length} are waiting in all.`} />
      ) : rows.length === 0 ? (
        <EmptyState
          size="region"
          guide="clear-a-claim"
          art="empty-queue"
          icon={Inbox}
          title="Nothing waiting"
          message="Every submitted claim has been checked. Come back when the next one lands."
        />
      ) : (
        <div className="space-y-10">
          {ready.length > 0 && (
            <section aria-label="Ready to clear">
              {laneHead("Ready to clear", ready, "Every check passed and no journal is watched.")}
              {lane(ready, true)}
            </section>
          )}
          {rest.length > 0 && (
            <section aria-label="Needs a look">
              {laneHead("Needs a look", rest, "Open each one to decide.")}
              {lane(rest, false)}
            </section>
          )}
          <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2 text-xs text-fg-muted">
            <p>Numbers that start with ERP were brought across from the old ERP workbook. They have no filing date of their own.</p>
            <Button kind="quiet" size="sm" onClick={() => downloadQueue(ordered)}>
              Download these {ordered.length} as CSV
            </Button>
          </div>
          <OwnPapersNote />
          {readyTotal > 0 && ready.length > 0 && <span className="sr-only">{ready.length} ready, {money(readyTotal)}</span>}
        </div>
      )}

      <ClearConfirmDialog
        open={dialog?.kind === "clear"}
        onOpenChange={(o) => !o && setDialog(null)}
        rows={dialogRows}
        notes={notReadyInBatch}
        leftOut={dialogRows.length > 1 && dialogRows.length === ready.length && dialogRows.every((c) => isReady(c)) ? leftOutOf(rows, dialogIds) : undefined}
        onConfirm={() => runBulkClear(dialogRows)}
      />
      <BulkHoldDialog
        open={dialog?.kind === "hold"}
        onOpenChange={(o) => !o && setDialog(null)}
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

function Kbd({ children }: { children: React.ReactNode }) {
  return <kbd className="rounded border border-edge px-1 text-[0.6875rem]">{children}</kbd>
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
