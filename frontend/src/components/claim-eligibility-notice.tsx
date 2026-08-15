import * as React from "react"
import { AlertTriangle, ExternalLink, ShieldCheck } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { cn } from "@/lib/utils"

/** Author Feedback Wizard — the only supported way to merge or move a Scopus ID. */
export const SCOPUS_FEEDBACK_WIZARD = "https://www.scopus.com/feedback/author/home.uri"

type Rule = {
  id: string
  title: string
  body: React.ReactNode
}

/**
 * The research cell's submission conditions, verbatim in substance.
 * Rendered before the wizard opens and re-openable from inside it, because
 * every one of these is a reason a filed ticket gets sent back.
 */
export const CLAIM_RULES: Rule[] = [
  {
    id: "scopus-id",
    title: "Scopus ID management",
    body: (
      <>
        If your article is currently linked to an incorrect or duplicate Scopus ID, use the{" "}
        <a
          href={SCOPUS_FEEDBACK_WIZARD}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 font-medium text-primary underline underline-offset-2"
        >
          Scopus Author Feedback Wizard
          <ExternalLink className="size-3" aria-hidden />
        </a>{" "}
        to merge or link it to your correct ID <strong>before</strong> submitting this form.
      </>
    ),
  },
  {
    id: "duplicate",
    title: "Duplicate claim prevention",
    body: <>Ensure that no previous incentive claim has been submitted for this specific article.</>,
  },
  {
    id: "reason",
    title: "Claim reason & SNIP entry",
    body: (
      <>
        Select the claim reason accurately based on your submission type:
        <ul className="mt-1.5 space-y-1">
          <li>
            <strong>Option A</strong> — Standard faculty publication claim (article NOT submitted
            for Final Year Student Project Reimbursement).
          </li>
          <li>
            <strong>Option B</strong> — For publication count only (typically used for student
            project outcomes).
          </li>
        </ul>
        <p className="mt-1.5">
          If the article is being submitted strictly for a count without a financial claim, enter{" "}
          <strong>0</strong> in the SNIP (Source Normalized Impact per Paper) field.
        </p>
      </>
    ),
  },
  {
    id: "documents",
    title: "Mandatory documentation",
    body: (
      <>
        Before proceeding, have these PDF files ready to upload:
        <ul className="mt-1.5 space-y-1">
          <li>Full-text PDF of the published article.</li>
          <li>
            Full-text PDFs of <strong>two</strong> cited references from your article authored by
            faculty members of Saveetha Engineering College.
          </li>
        </ul>
      </>
    ),
  },
  {
    id: "affiliation",
    title: "Affiliation requirement",
    body: (
      <>
        The institutional affiliation in the article must strictly be listed as{" "}
        <strong>Saveetha Engineering College</strong>.
      </>
    ),
  },
]

const LEAD =
  "Complete this form only after your article is officially indexed in Scopus and successfully " +
  "linked to your personal Scopus Author Profile. Submissions made prior to indexing will not be " +
  "processed, and you will be required to resubmit the claim once the article appears in the database."

/* ------------------------------------------------------------------ */

function RuleList({ className }: { className?: string }) {
  return (
    <ol className={cn("space-y-3.5", className)}>
      {CLAIM_RULES.map((rule, i) => (
        <li key={rule.id} className="flex gap-3">
          <span
            aria-hidden
            className="mt-px flex size-5.5 shrink-0 items-center justify-center rounded-full bg-warning/25 text-[11px] font-semibold tabular-nums text-warning-foreground"
          >
            {i + 1}
          </span>
          <div className="min-w-0 space-y-0.5">
            <p className="text-sm font-semibold leading-tight text-foreground">{rule.title}</p>
            <div className="text-[13px] leading-relaxed text-muted-foreground">{rule.body}</div>
          </div>
        </li>
      ))}
    </ol>
  )
}

