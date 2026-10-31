import { useMemo, useState } from "react"
import { useSearchParams } from "react-router-dom"
import { ListChecks, RotateCw } from "lucide-react"

import { can, useAuth } from "@/app/auth"
import { cn } from "@/lib/cn"
import { useApi, useApiMutation } from "@/lib/query"
import { Answer } from "@/ui/answer"
import { Button } from "@/ui/button"
import { ConfirmDialog } from "@/ui/dialog"
import { Input, Select } from "@/ui/field"
import { filterBar } from "@/ui/filter-bar"
import { PageHeader } from "@/ui/page-header"
import { Rows } from "@/ui/section"
import { ErrorState, NotOpen, SkeletonRows } from "@/ui/state"
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

type Status = "Failed" | "Finished" | "In progress" | "Waiting"

/** One line of the table: a run, a job a worker is on, or one still waiting. */
type JobLine = {
  id: string
  name: string
  status: Status
  started: string | null
  took: number | null
  result: string
  retry?: Job
  retryNote?: boolean
}

const STATUS_TONE: Record<Status, string> = {
  Failed: "text-critical",
  Finished: "text-positive",
  "In progress": "text-accent",
  Waiting: "text-fg-muted",
}

type Show = "all" | "failed" | "active" | "finished"
type View = "runs" | "names"

