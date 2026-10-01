import { useEffect } from "react"
import { useLocation } from "react-router-dom"

import { cn } from "@/lib/cn"

/**
 * Small pieces the research cell's views share, kept in one place so the same
 * thing reads the same on Home, Flags, Past claims, Journals and Coordination.
 * (docs/ux/22: the same thing is counted, and named, the same way everywhere.)
 */

/**
 * Where a claim stands, in the words the desks use (docs/ux/19): not the
 * claimant's "Awaiting check". Word first; colour is a second signal.
 */
export function staffStage(status: string): { label: string; tone: "neutral" | "progress" | "done" | "attention" } {
  switch (status) {
    case "SUBMITTED":
      return { label: "Waiting to be cleared", tone: "progress" }
    case "CLEARED":
      return { label: "Cleared, with the Principal", tone: "progress" }
    case "PRINCIPAL_APPROVED":
      return { label: "Approved, with the Director", tone: "progress" }
    case "DIRECTOR_APPROVED":
      return { label: "Authorised, with Finance", tone: "progress" }
    case "PAID":
      return { label: "Paid", tone: "done" }
    case "REJECTED":
      return { label: "Sent back or not accepted", tone: "attention" }
    case "DRAFT":
      return { label: "Not filed yet", tone: "neutral" }
    default:
      return { label: "In progress", tone: "neutral" }
  }
}

/**
 * A link to `#something` on this page (an Answer figure pointing lower down)
 * scrolls there once the page has what it points at. The router changes the
 * hash but does not scroll to it.
 */
export function useHashScroll(ready: boolean) {
  const { hash } = useLocation()
  useEffect(() => {
    if (!ready || !hash) return
    document.getElementById(hash.slice(1))?.scrollIntoView({ block: "start" })
  }, [hash, ready])
}

/** "3 days", "1 day", "Today". */
export function daysText(n: number | null | undefined): string {
  if (n == null) return "Not recorded"
  if (n <= 0) return "Today"
  return `${n} ${n === 1 ? "day" : "days"}`
}

/**
 * A claim number. One imported from the old ERP (ERP-RAW-3 and the like) says
 * so on hover, and `ClaimNoLegend` says it once per view for everyone who
 * cannot hover.
 */
export function ClaimNo({
  ticket,
  origin,
  className,
}: {
  ticket: string | null | undefined
  origin?: string | null
  className?: string
}) {
  if (!ticket) return <span className={cn("text-fg-muted", className)}>No claim number</span>
  return (
    <span className={cn("tabular", className)} title={origin ?? undefined}>
      {ticket}
    </span>
  )
}

/** One line under a list that holds imported claim numbers. */
export function ClaimNoLegend({ show }: { show: boolean }) {
  if (!show) return null
  return (
    <p className="text-sm text-fg-muted">
      Numbers that start with ERP were brought across from the old ERP workbook. They have no filing date of their own.
    </p>
  )
}

/**
 * How long a claim has waited, with the word as well as the colour: "Late"
 * once it is past the service level, "Nearly late" on its last day.
 */
export function Waited({ days, sla = 14, className }: { days: number | null | undefined; sla?: number; className?: string }) {
  const d = days ?? 0
  const state = d > sla ? "Late" : d >= sla - 1 ? "Nearly late" : null
  return (
    <span className={cn("block text-right tabular", className)}>
      <span className={cn("block text-sm", d > sla ? "font-medium text-critical" : d >= sla - 1 ? "text-caution" : "text-fg-muted")}>
        {daysText(days)}
      </span>
      {state && <span className={cn("block text-xs", d > sla ? "text-critical" : "text-caution")}>{state}</span>}
    </span>
  )
}
