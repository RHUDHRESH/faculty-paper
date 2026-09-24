import { LoaderCircle, Search } from "lucide-react"

import { useCollegeName } from "@/app/institution"
import { cn } from "@/lib/cn"
import { Button } from "@/ui/button"
import { Textarea } from "@/ui/field"
import { money } from "@/ui/paper"
import { Callout, InlineError } from "@/ui/state"

import { formatBytes, SummaryRow } from "./bits"
import { readableDate } from "./identifiers"
import { PROBLEM_STYLE, zeroReason, type Problem } from "./readiness"
import type { CalcResult, FilingRules, FormState, PriorCheckResult } from "./types"

/** The form stores the policy's own tokens; a person reads these. */
const TYPE_TEXT: Record<string, string> = {
  Journal: "Journal article",
  "Conference Proceeding": "Conference proceeding",
  "Book Series": "Book or book chapter",
}

const REASON_TEXT: Record<FormState["claimReason"], string> = {
  INCENTIVE: "Faculty publication incentive",
  STUDENT_PROJECT: "Student project conference incentive",
  COUNT_ONLY: "Publication count only — no payment",
}

function Part({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5 border-t border-dashed border-edge pt-3 first:border-t-0 first:pt-0">
      <p className="text-xs font-medium uppercase tracking-[0.04em] text-fg-muted">{title}</p>
      <dl className="space-y-1.5 text-sm">{children}</dl>
    </div>
  )
}

/**
 * The claim, read back like a receipt: every answer under the part of the
 * form it came from, each with a way to change it, and the estimate as the
 * line at the bottom.
 *
 * A receipt because that is the question this screen answers -- "is this what
 * I am sending?" -- and a claimant checking a receipt reads down it once, in
 * order, and stops at the line that is wrong.
 */
export function Receipt({
  form,
  calc,
  countOnly,
  onChange,
}: {
  form: FormState
  calc: CalcResult | null
  countOnly: boolean
  onChange: (step: number, field: string) => void
}) {
  const collegeName = useCollegeName()
  const papers = form.attachments.filter((a) => a.kind === "PUBLISHED_PAPER")
  const refs = form.attachments.filter((a) => a.kind === "SEC_REFERENCE")
  const me = form.authors.find((a) => a.position === form.authorPosition)

  return (
    <section aria-label="Your claim" className="panel space-y-3 p-4 sm:p-5">
      <Part title="The paper">
        <SummaryRow label="Title" value={form.paperTitle} onChange={() => onChange(0, "title")} />
        <SummaryRow label="DOI" value={form.doi} onChange={() => onChange(0, "doi")} />
        <SummaryRow
          label="Type"
          value={TYPE_TEXT[form.publicationType] ?? form.publicationType}
          onChange={() => onChange(0, "type")}
        />
        <SummaryRow
          label="Published"
          value={form.publicationDate ? readableDate(form.publicationDate) : ""}
          onChange={() => onChange(0, "date")}
        />
        <SummaryRow
          label="Filed as"
          value={`${REASON_TEXT[form.claimReason]}${form.claimReason === "STUDENT_PROJECT" && form.teamCode ? ` · team ${form.teamCode}` : ""}`}
          onChange={() => onChange(0, "reason")}
        />
      </Part>

      <Part title="The journal">
        <SummaryRow label="Journal" value={form.journalTitle} onChange={() => onChange(1, "journal")} />
        <SummaryRow label="ISSN" value={form.issn} onChange={() => onChange(1, "issn")} />
        <SummaryRow
          label="Indexed in"
          value={form.indexing
            .map((i) =>
              i === "AU Annexure" && form.auAnnexureRef
                ? `AU Annexure (${form.auAnnexureRef})`
                : i === "UGC Care" && form.ugcCareRef
                  ? `UGC Care (${form.ugcCareRef})`
                  : i
            )
            .join(", ")}
          onChange={() => onChange(1, "indexing")}
        />
        <SummaryRow label="Yukthi ID" value={form.yukthiId} onChange={() => onChange(1, "yukthi")} />
        {!countOnly && (
          <SummaryRow
            label="Quartile and SNIP"
            value={[form.selfReportedQuartile, form.selfReportedSnip && `SNIP ${form.selfReportedSnip}`]
              .filter(Boolean)
              .join(" · ") || "Not declared"}
            onChange={() => onChange(1, "standing")}
          />
        )}
      </Part>

      <Part title="You">
        <SummaryRow
          label="Author position"
          value={`${form.authorPosition} of ${form.totalAuthors}${me ? ` — ${me.name}` : ""}`}
          onChange={() => onChange(2, "position")}
        />
        <SummaryRow
          label="Affiliation"
          value={form.affiliationOk ? `Confirmed: ${collegeName}` : "Not confirmed"}
          onChange={() => onChange(2, "affiliation")}
        />
        <SummaryRow
          label="Scopus profile"
          value={form.scopusAuthorUrl}
          onChange={() => onChange(2, "scopus")}
        />
        <SummaryRow label="Designation" value={form.designation} onChange={() => onChange(2, "scopus")} />
      </Part>

      <Part title="The proof">
        <SummaryRow
          label="Published paper"
          value={papers.length ? papers.map((p) => `${p.filename} (${formatBytes(p.size_bytes)})`).join(", ") : "None attached"}
          onChange={() => onChange(3, "paper-file")}
        />
        <SummaryRow
          label="Cited references"
          value={
            refs.length
              ? refs
                  .map((r) => ((r.ref_number || "").trim() ? `No. ${r.ref_number}` : `${r.filename} (no number)`))
                  .join(", ")
              : "None attached"
          }
          onChange={() => onChange(3, "refs")}
        />
      </Part>

      {!countOnly && (
        <div className="flex flex-wrap items-baseline justify-between gap-2 border-t-2 border-edge pt-3">
          <span className="text-base font-medium">Estimated payout</span>
          <span className="figure text-2xl">
            {calc?.remuneration != null ? money(calc.remuneration) : "—"}
          </span>
        </div>
      )}
    </section>
  )
}