export function Jobs() {
  const { me } = useAuth()
  const allowed = can(me?.role).admin
  const [params, setParams] = useSearchParams()
  const only = params.get("only")
  const show: Show =
    params.get("show") === "failed" ? "failed" : only === "active" || only === "finished" ? only : "all"
  const [view, setView] = useState<View>("runs")
  const [search, setSearch] = useState("")
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

  // Failed runs first (the list of failures can reach further back than the
  // last hundred runs), then what is going on now, then everything that ran.
  const lines = useMemo<JobLine[]>(() => {
    if (!data) return []
    const seen = new Set<string>()
    const out: JobLine[] = []
    const run = (j: Job): JobLine => ({
      id: j.id,
      name: j.name,
      status: j.success ? "Finished" : "Failed",
      started: j.started,
      took: j.duration_s,
      result: j.success ? j.result : j.result || "No reason was recorded.",
      retry: !j.success && j.retry_safe ? j : undefined,
      retryNote: !j.success && !j.retry_safe,
    })
    for (const j of failedQ.data?.jobs ?? []) {
      seen.add(j.id)
      out.push(run(j))
    }
    for (const r of data.running ?? []) {
      out.push({
        id: `run-${r.id}`,
        name: r.name,
        status: "In progress",
        started: r.started ?? null,
        took: r.running_s ?? null,
        result: "",
      })
    }
    for (const q of data.queued) {
      out.push({ id: `wait-${q.id}`, name: q.name, status: "Waiting", started: q.locked, took: null, result: "" })
    }
    for (const j of data.jobs) if (!seen.has(j.id)) out.push(run(j))
    return out
  }, [data, failedQ.data])

  if (!allowed)
    return (
      <div className="page py-8">
        <NotOpen message="Only the super admin sees the job queue." />
      </div>
    )

  const lastDone = (data?.jobs ?? []).find((j) => j.stopped)?.stopped ?? null
  // The scheduled jobs run every few minutes, so three hours of silence means
  // the worker has stopped, not that there was nothing to do.
  const quiet = !lastDone || Date.now() - new Date(lastDone).getTime() > 3 * 3_600_000
  const running = data?.running ?? []
  const waiting = data?.queued ?? []

  const needle = search.trim().toLowerCase()
  const shownLines = lines.filter(
    (l) =>
      (show === "all" ||
        (show === "failed" && l.status === "Failed") ||
        (show === "active" && (l.status === "In progress" || l.status === "Waiting")) ||
        (show === "finished" && l.status === "Finished")) &&
      (!needle || l.name.toLowerCase().includes(needle))
  )
  const shownGroups = groups.filter((g) => !needle || g.name.toLowerCase().includes(needle))
  const narrowed = show !== "all" || Boolean(needle)
  function clear() {
    setSearch("")
    setParams(new URLSearchParams(), { replace: true })
  }
  function setShow(next: Show) {
    setParams(
      next === "all" ? new URLSearchParams() : new URLSearchParams(next === "failed" ? { show: "failed" } : { only: next }),
      { replace: true }
    )
  }

  const lineCols: Column<JobLine>[] = [
    { key: "name", header: "Job", exportValue: (l) => l.name, cell: (l) => <span className="font-medium">{l.name}</span> },
    {
      key: "status",
      header: "Status",
      exportValue: (l) => l.status,
      cell: (l) => <span className={cn("font-medium", STATUS_TONE[l.status])}>{l.status}</span>,
    },
    {
      key: "started",
      header: "Started",
      className: "whitespace-nowrap",
      exportValue: (l) => (l.started ? when(l.started) : l.status === "Waiting" ? "Queued" : ""),
      cell: (l) => (l.started ? when(l.started) : l.status === "Waiting" ? "Queued" : null),
    },
    {
      key: "took",
      header: "Took",
      align: "right",
      exportValue: (l) => (l.took == null ? "" : duration(l.took)),
      cell: (l) => (l.took == null ? null : duration(l.took)),
    },
    {
      key: "result",
      header: "What it said",
      empty: "Nothing to report",
      exportValue: (l) => l.result,
      cell: (l) => (l.result ? <span className="break-words text-fg-muted">{l.result}</span> : null),
    },
    {
      key: "act",
      header: <span className="sr-only">Retry</span>,
      label: "Retry",
      cell: (l) =>
        l.retry ? (
          <Button kind="default" size="sm" onClick={() => setRetrying(l.retry ?? null)}>
            <RotateCw aria-hidden /> Retry job
          </Button>
        ) : l.retryNote ? (
          <Meta className="max-w-[16rem]">Not safe to repeat. Run it from its own page.</Meta>
        ) : null,
    },
  ]

  const nameCols: Column<Group>[] = [
    { key: "name", header: "Job", exportValue: (g) => g.name, cell: (g) => <span className="font-medium">{g.name}</span> },
    { key: "runs", header: "Runs", align: "right", exportValue: (g) => g.runs, cell: (g) => count(g.runs) },
    {
      key: "failed",
      header: "Failed",
      align: "right",
      empty: "None",
      exportValue: (g) => g.failed,
      cell: (g) => (g.failed > 0 ? <span className="text-critical">{count(g.failed)}</span> : null),
    },
    { key: "last", header: "Last run", exportValue: (g) => (g.last ? when(g.last) : ""), cell: (g) => (g.last ? when(g.last) : null) },
    {
      key: "avg",
      header: "Usually takes",
      align: "right",
      exportValue: (g) => (g.avg == null ? "" : duration(g.avg)),
      cell: (g) => (g.avg == null ? null : duration(g.avg)),
    },
  ]

  const emptyTable = narrowed
    ? {
        icon: ListChecks,
        title: "No job matches",
        message: "Nothing fits the search or the choice above.",
        action: (
          <Button kind="default" onClick={clear}>
            Show every job
          </Button>
        ),
      }
    : { title: "No jobs have run yet", message: "Jobs appear here once they run." }

  return (
    <div className="page space-y-6">
      <PageHeader title="Jobs" sub="Harvests, the Scopus sync, backups and imports, and whether the worker is alive." />

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
          <div className="space-y-3">
            <Answer
              items={[
                { value: data.failed_count, label: "Failed jobs", tone: "critical", zero: "Nothing has failed" },
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
          </div>

          <div className={filterBar} role="search">
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by job name"
              aria-label="Search the jobs"
              className="w-full min-w-0 sm:w-80"
            />
            <Select
              aria-label="Show"
              value={show}
              onChange={(e) => setShow(e.target.value as Show)}
              disabled={view === "names"}
              className="w-auto max-sm:w-full"
            >
              <option value="all">Every run</option>
              <option value="failed">Failed ({count(data.failed_count)})</option>
              <option value="active">In progress and waiting</option>
              <option value="finished">Finished</option>
            </Select>
            <Select aria-label="View" value={view} onChange={(e) => setView(e.target.value as View)} className="w-auto max-sm:w-full">
              <option value="runs">One line per run</option>
              <option value="names">One line per job</option>
            </Select>
            {narrowed && (
              <Button kind="quiet" onClick={clear}>
                Clear filters
              </Button>
            )}
          </div>

          {view === "names" ? (
            <Table
              rows={shownGroups}
              columns={nameCols}
              getKey={(g) => g.name}
              caption="Jobs, one line each"
              maxHeight="none"
              tools={{ id: "jobs-by-name", title: "Jobs by name" }}
              empty={emptyTable}
            />
          ) : (
            <Table
              rows={shownLines}
              columns={lineCols}
              getKey={(l) => l.id}
              caption="Jobs, failed ones first"
              maxHeight="none"
              tools={{ id: "jobs", title: "Jobs" }}
              empty={emptyTable}
            />
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
