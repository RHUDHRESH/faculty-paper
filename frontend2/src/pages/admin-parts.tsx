import { Link } from "react-router-dom"

import { cn } from "@/lib/cn"
import { Button } from "@/ui/button"

/**
 * The pieces the super admin's Home and the data-fix queue share: one list of
 * what needs attention, drawn from `/api/admin/attention`, which one service
 * computes, so a number on Home and the same number elsewhere cannot disagree.
 * A row says how urgent it is in words as well as colour, how many there are
 * with what they are, and carries one button that opens where it is fixed.
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

/**
 * One thing that needs a look: what it is, how many, and a button that opens
 * where it is fixed. The first row of a list carries the primary button (the
 * most urgent thing is the thing to do next); the rest are ordinary buttons.
 * The one-sentence reason stays on one line and opens in full on hover.
 */
export function AttentionRow({ item, primary = false }: { item: AttentionItem; primary?: boolean }) {
  return (
    <li
      className="flex flex-wrap items-center gap-x-4 gap-y-2 px-1 py-3 sm:px-2"
      data-testid={`attention-${item.key}`}
    >
      <span aria-hidden className={cn("size-2 shrink-0 rounded-full", SEVERITY_DOT[item.severity])} />
      <div className="min-w-0 flex-1 basis-56">
        <p className="flex flex-wrap items-baseline gap-x-2">
          <span className="text-base font-medium">{item.title}</span>
          <span className={cn("text-xs font-medium", SEVERITY_TEXT[item.severity])}>{SEVERITY_WORD[item.severity]}</span>
        </p>
        <p className="mt-0.5 line-clamp-1 text-sm text-fg-muted" title={item.why}>
          {item.why}
        </p>
      </div>
      {item.count != null && (
        <span className="shrink-0 text-right max-sm:ml-auto">
          <span className="block text-lg font-semibold leading-tight tabular">{item.count.toLocaleString("en-IN")}</span>
          {item.unit && <span className="block text-xs text-fg-muted">{unitFor(item.count, item.unit)}</span>}
        </span>
      )}
      <Button asChild size="sm" kind={primary ? "primary" : "default"} className="max-sm:ml-5">
        <Link to={item.to} aria-label={`${item.action}: ${item.title}`}>
          {item.action}
        </Link>
      </Button>
    </li>
  )
}

export function AttentionRows({ items }: { items: AttentionItem[] }) {
  return (
    <ul className="divide-y divide-line border-y border-line" aria-label="Things that need attention">
      {items.map((i, n) => (
        <AttentionRow key={i.key} item={i} primary={n === 0} />
      ))}
    </ul>
  )
}
