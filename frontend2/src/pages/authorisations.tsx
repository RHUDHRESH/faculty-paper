import { thresholdFlag, type ClaimThreshold } from "@/ui/research-threshold"
import { useEffect, useMemo, useRef, useState } from "react"
import { Link, useNavigate, useSearchParams } from "react-router-dom"
import { CircleCheck, Stamp } from "lucide-react"

import { can, useAuth } from "@/app/auth"
import { ApiError } from "@/lib/api"
import { cn } from "@/lib/cn"
import { CHAIN, useApi, useApiMutation } from "@/lib/query"
import { Button } from "@/ui/button"
import { ClaimNoJump } from "@/ui/claim-number"
import { filterBar } from "@/ui/filter-bar"
import { ComingUp } from "@/ui/coming-up"
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/ui/dialog"
import { Field, Textarea } from "@/ui/field"
import { money } from "@/ui/paper"
import { Avatar, initialsOf } from "@/ui/person"
import { Pagination } from "@/ui/pagination"
import { useSlashToSearch } from "@/ui/queue-keys"
import { NoBulkSendBack, QueueTable, QuietSelect, SearchBox, reviewLink, useUrlFilters } from "@/ui/queue"
import { Callout, EmptyState, ErrorState, Skeleton, SkeletonRows } from "@/ui/state"
import { ColumnLabel, Meta, PageTitle, Sub } from "@/ui/text"
import { toast } from "@/ui/toast"
import { OwnPapersNote } from "@/ui/own-papers"
import { HeaderSpot } from "@/ui/page-header"
import { unshout } from "@/lib/names"

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
const FILTER_KEYS = ["q", "department", "sort"] as const

/* ------------------------------------------------------------------------ */
/* Data: read out of director_queue() in backend/core/api/director.py        */
/* ------------------------------------------------------------------------ */

