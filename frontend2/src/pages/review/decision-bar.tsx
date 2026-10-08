import { Link } from "react-router-dom"
import { Ellipsis, Flag, Info } from "lucide-react"

import { useApiMutation } from "@/lib/query"
import { cn } from "@/lib/cn"
import { Button } from "@/ui/button"
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/ui/menu"
import { money, stageOf } from "@/ui/paper"
import { toast } from "@/ui/toast"

import { decisionKeys } from "./decisions"
import { LEGACY_STATUSES } from "./more-dialogs"
import type { QueueName, WorkspaceClaim } from "./types"

/** Every dialog the bar can open. The workspace owns the state so the
 *  keyboard (c, s, h) and the buttons open the very same dialog. */
export type DecisionDialog =
  | "clear"
  | "approve"
  | "sendback"
  | "hold"
  | "reject"
  | "flag"
  | "verify"
  | "second"
  | "override"
  | "edit"

const QUEUE_PAGE: Record<QueueName, { to: string; label: string }> = {
  clearing: { to: "/clearing", label: "Clearing queue" },
  approvals: { to: "/approvals", label: "Approvals" },
  authorisations: { to: "/authorisations", label: "Authorisations" },
}

/**
 * The bar along the bottom of the workspace: always in view, whatever is
 * scrolled, because a decision made from a screen where the buttons have
 * scrolled away is a decision made without looking.
 *
 * It offers what this account may do with this claim right now and nothing
 * else. On the reviewer's own claim there is no bar at all, only the reason:
 * a greyed-out button reads as a fault, and the reason is the useful part.
 */
export function DecisionBar({
  claim,
  own,
  canClear,
  canApprove = false,
  isSuperAdmin,
  queue,
  open,
}: {
  claim: WorkspaceClaim
  own: boolean
  /** The account sits at the research cell's desk (or is a super admin). */
  canClear: boolean
  /** The account is the Principal (or a super admin standing in): it approves cleared claims. */
  canApprove?: boolean
  isSuperAdmin: boolean
  queue: QueueName
  open: (d: DecisionDialog) => void
}) {
  const resume = useApiMutation<Record<string, never>, unknown>(`/api/claims/${claim.id}/resume`, {
    invalidates: decisionKeys(claim.id),
  })

  if (own) {
    return (
      <Bar>
        <p className="flex items-start gap-2 text-sm text-fg-muted" role="status">
          <Info className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span>
            <span className="font-medium text-fg">This is your own claim.</span> Nobody decides a claim they filed, so another officer
            at this desk has to review it.
          </span>
        </p>
      </Bar>
    )
  }

  // The Principal reads the evidence in order to decide, so she decides here:
  // a cleared claim at her desk gets Approve, Send back and Hold, in view
  // whatever is scrolled (docs/ux/27, T3). Never on her own claim: that case
  // returned above, and the server refuses it too.
  if (claim.status === "CLEARED" && canApprove) {
    const by = (claim as { cleared_by_name?: string | null }).cleared_by_name
    return (
      <Bar>
        <div className="flex flex-wrap items-center gap-2 max-lg:flex-nowrap">
          <Button kind="primary" onClick={() => open("approve")} aria-keyshortcuts="a" disabled={claim.remuneration == null || !!claim.calc_error}>
            Approve{claim.remuneration != null ? ` ${money(claim.remuneration)}` : ""}
            <Key>a</Key>
          </Button>
          <Button kind="danger" onClick={() => open("sendback")} aria-keyshortcuts="s">
            Send back
            <Key>s</Key>
          </Button>
          {claim.on_hold ? (
            <Button
              kind="default"
              disabled={resume.isPending}
              aria-keyshortcuts="h"
              onClick={() => resume.mutate({}, { onSuccess: () => toast.ok("Resumed"), onError: (err) => toast.fail(err) })}
            >
              {resume.isPending ? "Resuming…" : "Resume"}
              <Key>h</Key>
            </Button>
          ) : (
            <Button kind="default" onClick={() => open("hold")} aria-keyshortcuts="h">
              Hold
              <Key>h</Key>
            </Button>
          )}
        </div>
        {by && <p className="text-sm text-fg-muted max-lg:hidden">Cleared by {by}.</p>}
      </Bar>
    )
  }

  const atMyDesk = claim.status === "SUBMITTED" && canClear

  if (!atMyDesk) {
    const stage = stageOf(claim.status ?? "")
    const page = QUEUE_PAGE[queue]
    return (
      <Bar>
        <p className="flex items-start gap-2 text-sm text-fg-muted" role="status">
          <Info className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span>
            <span className="font-medium text-fg">{stage.label}.</span>{" "}
            {canClear
              ? "This claim has left the clearing desk, so there is nothing to decide here."
              : "Decisions at your desk are made from its list."}{" "}
            <Link to={page.to} className="text-accent underline-offset-2 hover:underline">
              Back to {page.label.toLowerCase()}
            </Link>
          </span>
        </p>
        {canClear && (
          <MoreMenu claim={claim} isSuperAdmin={isSuperAdmin} open={open} show={{ flag: true }} />
        )}
      </Bar>
    )
  }

  return (
    <Bar>
      <div className="flex flex-wrap items-center gap-2 max-lg:flex-nowrap">
        <Button kind="primary" onClick={() => open("clear")} aria-keyshortcuts="c">
          Clear
          <Key>c</Key>
        </Button>
        <Button kind="danger" onClick={() => open("sendback")} aria-keyshortcuts="s">
          Send back
          <Key>s</Key>
        </Button>
        {claim.on_hold ? (
          <Button
            kind="default"
            disabled={resume.isPending}
            aria-keyshortcuts="h"
            onClick={() =>
              resume.mutate(
                {},
                { onSuccess: () => toast.ok("Resumed"), onError: (err) => toast.fail(err) }
              )
            }
          >
            {resume.isPending ? "Resuming…" : "Resume"}
            <Key>h</Key>
          </Button>
        ) : (
          <Button kind="default" onClick={() => open("hold")} aria-keyshortcuts="h">
            Hold
            <Key>h</Key>
          </Button>
        )}
        <Button kind="danger" className="max-lg:hidden" onClick={() => open("reject")} title="Reject this claim outright. This is final.">
          Reject outright
        </Button>
        <Button kind="quiet" className="max-lg:hidden" onClick={() => open("flag")}>
          <Flag /> Flag
        </Button>
        <MoreMenu claim={claim} isSuperAdmin={isSuperAdmin} open={open} show={{ reject: true, flag: true, phoneOnly: true }} />
      </div>
    </Bar>
  )
}

