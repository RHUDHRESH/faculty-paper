import { useId, useRef, useState, type ReactNode } from "react"
import * as CheckboxPrimitive from "@radix-ui/react-checkbox"
import { AlertTriangle, CopyX, ExternalLink, FileStack, ShieldCheck, type LucideIcon } from "lucide-react"
import { motion, useReducedMotion } from "motion/react"

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
import { SectionTitle } from "@/ui/text"

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
export function confirmations(minReferences: number): Confirmation[] {
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

/** The icon each condition card carries (docs/ux/04, Step 2). */
const CONDITION_ICON: Record<string, LucideIcon> = {
  indexed: ShieldCheck,
  "no-duplicate": CopyX,
  documents: FileStack,
}

/** What we found about one condition. Read-only: it never ticks a box. */
export type ConditionEvidence = {
  tone: "positive" | "neutral" | "critical"
  text: ReactNode
}

/** One box ticked, and when — sent with the filing as the legal record. */
export type Ticks = Record<string, string>

/** The condition ids, in the order the server expects them. */
export const CONDITION_IDS = ["indexed", "no-duplicate", "documents"] as const

/**
 * The gate in front of the claim form: three large cards, each a condition
 * about *this* article, each ticked by the person themselves.
 *
 * Shown in full every time — nothing folds away after a first filing, nothing
 * is pre-ticked and nothing is remembered. The ticks and their times are
 * handed to `onAcknowledge` and sent with the filing, where the server
 * records them as the college's evidence of acceptance.
 *
 * The primary button is deliberately **not** disabled while boxes are
 * unticked. A disabled button is unfocusable, says nothing about why, and
 * leaves a claimant who genuinely cannot tick one of these at a dead end;
 * pressing it names what is outstanding and what to do about each one.
 */
export function ClaimEligibilityGate({
  minReferences = 2,
  paper,
  evidence = {},
  blocked,
  onAcknowledge,
  onCancel,
  cancelLabel = "Not yet",
}: {
  minReferences?: number
  /** The article being confirmed, shown above the cards. */
  paper?: ReactNode
  evidence?: Partial<Record<string, ConditionEvidence>>
  /** Evidence that contradicts a condition: shown, and Start refuses. */
  blocked?: ReactNode
  onAcknowledge: (ticks: Ticks) => void
  onCancel?: () => void
  cancelLabel?: string
}) {
  const items = confirmations(minReferences)
  const [ticked, setTicked] = useState<Ticks>({})
  const [showStuck, setShowStuck] = useState(false)
  const alertRef = useRef<HTMLDivElement>(null)
  const alertId = useId()

  const outstanding = items.filter((c) => !ticked[c.id])
  const allTicked = outstanding.length === 0
  const count = items.length - outstanding.length

  function start() {
    if (blocked) return
    if (allTicked) {
      onAcknowledge(ticked)
      return
    }
    setShowStuck(true)
    // Focus follows the explanation, so a keyboard or screen-reader user
    // lands on the answer rather than being told, silently, somewhere below.
    window.requestAnimationFrame(() => alertRef.current?.focus())
  }

  return (
    <div className="space-y-5" data-area="record">
      {paper}

      <ol className="space-y-4">
        {items.map((c, i) => {
          const Icon = CONDITION_ICON[c.id] ?? ShieldCheck
          const on = !!ticked[c.id]
          const ev = evidence[c.id]
          return (
            <li
              key={c.id}
              data-condition={c.id}
              data-ticked={on ? "true" : undefined}
              className={cn(
                "flex min-h-[120px] flex-col gap-4 rounded-2xl bg-surface p-5 shadow-[inset_0_0_0_1px_var(--color-line)] transition-colors duration-[var(--dur-1)] sm:flex-row",
                on && "shadow-[inset_0_0_0_2px_var(--color-positive)]"
              )}
            >
              <span
                aria-hidden
                className={cn(
                  "inline-flex size-[88px] shrink-0 items-center justify-center rounded-3xl transition-colors duration-[var(--dur-1)]",
                  on ? "bg-positive-wash text-positive" : "bg-(--area-wash) text-(--area)"
                )}
              >
                <Icon className="size-12" strokeWidth={1.5} />
              </span>
              <div className="min-w-0 flex-1">
                <h3 className="flex items-baseline gap-2 text-lg font-semibold text-fg">
                  <span className="figure text-(--area) tabular">{i + 1}</span>
                  <span>{c.label}</span>
                </h3>
                <p className="mt-1 text-sm leading-relaxed text-fg-muted">{c.hint}</p>
                <p className="mt-1 text-sm leading-relaxed text-fg-muted">{c.stuck}</p>
                {ev && (
                  <p
                    className={cn(
                      "mt-2 flex items-start gap-1.5 text-sm",
                      ev.tone === "positive" ? "text-positive" : ev.tone === "critical" ? "text-critical" : "text-fg-muted"
                    )}
                  >
                    <span className="font-medium">Evidence we found:</span>
                    <span className="min-w-0">{ev.text}</span>
                  </p>
                )}
                <label
                  htmlFor={`ack-${c.id}`}
                  className={cn(
                    "mt-3 flex min-h-14 cursor-pointer items-center gap-3 rounded-xl px-4 py-3 text-base font-medium transition-colors duration-[var(--dur-1)]",
                    on ? "bg-positive-wash text-fg" : "bg-sunken hover:bg-hover"
                  )}
                >
                  <CheckboxPrimitive.Root
                    id={`ack-${c.id}`}
                    checked={on}
                    onCheckedChange={(v) =>
                      setTicked((s) => {
                        const next = { ...s }
                        if (v === true) next[c.id] = new Date().toISOString()
                        else delete next[c.id]
                        return next
                      })
                    }
                    aria-describedby={showStuck && !on ? alertId : undefined}
                    className="grid size-6 shrink-0 place-items-center rounded-md bg-surface ring-2 ring-inset ring-field outline-none focus-visible:ring-accent focus-visible:ring-offset-2 data-[state=checked]:bg-positive data-[state=checked]:ring-positive"
                  >
                    <CheckboxPrimitive.Indicator forceMount className="text-white">
                      <TickMark on={on} />
                    </CheckboxPrimitive.Indicator>
                  </CheckboxPrimitive.Root>
                  I confirm this is true for this article
                </label>
              </div>
            </li>
          )
        })}
      </ol>

      <details className="panel p-4 [&[open]>summary]:mb-3">
        <summary className="cursor-pointer text-sm font-medium text-accent">
          Read the full filing rules (claim reason and SNIP, affiliation)
        </summary>
        <ClaimRulesPanel minReferences={minReferences} />
      </details>

      {blocked && (
        <div role="alert" className="rounded-xl bg-critical-wash p-4">
          {blocked}
        </div>
      )}

      <div className="sticky bottom-0 z-10 -mx-4 flex flex-wrap items-center gap-3 border-t border-line bg-bg/95 px-4 py-3 backdrop-blur sm:static sm:mx-0 sm:border-0 sm:bg-transparent sm:p-0">
        <Button
          kind="primary"
          size="lg"
          type="button"
          onClick={start}
          disabled={!!blocked}
          aria-describedby={showStuck && !allTicked ? alertId : undefined}
        >
          <ShieldCheck aria-hidden />
          Start the claim
        </Button>
        {/* Polite, so a reader ticking three boxes in a row is told the
            count each time without being interrupted mid-word. */}
        <span role="status" aria-live="polite" className="text-sm font-medium text-fg-muted tabular">
          {count} of {items.length} confirmed
        </span>
        {onCancel && (
          <Button kind="quiet" size="lg" type="button" onClick={onCancel}>
            {cancelLabel}
          </Button>
        )}
      </div>

      {/* Only after the button is pressed. Spelling out how to get unstuck
          from all three the moment the page loads buries the three
          sentences that actually have to be read. */}
      {showStuck && !allTicked && (
        <div id={alertId} ref={alertRef} role="alert" tabIndex={-1} className="rounded-xl bg-critical-wash p-4">
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
    </div>
  )
}

/** The check draws its stroke with the 180ms spring (docs/ux/00 §5). */
function TickMark({ on }: { on: boolean }) {
  const reduce = useReducedMotion()
  return (
    <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth={3} aria-hidden>
      <motion.path
        d="M5 12.5l4.5 4.5L19 7.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        initial={false}
        animate={{ pathLength: on ? 1 : 0, opacity: on ? 1 : 0 }}
        transition={reduce ? { duration: 0 } : { type: "spring", stiffness: 500, damping: 30 }}
      />
    </svg>
  )
}

/**
 * The three confirmations read back on the last step, with when each was
 * ticked. Read-only: changing one means going back to the gate.
 */
export function ConfirmedConditions({ ticks, minReferences = 2 }: { ticks: Ticks; minReferences?: number }) {
  const fmt = (iso: string) =>
    new Date(iso).toLocaleString("en-IN", { hour: "2-digit", minute: "2-digit", day: "numeric", month: "short", year: "numeric" })
  return (
    <section className="space-y-3" data-area="record" aria-labelledby="confirmed-conditions">
      <h3 id="confirmed-conditions" className="text-base font-semibold">
        What you confirmed about this article
      </h3>
      <ul className="space-y-2">
        {confirmations(minReferences).map((c) => {
          const Icon = CONDITION_ICON[c.id] ?? ShieldCheck
          return (
            <li key={c.id} className="flex items-start gap-3 rounded-xl bg-positive-wash/60 p-3">
              <Icon aria-hidden className="mt-0.5 size-5 shrink-0 text-positive" strokeWidth={1.75} />
              <div className="min-w-0">
                <p className="text-sm font-medium">{c.label}</p>
                <p className="text-xs text-fg-muted">
                  {ticks[c.id] ? `Confirmed ${fmt(ticks[c.id])}` : "Not confirmed"}
                </p>
              </div>
            </li>
          )
        })}
      </ul>
      <p className="text-sm text-fg-muted">
        By filing you declare these are true. They are stored with the claim.
      </p>
    </section>
  )
}
