import { useEffect, useState } from "react"
import { Link } from "react-router-dom"

import { cn } from "@/lib/cn"
import { useApiMutation } from "@/lib/query"
import { ClaimNo, staffStage } from "@/pages/cell/parts"
import { MIN_NOTE, type ClaimFlag } from "@/pages/claim-review"
import { Button } from "@/ui/button"
import { Checkbox, Field, Textarea } from "@/ui/field"
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/ui/dialog"
import { money } from "@/ui/paper"
import { Avatar, initialsOf } from "@/ui/person"
import { Meta } from "@/ui/text"
import { toast } from "@/ui/toast"
import { When } from "@/ui/when"
import { unshout } from "@/lib/names"

/** A flag as `/api/flags` sends it: the flag, what it asks, and the claim. */
export type FlagWithClaim = ClaimFlag & {
  rule: string
  headline: string
  claim: {
    id: string
    ticket_number: string | null
    origin?: string | null
    paper_title: string | null
    owner_name: string
    owner_photo_url?: string | null
    owner_department: string | null
    status: string
    remuneration: number | null
    paid_at: string | null
  }
}

export type FlagGroup = { rule: string; headline: string; open: number; open_on_paid: number }

function formatDate(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ""
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })
}

/** Who raised it, in words: a check is not a person and should not read as one. */
export function raisedByLine(f: ClaimFlag): string {
  if (f.source === "AUTO") return f.kind === "CONTENT_MISMATCH" ? "Raised by the file check" : "Raised by the import check"
  return f.raised_by_name ? `Raised by ${f.raised_by_name}` : "Raised by a reviewer"
}

const LONG_NOTE = 200

/**
 * One flag as a row: the claim and its claimant, the question and its detail,
 * where the claim stands, and the next action. An answered flag shows who
 * answered, when and what was found, so the history reads without a click.
 */
export function FlagLine({
  flag,
  selected,
  chosen,
  onChoose,
  onSelect,
  onResolve,
  same = false,
}: {
  flag: FlagWithClaim
  selected: boolean
  chosen: boolean
  onChoose: () => void
  onSelect: () => void
  onResolve: () => void
  /** The question and its note are the same as the row above: say so once
   *  instead of printing them again, as a ledger does ("do."). */
  same?: boolean
}) {
  const [more, setMore] = useState(false)
  const c = flag.claim
  const stage = staffStage(c.status)
  const long = flag.note.length > LONG_NOTE
  const paid = c.status === "PAID"
  return (
    <li
      aria-current={selected || undefined}
      onClick={onSelect}
      className={cn(
        "row grid grid-cols-[1.5rem_minmax(0,1fr)] gap-x-3 gap-y-2 py-3 sm:px-2",
        "lg:grid-cols-[1.5rem_minmax(0,16rem)_minmax(0,1fr)_11rem_6rem] lg:gap-x-5",
        selected && "bg-sunken/60",
        !flag.open && "text-fg-muted"
      )}
    >
      <div className="pt-0.5">
        {flag.open ? (
          <Checkbox checked={chosen} onCheckedChange={onChoose} aria-label={`Choose the flag on ${c.ticket_number ?? "this claim"}`} />
        ) : null}
      </div>

      <div className="flex min-w-0 items-start gap-2.5">
        <Avatar size="sm" person={{ name: c.owner_name, initials: initialsOf(c.owner_name), photo_url: c.owner_photo_url ?? null }} />
        <span className="min-w-0">
          <Link to={`/papers/${c.id}`} className="line-clamp-2 break-words text-sm font-medium text-fg underline-offset-4 hover:underline">
            {unshout(c.paper_title) || "Untitled paper"}
          </Link>
          <Meta className="block truncate">{[c.owner_name, c.owner_department].filter(Boolean).join(" · ") || "No department"}</Meta>
          <Meta className="block truncate">
            <ClaimNo ticket={c.ticket_number} origin={c.origin} />
          </Meta>
        </span>
      </div>

      <div className="col-start-2 min-w-0 lg:col-start-auto">
        {same && flag.open ? (
          <p className="text-sm text-fg-muted">Same question and answer as the row above.</p>
        ) : (
          <>
            <p className="text-base font-medium text-fg">{flag.headline}</p>
            <p className={cn("mt-0.5 text-sm text-pretty", !more && long && "line-clamp-2", flag.open ? "text-fg" : "text-fg-muted")}>{flag.note}</p>
          </>
        )}
        {long && !(same && flag.open) && (
          <button
            type="button"
            aria-expanded={more}
            onClick={(e) => {
              e.stopPropagation()
              setMore((m) => !m)
            }}
            className="mt-0.5 text-sm text-accent underline-offset-4 hover:underline"
          >
            {more ? "Show less" : "Show all"}
          </button>
        )}
        <Meta className="mt-1 block">
          {raisedByLine(flag)}
          {flag.raised_at && (
            <>
              {" · "}
              <When iso={flag.raised_at} />
            </>
          )}
          {" · "}
          <Link to={`/flags?claim=${c.id}&status=all`} className="underline-offset-4 hover:underline" onClick={(e) => e.stopPropagation()}>
            All flags on this claim
          </Link>
        </Meta>
        {!flag.open && (
          <div className="mt-2 rounded-md bg-sunken px-3 py-2 text-sm">
            <p className="text-fg-muted">
              Resolved{flag.resolved_by_name ? ` by ${flag.resolved_by_name}` : " by a check"}
              {flag.resolved_at ? (
                <>
                  {" · "}
                  <When iso={flag.resolved_at} />
                </>
              ) : null}
            </p>
            <p className="mt-0.5 text-fg">{flag.resolution_note || "No reason was recorded."}</p>
          </div>
        )}
      </div>

      <div className="col-start-2 min-w-0 text-sm lg:col-start-auto">
        <span className={cn("block", stage.tone === "done" ? "text-positive" : stage.tone === "attention" ? "text-critical" : "text-fg")}>
          {paid && c.paid_at ? `Paid on ${formatDate(c.paid_at)}` : stage.label}
        </span>
        {c.remuneration != null ? (
          <span className={cn("block tabular", flag.open && paid && (c.remuneration ?? 0) > 0 ? "font-medium text-critical" : "text-fg-muted")}>
            {money(c.remuneration)}
            {paid ? " paid" : " at stake"}
          </span>
        ) : (
          <span className="block text-fg-muted">No amount recorded</span>
        )}
      </div>

      <div className="col-start-2 lg:col-start-auto lg:text-right">
        {flag.open && (
          <Button
            kind="default"
            size="sm"
            onClick={(e) => {
              e.stopPropagation()
              onResolve()
            }}
            aria-label={`Resolve the flag on ${c.ticket_number ?? "this claim"}`}
          >
            Resolve
          </Button>
        )}
      </div>
    </li>
  )
}