/**
 * Every rule the paper has to meet, and whether it does. Shows what passes
 * as well as what does not: "nothing is wrong" is only reassuring if you can
 * see what was checked.
 */
export function PreFlight({
  problems,
  rules,
  form,
  onGoToProblem,
}: {
  problems: Problem[]
  rules: FilingRules
  form: FormState
  onGoToProblem: (p: Problem) => void
}) {
  const collegeName = useCollegeName()
  const refs = form.attachments.filter((a) => a.kind === "SEC_REFERENCE")
  const numbered = refs.filter((r) => (r.ref_number || "").trim()).length
  const byKey = new Map(problems.map((p) => [p.key, p]))

  const rows: { key: string; label: string; fallbacks?: string[] }[] = [
    { key: "title", label: "The paper has a title, a type and a date", fallbacks: ["type", "date", "doi"] },
    { key: "issn", label: "The journal has a valid ISSN", fallbacks: ["journal"] },
    { key: "indexing", label: "At least one indexing level, with its reference", fallbacks: ["au", "ugc", "yukthi"] },
    { key: "quartile", label: "The journal has a quartile" },
    { key: "scopus", label: "Your Scopus author profile is linked", fallbacks: ["linkage"] },
    { key: "author-cap", label: `The paper has ${rules.max_authors} authors or fewer`, fallbacks: ["authors", "position", "position-found"] },
    { key: "affiliation", label: `Affiliated to ${collegeName}`, fallbacks: ["affiliation-found"] },
    { key: "paper-file", label: "The published paper is attached", fallbacks: ["file-twice", "file-dup"] },
    {
      key: "refs-few",
      label: `${rules.min_sec_references} cited SEC references attached and numbered (${numbered} of ${refs.length} attached ${refs.length === 1 ? "file carries" : "files carry"} a number)`,
      fallbacks: ["refs-none", "ref-numbers", "refs-url-only", "ref-numbers-zero", "ref-numbers-some", "file-twice-ref", "file-dup-ref"],
    },
    { key: "prior", label: "No earlier payment found for this paper" },
  ]

  return (
    <section className="space-y-2">
      <h3 className="text-base font-semibold">Before it goes</h3>
      <ul className="divide-y divide-line border-y border-line">
        {rows.map((row) => {
          const problem = byKey.get(row.key) ?? row.fallbacks?.map((k) => byKey.get(k)).find(Boolean)
          const style = problem ? PROBLEM_STYLE[problem.kind] : null
          return (
            <li key={row.key} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 py-2">
              <span className="min-w-0 text-sm">
                {row.label}
                {problem && <span className="block text-xs text-fg-muted">{problem.label}</span>}
              </span>
              {problem ? (
                <button
                  type="button"
                  onClick={() => onGoToProblem(problem)}
                  className={cn(
                    "shrink-0 text-sm font-medium underline-offset-2 hover:underline",
                    style?.tone === "critical" && "text-critical",
                    style?.tone === "caution" && "text-caution",
                    style?.tone === "info" && "text-fg-muted"
                  )}
                >
                  {style?.word}
                </button>
              ) : (
                <span className="shrink-0 text-sm text-positive">Yes</span>
              )}
            </li>
          )
        })}
      </ul>
    </section>
  )
}

