import { cn } from "@/lib/cn"

/**
 * How a paper's progress is said, everywhere, in one place.
 *
 * The chain is five steps — filed, checked, approved, authorised, paid — and
 * the two mistakes the old app made about it were both about words. It called
 * a checked ticket "with Finance" when Finance cannot see one until it has
 * been approved *and* authorised, and it showed a full progress bar reading
 * "step 4 of 4" beside a badge already saying Paid, on every settled row.
 *
 * The fourth step is the newest: the Principal agrees the spend, then the
 * Director authorises it, and only then can Finance pay. Both halves of that
 * matter to a claimant waiting, so "Approved" and "Authorised" are separate
 * words here rather than one word covering two desks.
 *
 * So: one function turns a status into a stage, one component draws it, and
 * the bar only appears while there is distance left to travel.
 */

export const STAGES = ["Filed", "Checked", "Approved", "Authorised", "Paid"] as const
export type StageName = (typeof STAGES)[number]

export type StageInfo = {
  /** Where it is. `null` means it is not travelling — a draft, or sent back. */
  step: StageName | null
  label: string
  /** Who is holding it, said to the claimant. */
  who: string
  tone: "neutral" | "progress" | "done" | "attention"
}

export function stageOf(status: string): StageInfo {
  switch (status) {
    case "DRAFT":
      return {
        step: null,
        label: "Draft",
        who: "Not filed yet — finish it when you are ready.",
        tone: "neutral",
      }
    case "REJECTED":
      return {
        step: null,
        label: "Sent back",
        who: "Edit the details and file it again.",
        tone: "attention",
      }
    case "SUBMITTED":
    case "HOD_APPROVED":
      return {
        step: "Filed",
        label: "Awaiting check",
        who: "With the research cell.",
        tone: "progress",
      }
    case "CLEARED":
    case "RESEARCH_APPROVED":
      return {
        step: "Checked",
        label: "Checked",
        // Not "with Finance". Finance cannot see it until the Principal has
        // approved it, and saying otherwise sent people to the wrong desk.
        who: "Waiting for the Principal to approve it.",
        tone: "progress",
      }
    case "PRINCIPAL_APPROVED":
      return {
        step: "Approved",
        label: "Approved",
        // Not "with Finance". The Principal agreeing the spend is not the
        // last signature any more — the Director authorises it next, and a
        // claimant told to chase Finance at this point is sent to a desk
        // that cannot yet see their ticket.
        who: "Waiting for the Director to authorise it.",
        tone: "progress",
      }
    case "DIRECTOR_APPROVED":
    case "FINANCE_APPROVED":
      return {
        step: "Authorised",
        label: "Authorised",
        who: "With Finance, who will process the payment.",
        tone: "progress",
      }
    case "PAID":
      return { step: "Paid", label: "Paid", who: "Settled.", tone: "done" }
    default:
      return { step: null, label: status.replace(/_/g, " "), who: "", tone: "neutral" }
  }
}

const TONE: Record<StageInfo["tone"], string> = {
  neutral: "text-fg-muted",
  progress: "text-fg",
  done: "text-positive",
  attention: "text-critical",
}

const FILL: Record<StageInfo["tone"], string> = {
  neutral: "bg-fg-subtle",
  progress: "bg-accent",
  done: "bg-positive",
  attention: "bg-critical",
}

/**
 * The stage, as a word and — only while it is still moving — a bar.
 *
 * No pill, no coloured chip. A badge repeated down fifty rows is fifty
 * lozenges of noise; the word alone reads faster and the bar carries the one
 * thing the word cannot, which is how far there is left to go.
 */
export function Stage({ stage, className }: { stage: StageInfo; className?: string }) {
  const index = stage.step ? STAGES.indexOf(stage.step) : -1
  const share = index >= 0 ? (index + 1) / STAGES.length : 0
  const travelling = stage.tone === "progress"

  return (
    <span className={cn("block", className)}>
      <span className={cn("block text-sm", TONE[stage.tone])}>{stage.label}</span>
      {travelling && (
        <span
          className="mt-1 block h-[3px] w-full overflow-hidden rounded-full bg-line"
          role="progressbar"
          aria-valuenow={index + 1}
          aria-valuemin={0}
          aria-valuemax={STAGES.length}
          aria-label={`${stage.label}: step ${index + 1} of ${STAGES.length}`}
        >
          <span
            className={cn("block h-full rounded-full transition-[width] duration-500", FILL[stage.tone])}
            style={{ width: `${share * 100}%` }}
          />
        </span>
      )}
    </span>
  )
}