/** The notice on its own — heading, lead paragraph, and the five conditions. */
export function ClaimRulesPanel({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "rounded-2xl border border-warning/40 bg-surface-warning/60 p-5 sm:p-6",
        className
      )}
    >
      <div className="flex gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-warning/25 text-warning-foreground">
          <AlertTriangle className="size-4.5" aria-hidden />
        </span>
        <div className="min-w-0">
          <h2 className="text-base font-semibold leading-tight text-foreground">
            Scopus indexing &amp; profile verification
          </h2>
          <p className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground">{LEAD}</p>
        </div>
      </div>
      <RuleList className="mt-5 border-t border-warning/30 pt-5" />
    </div>
  )
}

/** Re-open the full conditions from inside the wizard. */
export function ClaimRulesDialog({ trigger }: { trigger?: React.ReactNode }) {
  return (
    <Dialog>
      <DialogTrigger asChild>
        {trigger ?? (
          <Button type="button" variant="ghost" size="xs">
            Submission conditions
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Scopus indexing &amp; profile verification</DialogTitle>
          <DialogDescription>{LEAD}</DialogDescription>
        </DialogHeader>
        <RuleList className="mt-1" />
      </DialogContent>
    </Dialog>
  )
}

/* ------------------------------------------------------------------ */

const CONFIRMATIONS = [
  {
    id: "indexed",
    label: "The article is indexed in Scopus and appears on my own Scopus Author Profile",
    hint: "A claim filed before indexing cannot be processed and has to be filed again later.",
  },
  {
    id: "no-duplicate",
    label: "No incentive claim has been submitted for this article before",
    hint: "Duplicate claims are traced against the paid ledger and sent back.",
  },
  {
    id: "documents",
    label:
      "I have the published article PDF and the SEC-affiliated cited reference PDFs ready to upload",
    hint: "Two cited references authored by Saveetha Engineering College faculty are expected.",
  },
] as const

/**
 * Gate in front of the claim wizard. The conditions are not advisory — each one
 * is a rejection reason — so the form stays closed until they are ticked, and
 * the acknowledgement is per-article rather than remembered across tickets.
 */
export function ClaimEligibilityGate({
  onAcknowledge,
  onCancel,
}: {
  onAcknowledge: () => void
  onCancel?: () => void
}) {
  const [checked, setChecked] = React.useState<Record<string, boolean>>({})
  const allChecked = CONFIRMATIONS.every((c) => checked[c.id])

  return (
    <div className="space-y-5">
      <ClaimRulesPanel />

      <section className="rounded-2xl border border-border bg-card p-5 sm:p-6">
        <h3 className="text-sm font-semibold text-foreground">Confirm before you start</h3>
        <p className="mt-1 text-[13px] text-muted-foreground">
          Tick all three to open the claim form.
        </p>

        <ul className="mt-4 space-y-3">
          {CONFIRMATIONS.map((c) => (
            <li key={c.id} className="flex gap-3 rounded-xl border border-border bg-muted/30 p-3.5">
              <Checkbox
                id={`ack-${c.id}`}
                className="mt-0.5"
                checked={!!checked[c.id]}
                onCheckedChange={(v) => setChecked((s) => ({ ...s, [c.id]: v === true }))}
                aria-describedby={`ack-${c.id}-hint`}
              />
              <div className="min-w-0">
                <Label
                  htmlFor={`ack-${c.id}`}
                  className="text-sm font-medium leading-snug text-foreground"
                >
                  {c.label}
                </Label>
                <p id={`ack-${c.id}-hint`} className="mt-0.5 text-xs text-muted-foreground">
                  {c.hint}
                </p>
              </div>
            </li>
          ))}
        </ul>

        <div className="mt-5 flex flex-wrap items-center gap-2">
          <Button type="button" disabled={!allChecked} onClick={onAcknowledge}>
            <ShieldCheck className="size-4" />
            Start the claim
          </Button>
          {onCancel ? (
            <Button type="button" variant="ghost" onClick={onCancel}>
              Not yet
            </Button>
          ) : null}
          {!allChecked ? (
            <p aria-live="polite" className="text-xs text-muted-foreground">
              {CONFIRMATIONS.filter((c) => !checked[c.id]).length} confirmation
              {CONFIRMATIONS.filter((c) => !checked[c.id]).length === 1 ? "" : "s"} left
            </p>
          ) : null}
        </div>
      </section>
    </div>
  )
}
