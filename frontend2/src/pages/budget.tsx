import { useEffect, useMemo, useState } from "react"
import { useSearchParams } from "react-router-dom"
import { Coins, Pencil, Plus } from "lucide-react"

import { can, useAuth } from "@/app/auth"
import { cn } from "@/lib/cn"
import { useApi, useApiMutation } from "@/lib/query"
import { Button } from "@/ui/button"
import { Combobox, type ComboboxOption } from "@/ui/combobox"
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
import { Field, Input, NumberInput } from "@/ui/field"
import { money } from "@/ui/paper"
import { Callout, EmptyState, ErrorState, Skeleton, SkeletonRows } from "@/ui/state"
import { stickyHeadCell, TableScroller } from "@/ui/table"
import { ColumnLabel, Meta, PageTitle, SectionTitle, Sub } from "@/ui/text"
import { toast } from "@/ui/toast"

/**
 * What the scheme was given for the year, and where it has gone.
 *
 * The column nobody was keeping is **committed**: a ticket the Principal has
 * approved is money the college already owes, even though Finance has not
 * moved it yet. A budget screen that reports only what has been *paid*
 * understates the position by exactly the amount that is about to leave the
 * account — which is how a year's allocation gets spent twice, once on paper
 * and once in fact. So remaining here is `allocated − spent − committed`, and
 * the middle term is shown rather than folded into either neighbour.
 *
 * A department with no allocation set is not a department with a zero
 * allocation. It has no ceiling at all, and every figure derived from one —
 * remaining, the used bar — is blank rather than guessed. Rendering "no
 * budget" as ₹0 would put every unallocated department permanently over
 * budget by whatever it had legitimately spent.
 */

/* ------------------------------------------------------------------------ */
/* Data — read out of _budget_status() in backend/core/api.py               */
/* ------------------------------------------------------------------------ */

type BudgetSlice = {
  /** null on the college row — it is every department added together. */
  department: string | null
  /** null when nobody has set one. Not zero. */
  allocated: number | null
  spent: number
  committed: number
  remaining: number | null
  /** `(spent + committed) / allocated`, or null with no allocation. */
  used_fraction: number | null
  budget_id: string | null
  note: string | null
}

type BudgetPayload = {
  financial_year: string
  starts: string
  ends: string
  college: BudgetSlice
  departments: BudgetSlice[]
  years_on_record: string[]
}

type SetBudgetBody = {
  financial_year: string
  department: string | null
  amount: number
  note?: string
}

/* ------------------------------------------------------------------------ */
/* Page                                                                      */
/* ------------------------------------------------------------------------ */

