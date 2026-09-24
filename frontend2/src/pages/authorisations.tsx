import { useEffect, useState } from "react"
import { Link, useSearchParams } from "react-router-dom"
import { CircleCheck, Stamp } from "lucide-react"

import { can, useAuth } from "@/app/auth"
import { ApiError } from "@/lib/api"
import { cn } from "@/lib/cn"
import { CHAIN, useApi, useApiMutation } from "@/lib/query"
import { Button } from "@/ui/button"
import { Combobox, type ComboboxOption } from "@/ui/combobox"
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/ui/dialog"
import { Checkbox, Field, Textarea } from "@/ui/field"
import { money } from "@/ui/paper"
import { Pagination } from "@/ui/pagination"
import { Callout, EmptyState, ErrorState, Skeleton, SkeletonRows } from "@/ui/state"
import { ColumnLabel, Meta, PageTitle, Sub } from "@/ui/text"
import { toast } from "@/ui/toast"
import { OwnPapersNote } from "@/ui/own-papers"

/**
 * The Director's queue: everything the Principal has approved and nobody has
 * yet authorised.
 *
 * This is the newest link in the chain and the reason it exists is worth
 * stating, because the screen is otherwise a near-twin of the Principal's.
 * The Principal answers "is this claim correct and should we pay it". The
 * Director answers "can the institution pay it, this month, against this
 * budget, alongside everything else being authorised". Two questions, two
 * people, two signatures — and Finance pays only what carries the second.
 *
 * Deliberately shaped like `/approvals`: the same sort, the same
 * whole-filter totals, the same 409 guard. A second queue that ordered or
 * totalled its money differently would have the Principal and the Director
 * quoting different figures for the same set of claims.
 */

const PAGE_SIZE = 50

/* ------------------------------------------------------------------------ */
/* Data — read out of director_queue() in backend/core/api.py               */
/* ------------------------------------------------------------------------ */

export type Claim = {
  id: string
  ticket_number: string | null
  paper_title: string
  journal_title: string | null
  owner_name: string
  owner_department: string | null
  status: string
  remuneration: number | null
  quartile: string | null
  snip: number | null
  calc_error: string | null
  needs_second_approval: boolean
  cleared_by_name: string | null
  principal_approved_by_name: string | null
  waiting_days: number | null
}

type QueuePayload = {
  total: number
  limit: number
  offset: number
  results: Claim[]
  /** Over everything the filter matched, never the page. */
  totals: { count: number; amount: number; longest_wait_days: number | null }
  departments: string[]
}

type BulkResult = {
  approved: number
  total: number
  skipped: { id: string; reason: string }[]
}

/* ------------------------------------------------------------------------ */
/* Page                                                                      */
/* ------------------------------------------------------------------------ */

