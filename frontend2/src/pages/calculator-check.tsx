import { useState } from "react"
import { Link, useSearchParams } from "react-router-dom"

import { useAuth } from "@/app/auth"
import { ApiError } from "@/lib/api"
import { useApi } from "@/lib/query"
import { claimHref } from "@/pages/track-data"
import { ClaimNo, FaceName } from "@/pages/admin-b-parts"
import { monthWord, moreOrLess, type ClaimCheck, type Difference, type SideBlock, rs } from "@/pages/calculator-types"
import { Answer } from "@/ui/answer"
import { Button } from "@/ui/button"
import { Field, Input } from "@/ui/field"
import { Details, Rows, Section } from "@/ui/section"
import { EmptyState, ErrorState, SkeletonText } from "@/ui/state"
import { Meta } from "@/ui/text"
import { cn } from "@/lib/cn"

/**
 * Tab 2: check a claim.
 *
 * One claim, four figures side by side: what the claim records, what the
 * formula gives under the policy it was priced with, what it gives under the
 * policy in force now, and what the ledger shows paid. Every difference is
 * named with its cause. Nothing here changes the claim; the way to fix one is
 * a link.
 */
export function CheckTab() {
  const [params, setParams] = useSearchParams()
  const q = params.get("q") ?? ""
  const [typed, setTyped] = useState(q)

  const claim = useApi<ClaimCheck>(["calculator", "claim", q], `/api/calculator/claim?q=${encodeURIComponent(q)}`, {
    enabled: q.trim().length > 0,
    retry: false,
  })

  function submit(e: React.FormEvent) {
    e.preventDefault()
    const next = new URLSearchParams(params)
    next.set("tab", "claim")
    if (typed.trim()) next.set("q", typed.trim())
    else next.delete("q")
    setParams(next)
  }

  return (
    <div className="space-y-8">
      <form onSubmit={submit} className="flex max-w-xl flex-wrap items-end gap-2">
        <Field label="Claim no." hint="Type it as you say it: FP-2026-000123, fp 2026 123 or ERP-PROCESSED-120." className="min-w-0 flex-1">
          <Input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="FP-2026-000123" autoComplete="off" />
        </Field>
        <Button type="submit" kind="primary" disabled={!typed.trim()} className="mb-[1.35rem] max-sm:mb-0">
          Check this claim
        </Button>
      </form>

      {!q.trim() ? (
        <p className="max-w-prose text-base text-fg-muted">
          Enter a claim number above. You will see what was recorded, what the formula gives under the policy the claim
          was priced with and under today's, and what the ledger shows paid.
        </p>
      ) : claim.isLoading ? (
        <SkeletonText lines={5} />
      ) : claim.isError || !claim.data ? (
        claim.error instanceof ApiError && claim.error.status === 404 ? (
          <EmptyState
            art="no-results"
            title="No claim has that number"
            message="Check the number and try again. A draft is not a claim yet, so it is not found."
          />
        ) : (
          <ErrorState what="that claim's check" onRetry={() => void claim.refetch()} />
        )
      ) : (
        <Result c={claim.data} />
      )}
    </div>
  )
}

