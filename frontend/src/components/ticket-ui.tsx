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

export function StatusTimeline({ status }: { status: string }) {
  if (status === "DRAFT") {
    return <p className="text-sm text-muted-foreground">{facultyStatusMessage(status)}</p>
  }
  if (status === "REJECTED") {
    return (
      <div className="rounded-[var(--radius)] border border-rose-200/80 bg-rose-50 px-3 py-2.5 text-sm text-rose-900">
        {facultyStatusMessage(status)}
      </div>
    )
  }
  if (status === "PAID") {
    return (
      <div className="rounded-[var(--radius)] border border-emerald-200/80 bg-emerald-50 px-3 py-2.5 text-sm text-emerald-900">
        {facultyStatusMessage(status)}
      </div>
    )
  }
  const idx = FLOW.indexOf(status as (typeof FLOW)[number])
  return (
    <ol className="flex flex-wrap gap-1.5">
      {FLOW.map((step, i) => {
        const done = i < idx
        const current = i === idx
        return (
          <li
            key={step}
            className={cn(
              "rounded-full px-3 py-1.5 text-[11px] font-medium tracking-wide transition-colors duration-[var(--duration-normal)]",
              done && "bg-primary/15 text-primary",
              current && "bg-primary text-primary-foreground",
              !done && !current && "bg-muted text-muted-foreground"
            )}
          >
            {statusLabel(step)}
          </li>
        )
      })}
    </ol>
  )
}

export function Money({ value }: { value?: number | null }) {
  if (value == null) return <span className="text-muted-foreground">—</span>
  return (
    <span className="tabular-nums">₹{value.toLocaleString("en-IN")}</span>
  )
}