export function Budget() {
  const { me } = useAuth()
  const allowed = can(me?.role).viewReports
  const mayEdit = can(me?.role).manageMoney

  const [searchParams, setSearchParams] = useSearchParams()
  const requestedYear = searchParams.get("fy") ?? ""

  // `editing` is deliberately not cleared when the dialog closes. The dialog
  // animates out over a frame or two, and blanking the slice underneath it
  // flips the title from "Change the allocation" to "Set an allocation" on
  // the way past.
  const [editing, setEditing] = useState<BudgetSlice | null>(null)
  const [editOpen, setEditOpen] = useState(false)
  const [adding, setAdding] = useState(false)

  const query = requestedYear ? `?financial_year=${encodeURIComponent(requestedYear)}` : ""
  const { data, isLoading, isError, error, refetch } = useApi<BudgetPayload>(
    ["budgets", requestedYear],
    `/api/budgets${query}`,
    { enabled: allowed }
  )

  // The year list arrives with the figures, so on the first load — and on
  // every failed one — there is nothing to build a picker from. Remembering
  // the years the server has already named keeps the control on screen while
  // the next year is in flight, which is exactly when a reader wants it
  // again: they have just picked the wrong one.
  const [seenYears, setSeenYears] = useState<string[]>([])
  useEffect(() => {
    if (!data) return
    setSeenYears((prev) => {
      const merged = new Set([...prev, ...data.years_on_record, data.financial_year])
      return [...merged].sort().reverse()
    })
  }, [data])

  // The server decides which year "no filter" means. Until it has answered,
  // fall back to the same April-to-March rule it uses, so the header and the
  // set-an-allocation dialog can both name a year before the figures land.
  const fy = data?.financial_year || requestedYear || currentFinancialYear()

  const yearOptions: ComboboxOption[] = useMemo(() => {
    const all = new Set(seenYears)
    all.add(currentFinancialYear())
    all.add(fy)
    return [...all]
      .sort()
      .reverse()
      .map((y) => ({ value: y, label: `FY ${y}` }))
  }, [seenYears, fy])

  function selectYear(next: string) {
    setSearchParams((prev) => {
      const p = new URLSearchParams(prev)
      if (next) p.set("fy", next)
      else p.delete("fy")
      return p
    })
  }

  function openEdit(slice: BudgetSlice) {
    setEditing(slice)
    setEditOpen(true)
  }

  if (!allowed) {
    return (
      <div className="page py-8">
        <ErrorState
          title="Not open to this account"
          message="The budget is money. Finance, the Principal and the research cell can read it; a head of department cannot."
        />
      </div>
    )
  }

  const departments = data?.departments ?? []
  // Departments that have already been given an allocation are not offered
  // again in the "add" dialog — the endpoint would update rather than
  // create, and a form that says Add while quietly overwriting is worse
  // than one that sends you to the row you meant to edit.
  const allocatedDepartments = new Set(
    departments.filter((d) => d.budget_id).map((d) => d.department ?? "")
  )

  return (
    <div className="page space-y-8">
      <header className="space-y-4">
        <div>
          <PageTitle>Budget</PageTitle>
          <Sub className="mt-1">
            What the scheme was allocated this year, what has gone out, and what is already
            owed but not yet paid.
          </Sub>
        </div>

        {/* Outside the loading and error branches on purpose: a reader who
            has landed on a year that will not load still needs a way off it,
            and a retry button on its own cannot get them there. */}
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Financial year" className="w-44 shrink-0">
            <Combobox
              value={fy}
              onChange={selectYear}
              options={yearOptions}
              searchPlaceholder="Type a year…"
            />
          </Field>
          {mayEdit && (
            <Button
              kind="primary"
              size="md"
              onClick={() => setAdding(true)}
              className="w-full sm:w-auto"
            >
              <Plus />
              Set an allocation
            </Button>
          )}
        </div>
      </header>

      {isLoading ? (
        <BudgetSkeleton />
      ) : isError ? (
        <ErrorState
          title={`Could not load the budget for FY ${fy}`}
          message={
            error?.status === 403
              ? "Not allowed. Finance, the Principal and the research cell can read this."
              : "The server did not answer, so every figure below is unknown rather than zero. No allocation has been changed."
          }
          onRetry={error?.status === 403 ? undefined : () => void refetch()}
        />
      ) : !data ? (
        // Deliberately an error and not an empty state. Nothing has been
        // established about this year, and "no budget has been allocated"
        // is a claim the page has no evidence for.
        <ErrorState
          title={`Nothing came back for FY ${fy}`}
          message="The request finished without any figures. Try again — no allocation has been changed."
          onRetry={() => void refetch()}
        />
      ) : (
        <>
          <CollegePosition
            slice={data.college}
            fy={data.financial_year}
            starts={data.starts}
            ends={data.ends}
            mayEdit={mayEdit}
            onEdit={openEdit}
          />

          <section className="space-y-3">
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
              <SectionTitle>By department</SectionTitle>
              <Meta>
                {departments.length} {departments.length === 1 ? "department" : "departments"} with
                an allocation or a spend
              </Meta>
            </div>

            {departments.length === 0 ? (
              <EmptyState
                art="no-budget"
                icon={Coins}
                title="No department has an allocation or a spend yet"
                message={`Nothing at all is recorded against a department for FY ${data.financial_year}. One appears here as soon as it is given an allocation, or as soon as one of its papers is approved or paid.`}
                action={
                  mayEdit ? (
                    <Button kind="default" size="sm" onClick={() => setAdding(true)}>
                      <Plus />
                      Set an allocation
                    </Button>
                  ) : undefined
                }
              />
            ) : (
              <>
                <DepartmentCards
                  rows={departments}
                  college={data.college}
                  mayEdit={mayEdit}
                  onEdit={openEdit}
                />
                <DepartmentTable
                  rows={departments}
                  college={data.college}
                  mayEdit={mayEdit}
                  onEdit={openEdit}
                />
              </>
            )}
          </section>
        </>
      )}

      {mayEdit && (
        <>
          <AllocationDialog
            open={adding}
            onOpenChange={setAdding}
            fy={fy}
            slice={null}
            takenDepartments={allocatedDepartments}
            collegeAllocated={Boolean(data?.college.budget_id)}
          />
          <AllocationDialog
            open={editOpen}
            onOpenChange={setEditOpen}
            fy={fy}
            slice={editing}
            takenDepartments={allocatedDepartments}
            collegeAllocated={Boolean(data?.college.budget_id)}
          />
        </>
      )}
    </div>
  )
}

