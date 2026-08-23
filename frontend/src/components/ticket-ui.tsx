import { AlertTriangle, CheckCircle2, Link2 } from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

/**
 * Filed → checked by the research cell → approved by the Principal → paid.
 *
 * This said three steps and ended "cleared by admin → paid by Finance", which
 * is the chain as it was before the Principal was put in it. The cost was not
 * cosmetic: a CLEARED ticket was labelled "with Finance" and its author was
 * told "Finance has your ticket", when Finance cannot see a ticket until the
 * Principal has approved it. Eighteen live tickets were being described that
 * way — one waiting on the Principal and claiming to be with Finance, and
 * seventeen already approved and shown as though nothing had happened yet.
 */
const FLOW = ["SUBMITTED", "CLEARED", "PRINCIPAL_APPROVED", "PAID"] as const

const LABELS: Record<string, string> = {
  DRAFT: "Draft",
  SUBMITTED: "Awaiting check",
  CLEARED: "Checked — with the Principal",
  PRINCIPAL_APPROVED: "Approved — with Finance",
  PAID: "Paid",
  REJECTED: "Needs changes",
  // Old chain. Tickets filed before the change still carry these.
  HOD_APPROVED: "Approved by HoD (old flow)",
  RESEARCH_APPROVED: "Checked — with the Principal",
  FINANCE_APPROVED: "Approved — with Finance",
}

/** Four dots need four words that fit under them. */
const FLOW_STEP_LABELS: Record<(typeof FLOW)[number], string> = {
  SUBMITTED: "Filed",
  CLEARED: "Checked",
  PRINCIPAL_APPROVED: "Approved",
  PAID: "Paid",
}

/** Map an old-chain status onto its position in the current flow. */
function flowStatus(status: string): string {
  switch (status) {
    case "HOD_APPROVED":
      return "SUBMITTED"
    case "RESEARCH_APPROVED":
      return "CLEARED"
    case "FINANCE_APPROVED":
      return "PRINCIPAL_APPROVED"
    default:
      return status
  }
}

/** How far along, 0 to 1 — the number behind every bar on this page. */
export function ticketProgress(status: string): number {
  if (status === "DRAFT" || status === "REJECTED") return 0
  const i = FLOW.indexOf(flowStatus(status) as (typeof FLOW)[number])
  if (i < 0) return 0
  return (i + 1) / FLOW.length
}

export function statusLabel(status: string) {
  return LABELS[status] || status.replace(/_/g, " ")
}

/** Copies a deep link to this ticket on the current portal page — the URL
 * every portal already knows how to open via its ?claim= handler. */
export function CopyTicketLink({ claimId, className }: { claimId: string; className?: string }) {
  async function copy() {
    const url = `${window.location.origin}${window.location.pathname}?claim=${claimId}`
    try {
      await navigator.clipboard.writeText(url)
      toast.success("Link copied — paste it in chat or email")
    } catch {
      toast.error("Could not copy — your browser blocked clipboard access")
    }
  }
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className={cn("h-7 gap-1.5 px-2 text-xs text-muted-foreground", className)}
      onClick={copy}
    >
      <Link2 className="size-3.5" aria-hidden />
      Copy link
    </Button>
  )
}

export function facultyStatusMessage(status: string): string {
  switch (status) {
    case "DRAFT":
      return "Draft — verify and submit when ready."
    case "SUBMITTED":
    case "HOD_APPROVED":
      return "Submitted — waiting to be checked by the research cell."
    case "CLEARED":
    case "RESEARCH_APPROVED":
      // Not with Finance. The Principal has to approve it first, and saying
      // otherwise sent people to Finance to ask after a ticket Finance had
      // never been shown.
      return "Checked by the research cell. Waiting for the Principal to approve it."
    case "PRINCIPAL_APPROVED":
    case "FINANCE_APPROVED":
      return "Approved by the Principal. Finance has your ticket and will process the payment."
    case "PAID":
      // Past tense: this banner only ever shows on a ticket that is already
      // paid, and "will be processed shortly" read as though it still owed
      // the claimant something.
      return "Paid. Your remuneration has been processed by Finance."
    case "REJECTED":
      return "Sent back — edit details and submit again."
    default:
      return statusLabel(status)
  }
}

