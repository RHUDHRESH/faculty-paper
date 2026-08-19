"use client"

import { useState } from "react"
import { toast } from "sonner"
import { Wallet } from "lucide-react"

import { Callout } from "@/components/form/fields"
import { ErrorState, PageHeader, Section } from "@/components/layout/page"
import { Money, formatMoney } from "@/components/ticket-ui"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { api } from "@/lib/api"
import { useApiQuery } from "@/lib/queries"
import { cn } from "@/lib/utils"

/**
 * What was allocated, what has gone, and what is already spoken for.
 *
 * The scheme had no budget at all: the principal approved spend with no idea
 * what remained, which makes an approval step ceremony rather than control.
 *
 * The column that did not exist anywhere before is "committed" — tickets
 * cleared or approved but not yet paid. That money is owed. Reporting only
 * what has been paid understates the position by exactly the amount that is
 * about to leave the account.
 */

type Slice = {
  department: string | null
  allocated: number | null
  spent: number
  committed: number
  remaining: number | null
  used_fraction: number | null
  budget_id: string | null
  note: string | null
}

type BudgetStatus = {
  financial_year: string
  starts: string
  ends: string
  college: Slice
  departments: Slice[]
  years_on_record: string[]
}

/** A bar is quicker to read than three numbers, when the question is "how much is left". */
function UsageBar({ slice }: { slice: Slice }) {
  if (!slice.allocated) {
    return (
      <div className="h-2 rounded-full bg-muted" aria-hidden />
    )
  }
  const spent = Math.min(1, slice.spent / slice.allocated)
  const committed = Math.min(1 - spent, slice.committed / slice.allocated)
  const over = (slice.remaining ?? 0) < 0
  return (
    <div
      className="flex h-2 overflow-hidden rounded-full bg-muted"
      role="img"
      aria-label={`${Math.round((slice.used_fraction || 0) * 100)}% of the allocation is spent or committed`}
    >
      <span
        className={cn("h-full", over ? "bg-destructive" : "bg-primary")}
        style={{ width: `${spent * 100}%` }}
      />
      {/* Committed is drawn lighter: it is real, but it has not left yet. */}
      <span
        className={cn("h-full", over ? "bg-destructive/50" : "bg-primary/40")}
        style={{ width: `${committed * 100}%` }}
      />
    </div>
  )
}

function SliceRow({ slice, onEdit }: { slice: Slice; onEdit: () => void }) {
  const over = slice.remaining !== null && slice.remaining < 0
  return (
    <div className="border-b border-border/50 px-4 py-3 last:border-0">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <span className="text-sm font-medium text-foreground">
          {slice.department || "College-wide"}
        </span>
        <span className="text-sm tabular-nums">
          {slice.allocated === null ? (
            <span className="text-muted-foreground">No allocation set</span>
          ) : (
            <>
              <span className={cn("font-semibold", over && "text-destructive")}>
                <Money value={slice.remaining} />
              </span>
              <span className="text-muted-foreground"> left of <Money value={slice.allocated} /></span>
            </>
          )}
        </span>
      </div>
      <div className="mt-2">
        <UsageBar slice={slice} />
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span>Paid {formatMoney(slice.spent)}</span>
        <span>Committed {formatMoney(slice.committed)}</span>
        {over ? (
          <span className="font-medium text-destructive">
            Over by {formatMoney(Math.abs(slice.remaining || 0))}
          </span>
        ) : null}
        <button
          type="button"
          onClick={onEdit}
          className="interactive ml-auto underline-offset-2 hover:text-foreground hover:underline"
        >
          {slice.allocated === null ? "Set an allocation" : "Change"}
        </button>
      </div>
      {slice.note ? <p className="mt-1 text-xs text-muted-foreground">{slice.note}</p> : null}
    </div>
  )
}

export function BudgetPage() {
  const [year, setYear] = useState<string | null>(null)
  const [editing, setEditing] = useState<Slice | null>(null)
  const [amount, setAmount] = useState("")
  const [note, setNote] = useState("")
  const [busy, setBusy] = useState(false)

  const { data, isLoading, isError, refetch } = useApiQuery<BudgetStatus>(
    ["budget", year || "current"],
    `/api/budgets${year ? `?financial_year=${year}` : ""}`
  )

  async function save() {
    if (!data || !editing) return
    const value = Number(amount)
    if (!Number.isFinite(value) || value < 0) {
      toast.error("Enter an amount")
      return
    }
    setBusy(true)
    try {
      await api("/api/budgets", {
        method: "POST",
        json: {
          financial_year: data.financial_year,
          department: editing.department,
          amount: value,
          note: note.trim() || undefined,
        },
      })
      toast.success("Allocation saved")
      setEditing(null)
      setAmount("")
      setNote("")
      await refetch()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save it")
    } finally {
      setBusy(false)
    }
  }

  if (isError) return <ErrorState onRetry={() => refetch()} />

  return (
    <div className="space-y-6">
      <PageHeader
        title="Budget"
        subtitle="Allocation, spend, and what is already committed"
        actions={
          data ? (
            <Select value={data.financial_year} onValueChange={setYear}>
              <SelectTrigger className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {data.years_on_record.map((y) => (
                  <SelectItem key={y} value={y}>
                    {y}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : null
        }
      />

      {isLoading || !data ? null : (
        <>
          <Callout tone="info" title="Committed is money the college owes">
            A ticket the research cell has cleared, or the principal has approved, is
            already promised — finance simply has not moved it yet. Counting only what
            has been paid understates the position by exactly that amount.
          </Callout>

          <Section
            title={`Financial year ${data.financial_year}`}
            description={`${data.starts} to ${data.ends}`}
          >
            <div className="rounded-[var(--radius)] border border-border bg-card">
              <SliceRow
                slice={data.college}
                onEdit={() => {
                  setEditing(data.college)
                  setAmount(data.college.allocated ? String(data.college.allocated) : "")
                  setNote(data.college.note || "")
                }}
              />
            </div>
          </Section>

          <Section
            title="By department"
            description="A departmental allocation ring-fences part of the college total"
          >
            <div className="rounded-[var(--radius)] border border-border bg-card">
              {data.departments.length === 0 ? (
                <p className="px-4 py-6 text-sm text-muted-foreground">
                  Nothing has been paid or committed against a department this year.
                </p>
              ) : (
                data.departments.map((d) => (
                  <SliceRow
                    key={d.department || "none"}
                    slice={d}
                    onEdit={() => {
                      setEditing(d)
                      setAmount(d.allocated ? String(d.allocated) : "")
                      setNote(d.note || "")
                    }}
                  />
                ))
              )}
            </div>
          </Section>
        </>
      )}

      {editing ? (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-4 sm:items-center">
          <div className="w-full max-w-md rounded-[var(--radius)] border border-border bg-card p-5 shadow-lg">
            <h2 className="flex items-center gap-2 text-base font-semibold">
              <Wallet className="size-4 text-muted-foreground" aria-hidden />
              {editing.department || "College-wide"} · {data?.financial_year}
            </h2>
            <div className="mt-4 space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="budget-amount">Allocation</Label>
                <Input
                  id="budget-amount"
                  inputMode="decimal"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  placeholder="4000000"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="budget-note">Note</Label>
                <Input
                  id="budget-note"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="e.g. approved by the governing council on 12 April"
                />
              </div>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setEditing(null)}>
                Cancel
              </Button>
              <Button disabled={busy} onClick={save}>
                {busy ? "Saving…" : "Save"}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
