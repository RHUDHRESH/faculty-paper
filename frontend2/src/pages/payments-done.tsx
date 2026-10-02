import { useEffect, useMemo, useState } from "react"
import { Link, useSearchParams } from "react-router-dom"
import { Download, FileText, Printer, Receipt, SearchX, Undo2, X } from "lucide-react"

import { can, useAuth } from "@/app/auth"
import { api } from "@/lib/api"
import { formatCount } from "@/lib/count"
import { paperTitle } from "@/lib/names"
import { CHAIN, useApi, useApiMutation } from "@/lib/query"
import { Answer } from "@/ui/answer"
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
import { Field, Input, Textarea } from "@/ui/field"
import { PageHeader } from "@/ui/page-header"
import { money } from "@/ui/paper"
import { Pagination } from "@/ui/pagination"
import { Details } from "@/ui/section"
import { Callout, EmptyState, ErrorState, SkeletonRows } from "@/ui/state"
import { Table, type Column } from "@/ui/table"
import { ColumnLabel, Meta } from "@/ui/text"
import { toast } from "@/ui/toast"
import { PrintStamp } from "@/pages/reports-print"
import type { FinancialYear, StatementMonth } from "@/pages/statements"
import {
  AmountCell,
  Claimant,
  dateTime,
  ErpLegend,
  monthKey,
  monthLabel,
  PaperCell,
  thisMonthKey,
  type PaidTotals,
  type PayoutClaim,
  type PayoutsPage,
} from "@/pages/pay-parts"

/**
 * What has already gone out, and the one way to undo it.
 *
 * Read by Finance, who cannot undo, and by a super admin, who can. The
 * difference is said once, in words, and the Undo button exists only for the
 * person who may press it: a disabled button on every row of a fifty-row
 * register is fifty small refusals.
 *
 * Search and the month filter are the server's, so they cover every payment
 * on record and not the fifty in view. Each row carries what the ledger holds
 * for it, so a payment whose ledger row differs is visible here and not only
 * on the monthly statement.
 */

const PAGE_SIZE = 50

function csvCell(v: unknown): string {
  return `"${String(v ?? "").replace(/"/g, '""')}"`
}

function downloadCsv(name: string, lines: string[]) {
  const blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" })
  const a = document.createElement("a")
  a.href = URL.createObjectURL(blob)
  a.download = name
  a.click()
  URL.revokeObjectURL(a.href)
}

