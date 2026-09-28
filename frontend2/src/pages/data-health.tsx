import { useState } from "react"
import { Link } from "react-router-dom"
import { CircleCheck, Download, RefreshCw, Wrench } from "lucide-react"

import { api } from "@/lib/api"
import { cn } from "@/lib/cn"
import { useApi } from "@/lib/query"
import { queryClient } from "@/lib/query"
import { Button } from "@/ui/button"
import { Callout, ErrorState, SkeletonRows } from "@/ui/state"
import { Meta, PageTitle, SectionTitle, Sub } from "@/ui/text"
import { toast } from "@/ui/toast"

/**
 * Data health: what in the database contradicts itself, and the backups.
 *
 * Super admin only (GET /api/admin/data-health). The audit runs nightly on the
 * job queue; "Run now" runs it inside the request, which takes a second or
 * two on the college's data. Fixes are offered only where the right answer is
 * unambiguous, and each one is written to the audit log.
 */

type Row = { id: string; label: string; href: string }
type Finding = {
  key: string
  group: string
  title: string
  severity: "error" | "warning" | "info"
  count: number
  rows: Row[]
  fix: string | null
  help: string
}
type Report = {
  ran_at: string
  seconds: number
  problems: { error: number; warning: number; info: number }
  findings: Finding[]
}
type StoredBackup = { name: string; bytes: number; created_at: string }
type Health = { report: Report | null; fixes: Record<string, string>; backups: StoredBackup[] }
type Job = { status: string; success?: boolean | null; result?: unknown }

const KEY = ["admin", "data-health"]
const SEVERITY: Record<Finding["severity"], string> = {
  error: "bg-critical-wash text-critical",
  warning: "bg-caution-wash text-caution",
  info: "bg-sunken text-fg-muted",
}
const mb = (n: number) => `${(n / (1024 * 1024)).toFixed(1)} MB`
const when = (iso: string) => new Date(iso).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })

export function DataHealth() {
  const { data, isLoading, error, refetch } = useApi<Health>(KEY, "/api/admin/data-health")
  const [running, setRunning] = useState(false)
  const [fixing, setFixing] = useState<string | null>(null)
  const [backingUp, setBackingUp] = useState(false)
  const [badging, setBadging] = useState(false)

  /** The hourly badge job, run now. Safe to repeat. */
  async function runBadges() {
    setBadging(true)
    try {
      await api("/api/admin/badges/run", { method: "POST" })
      toast.ok("Badges brought up to date")
    } catch (e) {
      toast.fail(e, "The badge job did not run")
    } finally {
      setBadging(false)
    }
  }

  async function runNow() {
    setRunning(true)
    try {
      const fresh = await api<Health>("/api/admin/data-health?fresh=true")
      queryClient.setQueryData(KEY, fresh)
    } catch (e) {
      toast.fail(e, "The audit did not run")
    } finally {
      setRunning(false)
    }
  }

  async function fix(key: string, label: string) {
    if (!window.confirm(`${label}? This changes data and is recorded in the audit log.`)) return
    setFixing(key)
    try {
      const out = await api<{ changed: number }>(`/api/admin/data-health/fix/${key}`, { method: "POST" })
      toast.ok(`${label}: ${out.changed} row${out.changed === 1 ? "" : "s"} changed`)
      await refetch()
    } catch (e) {
      toast.fail(e, "The fix did not run")
    } finally {
      setFixing(null)
    }
  }

  async function backupNow() {
    setBackingUp(true)
    try {
      const { job_id } = await api<{ job_id: string }>("/api/admin/backups", { method: "POST" })
      toast.ok("Backup queued. It takes a few minutes; this page updates when it is done.")
      for (let i = 0; i < 200; i++) {
        await new Promise((r) => setTimeout(r, 3000))
        const job = await api<Job>(`/api/admin/jobs/${job_id}`)
        if (job.status === "done" || job.status === "failed") {
          if (job.status === "failed") toast.fail(null, "The backup failed; see the job log")
          break
        }
      }
      await refetch()
    } catch (e) {
      toast.fail(e, "The backup could not be queued")
    } finally {
      setBackingUp(false)
    }
  }

  if (isLoading) return <Frame><SkeletonRows rows={8} /></Frame>
  if (error) return <Frame><ErrorState onRetry={() => void refetch()} /></Frame>

  const report = data?.report
  const groups = new Map<string, Finding[]>()
  for (const f of report?.findings ?? []) groups.set(f.group, [...(groups.get(f.group) ?? []), f])

  return (
    <Frame>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <PageTitle>Data health</PageTitle>
          <Sub>
            {report
              ? `Checked ${when(report.ran_at)} in ${report.seconds}s. Runs every night.`
              : "Not checked yet. It runs every night, or now."}
          </Sub>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button kind="default" onClick={() => void runBadges()} disabled={badging}>
            {badging ? "Awarding…" : "Run badges now"}
          </Button>
          <Button kind="primary" onClick={() => void runNow()} disabled={running}>
            <RefreshCw className={cn(running && "animate-spin")} />
            {running ? "Checking" : "Run now"}
          </Button>
        </div>
      </div>

      {report ? (
        <div className="grid grid-cols-3 gap-3" aria-label="Summary">
          <Tally label="Errors" n={report.problems.error} tone="text-critical" />
          <Tally label="Warnings" n={report.problems.warning} tone="text-caution" />
          <Tally label="Notes" n={report.problems.info} tone="text-fg-muted" />
        </div>
      ) : null}

      {[...groups.entries()].map(([group, findings]) => (
        <section key={group} className="space-y-2">
          <SectionTitle>{group}</SectionTitle>
          <ul className="panel divide-y divide-line">
            {findings.map((f) => (
              <FindingRow
                key={f.key}
                f={f}
                fixLabel={f.fix ? data?.fixes[f.fix] : undefined}
                busy={fixing === f.fix}
                onFix={() => f.fix && void fix(f.fix, data?.fixes[f.fix] ?? f.fix)}
              />
            ))}
          </ul>
        </section>
      ))}

      <section className="space-y-2">
        <SectionTitle>Backups</SectionTitle>
        <Callout tone="info" title="Keep a copy off this server">
          The free database is deleted on 23 October 2026. A backup is every record as one
          .json.gz file; DEPLOY.md explains how to restore it into a new database. The newest four
          are kept here, one made automatically each week.
        </Callout>
        <div className="panel divide-y divide-line">
          {(data?.backups ?? []).length === 0 ? (
            <p className="px-4 py-3 text-sm text-fg-muted">No backups stored yet.</p>
          ) : (
            data!.backups.map((b) => (
              <div key={b.name} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{b.name.replace("backups/", "")}</p>
                  <Meta>{when(b.created_at)} · {mb(b.bytes)}</Meta>
                </div>
                <Button asChild size="sm">
                  <a href={`/api/admin/backups/download?name=${encodeURIComponent(b.name)}`} download>
                    <Download /> Download
                  </a>
                </Button>
              </div>
            ))
          )}
        </div>
        <Button onClick={() => void backupNow()} disabled={backingUp}>
          <RefreshCw className={cn(backingUp && "animate-spin")} />
          {backingUp ? "Making a backup" : "Make a backup now"}
        </Button>
      </section>
    </Frame>
  )
}