/* ------------------------------------------------------------------------ */
/* Resolving one flag, or many with the same answer                          */
/* ------------------------------------------------------------------------ */

const REASONS: Record<string, string[]> = {
  "import:paid-zero": [
    "Checked the ERP accounts sheet: nothing was paid and that is right",
    "Checked the ERP accounts sheet: the amount was paid and is now corrected on the claim",
  ],
  "import:paid-rejected": [
    "Checked with Finance: it was paid, and the ERP status is wrong",
    "Checked with Finance: it was not paid, and the payment record is reversed",
  ],
  file: ["Opened the file by eye: it is the right paper", "Wrong file. Asked the claimant for the right one"],
}
const GENERIC_REASONS = ["Checked the record: the claim is correct", "Corrected on the claim"]

/**
 * "Resolve this flag" for one, "Resolve 12 flags" for a batch. The reason is
 * required (the next reader has only this to go on), kept with each flag and in
 * the audit log. Ready-made reasons fill the box and stay editable.
 */
export function ResolveDialog({ flags, onClose }: { flags: FlagWithClaim[]; onClose: () => void }) {
  const [note, setNote] = useState("")
  useEffect(() => {
    if (flags.length > 0) setNote("")
  }, [flags])

  const many = flags.length > 1
  const single = useApiMutation<{ note: string }, ClaimFlag>(() => `/api/flags/${flags[0]?.id}/resolve`, {
    invalidates: [["flags"], ["claim-review"], ["archive"], ["clearing-queue"]],
  })
  const batch = useApiMutation<
    { flag_ids: string[]; note: string },
    { resolved: number; skipped: { ticket_number: string | null; reason: string }[] }
  >("/api/flags/resolve-many", { invalidates: [["flags"], ["claim-review"], ["archive"], ["clearing-queue"]] })
  const pending = single.isPending || batch.isPending
  const trimmed = note.trim()
  const tooShort = trimmed.length > 0 && trimmed.length < MIN_NOTE
  const ready = trimmed.length >= MIN_NOTE && !pending

  const rules = new Set(flags.map((f) => f.rule))
  const presets = rules.size === 1 ? (REASONS[flags[0]?.rule ?? ""] ?? GENERIC_REASONS) : GENERIC_REASONS
  const onPaid = flags.filter((f) => f.claim.status === "PAID").length
  const total = flags.reduce((s, f) => s + (f.claim.remuneration ?? 0), 0)

  async function submit() {
    try {
      if (many) {
        const r = await batch.mutateAsync({ flag_ids: flags.map((f) => f.id), note: trimmed })
        toast.ok(`Resolved ${r.resolved} ${r.resolved === 1 ? "flag" : "flags"}.`)
        if (r.skipped.length > 0) {
          toast.fail(new Error(`${r.skipped.length} skipped. ${r.skipped[0].ticket_number ?? "A flag"}: ${r.skipped[0].reason}`))
        }
      } else {
        await single.mutateAsync({ note: trimmed })
        toast.ok("Resolved 1 flag.")
      }
      onClose()
    } catch (err) {
      toast.fail(err)
    }
  }

  const first = flags[0]
  return (
    <Dialog open={flags.length > 0} onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>{many ? `Resolve ${flags.length} flags?` : "Resolve this flag?"}</DialogTitle>
          <DialogDescription>
            {many
              ? `${flags.length} flags${rules.size === 1 ? ` asking: ${first.headline.toLowerCase()}` : ""}. ${onPaid} on claims already paid${total > 0 ? `, ${money(total)} in all` : ""}. The same reason is kept with each one.`
              : first
                ? `${first.headline}. ${first.claim.ticket_number ?? ""} ${unshout(first.claim.paper_title) || ""}`.trim()
                : ""}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-3">
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Ready-made reasons">
            {presets.map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => setNote(p)}
                className="rounded-full px-3 py-1 text-left text-sm text-fg-muted ring-1 ring-inset ring-line hover:text-fg max-sm:min-h-10"
              >
                {p}
              </button>
            ))}
          </div>
          <Field
            label="What was found"
            hint="Kept with the flag and in the audit log."
            error={tooShort ? `At least ${MIN_NOTE} characters.` : undefined}
          >
            <Textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={3}
              placeholder="Checked against the accounts sheet: the figure is right"
            />
          </Field>
        </DialogBody>
        <DialogFooter>
          <Button kind="quiet" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button kind="primary" disabled={!ready} onClick={() => void submit()}>
            {pending ? "Resolving…" : many ? `Resolve ${flags.length} flags` : "Resolve this flag"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