/**
 * The five desks, drawn, with the one holding it marked.
 *
 * `Stage` is the compact form for a table cell -- a label and a 3px bar. On a
 * ticket page there is room for the real answer, and the real answer is the
 * question everybody actually arrives with: how far along is this, and who
 * has it now.
 *
 * The step names were declared in `STAGES` from the first day and drawn
 * nowhere. The only place the count existed was an `aria-label`, so a screen
 * reader heard "step 2 of 5" and somebody looking at the page saw an
 * unmarked sliver. A rejected ticket gets no track at all: it is not at a
 * step, it is back with its author, and drawing it two-fifths along a road it
 * has left would be a lie in a picture.
 */
export function StageTrack({ stage, className }: { stage: StageInfo; className?: string }) {
  // A sent-back ticket has no step -- it is not on the road, it is back with
  // its author -- so it gets no track. Drawing it two-fifths along a journey
  // it has left would be a lie told in a picture.
  const index = stage.step ? STAGES.indexOf(stage.step) : -1
  if (index < 0) return null

  const settled = stage.step === "Paid"

  return (
    <ol
      className={cn("flex w-full items-start gap-1", className)}
      aria-label={`Step ${index + 1} of ${STAGES.length}: ${stage.label}`}
    >
      {STAGES.map((name, i) => {
        const done = i < index
        const here = i === index
        return (
          <li key={name} className="flex min-w-0 flex-1 flex-col gap-1.5">
            <span
              aria-hidden
              className={cn(
                "block h-[3px] rounded-full",
                done && "bg-positive",
                here && (settled ? "bg-positive" : "bg-accent"),
                !done && !here && "bg-line"
              )}
            />
            <span
              className={cn(
                "truncate text-xs",
                here ? "font-medium text-fg" : done ? "text-fg-muted" : "text-fg-subtle"
              )}
            >
              {name}
            </span>
          </li>
        )
      })}
    </ol>
  )
}

/**
 * Rupees, formatted like money rather than like a float.
 *
 * Amounts come off the payout formula as plain numbers, so 52377.5 rendered
 * as "52,377.5" — a lone stray decimal beside "39,081", which reads as a
 * rounding mistake. Paise appear only when there are any, and then as two
 * digits.
 */
export function money(value: number | null | undefined): string {
  if (value == null) return "—"
  const hasPaise = Math.round(value * 100) % 100 !== 0
  return `₹${value.toLocaleString("en-IN", {
    minimumFractionDigits: hasPaise ? 2 : 0,
    maximumFractionDigits: 2,
  })}`
}

/* ------------------------------------------------------------------------ */
/* Why the amount is the amount                                             */
/* ------------------------------------------------------------------------ */

const CATEGORY_TEXT: Record<string, string> = {
  I: "Category I — indexed in Scopus, with a SNIP value",
  II: "Category II — a Scopus journal with no SNIP on record",
  III: "Category III — a Scopus conference paper or book chapter, no SNIP",
  IV: "Category IV — in Web of Science (SCIE/ESCI) but not in Scopus",
  "—": "Not eligible for a payment under the scheme",
}

/**
 * The scheme's category, said in words as well as in its numeral.
 *
 * `remuneration_category` arrives as a bare Roman numeral, and a bare "I"
 * under an amount is a letter, not a fact: it does not say what was true of
 * the paper that put it in that category, so nobody reading the page can tell
 * whether it is the right one. The numeral stays, because the policy document
 * and every approver's spreadsheet use it; the clause after it is what makes
 * it checkable by the person being paid.
 */
export function categoryLabel(code: string | null | undefined): string | null {
  if (!code) return null
  return CATEGORY_TEXT[code] || `Category ${code}`
}

/** The handful of claim fields the working is built out of. */
export type PayoutFacts = {
  remuneration: number | null
  base_amount: number | null
  qf_amount: number | null
  author_point: number | null
  snip: number | null
  quartile: string | null
  author_position: number | null
  total_authors: number | null
  remuneration_category: string | null
}

/** How a line joins the one above it. */
export type WorkingOp = "start" | "plus" | "times" | "equals"

