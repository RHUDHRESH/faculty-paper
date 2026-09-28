import { paperTitle } from "@/lib/names"
import { useEffect, useState } from "react"
import { Link, useSearchParams } from "react-router-dom"
import { CircleCheck, Stamp } from "lucide-react"

import { can, useAuth } from "@/app/auth"
import { ApiError } from "@/lib/api"
import { cn } from "@/lib/cn"
import { CHAIN, useApi, useApiMutation } from "@/lib/query"
import { Button } from "@/ui/button"
import { filterBar } from "@/ui/filter-bar"
import { ComingUp } from "@/ui/coming-up"
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
import { Avatar, initialsOf } from "@/ui/person"
import { Pagination } from "@/ui/pagination"
import { Callout, EmptyState, ErrorState, Skeleton, SkeletonRows } from "@/ui/state"
import { ColumnLabel, Meta, PageTitle, Sub } from "@/ui/text"
import { toast } from "@/ui/toast"
import { OwnPapersNote } from "@/ui/own-papers"
import { HeaderSpot } from "@/ui/page-header"

/**
 * The Director's queue: everything the Principal has approved and nobody has
 * yet authorised.
 *
 * The Principal answers "is this claim correct and should we pay it". The
 * Director answers "can the institution pay it, this month, against this
 * budget, alongside everything else being authorised". So beside the list sit
 * the two things that second question needs: the queue split by department,
 * and the year's budget (allocated, committed, paid).
 *
 * The Director is contest-blind: the server strips every flag, contest and
 * duplicate key from what this desk receives, and this screen names none of
 * them. The chain past the Principal is forward-only, so the Director has no
 * send-back; a super admin standing in keeps it as the rescue.
 */

const PAGE_SIZE = 50

/* ------------------------------------------------------------------------ */
/* Data: read out of director_queue() in backend/core/api/director.py        */
/* ------------------------------------------------------------------------ */

export type Claim = {
  id: string
  ticket_number: string | null
  paper_title: string
  journal_title: string | null
  owner_name: string
  owner_department: string | null
  owner_photo_url?: string | null
  status: string
  remuneration: number | null
  quartile: string | null
  calc_error: string | null
  cleared_by_name: string | null
  principal_approved_by_name: string | null
  principal_approved_at: string | null
  waiting_days: number | null
}

type DepartmentTotal = { department: string | null; count: number; amount: number }

type QueuePayload = {
  total: number
  limit: number
  offset: number
  results: Claim[]
  /** Over everything the filter matched, never the page. */
  totals: { count: number; amount: number; longest_wait_days: number | null }
  departments: string[]
  by_department?: DepartmentTotal[]
}

type BudgetSlice = {
  department: string | null
  allocated: number | null
  spent: number
  committed: number
  remaining: number | null
  used_fraction: number | null
}

