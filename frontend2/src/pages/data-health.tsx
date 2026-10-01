import { useState } from "react"
import { Link, useSearchParams } from "react-router-dom"
import { CircleCheck, Download, RefreshCw, Wrench } from "lucide-react"

import { api } from "@/lib/api"
import { cn } from "@/lib/cn"
import { useApi } from "@/lib/query"
import { queryClient } from "@/lib/query"
import { Answer } from "@/ui/answer"
import { Button } from "@/ui/button"
import { ConfirmDialog } from "@/ui/dialog"
import { PageHeader } from "@/ui/page-header"
import { Details, Rows, Section } from "@/ui/section"
import { Callout, ErrorState, SkeletonRows } from "@/ui/state"
import { Table, type Column } from "@/ui/table"
import { Meta } from "@/ui/text"
import { toast } from "@/ui/toast"
import { Ago } from "@/ui/when"

import { count, plural } from "./admin-b-parts"

/**
 * Data health: does the record contradict itself, and is there a recent backup?
 *
 * Super admin only (GET /api/admin/data-health). The audit runs nightly on the
 * job queue; "Check now" runs it inside the request, which takes a second or
 * two on the college's data. Fixes are offered only where the right answer is
 * unambiguous, each one is confirmed with how many rows it will change, and
 * each is written to the audit log.
 *
 * The answer is four figures: errors, warnings, notes, and how old the last
 * backup is. Only checks that found something are listed; the clean ones are
 * one line behind "Show the checks that found nothing".
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
const WORD: Record<Finding["severity"], string> = { error: "Error", warning: "Warning", info: "Note" }
const TONE: Record<Finding["severity"], string> = {
  error: "text-critical",
  warning: "text-caution",
  info: "text-fg-muted",
}
const RANK = { error: 0, warning: 1, info: 2 } as const

/** Where the fix for a finding is worked, when it is not a one-button fix. */
const ELSEWHERE: Record<string, { to: string; label: string }> = {
  paid_without_ledger: { to: "/data/fixes?kind=amount", label: "Fix imported claims" },
  ledger_amount_mismatch: { to: "/ledger", label: "Open the ledger checks" },
  ledger_on_unpaid_claim: { to: "/ledger", label: "Open the ledger checks" },
  ledger_unlinked_person: { to: "/ledger", label: "Open the ledger" },
  claim_impossible_values: { to: "/data/fixes", label: "Fix imported claims" },
  pub_missing_title_year: { to: "/data/record", label: "Open record quality" },
  pub_placeholder_title: { to: "/data/record", label: "Open record quality" },
  pub_impossible_year: { to: "/data/record", label: "Open record quality" },
  pub_no_authors: { to: "/people/matches", label: "Open author matches" },
  pub_duplicate_doi: { to: "/data/record", label: "Open record quality" },
  pub_duplicate_eid: { to: "/data/record", label: "Open record quality" },
  pub_duplicate_on_record: { to: "/data/record", label: "Open record quality" },
  paper_count_disagrees: { to: "/faculty", label: "Open Faculty" },
  dup_biometric_id: { to: "/faculty", label: "Open Faculty" },
}