/** The shape of the loaded page rather than a stack of grey bricks — four
 *  figures, a bar, then rows — so the numbers land where the placeholders
 *  were instead of shoving the page down when they arrive. */
function BudgetSkeleton() {
  return (
    <div className="space-y-8">
      <section className="space-y-4">
        <Skeleton className="h-5 w-56" />
        <div className="grid grid-cols-2 gap-x-6 gap-y-4 lg:grid-cols-4">
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i}>
              <Skeleton className="h-3 w-20" />
              <Skeleton className="mt-2 h-7 w-32" />
            </div>
          ))}
        </div>
        <Skeleton className="h-2 w-full rounded-full" />
      </section>
      <SkeletonRows rows={6} rowHeight={52} />
    </div>
  )
}

/* ------------------------------------------------------------------------ */
/* The college position                                                      */
/* ------------------------------------------------------------------------ */

function CollegePosition({
  slice,
  fy,
  starts,
  ends,
  mayEdit,
  onEdit,
}: {
  slice: BudgetSlice
  fy: string
  starts: string
  ends: string
  mayEdit: boolean
  onEdit: (slice: BudgetSlice) => void
}) {
  const over = isOver(slice)

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <SectionTitle>The college, FY {fy}</SectionTitle>
        <Meta>
          {formatDay(starts)} to {formatDay(ends)}
        </Meta>
      </div>

      <div className="grid grid-cols-2 gap-x-6 gap-y-4 lg:grid-cols-4">
        <Figure label="Allocated" value={slice.allocated} muted={slice.allocated === null} />
        <Figure label="Paid out" value={slice.spent} />
        <Figure
          label="Committed"
          value={slice.committed}
          hint="Approved, not yet paid — the college owes this"
        />
        <Figure
          label={over ? "Over by" : "Left"}
          value={slice.remaining === null ? null : Math.abs(slice.remaining)}
          tone={over ? "critical" : slice.remaining === null ? undefined : "positive"}
          muted={slice.remaining === null}
        />
      </div>

      <UsedBar slice={slice} />

      {slice.note && <Meta className="block">{slice.note}</Meta>}

      {slice.allocated === null && (
        <Callout tone="caution" title="No allocation is set for this year">
          Without one there is no ceiling to measure against, so nothing here can say whether
          the college is within budget — only what it has spent and what it owes.
        </Callout>
      )}

      {over && (
        <Callout tone="critical" title="Past the allocation">
          Paid and committed together come to {money(slice.spent + slice.committed)} against an
          allocation of {money(slice.allocated)}. The committed part is not yet out of the
          account, so this is a position to correct rather than a payment to reverse.
        </Callout>
      )}

      {/* The one control that has to survive a 375px screen. On a phone the
          department table becomes a card list further down; without this the
          college's own allocation would have no row to be edited from. */}
      {mayEdit && (
        <Button
          kind={slice.budget_id ? "quiet" : "default"}
          size="sm"
          onClick={() => onEdit(slice)}
          className="w-full sm:w-auto"
        >
          {slice.budget_id ? <Pencil /> : <Plus />}
          {slice.budget_id ? "Change the college allocation" : "Set an allocation for the college"}
        </Button>
      )}
    </section>
  )
}

function Figure({
  label,
  value,
  hint,
  tone,
  muted,
}: {
  label: string
  value: number | null
  hint?: string
  tone?: "positive" | "critical"
  muted?: boolean
}) {
  return (
    <div>
      <ColumnLabel className="block">{label}</ColumnLabel>
      <p
        className={cn(
          "mt-1 text-xl font-semibold tabular sm:text-2xl",
          tone === "positive" && "text-positive",
          tone === "critical" && "text-critical",
          muted && "text-fg-subtle"
        )}
      >
        {value === null ? "Not set" : money(value)}
      </p>
      {hint && <Meta className="mt-0.5 block text-xs">{hint}</Meta>}
    </div>
  )
}