export function PaymentsDone() {
  const { me } = useAuth()
  const allowed = can(me?.role).pay
  const isSuper = me?.role === "SUPER_ADMIN"

  const [params, setParams] = useSearchParams()
  const page = Math.max(0, Number.parseInt(params.get("page") ?? "0", 10) || 0)
  const month = params.get("month") ?? ""
  const q = params.get("q") ?? ""

  function setFilter(name: "month" | "q", value: string) {
    setParams((prev) => {
      const next = new URLSearchParams(prev)
      if (value) next.set(name, value)
      else next.delete(name)
      next.delete("page")
      return next
    })
  }
  function goToPage(next: number) {
    setParams((prev) => {
      const p = new URLSearchParams(prev)
      if (next > 0) p.set("page", String(next))
      else p.delete("page")
      return p
    })
  }

  // Typing stays local and reaches the server after a pause.
  const [draft, setDraft] = useState(q)
  useEffect(() => setDraft(q), [q])
  useEffect(() => {
    if (draft.trim() === q) return
    const t = window.setTimeout(() => setFilter("q", draft.trim()), 250)
    return () => window.clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft])

  const filters = new URLSearchParams({ status: "PAID" })
  if (q) filters.set("q", q)
  if (month) filters.set("month", month)
  const listQuery = new URLSearchParams(filters)
  listQuery.set("limit", String(PAGE_SIZE))
  listQuery.set("offset", String(page * PAGE_SIZE))

  const { data, isLoading, isError, refetch } = useApi<PayoutsPage<PaidTotals>>(
    ["payouts", "PAID", q, month, page],
    `/api/admin/payouts?${listQuery.toString()}`,
    { enabled: allowed, placeholderData: (prev) => prev }
  )
  const months = useApi<{ months: StatementMonth[] }>(["payouts", "months"], "/api/payouts/months", { enabled: allowed })
  const fy = useApi<FinancialYear>(["payouts", "fy"], "/api/payouts/financial-year", { enabled: allowed })

  const rows = data?.results ?? []
  const total = data?.total ?? 0
  const totals = data?.totals
  const filtered = Boolean(q) || Boolean(month)
  const ledgerMonths = months.data?.months ?? []
  const byMonth = new Map(ledgerMonths.map((m) => [m.month, m]))
  const nowKey = thisMonthKey()
  const lastKey = thisMonthKey(new Date(new Date().getFullYear(), new Date().getMonth() - 1, 1))
  const monthOptions: ComboboxOption[] = useMemo(
    () => [{ value: "", label: "All months" }, ...ledgerMonths.map((m) => ({ value: m.month, label: m.label, hint: money(m.amount) }))],
    [ledgerMonths]
  )
  const chosen = month ? byMonth.get(month) : undefined

  const [exporting, setExporting] = useState(false)
  const [voidId, setVoidId] = useState<string | null>(null)
  const voidClaim = voidId ? (rows.find((c) => c.id === voidId) ?? null) : null

  /** Every payment matching the filter, not just this page, 200 at a time. */
  async function exportCsv() {
    setExporting(true)
    try {
      const all: PayoutClaim[] = []
      for (let off = 0; ; off += 200) {
        const p = new URLSearchParams(filters)
        p.set("limit", "200")
        p.set("offset", String(off))
        const r = await api<PayoutsPage<PaidTotals>>(`/api/admin/payouts?${p.toString()}`)
        all.push(...r.results)
        if (r.results.length === 0 || all.length >= r.total) break
      }
      downloadCsv(`payments-paid-${new Date().toISOString().slice(0, 10)}.csv`, [
        ["Month paid", "Paid on", "Voucher", "Claim no.", "Staff id", "Name", "Department", "Paper", "Amount (INR)", "Held back by research threshold (INR)"]
          .map(csvCell)
          .join(","),
        ...all.map((c) =>
          [
            monthLabel(monthKey(c)),
            c.paid_at?.slice(0, 10),
            c.voucher_number,
            c.ticket_number,
            c.staff_id,
            c.owner_name,
            c.owner_department,
            c.paper_title,
            c.remuneration ?? "",
            c.threshold_absorbed || "",
          ]
            .map(csvCell)
            .join(",")
        ),
      ])
      toast.ok(`Exported ${formatCount(all.length)} ${all.length === 1 ? "payment" : "payments"}`)
    } catch (err) {
      toast.fail(err)
    } finally {
      setExporting(false)
    }
  }

  if (!allowed) {
    return (
      <div className="page py-8">
        <ErrorState title="Not open to this account" message="Only Finance can see or process payments." />
      </div>
    )
  }

  const columns: Column<PayoutClaim>[] = [
    { key: "claimant", header: "Paid to", className: "w-56", cell: (c) => <Claimant c={c} /> },
    { key: "paper", header: "Paper", cell: (c) => <PaperCell c={c} journal={false} /> },
    { key: "voucher", header: "Voucher", className: "w-40 break-all", empty: "None", cell: (c) => c.voucher_number },
    {
      key: "paid",
      header: "Paid on",
      className: "w-40",
      cell: (c) => (
        <div>
          <span className="block">{dateTime(c.paid_at)}</span>
          <Meta className="block">Month paid: {monthLabel(monthKey(c), true)}</Meta>
        </div>
      ),
    },
    { key: "amount", header: "Amount", align: "right", className: "w-52", cell: (c) => <AmountCell c={c} /> },
    {
      key: "ledger",
      header: "On the ledger",
      align: "right",
      className: "w-36",
      cell: (c) => {
        if (c.ledger_paid == null) return null
        const same = Math.abs(c.ledger_paid - (c.remuneration || 0)) < 0.005
        return same ? (
          <span className="font-normal text-fg-muted">Matches</span>
        ) : (
          <span className="block text-caution">
            Ledger shows {money(c.ledger_paid)}
            <Meta className="block">A super admin can correct it</Meta>
          </span>
        )
      },
    },
  ]
  if (isSuper) {
    columns.push({
      key: "undo",
      header: "Action",
      label: "Undo",
      className: "w-24",
      cell: (c) => (
        <Button kind="danger" size="sm" onClick={() => setVoidId(c.id)}>
          <Undo2 className="size-3.5" />
          Undo
        </Button>
      ),
    })
  }

  return (
    <div className="page space-y-8">
      <PrintStamp title="Register of incentive payments" scope={chosen ? chosen.label : "every month paid"} />
      <PageHeader
        title="Paid"
        action={
          <Button kind="default" size="sm" asChild>
            <Link to="/statements">
              <FileText />
              Monthly statements
            </Link>
          </Button>
        }
        spot="spot-payouts"
      />

      <Answer
        items={[
          {
            label: `Paid in ${monthLabel(nowKey)}`,
            value: months.isLoading ? null : money(byMonth.get(nowKey)?.amount ?? 0),
            to: `/payments/done?month=${nowKey}`,
          },
          {
            label: `Paid in ${monthLabel(lastKey)}`,
            value: months.isLoading ? null : money(byMonth.get(lastKey)?.amount ?? 0),
            to: `/payments/done?month=${lastKey}`,
          },
          {
            label: fy.data ? `Paid in FY ${fy.data.financial_year}` : "Paid this financial year",
            value: fy.data ? money(fy.data.paid) : null,
            to: "/ledger",
          },
          {
            label: "Claims paid in this app",
            value: totals ? totals.count : null,
            zero: "Nothing paid yet",
          },
        ]}
      />

      {chosen && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 print:hidden" aria-label={`${chosen.label} at a glance`}>
          <p className="text-base">
            <span className="font-medium">{chosen.label}:</span> {money(chosen.amount)} in {formatCount(chosen.count)}{" "}
            {chosen.count === 1 ? "payment" : "payments"} on the ledger.
          </p>
          <span className="flex flex-wrap gap-2">
            <Button kind="default" size="sm" asChild>
              <Link to={`/statements?month=${chosen.month}`}>Open the statement</Link>
            </Button>
            <Button kind="default" size="sm" asChild>
              <Link to={`/ledger?month=${chosen.month}`}>Open in the ledger</Link>
            </Button>
          </span>
        </div>
      )}

      <div className="flex flex-wrap items-end gap-3 print:hidden">
        <Field label="Find a payment" className="w-full max-w-sm">
          <Input
            type="search"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Name, staff id, claim number or voucher"
          />
        </Field>
        <div>
          <ColumnLabel className="mb-1 block">Month paid</ColumnLabel>
          <Combobox
            value={month}
            onChange={(v) => setFilter("month", v)}
            options={monthOptions}
            placeholder={months.isLoading ? "Loading…" : "All months"}
            aria-label="Month paid"
            className="w-56 max-w-full"
          />
        </div>
        <div className="flex flex-wrap items-center gap-2 sm:ml-auto">
          {filtered && (
            <Button
              kind="default"
              size="md"
              onClick={() => {
                setDraft("")
                setParams(new URLSearchParams())
              }}
            >
              <X />
              Clear filters
            </Button>
          )}
          <Button kind="default" size="md" onClick={() => void exportCsv()} disabled={exporting || total === 0}>
            <Download />
            {exporting ? "Exporting…" : `Export ${formatCount(total)} ${total === 1 ? "payment" : "payments"} (CSV)`}
          </Button>
          <Button kind="default" size="md" onClick={() => window.print()}>
            <Printer />
            Print register
          </Button>
        </div>
      </div>


      {isLoading ? (
        <SkeletonRows rows={8} rowHeight={52} />
      ) : isError ? (
        <ErrorState
          title="Could not load payment history"
          message="The server did not answer. Nothing has been changed."
          onRetry={() => refetch()}
        />
      ) : total === 0 ? (
        <EmptyState
          art={filtered ? "no-results" : "nothing-paid"}
          icon={filtered ? SearchX : Receipt}
          title={filtered ? "No payment matches" : "Nothing paid yet"}
          message={
            filtered
              ? "Nothing on the register matches this search and month. Try a shorter name or another month."
              : "Once Finance pays a claim, it appears here with its voucher and date."
          }
          action={
            filtered ? (
              <Button
                kind="default"
                size="sm"
                onClick={() => {
                  setDraft("")
                  setParams(new URLSearchParams())
                }}
              >
                Clear filters
              </Button>
            ) : (
              <Button kind="default" size="sm" asChild>
                <Link to="/payments">Go to payments</Link>
              </Button>
            )
          }
        />
      ) : (
        <>
          <Table
            rows={rows}
            columns={columns}
            getKey={(c) => c.id}
            minWidth="64rem"
            caption="Payments made"
            maxHeight="none"
          />
          <ErpLegend rows={rows} />
          <Pagination page={page} pageSize={PAGE_SIZE} total={total} onChange={goToPage} />
        </>
      )}

      <Details label="who can undo a payment" className="print:hidden">
        <p className="max-w-prose text-sm text-fg-muted">
          {isSuper
            ? "Undoing a payment writes a balancing row on the ledger; nothing is deleted."
            : "Finance cannot undo a payment. If one went out in error, ask a super admin: they write a balancing row on the ledger, so the person who paid and the person who reverses it are never the same."}
        </p>
      </Details>

      {voidClaim && (
        <VoidDialog
          claim={voidClaim}
          monthTotal={byMonth.get(monthKey(voidClaim))}
          open={!!voidId}
          onOpenChange={(o) => !o && setVoidId(null)}
        />
      )}
    </div>
  )
}