const mb = (n: number) =>
  n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / (1024 * 1024)).toFixed(1)} MB`
const when = (iso: string) => new Date(iso).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })

/** "1 day", "5 hours": how old a moment is, for the backup figure. */
function age(iso: string): { text: string; days: number } {
  const ms = Date.now() - new Date(iso).getTime()
  const hours = Math.floor(ms / 3_600_000)
  const days = Math.floor(hours / 24)
  return { text: days >= 1 ? plural(days, "day") : plural(Math.max(0, hours), "hour"), days }
}

export function DataHealth() {
  const { data, isLoading, error, refetch } = useApi<Health>(KEY, "/api/admin/data-health")
  const [running, setRunning] = useState(false)
  const [fixing, setFixing] = useState<string | null>(null)
  const [asking, setAsking] = useState<{ key: string; label: string; n: number } | null>(null)
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
      toast.ok("Checked again")
    } catch (e) {
      toast.fail(e, "The check did not run")
    } finally {
      setRunning(false)
    }
  }

  async function fix(key: string, label: string) {
    setFixing(key)
    try {
      const out = await api<{ changed: number }>(`/api/admin/data-health/fix/${key}`, { method: "POST" })
      toast.ok(`${label}. ${plural(out.changed, "row")} changed`)
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
          if (job.status === "failed") toast.fail(null, "The backup failed. See the job log under Jobs.")
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

  const report = data?.report
  const findings = report?.findings ?? []
  const problems = findings
    .filter((f) => f.count > 0)
    .sort((a, b) => RANK[a.severity] - RANK[b.severity] || b.count - a.count)
  const clean = findings.filter((f) => f.count === 0)
  const backups = [...(data?.backups ?? [])].sort((a, b) => b.created_at.localeCompare(a.created_at))
  const newest = backups[0]
  const newestAge = newest ? age(newest.created_at) : null

  return (
    <div className="page space-y-10">
      <PageHeader
        title="Data health"
        sub="Does the record contradict itself, and is there a recent backup?"
        spot="spot-audit"
        action={
          <Button kind="primary" onClick={() => void runNow()} disabled={running}>
            <RefreshCw aria-hidden className={cn(running && "animate-spin")} />
            {running ? "Checking" : "Check now"}
          </Button>
        }
      />

      <ConfirmDialog
        open={asking !== null}
        onOpenChange={(o) => !o && setAsking(null)}
        danger
        title={asking ? `${asking.label}?` : ""}
        description={
          asking
            ? `This changes ${plural(asking.n, "stored record")}. Each change is written to the audit log with your name.`
            : ""
        }
        confirmLabel={asking?.label ?? "Run fix"}
        onConfirm={async () => {
          if (asking) await fix(asking.key, asking.label)
        }}
      />

      {isLoading ? (
        <SkeletonRows rows={8} />
      ) : error ? (
        <ErrorState
          title="Could not load the data health report"
          message="The server did not answer. Nothing has been changed. Try again."
          onRetry={() => void refetch()}
        />
      ) : (
        <>
          <section aria-label="The answer" className="space-y-3">
            <Answer
              items={[
                {
                  value: report ? report.problems.error : null,
                  label: "Errors to fix",
                  to: "?show=error",
                  tone: "critical",
                  zero: "No errors",
                },
                {
                  value: report ? report.problems.warning : null,
                  label: "Warnings to look at",
                  to: "?show=warning",
                  tone: "caution",
                  zero: "No warnings",
                },
                { value: report ? report.problems.info : null, label: "Notes", to: "?show=info", zero: "No notes" },
                {
                  value: newestAge ? newestAge.text : "None yet",
                  label: newestAge ? "Since the last backup" : "No backup is stored",
                  to: "#backups",
                  tone: !newestAge || newestAge.days >= 2 ? "critical" : "positive",
                },
              ]}
            />
            <p className="text-sm text-fg-muted">
              {report ? (
                <>
                  Checked <Ago iso={report.ran_at} /> in {report.seconds} seconds. It runs every night.
                </>
              ) : (
                "Not checked yet. It runs every night, or press Check now."
              )}
            </p>
          </section>

          <ShowFilter
            problems={problems}
            fixes={data?.fixes ?? {}}
            fixing={fixing}
            onFix={(f) => f.fix && setAsking({ key: f.fix, label: data?.fixes[f.fix] ?? f.fix, n: f.count })}
          />

          {report && clean.length > 0 && (
            <Details label="the checks that found nothing" count={clean.length}>
              <Rows>
                {clean.map((f) => (
                  <li key={f.key} className="flex items-center gap-2 py-2 text-sm text-fg-muted">
                    <CircleCheck aria-hidden className="size-4 shrink-0 text-positive" />
                    <span className="flex-1">{f.title}</span>
                    <span>Nothing found</span>
                  </li>
                ))}
              </Rows>
            </Details>
          )}

          <Section
            id="backups"
            title="Backups"
            sub="A backup is every record in one .json.gz file. The newest four are kept here, and one is made automatically each week."
            className="space-y-4"
            action={
              <Button kind="default" size="sm" onClick={() => void backupNow()} disabled={backingUp}>
                <RefreshCw aria-hidden className={cn(backingUp && "animate-spin")} />
                {backingUp ? "Making a backup" : "Make a backup now"}
              </Button>
            }
          >
            <Callout tone="info" title="Keep a copy off this server">
              The free database is deleted on 23 October 2026. Download the newest backup and keep it somewhere
              else. DEPLOY.md explains how to restore it into a new database.
            </Callout>
            <BackupTable backups={backups} />
          </Section>

          <Details label="other tools">
            <div className="flex flex-wrap items-center gap-3">
              <Button kind="default" onClick={() => void runBadges()} disabled={badging}>
                {badging ? "Awarding badges" : "Award badges now"}
              </Button>
              <Meta>Badges are awarded every hour. Use this to bring them up to date at once.</Meta>
            </div>
          </Details>
        </>
      )}
    </div>
  )
}

function ShowFilter({
  problems,
  fixes,
  fixing,
  onFix,
}: {
  problems: Finding[]
  fixes: Record<string, string>
  fixing: string | null
  onFix: (f: Finding) => void
}) {
  const [params] = useSearchParams()
  const show = params.get("show")
  const shown = show === "error" || show === "warning" || show === "info" ? problems.filter((f) => f.severity === show) : problems
  const groups = new Map<string, Finding[]>()
  for (const f of shown) groups.set(f.group, [...(groups.get(f.group) ?? []), f])
  if (problems.length === 0) {
    return (
      <p className="rounded-panel bg-sunken px-4 py-8 text-center text-sm text-fg-muted">
        Every check found nothing. The record agrees with itself.
      </p>
    )
  }
  return (
    <div className="space-y-10">
      {show && (
        <p className="text-sm text-fg-muted">
          Showing {WORD[show as Finding["severity"]]?.toLowerCase()}s only.{" "}
          <Link to="/data/health" className="underline underline-offset-2">
            Show all {count(problems.length)} checks
          </Link>
        </p>
      )}
      {[...groups.entries()].map(([group, findings]) => (
        <Section key={group} title={group}>
          <Rows>
            {findings.map((f) => (
              <FindingRow
                key={f.key}
                f={f}
                fixLabel={f.fix ? fixes[f.fix] : undefined}
                busy={fixing === f.fix}
                onFix={() => onFix(f)}
              />
            ))}
          </Rows>
        </Section>
      ))}
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
  const elsewhere = ELSEWHERE[f.key]
  return (
    <li className="py-3">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1 basis-64">
          <p className="flex flex-wrap items-baseline gap-x-2">
            <span className="font-medium">{f.title}</span>
            <span className={cn("text-xs font-medium", TONE[f.severity])}>{WORD[f.severity]}</span>
          </p>
          <p className="mt-0.5 text-sm text-fg-muted">{f.help}</p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-3">
          <span className={cn("figure text-2xl tabular", TONE[f.severity])}>{count(f.count)}</span>
          {fixLabel ? (
            <Button kind="default" onClick={onFix} disabled={busy}>
              <Wrench aria-hidden />
              {busy ? "Working" : fixLabel}
            </Button>
          ) : elsewhere ? (
            <Button kind="default" asChild>
              <Link to={elsewhere.to}>{elsewhere.label}</Link>
            </Button>
          ) : null}
        </div>
      </div>
      {f.rows.length > 0 && (
        <Details label="the rows" count={f.count} className="mt-1">
          <ul className="space-y-1 text-sm">
            {f.rows.map((r) => (
              <li key={r.id} className="truncate">
                {r.href ? (
                  <Link className="underline-offset-2 hover:underline" to={r.href}>
                    {r.label}
                  </Link>
                ) : (
                  r.label
                )}
              </li>
            ))}
            {f.count > f.rows.length && (
              <Meta className="block">
                Showing {count(f.rows.length)} of {count(f.count)}. Fix these and check again to see the rest.
              </Meta>
            )}
          </ul>
        </Details>
      )}
    </li>
  )
}

function BackupTable({ backups }: { backups: StoredBackup[] }) {
  const cols: Column<StoredBackup>[] = [
    { key: "name", header: "Backup", cell: (b) => <span className="break-all">{b.name.replace("backups/", "")}</span> },
    { key: "when", header: "Made", cell: (b) => when(b.created_at) },
    { key: "size", header: "Size", align: "right", cell: (b) => mb(b.bytes) },
    {
      key: "get",
      header: "Download",
      label: "Download",
      cell: (b) => (
        <Button asChild size="sm" kind="default">
          <a href={`/api/admin/backups/download?name=${encodeURIComponent(b.name)}`} download>
            <Download aria-hidden /> Download
          </a>
        </Button>
      ),
    },
  ]
  return (
    <Table
      rows={backups}
      columns={cols}
      getKey={(b) => b.name}
      caption="Stored backups"
      empty={{
        title: "No backup is stored",
        message: "Make one now and download it, so a copy of every record exists off this server.",
      }}
    />
  )
}
