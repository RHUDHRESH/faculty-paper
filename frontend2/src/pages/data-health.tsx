import { useState } from "react"
import { Link, useSearchParams } from "react-router-dom"
import { CircleCheck, Download, RefreshCw, Wrench } from "lucide-react"

import { useAuth } from "@/app/auth"
import { api } from "@/lib/api"
import { cn } from "@/lib/cn"
import { useApi } from "@/lib/query"
import { queryClient } from "@/lib/query"
import { Answer } from "@/ui/answer"
import { Button } from "@/ui/button"
import { ConfirmDialog } from "@/ui/dialog"
import { Input, Select } from "@/ui/field"
import { filterBar } from "@/ui/filter-bar"
import { MoreMenu } from "@/pages/more-menu"
import { PageHeader } from "@/ui/page-header"
import { Details, Rows, Section } from "@/ui/section"
import { Callout, ErrorState, NotOpen, SkeletonRows } from "@/ui/state"
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
  const { me, loading: signingIn } = useAuth()
  // `_super` in api/data_health.py: a super admin only. No one else asks.
  const isSuper = me?.role === "SUPER_ADMIN"
  const { data, isLoading, error, refetch } = useApi<Health>(KEY, "/api/admin/data-health", { enabled: isSuper })
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
      toast.ok("Backup queued. This page updates when it is done.")
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

  if (signingIn) {
    return (
      <div className="page space-y-10">
        <SkeletonRows rows={8} />
      </div>
    )
  }

  if (!isSuper || error?.status === 403) {
    return (
      <div className="page py-8">
        <NotOpen message="Ask the research office if you think it should be yours." />
      </div>
    )
  }

  return (
    <div className="page space-y-6">
      <PageHeader
        title="Data health"
        sub="Contradictions in the record, and the newest backup."
        action={
          <>
            <MoreMenu
              items={[
                { label: backingUp ? "Making a backup" : "Make a backup now", onSelect: () => void backupNow(), disabled: backingUp },
                { label: badging ? "Awarding badges" : "Award badges now", onSelect: () => void runBadges(), disabled: badging },
              ]}
            />
            <Button kind="primary" onClick={() => void runNow()} disabled={running}>
              <RefreshCw aria-hidden className={cn(running && "animate-spin")} />
              {running ? "Checking" : "Check now"}
            </Button>
          </>
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
          message="The server did not answer."
          onRetry={() => void refetch()}
        />
      ) : (
        <>
          <div className="space-y-3">
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
                  Checked <Ago iso={report.ran_at} />. Runs every night.
                </>
              ) : (
                "Not checked yet. Runs every night."
              )}
            </p>
          </div>

          <FindingsTable
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

          <Section id="backups" title="Backups" className="space-y-4">
            <Callout tone="info" title="Keep a copy off this server">
              The free database is deleted on 23 October 2026. Download the newest backup and keep it elsewhere.
            </Callout>
            <BackupTable backups={backups} />
            <Details label="how backups work">
              <Meta className="block max-w-prose">
                A backup is every record in one .json.gz file. The newest four are kept here, and one is made each
                week. DEPLOY.md explains how to restore one into a new database.
              </Meta>
            </Details>
          </Section>
        </>
      )}
    </div>
  )
}

type Level = "all" | Finding["severity"]