function statusBadgeVariant(status: string): "default" | "secondary" | "outline" | "destructive" {
  if (status === "PAID") return "default"
  if (status === "REJECTED") return "destructive"
  if (status === "DRAFT") return "outline"
  return "secondary"
}

function statusBadgeClass(status: string) {
  switch (status) {
    case "PAID":
      return "border-success/20 bg-success/10 text-success hover:bg-success/10"
    case "REJECTED":
      return ""
    case "SUBMITTED":
      return "border-info/20 bg-info/10 text-info hover:bg-info/10"
    case "CLEARED":
    case "HOD_APPROVED":
    case "RESEARCH_APPROVED":
      return "border-warning/20 bg-warning/10 text-warning-foreground hover:bg-warning/10"
    // Approved is nearly there, and reading it in the same amber as "still
    // waiting" hid the one step that actually releases the money.
    case "PRINCIPAL_APPROVED":
    case "FINANCE_APPROVED":
      return "border-info/20 bg-info/10 text-info hover:bg-info/10"
    default:
      return ""
  }
}

export function StatusChip({
  status,
  contest,
  className,
}: {
  status: string
  contest?: boolean
  className?: string
}) {
  return (
    <span className={cn("inline-flex flex-wrap items-center gap-1.5", className)}>
      <Badge variant={statusBadgeVariant(status)} className={statusBadgeClass(status)}>
        {statusLabel(status)}
      </Badge>
      {contest ? (
        <Badge variant="outline" className="border-warning/30 bg-warning/10 text-warning-foreground">
          Contested
        </Badge>
      ) : null}
    </span>
  )
}

export function StatusBanner({
  status,
  note,
  className,
}: {
  status: string
  note?: string | null
  className?: string
}) {
  if (status === "PAID") {
    return (
      <div
        className={cn(
          "flex gap-3 rounded-lg border border-success/20 bg-success/10 px-4 py-3 text-sm text-success",
          className
        )}
      >
        <CheckCircle2 className="mt-0.5 size-4 shrink-0" aria-hidden />
        <div>
          <p className="font-medium">{facultyStatusMessage(status)}</p>
          {note ? <p className="mt-1 opacity-80">{note}</p> : null}
        </div>
      </div>
    )
  }
  if (status === "REJECTED") {
    return (
      <div
        className={cn(
          "flex gap-3 rounded-lg border border-destructive/20 bg-destructive/10 px-4 py-3 text-sm text-destructive",
          className
        )}
      >
        <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
        <div>
          <p className="font-medium">{facultyStatusMessage(status)}</p>
          {note ? <p className="mt-1 opacity-80">{note}</p> : null}
        </div>
      </div>
    )
  }
  return (
    <p className={cn("text-sm text-muted-foreground", className)}>
      {facultyStatusMessage(status)}
      {note ? ` — ${note}` : ""}
    </p>
  )
}

export function ContestCallout({
  note,
  className,
}: {
  note?: string | null
  className?: string
}) {
  if (!note) return null
  return (
    <div
      className={cn(
        "rounded-lg border border-warning/20 bg-warning/10 px-4 py-3 text-sm text-warning-foreground",
        className
      )}
      role="status"
    >
      <p className="text-xs font-medium text-warning-foreground/80">Sent with a note</p>
      <p className="mt-1.5 leading-relaxed">{note}</p>
    </div>
  )
}

/**
 * How far along a ticket is, in one line.
 *
 * Meant for lists, where a badge tells you the stage but not the distance —
 * "Checked" and "Approved" look equally far from paid until you know the
 * chain has four steps and one of them is second from the end.
 */