export type Claim = ClaimThreshold & {
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
  const navigate = useNavigate()
  const allowed = can(me?.role).authorise
  const standingIn = me?.role === "SUPER_ADMIN"

  const { values, set, clear, active: filtered } = useUrlFilters(FILTER_KEYS)
  const { q, department } = values
  const sort = values.sort || "waiting"
  const [searchParams, setSearchParams] = useSearchParams()
  const page = Math.max(0, Number.parseInt(searchParams.get("page") ?? "0", 10) || 0)
  const searchRef = useRef<HTMLInputElement>(null)
  useSlashToSearch(searchRef)

  const [selected, setSelected] = useState<Map<string, Claim>>(new Map())
  const [acting, setActing] = useState<{ claim: Claim; mode: "authorise" | "send-back" } | null>(null)
  const [bulkOpen, setBulkOpen] = useState(false)
  const [batch, setBatch] = useState<Claim[]>([])
  const [activeRow, setActiveRow] = useState(0)

  function setPage(next: number) {
    setSearchParams(
      (prev) => {
        const p = new URLSearchParams(prev)
        if (next > 0) p.set("page", String(next))
        else p.delete("page")
        return p
      },
      { replace: true }
    )
  }

  const query = new URLSearchParams()
  if (q) query.set("q", q)
  if (department) query.set("department", department)
  query.set("sort", sort)
  query.set("limit", String(PAGE_SIZE))
  query.set("offset", String(page * PAGE_SIZE))

  const { data, isLoading, isError, error, refetch } = useApi<QueuePayload>(
    ["director-queue", q, department, sort, page],
    `/api/director/queue?${query.toString()}`,
    { enabled: allowed, placeholderData: (prev) => prev }
  )
  const budget = useApi<BudgetPayload>(["budget-status", "current"], "/api/budgets", {
    enabled: allowed,
  })

  const rows = useMemo(() => data?.results ?? [], [data])

  const href = (c: Claim) => {
    const f = new URLSearchParams()
    for (const k of FILTER_KEYS) if (values[k]) f.set(k, values[k])
    return reviewLink(c.id, "authorisations", filtered ? f : undefined)
  }

  // A selection made on one page is meaningless on the next, and a hidden
  // selection is how somebody authorises rows they cannot see.
  useEffect(() => {
    setSelected(new Map())
  }, [q, department, sort, page])

  useEffect(() => {
    setActiveRow((i) => Math.min(i, Math.max(0, rows.length - 1)))
  }, [rows.length])

  const selectable = rows.filter((r) => !r.calc_error)
  const selectedRows = rows.filter((r) => selected.has(r.id))
  const selectedTotal = selectedRows.reduce((sum, c) => sum + (c.remuneration || 0), 0)
  const totals = data?.totals

  function toggle(c: Claim) {
    if (c.calc_error) return
    setSelected((prev) => {
      const next = new Map(prev)
      if (next.has(c.id)) next.delete(c.id)
      else next.set(c.id, c)
      return next
    })
  }
  function toggleAll() {
    setSelected((prev) => {
      const every = selectable.length > 0 && selectable.every((c) => prev.has(c.id))
      return every ? new Map() : new Map(selectable.map((c) => [c.id, c]))
    })
  }

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null
      const tag = target?.tagName
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target?.isContentEditable) return
      if (document.querySelector('[role="dialog"]')) return
      if (rows.length === 0) return
      if (e.key === "j" || e.key === "ArrowDown") {
        e.preventDefault()
        setActiveRow((i) => Math.min(i + 1, rows.length - 1))
      } else if (e.key === "k" || e.key === "ArrowUp") {
        e.preventDefault()
        setActiveRow((i) => Math.max(i - 1, 0))
      } else if (e.key === "x") {
        e.preventDefault()
        const row = rows[activeRow]
        if (row) toggle(row)
      } else if (e.key === "Enter") {
        e.preventDefault()
        const row = rows[activeRow]
        if (row) navigate(href(row))
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, activeRow])

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

  const departmentOptions = data?.departments ?? []

  return (
    <div className="page space-y-5">
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

      <div className="space-y-10">
        <section className="min-w-0 space-y-4" aria-label="Approved claims">
          <div className={filterBar}>
            <SearchBox
              inputRef={searchRef}
              value={q}
              onCommit={(next) => set({ q: next })}
              placeholder="Claim no., title, claimant or journal"
              label="Search the queue"
            />
            <QuietSelect value={department} onChange={(v) => set({ department: v })} label="Filter by department">
              <option value="">All departments</option>
              {departmentOptions.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </QuietSelect>
            <QuietSelect value={sort} onChange={(v) => set({ sort: v === "waiting" ? "" : v })} label="Sort">
              <option value="waiting">Longest waiting first</option>
              <option value="recent">Most recently approved</option>
              <option value="amount">Largest amount first</option>
              <option value="department">By department</option>
            </QuietSelect>
            {filtered && (
              <Button kind="quiet" size="sm" onClick={clear}>
                Clear filters
              </Button>
            )}
          </div>
          <ClaimNoJump term={q} skip={new Set(rows.map((c) => c.id))} />

          {selectable.length > 0 && selectedRows.length === 0 && (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg bg-sunken px-4 py-3">
              <p className="text-sm">
                <span className="font-semibold">{selectable.length}</span> on this page {selectable.length === 1 ? "is" : "are"} ready to authorise.{" "}
                <span className="text-fg-muted">Each has an amount worked out.</span>
              </p>
              <Button
                kind="primary"
                size="sm"
                className="ml-auto"
                onClick={() => {
                  setBatch(selectable)
                  setBulkOpen(true)
                }}
              >
                <Stamp />
                Review the {selectable.length} ready
              </Button>
            </div>
          )}

          {selectedRows.length > 0 && (
            // Pinned under the header while the list scrolls: on a phone the
            // rows being ticked are a screen below where the button was.
            <div className="sticky top-14 z-20 space-y-2 rounded-lg bg-accent-wash px-4 py-3 shadow-pop md:top-2">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-sm tabular">
                  <span className="font-semibold">{selectedRows.length}</span> selected ·{" "}
                  <span className="font-semibold">{money(selectedTotal)}</span>
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button kind="quiet" size="md" onClick={() => setSelected(new Map())}>
                    Clear selection
                  </Button>
                  <Button
                    kind="primary"
                    size="md"
                    onClick={() => {
                      setBatch(selectedRows)
                      setBulkOpen(true)
                    }}
                  >
                    <Stamp />
                    Review and authorise {selectedRows.length}
                  </Button>
                </div>
              </div>
              {standingIn && <NoBulkSendBack />}
            </div>
          )}

          {isLoading && !data ? (
            <SkeletonRows rows={8} rowHeight={52} />
          ) : isError ? (
            <ErrorState
              title="Could not load the queue"
              message={
                error?.status === 403
                  ? "Not allowed. Only the Director, or a super admin standing in, can authorise."
                  : "The server did not answer. Nothing has been authorised."
              }
              onRetry={error?.status === 403 ? false : () => refetch()}
            />
          ) : rows.length === 0 ? (
            <EmptyState guide="authorise-the-month"
              // With a filter on, "every approved claim has been authorised"
              // would be a claim about the whole college made from one
              // search's empty page.
              art={filtered ? "no-results" : "empty-queue"}
              icon={CircleCheck}
              title={
                department
                  ? `Nothing waiting from ${department}`
                  : filtered
                    ? "No claim matches these filters"
                    : "Nothing is waiting on you"
              }
              message={
                filtered
                  ? "Another department or search may still have claims waiting. Clear the filters to see the whole queue."
                  : "Every approved claim has been authorised. The Principal's next approvals appear here as soon as they are signed."
              }
              action={
                filtered ? (
                  <Button kind="default" size="sm" onClick={clear}>
                    Show the whole queue
                  </Button>
                ) : (
                  <ComingUp desk="director" />
                )
              }
            />
          ) : (
            <>
              {!standingIn && (
                <Meta className="block text-xs">
                  A question about an approval goes to the Principal. This desk only moves claims forward.
                </Meta>
              )}
              <QueueTable
                label="Claims waiting to be authorised"
                rows={rows}
                reviewHref={href}
                showAmount
                minWidth="52rem"
                extra={{
                  header: "Approved",
                  className: "w-52",
                  cell: (c) => (
                    <ApprovalCell
                      claim={c}
                      onAuthorise={() => setActing({ claim: c, mode: "authorise" })}
                      // Director and Finance are forward-only (the college's
                      // rule, enforced by the server); a super admin standing
                      // in keeps the send-back as the rescue.
                      onSendBack={standingIn ? () => setActing({ claim: c, mode: "send-back" }) : undefined}
                    />
                  ),
                }}
                active={activeRow}
                onActive={setActiveRow}
                select={{
                  selected: new Set(selected.keys()),
                  onToggle: toggle,
                  onToggleAll: toggleAll,
                  disabled: (c) => !!c.calc_error,
                }}
              />
              <Pagination
                page={page}
                pageSize={PAGE_SIZE}
                total={data?.total ?? 0}
                onChange={(next) => setPage(next)}
              />
            </>
          )}
        </section>

        <aside className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-x-12 gap-y-8 md:grid-cols-2" aria-label="Where the money goes">
          <DepartmentTotals
            rows={data?.by_department}
            loading={!data}
            active={department}
            onPick={(d) => set({ department: d === department ? "" : d })}
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
          claims={batch}
          onClose={() => setBulkOpen(false)}
          onDone={() => setSelected(new Map())}
        />
      )}
    </div>
  )
}

