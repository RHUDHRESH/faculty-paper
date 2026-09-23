import { useEffect, useState } from "react"
import { Link } from "react-router-dom"
import { FileSearch, Flag as FlagIcon } from "lucide-react"

import { useQueryClient } from "@tanstack/react-query"

import { cn } from "@/lib/cn"
import { useApi, useApiMutation } from "@/lib/query"
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
import { Field, Radio, Textarea } from "@/ui/field"
import { Meta, SectionTitle } from "@/ui/text"
import { toast } from "@/ui/toast"
import { When } from "@/ui/when"

/**
 * Discrepancy flags and file checks, as the desks that judge a paper see
 * them -- the research cell, the coordinator, the Principal and the super
 * admin (`rbac.can_review_flags`). Everybody else is refused these endpoints
 * and has the keys stripped from every other payload, so nothing here is
 * ever rendered for them.
 *
 * The one thing every piece of copy below has to keep saying: a flag never
 * holds a claim back. It is a question on the record. Holding the money is
 * what a hold is for.
 */

/* ------------------------------------------------------------------------ */
/* Shapes -- `flag_to_dict` and `file_check_to_dict` in core/api/flags.py     */
/* ------------------------------------------------------------------------ */

export type FlagKind =
  | "CONTENT_MISMATCH"
  | "AMOUNT"
  | "AUTHOR"
  | "AFFILIATION"
  | "DUPLICATE"
  | "OTHER"

export type ClaimFlag = {
  id: string
  claim_id: string
  kind: FlagKind
  kind_label: string
  source: "AUTO" | "MANUAL"
  note: string
  open: boolean
  raised_by_name: string | null
  raised_at: string | null
  resolved_by_name: string | null
  resolved_at: string | null
  resolution_note: string | null
}

export type FileCheck = {
  id: string
  url: string
  kind: string
  filename: string | null
  outcome: "MATCHED" | "MISMATCH" | "NO_TEXT" | "UNREADABLE"
  outcome_label: string
  found: string[]
  missing: string[]
  score: number | null
  detail: string | null
  text_chars: number
  checked_at: string | null
}

export type ClaimReview = { flags: ClaimFlag[]; file_checks: FileCheck[] }

/** In the order a reviewer is likeliest to want them. */
export const FLAG_KINDS: { value: FlagKind; label: string; hint: string }[] = [
  { value: "AMOUNT", label: "Amount", hint: "What was or will be paid looks wrong" },
  { value: "CONTENT_MISMATCH", label: "The file does not match the claim", hint: "The attached paper is not the one claimed" },
  { value: "AUTHOR", label: "Author", hint: "The author list, the position, or whose paper it is" },
  { value: "AFFILIATION", label: "Affiliation", hint: "The college is missing from the paper or a reference" },
  { value: "DUPLICATE", label: "Possible duplicate", hint: "It looks like a paper already paid" },
  { value: "OTHER", label: "Something else", hint: "Say what in the note" },
]

export function kindLabel(kind: string): string {
  return FLAG_KINDS.find((k) => k.value === kind)?.label ?? kind.replace(/_/g, " ").toLowerCase()
}

/** The server refuses a shorter note (`MIN_NOTE` in core/api/flags.py). */
export const MIN_NOTE = 10

/** How often, and for how long, to look for a queued read's result. The
 *  worker polls its queue every 15 seconds, so a minute covers it. */
const RECHECK_POLL_MS = 5_000
const RECHECK_WAIT_MS = 60_000

/* ------------------------------------------------------------------------ */
/* What a file was found to say                                              */
/* ------------------------------------------------------------------------ */

const ITEM_LABEL: Record<string, string> = {
  title: "title",
  doi: "DOI",
  journal: "journal",
  claimant: "claimant's name",
  affiliation: "college affiliation",
  reference_title: "reference's title",
}

