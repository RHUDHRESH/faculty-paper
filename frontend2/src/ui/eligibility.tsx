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
          Make sure no incentive claim has been filed for this article before, by you or by a
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
              <strong>Incentive</strong>: an ordinary faculty publication claim, which is
              priced and paid.
            </li>
            <li>
              <strong>For the record only</strong>: the publication is counted and no money is
              claimed. Typically a final-year student project outcome.
            </li>
            <li>
              <strong>Student project</strong>: counted against a named project team.
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
  /** What the reviewer will check, in the reviewer's own terms. */
  check: ReactNode
  /** How the claimant can be sure before ticking. */
  sure: ReactNode
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
          . If it is not indexed yet, there is nothing to fix; come back when it is. Nothing has
          been saved, so leaving now costs you nothing.
        </>
      ),
      check:
        "The reviewer opens your Scopus Author Profile and looks for this article under your name, with the same title and DOI as your claim.",
      sure: "Search the title on scopus.com and open the result. Your name should be among its authors, and the article should be listed on your own profile. If it sits under a second profile, merge the two in the Author Feedback Wizard first.",
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
      check:
        "The reviewer compares your title and DOI with every claim already filed or paid at the college, including claims by your co-authors.",
      sure: "Search My claims for the title, and ask each co-author at the college whether they have claimed it. A claim that was sent back is still that claim, so fix it instead of filing a second one.",
    },
    {
      id: "documents",
      label:
        "I have the published article PDF and the SEC-affiliated cited reference PDFs ready to upload",
      hint: `${minReferences} cited references authored by Saveetha Engineering College faculty are expected, each with its reference number.`,
      stuck: (
        <>
          Gather the files first. The form saves itself as you type, so you can start now and
          attach them later, but a claim filed with fewer than {minReferences} numbered
          references is recorded and paid nothing, which is worse than waiting.
        </>
      ),
      check:
        "The reviewer searches the article's PDF for the line “Saveetha Engineering College” under an author's name, then opens each reference PDF to see its number and a college author.",
      sure: "Open each PDF and press Ctrl+F to search for “Saveetha”. Save PDFs from the publisher's site rather than scanning them, so the text can be searched. Write down each reference's number from your article's reference list.",
    },
  ]
}

/**
 * What the reviewer will check for one condition, and how to be sure it is
 * true before ticking. Folded away by default so the three cards stay short,
 * but always one press from the card it belongs to.
 */
export function ConditionHelp({
  item,
  stuck,
  why,
  className,
}: {
  item: Pick<Confirmation, "check" | "sure">
  /** Why it matters: said in the fold, not under every title. */
  why?: ReactNode
  /** What to do if it is not true: said in the same fold, not under the title. */
  stuck?: ReactNode
  className?: string
}) {
  return (
    <details className={cn("group text-sm", className)}>
      <summary className="cursor-pointer select-none font-medium text-accent">
        What the reviewer checks, and how to be sure
      </summary>
      <div className="mt-2 space-y-2 leading-relaxed text-fg-muted">
        {why && <p>{why}</p>}
        <p>
          <span className="font-medium text-fg">The reviewer checks. </span>
          {item.check}
        </p>
        <p>
          <span className="font-medium text-fg">To be sure. </span>
          {item.sure}
        </p>
        {stuck && (
          <p>
            <span className="font-medium text-fg">If it is not true. </span>
            {stuck}
          </p>
        )}
      </div>
    </details>
  )
}

/**
 * The three conditions as a plain list of boxes, for the places that ask
 * again without the big cards (sending a fixed claim back). Each box is
 * ticked by the person, one at a time, and stamps its own time; nothing is
 * ticked for them and nothing remembers an earlier filing.
 */
export function ConditionTickList({
  minReferences = 2,
  ticks,
  onChange,
}: {
  minReferences?: number
  ticks: Ticks
  onChange: (next: Ticks) => void
}) {
  return (
    <ol className="space-y-3" data-area="record">
      {confirmations(minReferences).map((c, i) => {
        const on = !!ticks[c.id]
        return (
          <li key={c.id} data-condition={c.id} data-ticked={on ? "true" : undefined}>
            <label
              htmlFor={`tick-${c.id}`}
              className={cn(
                "flex min-h-14 cursor-pointer items-start gap-3 rounded-xl px-4 py-3 text-base transition-colors duration-[var(--dur-1)]",
                on ? "bg-positive-wash" : "bg-sunken hover:bg-hover"
              )}
            >
              <CheckboxPrimitive.Root
                id={`tick-${c.id}`}
                checked={on}
                onCheckedChange={(v) => {
                  const next = { ...ticks }
                  if (v === true) next[c.id] = new Date().toISOString()
                  else delete next[c.id]
                  onChange(next)
                }}
                className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-md bg-surface ring-2 ring-inset ring-field outline-none focus-visible:ring-accent focus-visible:ring-offset-2 data-[state=checked]:bg-positive data-[state=checked]:ring-positive"
              >
                <CheckboxPrimitive.Indicator forceMount className="text-white">
                  <TickMark on={on} />
                </CheckboxPrimitive.Indicator>
              </CheckboxPrimitive.Root>
              <span className="min-w-0">
                <span className="font-medium">
                  {i + 1}. {c.label}
                </span>
                <span className="mt-0.5 block text-sm text-fg-muted">I confirm this is true for this article.</span>
              </span>
            </label>
            <ConditionHelp item={c} className="mt-1.5 px-4" />
          </li>
        )
      })}
    </ol>
  )
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

      {/* One ruled list, not three cards: the three conditions are the same
          kind of thing, read once and ticked once each. The long advice
          ("what to do if it is not true") is folded beside "what the reviewer
          checks"; it is spelled out below only when Start is pressed with a
          box still empty. */}
      <ol className="divide-y divide-line rounded-panel bg-surface ring-1 ring-edge">
        {items.map((c, i) => {
          const on = !!ticked[c.id]
          const ev = evidence[c.id]
          return (
            <li
              key={c.id}
              data-condition={c.id}
              data-ticked={on ? "true" : undefined}
              className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 p-5"
            >
              <span aria-hidden className="figure pt-0.5 text-figure leading-none text-accent tabular">
                {i + 1}
              </span>
              <div className="min-w-0">
                <h3 className="text-base font-semibold leading-snug text-fg">{c.label}</h3>
                {ev && (
                  <p
                    className={cn(
                      "mt-2 text-sm leading-relaxed",
                      ev.tone === "positive" ? "text-positive" : ev.tone === "critical" ? "text-critical" : "text-fg-muted"
                    )}
                  >
                    <span className="font-medium">What we found: </span>
                    {ev.text}
                  </p>
                )}
                <ConditionHelp item={c} stuck={c.stuck} why={c.hint} className="mt-2" />
                <label
                  htmlFor={`ack-${c.id}`}
                  className={cn(
                    "mt-3 flex min-h-12 cursor-pointer items-center gap-3 rounded-control px-4 py-2.5 text-base font-medium transition-colors duration-[var(--dur-1)]",
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

      <details className="rounded-panel bg-surface p-4 ring-1 ring-edge [&[open]>summary]:mb-3">
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

      <div className="sticky bottom-0 z-10 -mx-4 flex flex-wrap items-center gap-3 border-t border-line bg-bg px-4 py-3 sm:static sm:mx-0 sm:border-0 sm:bg-transparent sm:p-0">
        <Button
          kind={allTicked ? "primary" : "default"}
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