/**
 * Reverses a payment made in error. "Void" reads like "delete" and it is not
 * one: the server writes a negative ledger row beside the original and the
 * claim goes back to Cleared, to be approved and authorised again. Said here,
 * with the rupees it moves, because a person pressing this is trusting the
 * word to mean what it says.
 */
function VoidDialog({
  claim,
  monthTotal,
  open,
  onOpenChange,
}: {
  claim: PayoutClaim
  monthTotal: StatementMonth | undefined
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [note, setNote] = useState("")
  const voidPayment = useApiMutation<{ note: string }, unknown>(`/api/claims/${claim.id}/void-payment`, {
    invalidates: [...CHAIN, ["payouts"]],
  })

  useEffect(() => {
    if (open) setNote("")
  }, [open])

  const trimmed = note.trim()
  const tooShort = trimmed.length > 0 && trimmed.length < 10
  const canSubmit = trimmed.length >= 10
  const amount = claim.ledger_paid ?? claim.remuneration ?? 0
  const month = monthLabel(monthKey(claim))

  async function submit() {
    try {
      await voidPayment.mutateAsync({ note: trimmed })
      toast.ok(`Undone. ${money(amount)} reversed for ${claim.ticket_number || claim.owner_name}`)
      onOpenChange(false)
    } catch (err) {
      toast.fail(err)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => (!voidPayment.isPending || o) && onOpenChange(o)}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>Undo this payment?</DialogTitle>
          <DialogDescription>
            {claim.owner_name} · {paperTitle(claim.paper_title)}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          <div>
            <p className="figure text-3xl">{money(amount)}</p>
            <Meta className="mt-1 block">
              1 payment · {claim.voucher_number ? `voucher ${claim.voucher_number}` : "no voucher number"} · paid{" "}
              {dateTime(claim.paid_at)}
            </Meta>
          </div>
          <Callout tone="caution" title="This does not delete anything">
            <ul className="mt-1 list-disc space-y-1 pl-5">
              <li>
                A balancing row of −{money(amount)} is written on the ledger beside the original.
                {monthTotal
                  ? ` The ${month} total falls from ${money(monthTotal.amount)} to ${money(monthTotal.amount - amount)}.`
                  : ""}
              </li>
              <li>
                The claim goes back to Cleared. It needs the Principal's approval and the Director's authorisation
                again before it can be paid.
              </li>
            </ul>
          </Callout>
          <Field
            label="Reason"
            hint="At least 10 characters. It goes to the audit trail and the ledger."
            error={tooShort ? "At least 10 characters." : undefined}
          >
            <Textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={3}
              placeholder="Why this payment is being reversed"
            />
          </Field>
        </DialogBody>
        <DialogFooter>
          <Button kind="quiet" onClick={() => onOpenChange(false)} disabled={voidPayment.isPending}>
            Cancel
          </Button>
          <Button kind="danger" disabled={!canSubmit || voidPayment.isPending} onClick={() => void submit()}>
            {voidPayment.isPending ? "Undoing…" : `Undo ${money(amount)}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
