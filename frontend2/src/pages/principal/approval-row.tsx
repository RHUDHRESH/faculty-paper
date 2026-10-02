import { useEffect, useRef } from "react"
import { Link, useNavigate } from "react-router-dom"

import { cn } from "@/lib/cn"
import { paperTitle } from "@/lib/names"
import { Button } from "@/ui/button"
import { ClaimNo } from "@/ui/claim-number"
import { Checkbox } from "@/ui/field"
import { money } from "@/ui/paper"
import { Avatar, initialsOf } from "@/ui/person"
import { waitingLabel, waitTitle, waitTone } from "@/ui/queue"
import type { QueueClaim } from "@/pages/approvals-actions"
import { notes, notReady } from "@/pages/principal/ready"

/**
 * One cleared claim, as the Principal reads it: the person leads (a face, a
 * name, a department), then the paper, then a quiet line of claim number,
 * journal and quartile. The amount and the wait are on the right in tabular
 * figures. A claim that needs her eyes says why in words, in the row, and its
 * button is "Review"; a ready claim's button is "Approve" and approves in
 * place, at the figure shown.
 *
 * The cursor is `bg-selected`, never a coloured stripe. The row is a link in
 * spirit: clicking anywhere on it opens the review, except on the controls.
 *
 * Her own claim is never drawn here (the server does not send it); and if one
 * ever came, it would have no Approve, because nobody decides what they filed.
 */
export function ApprovalRow({
  claim: c,
  href,
  ready,
  onApprove,
  onSendBack,
  me,
  compact,
  active,
  selected,
  onToggle,
  onActive,
}: {
  claim: QueueClaim
  href: string
  ready: boolean
  onApprove: () => void
  onSendBack?: () => void
  /** The reader's id: a claim of hers gets no button at all. */
  me?: string
  /** Home: no checkbox, no send back, no cursor. */
  compact?: boolean
  active?: boolean
  selected?: boolean
  onToggle?: () => void
  onActive?: () => void
}) {
  const navigate = useNavigate()
  const ref = useRef<HTMLLIElement>(null)
  useEffect(() => {
    if (active) ref.current?.scrollIntoView?.({ block: "nearest" })
  }, [active])

  const own = !!me && c.owner_id === me
  const days = c.waiting_days
  const late = (days ?? 0) > 14
  const hasAmount = c.remuneration != null && !c.calc_error
  const reasons = ready ? [] : notReady(c)
  const extra = notes(c)

  return (
    <li
      ref={ref}
      data-active={active || undefined}
      data-claim={c.ticket_number ?? undefined}
      onMouseEnter={onActive}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest("button, a, input, label, [role=checkbox]")) return
        navigate(href)
      }}
      className={cn(
        "flex cursor-pointer items-start gap-2 px-2 py-3.5 sm:gap-3 sm:px-3",
        active ? "bg-selected" : "hover:bg-hover"
      )}
    >
      {!compact && onToggle && (
        <label className="-my-1 grid size-10 shrink-0 cursor-pointer place-items-center max-sm:-ml-1" onClick={(e) => e.stopPropagation()}>
          <Checkbox checked={!!selected} onCheckedChange={onToggle} aria-label={`Choose ${c.ticket_number || c.paper_title}`} />
        </label>
      )}
      <Avatar
        person={{ name: c.owner_name, initials: c.owner_initials ?? initialsOf(c.owner_name), photo_url: c.owner_photo_url ?? null }}
        size="md"
      />

      <div className="min-w-0 flex-1">
        <p className="truncate text-sm">
          <span className="font-medium">{c.owner_name}</span>
          {c.owner_department && <span className="text-fg-muted"> · {c.owner_department}</span>}
        </p>
        <p className="line-clamp-2 text-base text-fg sm:line-clamp-1" title={c.paper_title}>
          {paperTitle(c.paper_title)}
        </p>
        <p className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 text-xs text-fg-muted sm:flex-nowrap">
          <ClaimNo value={c.ticket_number} className="text-xs" />
          {c.journal_title && <span className="min-w-0 max-w-[16rem] truncate">{c.journal_title}</span>}
          {c.quartile && <span className="shrink-0 rounded-sm bg-sunken px-1.5 font-medium text-fg">{c.quartile}</span>}
          {/* On a phone the figures sit here, under the paper. */}
          <span className="tabular sm:hidden">{hasAmount ? money(c.remuneration) : "No amount"}</span>
          <span className={cn("tabular sm:hidden", late && waitTone(days) + " font-medium")}>
            {waitingLabel(days)}
          </span>
        </p>
        {reasons.length > 0 && <p className="mt-1 text-sm text-caution">{reasons.join(" · ")}</p>}
        {!compact && extra.length > 0 && <p className="mt-0.5 text-sm text-fg-muted">{extra.join(" · ")}</p>}
        {/* Phone: the buttons sit under the text so each is a full-size target. */}
        {!own && (
          <div className="mt-2 flex gap-2 sm:hidden">
            {!compact && onSendBack && (
              <Button kind="quiet" size="sm" onClick={onSendBack}>
                Send back
              </Button>
            )}
            {ready && hasAmount ? (
              <Button size="sm" onClick={onApprove} aria-label={`Approve: ${paperTitle(c.paper_title)}`}>
                Approve
              </Button>
            ) : (
              <Button size="sm" asChild>
                <Link to={href}>Review</Link>
              </Button>
            )}
          </div>
        )}
      </div>

      <div className="hidden w-28 shrink-0 text-right sm:block">
        {hasAmount ? <p className="tabular text-base">{money(c.remuneration)}</p> : <p className="text-sm text-caution">No amount</p>}
      </div>
      <div className="hidden w-[4.5rem] shrink-0 text-right sm:block">
        <p className={cn("tabular text-sm", late ? waitTone(days) + " font-medium" : "text-fg-muted")} title={waitTitle(days)}>
          {waitingLabel(days)}
        </p>
      </div>
      <div className="hidden shrink-0 items-center gap-1 sm:flex">
        {!own && !compact && onSendBack && (
          <Button kind="quiet" size="sm" onClick={onSendBack}>
            Send back
          </Button>
        )}
        {!own &&
          (ready && hasAmount ? (
            <Button size="sm" onClick={onApprove} aria-label={`Approve: ${paperTitle(c.paper_title)}`}>
              Approve
            </Button>
          ) : (
            <Button size="sm" asChild>
              <Link to={href} tabIndex={-1}>
                Review
              </Link>
            </Button>
          ))}
      </div>
    </li>
  )
}
