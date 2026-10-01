import { useCallback, useEffect, useState } from "react"
import { Link, useNavigate, useSearchParams } from "react-router-dom"
import { Info } from "lucide-react"

import { cn } from "@/lib/cn"
import { CHAIN, useApiMutation } from "@/lib/query"
import { Button } from "@/ui/button"
import { ClaimNo } from "@/ui/claim-number"
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/ui/dialog"
import { Checkbox, Field, Input, Select, Textarea } from "@/ui/field"
import { paperTitle, unshout } from "@/lib/names"
import { money } from "@/ui/paper"
import { Avatar, initialsOf } from "@/ui/person"
import { stickyHeadCell, TableScroller } from "@/ui/table"
import { toast } from "@/ui/toast"
import { ColumnLabel, Meta } from "@/ui/text"

/**
 * The three desk queues (clearing, approvals, authorisations) share one dense
 * table, one bulk-action vocabulary and one way of remembering filters, so a
 * reviewer who learns one knows all three. A row opens the full-page review
 * (`/review/:id?queue=…`), never a side sheet.
 *
 * Money and flags are the caller's to withhold: `showAmount` and `flags` are
 * props because what a role may see is decided by the role, not the table.
 */

/* ------------------------------------------------------------------------ */
/* Waiting time                                                              */
/* ------------------------------------------------------------------------ */

/** Amber after two weeks, red after a month. */
export function waitTone(days: number | null | undefined): string {
  const d = days ?? 0
  return d > 30 ? "text-critical" : d > 14 ? "text-caution" : ""
}

export function waitTitle(days: number | null | undefined): string | undefined {
  const d = days ?? 0
  return d > 30 ? "Waiting more than a month" : d > 14 ? "Waiting more than two weeks" : undefined
}

export function waitingLabel(days: number | null | undefined): string {
  if (days == null) return "—"
  if (days <= 0) return "Today"
  if (days === 1) return "1 day"
  return `${days} days`
}

export function WaitingDays({ days, className }: { days: number | null | undefined; className?: string }) {
  const tone = waitTone(days)
  return (
    <span className={cn("tabular", tone && `font-medium ${tone}`, className)} title={waitTitle(days)}>
      {waitingLabel(days)}
    </span>
  )
}

export function QuartileTag({ q }: { q: string | null | undefined }) {
  if (!q) return null
  return <span className="ml-1 inline-block rounded-sm bg-sunken px-1.5 py-0.5 text-xs font-medium text-fg">{q}</span>
}

export function RowFlag({ tone, children }: { tone: "critical" | "caution"; children: React.ReactNode }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-xs font-medium",
        tone === "critical" ? "bg-critical-wash text-critical" : "bg-caution-wash text-caution"
      )}
    >
      {children}
    </span>
  )
}

/* ------------------------------------------------------------------------ */
/* Filters kept in the address                                               */
/* ------------------------------------------------------------------------ */

/**
 * Filters that live in the URL, so a saved link (or the browser's back button)
 * brings the same view back. Replaces rather than pushes: narrowing a queue is
 * not a place to come back to one keystroke at a time.
 */
export function useUrlFilters<K extends string>(keys: readonly K[]) {
  const [params, setParams] = useSearchParams()
  const values = Object.fromEntries(keys.map((k) => [k, params.get(k) ?? ""])) as Record<K, string>
  const set = useCallback(
    (patch: Partial<Record<K, string>>) =>
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev)
          for (const [k, v] of Object.entries(patch) as [string, string | undefined][]) {
            if (v) next.set(k, v)
            else next.delete(k)
          }
          next.delete("page")
          return next
        },
        { replace: true }
      ),
    [setParams]
  )
  const active = keys.some((k) => values[k] !== "")
  const clear = useCallback(() => set(Object.fromEntries(keys.map((k) => [k, ""])) as Partial<Record<K, string>>), [keys, set])
  return { values, set, clear, active }
}

/** The search box: instant to type in, and the address catches up when typing pauses. */
export const SearchBox = ({
  value,
  onCommit,
  inputRef,
  placeholder,
  label,
  className,
  inputMode,
}: {
  value: string
  onCommit: (next: string) => void
  inputRef?: React.Ref<HTMLInputElement>
  placeholder: string
  label: string
  className?: string
  inputMode?: "numeric" | "text"
}) => {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  useEffect(() => {
    if (draft === value) return
    const t = window.setTimeout(() => onCommit(draft), 200)
    return () => window.clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft])
  return (
    <Input
      ref={inputRef}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      placeholder={placeholder}
      aria-label={label}
      inputMode={inputMode}
      className={cn("w-full sm:w-72", className)}
    />
  )
}