function Bar({ children }: { children: React.ReactNode }) {
  return (
    <div
      className={cn(
        "z-30 flex shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-line bg-surface px-3 py-2.5",
        "shadow-under pb-[max(0.625rem,env(safe-area-inset-bottom))]"
      )}
      role="region"
      aria-label="Decision"
    >
      {children}
    </div>
  )
}

/**
 * A key hint on a button. Only where there is a keyboard to press it on.
 *
 * Hidden from the accessibility tree: the button already carries
 * `aria-keyshortcuts`, which is how a screen reader is told, and left in
 * the name the button reads "Clear c" -- not the verb the dialog and the
 * toast use (docs/ux/19 rule 1).
 */
function Key({ children }: { children: string }) {
  return (
    <kbd aria-hidden="true" className="ml-1 hidden rounded border border-current/25 px-1 text-xs leading-4 opacity-70 lg:inline">{children}</kbd>
  )
}

/**
 * The rest of what a desk can do to a claim: reject and flag on a phone,
 * where five buttons do not fit one row, and the tools that unstick a claim
 * on every screen. Nothing here is a routine decision.
 */
function MoreMenu({
  claim,
  isSuperAdmin,
  open,
  show,
}: {
  claim: WorkspaceClaim
  isSuperAdmin: boolean
  open: (d: DecisionDialog) => void
  show: { reject?: boolean; flag?: boolean; phoneOnly?: boolean }
}) {
  const active = claim.status === "SUBMITTED"
  const canVerify = active || claim.status === "CLEARED"
  const legacy = LEGACY_STATUSES.includes(claim.status ?? "")
  const second = !!claim.needs_second_approval
  const edit = isSuperAdmin
  const hasTools = canVerify || second || legacy || edit
  // On a wide screen reject and flag have buttons of their own; the menu
  // repeats them only where the buttons are hidden.
  const phoneOnly = show.phoneOnly ? "lg:hidden" : ""
  if (!hasTools && !show.reject && !show.flag) return null

  return (
    <Menu>
      <MenuTrigger asChild>
        <Button kind="quiet" size="icon" aria-label="More actions" className={cn(show.phoneOnly && !hasTools && "lg:hidden")}>
          <Ellipsis />
        </Button>
      </MenuTrigger>
      <MenuContent align="end" side="top" className="min-w-[14rem]">
        {show.reject && active && (
          <MenuItem danger className={phoneOnly} onSelect={() => open("reject")}>
            Reject outright
          </MenuItem>
        )}
        {show.flag && (
          <MenuItem className={phoneOnly} onSelect={() => open("flag")}>
            Flag
          </MenuItem>
        )}
        {(show.reject || show.flag) && hasTools && <MenuSeparator className={phoneOnly} />}
        {canVerify && <MenuItem onSelect={() => open("verify")}>Confirm figures</MenuItem>}
        {second && <MenuItem onSelect={() => open("second")}>Add second signature</MenuItem>}
        {legacy && <MenuItem onSelect={() => open("override")}>Move off a retired status</MenuItem>}
        {edit && <MenuItem onSelect={() => open("edit")}>Edit fields, with a reason</MenuItem>}
      </MenuContent>
    </Menu>
  )
}