function Frame({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto w-full max-w-4xl space-y-6 px-4 py-6 sm:px-6">{children}</div>
}

function Tally({ label, n, tone }: { label: string; n: number; tone: string }) {
  return (
    <div className="panel px-4 py-3">
      <p className={cn("text-2xl font-semibold tabular-nums", n ? tone : "text-fg-muted")}>{n}</p>
      <Meta>{label}</Meta>
    </div>
  )
}

function FindingRow({
  f,
  fixLabel,
  busy,
  onFix,
}: {
  f: Finding
  fixLabel?: string
  busy: boolean
  onFix: () => void
}) {
  const [open, setOpen] = useState(false)
  const clean = f.count === 0
  return (
    <li className="px-4 py-3">
      <div className="flex items-start gap-3">
        {clean ? (
          <CircleCheck className="mt-0.5 size-4 shrink-0 text-positive" aria-label="No problems" />
        ) : (
          <span
            className={cn("mt-0.5 shrink-0 rounded-sm px-1.5 text-xs font-semibold tabular-nums", SEVERITY[f.severity])}
          >
            {f.count.toLocaleString("en-IN")}
          </span>
        )}
        <div className="min-w-0 flex-1">
          <button
            type="button"
            className={cn("text-left text-sm", clean ? "text-fg-muted" : "font-medium")}
            onClick={() => setOpen((o) => !o)}
            disabled={clean}
            aria-expanded={open}
          >
            {f.title}
          </button>
          {open && !clean ? (
            <div className="mt-2 space-y-2">
              <p className="text-sm text-fg-muted">{f.help}</p>
              <ul className="space-y-1 text-sm">
                {f.rows.map((r) => (
                  <li key={r.id} className="truncate">
                    {r.href ? <Link className="underline-offset-2 hover:underline" to={r.href}>{r.label}</Link> : r.label}
                  </li>
                ))}
                {f.count > f.rows.length ? <Meta>and {f.count - f.rows.length} more</Meta> : null}
              </ul>
            </div>
          ) : null}
        </div>
        {fixLabel && !clean ? (
          <Button size="sm" onClick={onFix} disabled={busy}>
            <Wrench /> {busy ? "Fixing" : "Fix"}
          </Button>
        ) : null}
      </div>
    </li>
  )
}
