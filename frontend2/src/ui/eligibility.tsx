import { useId, useRef, useState, type ReactNode } from "react"
import { AlertTriangle, ExternalLink, ShieldCheck } from "lucide-react"

import { cn } from "@/lib/cn"
import { Button } from "@/ui/button"
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/ui/dialog"
import { Checkbox } from "@/ui/field"
import { SectionTitle, Sub } from "@/ui/text"

/**
 * The Author Feedback Wizard — the only supported way to merge or move a
 * Scopus ID.
 *
 * Named here rather than typed into prose because the alternative people
 * reach for is emailing the research cell, who cannot merge an ID either.
 */
export const SCOPUS_FEEDBACK_WIZARD = "https://www.scopus.com/feedback/author/home.uri"

export type ClaimRule = {
  id: string
  title: string
  body: ReactNode
}

/**
 * The research cell's submission conditions.
 *
 * A function rather than a constant because the number of cited SEC
 * references is policy, not a fact about this file. A hard-coded 2 in the
 * client is a rule that silently stops matching the one the money is
 * calculated from the day somebody publishes a new policy — `/api/meta/
 * filing-rules` is where the live figure comes from, and it is passed in.
 *
 * Every rule below is a reason a filed ticket is sent back. Without them the
 * first a claimant hears of any of it is a rejection weeks later, by which
 * time the article's Scopus ID is still wrong and they still do not know
 * where to fix it.
 */
export function claimRules(minReferences: number): ClaimRule[] {
  return [
    {
      id: "scopus-id",
      title: "Scopus ID management",
      body: (
        <>
          If your article is linked to an incorrect or duplicate Scopus ID, use the{" "}
          <a
            href={SCOPUS_FEEDBACK_WIZARD}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 font-medium text-accent underline underline-offset-2"
          >
            Scopus Author Feedback Wizard
            <ExternalLink className="size-3" aria-hidden />
          </a>{" "}
          to merge or link it to your correct ID <strong>before</strong> filing here. Nobody at
          the college can do it for you.
        </>
      ),
    },
    {
      id: "duplicate",
      title: "Duplicate claim prevention",
      body: (
        <>
          Make sure no incentive claim has been filed for this article before — by you or by a
          co-author. Duplicates are traced against the paid ledger and sent back.
        </>
      ),
    },
    {
      id: "reason",
      title: "Claim reason and SNIP entry",
      body: (
        <>
          Pick the claim reason that matches what you are filing:
          <ul className="mt-1.5 space-y-1">
            <li>
              <strong>Incentive</strong> — an ordinary faculty publication claim, which is
              priced and paid.
            </li>
            <li>
              <strong>For the record only</strong> — the publication is counted and no money is
              claimed. Typically a final-year student project outcome.
            </li>
            <li>
              <strong>Student project</strong> — counted against a named project team.
            </li>
          </ul>
          <p className="mt-1.5">
            Filing strictly for the count means no SNIP is needed; leave it blank or enter{" "}
            <strong>0</strong>.
          </p>
        </>
      ),
    },
    {
      id: "documents",
      title: "Mandatory documentation",
      body: (
        <>
          Have these files ready before you start:
          <ul className="mt-1.5 space-y-1">
            <li>The full-text PDF of the published article.</li>
            <li>
              The full-text PDFs of <strong>{minReferences}</strong> cited references from your
              article authored by Saveetha Engineering College faculty, each with its number
              from your reference list.
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
          The institutional affiliation printed on the article must read{" "}
          <strong>Saveetha Engineering College</strong>.
        </>
      ),
    },
  ]
}

const LEAD =
  "File this only after your article is officially indexed in Scopus and linked to your own " +
  "Scopus Author Profile. A claim filed before indexing cannot be processed, and you will be " +
  "asked to file it again once the article appears in the database."

/* ------------------------------------------------------------------------ */
/* The five conditions                                                       */
/* ------------------------------------------------------------------------ */

