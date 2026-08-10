import { AlertTriangle, CheckCircle2 } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"

const FLOW = ["SUBMITTED", "HOD_APPROVED", "PRINCIPAL_APPROVED", "PAID"] as const

const LABELS: Record<string, string> = {
  DRAFT: "Draft",
  SUBMITTED: "With HoD",
  HOD_APPROVED: "Approved by HoD",
  PRINCIPAL_APPROVED: "Approved",
  FINANCE_APPROVED: "Approved",
  RESEARCH_APPROVED: "Verified",
  PAID: "Payment cleared",
  REJECTED: "Needs changes",
}

const FLOW_STEP_LABELS: Record<(typeof FLOW)[number], string> = {
  SUBMITTED: "HoD",
  HOD_APPROVED: "Principal",
  PRINCIPAL_APPROVED: "Finance",
  PAID: "Paid",
}

export function statusLabel(status: string) {
  return LABELS[status] || status.replace(/_/g, " ")
}

export function facultyStatusMessage(status: string): string {
  switch (status) {
    case "DRAFT":
      return "Draft — verify and submit when ready."
    case "SUBMITTED":
      return "Submitted — waiting for HoD approval."
    case "HOD_APPROVED":
      return "Approved by HoD — waiting for Principal."
    case "PRINCIPAL_APPROVED":
      return "Approved. Finance has been ordered to process your payment."
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
    case "HOD_APPROVED":
    case "PRINCIPAL_APPROVED":
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

  const idx = FLOW.indexOf(status as (typeof FLOW)[number])

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
