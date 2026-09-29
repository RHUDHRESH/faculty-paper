import { useEffect, useState } from "react"

import { useAuth } from "@/app/auth"
import { CHAIN, useApiMutation } from "@/lib/query"
import { Button } from "@/ui/button"
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/ui/dialog"
import { Field, Input, Textarea } from "@/ui/field"
import { toast } from "@/ui/toast"

/**
 * The desk actions every queue shares: hold / resume, and the reasoned
 * one-way moves (reject outright, send to the faculty member). The server
 * refuses anyone acting on their own claim; these controls hide themselves
 * in that case too, so the refusal is never the first thing a person sees.
 */

type DeskClaim = {
  id: string
  paper_title?: string | null
  ticket_number?: string | null
  owner_email?: string | null
  on_hold?: boolean | null
  hold_reason?: string | null
}

/** True when the signed-in person filed this claim. */
export function useIsOwnClaim(claim: { owner_email?: string | null }): boolean {
  const { me } = useAuth()
  return !!me && !!claim.owner_email && me.email.toLowerCase() === claim.owner_email.toLowerCase()
}

/** A reason dialog posting `{ [field]: reason }` to `path`. */
export function ReasonActionDialog({
  claim,
  open,
  onOpenChange,
  onDone,
  path,
  title,
  hint,
  confirmLabel,
  doneToast,
  field = "note",
  minChars = 10,
  tone = "danger",
}: {
  claim: DeskClaim
  open: boolean
  onOpenChange: (open: boolean) => void
  onDone?: () => void
  path: string
  title: string
  hint: string
  confirmLabel: string
  doneToast: string
  field?: "note" | "reason"
  minChars?: number
  tone?: "danger" | "primary" | "default"
}) {
  const [text, setText] = useState("")
  const run = useApiMutation<Record<string, string>, unknown>(path, {
    invalidates: [...CHAIN, ["claim", claim.id]],
  })
  useEffect(() => {
    if (open) setText("")
  }, [open])
  const trimmed = text.trim()
  const tooShort = trimmed.length > 0 && trimmed.length < minChars

  async function submit() {
    try {
      await run.mutateAsync({ [field]: trimmed })
      toast.ok(`${doneToast}${claim.ticket_number ? `. ${claim.ticket_number}` : ""}`)
      onOpenChange(false)
      onDone?.()
    } catch (err) {
      toast.fail(err)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{claim.paper_title}</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <Field label="Reason" hint={hint} error={tooShort ? `At least ${minChars} characters.` : undefined}>
            <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} />
          </Field>
        </DialogBody>
        <DialogFooter>
          <Button kind="quiet" onClick={() => onOpenChange(false)} disabled={run.isPending}>
            Cancel
          </Button>
          <Button
            kind={tone}
            disabled={trimmed.length < minChars || run.isPending}
            onClick={() => void submit()}
          >
            {run.isPending ? "Working…" : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** "Put on hold" (with a reason) or "Resume", depending on the claim. */
export function HoldControl({ claim, onDone }: { claim: DeskClaim; onDone?: () => void }) {
  const [open, setOpen] = useState(false)
  const own = useIsOwnClaim(claim)
  const resume = useApiMutation<Record<string, never>, unknown>(`/api/claims/${claim.id}/resume`, {
    invalidates: [...CHAIN, ["claim", claim.id]],
  })
  if (own) return null

  if (claim.on_hold) {
    return (
      <Button
        kind="default"
        disabled={resume.isPending}
        onClick={async () => {
          try {
            await resume.mutateAsync({})
            toast.ok("Resumed")
            onDone?.()
          } catch (err) {
            toast.fail(err)
          }
        }}
      >
        {resume.isPending ? "Resuming…" : "Resume"}
      </Button>
    )
  }
  return (
    <>
      <Button kind="quiet" onClick={() => setOpen(true)}>
        Put on hold
      </Button>
      <ReasonActionDialog
        claim={claim}
        open={open}
        onOpenChange={setOpen}
        onDone={onDone}
        path={`/api/claims/${claim.id}/hold`}
        field="reason"
        title="Put this claim on hold?"
        hint="It stays at this desk until someone resumes it. The claimant is told it is on hold."
        confirmLabel="Put on hold"
        doneToast="On hold"
        tone="default"
      />
    </>
  )
}

/** The hold banner shown at the top of a ticket that is paused. */
export function HoldNote({ claim }: { claim: DeskClaim }) {
  if (!claim.on_hold) return null
  return (
    <p role="status" className="rounded-md border border-line bg-surface px-3 py-2 text-sm">
      <span className="font-medium">On hold.</span> {claim.hold_reason}
    </p>
  )
}

/* ------------------------------------------------------------------------ */
/* Super admin: correct a claim's fields                                    */
/* ------------------------------------------------------------------------ */

const EDITABLE: { key: string; label: string }[] = [
  { key: "paper_title", label: "Paper title" },
  { key: "journal_title", label: "Journal" },
  { key: "doi", label: "DOI" },
  { key: "issn", label: "ISSN" },
  { key: "author_position", label: "Author position" },
  { key: "total_authors", label: "Total authors" },
  { key: "status_note", label: "Status note" },
  { key: "remuneration", label: "Settled amount (paid claims only)" },
]

export function EditClaimFieldsDialog({
  claim,
  open,
  onOpenChange,
}: {
  claim: DeskClaim & Record<string, unknown>
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [values, setValues] = useState<Record<string, string>>({})
  const [reason, setReason] = useState("")
  const save = useApiMutation<{ fields: Record<string, unknown>; reason: string }, { changed?: object }>(
    `/api/admin/claims/${claim.id}/edit`,
    { invalidates: [...CHAIN, ["claim", claim.id]] }
  )

  useEffect(() => {
    if (!open) return
    const v: Record<string, string> = {}
    for (const f of EDITABLE) v[f.key] = claim[f.key] == null ? "" : String(claim[f.key])
    setValues(v)
    setReason("")
  }, [open, claim])

  const changed: Record<string, unknown> = {}
  for (const f of EDITABLE) {
    const before = claim[f.key] == null ? "" : String(claim[f.key])
    if ((values[f.key] ?? "") !== before) changed[f.key] = values[f.key] === "" ? null : values[f.key]
  }
  const r = reason.trim()
  const ready = Object.keys(changed).length > 0 && r.length >= 10

  async function submit() {
    try {
      await save.mutateAsync({ fields: changed, reason: r })
      toast.ok("Saved, with the reason on the audit log")
      onOpenChange(false)
    } catch (err) {
      toast.fail(err)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit fields</DialogTitle>
          <DialogDescription>
            Every change is recorded with its before and after. Status, approvals and payment move only through
            their own actions.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-3">
          {EDITABLE.map((f) => (
            <Field key={f.key} label={f.label}>
              <Input
                value={values[f.key] ?? ""}
                onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
              />
            </Field>
          ))}
          <Field
            label="Reason"
            hint="Kept with the change (at least 10 characters)."
            error={r.length > 0 && r.length < 10 ? "At least 10 characters." : undefined}
          >
            <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} />
          </Field>
        </DialogBody>
        <DialogFooter>
          <Button kind="quiet" onClick={() => onOpenChange(false)} disabled={save.isPending}>
            Cancel
          </Button>
          <Button kind="primary" disabled={!ready || save.isPending} onClick={() => void submit()}>
            {save.isPending ? "Saving…" : "Save changes"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