/** A plain select in the queue's quiet row. */
export function QuietSelect({
  value,
  onChange,
  label,
  children,
}: {
  value: string
  onChange: (v: string) => void
  label: string
  children: React.ReactNode
}) {
  return (
    <Select value={value} onChange={(e) => onChange(e.target.value)} aria-label={label} className="w-auto max-sm:w-full">
      {children}
    </Select>
  )
}

export type QueueName = "clearing" | "approvals" | "authorisations"

/**
 * Where a row opens: the full-page review, told which queue it came from and
 * which filters were on, so its rail lists the same claims in the same order.
 */
export function reviewLink(id: string, queue: QueueName, filters?: URLSearchParams | string): string {
  const qs = new URLSearchParams({ queue })
  const f = typeof filters === "string" ? filters : filters?.toString()
  if (f) qs.set("filter", f)
  return `/review/${id}?${qs.toString()}`
}

/* ------------------------------------------------------------------------ */
/* The table                                                                 */
/* ------------------------------------------------------------------------ */

export type QueueRow = {
  id: string
  ticket_number: string | null
  paper_title: string
  journal_title: string | null
  quartile?: string | null
  owner_name: string
  owner_department?: string | null
  owner_photo_url?: string | null
  owner_initials?: string | null
  remuneration: number | null
  waiting_days: number | null
  calc_error?: string | null
}


function face(r: QueueRow) {
  return { name: r.owner_name, initials: r.owner_initials || initialsOf(r.owner_name), photo_url: r.owner_photo_url ?? null }
}

/** The checkbox's name: a bare "Select" is what forty identical boxes sound like. */
export function selectLabel(r: QueueRow): string {
  const title = r.paper_title || "this claim"
  return r.ticket_number ? `Select ${title}, ${r.ticket_number}` : `Select ${title}`
}

const INTERACTIVE = "a, button, input, select, textarea, label, [role='checkbox'], [role='button']"