export function TicketProgress({
  status,
  className,
}: {
  status: string
  className?: string
}) {
  // Nothing left to say once it is paid: the bar is full, the label reads
  // "Step 4 of 4", and the badge beside it already says Paid. On a list of
  // eighty-six settled publications that is eighty-six identical green bars
  // carrying no information. The point of this was the distance still to go.
  if (status === "DRAFT" || status === "REJECTED" || status === "PAID") return null
  const share = ticketProgress(status)
  const step = Math.round(share * FLOW.length)
  return (
    <div className={cn("min-w-0", className)}>
      <div
        className="h-1 overflow-hidden rounded-full bg-muted"
        role="progressbar"
        aria-valuenow={step}
        aria-valuemin={0}
        aria-valuemax={FLOW.length}
        aria-label={`Step ${step} of ${FLOW.length}: ${statusLabel(status)}`}
      >
        <div
          className={cn(
            "h-full rounded-full transition-[width] duration-500",
            status === "PAID" ? "bg-success" : "bg-primary"
          )}
          style={{ width: `${share * 100}%` }}
        />
      </div>
      <p className="mt-1 text-[11px] text-muted-foreground">
        Step {step} of {FLOW.length}
      </p>
    </div>
  )
}

export function StatusTimeline({ status }: { status: string }) {
  // A draft has not entered the chain and a sent-back ticket has left it;
  // drawing four steps for either invents progress that does not exist.
  if (status === "DRAFT" || status === "REJECTED") {
    return <StatusBanner status={status} />
  }

  // Old-chain tickets map onto the current four steps so their timeline still
  // reads as progress rather than falling off the start.
  const idx = FLOW.indexOf(flowStatus(status) as (typeof FLOW)[number])
  const share = ticketProgress(status)

  return (
    <div className="space-y-3">
      <ol className="flex items-center gap-0" aria-label="Approval progress">
        {FLOW.map((step, i) => {
          const done = i <= idx
          const current = i === idx
          const isLast = i === FLOW.length - 1
          return (
            <li key={step} className="flex min-w-0 flex-1 items-center">
              <div className="flex min-w-0 flex-col items-center gap-1.5">
                <div
                  className={cn(
                    "flex size-7 items-center justify-center rounded-full border text-[11px] font-medium transition-colors",
                    done && status === "PAID" && "border-success bg-success text-white",
                    done && status !== "PAID" && "border-primary bg-primary text-primary-foreground",
                    current && "ring-2 ring-primary/25 ring-offset-2 ring-offset-background",
                    !done && "border-border bg-muted text-muted-foreground"
                  )}
                >
                  {/* A step that is finished says so; the one in progress keeps
                      its number, because that is the one you are counting. */}
                  {done && !current ? (
                    <CheckCircle2 className="size-4" aria-hidden />
                  ) : (
                    i + 1
                  )}
                </div>
                <span
                  className={cn(
                    "max-w-full truncate text-center text-[11px]",
                    current ? "font-medium text-foreground" : "text-muted-foreground"
                  )}
                >
                  {FLOW_STEP_LABELS[step]}
                </span>
              </div>
              {!isLast ? (
                <div
                  className={cn(
                    "mx-1 mb-5 h-px flex-1",
                    i < idx ? (status === "PAID" ? "bg-success" : "bg-primary") : "bg-border"
                  )}
                  aria-hidden
                />
              ) : null}
            </li>
          )
        })}
      </ol>

      {/* The dots say which step. The bar says how much is left, which is the
          question somebody waiting on money is actually asking. */}
      <div
        className="h-1.5 overflow-hidden rounded-full bg-muted"
        role="progressbar"
        aria-valuenow={idx + 1}
        aria-valuemin={0}
        aria-valuemax={FLOW.length}
      >
        <div
          className={cn(
            "h-full rounded-full transition-[width] duration-700",
            status === "PAID" ? "bg-success" : "bg-primary"
          )}
          style={{ width: `${share * 100}%` }}
        />
      </div>

      {status === "PAID" ? (
        <StatusBanner status={status} />
      ) : (
        <p className="text-sm text-muted-foreground">{facultyStatusMessage(status)}</p>
      )}
    </div>
  )
}

