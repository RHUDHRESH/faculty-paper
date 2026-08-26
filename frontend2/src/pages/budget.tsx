import { useEffect, useState } from "react"
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
import { Callout, EmptyState, ErrorState, SkeletonRows } from "@/ui/state"
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
  const year = searchParams.get("fy") ?? ""
  const [editing, setEditing] = useState<BudgetSlice | null>(null)
  const [adding, setAdding] = useState(false)

  const query = year ? `?financial_year=${encodeURIComponent(year)}` : ""
  const { data, isLoading, isError, error, refetch } = useApi<BudgetPayload>(
    ["budgets", year],
    `/api/budgets${query}`,
    { enabled: allowed }
  )

  // The server decides which year "no filter" means (the current financial
  // one), so the picker is only ever populated from what came back.
  const fy = data?.financial_year ?? year
  const yearOptions: ComboboxOption[] = (data?.years_on_record ?? []).map((y) => ({
    value: y,
    label: `FY ${y}`,
  }))

  function selectYear(next: string) {
    setSearchParams((prev) => {
      const p = new URLSearchParams(prev)
      if (next) p.set("fy", next)
      else p.delete("fy")
      return p
    })
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
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <PageTitle>Budget</PageTitle>
          <Sub className="mt-1">
            What the scheme was allocated this year, what has gone out, and what is already
            owed but not yet paid.
          </Sub>
        </div>
        <div className="flex items-center gap-2">
          {yearOptions.length > 0 && (
            <Combobox
              value={fy}
              onChange={selectYear}
              options={yearOptions}
              aria-label="Financial year"
              className="w-40"
            />
          )}
          {mayEdit && (
            <Button kind="primary" size="md" onClick={() => setAdding(true)}>
              <Plus />
              Set an allocation
            </Button>
          )}
        </div>
      </header>

      {isLoading ? (
        <SkeletonRows rows={8} rowHeight={52} />
      ) : isError ? (
        <ErrorState
          title="Could not load the budget"
          message={
            error?.status === 403
              ? "Not allowed. Finance, the Principal and the research cell can read this."
              : "The server did not answer. No allocation has been changed."
          }
          onRetry={error?.status === 403 ? undefined : () => refetch()}
        />
      ) : !data ? null : (
        <>
          <CollegePosition slice={data.college} fy={data.financial_year} starts={data.starts} ends={data.ends} />

          <section className="space-y-3">
            <div className="flex items-baseline justify-between gap-3">
              <SectionTitle>By department</SectionTitle>
              <Meta>
                {departments.length} {departments.length === 1 ? "department" : "departments"} with
                an allocation or a spend
              </Meta>
            </div>

            {departments.length === 0 ? (
              <EmptyState
                icon={Coins}
                title="No department has an allocation or a spend yet"
                message="A department appears here as soon as it is given an allocation, or as soon as one of its papers is approved or paid."
              />
            ) : (
              <DepartmentTable
                rows={departments}
                mayEdit={mayEdit}
                onEdit={(slice) => setEditing(slice)}
              />
            )}
          </section>
        </>
      )}

      {data && (
        <>
          <AllocationDialog
            open={adding}
            onOpenChange={setAdding}
            fy={data.financial_year}
            slice={null}
            takenDepartments={allocatedDepartments}
            collegeAllocated={data.college.budget_id !== null}
          />
          <AllocationDialog
            open={editing !== null}
            onOpenChange={(open) => !open && setEditing(null)}
            fy={data.financial_year}
            slice={editing}
            takenDepartments={allocatedDepartments}
            collegeAllocated={data.college.budget_id !== null}
          />
        </>
      )}
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
}: {
  slice: BudgetSlice
  fy: string
  starts: string
  ends: string
}) {
  const over = slice.remaining !== null && slice.remaining < 0

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <SectionTitle>The college, FY {fy}</SectionTitle>
        <Meta>
          {formatDay(starts)} to {formatDay(ends)}
        </Meta>
      </div>

      <div className="grid gap-x-8 gap-y-4 sm:grid-cols-2 lg:grid-cols-4">
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
          "mt-1 text-2xl font-semibold tabular",
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
function UsedBar({ slice }: { slice: BudgetSlice }) {
  if (slice.allocated === null || slice.allocated <= 0) return null

  const spentShare = Math.max(0, Math.min(1, slice.spent / slice.allocated))
  const committedShare = Math.max(0, Math.min(1 - spentShare, slice.committed / slice.allocated))
  const used = slice.used_fraction ?? 0

  return (
    <div className="space-y-1.5">
      <div
        className="flex h-2 w-full overflow-hidden rounded-full bg-sunken"
        role="img"
        aria-label={`${Math.round(used * 100)} per cent of the allocation is paid or committed`}
      >
        <span
          className="block bg-accent transition-[width] duration-500"
          style={{ width: `${spentShare * 100}%` }}
        />
        <span
          className="block bg-caution transition-[width] duration-500"
          style={{ width: `${committedShare * 100}%` }}
        />
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <Legend className="bg-accent">Paid {money(slice.spent)}</Legend>
        <Legend className="bg-caution">Committed {money(slice.committed)}</Legend>
        <Meta className="tabular">{Math.round(used * 100)}% of the allocation</Meta>
      </div>
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

/* ------------------------------------------------------------------------ */
/* The department table                                                      */
/* ------------------------------------------------------------------------ */

/**
 * Bespoke `<table>` markup rather than `<Table>`, because the used bar spans
 * the full width of its own row underneath the figures — a cell renderer
 * cannot draw across the columns beside it.
 */
function DepartmentTable({
  rows,
  mayEdit,
  onEdit,
}: {
  rows: BudgetSlice[]
  mayEdit: boolean
  onEdit: (slice: BudgetSlice) => void
}) {
  return (
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
              <th scope="col" className={cn(stickyHeadCell, "w-20 text-right")}>
                <span className="sr-only">Actions</span>
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const over = row.remaining !== null && row.remaining < 0
            return (
              <tr key={row.department ?? "college"} className="row border-b border-line last:border-b-0">
                <td className="px-3 py-2.5 align-middle">
                  <span className="block">{row.department || "No department recorded"}</span>
                  {row.note && <Meta className="mt-0.5 block truncate">{row.note}</Meta>}
                </td>
                <td className="px-3 py-2.5 text-right align-middle tabular">
                  {row.allocated === null ? (
                    <Meta>Not set</Meta>
                  ) : (
                    money(row.allocated)
                  )}
                </td>
                <td className="px-3 py-2.5 text-right align-middle tabular">{money(row.spent)}</td>
                <td className="px-3 py-2.5 text-right align-middle tabular">
                  {row.committed > 0 ? money(row.committed) : <Meta>—</Meta>}
                </td>
                <td
                  className={cn(
                    "px-3 py-2.5 text-right align-middle tabular",
                    over && "text-critical",
                    !over && row.remaining !== null && "text-positive"
                  )}
                >
                  {row.remaining === null ? (
                    <Meta>—</Meta>
                  ) : over ? (
                    `over ${money(Math.abs(row.remaining))}`
                  ) : (
                    money(row.remaining)
                  )}
                </td>
                {mayEdit && (
                  <td className="px-3 py-2.5 text-right align-middle">
                    <Button
                      kind="quiet"
                      size="sm"
                      className="reveal"
                      onClick={() => onEdit(row)}
                      aria-label={`Set the allocation for ${row.department || "this department"}`}
                    >
                      <Pencil />
                      {row.budget_id ? "Edit" : "Set"}
                    </Button>
                  </td>
                )}
              </tr>
            )
          })}
        </tbody>
      </table>
    </TableScroller>
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
            <DialogTitle>{slice?.budget_id ? "Change the allocation" : "Set an allocation"}</DialogTitle>
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
              <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Sanctioned in the March governing body meeting" />
            </Field>
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

function formatDay(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })
}