/**
 * Paid and committed as two segments of one allocation.
 *
 * They are drawn as separate segments rather than one total because the two
 * are undoable to different degrees: what is paid is gone, what is committed
 * is a decision that can still be revisited. A single bar tells you the year
 * is 90% used; this one tells you how much of that 90% you could still get
 * back.
 */
function UsedBar({ slice, compact }: { slice: BudgetSlice; compact?: boolean }) {
  if (slice.allocated === null || slice.allocated <= 0) return null

  const spentShare = Math.max(0, Math.min(1, slice.spent / slice.allocated))
  const committedShare = Math.max(0, Math.min(1 - spentShare, slice.committed / slice.allocated))
  const used = slice.used_fraction ?? 0
  const over = isOver(slice)

  return (
    <div className="space-y-1.5">
      <div
        className="flex h-2 w-full overflow-hidden rounded-full bg-sunken"
        role="img"
        aria-label={`${Math.round(used * 100)} per cent of the allocation is paid or committed`}
      >
        {/* Past the ceiling the whole bar turns critical. Two tidy segments
            filling the track exactly to its end otherwise read as a year
            that came out even, which is the opposite of what happened. */}
        <span
          className={cn("block transition-[width] duration-500", over ? "bg-critical" : "bg-accent")}
          style={{ width: `${spentShare * 100}%` }}
        />
        <span
          className={cn(
            "block transition-[width] duration-500",
            over ? "bg-critical" : "bg-caution"
          )}
          style={{ width: `${committedShare * 100}%` }}
        />
      </div>
      {!compact && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <Legend className={over ? "bg-critical" : "bg-accent"}>Paid {money(slice.spent)}</Legend>
          <Legend className={over ? "bg-critical" : "bg-caution"}>
            Committed {money(slice.committed)}
          </Legend>
          <Meta className="tabular">{Math.round(used * 100)}% of the allocation</Meta>
        </div>
      )}
    </div>
  )
}

function Legend({ className, children }: { className: string; children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-sm text-fg-muted">
      <span className={cn("size-2 shrink-0 rounded-full", className)} aria-hidden />
      {children}
    </span>
  )
}

/** The over-allocation flag, next to the name rather than only in the "left"
 *  column — one red figure among five right-aligned ones is missable, and
 *  being over the ceiling is the single thing this page exists to surface. */
function OverTag() {
  return (
    <span className="ml-2 inline-block rounded-sm bg-critical-wash px-1.5 py-0.5 text-xs font-medium text-critical">
      Over
    </span>
  )
}

/* ------------------------------------------------------------------------ */
/* The department table                                                      */
/* ------------------------------------------------------------------------ */

/**
 * Bespoke `<table>` markup rather than `<Table>`, because of the footer: the
 * college total has to sit in the same column grid as the departments above
 * it, and a generic column renderer has nowhere to put a `<tfoot>`. Hidden
 * below the `sm` breakpoint, where `DepartmentCards` says the same thing
 * without asking a phone to scroll sideways to reach an edit button.
 */
function DepartmentTable({
  rows,
  college,
  mayEdit,
  onEdit,
}: {
  rows: BudgetSlice[]
  college: BudgetSlice
  mayEdit: boolean
  onEdit: (slice: BudgetSlice) => void
}) {
  return (
    <div className="hidden sm:block">
      <TableScroller minWidth="48rem">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr>
              <th scope="col" className={stickyHeadCell}>
                <ColumnLabel>Department</ColumnLabel>
              </th>
              <th scope="col" className={cn(stickyHeadCell, "w-36 text-right")}>
                <ColumnLabel>Allocated</ColumnLabel>
              </th>
              <th scope="col" className={cn(stickyHeadCell, "w-32 text-right")}>
                <ColumnLabel>Paid</ColumnLabel>
              </th>
              <th scope="col" className={cn(stickyHeadCell, "w-32 text-right")}>
                <ColumnLabel>Committed</ColumnLabel>
              </th>
              <th scope="col" className={cn(stickyHeadCell, "w-32 text-right")}>
                <ColumnLabel>Left</ColumnLabel>
              </th>
              {mayEdit && (
                <th scope="col" className={cn(stickyHeadCell, "w-28 text-right")}>
                  <ColumnLabel>Allocation</ColumnLabel>
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={row.department ?? "unrecorded"}
                className="row border-b border-line last:border-b-0"
              >
                <td className="px-3 py-2.5 align-middle">
                  <span className="block">
                    {row.department || "No department recorded"}
                    {isOver(row) && <OverTag />}
                  </span>
                  {row.note && <Meta className="mt-0.5 block truncate">{row.note}</Meta>}
                </td>
                <MoneyCell value={row.allocated} placeholder="Not set" />
                <MoneyCell value={row.spent} />
                <MoneyCell value={row.committed > 0 ? row.committed : null} />
                <RemainingCell slice={row} />
                {mayEdit && (
                  <td className="px-3 py-2.5 text-right align-middle">
                    <AllocationButton slice={row} onEdit={onEdit} />
                  </td>
                )}
              </tr>
            ))}
          </tbody>
          <tfoot>
            {/* Not the sum of the rows above it. A paper filed by somebody
                with no department on record still spends the college's
                money, and has no departmental row to be counted in. */}
            <tr className="border-t border-edge bg-surface">
              <th scope="row" className="px-3 py-2.5 text-left align-middle font-medium">
                <span className="block">
                  The college
                  {isOver(college) && <OverTag />}
                </span>
                <Meta className="mt-0.5 block">Every department together</Meta>
              </th>
              <MoneyCell value={college.allocated} placeholder="Not set" strong />
              <MoneyCell value={college.spent} strong />
              <MoneyCell value={college.committed > 0 ? college.committed : null} strong />
              <RemainingCell slice={college} strong />
              {mayEdit && (
                <td className="px-3 py-2.5 text-right align-middle">
                  <AllocationButton slice={college} onEdit={onEdit} />
                </td>
              )}
            </tr>
          </tfoot>
        </table>
      </TableScroller>
    </div>
  )
}

