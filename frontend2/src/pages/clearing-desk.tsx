import { useState } from "react"
import { Link } from "react-router-dom"

import { api } from "@/lib/api"
import { cn } from "@/lib/cn"
import { useApi, useApiMutation } from "@/lib/query"
import { Button } from "@/ui/button"
import { Field, Input, Textarea } from "@/ui/field"
import { money } from "@/ui/paper"
import { Callout, EmptyState, ErrorState, SkeletonRows } from "@/ui/state"
import { Meta, SectionTitle } from "@/ui/text"
import { toast } from "@/ui/toast"

/**
 * The research cell's desk tools that sit beside the queue: the journal
 * watch-list, the scheme rules a ticket falls under, ageing buckets, and the
 * monthly processing report. Server: backend/core/api/research_cell.py.
 */

export type Watch = {
  id: string
  issn: string | null
  title: string | null
  reason: string
  added_by_name: string | null
  created_at: string | null
  waiting?: number
}

/** What a queue row carries for these tools. */
export type DeskFields = {
  journal_watch?: Watch | null
  quota_applied?: boolean | null
  quota_note?: string | null
  quota_position?: number | null
  owner_faculty_type?: string | null
  owner_research_quota?: number | null
  claim_reason?: string | null
  team?: { code: string; title?: string | null; mentor_name?: string | null } | null
  publication_year: number | null
  verification_ok: boolean | null
  duplicate_warning: boolean
  contest_forward?: boolean | null
  calc_error: string | null
  affiliation_ok?: boolean | null
  remuneration: number | null
  waiting_days: number | null
}

/* ------------------------------------------------------------------------ */
/* Ageing and "ready to clear"                                              */
/* ------------------------------------------------------------------------ */

export const AGE_BUCKETS = [
  { id: "week", label: "A week or less", test: (d: number) => d <= 7 },
  { id: "fortnight", label: "8 to 14 days", test: (d: number) => d > 7 && d <= 14 },
  { id: "month", label: "15 to 30 days", test: (d: number) => d > 14 && d <= 30 },
  { id: "older", label: "Over 30 days", test: (d: number) => d > 30 },
] as const
export type AgeBucket = (typeof AGE_BUCKETS)[number]["id"]

export function inBucket(days: number | null | undefined, bucket: AgeBucket | ""): boolean {
  if (!bucket) return true
  return AGE_BUCKETS.find((b) => b.id === bucket)!.test(days ?? 0)
}

/** Nothing on the ticket asks a question: safe to clear in a batch. */
export function isClean(c: DeskFields): boolean {
  return (
    c.verification_ok === true &&
    !c.duplicate_warning &&
    !c.contest_forward &&
    !c.calc_error &&
    c.affiliation_ok !== false &&
    !c.journal_watch &&
    c.remuneration != null
  )
}

/** How many rows fall in each ageing bucket, in bucket order. */
export function ageSplit(rows: { waiting_days?: number | null }[]) {
  return AGE_BUCKETS.map((b) => ({ id: b.id, label: b.label, n: rows.filter((r) => b.test(r.waiting_days ?? 0)).length }))
}

export function isAgeBucket(v: string | null): v is AgeBucket {
  return AGE_BUCKETS.some((b) => b.id === v)
}

/** Home's read-only copy of the queue's ageing chips; each opens the queue filtered. */
export function AgeingSplit({ rows }: { rows: { waiting_days?: number | null }[] }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5" aria-label="How long tickets have waited">
      <Meta>Waiting</Meta>
      {ageSplit(rows).map((b) => (
        <Link
          key={b.id}
          to={`/clearing?age=${b.id}`}
          className={cn(
            "rounded-full px-2.5 py-1 text-xs ring-1 ring-inset",
            b.n === 0
              ? "bg-surface text-fg-subtle ring-line"
              : b.id === "older"
                ? "bg-critical-wash text-critical ring-line"
                : b.id === "month"
                  ? "bg-caution-wash text-caution ring-line"
                  : "bg-surface text-fg-muted ring-line hover:text-fg"
          )}
        >
          {b.label} <span className="tabular">{b.n}</span>
        </Link>
      ))}
    </div>
  )
}

export function AgeingChips({
  rows,
  value,
  onChange,
}: {
  rows: DeskFields[]
  value: AgeBucket | ""
  onChange: (v: AgeBucket | "") => void
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Filter by how long it has waited">
      <Meta>Waiting</Meta>
      {AGE_BUCKETS.map((b) => {
        const n = rows.filter((r) => b.test(r.waiting_days ?? 0)).length
        return (
          <button
            key={b.id}
            type="button"
            aria-pressed={value === b.id}
            disabled={n === 0 && value !== b.id}
            onClick={() => onChange(value === b.id ? "" : b.id)}
            className={cn(
              "rounded-full px-2.5 py-1 text-xs ring-1 ring-inset disabled:opacity-50",
              value === b.id
                ? "bg-accent text-accent-fg ring-accent"
                : b.id === "older" && n > 0
                  ? "bg-critical-wash text-critical ring-line"
                  : b.id === "month" && n > 0
                    ? "bg-caution-wash text-caution ring-line"
                    : "bg-surface text-fg-muted ring-line hover:text-fg"
            )}
          >
            {b.label} <span className="tabular">{n}</span>
          </button>
        )
      })}
    </div>
  )
}