type BudgetPayload = {
  financial_year: string
  college: BudgetSlice
  departments: BudgetSlice[]
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
  const standingIn = me?.role === "SUPER_ADMIN"

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
  const budget = useApi<BudgetPayload>(["budget-status", "current"], "/api/budgets", {
    enabled: allowed,
  })

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

  const selectable = rows.filter((r) => !r.calc_error)
  const selectedRows = rows.filter((r) => selected.has(r.id))
  const selectedTotal = selectedRows.reduce((sum, c) => sum + (c.remuneration || 0), 0)
  const totals = data?.totals

  const departmentOptions: ComboboxOption[] = [
    { value: "", label: "All departments" },
    ...(data?.departments ?? []).map((d) => ({ value: d, label: d })),
  ]

  return (
    <div className="page space-y-6">
      <header className="page-head">
        <div>
          <PageTitle>Authorisations</PageTitle>
          <Sub className="mt-1">
            Approved by the Principal and waiting on you. Finance pays only what carries your
            authorisation.
          </Sub>
          <OwnPapersNote className="mt-1" />
        </div>
        <HeaderSpot name="spot-authorisations" />
      </header>

      {/* Skeletons until the figures are real: a dash here would read as
          "nothing waiting" at the one moment the screen does not know. */}
      {!(isError && !data) && (
        <div className="flex flex-wrap items-baseline gap-x-8 gap-y-3 border-y border-line py-3">
          <Stat
            label="Waiting on you"
            loading={!totals}
            value={totals ? String(totals.count) : ""}
          />
          <Stat
            label="Comes to"
            loading={!totals}
            value={money(totals?.amount)}
            hint={department ? `From ${department}` : "Across every department"}
          />
          <Stat
            label="Longest wait"
            loading={!totals}
            value={
              totals?.longest_wait_days == null
                ? "None"
                : totals.longest_wait_days === 0
                  ? "Today"
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

      <div className="grid grid-cols-[minmax(0,1fr)] gap-8 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <section className="min-w-0 space-y-4" aria-label="Approved claims">
          <div className={filterBar}>
            <Combobox
              value={department}
              onChange={(next) => setParam("department", next)}
              options={departmentOptions}
              placeholder="All departments"
              aria-label="Filter by department"
              className="w-full sm:w-56"
            />
            <Combobox
              value={sort}
              onChange={(next) => setParam("sort", next)}
              options={[
                { value: "waiting", label: "Longest waiting first" },
                { value: "recent", label: "Most recently approved" },
                { value: "amount", label: "Largest amount first" },
                { value: "department", label: "By department" },
              ]}
              aria-label="Sort"
              className="w-full sm:w-56"
            />
          </div>

          {selectedRows.length > 0 && (
            // Pinned under the header while the list scrolls: on a phone the
            // rows being ticked are a screen below where the button was.
            <div className="sticky top-14 z-20 flex flex-wrap items-center justify-between gap-3 rounded-lg bg-accent-wash px-4 py-3 shadow-pop md:top-2">
              <p className="text-sm tabular">
                <span className="font-semibold">{selectedRows.length}</span> selected ·{" "}
                <span className="font-semibold">{money(selectedTotal)}</span>
              </p>
              <div className="flex flex-wrap gap-2">
                <Button kind="quiet" size="md" onClick={() => setSelected(new Set())}>
                  Clear selection
                </Button>
                <Button kind="primary" size="md" onClick={() => setBulkOpen(true)}>
                  <Stamp />
                  Review and authorise {selectedRows.length}
                </Button>
              </div>
            </div>
          )}

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
              // With a department chosen, "every approved claim has been
              // authorised" would be a claim about the whole college made
              // from one department's empty page.
              art={department ? "no-results" : "empty-queue"}
              icon={CircleCheck}
              title={department ? `Nothing waiting from ${department}` : "Nothing is waiting on you"}
              message={
                department
                  ? "Another department may still have claims waiting. Clear the filter to see the whole queue."
                  : "Every approved claim has been authorised. The Principal's next approvals appear here as soon as they are signed."
              }
              action={
                department ? (
                  <Button kind="default" size="sm" onClick={() => setParam("department", "")}>
                    See every department
                  </Button>
                ) : (
                  <ComingUp desk="director" />
                )
              }
            />
          ) : (
            <>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <Checkbox
                  checked={selectedRows.length === selectable.length && selectable.length > 0}
                  disabled={selectable.length === 0}
                  onCheckedChange={(v) =>
                    setSelected(v === true ? new Set(selectable.map((r) => r.id)) : new Set())
                  }
                  label={`Select all ${selectable.length} on this page`}
                />
                {!standingIn && (
                  <Meta className="text-xs">
                    A question about an approval goes to the Principal. This desk only moves
                    claims forward.
                  </Meta>
                )}
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
                    // Director and Finance are forward-only (the college's
                    // rule, enforced by the server); a super admin standing
                    // in keeps the send-back as the rescue.
                    onSendBack={
                      standingIn ? () => setActing({ claim, mode: "send-back" }) : undefined
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
        </section>

        <aside className="min-w-0 space-y-8" aria-label="Where the money goes">
          <DepartmentTotals
            rows={data?.by_department}
            loading={!data}
            active={department}
            onPick={(d) => setParam("department", d === department ? "" : d)}
          />
          <BudgetPanel
            data={budget.data}
            loading={budget.isLoading}
            failed={budget.isError}
            department={department}
          />
        </aside>
      </div>

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
/* Beside the list: by department, and the budget                           */
/* ------------------------------------------------------------------------ */

function DepartmentTotals({
  rows,
  loading,
  active,
  onPick,
}: {
  rows: DepartmentTotal[] | undefined
  loading: boolean
  active: string
  onPick: (department: string) => void
}) {
  return (
    <section>
      <h2 className="text-sm font-semibold">Waiting, by department</h2>
      <Meta className="block text-xs">Pick one to filter the list.</Meta>
      {loading ? (
        <SkeletonRows rows={4} rowHeight={32} />
      ) : !rows || rows.length === 0 ? (
        <Meta className="mt-2 block">Nothing waiting.</Meta>
      ) : (
        <ul className="mt-2 divide-y divide-line border-y border-line">
          {rows.map((r) => {
            const name = r.department ?? ""
            const on = !!name && name === active
            return (
              <li key={name || "none"}>
                <button
                  type="button"
                  disabled={!name}
                  aria-pressed={on}
                  onClick={() => onPick(name)}
                  className={cn(
                    "flex w-full items-baseline justify-between gap-3 rounded-sm px-2 py-2 text-left text-sm",
                    "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
                    name && "hover:bg-sunken",
                    on && "bg-accent-wash"
                  )}
                >
                  <span className="min-w-0 truncate">
                    {name || "No department"}{" "}
                    <span className="text-ink-3">· {r.count}</span>
                  </span>
                  <span className="shrink-0 font-semibold tabular">{money(r.amount)}</span>
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

function BudgetPanel({
  data,
  loading,
  failed,
  department,
}: {
  data: BudgetPayload | undefined
  loading: boolean
  failed: boolean
  department: string
}) {
  const slice = department
    ? data?.departments.find((d) => d.department === department) ?? {
        department,
        allocated: null,
        spent: 0,
        committed: 0,
        remaining: null,
        used_fraction: null,
      }
    : data?.college

  return (
    <section>
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold">
          Budget {data ? data.financial_year : "this year"}
        </h2>
        <Link
          to="/budget"
          className="rounded-sm text-sm text-accent underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          Open the budget
        </Link>
      </div>
      <Meta className="block text-xs">{department || "The whole college"}</Meta>
      {loading ? (
        <SkeletonRows rows={3} rowHeight={28} />
      ) : failed || !slice ? (
        <Meta className="mt-2 block">The budget could not be loaded. The queue is unaffected.</Meta>
      ) : (
        <BudgetFigures slice={slice} />
      )}
    </section>
  )
}

function BudgetFigures({ slice }: { slice: BudgetSlice }) {
  const allocated = slice.allocated
  const used = allocated ? Math.min(1, (slice.spent + slice.committed) / allocated) : 0
  const over = slice.remaining != null && slice.remaining < 0
  return (
    <div className="mt-2 space-y-3">
      <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1.5 text-sm">
        <dt className="text-ink-2">Allocated</dt>
        <dd className="text-right font-semibold tabular">
          {allocated == null ? <span className="font-normal text-ink-3">Not set</span> : money(allocated)}
        </dd>
        <dt className="text-ink-2">Committed</dt>
        <dd className="text-right tabular">{money(slice.committed)}</dd>
        <dt className="text-ink-2">Paid</dt>
        <dd className="text-right tabular">{money(slice.spent)}</dd>
        {slice.remaining != null && (
          <>
            <dt className="text-ink-2">{over ? "Over by" : "Left"}</dt>
            <dd className={cn("text-right font-semibold tabular", over && "text-critical")}>
              {money(Math.abs(slice.remaining))}
            </dd>
          </>
        )}
      </dl>
      {allocated ? (
        <div
          className="h-2 overflow-hidden rounded-full bg-sunken"
          role="img"
          aria-label={`${Math.round(used * 100)} percent of the allocation paid or committed`}
        >
          <div
            className={cn("h-full rounded-full", over ? "bg-critical" : "bg-accent")}
            style={{ width: `${Math.round(used * 100)}%` }}
          />
        </div>
      ) : (
        <Meta className="block text-xs">
          No allocation has been set for this year, so there is no ceiling to measure against.
          Finance or a super admin sets it on the budget page.
        </Meta>
      )}
      <Meta className="block text-xs">
        Committed counts everything checked, approved or authorised but not yet paid, including
        this queue.
      </Meta>
    </div>
  )
}

/* ------------------------------------------------------------------------ */
/* One claim                                                                 */
/* ------------------------------------------------------------------------ */

function approvedOn(iso: string | null): string | null {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })
}

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
  const approved = approvedOn(claim.principal_approved_at)
  const blocked = !!claim.calc_error
  return (
    <li className="flex gap-3 py-4">
      <span className="pt-2">
        <Checkbox
          checked={checked}
          disabled={blocked}
          onCheckedChange={(v) => onToggle(v === true)}
          aria-label={`Select ${claim.owner_name}, ${claim.paper_title}`}
        />
      </span>

      <Avatar
        person={{
          name: claim.owner_name,
          initials: initialsOf(claim.owner_name),
          photo_url: claim.owner_photo_url ?? null,
        }}
        size="md"
      />

      <div className="min-w-0 flex-1 space-y-2">
        <div className="flex flex-col gap-x-4 gap-y-1 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold">
              {claim.owner_name}
              {claim.owner_department && (
                <span className="font-normal text-ink-2"> · {claim.owner_department}</span>
              )}
            </p>
            <Link
              to={`/papers/${claim.id}`}
              className="block truncate rounded-sm text-base underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              {paperTitle(claim.paper_title)}
            </Link>
            <Meta className="block truncate">
              {[claim.journal_title, claim.quartile, claim.ticket_number]
                .filter(Boolean)
                .join(" · ")}
            </Meta>
          </div>
          <div className="flex shrink-0 items-baseline gap-2 sm:block sm:text-right">
            <p className="text-lg font-semibold tabular">{money(claim.remuneration)}</p>
            {approved && (
              <Meta className="block text-xs">
                Approved {approved}
                {claim.waiting_days != null &&
                  ` · ${
                    claim.waiting_days === 0
                      ? "today"
                      : `${claim.waiting_days} ${claim.waiting_days === 1 ? "day" : "days"} ago`
                  }`}
              </Meta>
            )}
          </div>
        </div>

        {blocked && (
          <Callout tone="critical" title="This amount could not be worked out">
            {claim.calc_error} It cannot be authorised until the amount is fixed.
          </Callout>
        )}

        <div className="flex flex-wrap items-center justify-between gap-2">
          <Meta className="text-xs">
            Approved by {claim.principal_approved_by_name || "the Principal"}
            {claim.cleared_by_name ? `, checked by ${claim.cleared_by_name}` : ""}
          </Meta>
          <div className="flex flex-wrap gap-2">
            {onSendBack && (
              <Button kind="quiet" size="sm" onClick={onSendBack}>
                Send back
              </Button>
            )}
            <Button
              kind="primary"
              size="sm"
              onClick={onAuthorise}
              disabled={blocked}
              title={blocked ? "The amount could not be worked out" : undefined}
            >
              Authorise
            </Button>
          </div>
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
        `Authorised: ${money(result.remuneration)} released to Finance${
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

              <Field label="Note" hint="Optional. Kept on the ticket history.">
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
      toast.ok(`Sent back. The Principal will see why${claim.ticket_number ? ` on ${claim.ticket_number}` : ""}`)
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
              placeholder="Takes the department past its allocation for the quarter, hold until April"
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
  const byDept = Object.entries(
    claims.reduce<Record<string, { count: number; amount: number }>>((acc, c) => {
      const k = c.owner_department || "No department"
      acc[k] = {
        count: (acc[k]?.count ?? 0) + 1,
        amount: (acc[k]?.amount ?? 0) + (c.remuneration || 0),
      }
      return acc
    }, {})
  ).sort((a, b) => b[1].amount - a[1].amount)

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
              <div>
                <ColumnLabel className="block">Releasing</ColumnLabel>
                <p className="mt-0.5 text-2xl font-semibold tabular">{money(total)}</p>
                <Meta className="mt-1 block">
                  across {claims.length} {claims.length === 1 ? "claim" : "claims"}
                </Meta>
              </div>
              <div>
                <ColumnLabel className="block">By department</ColumnLabel>
                <ul className="mt-1 divide-y divide-line border-y border-line text-sm">
                  {byDept.map(([d, v]) => (
                    <li key={d} className="flex justify-between gap-3 py-1.5">
                      <span className="min-w-0 truncate">
                        {d} <span className="text-ink-3">· {v.count}</span>
                      </span>
                      <span className="shrink-0 tabular">{money(v.amount)}</span>
                    </li>
                  ))}
                </ul>
              </div>
              <div>
                <ColumnLabel className="block">Claims in this batch</ColumnLabel>
                <ul className="mt-1 max-h-56 space-y-1.5 overflow-y-auto text-sm">
                  {claims.map((c) => (
                    <li key={c.id} className="flex items-center gap-2">
                      <Avatar
                        person={{
                          name: c.owner_name,
                          initials: initialsOf(c.owner_name),
                          photo_url: c.owner_photo_url ?? null,
                        }}
                        size="sm"
                      />
                      <span className="min-w-0 flex-1 truncate">{c.owner_name}</span>
                      <span className="shrink-0 tabular">{money(c.remuneration)}</span>
                    </li>
                  ))}
                </ul>
              </div>
              <Field label="Note" hint="Optional. Recorded against every claim in the batch.">
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