function RuleList({ rules, className }: { rules: ClaimRule[]; className?: string }) {
  return (
    <ol className={cn("space-y-3.5", className)}>
      {rules.map((rule, i) => (
        <li key={rule.id} className="flex gap-3">
          <span
            aria-hidden
            className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full bg-caution-wash text-xs font-medium tabular text-fg"
          >
            {i + 1}
          </span>
          <div className="min-w-0">
            <p className="text-base font-medium">{rule.title}</p>
            <div className="mt-0.5 text-sm leading-relaxed text-fg-muted">{rule.body}</div>
          </div>
        </li>
      ))}
    </ol>
  )
}

/**
 * The five submission conditions, read before the form opens.
 *
 * Without it the conditions live in a circular nobody has open, and the
 * commonest rejections — a duplicate Scopus ID, a claim already filed by a
 * co-author, an affiliation that reads something else — are all discovered
 * after the work of filing rather than before it.
 */
export function ClaimRulesPanel({
  minReferences = 2,
  className,
}: {
  minReferences?: number
  className?: string
}) {
  return (
    <section className={cn("rounded-lg bg-caution-wash p-4 sm:p-5", className)}>
      <div className="flex gap-3">
        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-caution" aria-hidden />
        <div className="min-w-0">
          <SectionTitle>Scopus indexing and profile verification</SectionTitle>
          <p className="mt-1 text-sm leading-relaxed text-fg-muted">{LEAD}</p>
        </div>
      </div>
      <RuleList rules={claimRules(minReferences)} className="mt-4 border-t border-line pt-4" />
    </section>
  )
}

/**
 * The same five conditions, re-openable from inside the wizard.
 *
 * The gate is read once and then scrolls out of the claimant's life; the
 * question it answers ("does AU Annexure need a reference number, and what
 * did it say about SNIP?") arrives four steps later. Without this the only
 * way back to the answer is to abandon the draft and start again.
 */
export function ClaimRulesDialog({
  minReferences = 2,
  trigger,
}: {
  minReferences?: number
  trigger?: ReactNode
}) {
  return (
    <Dialog>
      <DialogTrigger asChild>
        {trigger ?? (
          <Button kind="quiet" size="sm" type="button">
            Submission conditions
          </Button>
        )}
      </DialogTrigger>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>Scopus indexing and profile verification</DialogTitle>
          <DialogDescription>{LEAD}</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <RuleList rules={claimRules(minReferences)} />
        </DialogBody>
      </DialogContent>
    </Dialog>
  )
}

/* ------------------------------------------------------------------------ */
/* The three checks                                                          */
/* ------------------------------------------------------------------------ */

type Confirmation = {
  id: string
  label: string
  /** What it costs to have this wrong. */
  hint: string
  /** What to do about it instead of giving up — see `ClaimEligibilityGate`. */
  stuck: ReactNode
}

/**
 * The three things that have to be true before a claim is worth filing, each
 * of which is otherwise found out weeks later as a rejection reason.
 */
function confirmations(minReferences: number): Confirmation[] {
  return [
    {
      id: "indexed",
      label: "The article is indexed in Scopus and appears on my own Scopus Author Profile",
      hint: "A claim filed before indexing cannot be processed and has to be filed again later.",
      stuck: (
        <>
          If the article is indexed but sits under the wrong author, fix that first in the{" "}
          <a
            href={SCOPUS_FEEDBACK_WIZARD}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 font-medium text-accent underline underline-offset-2"
          >
            Scopus Author Feedback Wizard
            <ExternalLink className="size-3" aria-hidden />
          </a>
          . If it is not indexed yet, there is nothing to fix — come back when it is. Nothing has
          been saved, so leaving now costs you nothing.
        </>
      ),
    },
    {
      id: "no-duplicate",
      label: "No incentive claim has been filed for this article before",
      hint: "Duplicate claims are traced against the paid ledger and sent back.",
      stuck: (
        <>
          Search “My papers” for the title, and ask your co-authors whether one of them has
          already filed it. If a claim exists and was sent back, open that one and edit it rather
          than starting a second.
        </>
      ),
    },
    {
      id: "documents",
      label:
        "I have the published article PDF and the SEC-affiliated cited reference PDFs ready to upload",
      hint: `${minReferences} cited references authored by Saveetha Engineering College faculty are expected, each with its reference number.`,
      stuck: (
        <>
          Gather the files first. The form saves itself as you type, so you can start now and
          attach them later — but a claim filed with fewer than {minReferences} numbered
          references is recorded and paid nothing, which is worse than waiting.
        </>
      ),
    },
  ]
}

