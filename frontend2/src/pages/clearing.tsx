import { useEffect, useMemo, useRef, useState } from "react"
import { Link, useNavigate } from "react-router-dom"
import { Inbox } from "lucide-react"

import { can, useAuth } from "@/app/auth"
import { openShortcuts } from "@/app/shortcuts"
import { CHAIN, useApi, useApiMutation } from "@/lib/query"
import { countAssignedToMe, isAssignedToMe } from "@/ui/assignee"
import { Answer } from "@/ui/answer"
import { Button } from "@/ui/button"
import { ClaimNoJump, matchesClaimNo } from "@/ui/claim-number"
import { filterBar } from "@/ui/filter-bar"
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
import { ErrorState, NotOpen, SkeletonRows } from "@/ui/state"
import { Meta } from "@/ui/text"
import { toast } from "@/ui/toast"
import { AGE_BUCKETS, ageSplit, inBucket, isAgeBucket } from "@/pages/clearing-desk"
import type { BulkClearResult, QueueClaim } from "@/pages/clearing-actions"
import { ClearConfirmDialog } from "@/pages/cell/clear-confirm"
import { isReady, notReady } from "@/pages/cell/clearing-rows"
import { DeskTable } from "@/pages/desk-table"
import { thresholdFlag } from "@/ui/research-threshold"

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
        <NotOpen message="Only the research office and a super admin can clear claims." />
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

  const sub =
    all.length === 0
      ? "Every submitted claim waits here until the research office clears it."
      : `${priced === 0 ? "Amounts are not worked out yet." : `${money(queueTotal)} in all${priced < all.length ? `, across the ${priced} priced` : ""}.`} The oldest has waited ${waitingLabel(oldest).toLowerCase()}.`

  /** Why a claim is not ready, or that it is, as one plain phrase. */
  const statusText = (c: QueueClaim) => {
    if (isReady(c)) return "Ready to clear"
    const extra = [thresholdFlag(c), c.owner_threshold_unset ? "Research faculty, threshold not set" : null].filter(Boolean) as string[]
    return [...notReady(c), ...extra].join(", ")
  }

  return (
    <div className="page space-y-6">
      <PageHeader
        title="Clearing queue"
        sub={sub}
        action={
          ready.length > 0 ? (
            <Button kind="primary" onClick={() => setDialog({ kind: "clear", rows: ready })}>
              Clear the {ready.length} ready
            </Button>
          ) : undefined
        }
      />

      <Answer
        items={[
          { value: claims ? all.length : null, label: "claims waiting", zero: "Nothing is waiting", to: "/clearing" },
          { value: claims ? readyAll.length : null, label: "ready to clear", zero: "None is ready yet", tone: "positive", to: "/clearing?check=ready" },
          { value: claims ? all.length - readyAll.length : null, label: "need a look", zero: "Nothing needs a look", tone: "caution" },
          { value: claims ? late : null, label: "waiting over 14 days", zero: "None over 14 days", tone: "critical", to: "/clearing?age=month" },
        ]}
      />

      {all.length > 0 && (
        <section aria-label="Find and narrow" className="space-y-2">
          <div className={filterBar} role="search">
            <SearchBox
              inputRef={searchRef}
              value={q}
              onCommit={(next) => set({ q: next })}
              placeholder="Claim no., title, claimant or journal"
              label="Search the queue"
              className="w-full min-w-0 sm:w-80"
            />
            <QuietSelect value={check} onChange={(v) => set({ check: v })} label="Filter by checks">
              <option value="">Any checks</option>
              <option value="ready">Ready to clear</option>
              <option value="passed">Checks passed</option>
              <option value="failed">Checks failed</option>
              <option value="flagged">Flagged</option>
            </QuietSelect>
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
              <Button kind="quiet" onClick={clear}>
                Show all {all.length}
              </Button>
            )}
          </div>
          <ClaimNoJump term={q} skip={new Set(all.map((c) => c.id))} />
          <Meta className="hidden text-sm md:block">
            <Kbd>j</Kbd> <Kbd>k</Kbd> move, <Kbd>c</Kbd> clear, <Kbd>a</Kbd> choose the ready, <Kbd>x</Kbd> choose one,{" "}
            <Kbd>s</Kbd> send back, <Kbd>Enter</Kbd> open, <Kbd>/</Kbd> search.{" "}
            <button type="button" onClick={openShortcuts} className="underline underline-offset-2">
              All shortcuts
            </button>
          </Meta>
        </section>
      )}

      {selected.size > 0 && (
        <div className="sticky top-14 z-20 space-y-2 rounded-panel bg-surface px-4 py-3 shadow-pop ring-1 ring-edge md:top-2">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm">
              <span className="font-semibold">{selected.size}</span> chosen,{" "}
              <span className="tabular font-semibold">{money(selectedTotal)}</span>
              {selectedRows.some((c) => !isReady(c)) && (
                <span className="text-caution">, {selectedRows.filter((c) => !isReady(c)).length} not ready</span>
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
        <SkeletonRows rows={8} rowHeight={56} />
      ) : isError ? (
        <ErrorState
          title="Could not load the queue"
          message="The server did not answer. Nothing has been lost or cleared."
          onRetry={() => refetch()}
        />
      ) : (
        <>
          <DeskTable
            rows={ordered}
            href={href}
            id="clearing-queue"
            title="Clearing queue"
            caption="Submitted claims, ready ones first"
            active={activeRow}
            onActive={setActiveRow}
            selection={{
              selected: new Set(selected.keys()),
              onToggle: toggleSelected,
              onToggleAll: () => toggleLane(ready),
              allLabel: `Choose all ${ready.length} ready to clear`,
              covers: isReady,
            }}
            status={{
              header: "Checks",
              text: statusText,
              cell: (c) => (
                <span className={isReady(c) ? "text-positive" : "text-caution"}>{statusText(c)}</span>
              ),
            }}
            action={(c) =>
              isReady(c) ? (
                <>
                  <Button kind="primary" size="sm" onClick={() => setDialog({ kind: "clear", rows: [c] })}>
                    Clear
                  </Button>
                  <Button kind="quiet" size="sm" asChild>
                    <Link to={href(c)}>Review</Link>
                  </Button>
                </>
              ) : (
                <Button kind="default" size="sm" asChild>
                  <Link to={href(c)}>Review</Link>
                </Button>
              )
            }
            empty={
              all.length > 0
                ? {
                    icon: Inbox,
                    title: "No claim matches these filters",
                    message: `${all.length} are waiting in all.`,
                    action: (
                      <Button kind="default" onClick={clear}>
                        Show all {all.length}
                      </Button>
                    ),
                  }
                : {
                    icon: Inbox,
                    guide: "clear-a-claim",
                    title: "Nothing is waiting",
                    message: "Every submitted claim has been checked.",
                    action: (
                      <Button kind="default" asChild>
                        <Link to="/track">See where claims are</Link>
                      </Button>
                    ),
                  }
            }
          />
          {rows.length > 0 && (
            <p className="text-sm text-fg-muted">
              Numbers that start with ERP were brought across from the old ERP workbook. They have no filing date of their own.
            </p>
          )}
          <OwnPapersNote />
          {readyTotal > 0 && ready.length > 0 && <span className="sr-only">{ready.length} ready, {money(readyTotal)}</span>}
        </>
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
  return <kbd className="rounded border border-edge px-1 text-xs">{children}</kbd>
}