function MoneyCell({
  value,
  placeholder = "—",
  strong,
}: {
  value: number | null
  placeholder?: string
  strong?: boolean
}) {
  return (
    <td className={cn("px-3 py-2.5 text-right align-middle tabular", strong && "font-medium")}>
      {value === null ? <Meta>{placeholder}</Meta> : money(value)}
    </td>
  )
}

function RemainingCell({ slice, strong }: { slice: BudgetSlice; strong?: boolean }) {
  const over = isOver(slice)
  return (
    <td
      className={cn(
        "px-3 py-2.5 text-right align-middle tabular",
        strong && "font-medium",
        over && "text-critical",
        !over && slice.remaining !== null && "text-positive"
      )}
    >
      {slice.remaining === null ? (
        <Meta>—</Meta>
      ) : over ? (
        `over ${money(Math.abs(slice.remaining))}`
      ) : (
        money(slice.remaining)
      )}
    </td>
  )
}

/**
 * The one control that sets or changes an allocation, wherever it appears.
 *
 * It used to carry `.reveal`, which only reaches full opacity on
 * `.row:hover` or `.row:focus-within`. A touch screen fires neither, so on a
 * phone the sole route to setting a department's budget was an invisible
 * button: the page could be read and never used. It is plainly visible at
 * all times now, and it says *set* or *edit* according to whether there is
 * an allocation to change, because those are different decisions.
 */
function AllocationButton({
  slice,
  onEdit,
  className,
}: {
  slice: BudgetSlice
  onEdit: (slice: BudgetSlice) => void
  className?: string
}) {
  const who = slice.department || "the college"
  return (
    <Button
      kind={slice.budget_id ? "quiet" : "default"}
      size="sm"
      className={className}
      onClick={() => onEdit(slice)}
      aria-label={
        slice.budget_id ? `Change the allocation for ${who}` : `Set an allocation for ${who}`
      }
    >
      {slice.budget_id ? <Pencil /> : <Plus />}
      {slice.budget_id ? "Edit" : "Set"}
    </Button>
  )
}

/* ------------------------------------------------------------------------ */
/* The department list, for a phone                                          */
/* ------------------------------------------------------------------------ */

/**
 * The same five figures stacked, for screens narrower than `sm`.
 *
 * A six-column table on a 375px screen is a 768px table inside a sideways
 * scroller, and the action column is the one furthest off the right edge —
 * so the very control Finance opens this page to press is the last thing
 * they can reach, if they find it at all. Below `sm` the rows become cards
 * and the control comes with them.
 */
