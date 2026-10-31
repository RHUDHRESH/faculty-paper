import { useEffect, useRef } from "react"
import { Link } from "react-router-dom"

import { cn } from "@/lib/cn"
import { amountUnrecorded, NOT_RECORDED, NOT_RECORDED_TITLE } from "@/lib/amount"
import { paperTitle, unshout } from "@/lib/names"
import { ClaimNo } from "@/ui/claim-number"
import { Checkbox } from "@/ui/field"
import { money } from "@/ui/paper"
import { Avatar, initialsOf } from "@/ui/person"
import { waitingLabel, waitTitle, waitTone } from "@/ui/queue"
import type { EmptyStateProps } from "@/ui/state"
import { Table, type Column } from "@/ui/table"

/**
 * The one table every claim desk works from: clearing, approvals and
 * authorisations. A desk is the same job three times: read the claim, then do
 * the one thing the desk does to it. So the columns are the same, the action is
 * the last cell of the row, and the keyboard cursor is the same.
 *
 * The cursor (`active`) is a row tint, never a stripe: `data-active` sits in the
 * paper cell and the wrapper tints the row that holds it. The pointer moves the
 * cursor too, as it did on the old lanes.
 */

export type DeskClaim = {
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
  remuneration_is_estimate?: boolean
}

export type DeskSelection<T> = {
  selected: ReadonlySet<string>
  onToggle: (row: T) => void
  onToggleAll: () => void
  /** A row that cannot be chosen (a claim with no amount at the authorising desk). */
  canSelect?: (row: T) => boolean
  /** What the heading box says: "Choose all 4 ready claims". */
  allLabel: string
  /** Which rows the heading box covers. Defaults to every row shown. */
  covers?: (row: T) => boolean
}