export function QueueTable<T extends QueueRow>({
  rows,
  reviewHref,
  showAmount,
  flags,
  extra,
  select,
  active = -1,
  onActive,
  minWidth = "52rem",
  label,
  disableSelect,
}: {
  rows: T[]
  /** Where a row opens: `/review/<id>?queue=…`. */
  reviewHref: (row: T) => string
  /** Money is shown only to roles that may see it. */
  showAmount: boolean
  /** Present only for roles that may see flags; absent, the column is not drawn. */
  flags?: (row: T) => React.ReactNode
  extra?: { header: string; className?: string; cell: (row: T) => React.ReactNode }
  select?: {
    selected: ReadonlySet<string>
    onToggle: (row: T) => void
    onToggleAll: () => void
    disabled?: (row: T) => boolean
  }
  active?: number
  onActive?: (i: number) => void
  minWidth?: string
  label: string
  disableSelect?: boolean
}) {
  const navigate = useNavigate()
  const canSelect = !!select && !disableSelect
  const allSelected = !!select && rows.length > 0 && rows.every((r) => select.selected.has(r.id))
  const someSelected = !!select && rows.some((r) => select.selected.has(r.id))
  const master: boolean | "indeterminate" = allSelected ? true : someSelected ? "indeterminate" : false

  return (
    <>
      {/* Below `md` the same rows are stacked as cards: this many columns do
          not fit 390px, and a queue that can only be read by dragging it
          sideways is one nobody works on a phone. */}
      <div className="space-y-2 md:hidden">
        {canSelect && (
          <Checkbox
            checked={master}
            onCheckedChange={() => select.onToggleAll()}
            label={allSelected ? "Deselect all shown" : "Select all shown"}
          />
        )}
        <ul className="divide-y divide-line border-y border-line" aria-label={label}>
          {rows.map((r) => {
            const on = !!select?.selected.has(r.id)
            return (
              <li key={r.id} className={cn("row flex items-start gap-3 px-1 py-3", on && "bg-selected")}>
                {canSelect && (
                  <span className="pt-1">
                    <Checkbox
                      checked={on}
                      disabled={select.disabled?.(r)}
                      onCheckedChange={() => select.onToggle(r)}
                      aria-label={selectLabel(r)}
                    />
                  </span>
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <ClaimNo value={r.ticket_number} />
                      <Link
                        to={reviewHref(r)}
                        className="mt-0.5 block break-words text-base underline-offset-2 hover:underline"
                      >
                        {paperTitle(r.paper_title)}
                      </Link>
                      <span className="mt-1 flex items-center gap-2">
                        <Avatar person={face(r)} size="xs" />
                        <Meta className="min-w-0 break-words">{r.owner_name}</Meta>
                      </span>
                      {r.journal_title && (
                        <Meta className="block break-words">
                          {unshout(r.journal_title)}
                          <QuartileTag q={r.quartile} />
                        </Meta>
                      )}
                    </div>
                    <div className="shrink-0 text-right">
                      {showAmount &&
                        (r.calc_error ? (
                          <span className="text-xs text-critical">No amount</span>
                        ) : (
                          <span className="block text-base tabular">{money(r.remuneration)}</span>
                        ))}
                      <WaitingDays days={r.waiting_days} className="block text-xs" />
                    </div>
                  </div>
                  {flags && <div className="mt-1.5 flex flex-wrap items-center gap-1.5 empty:hidden">{flags(r)}</div>}
                  {extra && <div className="mt-1 text-xs text-fg-muted">{extra.cell(r)}</div>}
                </div>
              </li>
            )
          })}
        </ul>
      </div>

      <TableScroller minWidth={minWidth} className="hidden md:block">
        <table className="w-full border-collapse text-sm" aria-label={label}>
          <thead>
            <tr>
              {canSelect && (
                <th scope="col" className={cn(stickyHeadCell, "w-9 px-2")}>
                  <Checkbox
                    checked={master}
                    onCheckedChange={() => select.onToggleAll()}
                    aria-label={allSelected ? "Deselect all" : "Select all"}
                  />
                </th>
              )}
              <th scope="col" className={cn(stickyHeadCell, "w-36")}>
                <ColumnLabel>Claim no.</ColumnLabel>
              </th>
              <th scope="col" className={cn(stickyHeadCell, "w-32")}>
                <ColumnLabel>Claimant</ColumnLabel>
              </th>
              <th scope="col" className={cn(stickyHeadCell, "min-w-[12rem]")}>
                <ColumnLabel>Paper</ColumnLabel>
              </th>
              <th scope="col" className={cn(stickyHeadCell, "w-32")}>
                <ColumnLabel>Journal</ColumnLabel>
              </th>
              <th scope="col" className={cn(stickyHeadCell, "w-[4.5rem] text-right")}>
                <ColumnLabel>Waiting</ColumnLabel>
              </th>
              {showAmount && (
                <th scope="col" className={cn(stickyHeadCell, "w-20 text-right")}>
                  <ColumnLabel>Amount</ColumnLabel>
                </th>
              )}
              {flags && (
                <th scope="col" className={cn(stickyHeadCell, "w-28")}>
                  <ColumnLabel>Flags</ColumnLabel>
                </th>
              )}
              {extra && (
                <th scope="col" className={cn(stickyHeadCell, extra.className)}>
                  <ColumnLabel>{extra.header}</ColumnLabel>
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const on = !!select?.selected.has(r.id)
              return (
                // No `aria-selected`: a `<tr>` in a plain table is not in a
                // grid, so the attribute would be dropped. The row's own
                // checkbox carries the selection to a screen reader.
                <tr
                  key={r.id}
                  onClick={(e) => {
                    if ((e.target as HTMLElement).closest(INTERACTIVE)) return
                    onActive?.(i)
                    navigate(reviewHref(r))
                  }}
                  className={cn(
                    "row cursor-pointer border-b border-line last:border-b-0",
                    i === active && "bg-hover",
                    on && "bg-selected"
                  )}
                >
                  {canSelect && (
                    <td className="px-2 py-2 align-top">
                      <Checkbox
                        checked={on}
                        disabled={select.disabled?.(r)}
                        onCheckedChange={() => select.onToggle(r)}
                        aria-label={selectLabel(r)}
                      />
                    </td>
                  )}
                  <td className="px-3 py-2 align-top">
                    <ClaimNo value={r.ticket_number} />
                  </td>
                  <td className="px-3 py-2 align-top">
                    <span className="flex items-start gap-2">
                      <Avatar person={face(r)} size="xs" />
                      <span className="min-w-0">
                        <span className="block truncate" title={r.owner_name}>
                          {r.owner_name}
                        </span>
                        {r.owner_department && (
                          <Meta className="block truncate text-xs" >{r.owner_department}</Meta>
                        )}
                      </span>
                    </span>
                  </td>
                  <td className="px-3 py-2 align-top">
                    <Link
                      to={reviewHref(r)}
                      className="line-clamp-2 break-words underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                    >
                      {paperTitle(r.paper_title)}
                    </Link>
                  </td>
                  <td className="px-3 py-2 align-top text-fg-muted">
                    <span className="line-clamp-2 break-words">{unshout(r.journal_title) || "No journal named"}</span>
                    <QuartileTag q={r.quartile} />
                  </td>
                  <td className="px-3 py-2 text-right align-top">
                    <WaitingDays days={r.waiting_days} />
                  </td>
                  {showAmount && (
                    <td className="px-3 py-2 text-right align-top">
                      {r.calc_error ? (
                        <span className="text-xs text-critical">No amount</span>
                      ) : (
                        <span className="tabular">{money(r.remuneration)}</span>
                      )}
                    </td>
                  )}
                  {flags && (
                    <td className="px-3 py-2 align-top">
                      <div className="flex flex-wrap gap-1">{flags(r)}</div>
                    </td>
                  )}
                  {extra && <td className={cn("px-3 py-2 align-top", extra.className)}>{extra.cell(r)}</td>}
                </tr>
              )
            })}
          </tbody>
        </table>
      </TableScroller>
    </>
  )
}

/* ------------------------------------------------------------------------ */
/* Bulk                                                                      */
/* ------------------------------------------------------------------------ */

/** Why the bar has no "Send back": said once, in the same words on every desk. */
export function NoBulkSendBack({ className }: { className?: string }) {
  return (
    <p className={cn("flex items-start gap-1.5 text-xs text-fg-muted", className)}>
      <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
      <span>
        Send back is one claim at a time, because each needs its own reason for the claimant. Open a claim to send it back.
      </span>
    </p>
  )
}

export type SummaryRow = Pick<QueueRow, "id" | "ticket_number" | "paper_title" | "owner_name" | "remuneration"> & {
  /** Something the reader should weigh before confirming, in plain words. */
  note?: string | null
}

/**
 * The last look before a batch goes: how many, how much, and what is being
 * left out or is worth a second look. The count and the total are the ones the
 * server will act on; the server still re-checks every claim as it goes.
 */
export function BulkSummaryDialog({
  open,
  onOpenChange,
  title,
  rows,
  showMoney,
  leftOut,
  confirmLabel,
  footnote,
  onConfirm,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  rows: SummaryRow[]
  showMoney: boolean
  /** Claims in view that are not part of this batch, grouped by reason. */
  leftOut?: { count: number; reasons: { label: string; count: number }[] }
  confirmLabel: string
  footnote?: string
  onConfirm: () => Promise<void> | void
}) {
  const [busy, setBusy] = useState(false)
  const total = rows.reduce((s, r) => s + (r.remuneration || 0), 0)
  const unpriced = rows.filter((r) => r.remuneration == null).length
  const noted = rows.filter((r) => r.note)
  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {rows.length} {rows.length === 1 ? "claim" : "claims"}
            {showMoney && (
              <>
                , <span className="tabular font-medium text-fg">{money(total)}</span> in all
                {unpriced > 0 && ` (${unpriced} without an amount)`}
              </>
            )}
            .
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          {noted.length > 0 && (
            <div className="rounded-md bg-caution-wash px-3 py-2 text-sm text-caution">
              <p className="font-medium">
                {noted.length} {noted.length === 1 ? "claim is" : "claims are"} worth a second look
              </p>
              <ul className="mt-1 space-y-0.5 text-fg">
                {noted.slice(0, 6).map((r) => (
                  <li key={r.id}>
                    <span className="tabular">{r.ticket_number || r.paper_title}</span>
                    <span className="text-fg-muted">: {r.note}</span>
                  </li>
                ))}
                {noted.length > 6 && <li className="text-fg-muted">and {noted.length - 6} more</li>}
              </ul>
            </div>
          )}
          <ul className="max-h-56 divide-y divide-line overflow-y-auto border-y border-line" aria-label="Claims in this batch">
            {rows.map((r) => (
              <li key={r.id} className="flex items-baseline justify-between gap-3 py-1.5 text-sm">
                <span className="min-w-0">
                  <span className="tabular">{r.ticket_number || "No claim no."}</span>
                  <span className="text-fg-muted"> · {r.owner_name}</span>
                </span>
                {showMoney && <span className="tabular shrink-0">{money(r.remuneration)}</span>}
              </li>
            ))}
          </ul>
          {leftOut && leftOut.count > 0 && (
            <div className="text-sm">
              <p className="font-medium">
                {leftOut.count} left out, because they are not ready
              </p>
              <ul className="mt-0.5 text-fg-muted">
                {leftOut.reasons.map((x) => (
                  <li key={x.label}>
                    {x.count} {x.label}
                  </li>
                ))}
              </ul>
              <p className="mt-0.5 text-xs text-fg-muted">A claim can be in more than one line. Open them from the queue.</p>
            </div>
          )}
          {footnote && <p className="text-xs text-fg-muted">{footnote}</p>}
        </DialogBody>
        <DialogFooter>
          <Button kind="quiet" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button
            kind="primary"
            disabled={busy || rows.length === 0}
            onClick={async () => {
              setBusy(true)
              try {
                await onConfirm()
                onOpenChange(false)
              } catch {
                // The caller has already told the reader what went wrong.
              } finally {
                setBusy(false)
              }
            }}
          >
            {busy ? "Working…" : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export type BulkHoldResult = { held: number; held_ids: string[]; skipped: { id: string; reason: string }[] }

/** Hold a batch with one reason. Bulk hold is allowed; bulk send back is not. */
export function BulkHoldDialog({
  open,
  onOpenChange,
  rows,
  onDone,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  rows: SummaryRow[]
  onDone: (result: BulkHoldResult) => void
}) {
  const [reason, setReason] = useState("")
  const hold = useApiMutation<{ claim_ids: string[]; reason: string }, BulkHoldResult>("/api/desk/bulk-hold", {
    invalidates: [...CHAIN],
  })
  useEffect(() => {
    if (open) setReason("")
  }, [open])
  const trimmed = reason.trim()
  const short = trimmed.length > 0 && trimmed.length < 10

  async function submit() {
    try {
      const result = await hold.mutateAsync({ claim_ids: rows.map((r) => r.id), reason: trimmed })
      if (result.skipped.length === 0) toast.ok(`On hold. ${result.held} ${result.held === 1 ? "claim" : "claims"} paused`)
      onOpenChange(false)
      onDone(result)
    } catch (err) {
      toast.fail(err)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>
            Put {rows.length} {rows.length === 1 ? "claim" : "claims"} on hold?
          </DialogTitle>
          <DialogDescription>
            They stay at this desk until someone resumes them. The claimants are told they are on hold, not why.
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <Field label="Reason" hint="Kept for the desk. One reason covers the whole batch." error={short ? "At least 10 characters." : undefined}>
            <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} placeholder="Why these are paused" />
          </Field>
        </DialogBody>
        <DialogFooter>
          <Button kind="quiet" onClick={() => onOpenChange(false)} disabled={hold.isPending}>
            Cancel
          </Button>
          <Button kind="primary" disabled={trimmed.length < 10 || hold.isPending} onClick={() => void submit()}>
            {hold.isPending ? "Working…" : `Put ${rows.length} on hold`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** Every skip named, not just a count. */
export function SkippedDialog({
  title,
  description,
  skipped,
  lookup,
  onClose,
}: {
  title: string
  description: string
  skipped: { id: string; reason: string }[]
  lookup: ReadonlyMap<string, { ticket_number: string | null; paper_title: string }>
  onClose: () => void
}) {
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {skipped.length > 0 && (
          <DialogBody>
            <ul className="space-y-3">
              {skipped.map((s) => {
                const claim = lookup.get(s.id)
                return (
                  <li key={s.id} className="text-sm">
                    <p className="font-medium">{claim?.ticket_number || claim?.paper_title || s.id}</p>
                    <p className="text-fg-muted">{s.reason}</p>
                  </li>
                )
              })}
            </ul>
          </DialogBody>
        )}
        <DialogFooter>
          <Button kind="primary" onClick={onClose}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
