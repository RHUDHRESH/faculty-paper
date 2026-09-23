import { Link } from "react-router-dom"
import { AlertTriangle } from "lucide-react"

import { useApi } from "@/lib/query"
import { money } from "@/ui/paper"
import { InlineError, SkeletonText } from "@/ui/state"
import { Meta, SectionTitle } from "@/ui/text"
import { When } from "@/ui/when"

/**
 * The history around one claim, for the desk deciding it.
 *
 * The Principal asked to click a claim and see the patterns behind it: what
 * this person has claimed before, what the college's record with this
 * journal looks like, how the department is trending, and anything that
 * should make her look twice. All four come from report endpoints she can
 * already read; nothing here is new data, only put where the decision is.
 */

type Row = { key: string; count: number; amount: number }

type FacultyReport = {
  totals: { publications: number; paid_claims: number; paid_amount: number; in_review: number }
  by_year: Row[]
  claims: {
    id: string
    ticket_number: string | null
    paper_title: string
    journal_title: string | null
    status: string
    remuneration: number | null
    submitted_at: string | null
    created_at?: string | null
  }[]
}

type JournalReport = {
  totals: {
    publications: number
    authors: number
    departments: number
    paid_claims: number
    paid_amount: number
    first_year: number | null
    last_year: number | null
  }
}

type DepartmentReport = { by_year: Row[] }

export type ContextClaim = {
  id: string
  owner_id?: string
  owner_department?: string | null
  journal_title: string | null
  remuneration: number | null
  duplicate_warning?: boolean
  contest_forward?: boolean | null
  verification_ok?: boolean | null
  needs_second_approval?: boolean
  remuneration_is_estimate?: boolean
  calc_error?: string | null
}

export function ClaimContext({ claim }: { claim: ContextClaim }) {
  const person = useApi<FacultyReport>(
    ["faculty-report", claim.owner_id],
    `/api/faculty/${claim.owner_id}/report`,
    { enabled: !!claim.owner_id }
  )
  const journal = useApi<JournalReport>(
    ["journal-report", claim.journal_title],
    `/api/journals/report?title=${encodeURIComponent(claim.journal_title || "")}`,
    { enabled: !!claim.journal_title }
  )
  const dept = useApi<DepartmentReport>(
    ["reports", "department", claim.owner_department],
    `/api/reports?department=${encodeURIComponent(claim.owner_department || "")}`,
    { enabled: !!claim.owner_department }
  )

  const others = (person.data?.claims ?? []).filter((c) => c.id !== claim.id)
  const recent = others.filter((c) => {
    const at = c.submitted_at || c.created_at
    return at && Date.now() - new Date(at).getTime() < 90 * 86_400_000
  })

  const flags: string[] = []
  if (claim.duplicate_warning) flags.push("It may already have been paid (a matching payment is on record).")
  if (claim.contest_forward) flags.push("The claimant contested a possible match and sent it on anyway.")
  if (claim.verification_ok === false) flags.push("Verification did not pass; see the reasons above.")
  if (claim.remuneration_is_estimate) flags.push("The amount rests on values the claimant reported, not verified ones.")
  if (claim.needs_second_approval) flags.push("Over the high-value threshold: it needs a second, different signature.")
  if (recent.length >= 3) flags.push(`${recent.length} other claims from this person in the last 90 days.`)

  const years = (dept.data?.by_year ?? []).slice(-5)
  const maxYear = Math.max(1, ...years.map((y) => y.count))

  return (
    <section className="space-y-5">
      <SectionTitle>Around this claim</SectionTitle>

      <div className="space-y-2">
        <p className="text-sm font-medium">Things to look at</p>
        {flags.length === 0 ? (
          <p className="text-sm text-fg-muted">Nothing unusual about this one.</p>
        ) : (
          <ul className="space-y-1.5">
            {flags.map((f) => (
              <li key={f} className="flex gap-2 text-sm text-caution">
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                <span>{f}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="space-y-2">
        <p className="text-sm font-medium">This person's record</p>
        {person.isLoading ? (
          <SkeletonText lines={3} />
        ) : person.isError ? (
          <InlineError message="Could not load their record." onRetry={() => person.refetch()} />
        ) : person.data ? (
          <>
            <p className="text-sm text-fg-muted">
              {person.data.totals.publications} papers on record ·{" "}
              {person.data.totals.paid_claims} paid, {money(person.data.totals.paid_amount)} in all
            </p>
            {others.length > 0 && (
              <ul className="divide-y divide-line rounded-md ring-1 ring-line">
                {others.slice(0, 5).map((c) => (
                  <li key={c.id} className="flex items-baseline gap-3 px-3 py-2 text-sm">
                    <Link to={`/papers/${c.id}`} className="min-w-0 flex-1 truncate hover:underline">
                      {c.paper_title}
                    </Link>
                    <Meta className="shrink-0">
                      <When iso={c.submitted_at || c.created_at} />
                    </Meta>
                    <span className="figure shrink-0">{money(c.remuneration)}</span>
                  </li>
                ))}
              </ul>
            )}
          </>
        ) : null}
      </div>

      {claim.journal_title && (
        <div className="space-y-1">
          <p className="text-sm font-medium">This journal at the college</p>
          {journal.isLoading ? (
            <SkeletonText lines={1} />
          ) : journal.data ? (
            <p className="text-sm text-fg-muted">
              {journal.data.totals.publications} paper{journal.data.totals.publications === 1 ? "" : "s"} by {journal.data.totals.authors}{" "}
              {journal.data.totals.authors === 1 ? "person" : "people"} in{" "}
              {journal.data.totals.departments} department{journal.data.totals.departments === 1 ? "" : "s"}
              {journal.data.totals.first_year ? `, ${journal.data.totals.first_year}–${journal.data.totals.last_year}` : ""}
              ; {journal.data.totals.paid_claims} paid, {money(journal.data.totals.paid_amount)}.{" "}
              <Link
                to={`/journals/${encodeURIComponent(claim.journal_title)}`}
                className="text-accent hover:underline"
              >
                Open the journal
              </Link>
            </p>
          ) : (
            <p className="text-sm text-fg-muted">No other paper here in this journal.</p>
          )}
        </div>
      )}

      {years.length > 0 && (
        <div className="space-y-2">
          <p className="text-sm font-medium">{claim.owner_department} — papers per year</p>
          <ol className="flex items-end justify-start gap-3" aria-label="Papers per year">
            {years.map((y) => (
              <li key={y.key} className="flex w-10 flex-col items-center gap-1">
                <span className="text-xs tabular text-fg-muted">{y.count}</span>
                <span
                  aria-hidden
                  className="w-full max-w-10 rounded-sm bg-accent"
                  style={{ height: `${Math.max(4, (y.count / maxYear) * 56)}px` }}
                />
                <span className="text-xs text-fg-subtle">{y.key}</span>
              </li>
            ))}
          </ol>
        </div>
      )}
    </section>
  )
}