/** Follows the keyboard cursor; never on first paint, so a phone does not jump. */
function Cursor({ active, onActive, children }: { active: boolean; onActive?: () => void; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  const mounted = useRef(false)
  useEffect(() => {
    if (mounted.current && active) ref.current?.scrollIntoView?.({ block: "nearest" })
    mounted.current = true
  }, [active])
  return (
    <div ref={ref} data-active={active || undefined} onMouseEnter={onActive} className="min-w-0">
      {children}
    </div>
  )
}

export function waitCell(days: number | null | undefined) {
  const tone = waitTone(days)
  return (
    <span className="block">
      <span className={cn("tabular", tone && `font-medium ${tone}`)} title={waitTitle(days)}>
        {waitingLabel(days)}
      </span>
      {tone && <span className={cn("block text-sm", tone)}>Late</span>}
    </span>
  )
}

export function DeskTable<T extends DeskClaim>({
  rows,
  href,
  id,
  title,
  caption,
  selection,
  active = -1,
  onActive,
  showAmount = true,
  extra,
  status,
  action,
  actionLabel = "Next step",
  empty,
}: {
  rows: T[]
  /** Where a claim opens: `/review/<id>?queue=...`. */
  href: (row: T) => string
  /** Keys the saved columns and names the exported file. */
  id: string
  title: string
  caption: string
  selection?: DeskSelection<T>
  active?: number
  onActive?: (i: number) => void
  /** Money is shown only to a role that may see it. */
  showAmount?: boolean
  /** Columns specific to one desk, placed before the status ("Approved on"). */
  extra?: Column<T>[]
  /** The column that says whether the claim can go on, and if not, why. */
  status?: { header: string; text: (row: T) => string; cell: (row: T) => React.ReactNode }
  /** The last cell of the row: the one thing this desk does. */
  action: (row: T) => React.ReactNode
  actionLabel?: string
  empty: EmptyStateProps
}) {
  const columns: Column<T>[] = []

  if (selection) {
    const sel = selection
    const pool = rows.filter((r) => (sel.canSelect ? sel.canSelect(r) : true) && (sel.covers ? sel.covers(r) : true))
    const all = pool.length > 0 && pool.every((r) => sel.selected.has(r.id))
    const some = pool.some((r) => sel.selected.has(r.id))
    columns.push({
      key: "choose",
      header: (
        <Checkbox
          checked={all ? true : some ? "indeterminate" : false}
          disabled={pool.length === 0}
          onCheckedChange={() => sel.onToggleAll()}
          aria-label={sel.allLabel}
        />
      ),
      label: "Choose",
      className: "w-10",
      cell: (r) =>
        sel.canSelect && !sel.canSelect(r) ? (
          <span aria-hidden className="block size-4" />
        ) : (
          <Checkbox
            checked={sel.selected.has(r.id)}
            onCheckedChange={() => sel.onToggle(r)}
            aria-label={`Choose ${r.ticket_number || r.paper_title}`}
          />
        ),
    })
  }

  columns.push(
    {
      key: "claimant",
      header: "Claimant",
      exportValue: (r) => [r.owner_name, r.owner_department].filter(Boolean).join(", "),
      cell: (r) => (
        <span className="flex min-w-0 items-center gap-3">
          <Avatar
            person={{ name: r.owner_name, initials: r.owner_initials || initialsOf(r.owner_name), photo_url: r.owner_photo_url ?? null }}
            size="md"
          />
          <span className="min-w-0">
            <span className="block font-medium">{r.owner_name}</span>
            {r.owner_department && <span className="block text-fg-muted">{r.owner_department}</span>}
          </span>
        </span>
      ),
    },
    {
      key: "paper",
      header: "Paper",
      exportValue: (r) => paperTitle(r.paper_title),
      cell: (r) => {
        const i = rows.indexOf(r)
        return (
          <Cursor active={i === active} onActive={() => onActive?.(i)}>
            <Link to={href(r)} className="line-clamp-2 text-base leading-snug hover:text-accent" title={r.paper_title}>
              {paperTitle(r.paper_title)}
            </Link>
            {r.journal_title && (
              <span className="mt-0.5 line-clamp-1 block text-fg-muted">
                {unshout(r.journal_title)}
                {r.quartile && <span className="ml-2 rounded-sm bg-sunken px-1.5 font-medium text-fg">{r.quartile}</span>}
              </span>
            )}
          </Cursor>
        )
      },
    },
    {
      key: "claim_no",
      header: "Claim no.",
      exportValue: (r) => r.ticket_number,
      cell: (r) => (r.ticket_number ? <ClaimNo value={r.ticket_number} /> : null),
    },
    {
      key: "journal",
      header: "Journal",
      defaultHidden: true,
      exportValue: (r) => [unshout(r.journal_title), r.quartile].filter(Boolean).join(" "),
      cell: (r) =>
        r.journal_title ? (
          <span className="line-clamp-2">
            {unshout(r.journal_title)}
            {r.quartile ? ` (${r.quartile})` : ""}
          </span>
        ) : null,
    }
  )

  if (showAmount) {
    columns.push({
      key: "amount",
      header: "Amount",
      align: "right",
      exportKind: "money",
      exportValue: (r) => (r.calc_error ? null : r.remuneration),
      cell: (r) => {
        if (amountUnrecorded(r.remuneration, r.ticket_number))
          return (
            <span className="text-fg-muted" title={NOT_RECORDED_TITLE}>
              {NOT_RECORDED}
            </span>
          )
        if (r.calc_error || r.remuneration == null) return <span className="text-caution">No amount</span>
        return (
          <span>
            {money(r.remuneration)}
            {r.remuneration_is_estimate && <span className="block text-sm font-normal text-caution">Estimate</span>}
          </span>
        )
      },
    })
  }

  columns.push({
    key: "waiting",
    header: "Waiting",
    align: "right",
    exportValue: (r) => r.waiting_days,
    cell: (r) => waitCell(r.waiting_days),
  })

  if (extra) columns.push(...extra)

  if (status) {
    columns.push({
      key: "status",
      header: status.header,
      exportValue: status.text,
      cell: status.cell,
    })
  }

  columns.push({
    key: "action",
    header: <span className="sr-only">{actionLabel}</span>,
    label: actionLabel,
    cell: (r) => <div className="flex flex-wrap items-center justify-end gap-2">{action(r)}</div>,
  })

  return (
    <div className="[&_tr:has([data-active])]:bg-selected">
      <Table
        rows={rows}
        columns={columns}
        getKey={(r) => r.id}
        maxHeight="none"
        caption={caption}
        tools={{ id, title }}
        empty={empty}
      />
    </div>
  )
}