export function Authorisations() {
  const { me } = useAuth()
  const allowed = can(me?.role).authorise

  const [searchParams, setSearchParams] = useSearchParams()
  const department = searchParams.get("department") ?? ""
  const sort = searchParams.get("sort") ?? "waiting"
  const page = Math.max(0, Number.parseInt(searchParams.get("page") ?? "0", 10) || 0)

  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [acting, setActing] = useState<{ claim: Claim; mode: "authorise" | "send-back" } | null>(
    null
  )
  const [bulkOpen, setBulkOpen] = useState(false)

  function setParam(key: string, value: string) {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev)
      if (value) next.set(key, value)
      else next.delete(key)
      if (key !== "page") next.delete("page")
      return next
    })
  }

  const query = new URLSearchParams()
  if (department) query.set("department", department)
  query.set("sort", sort)
  query.set("limit", String(PAGE_SIZE))
  query.set("offset", String(page * PAGE_SIZE))

  const { data, isLoading, isError, error, refetch } = useApi<QueuePayload>(
    ["director-queue", department, sort, page],
    `/api/director/queue?${query.toString()}`,
    { enabled: allowed, placeholderData: (prev) => prev }
  )

  const rows = data?.results ?? []

  // A selection made on one page is meaningless on the next, and a hidden
  // selection is how somebody authorises rows they cannot see.
  useEffect(() => {
    setSelected(new Set())
  }, [department, sort, page])

  if (!allowed) {
    return (
      <div className="page py-8">
        <ErrorState
          art="closed-gate"
          title="Not open to this account"
          message="Authorising a payment is the Director's, and a super admin standing in for one."
        />
      </div>
    )
  }

  const selectedRows = rows.filter((r) => selected.has(r.id))
  const selectedTotal = selectedRows.reduce((sum, c) => sum + (c.remuneration || 0), 0)
  const totals = data?.totals

  const departmentOptions: ComboboxOption[] = [
    { value: "", label: "All departments" },
    ...(data?.departments ?? []).map((d) => ({ value: d, label: d })),
  ]

  return (
    <div className="page space-y-6">
      <header>
        <PageTitle>Authorisations</PageTitle>
        <Sub className="mt-1">
          Approved by the Principal and waiting on you. Finance cannot pay any of these until
          they carry your authorisation.
        </Sub>
        <OwnPapersNote className="mt-1" />
      </header>

      {/* Three states, not two. Without `loading` these read "—", "—", "—"
          while the request is out — and with `totals` undefined after a
          failure they went on reading that way above the error banner, which
          is a column of dashes saying "nothing is waiting on you" at the one
          moment the screen does not know. Withheld outright on a failure
          with nothing cached; skeletons until the figures are real. */}
      {!(isError && !data) && (
        <div className="flex flex-wrap items-baseline gap-x-8 gap-y-3 border-y border-line py-3">
          <Stat
            label="Waiting on you"
            loading={!totals}
            value={totals ? String(totals.count) : "—"}
          />
          <Stat
            label="Comes to"
            loading={!totals}
            value={money(totals?.amount)}
            hint="Across everything that matches, not this page"
          />
          <Stat
            label="Longest wait"
            loading={!totals}
            value={
              totals?.longest_wait_days == null
                ? "None"
                : `${totals.longest_wait_days} ${totals.longest_wait_days === 1 ? "day" : "days"}`
            }
            hint="Since the Principal approved it"
            tone={
              totals?.longest_wait_days != null && totals.longest_wait_days > 30
                ? "critical"
                : undefined
            }
          />
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <Combobox
          value={department}
          onChange={(next) => setParam("department", next)}
          options={departmentOptions}
          placeholder="All departments"
          aria-label="Filter by department"
          className="w-56"
        />
        <Combobox
          value={sort}
          onChange={(next) => setParam("sort", next)}
          options={[
            { value: "waiting", label: "Longest waiting first" },
            { value: "recent", label: "Most recent first" },
            { value: "amount", label: "Largest amount first" },
            { value: "department", label: "By department" },
          ]}
          aria-label="Sort"
          className="w-52"
        />
        {selectedRows.length > 0 && (
          <div className="ml-auto flex items-center gap-3">
            <Meta className="tabular">
              {selectedRows.length} selected · {money(selectedTotal)}
            </Meta>
            <Button kind="primary" size="md" onClick={() => setBulkOpen(true)}>
              <Stamp />
              Authorise {selectedRows.length}
            </Button>
          </div>
        )}
      </div>

      {isLoading && !data ? (
        <SkeletonRows rows={8} rowHeight={72} />
      ) : isError ? (
        <ErrorState
          title="Could not load the queue"
          message={
            error?.status === 403
              ? "Not allowed. Only the Director, or a super admin standing in, can authorise."
              : "The server did not answer. Nothing has been authorised."
          }
          onRetry={error?.status === 403 ? undefined : () => refetch()}
        />
      ) : rows.length === 0 ? (
        <EmptyState
          // With a department chosen, "Every approved claim has been
          // authorised" is a claim about the whole college made from one
          // department's empty page — and it is the sentence a Director
          // would stop working on the strength of.
          art={department ? "no-results" : "empty-queue"}
          icon={CircleCheck}
          title={
            department ? `Nothing waiting from ${department}` : "Nothing is waiting on you"
          }
          message={
            department
              ? "Another department may still have claims waiting. Clear the filter to see the whole queue."
              : "Every approved claim has been authorised. The Principal's next batch appears here as soon as they sign it off."
          }
          action={
            department ? (
              <Button kind="default" size="sm" onClick={() => setParam("department", "")}>
                See every department
              </Button>
            ) : undefined
          }
        />
      ) : (
        <>
          <div className="flex items-center gap-2 pb-1">
            <Checkbox
              checked={selectedRows.length === rows.length && rows.length > 0}
              onCheckedChange={(v) =>
                setSelected(v === true ? new Set(rows.map((r) => r.id)) : new Set())
              }
              label={`Select all ${rows.length} on this page`}
            />
          </div>

          <ul className="divide-y divide-line border-y border-line">
            {rows.map((claim) => (
              <ClaimRow
                key={claim.id}
                claim={claim}
                checked={selected.has(claim.id)}
                onToggle={(on) =>
                  setSelected((prev) => {
                    const next = new Set(prev)
                    if (on) next.add(claim.id)
                    else next.delete(claim.id)
                    return next
                  })
                }
                onAuthorise={() => setActing({ claim, mode: "authorise" })}
                // The Director only moves a claim forward (the college's rule);
                // sending one back is left to a super admin standing in.
                onSendBack={
                  me?.role === "SUPER_ADMIN" ? () => setActing({ claim, mode: "send-back" }) : undefined
                }
              />
            ))}
          </ul>

          <Pagination
            page={page}
            pageSize={PAGE_SIZE}
            total={data?.total ?? 0}
            onChange={(next) => setParam("page", next > 0 ? String(next) : "")}
          />
        </>
      )}

      {acting?.mode === "authorise" && (
        <AuthoriseDialog claim={acting.claim} onClose={() => setActing(null)} />
      )}
      {acting?.mode === "send-back" && (
        <SendBackDialog claim={acting.claim} onClose={() => setActing(null)} />
      )}
      {bulkOpen && (
        <BulkAuthoriseDialog
          claims={selectedRows}
          onClose={() => setBulkOpen(false)}
          onDone={() => setSelected(new Set())}
        />
      )}
    </div>
  )
}

function Stat({
  label,
  value,
  hint,
  tone,
  loading,
}: {
  label: string
  value: string
  hint?: string
  tone?: "critical"
  /** A figure that has not arrived is a placeholder, never a dash. A dash is
   *  a value, and on this screen it is the value "none waiting". */
  loading?: boolean
}) {
  return (
    <div>
      <ColumnLabel className="block">{label}</ColumnLabel>
      {loading ? (
        <Skeleton className="mt-1 h-7 w-24" />
      ) : (
        <p
          className={cn(
            "mt-0.5 text-2xl font-semibold tabular",
            tone === "critical" && "text-critical"
          )}
        >
          {value}
        </p>
      )}
      {hint && <Meta className="mt-0.5 block text-xs">{hint}</Meta>}
    </div>
  )
}

/* ------------------------------------------------------------------------ */
/* One claim                                                                 */
/* ------------------------------------------------------------------------ */

function ClaimRow({
  claim,
  checked,
  onToggle,
  onAuthorise,
  onSendBack,
}: {
  claim: Claim
  checked: boolean
  onToggle: (on: boolean) => void
  onAuthorise: () => void
  onSendBack?: () => void
}) {
  return (
    <li className="flex gap-3 py-4">
      <span className="pt-1">
        <Checkbox
          checked={checked}
          onCheckedChange={(v) => onToggle(v === true)}
          aria-label={`Select ${claim.paper_title}`}
        />
      </span>

      <div className="min-w-0 flex-1 space-y-2">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <Link
              to={`/papers/${claim.id}`}
              className="block truncate text-base underline-offset-4 hover:underline"
            >
              {claim.paper_title || "Untitled"}
            </Link>
            <Meta className="block truncate">
              {[
                claim.owner_name,
                claim.owner_department,
                claim.journal_title,
                claim.ticket_number,
              ]
                .filter(Boolean)
                .join(" · ")}
            </Meta>
          </div>
          <div className="shrink-0 text-right">
            <p className="text-lg font-semibold tabular">{money(claim.remuneration)}</p>
            {claim.waiting_days != null && (
              <Meta className="block text-xs">
                waiting {claim.waiting_days} {claim.waiting_days === 1 ? "day" : "days"}
              </Meta>
            )}
          </div>
        </div>

        {claim.calc_error && (
          <Callout tone="critical" title="This amount could not be worked out">
            {claim.calc_error}
          </Callout>
        )}

        {claim.needs_second_approval && (
          // Information, not a control. `second-approve` is restricted to the
          // office; a Director pressing it would simply be refused, so it is
          // said rather than offered.
          <Callout tone="caution" title="Needs a second signature before Finance can pay">
            Over the high-value threshold. The research cell or a super admin gives that
            signature — authorising it here does not, and Finance will still refuse the payment
            until they do.
          </Callout>
        )}

        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <Meta>
            Approved by {claim.principal_approved_by_name || "the Principal"}
            {claim.cleared_by_name ? ` · checked by ${claim.cleared_by_name}` : ""}
          </Meta>
          {claim.quartile && <Meta>{claim.quartile}</Meta>}
          {claim.snip != null && <Meta>SNIP {claim.snip}</Meta>}
        </div>

        <div className="flex gap-2">
          <Button kind="primary" size="sm" onClick={onAuthorise} disabled={!!claim.calc_error}>
            Authorise
          </Button>
          {onSendBack && (
            <Button kind="quiet" size="sm" onClick={onSendBack}>
              Send back to the Principal
            </Button>
          )}
        </div>
      </div>
    </li>
  )
}

/* ------------------------------------------------------------------------ */
/* Authorising                                                               */
/* ------------------------------------------------------------------------ */

/**
 * The amount on screen is the amount authorised.
 *
 * If the figure moved between this screen being drawn and the click, the
 * server answers 409 with the recomputed amount inside its own message. That
 * number is read back out and shown beside the old one; confirming again is
 * always a fresh, deliberate click at the new figure, never automatic.
 */
function AuthoriseDialog({ claim, onClose }: { claim: Claim; onClose: () => void }) {
  const [amount, setAmount] = useState<number | null>(claim.remuneration)
  const [phase, setPhase] = useState<"ready" | "changed">("ready")
  const [changedMessage, setChangedMessage] = useState<string | null>(null)
  const [note, setNote] = useState("")
  const [busy, setBusy] = useState(false)

  const authorise = useApiMutation<{ note?: string; expected_amount: number }, Claim>(
    `/api/claims/${claim.id}/director-approve`,
    { invalidates: [...CHAIN, ["claim", claim.id]] }
  )

  async function confirm() {
    if (amount == null) return
    setBusy(true)
    try {
      const result = await authorise.mutateAsync({
        note: note.trim() || undefined,
        expected_amount: amount,
      })
      toast.ok(
        `Authorised — ${money(result.remuneration)} released to Finance${
          claim.ticket_number ? ` for ${claim.ticket_number}` : ""
        }`
      )
      onClose()
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setChangedMessage(err.message)
        setPhase("changed")
      } else {
        toast.fail(err)
      }
    } finally {
      setBusy(false)
    }
  }

  function continueWithNewAmount() {
    const parsed = changedMessage ? parseAmountFromMessage(changedMessage) : null
    if (parsed != null) setAmount(parsed)
    setPhase("ready")
    setChangedMessage(null)
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>Authorise this payment?</DialogTitle>
          <DialogDescription>
            {claim.owner_name} · {claim.paper_title}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          {phase === "changed" ? (
            <Callout tone="caution" title="The amount changed while this was open">
              <p className="mt-1">{changedMessage}</p>
              <p className="mt-2">
                Nothing has been authorised. Check the new figure and confirm again if it is
                right.
              </p>
            </Callout>
          ) : (
            <>
              <div>
                <ColumnLabel className="block">Authorising</ColumnLabel>
                <p className="mt-0.5 text-2xl font-semibold tabular">{money(amount)}</p>
                <Meta className="mt-1 block">
                  Approved by {claim.principal_approved_by_name || "the Principal"}. Once
                  authorised, Finance can pay it.
                </Meta>
              </div>

              <Field label="Note" hint="Optional — kept on the ticket's history.">
                <Textarea
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  rows={2}
                  placeholder="Within the quarter's allocation"
                />
              </Field>
            </>
          )}
        </DialogBody>
        <DialogFooter>
          <Button kind="quiet" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          {phase === "changed" ? (
            <Button kind="primary" onClick={continueWithNewAmount}>
              Show me the new amount
            </Button>
          ) : (
            <Button kind="primary" disabled={busy || amount == null} onClick={() => void confirm()}>
              {busy ? "Authorising…" : `Authorise ${money(amount)}`}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/* ------------------------------------------------------------------------ */
/* Sending it back                                                           */
/* ------------------------------------------------------------------------ */

/**
 * Back to the Principal, not to the claimant.
 *
 * What the Director is querying is the approval, so it returns to whoever
 * gave it. The server withdraws that approval along with the status, so the
 * ticket genuinely sits with the Principal again rather than carrying a
 * signature for a decision that has been reopened.
 */
function SendBackDialog({ claim, onClose }: { claim: Claim; onClose: () => void }) {
  const [note, setNote] = useState("")

  const reject = useApiMutation<{ note: string }, Claim>(
    `/api/claims/${claim.id}/director-reject`,
    { invalidates: [...CHAIN, ["claim", claim.id]] }
  )

  const trimmed = note.trim()
  const tooShort = trimmed.length > 0 && trimmed.length < 5

  async function submit() {
    try {
      await reject.mutateAsync({ note: trimmed })
      toast.ok(`Sent back — the Principal will see why${claim.ticket_number ? ` on ${claim.ticket_number}` : ""}`)
      onClose()
    } catch (err) {
      toast.fail(err)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>Send back to the Principal?</DialogTitle>
          <DialogDescription>
            {claim.owner_name} · {money(claim.remuneration)}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          <Callout tone="info" title="This goes back one step, not to the claimant">
            The Principal's approval is withdrawn and the ticket returns to them. Nobody is
            asked to re-file a paper to answer a question about the budget.
          </Callout>
          <Field
            label="Reason"
            hint="The Principal reads this. Say what needs revisiting."
            error={tooShort ? "At least 5 characters." : undefined}
          >
            <Textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={3}
              placeholder="Takes the department past its allocation for the quarter — hold until April"
              autoFocus
            />
          </Field>
        </DialogBody>
        <DialogFooter>
          <Button kind="quiet" onClick={onClose} disabled={reject.isPending}>
            Cancel
          </Button>
          <Button
            kind="danger"
            disabled={trimmed.length < 5 || reject.isPending}
            onClick={() => void submit()}
          >
            {reject.isPending ? "Sending back…" : "Send back"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/* ------------------------------------------------------------------------ */
/* Bulk                                                                      */
/* ------------------------------------------------------------------------ */

/**
 * A batch that fails as a unit is a batch nobody dares run, so the server
 * authorises row by row and returns what it skipped and why.
 *
 * Those reasons are reported individually. "Authorised 12 of 15" with no word
 * on the other three is how three claims get forgotten.
 */
export function BulkAuthoriseDialog({
  claims,
  onClose,
  onDone,
}: {
  claims: Claim[]
  onClose: () => void
  onDone: () => void
}) {
  const [note, setNote] = useState("")
  const [result, setResult] = useState<BulkResult | null>(null)

  const bulk = useApiMutation<{ claim_ids: string[]; note?: string }, BulkResult>(
    "/api/director/bulk-approve",
    { invalidates: [...CHAIN] }
  )

  const total = claims.reduce((sum, c) => sum + (c.remuneration || 0), 0)
  const blocked = claims.filter((c) => c.needs_second_approval)

  async function submit() {
    try {
      const res = await bulk.mutateAsync({
        claim_ids: claims.map((c) => c.id),
        note: note.trim() || undefined,
      })
      setResult(res)
      if (res.approved > 0) {
        toast.ok(`Authorised ${res.approved} · ${money(res.total)} released to Finance`)
        onDone()
      }
      if (res.skipped.length === 0) onClose()
    } catch (err) {
      toast.fail(err)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>
            {result ? "What happened" : `Authorise ${claims.length} claims?`}
          </DialogTitle>
          <DialogDescription>
            {result
              ? `${result.approved} authorised, ${result.skipped.length} skipped.`
              : `${money(total)} in total, released to Finance for payment.`}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          {result ? (
            result.skipped.length > 0 && (
              <div className="space-y-2">
                <Callout tone="caution" title={`${result.skipped.length} were not authorised`}>
                  Each one is listed below with its reason. They are still in the queue.
                </Callout>
                <ul className="space-y-1 text-sm">
                  {result.skipped.map((s) => (
                    <li key={s.id} className="rounded-md bg-sunken px-3 py-2">
                      {s.reason}
                    </li>
                  ))}
                </ul>
              </div>
            )
          ) : (
            <>
              {blocked.length > 0 && (
                <Callout tone="caution" title={`${blocked.length} still need a second signature`}>
                  They will be authorised, but Finance cannot pay them until the research cell
                  or a super admin adds the second signature. Authorising here does not supply
                  it.
                </Callout>
              )}
              <div>
                <ColumnLabel className="block">Releasing</ColumnLabel>
                <p className="mt-0.5 text-2xl font-semibold tabular">{money(total)}</p>
                <Meta className="mt-1 block">
                  across {claims.length} {claims.length === 1 ? "claim" : "claims"}
                </Meta>
              </div>
              <Field label="Note" hint="Optional — recorded against every claim in the batch.">
                <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} />
              </Field>
            </>
          )}
        </DialogBody>
        <DialogFooter>
          <Button kind="quiet" onClick={onClose} disabled={bulk.isPending}>
            {result ? "Close" : "Cancel"}
          </Button>
          {!result && (
            <Button kind="primary" disabled={bulk.isPending} onClick={() => void submit()}>
              {bulk.isPending ? "Authorising…" : `Authorise ${money(total)}`}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/* ------------------------------------------------------------------------ */
/* Helpers                                                                   */
/* ------------------------------------------------------------------------ */

// `_guard_recomputed_amount` writes the recomputed figure into its own 409
// message ("The recomputed amount is ₹52,377.50. ..."), so the fresh number
// is read straight back out of it rather than re-fetching the claim — which,
// inside the same rolled-back transaction, would still show the stale one.
function parseAmountFromMessage(message: string): number | null {
  const m = message.match(/₹([\d,]+(?:\.\d+)?)/)
  if (!m) return null
  const n = Number.parseFloat(m[1].replace(/,/g, ""))
  return Number.isFinite(n) ? n : null
}
