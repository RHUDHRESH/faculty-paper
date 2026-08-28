import { useEffect, useState } from "react"
import { Inbox, Lock } from "lucide-react"

import { can, useAuth } from "@/app/auth"
import { ApiError } from "@/lib/api"
import { cn } from "@/lib/cn"
import { useApi, useApiMutation } from "@/lib/query"
import { Button } from "@/ui/button"
import {
  ConfirmDialog,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/ui/dialog"
import { Field, Textarea } from "@/ui/field"
import { Callout, EmptyState, ErrorState, SkeletonRows } from "@/ui/state"
import { Meta, PageTitle, SectionTitle, Sub } from "@/ui/text"
import { toast } from "@/ui/toast"

/**
 * The office's side of `profile.tsx`'s "Request a correction" — every
 * pending ask for a name, staff ID, biometric ID, designation, department or
 * Scopus link, and what became of the ones already decided.
 *
 * Before this screen existed, a correction request was write-only: an admin
 * who missed the notification lost it outright, there was no list of what
 * was still outstanding, and the person who asked never learned whether they
 * had been heard. So this is deliberately a queue, not a log — pending work
 * first, oldest ask first inside it, and a decided request stays visible
 * with its outcome rather than vanishing the moment somebody acts on it.
 *
 * Identity fields (`identity: true` — everything but department) can only be
 * decided by a super admin, on the server as much as here: `POST
 * /api/admin/profile-requests/{id}` answers 403 to a research-cell account
 * for one of those, unconditionally, even to decline it. Offering the
 * buttons anyway would just turn every identity row into a guaranteed
 * failed click, so they are hidden rather than disabled.
 */

/* ------------------------------------------------------------------------ */
/* Data — read out of _request_dict() in backend/core/api.py                */
/* ------------------------------------------------------------------------ */

type RequestStatus = "PENDING" | "APPROVED" | "DECLINED"

type RequestedBy = {
  id: string
  name: string
  email: string
  department: string
  staff_id: string
}

type ProfileRequest = {
  id: string
  field: string
  label: string
  current_value: string
  proposed_value: string
  // What the record says *today*. Can differ from `current_value` if it
  // moved while this sat in the queue — the whole reason this field exists.
  value_now: string
  note: string
  identity: boolean
  status: RequestStatus
  requested_by: RequestedBy
  decided_by: string | null
  decided_at: string | null
  decision_note: string
  created_at: string | null
}

type ProfileRequestsResponse = {
  results: ProfileRequest[]
  // A count of every PENDING row system-wide, independent of whatever
  // `status` filter the list itself was fetched with.
  pending: number
}

type DecidePayload = { approve: boolean; note?: string }
type DecideResult = { ok: boolean; request: ProfileRequest }

/* ------------------------------------------------------------------------ */
/* Page                                                                      */
/* ------------------------------------------------------------------------ */

export function Requests() {
  const { me } = useAuth()
  const allowed = can(me?.role).manageUsers
  const isSuperAdmin = can(me?.role).admin

  // A claimant who lands here gets refused by the server (403) — gating the
  // request itself, rather than letting it fire and rendering whatever comes
  // back, means that refusal is never mistaken for "nothing is pending".
  const { data, isLoading, isError, error, refetch } = useApi<ProfileRequestsResponse>(
    ["admin", "profile-requests"],
    "/api/admin/profile-requests?status=ALL&limit=200",
    { enabled: allowed }
  )

  if (!allowed) {
    return (
      <div className="page py-8">
        <ErrorState
          title="Not open to this account"
          message="Only the research cell and a super admin can decide profile requests."
        />
      </div>
    )
  }

  const results = data?.results ?? []
  // Oldest ask first — the same reasoning as the clearing queue: whoever is
  // working through this list top to bottom should never have to hunt for
  // the request that has waited longest.
  const pendingRows = [...results]
    .filter((r) => r.status === "PENDING")
    .sort((a, b) => (a.created_at || "").localeCompare(b.created_at || ""))
  const decidedRows = results.filter((r) => r.status !== "PENDING")

  return (
    <div className="page space-y-8 py-8">
      <header>
        <PageTitle>Profile requests</PageTitle>
        <Sub className="mt-1">
          Corrections a claimant cannot make themselves — those fields decide who gets paid
          and whose record a paper is checked against, so an admin decides here instead.
        </Sub>
      </header>

      {isLoading ? (
        <SkeletonRows rows={6} rowHeight={104} />
      ) : isError ? (
        <ErrorState
          title="Could not load the queue"
          message={
            error instanceof ApiError && error.status === 403
              ? "Not allowed. Only the research cell and a super admin can open this."
              : "The server did not answer. Nothing has been lost or decided."
          }
          onRetry={error instanceof ApiError && error.status === 403 ? undefined : () => refetch()}
        />
      ) : (
        <>
          <section className="space-y-3">
            <div className="flex items-baseline justify-between gap-3">
              <SectionTitle>Pending</SectionTitle>
              <Meta>
                {data?.pending ?? 0} {(data?.pending ?? 0) === 1 ? "request" : "requests"} waiting
              </Meta>
            </div>

            {pendingRows.length === 0 ? (
              <EmptyState
                art="empty-queue"
                icon={Inbox}
                title="Nothing waiting"
                message="Every request has been decided. That is good news — come back when the next one lands."
              />
            ) : (
              <ul className="divide-y divide-line border-y border-line">
                {pendingRows.map((r) => (
                  <RequestRow key={r.id} request={r} isSuperAdmin={isSuperAdmin} />
                ))}
              </ul>
            )}
          </section>

          {decidedRows.length > 0 && (
            <section className="space-y-3">
              <SectionTitle>Decided</SectionTitle>
              <ul className="divide-y divide-line border-y border-line">
                {decidedRows.map((r) => (
                  <DecidedRow key={r.id} request={r} />
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------------ */
/* Pending row                                                               */
/* ------------------------------------------------------------------------ */

function IdentityBadge() {
  return (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-sm bg-caution-wash px-1.5 py-0.5 text-xs font-medium text-caution">
      <Lock className="size-3" aria-hidden />
      Identity — super admin only
    </span>
  )
}

/**
 * One outstanding request: what changes, who asked, why, and the two
 * actions an admin has. `value_now` is compared against `current_value`
 * every render, because that is the one thing on this row that can go
 * stale — a super admin correcting the same field a different way after
 * this was asked would otherwise be silently overwritten by "approve".
 */
function RequestRow({ request, isSuperAdmin }: { request: ProfileRequest; isSuperAdmin: boolean }) {
  const [approveOpen, setApproveOpen] = useState(false)
  const [declineOpen, setDeclineOpen] = useState(false)

  const canAct = !request.identity || isSuperAdmin
  const moved = request.value_now !== request.current_value

  return (
    <li className="space-y-3 py-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium">{request.label}</p>
          <p className="mt-0.5 text-sm text-fg-muted">
            {[request.requested_by.name, request.requested_by.department, request.requested_by.email]
              .filter(Boolean)
              .join(" · ")}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {request.identity && <IdentityBadge />}
          <Meta>{formatDateTime(request.created_at)}</Meta>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="rounded-md bg-sunken px-2 py-1">{request.current_value || "Not set"}</span>
        <span className="text-fg-subtle" aria-hidden>
          →
        </span>
        <span className="rounded-md bg-accent-wash px-2 py-1 font-medium">{request.proposed_value}</span>
      </div>

      {moved && (
        <Callout tone="caution" title="The record moved while this was waiting">
          {request.label} now reads “{request.value_now || "not set"}”, not “
          {request.current_value || "not set"}” — what was asked about. Approving overwrites
          today's value, not the one this request was compared against.
        </Callout>
      )}

      {request.note && <p className="text-sm text-fg-muted">“{request.note}”</p>}

      {canAct ? (
        <div className="flex gap-2">
          <Button kind="danger" size="sm" onClick={() => setDeclineOpen(true)}>
            Decline
          </Button>
          <Button kind="primary" size="sm" onClick={() => setApproveOpen(true)}>
            Approve
          </Button>
        </div>
      ) : (
        <p className="text-sm text-fg-subtle">
          Only a super admin can act on this — it decides identity, not routing.
        </p>
      )}

      <ApproveDialog request={request} open={approveOpen} onOpenChange={setApproveOpen} moved={moved} />
      <DeclineDialog request={request} open={declineOpen} onOpenChange={setDeclineOpen} />
    </li>
  )
}

/* ------------------------------------------------------------------------ */
/* Approve — a write to a field that decides payment, said plainly          */
/* ------------------------------------------------------------------------ */

function ApproveDialog({
  request,
  open,
  onOpenChange,
  moved,
}: {
  request: ProfileRequest
  open: boolean
  onOpenChange: (open: boolean) => void
  moved: boolean
}) {
  const decide = useApiMutation<DecidePayload, DecideResult>(
    `/api/admin/profile-requests/${request.id}`,
    { invalidates: [["admin", "profile-requests"]] }
  )

  async function confirm() {
    try {
      await decide.mutateAsync({ approve: true })
      toast.ok(`Approved — ${request.label} → “${request.proposed_value}” for ${request.requested_by.name}`)
    } catch (err) {
      toast.fail(err)
      // Re-thrown so ConfirmDialog's own confirm() sees the failure and
      // leaves the dialog open instead of closing on a request that did
      // not actually go through.
      throw err
    }
  }

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Approve — ${request.label}?`}
      description={
        moved
          ? `This writes “${request.proposed_value}” to ${request.requested_by.name}'s ${request.label.toLowerCase()}, replacing what it says today — “${request.value_now || "not set"}” — not what was originally asked about.`
          : `This writes “${request.proposed_value}” to ${request.requested_by.name}'s ${request.label.toLowerCase()} straight away. That field decides who gets paid and whose record a paper is checked against.`
      }
      confirmLabel="Approve"
      onConfirm={confirm}
    />
  )
}

/* ------------------------------------------------------------------------ */
/* Decline — a reason is not optional                                       */
/* ------------------------------------------------------------------------ */

/**
 * The server refuses a decline under five characters — "Say why it is being
 * declined — the person is told." — and the person really is told: the
 * claimant reads this exact sentence on their own profile page. A bare "No"
 * here is a bare "No" there, which is the failure this whole feature exists
 * to replace.
 */
function DeclineDialog({
  request,
  open,
  onOpenChange,
}: {
  request: ProfileRequest
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [note, setNote] = useState("")

  useEffect(() => {
    if (open) setNote("")
  }, [open])

  const decide = useApiMutation<DecidePayload, DecideResult>(
    `/api/admin/profile-requests/${request.id}`,
    { invalidates: [["admin", "profile-requests"]] }
  )

  const trimmed = note.trim()
  const tooShort = trimmed.length > 0 && trimmed.length < 5
  const canSubmit = trimmed.length >= 5

  async function submit() {
    try {
      await decide.mutateAsync({ approve: false, note: trimmed })
      toast.ok(`Declined — ${request.requested_by.name} will see why`)
      onOpenChange(false)
    } catch (err) {
      toast.fail(err)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>Decline — {request.label}?</DialogTitle>
          <DialogDescription>
            {request.requested_by.name} asked for “{request.proposed_value}”.
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <Field
            label="Reason"
            hint="The claimant reads this on their own profile page — say what was wrong, not just no."
            error={tooShort ? "At least 5 characters." : undefined}
          >
            <Textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={3}
              placeholder="What was wrong with the request, or what to do instead"
              autoFocus
            />
          </Field>
        </DialogBody>
        <DialogFooter>
          <Button kind="quiet" onClick={() => onOpenChange(false)} disabled={decide.isPending}>
            Cancel
          </Button>
          <Button kind="danger" disabled={!canSubmit || decide.isPending} onClick={() => void submit()}>
            {decide.isPending ? "Declining…" : "Decline"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/* ------------------------------------------------------------------------ */
/* Decided row                                                              */
/* ------------------------------------------------------------------------ */

/**
 * What came of an already-decided request — kept on screen rather than
 * dropped the moment it leaves the queue, because "was this ever answered"
 * is exactly the question this whole screen exists to stop being unanswerable.
 */
function DecidedRow({ request }: { request: ProfileRequest }) {
  const approved = request.status === "APPROVED"
  return (
    <li className="space-y-2 py-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium">{request.label}</p>
          <p className="mt-0.5 text-sm text-fg-muted">
            {[request.requested_by.name, request.requested_by.department].filter(Boolean).join(" · ")}
          </p>
        </div>
        <span
          className={cn(
            "shrink-0 rounded-sm px-1.5 py-0.5 text-xs font-medium",
            approved ? "bg-positive-wash text-positive" : "bg-critical-wash text-critical"
          )}
        >
          {approved ? "Approved" : "Declined"}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-sm text-fg-muted">
        <span>{request.current_value || "Not set"}</span>
        <span aria-hidden>→</span>
        <span>{request.proposed_value}</span>
      </div>

      {request.decision_note && <p className="text-sm text-fg-muted">“{request.decision_note}”</p>}

      <Meta className="block">
        {request.decided_by ? `${request.decided_by} · ` : ""}
        {formatDateTime(request.decided_at)}
      </Meta>
    </li>
  )
}

/* ------------------------------------------------------------------------ */
/* Small helpers                                                            */
/* ------------------------------------------------------------------------ */

function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return ""
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ""
  return d.toLocaleString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  })
}
