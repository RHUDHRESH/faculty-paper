import { useId, useState } from "react"
import { Link, useSearchParams } from "react-router-dom"
import { useQueryClient } from "@tanstack/react-query"
import { CheckCircle2 } from "lucide-react"

import { can, useAuth } from "@/app/auth"
import { ApiError, api } from "@/lib/api"
import { useApi } from "@/lib/query"
import { Button } from "@/ui/button"
import { Field, Input, NumberInput, Select } from "@/ui/field"
import { ErpRemark } from "@/pages/erp-remark"
import { PageHeader } from "@/ui/page-header"
import { Answer } from "@/ui/answer"
import { Rows, Section } from "@/ui/section"
import { money, stageOf } from "@/ui/paper"
import { EmptyState, ErrorState, InlineError, SkeletonRows } from "@/ui/state"
import { toast } from "@/ui/toast"


import {
  ChangeHistory,
  ClaimNo,
  count,
  FaceName,
  type Face,
  plural,
} from "./admin-b-parts"

/**
 * Fix the claims the old ERP left wrong.
 *
 * The workbook brought across paid claims with no amount, papers with no
 * title ("-", "Untitled") and journals with no quartile. The answer figures are
 * the filters; each row is one line of trouble and one Fix button, and the form
 * with only the boxes that claim needs opens beneath it. A save changes the
 * claim, writes the balancing ledger row for a settled amount, records who did
 * it and why, and says whether the ledger now agrees.
 */

type Kind = "paid_no_amount" | "untitled" | "no_quartile" | "no_claimant"

type Row = {
  id: string
  ticket_number: string | null
  imported: boolean
  title: string | null
  journal: string | null
  year: number | null
  status: string
  owner: Face
  department: string | null
  amount: number | null
  quartile: string | null
  claimed_quartile: string | null
  month_paid: string | null
  status_note: string | null
  ledger_total: number
  ledger_rows: number
  issues: Kind[]
  suggestion: { amount: number; note: string | null } | null
  ledger_matches?: { id: string; amount: number; voucher_number: string | null; month: string | null; faculty_name: string | null }[]
  last_fix: { by: string; at: string } | null
}

type Queue = {
  counts: { paid_no_amount: number; untitled: number; no_quartile: number; no_claimant: number; no_quartile_in_review: number; claims: number }
  total: number
  rows: Row[]
}

type FixResult = {
  ok: boolean
  changed: Record<string, unknown>
  ledger: { claim_amount: number; ledger_total: number; ledger_rows: number; matches: boolean }
  row: Row | null
}

const ISSUE_WORD: Record<Kind, string> = {
  paid_no_amount: "No amount",
  untitled: "No title",
  no_quartile: "No quartile",
  no_claimant: "Claimant not identified",
}
const PAGE = 20
const DEFAULT_REASON = "Corrected from the accounts records"

function isKind(v: string | null): v is Kind {
  return v === "paid_no_amount" || v === "untitled" || v === "no_quartile" || v === "no_claimant"
}

