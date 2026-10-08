import { useMemo, useState } from "react"
import { Link, useSearchParams } from "react-router-dom"
import { CheckCircle2, RotateCw } from "lucide-react"

import { can, useAuth } from "@/app/auth"
import { cn } from "@/lib/cn"
import { useApi, useApiMutation } from "@/lib/query"
import { Answer } from "@/ui/answer"
import { Button } from "@/ui/button"
import { ConfirmDialog } from "@/ui/dialog"
import { PageHeader } from "@/ui/page-header"
import { Details, Rows, Section } from "@/ui/section"
import { EmptyState, ErrorState, NotOpen, SkeletonRows } from "@/ui/state"
import { Table, type Column } from "@/ui/table"
import { Meta } from "@/ui/text"
import { toast } from "@/ui/toast"
import { Ago } from "@/ui/when"

import { count } from "./admin-b-parts"

/**
 * Background jobs from django-q2: harvests, the Scopus sync, backups,
 * imports. Read from `GET /api/admin/jobs`. A retry is offered only where the
 * server marks the job safe to run twice (never an import or a restore).
 *
 * The question is "did the background work finish, and is the worker alive?".
 * The answer is four figures. What failed comes first, with the last line of
 * the error and a way to run it again where that is safe. The rest is the
 * jobs grouped by name, because the same scheduled job runs dozens of times a
 * day and a list of a hundred identical rows hides the one that failed.
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
  /** Picked up by a worker and not yet finished (older servers omit it). */
  running?: RunningJob[]
  jobs: Job[]
  failed_count: number
  total: number
}

export type RunningJob = { id: string; func: string; name: string; started?: string | null; running_s?: number | null }

/** Jobs a worker has picked up, with how long each has been going. */
export function RunningJobs({ rows }: { rows: RunningJob[] }) {
  return (
    <section className="space-y-2">
      {rows.length === 0 ? (
        <Meta>Nothing is running at the moment.</Meta>
      ) : (
        <Rows>
          {rows.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
              <span className="inline-flex items-center gap-2">
                <span className="size-2 animate-pulse rounded-full bg-accent" aria-hidden />
                {r.name}
              </span>
              <Meta>
                {r.running_s != null ? `In progress for ${duration(r.running_s)}` : "In progress"}
                {r.started ? `, since ${when(r.started)}` : ""}
              </Meta>
            </li>
          ))}
        </Rows>
      )}
    </section>
  )
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

type Group = {
  name: string
  runs: number
  failed: number
  last: string | null
  avg: number | null
}

/** The same job many times over, as one line each. */
function grouped(jobs: Job[]): Group[] {
  const by = new Map<string, Group & { total: number; timed: number }>()
  for (const j of jobs) {
    const g = by.get(j.name) ?? { name: j.name, runs: 0, failed: 0, last: null, avg: null, total: 0, timed: 0 }
    g.runs += 1
    if (!j.success) g.failed += 1
    if (j.started && (!g.last || j.started > g.last)) g.last = j.started
    if (j.duration_s != null) {
      g.total += j.duration_s
      g.timed += 1
    }
    by.set(j.name, g)
  }
  return [...by.values()]
    .map((g) => ({ ...g, avg: g.timed ? g.total / g.timed : null }))
    .sort((a, b) => (b.last ?? "").localeCompare(a.last ?? ""))
}

