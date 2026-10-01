import { useQueryClient } from "@tanstack/react-query"

import { RaiseFlagDialog } from "@/pages/claim-review"
import { EditClaimFieldsDialog, ReasonActionDialog } from "@/ui/desk-actions"

import type { DecisionDialog } from "./decision-bar"
import { ClearDialog, HoldDialog, SendBackDialog } from "./decisions"
import { ManualVerifyDialog, OverrideStatusDialog, SecondSignatureDialog } from "./more-dialogs"
import type { WorkspaceClaim } from "./types"

/**
 * Every dialog the decision bar and the keys can open, in one place. The
 * workspace owns which one is open, so pressing c and clicking Clear open the
 * same dialog; this only draws them. Not rendered at all on the reviewer's own
 * claim: nobody decides it, and a dialog that cannot be opened is a dialog
 * that cannot be got wrong.
 */
export function DecisionDialogs({
  claim,
  dialog,
  setDialog,
  isSuperAdmin,
  sendBackReason,
  onDone,
}: {
  claim: WorkspaceClaim
  dialog: DecisionDialog | null
  setDialog: (d: DecisionDialog | null) => void
  isSuperAdmin: boolean
  /** What the send-back reason starts as, from the marks and checklist. */
  sendBackReason: string
  /** After a decision that ends the reviewer's part: open the next claim. */
  onDone: () => void
}) {
  const qc = useQueryClient()
  const control = (kind: DecisionDialog) => ({
    open: dialog === kind,
    onOpenChange: (o: boolean) => setDialog(o ? kind : null),
  })

  return (
    <>
      <ClearDialog claim={claim} {...control("clear")} isSuperAdmin={isSuperAdmin} onDone={onDone} />
      <SendBackDialog claim={claim} {...control("sendback")} prefill={sendBackReason} onDone={onDone} />
      <HoldDialog claim={claim} {...control("hold")} onDone={onDone} />
      <ReasonActionDialog
        claim={claim}
        {...control("reject")}
        onDone={onDone}
        path={`/api/claims/${claim.id}/reject-outright`}
        title="Reject this claim?"
        hint="Final: the claimant cannot edit or refile it, and sees this reason. To ask for a fix, send it back instead."
        confirmLabel="Reject"
        doneToast="Rejected"
      />
      <RaiseFlagDialog
        claimId={claim.id}
        open={dialog === "flag"}
        onClose={() => {
          setDialog(null)
          void qc.invalidateQueries({ queryKey: ["review-workspace", claim.id] })
        }}
      />
      <ManualVerifyDialog claim={claim} {...control("verify")} />
      <SecondSignatureDialog claim={claim} {...control("second")} />
      <OverrideStatusDialog claim={claim} {...control("override")} onDone={() => undefined} />
      {isSuperAdmin && (
        <EditClaimFieldsDialog
          claim={claim as unknown as Parameters<typeof EditClaimFieldsDialog>[0]["claim"]}
          {...control("edit")}
        />
      )}
    </>
  )
}