export function DataFixes() {
  const { me } = useAuth()
  const mayFix = can(me?.role).admin
  const qc = useQueryClient()
  const [params, setParams] = useSearchParams()
  const kind = isKind(params.get("kind")) ? (params.get("kind") as Kind) : null
  const stage = params.get("stage") === "review" ? "review" : params.get("stage") === "paid" ? "paid" : null
  const [reason, setReason] = useState(DEFAULT_REASON)
  const [shown, setShown] = useState(PAGE)
  const [openId, setOpenId] = useState<string | null>(null)
  const [fixed, setFixed] = useState<{ id: string; no: string | null; text: string; ok: boolean }[]>([])

  const qs = new URLSearchParams()
  if (kind) qs.set("kind", kind)
  if (stage) qs.set("stage", stage)
  qs.set("limit", "200")
  const { data, isLoading, isError, refetch } = useApi<Queue>(
    ["data-fixes", kind, stage],
    `/api/admin/data-fixes?${qs}`
  )

  const fixedIds = new Set(fixed.map((f) => f.id))
  const rows = (data?.rows ?? []).filter((r) => !fixedIds.has(r.id))
  const c = data?.counts

  function setFilter(next: Record<string, string | null>) {
    const p = new URLSearchParams(params)
    for (const [k, v] of Object.entries(next)) {
      if (v) p.set(k, v)
      else p.delete(k)
    }
    setParams(p)
    setShown(PAGE)
    setOpenId(null)
  }

  function done(row: Row, result: FixResult) {
    const bits: string[] = []
    if ("remuneration" in result.changed) bits.push(`amount ${money(Number(result.changed.remuneration))}`)
    if ("paper_title" in result.changed) bits.push("title")
    if ("quartile" in result.changed) bits.push(`quartile ${String(result.changed.quartile)}`)
    if ("owner" in result.changed) bits.push(`claimant ${String(result.changed.owner)}`)
    if ("status_note" in result.changed) bits.push("marked no payment due")
    const ledger = result.ledger.matches
      ? "The ledger agrees."
      : `The ledger is off: it holds ${money(result.ledger.ledger_total)} against ${money(result.ledger.claim_amount)}.`
    setFixed((f) => [
      { id: row.id, no: row.ticket_number, text: `Saved ${bits.join(", ") || "the change"}. ${ledger}`, ok: result.ledger.matches },
      ...f,
    ])
    setOpenId(null)
    void qc.invalidateQueries({ queryKey: ["data-fixes"] })
    void qc.invalidateQueries({ queryKey: ["admin-faults"] })
    void qc.invalidateQueries({ queryKey: ["ledger"] })
    toast.ok(`Fixed ${row.ticket_number ?? "the claim"}. ${ledger}`)
  }

  return (
    <div className="page space-y-10">
      <PageHeader title="Fix imported claims" sub="Missing an amount, title, quartile or claimant." spot="spot-audit" />

      <ErpRemark />

      {isLoading ? (
        <SkeletonRows rows={5} rowHeight={72} />
      ) : isError || !data || !c ? (
        <ErrorState
          title="Could not load the fix list"
          message="Nothing has been changed. Try again."
          onRetry={() => refetch()}
        />
      ) : (
        <>
          <section aria-label="The answer" className="space-y-3">
            <Answer
              items={[
                { value: c.paid_no_amount, label: "Paid with no amount", to: "?kind=paid_no_amount", tone: "critical", zero: "Every paid claim has an amount" },
                { value: c.untitled, label: "With no real title", to: "?kind=untitled", tone: "caution", zero: "Every claim has a title" },
                { value: c.no_quartile, label: "With no quartile", to: "?kind=no_quartile", tone: "caution", zero: "Every claim has a quartile" },
                { value: c.no_claimant, label: "With the claimant not identified", to: "?kind=no_claimant", tone: "caution", zero: "Every claim has a claimant" },
              ]}
            />
            {c.no_quartile_in_review > 0 && (
              <p className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-fg-muted">
                {plural(c.no_quartile_in_review, "claim")} in review cannot be cleared without a quartile.
                <Button kind="default" size="sm" onClick={() => setFilter({ kind: "no_quartile", stage: "review" })}>
                  Show those {count(c.no_quartile_in_review)}
                </Button>
              </p>
            )}
          </section>

          {fixed.length > 0 && (
            <Section title="Fixed just now">
              <Rows>
                {fixed.map((f) => (
                  <li key={f.id} className="flex flex-wrap items-baseline gap-x-3 py-2.5 text-sm">
                    <CheckCircle2 aria-hidden className="size-4 self-center text-positive" />
                    <ClaimNo no={f.no} />
                    <span className={f.ok ? "text-fg-muted" : "text-critical"}>{f.text}</span>
                    <ChangeHistory entity="Claim" id={f.id} className="ml-auto" />
                  </li>
                ))}
              </Rows>
            </Section>
          )}

          <Section
            title={`${kind ? ISSUE_WORD[kind] : "All claims"}${stage === "review" ? ", still in review" : ""}`}
            sub={plural(data.total, "claim")}
            action={
              kind || stage ? (
                <Button kind="default" size="sm" onClick={() => setFilter({ kind: null, stage: null })}>
                  Show all {count(c.claims)}
                </Button>
              ) : undefined
            }
            className="space-y-4"
          >
            {!mayFix && <p className="text-sm text-fg-muted">Read only. A super admin saves fixes.</p>}

            {rows.length === 0 ? (
              <EmptyState
                art="empty-queue"
                icon={CheckCircle2}
                title="Nothing left to fix here"
                message="Every claim in this list has what it needs."
                action={
                  <Button kind="default" asChild>
                    <Link to="/ledger?problem=no-ledger">Open the ledger checks</Link>
                  </Button>
                }
              />
            ) : (
              <Rows>
                {rows.slice(0, shown).map((r) => (
                  <FixRow
                    key={r.id}
                    row={r}
                    reason={reason}
                    onReason={setReason}
                    mayFix={mayFix}
                    open={openId === r.id}
                    onToggle={() => setOpenId((id) => (id === r.id ? null : r.id))}
                    onDone={done}
                  />
                ))}
              </Rows>
            )}
            {rows.length > shown && (
              <Button kind="default" onClick={() => setShown((n) => n + PAGE)}>
                Show {Math.min(PAGE, rows.length - shown)} more of {count(rows.length - shown)} left
              </Button>
            )}
          </Section>
        </>
      )}
    </div>
  )
}

