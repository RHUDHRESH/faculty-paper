import { useEffect, useMemo, useState } from "react"
import { useSearchParams } from "react-router-dom"
import { Coins, Pencil, Plus } from "lucide-react"

import { can, useAuth } from "@/app/auth"
import { useApi, useApiMutation } from "@/lib/query"
import { BudgetBurn, type FinancialYear } from "@/pages/statements"
import { BudgetStrip } from "@/pages/budget-strip"
import { AnswerLine, AnswerWord, tieNumbers } from "@/ui/answer"
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
import { filterBar } from "@/ui/filter-bar"
import { money } from "@/ui/paper"
import { Callout, EmptyState, ErrorState, NotOpen, Skeleton, SkeletonRows } from "@/ui/state"
import { Table, type Column } from "@/ui/table"
import { Meta } from "@/ui/text"
import { PageHeader } from "@/ui/page-header"
import { Details } from "@/ui/section"
import { Ago } from "@/ui/when"
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
        <NotOpen message="The budget is money. Finance, the Principal and the research office can read it; a head of department cannot." />
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
    <div className="page space-y-6">
      <PageHeader
        title="Budget"
        sub="What each department was given for the year, what has been paid and what is promised."
        action={
          mayEdit ? (
            <Button kind="primary" size="md" onClick={() => setAdding(true)}>
              <Plus aria-hidden />
              Set an allocation
            </Button>
          ) : undefined
        }
      />

      {/* Outside the loading and error branches on purpose: a reader who has
          landed on a year that will not load still needs a way off it, and a
          retry button on its own cannot get them there. */}
      <div className={filterBar} role="search">
        <Field label="Financial year" className="w-44 shrink-0">
          <Combobox value={fy} onChange={selectYear} options={yearOptions} searchPlaceholder="Type a year" />
        </Field>
      </div>

      {isLoading ? (
        <BudgetSkeleton />
      ) : isError ? (
        <ErrorState
          title={`Could not load the budget for FY ${fy}`}
          message={
            error?.status === 403
              ? "Not allowed. Finance, the Principal and the research office can read this."
              : "The server did not answer, so every figure below is unknown rather than zero. No allocation has been changed."
          }
          onRetry={error?.status === 403 ? false : () => void refetch()}
        />
      ) : !data ? (
        // Deliberately an error and not an empty state. Nothing has been
        // established about this year, and "no budget has been allocated"
        // is a claim the page has no evidence for.
        <ErrorState
          title={`Nothing came back for FY ${fy}`}
          message="The request finished without any figures. Try again. No allocation has been changed."
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

          <FyBurn fy={data.financial_year} />

          <section className="space-y-3">
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
                <DepartmentTable
                  rows={departments}
                  college={data.college}
                  mayEdit={mayEdit}
                  onEdit={openEdit}
                />
              </>
            )}
          </section>

          <BudgetHistory />
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

type BudgetEntry = {
  id: string
  created_at: string
  who?: { user_id: string; name: string } | null
  what?: string
  context?: string | null
  changes?: { label: string; from: string; to: string }[]
  reason?: string | null
}

/** Who set or removed which allocation, from what to what. Below the fold:
 *  it answers "who changed this figure?", which is asked rarely. */