/**
 * The gate in front of the claim wizard.
 *
 * The conditions are not advisory: each of the three is a reason a ticket is
 * refused, so the form stays shut until all three are ticked, and the
 * acknowledgement is per-article rather than remembered across tickets —
 * "I ticked this last year" is exactly how a duplicate claim gets filed.
 *
 * The primary button is deliberately **not** disabled while boxes are
 * unticked. A disabled button is unfocusable, says nothing about why, and
 * leaves a claimant who genuinely cannot tick one of these at a dead end;
 * pressing it names what is outstanding and what to do about each one.
 */
export function ClaimEligibilityGate({
  minReferences = 2,
  onAcknowledge,
  onCancel,
  cancelLabel = "Not yet",
}: {
  minReferences?: number
  onAcknowledge: () => void
  onCancel?: () => void
  cancelLabel?: string
}) {
  const items = confirmations(minReferences)
  const [ticked, setTicked] = useState<Record<string, boolean>>({})
  const [showStuck, setShowStuck] = useState(false)
  const alertRef = useRef<HTMLDivElement>(null)
  const alertId = useId()

  const outstanding = items.filter((c) => !ticked[c.id])
  const allTicked = outstanding.length === 0

  function start() {
    if (allTicked) {
      onAcknowledge()
      return
    }
    setShowStuck(true)
    // Focus follows the explanation, so a keyboard or screen-reader user
    // lands on the answer rather than being told, silently, somewhere below.
    window.requestAnimationFrame(() => alertRef.current?.focus())
  }

  return (
    <div className="space-y-5">
      <ClaimRulesPanel minReferences={minReferences} />

      <section className="panel-lead p-4 sm:p-5">
        <SectionTitle>Confirm before you start</SectionTitle>
        <Sub className="mt-1">
          All three have to be true. Ticking them opens the claim form.
        </Sub>

        <ul className="mt-4 space-y-3">
          {items.map((c) => (
            <li key={c.id} className="rounded-md bg-sunken p-3">
              <Checkbox
                id={`ack-${c.id}`}
                checked={!!ticked[c.id]}
                onCheckedChange={(v) => setTicked((s) => ({ ...s, [c.id]: v === true }))}
                label={c.label}
                hint={c.hint}
              />
            </li>
          ))}
        </ul>

        <div className="mt-5 flex flex-wrap items-center gap-2">
          <Button
            kind="primary"
            size="lg"
            type="button"
            onClick={start}
            aria-describedby={showStuck && !allTicked ? alertId : undefined}
          >
            <ShieldCheck aria-hidden />
            Start the claim
          </Button>
          {onCancel && (
            <Button kind="quiet" size="lg" type="button" onClick={onCancel}>
              {cancelLabel}
            </Button>
          )}
          {/* Polite, so a reader ticking three boxes in a row is told the
              count each time without being interrupted mid-word. */}
          <span role="status" aria-live="polite" className="text-sm text-fg-muted">
            {allTicked
              ? "All three confirmed"
              : `${outstanding.length} confirmation${outstanding.length === 1 ? "" : "s"} left`}
          </span>
        </div>

        {/* Only after the button is pressed. Spelling out how to get unstuck
            from all three the moment the page loads buries the three
            sentences that actually have to be read. */}
        {showStuck && !allTicked && (
          <div
            id={alertId}
            ref={alertRef}
            role="alert"
            tabIndex={-1}
            className="mt-4 rounded-md bg-critical-wash p-3"
          >
            <p className="text-base font-medium">
              {outstanding.length === 1
                ? "One of these is not confirmed yet, so the form has not opened"
                : `${outstanding.length} of these are not confirmed yet, so the form has not opened`}
            </p>
            <ul className="mt-2 space-y-2.5">
              {outstanding.map((c) => (
                <li key={c.id}>
                  <p className="text-sm font-medium">{c.label}</p>
                  <p className="mt-0.5 text-sm leading-relaxed text-fg-muted">{c.stuck}</p>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>
    </div>
  )
}