/** Who approved it and when, and the row's own actions. */
function ApprovalCell({
  claim,
  onAuthorise,
  onSendBack,
}: {
  claim: Claim
  onAuthorise: () => void
  onSendBack?: () => void
}) {
  const approved = approvedOn(claim.principal_approved_at)
  const blocked = !!claim.calc_error
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-3">
        <span className="whitespace-nowrap text-xs text-fg-muted" title={`Approved by ${claim.principal_approved_by_name || "the Principal"}`}>
          {approved ?? "Approved"}
          {/* Not a flag: the research threshold explains a ₹0 or part amount. */}
          {thresholdFlag(claim) && <span className="block text-caution">{thresholdFlag(claim)}</span>}
        </span>
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
      {blocked && <p className="text-xs text-critical">The amount could not be worked out, so it cannot be authorised.</p>}
    </div>
  )
}

function approvedOn(iso: string | null): string | null {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "short" })
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
      toast.stamp(
        "Authorised",
        `${money(result.remuneration)} released to Finance${claim.ticket_number ? ` for ${claim.ticket_number}` : ""}.`
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
            {claim.owner_name} · {unshout(claim.paper_title)}
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

              <Field label="Note" hint="Optional. Kept on the claim history.">
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
            The Principal's approval is withdrawn and the claim returns to them. Nobody is
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
        toast.stamp("Authorised", `${res.approved} ${res.approved === 1 ? "claim" : "claims"}, ${money(res.total)} released to Finance.`)
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
