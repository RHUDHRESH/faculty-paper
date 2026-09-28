import { useState } from "react"
import { RotateCw } from "lucide-react"

import { can, useAuth } from "@/app/auth"
import { cn } from "@/lib/cn"
import { useApi, useApiMutation } from "@/lib/query"
import { Button } from "@/ui/button"
import { ConfirmDialog } from "@/ui/dialog"
import { EmptyState, ErrorState, SkeletonRows } from "@/ui/state"
import { Meta, PageTitle, SectionTitle, Sub } from "@/ui/text"
import { toast } from "@/ui/toast"
import { HeaderSpot } from "@/ui/page-header"

/**
 * Background jobs from django-q2: harvests, the Scopus sync, backups,
 * imports. Read from `GET /api/admin/jobs`. A retry is offered only where
 * the server marks the job safe to run twice (never an import or a restore).
 */

type Job = {
  id: string
  func: string
  name: string
  started: string | null
  stopped: string | null
  duration_s: number | null
  success: boolean
  result: string
  attempts: number | null
  retry_safe: boolean
}

type JobsPayload = {
  queued: { id: string; func: string; name: string; locked: string | null }[]
  jobs: Job[]
  failed_count: number
  total: number
}

function when(iso: string | null): string {
  if (!iso) return "Not started"
  const d = new Date(iso)
  return d.toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })
}

function duration(s: number | null): string {
  if (s == null) return ""
  if (s < 60) return `${Math.round(s)} s`
  if (s < 3600) return `${Math.round(s / 60)} min`
  return `${(s / 3600).toFixed(1)} h`
}

export function Jobs() {
  const { me } = useAuth()
  const allowed = can(me?.role).admin
  const [failedOnly, setFailedOnly] = useState(false)
  const [retrying, setRetrying] = useState<Job | null>(null)
  const { data, isLoading, isError, error, refetch } = useApi<JobsPayload>(
    ["admin", "jobs", failedOnly],
    `/api/admin/jobs?limit=100${failedOnly ? "&failed=true" : ""}`,
    { enabled: allowed }
  )
  const retry = useApiMutation<Record<string, never>, { ok: boolean; job_id: string; name: string }>(
    () => `/api/admin/jobs/${retrying?.id ?? ""}/retry`,
    { method: "POST", invalidates: [["admin", "jobs"]] }
  )

  if (!allowed)
    return (
      <div className="page py-8">
        <ErrorState art="closed-gate" title="Not open to this account" message="Only the super admin sees the job queue." />
      </div>
    )

  return (
    <div className="page space-y-8 py-8">
      <header className="page-head">
        <div>
          <PageTitle>Jobs</PageTitle>
          <Sub className="mt-1">
            Work the system does in the background: harvests, the Scopus sync, backups and imports. Did it finish,
            how long did it take, and what did it say.
          </Sub>
        </div>
        <HeaderSpot name="spot-imports" />
      </header>

      {isLoading ? (
        <SkeletonRows rows={6} rowHeight={56} />
      ) : isError ? (
        <ErrorState title="Could not load the jobs" message={String(error)} onRetry={() => void refetch()} />
      ) : data ? (
        <>
          <section className="space-y-2">
            <SectionTitle>Waiting to run</SectionTitle>
            {data.queued.length === 0 ? (
              <Meta>Nothing is queued. The worker is idle or keeping up.</Meta>
            ) : (
              <ul className="divide-y divide-border border-y border-border">
                {data.queued.map((q) => (
                  <li key={q.id} className="flex flex-wrap justify-between gap-2 py-2 text-sm">
                    <span>{q.name}</span>
                    <Meta>{q.locked ? `Picked up ${when(q.locked)}` : "Queued"}</Meta>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <SectionTitle>
                {failedOnly ? "Failed jobs" : "Recent jobs"}
              </SectionTitle>
              <div className="flex flex-wrap gap-2">
                <Button kind={failedOnly ? "quiet" : "default"} size="sm" onClick={() => setFailedOnly(false)}>
                  All ({data.total.toLocaleString("en-IN")})
                </Button>
                <Button kind={failedOnly ? "default" : "quiet"} size="sm" onClick={() => setFailedOnly(true)}>
                  Failed ({data.failed_count.toLocaleString("en-IN")})
                </Button>
              </div>
            </div>
            {data.jobs.length === 0 ? (
              <EmptyState
                illustration="empty-nothing-to-review"
                title={failedOnly ? "No failed jobs" : "No jobs have run yet"}
                message={
                  failedOnly
                    ? "Every background job on record finished."
                    : "Take a backup from Data health, or start a harvest, and it will appear here."
                }
              />
            ) : (
              <ul className="divide-y divide-border border-y border-border">
                {data.jobs.map((j) => (
                  <li key={j.id} className="grid grid-cols-[minmax(0,1fr)] gap-2 py-3 sm:grid-cols-[minmax(0,1fr)_auto]">
                    <div className="min-w-0 space-y-0.5">
                      <p className="flex flex-wrap items-center gap-2 font-medium">
                        <span
                          aria-hidden
                          className={cn("size-2 rounded-full", j.success ? "bg-success" : "bg-critical")}
                        />
                        {j.name}
                        <span className={cn("text-sm font-normal", j.success ? "text-fg-muted" : "text-critical")}>
                          {j.success ? "Finished" : "Failed"}
                        </span>
                      </p>
                      <Meta>
                        Started {when(j.started)}
                        {j.duration_s != null ? `, took ${duration(j.duration_s)}` : ""}
                      </Meta>
                      <p className="break-words text-sm text-fg-muted">{j.result}</p>
                    </div>
                    <div className="flex items-start">
                      {j.retry_safe ? (
                        <Button kind="default" size="sm" onClick={() => setRetrying(j)}>
                          <RotateCw className="size-4" aria-hidden /> Run again
                        </Button>
                      ) : !j.success ? (
                        <Meta className="max-w-[16rem]">Run it again from its own page.</Meta>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      ) : null}

      <ConfirmDialog
        open={retrying !== null}
        onOpenChange={(o) => !o && setRetrying(null)}
        title={`Run ${retrying?.name.toLowerCase() ?? "this job"} again?`}
        description="It is queued with the same settings as the run shown. Nothing else changes until it finishes."
        confirmLabel="Run again"
        onConfirm={async () => {
          if (!retrying) return
          try {
            const r = await retry.mutateAsync({})
            toast.ok(`${r.name} queued again`)
          } catch (e) {
            toast.fail(e, "Could not queue it again")
          }
          setRetrying(null)
        }}
      />
    </div>
  )
}
