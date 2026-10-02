import { useEffect, useRef } from "react"
import { Link, useNavigate } from "react-router-dom"

import { cn } from "@/lib/cn"
import { paperTitle } from "@/lib/names"
import { Button } from "@/ui/button"
import { ClaimNo } from "@/ui/claim-number"
import { Checkbox } from "@/ui/field"
import { money } from "@/ui/paper"
import { Avatar, initialsOf } from "@/ui/person"
import { waitingLabel, waitTone } from "@/ui/queue"
import { thresholdFlag } from "@/ui/research-threshold"
import type { QueueClaim } from "@/pages/clearing-actions"
import { isClean } from "@/pages/clearing-desk"

/**
 * The queue's rows, for the two lanes (docs/ux/26): the person leads, then
 * the paper, then a quiet line of claim number and journal, and in the lane
 * that needs a look, the reason in words. Numbers on the right are tabular.
 *
 * The cursor (`active`) is `bg-selected`, never a coloured stripe. A row is a
 * link in spirit: clicking anywhere on it opens the review, except on the
 * checkbox and the claim-number copy button, which do their own thing.
 */

/** Why a claim is not ready to clear, in words for the desk. Empty when it is ready. */
export function notReady(c: QueueClaim): string[] {
  const why: string[] = []
  if (c.on_hold) why.push("On hold")
  if (c.verification_ok === false) why.push("Checks failed")
  else if (c.verification_ok == null) why.push("Not checked yet")
  if (c.duplicate_warning) why.push("Possible duplicate")
  if (c.contest_forward) why.push("Contested by the claimant")
  if (c.journal_watch) why.push("Watched journal")
  if (c.affiliation_ok === false) why.push("Affiliation not confirmed")
  if (c.calc_error || c.remuneration == null) why.push("No amount")
  return why
}

/** All checks pass and nothing is watch-listed. */
export function isReady(c: QueueClaim): boolean {
  return !c.on_hold && isClean(c)
}

export function ClearingRow({
  claim: c,
  active,
  selected,
  onToggle,
  onActive,
  href,
  ready,
}: {
  claim: QueueClaim
  active: boolean
  selected: boolean
  onToggle: () => void
  onActive: () => void
  href: string
  ready: boolean
}) {
  const navigate = useNavigate()
  const ref = useRef<HTMLLIElement>(null)
  useEffect(() => {
    if (active) ref.current?.scrollIntoView?.({ block: "nearest" })
  }, [active])

  const reasons = ready ? [] : notReady(c)
  const extra = [thresholdFlag(c), c.owner_threshold_unset ? "Research faculty, threshold not set" : null].filter(Boolean) as string[]
  const days = c.waiting_days
  const late = (days ?? 0) > 14
  const hasAmount = c.remuneration != null && !c.calc_error

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
        "flex cursor-pointer items-start gap-2 px-2 py-3 sm:gap-3 sm:px-3",
        active ? "bg-selected" : "hover:bg-hover"
      )}
    >
      <label className="-my-1 grid size-10 shrink-0 cursor-pointer place-items-center max-sm:-ml-1" onClick={(e) => e.stopPropagation()}>
        <Checkbox checked={selected} onCheckedChange={onToggle} aria-label={`Choose ${c.ticket_number || c.paper_title}`} />
      </label>
      <Avatar person={{ name: c.owner_name, initials: initialsOf(c.owner_name), photo_url: c.owner_photo_url ?? null }} size="md" />

      <div className="min-w-0 flex-1">
        <p className="truncate text-sm">
          <span className="font-medium">{c.owner_name}</span>
          {c.owner_department && <span className="text-fg-muted"> · {c.owner_department}</span>}
        </p>
        <p className="line-clamp-2 text-base text-fg sm:line-clamp-1" title={c.paper_title}>
          {paperTitle(c.paper_title)}
        </p>
        <p className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 text-xs text-fg-muted">
          <ClaimNo value={c.ticket_number} className="text-xs" />
          {c.journal_title && <span className="max-w-[20rem] truncate">{c.journal_title}</span>}
          {c.quartile && <span className="rounded-sm bg-sunken px-1.5 font-medium text-fg">{c.quartile}</span>}
          {/* On a phone the figures sit here, under the paper. */}
          <span className="tabular sm:hidden">{hasAmount ? money(c.remuneration) : ""}</span>
          <span className={cn("tabular sm:hidden", late ? waitTone(days) + " font-medium" : "")}>
            {waitingLabel(days)}
            {late ? ", late" : ""}
          </span>
        </p>
        {(reasons.length > 0 || extra.length > 0) && (
          <p className="mt-1 text-sm text-caution">
            {[...reasons, ...extra].join(" · ")}
          </p>
        )}
      </div>

      <div className="hidden w-28 shrink-0 text-right sm:block">
        {hasAmount ? (
          <>
            <p className="tabular text-base">{money(c.remuneration)}</p>
            {c.remuneration_is_estimate && <p className="text-xs text-caution">Estimate</p>}
          </>
        ) : null}
      </div>
      <div className="hidden w-[4.5rem] shrink-0 text-right sm:block">
        <p className={cn("tabular text-sm", late ? waitTone(days) + " font-medium" : "text-fg-muted")}>{waitingLabel(days)}</p>
        {late && <p className={cn("text-xs", waitTone(days))}>Late</p>}
      </div>
      <div className="hidden shrink-0 sm:block">
        <Button asChild kind="quiet" size="sm">
          <Link to={href} tabIndex={-1}>
            Review
          </Link>
        </Button>
      </div>
    </li>
  )
}