function BudgetHistory() {
  const { data } = useApi<{ results: BudgetEntry[]; total: number }>(
    ["audit", "budget"],
    "/api/admin/audit?action=BUDGET&limit=20"
  )
  if (!data || data.results.length === 0) return null
  return (
    <Details label="who changed an allocation" count={data.total}>
      <ul className="divide-y divide-line">
        {data.results.map((e) => (
          <li key={e.id} className="py-2.5 text-sm">
            <p>
              <span className="font-medium">{e.who?.name ?? "The system"}</span> {e.what ?? "changed an allocation"}
              {e.context ? `: ${e.context}` : ""}
              <Meta className="ml-2">
                <Ago iso={e.created_at} />
              </Meta>
            </p>
            {(e.changes ?? []).map((c) => (
              <p key={c.label} className="mt-0.5 text-fg-muted">
                {c.label}: <span className="line-through">{c.from}</span> to <span className="font-medium text-fg">{c.to}</span>
              </p>
            ))}
            {e.reason && <p className="mt-0.5 text-fg-muted">Reason given: {e.reason}</p>}
          </li>
        ))}
      </ul>
    </Details>
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
  const left = slice.remaining

  return (
    <section className="space-y-5" aria-label={`The college, FY ${fy}`}>
      <AnswerLine>
        {slice.allocated === null ? (
          `No budget is set for ${fy}.`
        ) : over ? (
          <>
            The budget is <AnswerWord tone="crimson">{money(Math.abs(left ?? 0))} over</AnswerWord>.
          </>
        ) : (
          <>
            {tieNumbers(`${money(left)} is`)} <AnswerWord tone="sage">left</AnswerWord> of {money(slice.allocated)}.
          </>
        )}
      </AnswerLine>

      {slice.allocated === null ? (
        <p className="max-w-2xl text-lead text-fg-muted">
          Paid so far {money(slice.spent)}; committed {money(slice.committed)}. Without an allocation there is no ceiling to
          measure against.
        </p>
      ) : (
        <div className="max-w-2xl">
          <BudgetStrip budget={slice} batch={0} />
        </div>
      )}

      {slice.note && <Meta className="block">{slice.note}</Meta>}

      {/* The one control that has to survive a 375px screen. On a phone the
          department table becomes a card list further down; without this the
          college's own allocation would have no row to be edited from. */}
      {mayEdit && (
        <Button kind="default" onClick={() => onEdit(slice)} className="w-full sm:w-auto">
          {slice.budget_id ? <Pencil /> : <Plus />}
          {slice.budget_id ? "Change the college allocation" : "Set an allocation for the college"}
        </Button>
      )}
    </section>
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
 * The departments as one table, with the college total in the footer row: a
 * paper filed by somebody with no department on record still spends the
 * college's money, so the total is the server's, not the sum of the rows
 * above it. On a phone the rows stack and keep their labels.
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
  const left = (s: BudgetSlice) =>
    s.remaining === null ? <Meta>Not set</Meta> : isOver(s) ? `over ${money(Math.abs(s.remaining))}` : money(s.remaining)
  const leftTone = (s: BudgetSlice) => (isOver(s) ? "text-critical" : s.remaining !== null ? "text-positive" : undefined)
  const columns: Column<BudgetSlice>[] = [
    {
      key: "department",
      header: "Department",
      exportValue: (r) => r.department || "No department recorded",
      cell: (r) => (
        <span className="block">
          {r.department || "No department recorded"}
          {isOver(r) && <OverTag />}
          {r.note && <Meta className="mt-0.5 block truncate">{r.note}</Meta>}
        </span>
      ),
    },
    {
      key: "allocated",
      header: "Allocated",
      align: "right",
      exportKind: "money",
      exportValue: (r) => r.allocated,
      cell: (r) => (r.allocated === null ? <Meta>Not set</Meta> : money(r.allocated)),
    },
    { key: "spent", header: "Paid", align: "right", exportKind: "money", exportValue: (r) => r.spent, cell: (r) => money(r.spent) },
    {
      key: "committed",
      header: "Committed",
      align: "right",
      exportKind: "money",
      exportValue: (r) => r.committed,
      cell: (r) => (r.committed > 0 ? money(r.committed) : <Meta>None</Meta>),
    },
    {
      key: "left",
      header: "Left",
      align: "right",
      exportKind: "money",
      exportValue: (r) => r.remaining,
      cell: (r) => <span className={leftTone(r)}>{left(r)}</span>,
    },
    ...(mayEdit
      ? [
          {
            key: "edit",
            header: <span className="sr-only">Allocation</span>,
            label: "Allocation",
            cell: (r: BudgetSlice) => <AllocationButton slice={r} onEdit={onEdit} />,
          },
        ]
      : []),
  ]
  return (
    <Table
      rows={rows}
      columns={columns}
      getKey={(r) => r.department ?? "unrecorded"}
      maxHeight="none"
      caption="Budget by department"
      tools={{ id: "budget-departments", title: "Budget by department" }}
      footer={{
        department: (
          <span className="block">
            The college
            {isOver(college) && <OverTag />}
            <Meta className="mt-0.5 block font-normal">Every department together</Meta>
          </span>
        ),
        allocated: college.allocated === null ? <Meta>Not set</Meta> : money(college.allocated),
        spent: money(college.spent),
        committed: college.committed > 0 ? money(college.committed) : <Meta>None</Meta>,
        left: <span className={leftTone(college)}>{left(college)}</span>,
        edit: mayEdit ? <AllocationButton slice={college} onEdit={onEdit} /> : undefined,
      }}
    />
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
      hint: collegeAllocated && !slice ? "already allocated, and this replaces it" : undefined,
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
        `${result.created ? "Allocated" : "Updated"}: ${money(parsed)} to ${target} for FY ${fy}`
      )
      onOpenChange(false)
    } catch (err) {
      toast.fail(err)
    }
  }

  async function deleteAllocation() {
    try {
      await remove.mutateAsync(undefined as never)
      toast.ok(`Allocation removed. ${target} has no ceiling for FY ${fy}`)
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

            <Field label="Note" hint="Optional. Where the figure came from, or what it covers.">
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
        description={`${slice ? `The ${money(slice.allocated ?? 0)} allocation is removed. ` : ""}This removes the ceiling, not the spending. Nothing that has been paid or committed changes${slice ? ` (${money(slice.spent)} paid, ${money(slice.committed)} committed)` : ""}, but ${target} will have no allocation to measure against for FY ${fy}, so "left" goes blank rather than to zero.`}
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

/** Month by month spend against the allocation, from the ledger. */
function FyBurn({ fy }: { fy: string }) {
  const burn = useApi<FinancialYear>(
    ["payouts", "fy", fy],
    `/api/payouts/financial-year?financial_year=${encodeURIComponent(fy)}`
  )
  return burn.data ? <BudgetBurn fy={burn.data} /> : null
}