function Result({ c }: { c: ClaimCheck }) {
  const { me } = useAuth()
  const role = me?.role
  const problems = c.differences.filter((d) => !d.expected)
  const isAdmin = role === "SUPER_ADMIN"
  const mine = !!me && me.id === c.claim.user_id
  const open = claimHref(role, { id: c.claim.id, is_mine: mine })
  const ledgerPaid = c.ledger.rows.length > 0
  const wantsDataFix = c.differences.some((d) => d.cause === "imported_no_amount")

  return (
    <div className="space-y-8">
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <ClaimNo no={c.claim.ticket_number} />
          <Meta>{c.claim.status}</Meta>
          <Meta>{monthWord(c.claim.month)}</Meta>
        </div>
        <p className="text-balance text-lg font-medium">{c.claim.title || "No title recorded"}</p>
        <FaceName person={c.claim} />
        {c.claim.department && <Meta className="block">{c.claim.department}</Meta>}
      </div>

      <section aria-label="The verdict" className="panel-lead p-5 sm:p-6">
        <p className="text-pretty text-xl" data-testid="check-headline">
          {c.headline}
        </p>
        <Meta className="mt-1 block text-xs">
          {c.agrees
            ? "Nothing here needs fixing."
            : `${problems.length} ${problems.length === 1 ? "difference needs" : "differences need"} a look.`}
        </Meta>
      </section>

      <Answer
        items={[
          {
            value: c.recorded.amount == null ? "Not recorded" : rs(c.recorded.amount),
            label:
              c.recorded.absorbed > 0
                ? `Recorded on the claim, payable (${rs(c.recorded.policy_amount)} before the threshold)`
                : "Recorded on the claim",
            tone: c.agrees ? "neutral" : "caution",
          },
          c.under_snapshot
            ? {
                value: c.under_snapshot.amount == null ? "Cannot be priced" : rs(c.under_snapshot.amount),
                label: `Formula under ${c.under_snapshot.policy}, what it was priced with`,
              }
            : {
                value: "Not recorded",
                label: "Formula under the policy it was priced with: this claim keeps no record of it",
              },
          {
            value: c.under_today.amount == null ? "Cannot be priced" : rs(c.under_today.amount),
            label: `Formula under ${c.under_today.policy}, in force now`,
          },
          {
            value: ledgerPaid ? rs(c.ledger.total) : "Nothing paid",
            label: ledgerPaid ? "Paid, from the ledger" : "Paid, from the ledger: no row",
          },
        ]}
      />

      <Section title="Differences and their causes" sub={c.differences.length === 0 ? undefined : "Expected ones are not faults."}>
        {c.differences.length === 0 ? (
          <p className="text-base text-fg-muted">None. The recorded amount, the formula and the ledger agree.</p>
        ) : (
          <Rows>
            {c.differences.map((d) => (
              <DifferenceRow key={d.key} d={d} />
            ))}
          </Rows>
        )}
      </Section>

      <Section title="Where to look next">
        <div className="flex flex-wrap gap-2">
          <Button kind="default" asChild>
            <Link to={open}>Open the claim</Link>
          </Button>
          <Button kind="default" asChild>
            <Link to={`/track?why=${c.claim.id}`}>Why this amount</Link>
          </Button>
          {ledgerPaid && (
            <Button kind="default" asChild>
              <Link to={`/ledger?q=${encodeURIComponent(c.ledger.rows[0]?.voucher ?? c.claim.name)}`}>See the ledger</Link>
            </Button>
          )}
          {isAdmin && !c.agrees && (
            <Button kind="primary" asChild>
              <Link to={wantsDataFix ? "/data/fixes?kind=paid_no_amount" : open}>
                {wantsDataFix ? "Fix it in the imported-claims queue" : "Fix it on the claim"}
              </Link>
            </Button>
          )}
        </div>
        <p className="mt-2 text-xs text-fg-muted">The calculator only reads. It never changes a claim.</p>
      </Section>

      <div className="space-y-3">
        <SideBySide c={c} />
        <Details label="the figures the formula used">
          <Inputs c={c} />
        </Details>
      </div>

      {c.ledger.rows.length > 0 && (
        <Section title="What the ledger shows">
          <Rows>
            {c.ledger.rows.map((r, i) => (
              <li key={i} className="flex items-baseline justify-between gap-4 py-2 text-sm">
                <span>
                  {monthWord(r.month)}
                  <span className="text-fg-muted">, {r.voucher ?? "no voucher recorded"}</span>
                </span>
                <span className="tabular font-medium">{rs(r.amount)}</span>
              </li>
            ))}
          </Rows>
        </Section>
      )}
    </div>
  )
}

function DifferenceRow({ d }: { d: Difference }) {
  return (
    <li className="space-y-1 py-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <span className="flex items-center gap-2 text-sm font-medium">
          {d.cause_label}
          <span
            className={cn(
              "rounded-full px-2 py-0.5 text-xs font-medium",
              d.expected ? "bg-sunken text-fg-muted" : "bg-caution-wash text-fg"
            )}
          >
            {d.expected ? "Expected" : "Needs a look"}
          </span>
        </span>
        {d.delta != null && (
          <span className="text-sm tabular">{moreOrLess(d.delta)}</span>
        )}
      </div>
      <p className="text-pretty text-sm text-fg-muted">{d.text}</p>
      <p className="text-xs text-fg-subtle">{d.compare}</p>
    </li>
  )
}

function Block({ title, b }: { title: string; b: SideBlock | null }) {
  if (!b) {
    return (
      <div className="min-w-0 space-y-1">
        <p className="text-sm font-medium">{title}</p>
        <p className="text-sm text-fg-muted">This claim keeps no copy of the policy it was priced with.</p>
      </div>
    )
  }
  return (
    <div className="min-w-0 space-y-1">
      <p className="text-sm font-medium">{title}</p>
      <p className="text-sm text-fg-muted">{b.policy}</p>
      <p className="text-sm text-fg-muted">
        {b.problem ? `Cannot be priced: ${b.problem}` : (b.category ?? "No category")}
      </p>
      {b.note && <p className="text-pretty text-xs text-fg-subtle">{b.note}</p>}
    </div>
  )
}

function SideBySide({ c }: { c: ClaimCheck }) {
  return (
    <Details label="how each policy priced it">
      <div className="grid grid-cols-[minmax(0,1fr)] gap-6 sm:grid-cols-2">
        <Block title="Under the policy it was priced with" b={c.under_snapshot} />
        <Block title="Under the policy in force now" b={c.under_today} />
      </div>
    </Details>
  )
}

function Inputs({ c }: { c: ClaimCheck }) {
  const i = c.inputs
  const rows: [string, string][] = [
    ["Paper type", i.publication_type ?? "Not recorded"],
    ["Indexed in", i.indexing_level ?? "Not recorded"],
    ["Subject area", i.engineering_class ?? "Not classified"],
    ["Quartile", i.quartile ?? "Not recorded"],
    ["SNIP", i.snip == null ? "Not recorded" : String(i.snip)],
    ["Authors", `Author ${i.author_position} of ${i.total_authors}`],
    ["SEC-affiliated references evidenced", String(i.sec_references)],
    ["Priced as", i.priced_category ?? "Not priced"],
  ]
  return (
    <dl className="grid grid-cols-[minmax(0,1fr)] gap-x-8 gap-y-2 sm:grid-cols-2">
      {rows.map(([k, v]) => (
        <div key={k} className="flex items-baseline justify-between gap-3 border-b border-line py-1.5 text-sm">
          <dt className="text-fg-muted">{k}</dt>
          <dd className="text-right">{v}</dd>
        </div>
      ))}
    </dl>
  )
}