/** One claim, one line of trouble, one button. The form opens beneath it. */
function FixRow({
  row,
  reason,
  onReason,
  mayFix,
  open,
  onToggle,
  onDone,
}: {
  row: Row
  reason: string
  onReason: (v: string) => void
  mayFix: boolean
  open: boolean
  onToggle: () => void
  onDone: (row: Row, result: FixResult) => void
}) {
  const stage = stageOf(row.status)
  const formId = useId()
  return (
    <li className="py-4">
      <div className="flex items-start gap-4">
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
            <FaceName person={row.owner} />
            <ClaimNo no={row.ticket_number} className="text-fg-muted" />
          </div>
          <p className="text-base">{row.title && !isBlankTitle(row.title) ? row.title : "No title recorded"}</p>
          <p className="text-sm text-fg-muted">
            <span className="font-medium text-critical">{row.issues.map((i) => ISSUE_WORD[i]).join(", ")}</span>
            {" · "}
            {row.status === "PAID" && row.month_paid ? `Paid for ${monthName(row.month_paid)}` : stage.label}
            {row.journal && row.journal !== "-" ? ` · ${row.journal}` : ""}
            {row.year ? ` · ${row.year}` : ""}
          </p>
        </div>
        {mayFix && (
          <Button
            kind={open ? "quiet" : "default"}
            size="sm"
            aria-expanded={open}
            aria-controls={formId}
            aria-label={`${open ? "Close" : "Fix"} ${row.ticket_number ?? "this claim"}`}
            onClick={onToggle}
          >
            {open ? "Close" : "Fix"}
          </Button>
        )}
      </div>
      {open && mayFix && (
        <div id={formId} className="mt-4">
          <FixForm row={row} reason={reason} onReason={onReason} onDone={onDone} />
        </div>
      )}
    </li>
  )
}

