import { CircleCheck, CircleHelp, CircleX } from "lucide-react"

import { cn } from "@/lib/cn"

/** A word on a wash. The icon and the wording both carry the meaning, so the
 *  colour is never the only thing saying which of these is bad news. */
export function Tag({
  tone,
  icon: Icon,
  children,
  className,
}: {
  tone: "positive" | "caution" | "critical" | "accent" | "neutral"
  icon?: React.ComponentType<{ className?: string; "aria-hidden"?: boolean }>
  children: React.ReactNode
  className?: string
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-xs font-medium",
        tone === "positive" && "bg-positive-wash text-positive",
        tone === "caution" && "bg-caution-wash text-caution",
        tone === "critical" && "bg-critical-wash text-critical",
        tone === "accent" && "bg-accent-wash text-accent",
        tone === "neutral" && "bg-sunken text-fg-muted",
        className
      )}
    >
      {Icon && <Icon className="size-3 shrink-0" aria-hidden />}
      {children}
    </span>
  )
}

/**
 * Where a value came from, said beside the value.
 *
 * "OpenAlex" beside a journal name and "Our journal data" beside a quartile
 * are different promises -- one is what a publisher declared, the other is
 * what the college's own tables hold -- and a claimant deciding whether to
 * trust a filled-in field needs to know which one they are looking at.
 */
export function SourceTag({ source, className }: { source?: string | null; className?: string }) {
  if (!source) return null
  return (
    <span className={cn("shrink-0 whitespace-nowrap text-xs text-fg-subtle", className)}>
      <span className="sr-only">from </span>
      {source}
    </span>
  )
}

/**
 * One answered thing, read back -- with the way to change it, when there is
 * one. Stacked below `sm`: side by side at 375px a paper title got two or
 * three characters of width and was truncated to nothing checkable.
 */
export function SummaryRow({
  label,
  value,
  onChange,
  source,
}: {
  label: string
  value: React.ReactNode
  onChange?: () => void
  source?: string | null
}) {
  if (value === "" || value == null) return null
  return (
    <div className="flex flex-col gap-0.5 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4">
      <dt className="shrink-0 text-fg-muted">{label}</dt>
      <dd className="flex min-w-0 flex-wrap items-baseline gap-x-2 sm:justify-end">
        <span className="min-w-0 break-words sm:text-right">{value}</span>
        <SourceTag source={source} />
        {onChange && (
          <button
            type="button"
            onClick={onChange}
            className="shrink-0 text-sm text-accent underline-offset-2 hover:underline"
          >
            Change
            <span className="sr-only"> {label}</span>
          </button>
        )}
      </dd>
    </div>
  )
}

export type CheckState = "pass" | "fail" | "unknown"

const CHECK_ICON: Record<CheckState, { Icon: typeof CircleCheck; className: string; word: string }> = {
  pass: { Icon: CircleCheck, className: "text-positive", word: "Passed" },
  fail: { Icon: CircleX, className: "text-critical", word: "Failed" },
  unknown: { Icon: CircleHelp, className: "text-fg-muted", word: "Not determined" },
}

/** One fact, its verdict, and what to do if the verdict is bad. The word in
 *  the screen-reader span is there because an icon and a colour are the same
 *  signal twice, not two signals. */
export function CheckRow({
  state,
  label,
  detail,
}: {
  state: CheckState
  label: string
  detail?: React.ReactNode
}) {
  const { Icon, className, word } = CHECK_ICON[state]
  return (
    <li className="flex gap-2.5 py-3">
      <Icon className={cn("mt-0.5 size-4 shrink-0", className)} aria-hidden />
      <div className="min-w-0">
        <p className="text-base font-medium">{label}</p>
        {detail && <p className="mt-0.5 text-sm text-fg-muted">{detail}</p>}
      </div>
      <span className="sr-only">{word}</span>
    </li>
  )
}

/** "a, b and c" — a list a person reads, not one a machine emits. */
export function listOf(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? ""
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`
}

/** First letter up, for a phrase built from field names that starts a
 *  sentence. */
export function sentenceCase(text: string): string {
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : text
}

export function formatBytes(bytes: number | null): string {
  if (bytes == null) return ""
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