export type WorkingLine = {
  op: WorkingOp
  /** Names the thing, and expands its initialism where it has one. */
  label: string
  /** Where the number came from, in a sentence. */
  detail?: string
  /** Already formatted: money, or a bare multiplier. */
  value: string
  /** A running answer rather than a component — drawn with a rule above it. */
  total?: boolean
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

function ordinal(n: number): string {
  const teens = n % 100
  if (teens >= 11 && teens <= 13) return `${n}th`
  return `${n}${["th", "st", "nd", "rd"][n % 10] || "th"}`
}

function shareDetail(c: PayoutFacts): string | undefined {
  const pos = c.author_position
  const of = c.total_authors
  if (!pos || !of) return undefined
  if (of === 1) return "Sole author, so the whole amount"
  return `${ordinal(pos)} of ${of} authors, per the scheme's author-position table`
}

/**
 * The payout, broken back into the sum that produced it.
 *
 * The page used to print `Formula: [(SNIP × 55,000) + QFA] × APP` and then,
 * separately, three unrelated-looking money figures — a headline of
 * ₹1,05,000, a "QF amount" of ₹50,000 and a "Base amount" of ₹1,05,000. QFA
 * and APP were expanded nowhere, so the equation was in a private language,
 * and nothing on the page said that two of the three figures were equal
 * because the claimant happened to be the only author. Somebody owed money
 * could read the whole section and still not know why they were owed that
 * much.
 *
 * So the equation is thrown away and the arithmetic is drawn instead: one
 * line per term, each term named in words, each line carrying the number it
 * contributes, ending on the figure at the top of the page. Returns an empty
 * list when there is no sum to show — an imported payment that predates this
 * system carries a total and none of its workings, and inventing one would be
 * worse than saying so.
 */
export function payoutWorking(c: PayoutFacts): WorkingLine[] {
  const base = c.base_amount
  const app = c.author_point
  const paid = c.remuneration
  if (base == null || app == null || paid == null) return []
  // A zero base is a rule, not an arithmetic — "recorded for the publication
  // count only", or too few SEC-affiliated references. `remuneration_note`
  // says which rule; "₹0 × 1.000 = ₹0" would explain nothing.
  if (base <= 0) return []

  const qf = c.qf_amount ?? 0
  const beforeQf = round2(base - qf)
  const lines: WorkingLine[] = []

  if (c.snip != null && c.snip > 0 && beforeQf > 0) {
    // The rate per SNIP point is not in the payload, so it is recovered from
    // the two figures that are. That keeps the page honest when the policy's
    // multiplier is edited later: it shows the rate this ticket was actually
    // priced at, not whichever rate happens to be in force today.
    const rate = round2(beforeQf / c.snip)
    lines.push({
      op: "start",
      label: "The journal's SNIP, priced",
      detail: `SNIP ${c.snip.toFixed(3)} × ${money(rate)} for every SNIP point`,
      value: money(beforeQf),
    })
  } else {
    lines.push({
      op: "start",
      label: "The scheme's flat rate for this kind of paper",
      detail: categoryLabel(c.remuneration_category) ?? undefined,
      value: money(beforeQf),
    })
  }

  if (qf > 0) {
    lines.push({
      op: "plus",
      label: "Quartile incentive (QFA)",
      detail: c.quartile
        ? `Paid because the journal sits in ${c.quartile}`
        : "The extra the scheme pays on a ranked Engineering journal",
      value: money(qf),
    })
    lines.push({
      op: "equals",
      label: "What the paper is worth in full",
      detail: "Before it is shared out between its authors",
      value: money(base),
      total: true,
    })
  }

  lines.push({
    op: "times",
    label: "Author-position share (APP)",
    detail: shareDetail(c),
    value: app.toFixed(3),
  })

  lines.push({
    op: "equals",
    label: "The payment for this paper",
    // The server's own figure, never `base * app` recomputed here: the two
    // can differ by a paisa after rounding, and a page that quietly disagrees
    // with the payment is worse than a page showing no sum at all.
    value: money(paid),
    total: true,
  })

  return lines
}

const OP_GLYPH: Record<WorkingOp, string> = { start: "", plus: "+", times: "×", equals: "=" }
/** Said instead of the glyph, which a screen reader either skips or mangles. */
const OP_WORD: Record<WorkingOp, string> = {
  start: "",
  plus: "plus",
  times: "times",
  equals: "which comes to",
}

/**
 * The sum behind the payout, drawn.
 *
 * Right-aligned and tabular so the column of amounts can be read down without
 * reading the names beside them, and every operator is spelled out for a
 * screen reader, which otherwise announces a bare "+" as nothing at all and
 * turns an arithmetic into an unexplained list of money.
 */
export function PayoutWorking({
  facts,
  className,
}: {
  facts: PayoutFacts
  className?: string
}) {
  const lines = payoutWorking(facts)
  if (lines.length === 0) return null

  return (
    <dl className={cn("space-y-2", className)}>
      {lines.map((line) => (
        <div
          key={line.label}
          className={cn(
            "flex items-baseline justify-between gap-3",
            line.total && "border-t border-line pt-2"
          )}
        >
          <dt className="min-w-0">
            <span className={cn("text-sm", line.total && "font-medium")}>
              <span aria-hidden className="mr-1.5 inline-block w-3 text-fg-subtle">
                {OP_GLYPH[line.op]}
              </span>
              {OP_WORD[line.op] ? <span className="sr-only">{OP_WORD[line.op]} </span> : null}
              {line.label}
            </span>
            {line.detail ? (
              <span className="mt-0.5 block pl-[1.125rem] text-xs text-fg-subtle">
                {line.detail}
              </span>
            ) : null}
          </dt>
          <dd className={cn("tabular shrink-0 text-sm", line.total && "font-medium")}>
            {line.value}
          </dd>
        </div>
      ))}
    </dl>
  )
}