function DepartmentCards({
  rows,
  college,
  mayEdit,
  onEdit,
}: {
  rows: BudgetSlice[]
  college: BudgetSlice
  mayEdit: boolean
  onEdit: (slice: BudgetSlice) => void
}) {
  return (
    <ul className="divide-y divide-line sm:hidden">
      {rows.map((row) => (
        <li key={row.department ?? "unrecorded"} className="py-4">
          <DepartmentCard slice={row} mayEdit={mayEdit} onEdit={onEdit} />
        </li>
      ))}
      <li className="border-t border-edge py-4">
        <DepartmentCard
          slice={college}
          label="The college"
          hint="Every department together"
          mayEdit={mayEdit}
          onEdit={onEdit}
        />
      </li>
    </ul>
  )
}

function DepartmentCard({
  slice,
  label,
  hint,
  mayEdit,
  onEdit,
}: {
  slice: BudgetSlice
  label?: string
  hint?: string
  mayEdit: boolean
  onEdit: (slice: BudgetSlice) => void
}) {
  const over = isOver(slice)
  return (
    <div className="space-y-3">
      <div>
        <span className="font-medium">
          {label ?? slice.department ?? "No department recorded"}
          {over && <OverTag />}
        </span>
        {hint && <Meta className="block">{hint}</Meta>}
      </div>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
        <CardFigure term="Allocated" value={slice.allocated} placeholder="Not set" />
        <CardFigure term="Paid" value={slice.spent} />
        <CardFigure term="Committed" value={slice.committed > 0 ? slice.committed : null} />
        <CardFigure
          term={over ? "Over by" : "Left"}
          value={slice.remaining === null ? null : Math.abs(slice.remaining)}
          tone={over ? "critical" : slice.remaining === null ? undefined : "positive"}
        />
      </dl>

      <UsedBar slice={slice} compact />

      {slice.note && <Meta className="block">{slice.note}</Meta>}

      {mayEdit && <AllocationButton slice={slice} onEdit={onEdit} className="w-full" />}
    </div>
  )
}

function CardFigure({
  term,
  value,
  placeholder = "—",
  tone,
}: {
  term: string
  value: number | null
  placeholder?: string
  tone?: "positive" | "critical"
}) {
  return (
    <div>
      <dt>
        <ColumnLabel>{term}</ColumnLabel>
      </dt>
      <dd
        className={cn(
          "tabular",
          tone === "positive" && "text-positive",
          tone === "critical" && "font-medium text-critical",
          value === null && "text-fg-subtle"
        )}
      >
        {value === null ? placeholder : money(value)}
      </dd>
    </div>
  )
}

/* ------------------------------------------------------------------------ */
/* Setting an allocation                                                     */
/* ------------------------------------------------------------------------ */

/**
 * One dialog for both setting and changing an allocation, because the server
 * has one endpoint for both — `POST /api/budgets` is an upsert keyed on
 * (financial year, department). Two dialogs would imply a distinction the
 * API does not make, and the "create" one would silently overwrite.
 */
