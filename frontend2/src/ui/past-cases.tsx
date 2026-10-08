import { useState } from "react"
import { Link } from "react-router-dom"

import { Button } from "@/ui/button"
import { cn } from "@/lib/cn"
import { useApi } from "@/lib/query"
import { ClaimNo } from "@/ui/claim-number"
import { money } from "@/ui/paper"
import { Avatar, initialsOf } from "@/ui/person"
import { SkeletonText } from "@/ui/state"
import { Meta } from "@/ui/text"
import { unshout } from "@/lib/names"

/**
 * Past cases for the claim under review (`GET /api/claims/{id}/context`): the
 * claimant's earlier claims and how each ended, the same paper claimed by
 * co-authors, the same journal's history at the college, and payment-history
 * matches. Compact and grouped; every item opens its own claim.
 *
 * The server decides what is in the answer, by role. This component adds only
 * one rule of its own: it asks nothing at all for a faculty member or a head
 * of department, who are never shown other people's claims.
 *   - Amounts appear only when the server sent them.
 *   - The payment-history group appears only when the server sent it, which it
 *     does not for the Director and Finance.
 *   - A claim of one's own has no past cases: the reviewer seat is not theirs.
 */

type Outcome = { key: string; label: string }

type SendBack = { reason: string; kind: "faculty" | "internal" | "refused"; by: string | null; when: string }

type CaseItem = {
  id: string
  ticket_number: string | null
  paper_title: string
  journal_title: string | null
  publication_year: number | null
  filed_on: string | null
  outcome: Outcome
  remuneration?: number | null
  send_backs: SendBack[]
  owner_id?: string
  owner_name?: string | null
  owner_photo_url?: string | null
  owner_initials?: string | null
}

type Tally = { total: number; paid: number; in_progress: number; sent_back: number; rejected: number }

type DuplicateMatch = {
  id: string
  source: string
  title: string | null
  amount?: number | null
  reference: string | null
  who: string | null
  when: string | null
}

type LedgerMatch = {
  id: string
  paper_title: string | null
  faculty_name: string | null
  month: string | null
  voucher_number: string | null
  amount?: number | null
  claim_id: string | null
}

export type PastCasesData = {
  claim_id: string
  own_claim: boolean
  can_see_flags: boolean
  claimant: { user_id: string; name: string; department: string | null }
  previous_claims: CaseItem[]
  previous_total: number
  co_author_claims: CaseItem[]
  journal: { title: string | null; tally: Tally | null; recent: CaseItem[] }
  matches?: { duplicates: DuplicateMatch[]; ledger: LedgerMatch[] }
}

/** Roles that review claims, and so may read past cases. */
const REVIEWERS = new Set(["RESEARCH_CELL", "RESEARCH_COORDINATOR", "SUPER_ADMIN", "PRINCIPAL", "DIRECTOR", "FINANCE"])

const TONE: Record<string, string> = {
  paid: "bg-positive-wash text-positive",
  authorised: "bg-positive-wash text-positive",
  approved: "bg-positive-wash text-positive",
  sent_back: "bg-caution-wash text-caution",
  on_hold: "bg-caution-wash text-caution",
  rejected: "bg-critical-wash text-critical",
}

function OutcomeChip({ outcome }: { outcome: Outcome }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded-sm px-1.5 py-0.5 text-xs font-medium",
        TONE[outcome.key] ?? "bg-sunken text-fg-muted"
      )}
    >
      {outcome.label}
    </span>
  )
}

function year(iso: string | null): string {
  if (!iso) return ""
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString("en-IN", { month: "short", year: "numeric" })
}

function Item({ c, showWho, showJournal = true }: { c: CaseItem; showWho?: boolean; showJournal?: boolean }) {
  const reasons = c.send_backs.slice(0, 2)
  return (
    <li className="py-2 text-sm">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <ClaimNo value={c.ticket_number} />
          <Link
            to={`/papers/${c.id}`}
            className="block break-words leading-snug underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            {unshout(c.paper_title)}
          </Link>
        </div>
        <div className="shrink-0 text-right">
          <OutcomeChip outcome={c.outcome} />
          {c.remuneration != null && <span className="mt-0.5 block text-xs tabular text-fg-muted">{money(c.remuneration)}</span>}
        </div>
      </div>
      <Meta className="mt-0.5 flex items-center gap-1.5 text-xs">
        {showWho && c.owner_name && (
          <>
            <Avatar
              person={{ name: c.owner_name, initials: c.owner_initials || initialsOf(c.owner_name), photo_url: c.owner_photo_url ?? null }}
              size="xs"
              className="size-4 text-xs"
            />
            <span className="shrink-0">{c.owner_name}</span>
            <span aria-hidden>·</span>
          </>
        )}
        <span className="truncate">{[showJournal ? c.journal_title : null, year(c.filed_on)].filter(Boolean).join(" · ")}</span>
      </Meta>
      {reasons.map((r, i) => (
        <p key={i} className="mt-1 border-l-2 border-line pl-2 text-xs text-fg-muted">
          {r.kind === "internal" ? "Sent back inside the college" : "Sent back"}: {r.reason}
        </p>
      ))}
    </li>
  )
}

function Group({ title, count, children }: { title: string; count?: number; children: React.ReactNode }) {
  return (
    <section className="space-y-1">
      <h3 className="text-sm font-semibold">
        {title}
        {count != null && <span className="ml-1.5 font-normal text-fg-muted tabular">{count}</span>}
      </h3>
      {children}
    </section>
  )
}