function sentenceList(items: string[]): string {
  const words = items.map((i) => ITEM_LABEL[i] ?? i)
  if (words.length <= 1) return words[0] ?? ""
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`
}

export type CheckTone = "positive" | "caution" | "critical" | "neutral"

/**
 * One line saying what a file was found to say, and how worried to be.
 *
 * Pure, so the wording is tested without a page: "Not found in the file:
 * title and DOI" is the sentence a reviewer acts on, and a regression that
 * turned it into "MISMATCH" would read as a status code rather than a reason.
 */
export function checkSummary(check: FileCheck | undefined): { tone: CheckTone; text: string } {
  if (!check) return { tone: "neutral", text: "Not read yet" }
  switch (check.outcome) {
    case "MATCHED":
      return {
        tone: "positive",
        text: check.score != null ? `Matches the claim · ${check.score}%` : "Matches the claim",
      }
    case "MISMATCH": {
      const blocking = check.kind === "PUBLISHED_PAPER"
        ? check.missing.filter((m) => m === "title" || m === "doi")
        : check.missing
      return { tone: "critical", text: `Not found in the file: ${sentenceList(blocking.length ? blocking : check.missing)}` }
    }
    case "NO_TEXT":
      return { tone: "caution", text: "No text to read — probably scanned. Check it by eye." }
    default:
      return { tone: "caution", text: "Could not open this file to read it" }
  }
}

const TONE_CLASS: Record<CheckTone, string> = {
  positive: "text-positive",
  caution: "text-caution",
  critical: "text-critical",
  neutral: "text-fg-subtle",
}

/**
 * The check, under the file it is about. Colour is the second signal only:
 * the sentence says whether it matched.
 */
export function FileCheckLine({
  check,
  readable,
}: {
  check: FileCheck | undefined
  /** One of our own uploaded PDFs, which is all the check can open. */
  readable: boolean
}) {
  if (!readable && !check) {
    return <p className="text-sm text-fg-subtle">Not read — only PDFs uploaded here are checked</p>
  }
  const { tone, text } = checkSummary(check)
  // Only a published paper has facts beyond the headline: for a cited
  // reference the headline already names everything that is missing.
  const also =
    check?.kind === "PUBLISHED_PAPER" && (check.outcome === "MISMATCH" || check.outcome === "MATCHED")
      ? check.missing.filter((m) => m !== "title" && m !== "doi")
      : []
  return (
    <p className="text-sm">
      <span className={cn("font-medium", TONE_CLASS[tone])}>{text}</span>
      {also.length > 0 && <span className="text-fg-muted"> · also missing: {sentenceList(also)}</span>}
    </p>
  )
}

/* ------------------------------------------------------------------------ */
/* One flag                                                                  */
/* ------------------------------------------------------------------------ */

/** Who raised it, in words: a check is not a person and should not read as one. */
export function raisedBy(flag: ClaimFlag): string {
  if (flag.source === "AUTO") {
    return flag.kind === "CONTENT_MISMATCH" ? "Raised by the file check" : "Raised by the import check"
  }
  return flag.raised_by_name ? `Raised by ${flag.raised_by_name}` : "Raised by a reviewer"
}

/**
 * One flag, open or answered. Shared by the claim page and the Flags queue
 * so the two cannot describe the same flag differently.
 */
export function FlagRow({
  flag,
  onResolve,
  claimLink,
}: {
  flag: ClaimFlag
  onResolve?: () => void
  /** The claim it is on, when the list is not already one claim's. */
  claimLink?: React.ReactNode
}) {
  return (
    <li className="space-y-2 py-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1 space-y-1">
          <p className="flex flex-wrap items-center gap-2">
            <span
              className={cn(
                "rounded-sm px-1.5 py-0.5 text-xs font-medium",
                flag.open ? "bg-caution-wash text-caution" : "bg-sunken text-fg-muted"
              )}
            >
              {flag.open ? "Open" : "Resolved"}
            </span>
            <span className="text-base font-medium">{kindLabel(flag.kind)}</span>
          </p>
          {claimLink}
        </div>
        {flag.open && onResolve && (
          <Button kind="default" size="sm" onClick={onResolve}>
            Resolve
          </Button>
        )}
      </div>
      <p className="text-pretty text-sm">{flag.note}</p>
      <Meta className="block">
        {raisedBy(flag)}
        {flag.raised_at ? (
          <>
            {" · "}
            <When iso={flag.raised_at} />
          </>
        ) : null}
      </Meta>
      {!flag.open && (
        <div className="well rounded-md px-3 py-2 text-sm">
          <p className="text-fg-muted">
            Resolved{flag.resolved_by_name ? ` by ${flag.resolved_by_name}` : ""}
            {flag.resolved_at ? (
              <>
                {" · "}
                <When iso={flag.resolved_at} />
              </>
            ) : null}
          </p>
          {flag.resolution_note && <p className="mt-1">{flag.resolution_note}</p>}
        </div>
      )}
    </li>
  )
}

/* ------------------------------------------------------------------------ */
/* Raising and resolving                                                     */
/* ------------------------------------------------------------------------ */

export function RaiseFlagDialog({
  claimId,
  open,
  onClose,
}: {
  claimId: string
  open: boolean
  onClose: () => void
}) {
  const [kind, setKind] = useState<FlagKind | "">("")
  const [note, setNote] = useState("")
  useEffect(() => {
    if (open) {
      setKind("")
      setNote("")
    }
  }, [open])

  const raise = useApiMutation<{ kind: FlagKind; note: string }, ClaimFlag>(
    `/api/claims/${claimId}/flags`,
    { invalidates: [["claim-review", claimId], ["flags"], ["archive"]] }
  )
  const trimmed = note.trim()
  const tooShort = trimmed.length > 0 && trimmed.length < MIN_NOTE
  const ready = kind !== "" && trimmed.length >= MIN_NOTE && !raise.isPending

  async function submit() {
    if (kind === "") return
    try {
      await raise.mutateAsync({ kind, note: trimmed })
      toast.ok(`Flag raised — ${kindLabel(kind).toLowerCase()}. The claim carries on as normal.`)
      onClose()
    } catch (err) {
      toast.fail(err)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>Raise a flag</DialogTitle>
          <DialogDescription>
            A flag is a question on the record. It does not hold the claim back: it goes on through
            the chain and can be paid, and the super admin is told if it is paid with the flag open.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          <fieldset className="space-y-2">
            <legend className="mb-1 text-sm font-medium">What kind of problem</legend>
            {FLAG_KINDS.map((k) => (
              <div key={k.value}>
                <Radio
                  name="flag-kind"
                  value={k.value}
                  checked={kind === k.value}
                  onChange={() => setKind(k.value)}
                  label={k.label}
                  hint={k.hint}
                />
              </div>
            ))}
          </fieldset>
          <Field
            label="What looks wrong"
            hint="The next reader has only this to go on."
            error={tooShort ? `At least ${MIN_NOTE} characters.` : undefined}
          >
            <Textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={3}
              placeholder="The SNIP on the ticket is not the journal's for that year"
            />
          </Field>
        </DialogBody>
        <DialogFooter>
          <Button kind="quiet" onClick={onClose} disabled={raise.isPending}>
            Cancel
          </Button>
          <Button kind="primary" disabled={!ready} onClick={() => void submit()}>
            {raise.isPending ? "Raising…" : "Raise it"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function ResolveFlagDialog({
  flag,
  onClose,
}: {
  flag: ClaimFlag | null
  onClose: () => void
}) {
  const [note, setNote] = useState("")
  useEffect(() => {
    if (flag) setNote("")
  }, [flag])

  const resolve = useApiMutation<{ note: string }, ClaimFlag>(
    () => `/api/flags/${flag?.id}/resolve`,
    { invalidates: [["flags"], ["claim-review"], ["archive"]] }
  )
  const trimmed = note.trim()
  const tooShort = trimmed.length > 0 && trimmed.length < MIN_NOTE
  const ready = trimmed.length >= MIN_NOTE && !resolve.isPending

  async function submit() {
    try {
      await resolve.mutateAsync({ note: trimmed })
      toast.ok(`Resolved — ${flag ? kindLabel(flag.kind).toLowerCase() : "flag"}`)
      onClose()
    } catch (err) {
      toast.fail(err)
    }
  }

  return (
    <Dialog open={flag !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>Resolve this flag</DialogTitle>
          <DialogDescription>
            {flag ? `${kindLabel(flag.kind)}: ${flag.note}` : ""}
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <Field
            label="What was found"
            hint="Kept with the flag and in the audit log."
            error={tooShort ? `At least ${MIN_NOTE} characters.` : undefined}
          >
            <Textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={3}
              placeholder="Checked against the publisher's page: the figure is right"
            />
          </Field>
        </DialogBody>
        <DialogFooter>
          <Button kind="quiet" onClick={onClose} disabled={resolve.isPending}>
            Cancel
          </Button>
          <Button kind="primary" disabled={!ready} onClick={() => void submit()}>
            {resolve.isPending ? "Resolving…" : "Resolve this flag"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/* ------------------------------------------------------------------------ */
/* On the claim page                                                         */
/* ------------------------------------------------------------------------ */

/** The flags and file checks for one claim; only fetched for a reviewer. */
export function useClaimReview(claimId: string | undefined, enabled: boolean) {
  return useApi<ClaimReview>(["claim-review", claimId], `/api/claims/${claimId}/review`, {
    enabled: enabled && !!claimId,
  })
}

/**
 * The flags section of a claim, for the desks that judge it.
 *
 * "Read the files again" is on the job queue, so it answers at once and the
 * result lands a little later; the section says so rather than pretending
 * the old result is the new one.
 */
export function ClaimFlagsPanel({
  claimId,
  review,
  loading = false,
  failed = false,
  onRetry,
}: {
  claimId: string
  review: ClaimReview | undefined
  loading?: boolean
  failed?: boolean
  onRetry?: () => void
}) {
  const [raising, setRaising] = useState(false)
  const [resolving, setResolving] = useState<ClaimFlag | null>(null)
  const recheck = useApiMutation<Record<string, never>, { queued: boolean; file_checks: FileCheck[] }>(
    `/api/claims/${claimId}/check-files`,
    { invalidates: [["claim-review", claimId], ["flags"]] }
  )

  // A queued read lands after the request that asked for it has returned, so
  // the section asks again every few seconds until a result newer than the
  // request arrives -- or for a minute, if the worker is not running.
  const queryClient = useQueryClient()
  const [waitingSince, setWaitingSince] = useState<number | null>(null)
  const newest = Math.max(
    0,
    ...(review?.file_checks ?? []).map((c) => (c.checked_at ? Date.parse(c.checked_at) : 0))
  )
  useEffect(() => {
    if (waitingSince === null) return
    if (newest >= waitingSince) {
      setWaitingSince(null)
      return
    }
    const timer = setInterval(() => {
      if (Date.now() - waitingSince > RECHECK_WAIT_MS) {
        setWaitingSince(null)
        return
      }
      void queryClient.invalidateQueries({ queryKey: ["claim-review", claimId] })
      void queryClient.invalidateQueries({ queryKey: ["flags"] })
    }, RECHECK_POLL_MS)
    return () => clearInterval(timer)
  }, [waitingSince, newest, claimId, queryClient])

  const flags = review?.flags ?? []
  const open = flags.filter((f) => f.open).length

  return (
    <section className="space-y-3" aria-labelledby="claim-flags">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <SectionTitle>
          <span id="claim-flags" className="inline-flex items-center gap-2">
            <FlagIcon className="size-4 text-fg-muted" aria-hidden />
            Flags{open > 0 ? ` · ${open} open` : ""}
          </span>
        </SectionTitle>
        <div className="flex flex-wrap gap-2">
          <Button
            kind="quiet"
            size="sm"
            disabled={recheck.isPending}
            onClick={() =>
              recheck.mutate(
                {},
                {
                  onSuccess: (r) => {
                    if (r.queued) setWaitingSince(Date.now())
                    toast.ok(
                      r.queued
                        ? "Reading the files again — the result appears here in a minute"
                        : "Files read again"
                    )
                  },
                  onError: (err: unknown) => toast.fail(err),
                }
              )
            }
          >
            <FileSearch aria-hidden />
            {recheck.isPending ? "Asking…" : waitingSince !== null ? "Reading…" : "Read the files again"}
          </Button>
          <Button kind="default" size="sm" onClick={() => setRaising(true)}>
            Raise a flag
          </Button>
        </div>
      </div>
      <Meta className="block text-pretty">
        Seen by the research cell, the coordinator, the Principal and the super admin — not by the
        claimant, the Director or Finance. A flag never holds the claim back.
      </Meta>

      {loading ? (
        <div className="skeleton h-16 w-full rounded-md" aria-hidden="true" />
      ) : failed ? (
        <p role="alert" className="text-sm text-critical">
          Could not load the flags on this claim.{" "}
          {onRetry && (
            <button type="button" className="font-medium underline-offset-2 hover:underline" onClick={onRetry}>
              Try again
            </button>
          )}
        </p>
      ) : flags.length === 0 ? (
        <p className="text-sm text-fg-muted">No flags on this claim.</p>
      ) : (
        <ul className="divide-y divide-line border-y border-line">
          {flags.map((f) => (
            <FlagRow key={f.id} flag={f} onResolve={() => setResolving(f)} />
          ))}
        </ul>
      )}

      <RaiseFlagDialog claimId={claimId} open={raising} onClose={() => setRaising(false)} />
      <ResolveFlagDialog flag={resolving} onClose={() => setResolving(null)} />
    </section>
  )
}

/** The claim a flag is on, as a link and one line of who and where. */
export function ClaimLine({
  claim,
}: {
  claim: {
    id: string
    ticket_number: string | null
    paper_title: string | null
    owner_name: string
    owner_department: string | null
  }
}) {
  return (
    <span className="block min-w-0">
      <Link
        to={`/papers/${claim.id}`}
        className="block truncate text-sm text-accent underline-offset-4 hover:underline"
      >
        {claim.paper_title || "Untitled paper"}
      </Link>
      <Meta className="block truncate">
        {[claim.ticket_number, claim.owner_name, claim.owner_department].filter(Boolean).join(" · ")}
      </Meta>
    </span>
  )
}