function AllocationDialog({
  open,
  onOpenChange,
  fy,
  slice,
  takenDepartments,
  collegeAllocated,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  fy: string
  /** null when adding a fresh allocation rather than editing a row. */
  slice: BudgetSlice | null
  takenDepartments: Set<string>
  collegeAllocated: boolean
}) {
  const [department, setDepartment] = useState("")
  const [amount, setAmount] = useState("")
  const [note, setNote] = useState("")
  const [confirmDelete, setConfirmDelete] = useState(false)

  const departmentsQuery = useApi<string[]>(["meta", "departments"], "/api/meta/departments", {
    enabled: open,
  })

  // Every open starts from what is actually on the row, not from whatever
  // the last open left behind.
  useEffect(() => {
    if (!open) return
    setDepartment(slice?.department ?? "")
    setAmount(slice?.allocated != null ? String(slice.allocated) : "")
    setNote(slice?.note ?? "")
    setConfirmDelete(false)
  }, [open, slice])

  const save = useApiMutation<SetBudgetBody, { ok: boolean; created: boolean }>("/api/budgets", {
    invalidates: [["budgets"]],
  })
  const remove = useApiMutation<void, { ok: boolean }>(
    () => `/api/budgets/${slice?.budget_id ?? ""}`,
    { method: "DELETE", invalidates: [["budgets"]] }
  )

  const departmentOptions: ComboboxOption[] = [
    {
      value: "",
      label: "The college as a whole",
      hint: collegeAllocated && !slice ? "already allocated — this replaces it" : undefined,
    },
    ...(departmentsQuery.data || []).map((d) => ({
      value: d,
      label: d,
      hint: takenDepartments.has(d) && slice?.department !== d ? "already allocated" : undefined,
    })),
  ]

  const parsed = Number.parseFloat(amount)
  const amountValid = amount.trim() !== "" && Number.isFinite(parsed) && parsed >= 0
  const negative = amount.trim() !== "" && Number.isFinite(parsed) && parsed < 0

  const target = department || "the college as a whole"
  // Whichever way the dialog was opened, an allocation that already exists
  // is about to be overwritten. Worth saying before Save, not after.
  const replacing = slice
    ? Boolean(slice.budget_id)
    : department
      ? takenDepartments.has(department)
      : collegeAllocated

  async function submit() {
    if (!amountValid) return
    try {
      const result = await save.mutateAsync({
        financial_year: fy,
        department: department || null,
        amount: parsed,
        note: note.trim() || undefined,
      })
      toast.ok(
        `${result.created ? "Allocated" : "Updated"} — ${money(parsed)} to ${target} for FY ${fy}`
      )
      onOpenChange(false)
    } catch (err) {
      toast.fail(err)
    }
  }

  async function deleteAllocation() {
    try {
      await remove.mutateAsync(undefined as never)
      toast.ok(`Allocation removed — ${target} has no ceiling for FY ${fy}`)
      onOpenChange(false)
    } catch (err) {
      toast.fail(err)
      throw err
    }
  }

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>
              {slice?.budget_id ? "Change the allocation" : "Set an allocation"}
            </DialogTitle>
            <DialogDescription>
              For financial year {fy}. The change is written to the audit log against your name.
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-4">
            <Field
              label="Applies to"
              hint="One allocation per department per year. Setting one that already exists replaces it."
            >
              <Combobox
                value={department}
                onChange={setDepartment}
                options={departmentOptions}
                placeholder={departmentsQuery.isLoading ? "Loading…" : "The college as a whole"}
                disabled={departmentsQuery.isLoading || Boolean(slice)}
              />
            </Field>

            <Field
              label="Allocation"
              error={negative ? "An allocation cannot be negative." : undefined}
            >
              <NumberInput
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                min={0}
                step="1000"
                unit="₹"
                autoFocus
              />
            </Field>

            <Field label="Note" hint="Optional — where the figure came from, or what it covers.">
              <Input
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Sanctioned in the March governing body meeting"
              />
            </Field>

            {replacing && amountValid && (
              <Callout tone="caution" title="This replaces the allocation already on record">
                {target} already has an allocation for FY {fy}. Saving overwrites it with{" "}
                {money(parsed)}. Nothing that has been paid or committed changes.
              </Callout>
            )}
          </DialogBody>
          <DialogFooter className="justify-between">
            {slice?.budget_id ? (
              <Button
                kind="danger"
                onClick={() => setConfirmDelete(true)}
                disabled={save.isPending || remove.isPending}
              >
                Remove
              </Button>
            ) : (
              <span />
            )}
            <div className="flex gap-2">
              <Button kind="quiet" onClick={() => onOpenChange(false)} disabled={save.isPending}>
                Cancel
              </Button>
              <Button
                kind="primary"
                disabled={!amountValid || save.isPending}
                onClick={() => void submit()}
              >
                {save.isPending ? "Saving…" : "Save"}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        danger
        title={`Remove the allocation for ${target}?`}
        // Said plainly, because "delete the budget" sounds like it deletes
        // the spending. It does not: it removes the ceiling, and every
        // figure measured against that ceiling stops having an answer.
        description={`This removes the ceiling, not the spending. Nothing that has been paid or committed changes — but ${target} will have no allocation to measure against for FY ${fy}, so "left" goes blank rather than to zero.`}
        confirmLabel="Remove the allocation"
        onConfirm={deleteAllocation}
      />
    </>
  )
}

/* ------------------------------------------------------------------------ */
/* Helpers                                                                   */
/* ------------------------------------------------------------------------ */

/** Over the ceiling, and only where there *is* a ceiling. A department with
 *  no allocation has spent money against no limit, which is not the same
 *  thing as having overspent. */
function isOver(slice: BudgetSlice): boolean {
  return slice.remaining !== null && slice.remaining < 0
}

/** India's financial year runs April to March, mirroring
 *  `financial_year_of()` in backend/core/api.py. Used only to name a year
 *  before the server has answered — the server's own answer always wins. */
function currentFinancialYear(): string {
  const now = new Date()
  const start = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1
  return `${start}-${String(start + 1).slice(-2)}`
}

function formatDay(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })
}