function ItemList({ items, showWho, showJournal, limit = 4 }: { items: CaseItem[]; showWho?: boolean; showJournal?: boolean; limit?: number }) {
  const [all, setAll] = useState(false)
  const shown = all ? items : items.slice(0, limit)
  return (
    <>
      <ul className="divide-y divide-line">
        {shown.map((c) => (
          <Item key={c.id} c={c} showWho={showWho} showJournal={showJournal} />
        ))}
      </ul>
      {items.length > limit && (
        <Button kind="quiet" size="sm" onClick={() => setAll(!all)} className="text-accent hover:text-accent">
          {all ? "Show fewer" : `Show ${items.length - limit} more`}
        </Button>
      )}
    </>
  )
}

function tallySentence(t: Tally): string {
  const parts = [
    t.paid ? `${t.paid} paid` : "",
    t.in_progress ? `${t.in_progress} in progress` : "",
    t.sent_back ? `${t.sent_back} sent back` : "",
    t.rejected ? `${t.rejected} rejected` : "",
  ].filter(Boolean)
  return `${t.total} ${t.total === 1 ? "claim" : "claims"} at the college${parts.length ? `: ${parts.join(", ")}` : ""}.`
}

/** An ERP claim ref arrives as a spreadsheet number ("3089.0"). */
const refText = (r: string | null) => (r ? r.replace(/.0$/, "") : r)

/** The view, on data already in hand. Exported for tests and for a workspace that has fetched it already. */
export function PastCasesView({ data }: { data: PastCasesData }) {
  if (data.own_claim) {
    return <p className="text-sm text-fg-muted">This is your own claim, so its past cases are not shown here.</p>
  }
  const dups = data.matches?.duplicates ?? []
  const ledger = data.matches?.ledger ?? []
  const nothing =
    data.previous_claims.length === 0 &&
    data.co_author_claims.length === 0 &&
    data.journal.recent.length === 0 &&
    dups.length === 0 &&
    ledger.length === 0
  if (nothing) {
    return <p className="text-sm text-fg-muted">No earlier claims by {data.claimant.name}, and nothing else on record for this paper or journal.</p>
  }
  return (
    <div className="space-y-5">
      <Group title={`Earlier claims by ${data.claimant.name}`} count={data.previous_total}>
        {data.previous_claims.length === 0 ? (
          <p className="text-sm text-fg-muted">This is their first claim.</p>
        ) : (
          <ItemList items={data.previous_claims} />
        )}
      </Group>

      {data.co_author_claims.length > 0 && (
        <Group title="The same paper, claimed by others" count={data.co_author_claims.length}>
          <ItemList items={data.co_author_claims} showWho />
        </Group>
      )}

      {data.journal.title && data.journal.recent.length > 0 && (
        <Group title={`${data.journal.title} at the college`}>
          {data.journal.tally && <Meta className="block text-xs">{tallySentence(data.journal.tally)}</Meta>}
          <ItemList items={data.journal.recent} showWho showJournal={false} limit={3} />
        </Group>
      )}

      {(dups.length > 0 || ledger.length > 0) && (
        <Group title="Payment history matches" count={dups.length + ledger.length}>
          <ul className="divide-y divide-line">
            {dups.map((m) => (
              <li key={m.id} className="py-2 text-sm">
                {m.source === "claim" ? (
                  <Link to={`/papers/${m.id}`} className="underline underline-offset-2">
                    {[refText(m.reference), m.who, m.when].filter(Boolean).join(" · ") || "Another claim"}
                  </Link>
                ) : (
                  <span>{[refText(m.reference), m.who, m.when].filter(Boolean).join(" · ") || "An earlier payment"}</span>
                )}
                {m.amount != null && <span className="text-fg-muted tabular"> · {money(m.amount)}</span>}
                {m.title && <Meta className="block text-xs">{m.title}</Meta>}
              </li>
            ))}
            {ledger.map((l) => (
              <li key={l.id} className="py-2 text-sm">
                <span>
                  Ledger {l.month ?? ""}
                  {l.voucher_number ? ` · voucher ${l.voucher_number}` : ""}
                  {l.faculty_name ? ` · ${l.faculty_name}` : ""}
                </span>
                {l.amount != null && <span className="text-fg-muted tabular"> · {money(l.amount)}</span>}
                {l.paper_title && <Meta className="block text-xs">{unshout(l.paper_title)}</Meta>}
              </li>
            ))}
          </ul>
        </Group>
      )}
    </div>
  )
}

/**
 * Past cases for a claim. `role` is the signed-in person's role: anyone who
 * does not review claims gets nothing, and no request is made.
 */
export function PastCases({ claimId, role }: { claimId: string; role: string | null | undefined }) {
  const allowed = !!role && REVIEWERS.has(role)
  const { data, isLoading, isError } = useApi<PastCasesData>(["claim-context", claimId], `/api/claims/${claimId}/context`, {
    enabled: allowed,
    staleTime: 60_000,
  })
  if (!allowed) return null
  if (isLoading) return <SkeletonText lines={4} />
  if (isError || !data) return <p className="text-sm text-fg-muted">Past cases could not be loaded. The claim itself is unaffected.</p>
  return <PastCasesView data={data} />
}
