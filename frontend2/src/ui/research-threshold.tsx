import { Link } from "react-router-dom"

import { cn } from "@/lib/cn"
import { useApi } from "@/lib/query"
import { money } from "@/ui/paper"

/**
 * The research threshold, said the same way on every screen.
 *
 * Research faculty are already paid to do research, so the first part of the
 * incentives they earn each year is not paid: "no incentive up to ₹3 lakh a
 * year". The server decides it (backend/core/services/research_threshold.py)
 * and puts the numbers on the account and on every claim; this file only says
 * them in plain words. One place, so Home, My claims, the payment statement
 * and every queue cannot disagree about what a claim was worth.
 */

export type ThresholdHistory = {
  id?: string
  amount: number | null
  effective_from: string
  note: string | null
  set_by?: string | null
  set_at?: string
}

/** `GET /api/me/research-threshold`, and the `research` block on `/api/me/payments`. */
export type ThresholdSummary = {
  research: boolean
  threshold?: number | null
  unset?: boolean
  year?: string
  year_start?: string
  year_end?: string
  /** Only claims approved for payment or paid. Never includes claims still waiting. */
  used?: number
  /** What claims still waiting for approval would use of the threshold. Not used yet. */
  on_the_way?: number
  /** What those same claims would be paid: the part above the threshold. */
  on_the_way_above?: number
  left?: number | null
  message?: string
  old_quota?: number | null
  needs_rupee_threshold?: boolean
  history?: ThresholdHistory[]
}

/** What a claim carries about the threshold (`claim_to_dict`). */
export type ClaimThreshold = {
  quota_applied?: boolean | null
  threshold_absorbed?: number | null
  threshold_full_amount?: number | null
  threshold_note?: string | null
  remuneration?: number | null
  owner_faculty_type?: string | null
  owner_research_threshold?: number | null
  owner_threshold_unset?: boolean | null
}

export function useMyThreshold() {
  return useApi<ThresholdSummary>(["me", "research-threshold"], "/api/me/research-threshold", {
    staleTime: 60_000,
  })
}

/** "1 June 2026" for an ISO date. */
export function longDate(iso: string | null | undefined): string {
  if (!iso) return ""
  const d = new Date(`${iso.slice(0, 10)}T00:00:00`)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" })
}

/** How much of the threshold is used, as a bar. Never the only carrier of the fact. */
export function ThresholdMeter({
  used,
  threshold,
  onTheWay = 0,
  className,
}: {
  used: number
  threshold: number
  /** What claims still waiting would use. Drawn hatched after the solid part. */
  onTheWay?: number
  className?: string
}) {
  const pct = (n: number) => (threshold > 0 ? Math.min(100, Math.max(0, (n / threshold) * 100)) : 100)
  const solid = pct(used)
  const hatched = Math.min(pct(used + onTheWay) - solid, 100 - solid)
  return (
    <div
      role="meter"
      aria-valuemin={0}
      aria-valuemax={threshold}
      aria-valuenow={Math.min(used, threshold)}
      aria-label={`${Math.round(solid)}% of the research threshold used${
        hatched > 0 ? `, ${Math.round(hatched)}% more on the way` : ""
      }`}
      className={cn(
        "flex h-1.5 w-full overflow-hidden rounded-full bg-sunken ring-1 ring-inset ring-line",
        className
      )}
    >
      <div className="h-full bg-accent" style={{ width: `${solid}%` }} />
      {hatched > 0 && (
        <div
          className="h-full opacity-70"
          style={{
            width: `${hatched}%`,
            backgroundImage:
              "repeating-linear-gradient(135deg, var(--color-accent) 0 2px, transparent 2px 4px)",
          }}
        />
      )}
    </div>
  )
}

/**
 * "You are research faculty. Your threshold this year is ₹3,00,000; ₹1,20,000
 * used, ₹1,80,000 before incentives are paid." The server writes the
 * sentence, so it reads the same in an email, a statement and here.
 */
export function ThresholdCard({
  s,
  className,
  link = true,
}: {
  s: ThresholdSummary | undefined
  className?: string
  link?: boolean
}) {
  if (!s?.research) return null
  return (
    <section
      aria-label="Your research threshold"
      data-testid="research-threshold"
      className={cn("rounded-lg bg-sunken px-4 py-3 text-sm", className)}
    >
      <p className="leading-relaxed text-fg">{s.message}</p>
      {!s.unset && s.threshold != null && (
        <div className="mt-2.5 space-y-1.5">
          <ThresholdMeter used={s.used ?? 0} threshold={s.threshold} onTheWay={s.on_the_way ?? 0} />
          <p className="text-xs text-fg-muted">
            {s.year ? `For ${s.year}. ` : ""}
            Solid is used: only incentives approved or paid. Hatched is what claims still on the way would use.
          </p>
        </div>
      )}
      {link && (
        <p className="mt-2 text-xs">
          <Link to="/papers" className="text-accent underline-offset-2 hover:underline">
            See which claims it applies to
          </Link>
        </p>
      )}
    </section>
  )
}

/**
 * Why a claim is worth ₹0 or less than the policy says, in plain words.
 * `mine` is the claimant reading their own claim ("your threshold"); staff
 * read it about somebody else. Renders nothing for a claim the threshold did
 * not touch.
 */
export function claimThresholdSentence(c: ClaimThreshold, mine: boolean): string | null {
  const absorbed = c.threshold_absorbed ?? 0
  const full = c.threshold_full_amount ?? 0
  if (absorbed <= 0.005 || full <= 0) return null
  const whose = mine ? "your" : "the"
  const inside = absorbed >= full - 0.005
  if (inside) {
    return `Inside ${whose} research threshold. The ${money(full)} counts against ${mine ? "your" : "their"} yearly threshold, so nothing is paid on this claim.`
  }
  return `This claim crosses ${whose} research threshold. ${money(absorbed)} of its ${money(full)} counts against it, and ${money(c.remuneration ?? full - absorbed)} above it is paid.`
}

export function ClaimThresholdNote({
  c,
  mine = false,
  className,
}: {
  c: ClaimThreshold
  mine?: boolean
  className?: string
}) {
  const text = claimThresholdSentence(c, mine)
  if (!text) return null
  return (
    <p data-testid="claim-threshold-note" className={cn("text-sm leading-relaxed text-fg-muted", className)}>
      {text}
    </p>
  )
}

/** A few words for a queue row. */
export function thresholdFlag(c: ClaimThreshold): string | null {
  const absorbed = c.threshold_absorbed ?? 0
  const full = c.threshold_full_amount ?? 0
  if (absorbed <= 0.005 || full <= 0) return null
  return absorbed >= full - 0.005 ? "Inside research threshold" : "Part inside research threshold"
}
