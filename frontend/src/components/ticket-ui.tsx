import { AlertTriangle, CheckCircle2, Link2 } from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

/** Submitted → cleared by admin → paid by Finance. */
const FLOW = ["SUBMITTED", "CLEARED", "PAID"] as const

const LABELS: Record<string, string> = {
  DRAFT: "Draft",
  SUBMITTED: "Awaiting clearance",
  CLEARED: "Cleared — with Finance",
  // "Payment cleared" collided with CLEARED's "Cleared — with Finance";
  // the same word meant two different stages.
  PAID: "Paid",
  REJECTED: "Needs changes",
  // Old chain. Tickets filed before the change still carry these.
  HOD_APPROVED: "Approved by HoD (old flow)",
  PRINCIPAL_APPROVED: "Cleared — with Finance",
  FINANCE_APPROVED: "Cleared — with Finance",
  RESEARCH_APPROVED: "Cleared — with Finance",
}

const FLOW_STEP_LABELS: Record<(typeof FLOW)[number], string> = {
  SUBMITTED: "Submitted",
  CLEARED: "Cleared",
  PAID: "Paid",
}

/** Statuses that sit at the "cleared, awaiting payment" point of the flow. */
const CLEARED_STATUSES = [
  "CLEARED",
  "PRINCIPAL_APPROVED",
  "FINANCE_APPROVED",
  "RESEARCH_APPROVED",
]

/** Map an old-chain status onto its position in the current flow. */
function flowStatus(status: string): string {
  if (CLEARED_STATUSES.includes(status)) return "CLEARED"
  if (status === "HOD_APPROVED") return "SUBMITTED"
  return status
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
  if (CLEARED_STATUSES.includes(status)) {
    return "Cleared. Finance has your ticket and will process the payment."
  }
  switch (status) {
    case "DRAFT":
      return "Draft — verify and submit when ready."
    case "SUBMITTED":
    case "HOD_APPROVED":
      return "Submitted — waiting to be cleared."
    case "PAID":
      return "Your payment has been cleared and will be processed shortly."
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
    case "PRINCIPAL_APPROVED":
    case "FINANCE_APPROVED":
    case "RESEARCH_APPROVED":
      return "border-warning/20 bg-warning/10 text-warning-foreground hover:bg-warning/10"
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

export function StatusTimeline({ status }: { status: string }) {
  if (status === "DRAFT" || status === "REJECTED" || status === "PAID") {
    return <StatusBanner status={status} />
  }

  // Old-chain tickets map onto the current three steps so their timeline still
  // reads as progress rather than falling off the start.
  const idx = FLOW.indexOf(flowStatus(status) as (typeof FLOW)[number])

  return (
    <div className="space-y-3">
      <ol className="flex items-center gap-0" aria-label="Approval progress">
        {FLOW.map((step, i) => {
          const done = i < idx
          const current = i === idx
          const isLast = i === FLOW.length - 1
          return (
            <li key={step} className="flex min-w-0 flex-1 items-center">
              <div className="flex min-w-0 flex-col items-center gap-1.5">
                <div
                  className={cn(
                    "flex size-7 items-center justify-center rounded-full border text-[11px] font-medium",
                    done && "border-primary bg-primary text-primary-foreground",
                    current && "border-primary bg-primary text-primary-foreground",
                    !done && !current && "border-border bg-muted text-muted-foreground"
                  )}
                >
                  {i + 1}
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
                    i < idx ? "bg-primary" : "bg-border"
                  )}
                  aria-hidden
                />
              ) : null}
            </li>
          )
        })}
      </ol>
      <p className="text-sm text-muted-foreground">{facultyStatusMessage(status)}</p>
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
      ₹{value.toLocaleString("en-IN")}
    </span>
  )
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