function FindingsTable({
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
  const [params, setParams] = useSearchParams()
  const raw = params.get("show")
  const level: Level = raw === "error" || raw === "warning" || raw === "info" ? raw : "all"
  const [search, setSearch] = useState("")
  const [group, setGroup] = useState("")
  const groups = [...new Set(problems.map((f) => f.group))]
  const needle = search.trim().toLowerCase()
  const shown = problems.filter(
    (f) =>
      (level === "all" || f.severity === level) &&
      (!group || f.group === group) &&
      (!needle || f.title.toLowerCase().includes(needle))
  )
  const narrowed = level !== "all" || Boolean(group) || Boolean(needle)
  function clear() {
    setSearch("")
    setGroup("")
    setParams(new URLSearchParams(), { replace: true })
  }

  const columns: Column<Finding>[] = [
    {
      key: "title",
      header: "What was found",
      exportValue: (f) => f.title,
      cell: (f) => (
        <div className="min-w-0">
          <p className="font-medium">{f.title}</p>
          <Details
            label={f.rows.length > 0 ? "the rows" : "what this means"}
            count={f.rows.length > 0 ? f.count : undefined}
            className="mt-1"
          >
            <p className="mb-2 max-w-prose text-sm text-fg-muted">{f.help}</p>
            {f.rows.length > 0 && (
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
            )}
          </Details>
        </div>
      ),
    },
    { key: "group", header: "Part of the record", exportValue: (f) => f.group, cell: (f) => f.group },
    {
      key: "level",
      header: "How serious",
      exportValue: (f) => WORD[f.severity],
      cell: (f) => <span className={cn("font-medium", TONE[f.severity])}>{WORD[f.severity]}</span>,
    },
    {
      key: "count",
      header: "Found",
      align: "right",
      exportKind: "number",
      exportValue: (f) => f.count,
      cell: (f) => <span className={TONE[f.severity]}>{count(f.count)}</span>,
    },
    {
      key: "act",
      header: <span className="sr-only">Fix</span>,
      label: "Fix",
      cell: (f) => {
        const fixLabel = f.fix ? fixes[f.fix] : undefined
        const elsewhere = ELSEWHERE[f.key]
        return fixLabel ? (
          <Button kind="default" size="sm" onClick={() => onFix(f)} disabled={fixing === f.fix}>
            <Wrench aria-hidden />
            {fixing === f.fix ? "Working" : fixLabel}
          </Button>
        ) : elsewhere ? (
          <Button kind="default" size="sm" asChild>
            <Link to={elsewhere.to}>{elsewhere.label}</Link>
          </Button>
        ) : null
      },
    },
  ]

  return (
    <div className="space-y-4">
      {problems.length > 0 && (
        <div className={filterBar} role="search">
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search the checks"
            aria-label="Search the checks"
            className="w-full min-w-0 sm:w-80"
          />
          <Select
            aria-label="How serious"
            value={level}
            onChange={(e) => setParams(e.target.value === "all" ? new URLSearchParams() : new URLSearchParams({ show: e.target.value }), { replace: true })}
            className="w-auto max-sm:w-full"
          >
            <option value="all">Every level</option>
            <option value="error">Errors</option>
            <option value="warning">Warnings</option>
            <option value="info">Notes</option>
          </Select>
          <Select aria-label="Part of the record" value={group} onChange={(e) => setGroup(e.target.value)} className="w-auto max-sm:w-full">
            <option value="">Every part of the record</option>
            {groups.map((g) => (
              <option key={g} value={g}>
                {g}
              </option>
            ))}
          </Select>
          {narrowed && (
            <Button kind="quiet" onClick={clear}>
              Clear filters
            </Button>
          )}
        </div>
      )}
      <Table
        rows={shown}
        columns={columns}
        getKey={(f) => f.key}
        maxHeight="none"
        caption="Checks that found something"
        tools={{ id: "data-health", title: "Data health" }}
        empty={
          problems.length === 0
            ? { icon: CircleCheck, title: "Every check found nothing", message: "The record does not contradict itself." }
            : {
                icon: CircleCheck,
                title: "No check matches",
                message: "Nothing fits the search or the choices above.",
                action: (
                  <Button kind="default" onClick={clear}>
                    Clear filters
                  </Button>
                ),
              }
        }
      />
    </div>
  )
}

function BackupTable({ backups }: { backups: StoredBackup[] }) {
  const cols: Column<StoredBackup>[] = [
    {
      key: "name",
      header: "Backup",
      exportValue: (b) => b.name.replace("backups/", ""),
      cell: (b) => <span className="break-all">{b.name.replace("backups/", "")}</span>,
    },
    { key: "when", header: "Made", exportValue: (b) => when(b.created_at), cell: (b) => when(b.created_at) },
    { key: "size", header: "Size", align: "right", exportValue: (b) => mb(b.bytes), cell: (b) => mb(b.bytes) },
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
      maxHeight="none"
      tools={{ id: "data-health-backups", title: "Stored backups" }}
      empty={{
        title: "No backup is stored",
        message: "Make one now and download it, so a copy of every record exists off this server.",
      }}
    />
  )
}