export function Money({
  value,
  className,
  size = "md",
}: {
  value?: number | null
  className?: string
  size?: "sm" | "md" | "lg"
}) {
  if (value == null) return <span className="text-muted-foreground">—</span>
  return (
    <span
      className={cn(
        "tabular-nums tracking-tight",
        size === "lg" && "text-2xl font-semibold",
        size === "md" && "font-medium",
        size === "sm" && "text-sm",
        className
      )}
    >
      {formatMoney(value)}
    </span>
  )
}

/**
 * Rupees, formatted like money rather than like a float.
 *
 * Amounts come off the formula as plain numbers, so a payout of 52377.5
 * rendered as "₹52,377.5" — a single stray decimal that reads as a rounding
 * mistake next to "₹39,081". Paise are shown only when there are any, and
 * then always as two digits.
 */
export function formatMoney(value: number): string {
  const hasPaise = Math.round(value * 100) % 100 !== 0
  return `₹${value.toLocaleString("en-IN", {
    minimumFractionDigits: hasPaise ? 2 : 0,
    maximumFractionDigits: 2,
  })}`
}

/**
 * A timestamp, formatted the same way everywhere.
 *
 * These were bare `toLocaleString()` calls, so the format followed each
 * viewer's browser locale — the same claim history read "17/08/2026, 20:45:12"
 * for one person and "8/17/2026, 8:45:12 PM" for the next, while every amount
 * on the same row was pinned to en-IN. Dates now match the money.
 */
export function formatDateTime(value: string | number | Date | null | undefined): string {
  if (!value) return "—"
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return "—"
  return d.toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })
}

/**
 * A payout month ("2026-08") as words.
 *
 * Three copies of this existed -- in the reports, the faculty record and the
 * duplicate warning -- and all three passed `undefined` as the locale, so the
 * month followed each viewer's browser while every amount on the same row was
 * pinned to en-IN. One implementation, pinned like the rest.
 *
 * `length: "long"` spells the month out, for headings; the default is the
 * short form that fits in a table cell.
 */
export function monthLabel(key?: string | null, length: "short" | "long" = "short"): string {
  if (!key) return "—"
  const [y, m] = key.split("-").map(Number)
  if (!y || !m) return key
  return new Date(y, m - 1, 1).toLocaleDateString("en-IN", {
    month: length,
    year: "numeric",
  })
}

/** The same, without the time — for "last activity" style lines. */
export function formatDate(value: string | number | Date | null | undefined): string {
  if (!value) return "—"
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return "—"
  return d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })
}

export function VerificationSnapshot({
  snapshot,
  className,
}: {
  snapshot?: Record<string, unknown> | null
  className?: string
}) {
  if (!snapshot || typeof snapshot !== "object") return null
  const entries = Object.entries(snapshot).filter(
    ([, v]) => v !== null && v !== undefined && v !== ""
  )
  if (!entries.length) return null
  return (
    <div className={cn("rounded-lg border border-border bg-muted/40 px-4 py-3", className)}>
      <p className="text-xs font-medium text-muted-foreground">Verification</p>
      <dl className="mt-2 grid gap-2 sm:grid-cols-2">
        {entries.slice(0, 8).map(([k, v]) => (
          <div key={k} className="min-w-0">
            <dt className="text-[11px] text-muted-foreground">{k.replace(/_/g, " ")}</dt>
            <dd className="truncate text-sm font-medium">
              {typeof v === "boolean" ? (v ? "Yes" : "No") : String(v)}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  )
}
