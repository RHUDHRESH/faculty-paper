import { cn } from "@/lib/cn"

/**
 * How a paper's progress is said, everywhere, in one place.
 *
 * The chain is four steps — filed, checked, approved, paid — and the two
 * mistakes the old app made about it were both about words. It called a
 * checked ticket "with Finance" when Finance cannot see one until the
 * Principal approves it, and it showed a full progress bar reading "step 4 of
 * 4" beside a badge already saying Paid, on every settled row.
 *
 * So: one function turns a status into a stage, one component draws it, and
 * the bar only appears while there is distance left to travel.
 */

export const STAGES = ["Filed", "Checked", "Approved", "Paid"] as const
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
    case "FINANCE_APPROVED":
      return {
        step: "Approved",
        label: "Approved",
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
  neutral: "text-[--color-fg-muted]",
  progress: "text-[--color-fg]",
  done: "text-[--color-positive]",
  attention: "text-[--color-critical]",
}

const FILL: Record<StageInfo["tone"], string> = {
  neutral: "bg-[--color-fg-subtle]",
  progress: "bg-[--color-accent]",
  done: "bg-[--color-positive]",
  attention: "bg-[--color-critical]",
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
          className="mt-1 block h-[3px] w-full overflow-hidden rounded-full bg-[--color-line]"
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
