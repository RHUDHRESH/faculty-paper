import { useMemo, useState } from "react"
import { Link } from "react-router-dom"
import { Info, Stamp } from "lucide-react"

import { cn } from "@/lib/cn"
import { AuthoriseDialog, SendBackDialog, thresholdClause } from "@/pages/authorise-dialogs"
import { BudgetStrip, budgetLine } from "@/pages/budget-strip"
import { useBudgetNow } from "@/pages/pay-parts"
import { Button } from "@/ui/button"
import { money, stageOf } from "@/ui/paper"
import { useQueueKeys } from "@/ui/queue-keys"

import type { WorkspaceClaim } from "./types"

/**
 * The Director's decision bar in the review workspace (docs/ux/28, target T3).
 *
 * The workspace's bar is the research cell's. A Director who opened a claim
 * from a notification used to read "Decisions at your desk are made from its
 * list" and had to go back to act. This bar is the Director's desk where the
 * evidence is: **Authorise** (primary, key `a`), the budget effect in the same
 * bar, and for a super admin standing in only, **Send back** (key `s`), which
 * returns the claim to the Principal with a reason. There is no flag, no hold
 * and no reject here: the Director is contest-blind and the chain past the
 * Principal is forward-only.
 *
 * On the reader's own claim there is no bar, only the reason: nobody decides
 * a claim they filed.
 */
export function AuthoriseBar({
  claim,
  own,
  isSuperAdmin,
  onDone,
}: {
  claim: WorkspaceClaim
  own: boolean
  isSuperAdmin: boolean
  /** After a decision: the workspace opens the next claim. */
  onDone: () => void
}) {
  const budget = useBudgetNow()
  const [dialog, setDialog] = useState<"authorise" | "sendback" | null>(null)
  const ready = !own && claim.status === "PRINCIPAL_APPROVED" && claim.remuneration != null && !claim.calc_error

  const keys = useMemo<Record<string, () => void>>(
    () => ({
      a: () => ready && setDialog("authorise"),
      s: () => ready && isSuperAdmin && setDialog("sendback"),
    }),
    [ready, isSuperAdmin]
  )
  useQueueKeys(keys, true)

  if (own) {
    return (
      <Bar>
        <p className="flex items-start gap-2 text-sm text-fg-muted" role="status">
          <Info className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span>
            <span className="font-medium text-fg">This is your own claim.</span> Another officer decides it.
          </span>
        </p>
      </Bar>
    )
  }

  if (claim.status !== "PRINCIPAL_APPROVED") {
    const stage = stageOf(claim.status ?? "")
    return (
      <Bar>
        <p className="flex items-start gap-2 text-sm text-fg-muted" role="status">
          <Info className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span>
            <span className="font-medium text-fg">{stage.label}.</span> There is nothing for you to authorise on this claim.
          </span>
        </p>
        <Button kind="default" asChild>
          <Link to="/authorisations">Back to authorisations</Link>
        </Button>
      </Bar>
    )
  }

  const held = thresholdClause(claim)
  const target = {
    id: claim.id,
    ticket_number: claim.ticket_number,
    paper_title: claim.paper_title,
    owner_name: claim.owner_name,
    owner_department: claim.owner_department,
    owner_photo_url: claim.owner_photo_url ?? null,
    remuneration: claim.remuneration,
    principal_approved_by_name: (claim as { principal_approved_by_name?: string | null }).principal_approved_by_name ?? null,
    principal_approved_at: (claim as { principal_approved_at?: string | null }).principal_approved_at ?? null,
    threshold_absorbed: claim.threshold_absorbed,
    threshold_full_amount: claim.threshold_full_amount,
  }

  return (
    <>
      <Bar>
        <div className="flex flex-wrap items-center gap-2 max-lg:flex-nowrap">
          <Button kind="primary" disabled={!ready} onClick={() => setDialog("authorise")} aria-keyshortcuts="a">
            <Stamp />
            {ready ? `Authorise ${money(claim.remuneration)}` : "Authorise"}
            <Key>a</Key>
          </Button>
          {isSuperAdmin && (
            <Button kind="danger" onClick={() => setDialog("sendback")} aria-keyshortcuts="s">
              Send back
              <Key>s</Key>
            </Button>
          )}
        </div>
        <div className="min-w-0 flex-1 basis-64 space-y-1.5 max-md:basis-full">
          <p className="truncate text-sm text-fg-muted" data-testid="bar-budget-line">
            {claim.calc_error
              ? "The amount could not be worked out, so this cannot be authorised yet."
              : held
                ? `${held}. ${budgetLine(budget.data, "authorising", false) ?? ""}`
                : (budgetLine(budget.data, "authorising", false) ?? " ")}
          </p>
          <BudgetStrip budget={budget.data?.college} batch={claim.remuneration ?? 0} batchLabel="This claim" compact />
        </div>
      </Bar>
      {dialog === "authorise" && <AuthoriseDialog claim={target} onClose={() => setDialog(null)} onDone={onDone} />}
      {dialog === "sendback" && (
        <SendBackDialog claim={target} onClose={() => setDialog(null)} onDone={onDone} />
      )}
    </>
  )
}

function Bar({ children }: { children: React.ReactNode }) {
  return (
    <div
      className={cn(
        "z-30 flex shrink-0 flex-wrap items-center justify-between gap-x-5 gap-y-2 border-t border-line bg-surface px-3 py-2.5",
        "shadow-under pb-[max(0.625rem,env(safe-area-inset-bottom))]"
      )}
      role="region"
      aria-label="Decision"
    >
      {children}
    </div>
  )
}

function Key({ children }: { children: string }) {
  return (
    <kbd aria-hidden="true" className="ml-1 hidden rounded border border-current/25 px-1 text-[10px] leading-4 opacity-70 lg:inline">
      {children}
    </kbd>
  )
}
