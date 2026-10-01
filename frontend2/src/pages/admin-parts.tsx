import { Link } from "react-router-dom"
import { ArrowUpRight, CheckCircle2, CircleAlert } from "lucide-react"

import { cn } from "@/lib/cn"
import { Meta } from "@/ui/text"

/**
 * The pieces the super admin's Home and Admin page share: one list of what
 * needs attention, and one checklist of whether the system is ready.
 *
 * Both are drawn from `/api/admin/attention` and `/api/admin/readiness`, which
 * are computed by one service each, so a number on Home and the same number on
 * Admin cannot disagree. A row says how urgent it is in words as well as
 * colour, how many there are with what they are, and the one thing to do.
 */

export type AttentionItem = {
  key: string
  job: "people" | "data" | "money" | "running"
  severity: "critical" | "warning" | "info"
  title: string
  why: string
  to: string
  count: number | null
  action: string
  unit: string | null
}

export type Attention = { checked_at: string; items: AttentionItem[]; ok: string[] }

export type ReadyCheck = {
  key: string
  label: string
  ok: boolean
  detail: string
  to: string
  fix: string
  severity: "critical" | "warning" | "info"
}

export type Readiness = { checked_at: string; ok: number; total: number; items: ReadyCheck[] }

export type DataFixQueue = { key: string; label: string; why: string; count: number }
export type DataFixes = {
  queues: DataFixQueue[]
  claims_needing_a_fix: number
  total: number
}

export const SEVERITY_WORD: Record<AttentionItem["severity"], string> = {
  critical: "Urgent",
  warning: "Needs a look",
  info: "For your information",
}

const SEVERITY_TEXT: Record<AttentionItem["severity"], string> = {
  critical: "text-critical",
  warning: "text-caution",
  info: "text-fg-muted",
}

const SEVERITY_DOT: Record<AttentionItem["severity"], string> = {
  critical: "bg-critical",
  warning: "bg-caution",
  info: "bg-fg-subtle",
}

/** "1 claim", "13 claims": the unit agrees with the number beside it. */
export function unitFor(n: number, unit: string): string {
  return n === 1 && unit.endsWith("s") ? unit.slice(0, -1) : unit
}

/** One thing that needs a look, as a row that opens where it is fixed. */
export function AttentionRow({ item }: { item: AttentionItem }) {
  return (
    <li>
      <Link
        to={item.to}
        className="row group flex items-start gap-3 px-1 py-3 sm:px-2"
        data-testid={`attention-${item.key}`}
      >
        <span aria-hidden className={cn("mt-2 size-2 shrink-0 rounded-full", SEVERITY_DOT[item.severity])} />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-baseline gap-x-2">
            <span className="text-base font-medium">{item.title}</span>
            <span className={cn("text-xs font-medium", SEVERITY_TEXT[item.severity])}>
              {SEVERITY_WORD[item.severity]}
            </span>
          </span>
          <span className="mt-0.5 block text-pretty text-sm text-fg-muted">{item.why}</span>
          <span className="mt-1 inline-flex items-center gap-1 text-sm text-accent sm:hidden">
            {item.action}
            <ArrowUpRight className="size-3.5" aria-hidden />
          </span>
        </span>
        {item.count != null && (
          <span className="shrink-0 text-right">
            <span className="block text-lg font-semibold leading-tight tabular">
              {item.count.toLocaleString("en-IN")}
            </span>
            {item.unit && <span className="block text-xs text-fg-muted">{unitFor(item.count, item.unit)}</span>}
          </span>
        )}
        <span className="hidden shrink-0 items-center gap-1 self-center text-sm text-accent group-hover:underline sm:inline-flex sm:w-40 sm:justify-end">
          {item.action}
          <ArrowUpRight className="size-3.5" aria-hidden />
        </span>
      </Link>
    </li>
  )
}

export function AttentionRows({ items }: { items: AttentionItem[] }) {
  return (
    <ul className="divide-y divide-line border-y border-line" aria-label="Things that need attention">
      {items.map((i) => (
        <AttentionRow key={i.key} item={i} />
      ))}
    </ul>
  )
}

/** The readiness checklist: every line green or red, red ones with the fix. */
export function ReadinessList({ data }: { data: Readiness }) {
  return (
    <ul className="divide-y divide-line border-y border-line" aria-label="Readiness checklist">
      {data.items.map((c) => (
        <li key={c.key}>
          <Link to={c.to} className="row flex items-start gap-3 px-1 py-2.5 sm:px-2" data-testid={`ready-${c.key}`}>
            {c.ok ? (
              <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-positive" aria-hidden />
            ) : (
              <CircleAlert
                className={cn("mt-0.5 size-4 shrink-0", c.severity === "info" ? "text-fg-subtle" : "text-critical")}
                aria-hidden
              />
            )}
            <span className="min-w-0 flex-1">
              <span className="block text-base">
                {c.label}
                <span className={cn("ml-2 text-xs font-medium", c.ok ? "text-positive" : "text-critical")}>
                  {c.ok ? "Ready" : "Not ready"}
                </span>
              </span>
              <Meta className="block text-pretty text-xs sm:text-sm">{c.detail}</Meta>
            </span>
            <span className="hidden shrink-0 self-center text-sm text-accent sm:inline">
              {c.fix}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  )
}