/** The estimate's working, under the receipt. */
export function EstimateDetail({
  calc,
  calcBusy,
  calcFailed,
  priceable,
  countOnly,
  problems,
  onRetryCalc,
}: {
  calc: CalcResult | null
  calcBusy: boolean
  calcFailed: boolean
  priceable: boolean
  countOnly: boolean
  problems: Problem[]
  onRetryCalc: () => void
}) {
  if (countOnly) {
    return (
      <p className="text-sm text-fg-muted">
        No payment is being claimed. The publication goes on your record and no amount is worked out.
      </p>
    )
  }
  if (calcBusy && !calc) {
    return (
      <p className="flex items-center gap-1.5 text-sm text-fg-muted">
        <LoaderCircle className="size-3.5 animate-spin" aria-hidden />
        Working out the estimate…
      </p>
    )
  }
  if (calcFailed) {
    return (
      <InlineError
        message="Could not work out the estimate. It is missing because the server did not answer, not because the paper is worth nothing."
        onRetry={onRetryCalc}
      />
    )
  }
  if (calc?.error) {
    return (
      <Callout tone="critical" title="This amount could not be worked out">
        {calc.error}
      </Callout>
    )
  }
  if (!calc) {
    return (
      <p className="text-sm text-fg-muted">
        {priceable ? "No estimate yet." : "Not enough entered yet — the quartile, the SNIP or the indexing level is what prices a paper."}
      </p>
    )
  }
  return (
    <div className="space-y-2">
      {calc.remuneration === 0 && (
        <Callout tone="critical" title="This estimate is ₹0 — filing it pays nothing">
          <p>{zeroReason(calc, problems)}</p>
        </Callout>
      )}
      <dl className="grid gap-x-6 gap-y-1.5 text-sm sm:grid-cols-2">
        <SummaryRow label="Base amount" value={money(calc.base)} />
        <SummaryRow label="Quartile incentive" value={money(calc.qf)} />
        <SummaryRow label="Author point" value={calc.point != null ? calc.point.toFixed(3) : "—"} />
        {calc.category_label && <SummaryRow label="Category" value={calc.category_label} />}
      </dl>
      {calc.note && calc.remuneration !== 0 && <p className="text-sm text-fg-muted">{calc.note}</p>}
      <p className="text-sm text-fg-muted">
        This is an estimate from the SNIP and quartile on this form. The research cell verifies both
        after you file, and the figure can change.
      </p>
    </div>
  )
}

/** Whether this paper was paid for before, said either way. */
export function PriorCheckLine({
  priorCheck,
  busy,
  onRecheck,
}: {
  priorCheck: PriorCheckResult | null
  busy: boolean
  onRecheck: () => void
}) {
  return (
    <div className="space-y-2">
      {priorCheck?.warning && (
        <Callout tone="critical" title="This paper may already have been paid">
          <p>Check the matches below before filing — you can still go ahead once you have.</p>
          {priorCheck.matches.length > 0 && (
            <ul className="mt-2 space-y-1">
              {priorCheck.matches.map((m, i) => (
                <li key={i} className="text-sm">
                  {m.title && <span className="block">{m.title}</span>}
                  <span className="text-fg-muted">
                    {[m.reference, m.who, m.when].filter(Boolean).join(" · ") || "A prior payment"}
                    {m.amount != null && <> — {money(m.amount)}</>}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Callout>
      )}
      <div className="flex flex-wrap items-center gap-2 text-sm">
        {busy ? (
          <span className="flex items-center gap-1.5 text-fg-muted">
            <LoaderCircle className="size-3.5 animate-spin" aria-hidden />
            Checking whether this paper has been paid for before…
          </span>
        ) : priorCheck && !priorCheck.warning ? (
          <span className="text-fg-muted">No earlier payment found for this paper.</span>
        ) : !priorCheck ? (
          <span className="text-caution">
            The check for an earlier payment has not come back. The research cell runs it again after
            filing.
          </span>
        ) : null}
        <Button kind="quiet" size="sm" onClick={onRecheck} disabled={busy}>
          <Search />
          Check again
        </Button>
      </div>
    </div>
  )
}

/**
 * The note that goes with a paper the server cannot confirm on its own.
 *
 * Offered before filing when it is already known to be needed -- this server
 * has no Scopus connection, so every paper is confirmed by hand and the
 * server asks for a note -- rather than only after a refused attempt.
 */
export function ContestNote({
  value,
  onChange,
  expected,
  submitError,
  busy,
  onSendAnyway,
}: {
  value: string
  onChange: (v: string) => void
  expected: boolean
  submitError: string | null
  busy: boolean
  onSendAnyway: () => void
}) {
  const contestable = submitError?.includes("Could not auto-confirm") ?? false
  if (!expected && !submitError) return null
  const short = 10 - value.trim().length
  return (
    <div className="space-y-2">
      {submitError && (
        <Callout tone={contestable ? "caution" : "critical"} title={contestable ? "It needs a note to go through" : "Could not file this paper"}>
          <p>{submitError}</p>
        </Callout>
      )}
      {(expected || contestable) && (
        <div className="space-y-1.5" data-field="contest">
          <label htmlFor="contest-note" className="block text-sm font-medium">
            A note for the research cell
          </label>
          <Textarea
            id="contest-note"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder="For example: Published online 20 May 2026; the DOI resolves and the paper names the college."
            rows={2}
          />
          <p className="text-xs text-fg-muted">
            {expected && !contestable
              ? "Scopus is not connected here, so the research cell confirms indexing by hand and filing asks for a line saying why it should go through. Write it now and it is sent with the paper."
              : short > 0
                ? `${short} more character${short === 1 ? "" : "s"} needed.`
                : "Sent with the paper."}
          </p>
          {contestable && (
            <Button kind="default" size="sm" disabled={short > 0 || busy} onClick={onSendAnyway}>
              {busy && <LoaderCircle className="animate-spin" />}
              {busy ? "Sending…" : "Send it with this note"}
            </Button>
          )}
        </div>
      )}
    </div>
  )
}