/* ------------------------------------------------------------------------ */
/* On the ticket                                                            */
/* ------------------------------------------------------------------------ */

export function WatchCallout({ watch }: { watch: Watch }) {
  return (
    <Callout tone="critical" title="This journal is on the watch-list">
      {watch.reason}
      {watch.added_by_name && ` Added by ${watch.added_by_name}.`} Batch clearing skips it; decide it here.
    </Callout>
  )
}

/** The research quota and the final-year project rule, stated for this
 *  ticket so the desk does not have to remember them. */
export function SchemeRules({ c }: { c: DeskFields }) {
  const fyp = c.claim_reason === "STUDENT_PROJECT" || !!c.team
  const research = c.owner_faculty_type === "RESEARCH"
  if (!fyp && !research) return null
  return (
    <section className="space-y-2">
      <SectionTitle>Scheme rules on this ticket</SectionTitle>
      {fyp && (
        <p className="text-sm">
          Final-year project scheme: one claim per team, filed by the mentor, a fixed amount per conference paper
          (Rs 15,000 in the current policy).
          {c.team && (
            <>
              {" "}
              Team <span className="font-medium">{c.team.code}</span>
              {c.team.mentor_name && <>, mentor {c.team.mentor_name}</>}.
            </>
          )}{" "}
          The research quota does not apply.
        </p>
      )}
      {research && !fyp && (
        <p className="text-sm">
          Research faculty.{" "}
          {c.owner_research_quota
            ? `Quota: the first ${c.owner_research_quota} ${c.owner_research_quota === 1 ? "paper" : "papers"} of a year are unpaid.`
            : "No quota is set for this person."}{" "}
          {c.quota_position != null && c.publication_year != null && (
            <>
              This is paper {c.quota_position} of {c.publication_year}.{" "}
            </>
          )}
          <span className={cn("font-medium", c.quota_applied ? "text-caution" : "text-positive")}>
            {c.quota_applied ? "Inside the quota, so the amount is nil." : "Outside the quota, so it is paid."}
          </span>
          {c.quota_note && <Meta className="mt-1 block">{c.quota_note}</Meta>}
        </p>
      )}
    </section>
  )
}

/* ------------------------------------------------------------------------ */
/* Journal watch-list                                                       */
/* ------------------------------------------------------------------------ */

