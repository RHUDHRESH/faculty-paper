import { useMemo } from "react"

import type { Attachment } from "@/ui/attachments"
import { useMarks } from "@/ui/review-marks"
import type { ClaimantMark } from "./items"

/**
 * The reviewer's marks that are meant for this claimant, from the real marks
 * API (`useMarks`, docs/ux/21 section B).
 *
 * The server gives a claimant only the CLAIMANT marks that went back with a
 * send-back, signed "The college": no author, no desk. Marks are read only
 * while the claim is sent back (a draft has none, and the endpoint says so),
 * and each is joined to the claim's own attachment so the fix view can open
 * the file at the marked page. A mark that is resolved, or that the claimant
 * has already filed again ("fixed?"), is not something to fix, so it is
 * left out of the list here rather than in every reader.
 */
export function useClaimantMarks(
  claimId: string | undefined,
  sentBack: boolean,
  attachments: Attachment[] | undefined
): ClaimantMark[] {
  const { marks, sendBack } = useMarks(sentBack ? claimId : undefined)
  return useMemo(() => {
    const fromMarks: ClaimantMark[] = marks
        .filter((m) => m.audience === "CLAIMANT" && m.state === "open")
        .map((m) => {
          const file = m.upload_id ? attachments?.find((a) => a.id === m.upload_id) : undefined
          return {
            id: m.id,
            kind: m.kind,
            audience: m.audience,
            upload_id: m.upload_id,
            upload_url: file?.url ?? null,
            upload_name: m.upload_label ?? file?.filename ?? null,
            page: m.page,
            rect: m.rect,
            quoted_text: m.quote || null,
            checklist_key: m.checklist_key || null,
            body: m.body,
            resolved_in_resubmission: m.state !== "open",
          }
        })
    // A checklist item that failed goes back with the marks. One with no mark
    // of its own would otherwise be missing from the list, so it becomes an
    // item too: a reviewer's "Affiliation: not on the first page" is a thing
    // to fix as much as a rectangle on a page is.
    const covered = new Set(fromMarks.map((m) => m.checklist_key).filter(Boolean))
    const fromChecklist: ClaimantMark[] = (sendBack?.checklist ?? [])
      .filter((c) => c.status !== "ok" && !covered.has(c.key))
      .map((c) => ({
        id: `check-${c.key}`,
        kind: "ISSUE" as const,
        audience: "CLAIMANT" as const,
        checklist_key: c.key,
        body: c.note ? `${c.label}: ${c.note}` : `${c.label} needs another look.`,
      }))
    return [...fromMarks, ...fromChecklist]
  }, [marks, sendBack, attachments])
}