function FixForm({
  row,
  reason,
  onReason,
  onDone,
}: {
  row: Row
  reason: string
  onReason: (v: string) => void
  onDone: (row: Row, result: FixResult) => void
}) {
  const wantsAmount = row.issues.includes("paid_no_amount")
  const wantsTitle = row.issues.includes("untitled")
  const wantsQuartile = row.issues.includes("no_quartile")
  const wantsClaimant = row.issues.includes("no_claimant")
  const [ownerEmail, setOwnerEmail] = useState("")
  const [amount, setAmount] = useState("")
  const [title, setTitle] = useState("")
  const [quartile, setQuartile] = useState("")
  const [noPayment, setNoPayment] = useState(false)
  const [linkId, setLinkId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const something = (wantsAmount && (amount !== "" || noPayment)) || (wantsTitle && title.trim() !== "") || (wantsQuartile && quartile !== "") || (wantsClaimant && ownerEmail.trim() !== "")

  async function save() {
    setBusy(true)
    setError(null)
    const body: Record<string, unknown> = { reason }
    if (wantsAmount && amount !== "") body.amount = Number(amount)
    if (wantsAmount && linkId) body.link_ledger_row_id = linkId
    if (wantsAmount && noPayment) body.no_payment = true
    if (wantsTitle && title.trim()) body.title = title.trim()
    if (wantsQuartile && quartile) body.quartile = quartile
    if (wantsClaimant && ownerEmail.trim()) body.owner_email = ownerEmail.trim()
    try {
      const result = await api<FixResult>(`/api/admin/data-fixes/${row.id}`, { method: "POST", json: body })
      onDone(row, result)
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "The fix could not be saved. Nothing was changed.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-[minmax(0,1fr)] gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {wantsAmount && (
          <div className="space-y-1.5">
            <Field
              label="Amount paid"
              hint={
                (row.amount == null ? "Now: not recorded" : `Now: ${money(row.amount)}`) +
                `. Ledger holds ${money(row.ledger_total)} in ${plural(row.ledger_rows, "row")}`
              }
            >
              <NumberInput
                unit="₹"
                min={1}
                step="any"
                value={amount}
                disabled={noPayment}
                onChange={(e) => {
                  setAmount(e.target.value)
                  setLinkId(null)
                }}
              />
            </Field>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm">
              {(row.ledger_matches ?? []).map((m) => (
                <Button
                  key={m.id}
                  kind="default"
                  size="sm"
                  title={`The ledger already has this payment${m.voucher_number ? `, voucher ${m.voucher_number}` : ""}${m.month ? `, ${monthName(m.month)}` : ""}.`}
                  onClick={() => {
                    setNoPayment(false)
                    setAmount(String(m.amount))
                    setLinkId(m.id)
                  }}
                >
                  Use the ledger payment of {money(m.amount)}
                </Button>
              ))}
              {row.suggestion && (
                <Button
                  kind="default"
                  size="sm"
                  onClick={() => {
                    setNoPayment(false)
                    setAmount(String(row.suggestion!.amount))
                  }}
                  title={row.suggestion.note ?? undefined}
                >
                  The policy would pay {money(row.suggestion.amount)}. Use it
                </Button>
              )}
              <label className="flex items-center gap-1.5 text-fg-muted">
                <input
                  type="checkbox"
                  checked={noPayment}
                  onChange={(e) => {
                    setNoPayment(e.target.checked)
                    if (e.target.checked) setAmount("")
                  }}
                />
                No payment was due
              </label>
            </div>
          </div>
        )}
        {wantsTitle && (
          <Field label="Paper title">
            <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Type the paper's real title" />
          </Field>
        )}
        {wantsQuartile && (
          <Field label="Quartile" hint={row.claimed_quartile ? `The claimant wrote: ${row.claimed_quartile}` : undefined}>
            <Select size="sm" value={quartile} onChange={(e) => setQuartile(e.target.value)}>
              <option value="">Choose a quartile</option>
              <option value="Q1">Q1</option>
              <option value="Q2">Q2</option>
              <option value="Q3">Q3</option>
              <option value="Q4">Q4</option>
              <option value="Others">Others (not ranked)</option>
            </Select>
          </Field>
        )}
        {wantsClaimant && (
          <Field label="Email of the right account" hint={`Now: ${row.owner.name}`}>
            <Input
              type="email"
              value={ownerEmail}
              onChange={(e) => setOwnerEmail(e.target.value)}
              placeholder="name@college.edu"
            />
          </Field>
        )}
      </div>

      <Field
        label="Where the correction comes from"
        error={reason.trim().length < 10 ? "Write at least 10 characters." : undefined}
        className="max-w-xl"
      >
        <Input value={reason} onChange={(e) => onReason(e.target.value)} />
      </Field>

      {error && <InlineError message={error} />}

      <div className="flex flex-wrap items-center gap-3">
        <Button kind="primary" disabled={busy || !something || reason.trim().length < 10} onClick={save}>
          {busy ? "Saving" : `Save fix for ${row.ticket_number ?? "this claim"}`}
        </Button>
        <Button kind="default" size="sm" asChild>
          <Link to={`/papers/${row.id}`}>Open the claim</Link>
        </Button>
        <ChangeHistory entity="Claim" id={row.id} />
        {row.last_fix && <span className="text-sm text-fg-muted">Last fixed by {row.last_fix.by}.</span>}
      </div>
    </div>
  )
}

function isBlankTitle(t: string): boolean {
  return /^[\s\-–—_.]*$/.test(t) || /^\s*(untitled|n\/?a|none|nil|null|no title)\s*$/i.test(t)
}

function monthName(day: string): string {
  const d = new Date(`${day}T00:00:00`)
  return d.toLocaleDateString("en-IN", { month: "long", year: "numeric" })
}