export function JournalWatchList() {
  const list = useApi<Watch[]>(["journal-watch"], "/api/admin/journal-watch")
  const add = useApiMutation<{ issn?: string; title?: string; reason: string }, Watch>("/api/admin/journal-watch", {
    invalidates: [["journal-watch"], ["clearing-queue"]],
  })
  const [issn, setIssn] = useState("")
  const [title, setTitle] = useState("")
  const [reason, setReason] = useState("")

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    try {
      await add.mutateAsync({ issn: issn.trim() || undefined, title: title.trim() || undefined, reason })
      setIssn("")
      setTitle("")
      setReason("")
      toast.ok("Added to the watch-list")
    } catch (err) {
      toast.fail(err)
    }
  }

  async function remove(w: Watch) {
    try {
      await api(`/api/admin/journal-watch/${w.id}`, { method: "DELETE" })
      void list.refetch()
      toast.ok("Taken off the watch-list")
    } catch (err) {
      toast.fail(err)
    }
  }

  return (
    <section aria-labelledby="watch-h" className="space-y-4">
      <div>
        <SectionTitle id="watch-h">Journal watch-list</SectionTitle>
        <p className="mt-1 text-sm text-fg-muted">
          Journals the research cell wants to look at twice: suspected clones, venues about to be discontinued,
          publishers with complaints. Every ticket in one carries a warning, and batch clearing skips it.
        </p>
      </div>
      <form onSubmit={submit} className="grid grid-cols-[minmax(0,1fr)] gap-3 md:grid-cols-[10rem_minmax(0,1fr)]">
        <Field label="ISSN">
          <Input value={issn} onChange={(e) => setIssn(e.target.value)} placeholder="1234-5678" />
        </Field>
        <Field label="Journal title (if no ISSN)">
          <Input value={title} onChange={(e) => setTitle(e.target.value)} />
        </Field>
        <div className="md:col-span-2">
          <Field label="Why">
            <Textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={2}
              placeholder="For example: cloned site of a discontinued journal, same ISSN"
            />
          </Field>
        </div>
        <div className="md:col-span-2">
          <Button type="submit" kind="primary" size="sm" disabled={add.isPending || !reason.trim() || (!issn.trim() && !title.trim())}>
            Add to the watch-list
          </Button>
        </div>
      </form>
      {list.isLoading ? (
        <SkeletonRows rows={3} rowHeight={44} />
      ) : list.isError ? (
        <ErrorState title="Could not load the watch-list" onRetry={() => list.refetch()} />
      ) : (list.data ?? []).length === 0 ? (
        <EmptyState art="empty-queue" title="No journal is being watched" message="Add one above when a venue looks doubtful." />
      ) : (
        <ul className="divide-y divide-line border-y border-line">
          {(list.data ?? []).map((w) => (
            <li key={w.id} className="flex flex-wrap items-start justify-between gap-3 py-3">
              <div className="min-w-0 flex-1">
                <p className="break-words font-medium">
                  {w.title || "Untitled"} {w.issn && <span className="tabular text-fg-muted">ISSN {w.issn}</span>}
                </p>
                <p className="break-words text-sm">{w.reason}</p>
                <Meta className="block">
                  {w.added_by_name ? `Added by ${w.added_by_name}` : "Added"}
                  {w.created_at && ` on ${new Date(w.created_at).toLocaleDateString("en-IN")}`}
                  {" · "}
                  {w.waiting ? `${w.waiting} waiting to be cleared` : "nothing waiting"}
                </Meta>
              </div>
              <Button kind="quiet" size="sm" onClick={() => void remove(w)}>
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

/* ------------------------------------------------------------------------ */
/* Monthly processing report                                                */
/* ------------------------------------------------------------------------ */

type Report = {
  month: string
  received: number
  cleared: number
  sent_back: number
  not_accepted: number
  amount_cleared: number
  median_days: number | null
  within_week: number
  decided: number
  waiting_now: number
  by_person: { name: string; cleared: number; sent_back: number; not_accepted: number }[]
  ageing: { bucket: string; count: number }[]
}

function thisMonth(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`
}

export function MonthlyReport() {
  const [month, setMonth] = useState(thisMonth())
  const q = useApi<Report>(["clearing-report", month], `/api/admin/clearing-report?month=${month}`)
  const r = q.data
  return (
    <section aria-labelledby="report-h" className="space-y-4 border-t border-line pt-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <SectionTitle id="report-h">Monthly processing report</SectionTitle>
          <p className="mt-1 text-sm text-fg-muted">What this desk decided in a month, and how fast. For the Principal and for NAAC.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            type="month"
            value={month}
            onChange={(e) => e.target.value && setMonth(e.target.value)}
            aria-label="Month"
            className="w-40"
          />
          <a
            href={`/api/admin/clearing-report?month=${month}&format=csv`}
            className="text-sm font-medium text-accent underline underline-offset-2"
          >
            Download CSV
          </a>
        </div>
      </div>
      {q.isLoading ? (
        <SkeletonRows rows={2} rowHeight={48} />
      ) : q.isError || !r ? (
        <ErrorState title="Could not load the report" onRetry={() => q.refetch()} />
      ) : (
        <>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3 lg:grid-cols-6">
            <Fig label="Received" value={String(r.received)} />
            <Fig label="Cleared" value={String(r.cleared)} note={money(r.amount_cleared)} />
            <Fig label="Sent back" value={String(r.sent_back)} />
            <Fig label="Not accepted" value={String(r.not_accepted)} />
            <Fig
              label="Median days to decide"
              value={r.median_days == null ? "None decided" : String(r.median_days)}
              note={r.decided ? `${r.within_week} of ${r.decided} within a week` : undefined}
            />
            <Fig label="Waiting now" value={String(r.waiting_now)} />
          </dl>
          <div className="grid grid-cols-[minmax(0,1fr)] gap-6 md:grid-cols-2">
            <div>
              <Meta className="block">How long the waiting tickets have waited</Meta>
              <ul className="mt-1 text-sm">
                {r.ageing.map((a) => (
                  <li key={a.bucket} className="flex justify-between border-b border-line py-1">
                    <span>{a.bucket[0].toUpperCase() + a.bucket.slice(1)}</span>
                    <span className="tabular">{a.count}</span>
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <Meta className="block">Who decided</Meta>
              {r.by_person.length === 0 ? (
                <p className="mt-1 text-sm text-fg-muted">No decisions this month.</p>
              ) : (
                <ul className="mt-1 text-sm">
                  {r.by_person.map((p) => (
                    <li key={p.name} className="flex flex-wrap justify-between gap-2 border-b border-line py-1">
                      <span>{p.name}</span>
                      <span className="tabular text-fg-muted">
                        {p.cleared} cleared, {p.sent_back} sent back, {p.not_accepted} not accepted
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </>
      )}
    </section>
  )
}

function Fig({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div>
      <dt className="text-xs text-fg-muted">{label}</dt>
      <dd className="text-xl tabular">{value}</dd>
      {note && <dd className="text-xs text-fg-muted">{note}</dd>}
    </div>
  )
}
