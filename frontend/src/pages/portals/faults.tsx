/**
 * Everything wrong, in one place.
 *
 * Each of these was a query somebody ran by hand once and was never going to
 * run again. They are grouped by the response they need rather than by the
 * table they came from: a person who cannot file, work that has stalled, a
 * verification that could not confirm, and money that does not reconcile are
 * four different jobs for four different afternoons.
 */
import { AlertTriangle, ArrowRight, CheckCircle2, Info } from "lucide-react"
import { Link } from "react-router-dom"

import { ErrorState, PageHeader, Section, StatStrip } from "@/components/layout/page"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import { useApiQuery } from "@/lib/queries"
import { cn } from "@/lib/utils"

type Fault = {
  key: string
  title: string
  detail: string
  count: number
  severity: "critical" | "warning" | "info"
  to?: string | null
  sample: string[]
}

type Group = { key: string; title: string; blurb: string; faults: Fault[] }

type Payload = {
  groups: Group[]
  total: number
  urgent: number
  checked_at: string
}

/** Severity is carried by an icon and a word, never by colour alone. */
const SEVERITY: Record<
  Fault["severity"],
  { label: string; icon: typeof Info; className: string }
> = {
  critical: {
    label: "Blocking",
    icon: AlertTriangle,
    className: "text-destructive",
  },
  warning: { label: "Needs attention", icon: AlertTriangle, className: "text-warning" },
  info: { label: "For information", icon: Info, className: "text-muted-foreground" },
}

function FaultRow({ fault }: { fault: Fault }) {
  const sev = SEVERITY[fault.severity]
  const Icon = sev.icon
  const body = (
    <>
      <span className="flex min-w-0 items-start gap-3">
        <Icon className={cn("mt-0.5 size-4 shrink-0", sev.className)} aria-hidden />
        <span className="min-w-0">
          <span className="block text-sm font-medium text-foreground">{fault.title}</span>
          <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">
            {fault.detail}
          </span>
          {fault.sample.length ? (
            <span className="mt-1.5 block truncate font-mono text-[11px] text-muted-foreground">
              {fault.sample.slice(0, 3).join(" · ")}
              {fault.count > 3 ? ` · +${fault.count - 3} more` : ""}
            </span>
          ) : null}
        </span>
      </span>
      <span className="flex shrink-0 items-center gap-3">
        <span className="text-metric-sm tabular-nums text-foreground">{fault.count}</span>
        {fault.to ? (
          <ArrowRight className="size-4 text-muted-foreground" aria-hidden />
        ) : null}
      </span>
    </>
  )

  const className =
    "flex items-start justify-between gap-4 px-4 py-3.5 transition-colors"

  // Only the ones with somewhere to go are links; the rest would be a link that
  // lies about being clickable.
  return fault.to ? (
    <Link to={fault.to} className={cn(className, "interactive hover:bg-muted/40")}>
      {body}
    </Link>
  ) : (
    <div className={className}>{body}</div>
  )
}

export function AdminFaultsPage() {
  const { data, isLoading, isError, refetch } = useApiQuery<Payload>(
    ["admin", "faults"],
    "/api/admin/faults"
  )

  const groups = (data?.groups || []).map((g) => ({
    ...g,
    faults: g.faults.filter((f) => f.count > 0),
  }))
  const withFaults = groups.filter((g) => g.faults.length)

  return (
    <div className="space-y-6">
      <PageHeader
        title="Faults"
        subtitle="What is broken, blocked or unreconciled right now"
      />

      {isLoading ? (
        <Skeleton className="h-64 w-full rounded-[var(--radius)]" />
      ) : isError ? (
        <ErrorState
          title="Could not run the checks"
          description="The fault report did not load."
          onRetry={() => refetch()}
        />
      ) : (
        <>
          <StatStrip
            items={[
              { label: "Blocking someone", value: data?.urgent ?? 0 },
              { label: "Total findings", value: data?.total ?? 0 },
              { label: "Areas affected", value: withFaults.length },
            ]}
          />

          {withFaults.length === 0 ? (
            <div className="surface-card flex flex-col items-center gap-3 px-6 py-14 text-center">
              <CheckCircle2 className="size-6 text-success" aria-hidden />
              <p className="text-sm font-medium text-foreground">Nothing to report</p>
              <p className="max-w-md text-sm text-muted-foreground">
                Every check passed: no missing identity details, nothing stalled in a
                queue, nothing unverified, and every payment reconciles.
              </p>
            </div>
          ) : (
            withFaults.map((group) => (
              <Section key={group.key} title={group.title} description={group.blurb}>
                <div className="surface-card overflow-hidden">
                  <div className="divide-y divide-border/70">
                    {group.faults.map((f) => (
                      <FaultRow key={f.key} fault={f} />
                    ))}
                  </div>
                </div>
              </Section>
            ))
          )}

          {/* Groups that came back clean still get a line: "no findings" is a
              result, and silence looks like the check never ran. */}
          {groups.some((g) => !g.faults.length) ? (
            <p className="text-sm text-muted-foreground">
              Clean:{" "}
              {groups
                .filter((g) => !g.faults.length)
                .map((g) => g.title.toLowerCase())
                .join(", ")}
              .
            </p>
          ) : null}

          {data?.checked_at ? (
            <p className="text-xs text-muted-foreground">
              Checked {new Date(data.checked_at).toLocaleString("en-IN")}
            </p>
          ) : null}
        </>
      )}
    </div>
  )
}