export function Jobs() {
  const { me } = useAuth()
  const allowed = can(me?.role).admin
  const [params] = useSearchParams()
  const failedOnly = params.get("show") === "failed"
  const [retrying, setRetrying] = useState<Job | null>(null)
  const { data, isLoading, isError, refetch } = useApi<JobsPayload>(
    ["admin", "jobs", "recent"],
    "/api/admin/jobs?limit=100",
    { enabled: allowed }
  )
  const failedQ = useApi<JobsPayload>(["admin", "jobs", "failed"], "/api/admin/jobs?limit=100&failed=true", {
    enabled: allowed && (data?.failed_count ?? 0) > 0,
  })
  const retry = useApiMutation<Record<string, never>, { ok: boolean; job_id: string; name: string }>(
    () => `/api/admin/jobs/${retrying?.id ?? ""}/retry`,
    { method: "POST", invalidates: [["admin", "jobs"]] }
  )

  const groups = useMemo(() => grouped(data?.jobs ?? []), [data])

  if (!allowed)
    return (
      <div className="page py-8">
        <NotOpen message="Only the super admin sees the job queue." />
      </div>
    )

  const failed = failedQ.data?.jobs ?? []
  const lastDone = (data?.jobs ?? []).find((j) => j.stopped)?.stopped ?? null
  // The scheduled jobs run every few minutes, so three hours of silence means
  // the worker has stopped, not that there was nothing to do.
  const quiet = !lastDone || Date.now() - new Date(lastDone).getTime() > 3 * 3_600_000
  const running = data?.running ?? []
  const waiting = data?.queued ?? []

  return (
    <div className="page space-y-10">
      <PageHeader
        title="Jobs"
        sub="Harvests, the Scopus sync, backups and imports."
        spot="spot-imports"
      />

      {isLoading ? (
        <SkeletonRows rows={6} rowHeight={56} />
      ) : isError || !data ? (
        <ErrorState
          title="Could not load the jobs"
          message="The server did not answer."
          onRetry={() => void refetch()}
        />
      ) : (
        <>
          <section aria-label="The answer" className="space-y-3">
            <Answer
              items={[
                { value: data.failed_count, label: "Failed jobs", to: "?show=failed", tone: "critical", zero: "Nothing has failed" },
                { value: running.length, label: "In progress now", zero: "Nothing is running" },
                { value: waiting.length, label: "Waiting to run", zero: "Nothing is waiting" },
                quiet
                  ? {
                      value: lastDone ? "Quiet" : "No sign",
                      label: lastDone
                        ? "No job has finished for over 3 hours. Is the worker running?"
                        : "No job has finished yet",
                      tone: "critical" as const,
                    }
                  : { value: "Alive", label: "The worker finished a job recently", tone: "positive" as const },
              ]}
            />
            {lastDone && (
              <p className="text-sm text-fg-muted">
                Last job finished <Ago iso={lastDone} />.
              </p>
            )}
          </section>

          {(data.failed_count > 0 || failedOnly) && (
            <Section
              title={`Failed (${count(data.failed_count)})`}
              action={
                failedOnly ? (
                  <Button kind="default" size="sm" asChild>
                    <Link to="/jobs">Show everything</Link>
                  </Button>
                ) : undefined
              }
            >
              {failed.length === 0 ? (
                failedQ.isLoading ? (
                  <SkeletonRows rows={2} rowHeight={48} />
                ) : (
                  <EmptyState
                    illustration="empty-nothing-to-review"
                    title="No failed jobs"
                    message="Every job on record finished."
                  />
                )
              ) : (
                <Rows>
                  {failed.map((j) => (
                    <li key={j.id} className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 py-3">
                      <div className="min-w-0 flex-1 basis-64 space-y-0.5">
                        <p className="font-medium">
                          {j.name}
                        </p>
                        <Meta className="block">
                          Started {when(j.started)}
                          {j.duration_s != null ? `, took ${duration(j.duration_s)}` : ""}
                        </Meta>
                        <p className="break-words text-sm text-fg-muted">{j.result || "No reason was recorded."}</p>
                      </div>
                      {j.retry_safe ? (
                        <Button kind="default" size="sm" onClick={() => setRetrying(j)}>
                          <RotateCw aria-hidden /> Retry job
                        </Button>
                      ) : (
                        <Meta className="max-w-[16rem]">Not safe to repeat. Run it from its own page.</Meta>
                      )}
                    </li>
                  ))}
                </Rows>
              )}
            </Section>
          )}

          {!failedOnly && (running.length > 0 || waiting.length > 0) && (
            <Section title="In progress and waiting">
              {running.length > 0 && <RunningJobs rows={running} />}
              {waiting.length > 0 && (
                <Rows>
                  {waiting.map((q) => (
                    <li key={q.id} className="flex flex-wrap justify-between gap-2 py-2 text-sm">
                      <span>{q.name}</span>
                      <Meta>{q.locked ? `Picked up ${when(q.locked)}` : "Queued"}</Meta>
                    </li>
                  ))}
                </Rows>
              )}
            </Section>
          )}

          {!failedOnly && (
            <Section title="What has run">
              {groups.length === 0 ? (
                <EmptyState
                  illustration="empty-nothing-to-review"
                  title="No jobs have run yet"
                  message="Jobs appear here once they run."
                />
              ) : (
                <GroupTable groups={groups} />
              )}
              {data.jobs.length > 0 && (
                <Details label="every run" count={data.jobs.length} className="mt-3">
                  <Rows>
                    {data.jobs.map((j) => (
                      <li key={j.id} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 py-2 text-sm">
                        <span className="flex items-center gap-2">
                          {j.success ? (
                            <CheckCircle2 aria-hidden className="size-4 text-positive" />
                          ) : (
                            <span aria-hidden className="size-2 rounded-full bg-critical" />
                          )}
                          {j.name}
                          <span className={cn("text-xs", j.success ? "text-fg-muted" : "text-critical")}>
                            {j.success ? "Finished" : "Failed"}
                          </span>
                        </span>
                        <Meta>
                          {when(j.started)}
                          {j.duration_s != null ? `, ${duration(j.duration_s)}` : ""}
                        </Meta>
                        {j.result && <p className="basis-full break-words text-fg-muted">{j.result}</p>}
                      </li>
                    ))}
                  </Rows>
                </Details>
              )}
            </Section>
          )}
        </>
      )}

      <ConfirmDialog
        open={retrying !== null}
        onOpenChange={(o) => !o && setRetrying(null)}
        title={`Retry ${retrying?.name.toLowerCase() ?? "this job"}?`}
        description="It is queued with the same settings as the failed run."
        confirmLabel="Retry job"
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

function GroupTable({ groups }: { groups: Group[] }) {
  const cols: Column<Group>[] = [
    { key: "name", header: "Job", cell: (g) => g.name },
    { key: "runs", header: "Runs", align: "right", cell: (g) => count(g.runs) },
    {
      key: "failed",
      header: "Failed",
      align: "right",
      empty: "None",
      cell: (g) => (g.failed > 0 ? <span className="text-critical">{count(g.failed)}</span> : null),
    },
    { key: "last", header: "Last run", cell: (g) => (g.last ? when(g.last) : null) },
    { key: "avg", header: "Usually takes", align: "right", cell: (g) => (g.avg == null ? null : duration(g.avg)) },
  ]
  return <Table rows={groups} columns={cols} getKey={(g) => g.name} caption="Jobs, one line each" maxHeight="28rem" />
}
