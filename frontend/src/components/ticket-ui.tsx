import { AlertTriangle, CheckCircle2 } from "lucide-react"
import { cn } from "@/lib/utils"

const FLOW = ["SUBMITTED", "HOD_APPROVED", "PRINCIPAL_APPROVED", "PAID"] as const

/** Faculty-facing short labels — no finance/process jargon. */
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

/** One-line message for faculty ticket detail / banners. */
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

export function statusTone(status: string) {
  switch (status) {
    case "PAID":
      return "bg-emerald-50 text-emerald-800 border-emerald-200/80"
    case "REJECTED":
      return "bg-rose-50 text-rose-800 border-rose-200/80"
    case "DRAFT":
      return "bg-muted text-muted-foreground border-border"
    case "SUBMITTED":
      return "bg-sky-50 text-sky-800 border-sky-200/80"
    case "HOD_APPROVED":
      return "bg-amber-50 text-amber-900 border-amber-200/80"
    case "PRINCIPAL_APPROVED":
      return "bg-teal-50 text-teal-900 border-teal-200/80"
    default:
      return "bg-muted text-muted-foreground border-border"
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
      <span
        className={cn(
          "inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors",
          statusTone(status)
        )}
      >
        {statusLabel(status)}
      </span>
      {contest ? (
        <span className="inline-flex items-center rounded-full border border-amber-200 bg-amber-50 px-2.5 py-0.5 text-xs font-medium text-amber-900">
          Contested
        </span>
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
          "flex gap-3 rounded-[var(--radius)] border border-emerald-200/80 bg-emerald-50 px-4 py-3 text-sm text-emerald-900",
          className
        )}
      >
        <CheckCircle2 className="mt-0.5 size-4 shrink-0" aria-hidden />
        <div>
          <p className="font-medium">{facultyStatusMessage(status)}</p>
          {note ? <p className="mt-1 text-emerald-800/80">{note}</p> : null}
        </div>
      </div>
    )
  }
  if (status === "REJECTED") {
    return (
      <div
        className={cn(
          "flex gap-3 rounded-[var(--radius)] border border-rose-200/80 bg-rose-50 px-4 py-3 text-sm text-rose-900",
          className
        )}
      >
        <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
        <div>
          <p className="font-medium">{facultyStatusMessage(status)}</p>
          {note ? <p className="mt-1 text-rose-800/80">{note}</p> : null}
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
        "rounded-[var(--radius)] border border-amber-200/90 bg-amber-50 px-4 py-3 text-sm text-amber-950",
        className
      )}
      role="status"
    >
      <p className="text-xs font-semibold uppercase tracking-[0.12em] text-amber-800/80">
        Sent with a note
      </p>
      <p className="mt-1.5 leading-relaxed">{note}</p>
    </div>
  )
}

export function StatusTimeline({ status }: { status: string }) {
  if (status === "DRAFT") {
    return <StatusBanner status={status} />
  }
  if (status === "REJECTED" || status === "PAID") {
    return <StatusBanner status={status} />
  }
  const idx = FLOW.indexOf(status as (typeof FLOW)[number])
  return (
    <div className="space-y-3">
      <ol className="flex flex-wrap gap-1.5" aria-label="Approval progress">
        {FLOW.map((step, i) => {
          const done = i < idx
          const current = i === idx
          return (
            <li
              key={step}
              className={cn(
                "rounded-full px-3 py-1.5 text-[11px] font-medium tracking-wide transition-colors duration-[var(--duration-normal)]",
                done && "bg-primary/15 text-primary",
                current && "bg-primary text-primary-foreground shadow-sm",
                !done && !current && "bg-muted text-muted-foreground"
              )}
            >
              {FLOW_STEP_LABELS[step]}
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
        size === "lg" && "font-[family-name:var(--font-display)] text-2xl font-semibold",
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
    <div
      className={cn(
        "rounded-[var(--radius)] border border-border/80 bg-muted/40 px-4 py-3",
        className
      )}
    >
      <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
        Verification
      </p>
      <dl className="mt-2 grid gap-2 sm:grid-cols-2">
        {entries.slice(0, 8).map(([k, v]) => (
          <div key={k} className="min-w-0">
            <dt className="text-[11px] text-muted-foreground">
              {k.replace(/_/g, " ")}
            </dt>
            <dd className="truncate text-sm font-medium">
              {typeof v === "boolean" ? (v ? "Yes" : "No") : String(v)}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  )
}
