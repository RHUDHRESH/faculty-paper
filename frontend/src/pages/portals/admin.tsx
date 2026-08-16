import { type FormEvent, type ReactNode, useEffect, useState } from "react"
import { toast } from "sonner"

import { EmptyState, ErrorState, PageHeader, Section, StatStrip } from "@/components/layout/page"
import { Money } from "@/components/ticket-ui"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Pager } from "@/components/ui/pagination"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { API_BASE, api, apiFetch, ensureCsrf, readJson, SLOW_TIMEOUT_MS } from "@/lib/api"
import { useApiQuery } from "@/lib/queries"
import { cn } from "@/lib/utils"
import { pollJob } from "@/lib/use-job"

// ---------------------------------------------------------------------------
// Shared layout primitives
// ---------------------------------------------------------------------------

function FormPanel({
  children,
  className,
}: {
  children: ReactNode
  className?: string
}) {
  return (
    <div
      className={`surface-card p-5 ${className || ""}`}
    >
      {children}
    </div>
  )
}

function DataTable({
  headers,
  children,
  empty,
}: {
  headers: string[]
  children: ReactNode
  empty?: ReactNode
}) {
  return (
    <div className="surface-card overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[480px] text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/40 text-left">
              {headers.map((h) => (
                <th key={h} className="text-eyebrow whitespace-nowrap px-4 py-2.5">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-border/70">{children}</tbody>
        </table>
      </div>
      {empty}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Helper: multipart upload via ensureCsrf
// ---------------------------------------------------------------------------

async function multipartPost(path: string, fd: FormData): Promise<unknown> {
  const csrfToken = await ensureCsrf()
  const res = await apiFetch(path, {
    method: "POST",
    headers: { "X-CSRFToken": csrfToken },
    body: fd,
    timeoutMs: SLOW_TIMEOUT_MS,
  })
  const data = await readJson<{ detail?: string }>(res)
  if (!res.ok) throw new Error(data?.detail || JSON.stringify(data))
  return data
}

// ---------------------------------------------------------------------------
// Admin overview (index route)
// ---------------------------------------------------------------------------

export function AdminApprovalsPage() {
  const { data: dash, isLoading: loading, isError, refetch } = useApiQuery<{
    by_status?: Record<string, number>
    total_paid?: number
  }>(["dashboard", "admin"], "/api/dashboard")

  const by = dash?.by_status || {}

  return (
    <div className="space-y-6">
      <PageHeader
        title="Admin overview"
        subtitle="Overview · Users · Formula · Imports · Monthly · Audit — manage the system from this hub"
      />
      {loading ? (
        <Skeleton className="h-20 w-full rounded-[var(--radius)]" />
      ) : isError ? (
        <ErrorState
          title="Could not load overview"
          description="The pipeline numbers did not load."
          onRetry={() => refetch()}
        />
      ) : (
        <Section title="Claim pipeline">
          <StatStrip
            items={[
              { label: "Drafts", value: by.DRAFT || 0 },
              // HOD_APPROVED is a stranded legacy status the clearing queue
              // refuses — counting it under "To clear" promised work the
              // button could not do. It has its own bucket.
              { label: "To clear", value: by.SUBMITTED || 0, to: "/admin/clearing" },
              ...(by.HOD_APPROVED
                ? [{ label: "Stranded (legacy)", value: by.HOD_APPROVED, to: "/admin/clearing" }]
                : []),
              {
                label: "With Finance",
                value:
                  (by.CLEARED || 0) +
                  (by.PRINCIPAL_APPROVED || 0) +
                  (by.FINANCE_APPROVED || 0) +
                  (by.RESEARCH_APPROVED || 0),
                to: "/finance",
              },
              { label: "Paid", value: by.PAID || 0, to: "/finance/paid" },
            ]}
          />
          <p className="mt-2 text-sm text-muted-foreground">
            Total paid:{" "}
            <span className="font-semibold text-foreground">
              <Money value={dash?.total_paid || 0} />
            </span>
          </p>
        </Section>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Monthly indexing
// ---------------------------------------------------------------------------

export function AdminMonthlyPage() {
  const [batches, setBatches] = useState<Array<Record<string, unknown>>>([])
  const [name, setName] = useState("Monthly run")
  const [file, setFile] = useState<File | null>(null)
  const [selected, setSelected] = useState<Record<string, unknown> | null>(null)
  const [loading, setLoading] = useState(true)
  const [uploading, setUploading] = useState(false)

  async function refresh() {
    setBatches(await api("/api/monthly"))
  }

  useEffect(() => {
    refresh()
      .catch(() => toast.error("Could not load batches"))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    if (!selected || selected.status !== "RUNNING") return
    const t = setInterval(async () => {
      const d = await api<Record<string, unknown>>(`/api/monthly/${selected.id}`)
      setSelected(d)
      if (d.status !== "RUNNING") {
        toast.success(`Batch "${String(d.name || selected.id)}" finished`)
        refresh()
      }
    }, 2500)
    return () => clearInterval(t)
  }, [selected?.id, selected?.status])

  async function onUpload(e: FormEvent) {
    e.preventDefault()
    if (!file) return
    setUploading(true)
    const tid = toast.loading("Uploading CSV…")
    try {
      const fd = new FormData()
      fd.append("name", name)
      fd.append("file", file)
      const data = await multipartPost("/api/monthly/upload", fd) as Record<string, unknown>
      toast.dismiss(tid)
      toast.success(`Upload complete · ${data.row_count} rows`)
      setFile(null)
      await refresh()
      setSelected(await api(`/api/monthly/${data.id}`))
    } catch (err) {
      toast.dismiss(tid)
      toast.error(err instanceof Error ? err.message : "Upload failed")
    } finally {
      setUploading(false)
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Monthly indexing"
        subtitle="Imports · Upload a CSV, then start enrichment to resolve SNIP and quartile data"
      />
      <Section title="Upload batch">
        <FormPanel>
          <form className="flex flex-wrap items-end gap-3" onSubmit={onUpload}>
            <div className="space-y-1.5">
              <Label htmlFor="batch-name">Batch name</Label>
              <Input
                id="batch-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-48"
              />
            </div>
            <div className="space-y-1.5">
              <Label>CSV file</Label>
              <Input
                type="file"
                accept=".csv"
                onChange={(e) => setFile(e.target.files?.[0] || null)}
                className="max-w-xs"
              />
            </div>
            <Button type="submit" disabled={!file || uploading}>
              {uploading ? "Uploading…" : "Upload"}
            </Button>
          </form>
        </FormPanel>
      </Section>

      <Section title="Batches">
        {loading ? (
          <Skeleton className="h-40 w-full rounded-[var(--radius)]" />
        ) : batches.length === 0 ? (
          <EmptyState
            title="No batches yet"
            description="Upload a CSV above to create your first monthly batch."
          />
        ) : (
          <DataTable headers={["Name", "Status", ""]}>
            {batches.map((b) => (
              <tr key={String(b.id)} className="border-b border-border/50 last:border-0">
                <td className="px-4 py-3 font-medium">{String(b.name)}</td>
                <td className="px-4 py-3">
                  <Badge
                    variant="secondary"
                    className={
                      b.status === "RUNNING"
                        ? "border-warning/20 bg-warning/10 text-warning-foreground"
                        : b.status === "DONE"
                          ? "border-success/20 bg-success/10 text-success"
                          : undefined
                    }
                  >
                    {String(b.status)}
                  </Badge>
                </td>
                <td className="space-x-2 px-4 py-3 text-right">
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={async () => setSelected(await api(`/api/monthly/${b.id}`))}
                  >
                    Open
                  </Button>
                  <Button
                    size="sm"
                    disabled={b.status === "RUNNING"}
                    onClick={async () => {
                      const tid = toast.loading("Starting batch…")
                      try {
                        const started = await api<{ job_id?: string }>(
                          `/api/monthly/${b.id}/start`,
                          { method: "POST", json: {} }
                        )
                        toast.dismiss(tid)
                        toast.success("Batch queued — watching job status")
                        setSelected(await api(`/api/monthly/${b.id}`))
                        if (started.job_id) {
                          const job = await pollJob(started.job_id)
                          if (job.status === "done") toast.success("Monthly batch finished")
                          else if (job.status === "failed") toast.error("Monthly batch failed")
                          setSelected(await api(`/api/monthly/${b.id}`))
                          await refresh()
                        }
                      } catch (err) {
                        toast.dismiss(tid)
                        toast.error(err instanceof Error ? err.message : "Start failed")
                      }
                    }}
                  >
                    Start
                  </Button>
                </td>
              </tr>
            ))}
          </DataTable>
        )}
      </Section>

      {selected ? (
        <Section
          title={`Batch · ${String(selected.name || selected.id)}`}
          actions={
            <a href={`${API_BASE}/api/monthly/${selected.id}/export`}>
              <Button size="sm" variant="outline">
                Export
              </Button>
            </a>
          }
        >
          <FormPanel className="overflow-auto">
            <div className="mb-3">
              <Badge
                variant="secondary"
                className={
                  selected.status === "RUNNING"
                    ? "border-warning/20 bg-warning/10 text-warning-foreground"
                    : selected.status === "DONE"
                      ? "border-success/20 bg-success/10 text-success"
                      : undefined
                }
              >
                {String(selected.status)}
              </Badge>
            </div>
            <table className="w-full min-w-[800px] text-xs">
              <thead>
                <tr className="border-b border-border/60 text-left uppercase text-muted-foreground">
                  {["#", "Title", "Status", "Link", "Journal", "DOI", "SNIP", "Eng"].map((h) => (
                    <th key={h} className="px-2 py-2 font-medium">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {((selected.rows as Array<Record<string, unknown>>) || []).map((r) => (
                  <tr key={String(r.id)} className="border-b border-border/40">
                    <td className="px-2 py-1.5">{String(r.row_number)}</td>
                    <td className="max-w-[200px] truncate px-2 py-1.5">
                      {String(r.paper_title || "")}
                    </td>
                    <td className="px-2 py-1.5">{String(r.index_status || "")}</td>
                    <td className="px-2 py-1.5">{String(r.linkage || "")}</td>
                    <td className="px-2 py-1.5">{String(r.journal || "")}</td>
                    <td className="px-2 py-1.5">{String(r.doi || "")}</td>
                    <td className="px-2 py-1.5">{String(r.snip || "")}</td>
                    <td className="px-2 py-1.5">{String(r.engineering_class || "")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </FormPanel>
        </Section>
      ) : null}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Scimago import
// ---------------------------------------------------------------------------

export function AdminScimagoPage() {
  const [stats, setStats] = useState<{ count: number; years: number[] } | null>(null)
  const [year, setYear] = useState(new Date().getFullYear())
  const [file, setFile] = useState<File | null>(null)
  const [uploading, setUploading] = useState(false)
  const [syncing, setSyncing] = useState(false)

  async function loadStats() {
    return api<{ count: number; years: number[] }>("/api/admin/scimago/stats").then(setStats)
  }

  useEffect(() => {
    loadStats().catch(() => toast.error("Could not load Scimago stats"))
  }, [])

  async function upload(e: FormEvent) {
    e.preventDefault()
    if (!file) return
    setUploading(true)
    const tid = toast.loading(`Importing Scimago ${year}…`)
    try {
      const fd = new FormData()
      fd.append("file", file)
      fd.append("year", String(year))
      const data = await multipartPost("/api/admin/scimago/import", fd) as Record<string, unknown>
      toast.dismiss(tid)
      toast.success(`Imported ${data.imported} rows for ${year}`)
      setFile(null)
      await loadStats()
    } catch (err) {
      toast.dismiss(tid)
      toast.error(err instanceof Error ? err.message : "Import failed")
    } finally {
      setUploading(false)
    }
  }

  async function syncFromScimago() {
    setSyncing(true)
    const tid = toast.loading(`Downloading the SCImago ${year} dump…`)
    try {
      const data = (await api("/api/admin/scimago/sync", {
        method: "POST",
        json: { year },
      })) as Record<string, unknown>
      toast.dismiss(tid)
      toast.success(`Loaded ${data.imported} journals for ${year}`)
      await loadStats()
    } catch (err) {
      toast.dismiss(tid)
      toast.error(err instanceof Error ? err.message : "Download failed")
    } finally {
      setSyncing(false)
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Scimago import"
        subtitle="Imports · Official yearly dump for quartile resolution"
      />

      <Section
        title="Fetch from scimagojr.com"
        description="Pulls the official rank dump for the year directly. No manual download needed."
      >
        <FormPanel>
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="scimago-sync-year">Dataset year</Label>
              <Input
                id="scimago-sync-year"
                type="number"
                value={year}
                onChange={(e) => setYear(Number(e.target.value))}
                className="w-28"
              />
            </div>
            <Button type="button" onClick={syncFromScimago} disabled={syncing}>
              {syncing ? "Downloading…" : "Download & load"}
            </Button>
            <p className="max-w-md text-xs text-muted-foreground">
              The current year's dump is published partway through the next one — if it fails, try
              the previous year. SCImago also serves a bot-protection challenge to servers at
              times; when that happens, download the CSV in a browser and use the upload below. Both
              paths run the same parser.
            </p>
          </div>
        </FormPanel>
      </Section>

      <Section title="Current data">
        <FormPanel className="text-sm">
          <div className="flex flex-wrap gap-6">
            <div>
              <p className="text-xs uppercase tracking-wide text-muted-foreground">Total rows</p>
              <p className="mt-1 text-2xl font-semibold tabular-nums">{stats?.count ?? 0}</p>
            </div>
            <div>
              <p className="text-xs uppercase tracking-wide text-muted-foreground">Years loaded</p>
              <p className="mt-1 text-sm font-medium">
                {(stats?.years || []).join(", ") || "—"}
              </p>
            </div>
          </div>
        </FormPanel>
      </Section>
      <Section title="Upload new year">
        <FormPanel>
          <form className="flex flex-wrap items-end gap-3" onSubmit={upload}>
            <div className="space-y-1.5">
              <Label htmlFor="scimago-year">Year</Label>
              <Input
                id="scimago-year"
                type="number"
                value={year}
                onChange={(e) => setYear(Number(e.target.value))}
                className="w-28"
              />
            </div>
            <div className="space-y-1.5">
              <Label>CSV file</Label>
              <Input
                type="file"
                accept=".csv"
                onChange={(e) => setFile(e.target.files?.[0] || null)}
                className="max-w-xs"
              />
            </div>
            <Button type="submit" disabled={!file || uploading}>
              {uploading ? "Importing…" : "Import"}
            </Button>
          </form>
        </FormPanel>
      </Section>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Prior payments import
// ---------------------------------------------------------------------------

export function AdminPriorPage() {
  const [file, setFile] = useState<File | null>(null)
  const [uploading, setUploading] = useState(false)
  const [erpFile, setErpFile] = useState<File | null>(null)
  const [erpBusy, setErpBusy] = useState(false)
  const [erpJob, setErpJob] = useState<string | null>(null)

  async function upload(e: FormEvent) {
    e.preventDefault()
    if (!file) return
    setUploading(true)
    const tid = toast.loading("Importing prior payments…")
    try {
      const fd = new FormData()
      fd.append("file", file)
      const data = await multipartPost("/api/admin/prior/import", fd) as Record<string, unknown>
      toast.dismiss(tid)
      toast.success(`Imported ${data.imported} prior payment rows`)
      setFile(null)
    } catch (err) {
      toast.dismiss(tid)
      toast.error(err instanceof Error ? err.message : "Import failed")
    } finally {
      setUploading(false)
    }
  }

  async function uploadErp(e: FormEvent) {
    e.preventDefault()
    if (!erpFile) return
    setErpBusy(true)
    const tid = toast.loading("Queueing ERP workbook…")
    try {
      const fd = new FormData()
      fd.append("file", erpFile)
      const data = (await multipartPost("/api/admin/erp-import", fd)) as {
        job_id?: string
      }
      toast.dismiss(tid)
      if (!data.job_id) {
        toast.success("ERP import accepted")
        setErpFile(null)
        return
      }
      setErpJob("queued")
      toast.success("ERP import queued — watching job status")
      const job = await pollJob(data.job_id, (s) => setErpJob(s.status))
      if (job.status === "done") toast.success("ERP import finished")
      else if (job.status === "failed") toast.error("ERP import failed")
      else toast.info("ERP import is still running in the background")
      setErpFile(null)
    } catch (err) {
      toast.dismiss(tid)
      toast.error(err instanceof Error ? err.message : "ERP import failed")
    } finally {
      setErpBusy(false)
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Prior payments"
        subtitle="Imports · Upload a prior-payment CSV or queue an ERP workbook"
      />
      <Section title="Upload CSV">
        <FormPanel>
          <form className="flex flex-wrap items-end gap-3" onSubmit={upload}>
            <div className="space-y-1.5">
              <Label>CSV file</Label>
              <Input
                type="file"
                accept=".csv"
                onChange={(e) => setFile(e.target.files?.[0] || null)}
                className="max-w-xs"
              />
            </div>
            <Button type="submit" disabled={!file || uploading}>
              {uploading ? "Importing…" : "Import"}
            </Button>
          </form>
        </FormPanel>
      </Section>
      <Section
        title="ERP workbook"
        description="The 40 MB Publication_Processing_ERP file runs on the job queue. This page waits for SUCCESS or FAILED."
      >
        <FormPanel>
          <form className="flex flex-wrap items-end gap-3" onSubmit={uploadErp}>
            <div className="space-y-1.5">
              <Label>XLSX file</Label>
              <Input
                type="file"
                accept=".xlsx,.xlsm"
                onChange={(e) => setErpFile(e.target.files?.[0] || null)}
                className="max-w-xs"
              />
            </div>
            <Button type="submit" disabled={!erpFile || erpBusy}>
              {erpBusy ? "Working…" : "Queue import"}
            </Button>
            {erpJob ? (
              <Badge variant="secondary" className="uppercase">
                {erpJob}
              </Badge>
            ) : null}
          </form>
        </FormPanel>
      </Section>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

/** HOD was removed from the system; it is not assignable to anyone new. */
/** Four roles. HOD and RESEARCH_CELL were removed and are not assignable. */
const ROLES = ["FACULTY", "PRINCIPAL", "FINANCE", "SUPER_ADMIN"] as const

const ROLE_LABELS: Record<string, string> = {
  FACULTY: "Faculty",
  // Retired, but old accounts still render their label in the table.
  HOD: "Head of Department (retired)",
  PRINCIPAL: "Principal",
  RESEARCH_CELL: "Research Cell (merged into Admin)",
  FINANCE: "Finance",
  SUPER_ADMIN: "Admin",
}

const EMPTY_FORM = {
  email: "",
  name: "",
  password: "",
  role: "FACULTY",
  department: "",
  // Faculty cannot file a claim without these, and cannot set them themselves.
  staff_id: "",
  biometric_id: "",
  designation: "",
}

/** Everything an admin owns on a faculty record, in the order the form shows it. */
const EDITABLE_USER_FIELDS: { key: string; label: string; hint?: string; mono?: boolean }[] = [
  { key: "name", label: "Full name" },
  { key: "department", label: "Department", hint: "The department this person's tickets are filed under." },
  { key: "staff_id", label: "Staff ID", mono: true },
  {
    key: "biometric_id",
    label: "Biometric ID",
    hint: "Decides which account is paid. Faculty cannot submit a claim until this is set.",
    mono: true,
  },
  { key: "designation", label: "Designation" },
  { key: "scopus_author_url", label: "Scopus author URL" },
  { key: "scopus_author_id", label: "Scopus author ID", mono: true },
]

type UserRow = Record<string, unknown>

/** Every field on the record, whether or not an admin may edit it. */
const VIEW_USER_FIELDS: { key: string; label: string; mono?: boolean }[] = [
  { key: "email", label: "Email" },
  { key: "name", label: "Full name" },
  { key: "department", label: "Department" },
  { key: "designation", label: "Designation" },
  { key: "staff_id", label: "Staff ID", mono: true },
  { key: "employee_id", label: "Employee ID", mono: true },
  { key: "biometric_id", label: "Biometric ID", mono: true },
  { key: "scopus_author_id", label: "Scopus author ID", mono: true },
  { key: "scopus_author_url", label: "Scopus profile" },
]

/**
 * The whole account, including what it has actually done.
 *
 * Before deactivating someone or correcting a payment identity, an admin needs
 * to know whether there are claims and payments standing behind the record —
 * the list row alone cannot tell them that.
 */
function ViewUserDialog({
  userId,
  onClose,
  onEdit,
}: {
  userId: string | null
  onClose: () => void
  onEdit: (u: UserRow) => void
}) {
  const [data, setData] = useState<UserRow | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!userId) {
      setData(null)
      setError(null)
      return
    }
    let cancelled = false
    setData(null)
    setError(null)
    api(`/api/admin/users/${userId}`)
      .then((r) => !cancelled && setData(r as UserRow))
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : "Load failed"))
    return () => {
      cancelled = true
    }
  }, [userId])

  const stats = (data?.stats ?? {}) as Record<string, unknown>

  return (
    <Dialog open={!!userId} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{String(data?.name || data?.email || "Account")}</DialogTitle>
          <DialogDescription>
            {data
              ? `${ROLE_LABELS[String(data.role)] ?? String(data.role)}${
                  data.active === false ? " — deactivated" : ""
                }`
              : "Loading the full record…"}
          </DialogDescription>
        </DialogHeader>

        {error ? (
          <ErrorState title="Could not load this account" description={error} />
        ) : !data ? (
          <Skeleton className="h-56 w-full rounded-[var(--radius)]" />
        ) : (
          <div className="space-y-5">
            <div className="grid gap-3 sm:grid-cols-3">
              {[
                { label: "Tickets filed", value: String(stats.claims ?? 0) },
                { label: "Paid", value: String(stats.paid_claims ?? 0) },
                {
                  label: "Total paid",
                  value: <Money value={Number(stats.paid_amount ?? 0)} />,
                },
              ].map((t) => (
                <div key={t.label} className="surface-card p-3.5">
                  <div className="text-eyebrow">{t.label}</div>
                  <div className="text-metric-sm">{t.value}</div>
                </div>
              ))}
            </div>

            <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
              {VIEW_USER_FIELDS.map((f) => {
                const raw = data[f.key]
                const value = raw === null || raw === undefined || raw === "" ? null : String(raw)
                return (
                  <div key={f.key} className="min-w-0">
                    <dt className="text-eyebrow">{f.label}</dt>
                    <dd
                      className={cn(
                        "truncate text-sm",
                        f.mono && "font-mono text-xs",
                        !value && "text-muted-foreground",
                      )}
                    >
                      {value && f.key === "scopus_author_url" ? (
                        <a
                          className="underline underline-offset-2"
                          href={value}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {value}
                        </a>
                      ) : (
                        value ?? "Not set"
                      )}
                    </dd>
                  </div>
                )
              })}
            </dl>

            <p className="text-xs text-muted-foreground">
              {stats.drafts ? `${stats.drafts} draft(s) · ` : ""}
              {stats.in_review ? `${stats.in_review} awaiting review · ` : ""}
              {stats.last_claim_at
                ? `last activity ${new Date(String(stats.last_claim_at)).toLocaleDateString()}`
                : "no claim activity yet"}
            </p>
          </div>
        )}

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose}>
            Close
          </Button>
          <Button type="button" disabled={!data} onClick={() => data && onEdit(data)}>
            Edit details
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * Edit a faculty record on their behalf.
 *
 * Department, staff ID and biometric ID are deliberately not editable on the
 * faculty's own profile — they route the approval and pick the bank account —
 * so this dialog is the only place they can be corrected.
 */
function EditUserDialog({
  user,
  onClose,
  onSaved,
}: {
  user: UserRow | null
  onClose: () => void
  onSaved: () => Promise<void>
}) {
  const [form, setForm] = useState<Record<string, string>>({})
  const [role, setRole] = useState("FACULTY")
  const [active, setActive] = useState(true)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!user) return
    const next: Record<string, string> = {}
    for (const f of EDITABLE_USER_FIELDS) next[f.key] = String(user[f.key] ?? "")
    setForm(next)
    setRole(String(user.role || "FACULTY"))
    setActive(user.active !== false)
  }, [user])

  async function save() {
    if (!user) return
    setBusy(true)
    try {
      // Blank a field to clear it, rather than storing an empty string that
      // reads as "set" everywhere downstream.
      const payload: Record<string, unknown> = { role, active }
      for (const f of EDITABLE_USER_FIELDS) payload[f.key] = form[f.key]?.trim() || null
      await api(`/api/admin/users/${user.id}`, { method: "PATCH", json: payload })
      toast.success(`Saved ${String(user.email)}`)
      await onSaved()
      onClose()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Save failed")
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={!!user} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit {String(user?.name || user?.email || "user")}</DialogTitle>
          <DialogDescription>
            {String(user?.email || "")} — changes apply to tickets filed from now on.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 sm:grid-cols-2">
          {EDITABLE_USER_FIELDS.map((f) => (
            <div key={f.key} className={`space-y-1.5 ${f.hint ? "sm:col-span-2" : ""}`}>
              <Label htmlFor={`eu-${f.key}`}>{f.label}</Label>
              <Input
                id={`eu-${f.key}`}
                className={f.mono ? "font-mono" : undefined}
                value={form[f.key] ?? ""}
                onChange={(e) => setForm({ ...form, [f.key]: e.target.value })}
              />
              {f.hint ? <p className="text-xs text-muted-foreground">{f.hint}</p> : null}
            </div>
          ))}
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="eu-role">Role</Label>
            <Select value={role} onValueChange={setRole}>
              <SelectTrigger id="eu-role">
                <SelectValue placeholder="Select role" />
              </SelectTrigger>
              <SelectContent>
                {/* An account still on a retired role rendered a blank Select,
                    which reads as "no role assigned". Show what it actually
                    holds, disabled, alongside the roles it can move to. */}
                {!ROLES.includes(role as (typeof ROLES)[number]) ? (
                  <SelectItem value={role} disabled>
                    {ROLE_LABELS[role] ?? role}
                  </SelectItem>
                ) : null}
                {ROLES.map((r) => (
                  <SelectItem key={r} value={r}>
                    {ROLE_LABELS[r] ?? r}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Leaving is the common case; deleting an account would take its
              claims and audit trail with it, so accounts are stood down. */}
          <div className="sm:col-span-2">
            <label className="surface-card flex items-start gap-3 p-3.5">
              <Checkbox
                checked={active}
                onCheckedChange={(v) => setActive(v === true)}
                aria-label="Account is active"
                className="mt-0.5"
              />
              <span className="min-w-0">
                <span className="block text-sm font-medium">Account is active</span>
                <span className="block text-xs text-muted-foreground">
                  Turn this off when someone leaves. They can no longer sign in, and
                  their tickets and history stay exactly as they are.
                </span>
              </span>
            </label>
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="button" disabled={busy} onClick={save}>
            {busy ? "Saving…" : "Save changes"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function AdminUsersPage() {
  const [users, setUsers] = useState<Array<Record<string, unknown>>>([])
  const [loading, setLoading] = useState(true)
  const [form, setForm] = useState({ ...EMPTY_FORM })
  const [resetEmail, setResetEmail] = useState("")
  const [resetPw, setResetPw] = useState("")
  const [editing, setEditing] = useState<UserRow | null>(null)
  const [viewing, setViewing] = useState<string | null>(null)
  const [userSearch, setUserSearch] = useState("")
  // A refused load is not an empty list. Swallowing the 403 made this screen
  // tell a research-cell user there were no accounts at all.
  const [denied, setDenied] = useState(false)

  const [offset, setOffset] = useState(0)
  const [total, setTotal] = useState(0)
  const [roleFilter, setRoleFilter] = useState("ALL")
  const PAGE = 50

  async function load() {
    const qs = new URLSearchParams({ limit: String(PAGE), offset: String(offset) })
    if (userSearch.trim()) qs.set("q", userSearch.trim())
    if (roleFilter !== "ALL") qs.set("role", roleFilter)
    const body = await api<{ total: number; results: Array<Record<string, unknown>> }>(
      `/api/admin/users?${qs}`
    )
    setUsers(body.results)
    setTotal(body.total)
  }

  // Searching and paging happen on the server: the college has hundreds of
  // faculty accounts, and loading all of them to filter in the browser meant
  // the directory got slower every time someone was added.
  useEffect(() => {
    const t = setTimeout(() => {
      setLoading(true)
      load()
        .catch((e) => {
          const forbidden = e instanceof Error && /forbidden/i.test(e.message)
          setDenied(forbidden)
          if (!forbidden) toast.error("Could not load users")
        })
        .finally(() => setLoading(false))
    }, 250)
    return () => clearTimeout(t)
  }, [userSearch, roleFilter, offset])

  if (denied) {
    return (
      <div className="space-y-6">
        <PageHeader title="Users" subtitle="Users · Create accounts, assign roles and reset passwords" />
        <EmptyState
          title="Only a super admin can manage accounts"
          description="Your role can clear tickets and run imports, but not create users or change roles. Ask a super admin if someone needs an account."
        />
      </div>
    )
  }

  async function onCreate(e: FormEvent) {
    e.preventDefault()
    try {
      await api("/api/admin/users", { method: "POST", json: form })
      setForm({ ...EMPTY_FORM })
      toast.success(`Account created for ${form.email}`)
      await load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Create failed")
    }
  }

  async function onReset(e: FormEvent) {
    e.preventDefault()
    if (!resetEmail || !resetPw) return
    try {
      // The server resolves the email itself — matching against the loaded
      // list failed for any account the table had not fetched. A reset also
      // clears a sign-in lockout on that account.
      await api("/api/admin/reset-password", {
        method: "POST",
        json: { email: resetEmail.trim(), password: resetPw },
      })
      setResetEmail("")
      setResetPw("")
      toast.success(`Password reset for ${resetEmail} — the account is unlocked`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Reset failed")
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader title="Users" subtitle="Users · Create accounts, assign roles and reset passwords" />

      <Section title="Create account">
        <FormPanel>
          <form className="grid gap-4 md:grid-cols-2" onSubmit={onCreate}>
            <div className="space-y-1.5">
              <Label htmlFor="u-email">Email</Label>
              <Input
                id="u-email"
                type="email"
                required
                placeholder="faculty@example.edu"
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="u-name">Full name</Label>
              <Input
                id="u-name"
                required
                placeholder="Dr. A. Sharma"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="u-pw">
                Initial password
                {!import.meta.env.PROD && (
                  <span className="ml-2 text-[10px] font-normal text-muted-foreground">
                    (dev only — hide in prod)
                  </span>
                )}
              </Label>
              <Input
                id="u-pw"
                required
                type="password"
                placeholder="••••••••"
                value={form.password}
                onChange={(e) => setForm({ ...form, password: e.target.value })}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="u-dept">Department</Label>
              <Input
                id="u-dept"
                placeholder="Computer Engineering"
                value={form.department}
                onChange={(e) => setForm({ ...form, department: e.target.value })}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="u-staff">Staff ID</Label>
              <Input
                id="u-staff"
                placeholder="STF-001"
                value={form.staff_id}
                onChange={(e) => setForm({ ...form, staff_id: e.target.value })}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="u-bio">Biometric ID</Label>
              <Input
                id="u-bio"
                placeholder="BIO-001"
                value={form.biometric_id}
                onChange={(e) => setForm({ ...form, biometric_id: e.target.value })}
              />
              <p className="text-xs text-muted-foreground">
                Faculty cannot submit a claim until this is set, and cannot set it themselves.
              </p>
            </div>
            <div className="space-y-1.5 md:col-span-2">
              <Label htmlFor="u-desig">Designation</Label>
              <Input
                id="u-desig"
                placeholder="Assistant Professor"
                value={form.designation}
                onChange={(e) => setForm({ ...form, designation: e.target.value })}
              />
            </div>
            <div className="space-y-1.5 md:col-span-2">
              <Label htmlFor="u-role">Role</Label>
              <Select
                value={form.role}
                onValueChange={(role) => setForm({ ...form, role })}
              >
                <SelectTrigger id="u-role">
                  <SelectValue placeholder="Select role" />
                </SelectTrigger>
                <SelectContent>
                  {ROLES.map((r) => (
                    <SelectItem key={r} value={r}>
                      {ROLE_LABELS[r] ?? r}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="md:col-span-2">
              <Button type="submit">Create account</Button>
            </div>
          </form>
        </FormPanel>
      </Section>

      <Section title="Reset password">
        <FormPanel>
          <form className="flex flex-wrap items-end gap-3" onSubmit={onReset}>
            <div className="space-y-1.5">
              <Label htmlFor="r-email">Account email</Label>
              <Input
                id="r-email"
                type="email"
                required
                placeholder="faculty@example.edu"
                value={resetEmail}
                onChange={(e) => setResetEmail(e.target.value)}
                className="w-64"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="r-pw">New password</Label>
              <Input
                id="r-pw"
                type="password"
                required
                placeholder="••••••••"
                value={resetPw}
                onChange={(e) => setResetPw(e.target.value)}
                className="w-48"
              />
            </div>
            <Button type="submit" variant="secondary">
              Reset password
            </Button>
          </form>
        </FormPanel>
      </Section>

      <Section
        title="All users"
        description="Edit a record to fill in the details faculty cannot set themselves."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Input
              className="w-full sm:w-64"
              placeholder="Search name, email, staff ID…"
              value={userSearch}
              onChange={(e) => {
                setUserSearch(e.target.value)
                setOffset(0)
              }}
              aria-label="Search users"
            />
            <Select
              value={roleFilter}
              onValueChange={(v) => {
                setRoleFilter(v)
                setOffset(0)
              }}
            >
              <SelectTrigger className="w-44" aria-label="Filter by role">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">All roles</SelectItem>
                {ROLES.map((r) => (
                  <SelectItem key={r} value={r}>
                    {ROLE_LABELS[r] ?? r}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        }
      >
        {loading ? (
          <Skeleton className="h-40 w-full rounded-[var(--radius)]" />
        ) : users.length === 0 ? (
          <EmptyState
            title={userSearch || roleFilter !== "ALL" ? "No matching accounts" : "No users yet"}
            description={
              userSearch || roleFilter !== "ALL"
                ? "Try a different search or role."
                : "Create the first account above."
            }
          />
        ) : (
          <>
            <DataTable
              headers={["Email", "Name", "Role", "Department", "Staff ID", "Biometric ID", "Status", ""]}
            >
              {users.map((u) => {
                // A faculty account without these can log in but cannot file.
                const incomplete =
                  String(u.role) === "FACULTY" && (!u.biometric_id || !u.department)
                const inactive = u.active === false
                return (
                  <tr
                    key={String(u.id)}
                    className={cn("interactive hover:bg-muted/40", inactive && "opacity-60")}
                  >
                    <td className="px-4 py-3">
                      <button
                        type="button"
                        className="interactive text-left underline-offset-2 hover:underline"
                        onClick={() => setViewing(String(u.id))}
                      >
                        {String(u.email)}
                      </button>
                    </td>
                    <td className="px-4 py-3">{String(u.name || "—")}</td>
                    <td className="px-4 py-3">
                      <Badge variant="outline">
                        {ROLE_LABELS[String(u.role)] ?? String(u.role)}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {String(u.department || "—")}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-muted-foreground">
                      {String(u.staff_id || "—")}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs">
                      {u.biometric_id ? (
                        <span className="text-muted-foreground">{String(u.biometric_id)}</span>
                      ) : (
                        <span className="text-destructive">missing</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {/* A stood-down account used to look identical to a live
                          one, so nobody could tell who still had access. */}
                      {inactive ? (
                        <Badge variant="outline" className="text-muted-foreground">
                          Deactivated
                        </Badge>
                      ) : (
                        <span className="text-xs text-success">Active</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Button
                        type="button"
                        variant={incomplete ? "secondary" : "ghost"}
                        size="xs"
                        onClick={() => setEditing(u)}
                      >
                        {incomplete ? "Complete" : "Edit"}
                      </Button>
                    </td>
                  </tr>
                )
              })}
            </DataTable>
            <Pager total={total} limit={PAGE} offset={offset} onOffsetChange={setOffset} />
          </>
        )}
      </Section>

      <ViewUserDialog
        userId={viewing}
        onClose={() => setViewing(null)}
        onEdit={(u) => {
          setViewing(null)
          setEditing(u)
        }}
      />

      <EditUserDialog
        user={editing}
        onClose={() => setEditing(null)}
        onSaved={load}
      />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Formula editor + preview calculator
// ---------------------------------------------------------------------------

const FORMULA_FIELD_META: { key: string; label: string; description: string }[] = [
  {
    key: "snip_multiplier",
    label: "SNIP multiplier",
    description: "Rupees added per SNIP point (base = SNIP × multiplier + QF)",
  },
  {
    key: "snip_cap",
    label: "SNIP cap",
    description: "Reject SNIP values above this (default 30)",
  },
  {
    key: "qf_q1",
    label: "QF — Q1",
    description: "Quartile factor for Q1 journals",
  },
  {
    key: "qf_q2",
    label: "QF — Q2",
    description: "Quartile factor for Q2 journals",
  },
  {
    key: "qf_q3",
    label: "QF — Q3",
    description: "Quartile factor for Q3 journals",
  },
  {
    key: "qf_q4",
    label: "QF — Q4",
    description: "Quartile factor for Q4 journals",
  },
  {
    key: "qf_others",
    label: "QF — Others / conference",
    description: "Used when ranking is Others or SNIP is N/A",
  },
  {
    key: "qf_no_snip",
    label: "QF — NO_SNIP mode",
    description: "Quartile factor when NO_SNIP is selected",
  },
  {
    key: "high_value_threshold",
    label: "Second-approval threshold (₹)",
    description:
      "0 = off. Above 0, claims at or over this amount need a second admin to approve them before Finance can pay — which requires two admin accounts",
  },
]

const QUARTILE_OPTIONS = ["Q1", "Q2", "Q3", "Q4", "Others"] as const

export function AdminFormulaPage() {
  const [form, setForm] = useState<Record<string, unknown> | null>(null)

  const [calc, setCalc] = useState({
    snip: 1.5,
    quartile: "Q1",
    total_authors: 3,
    author_position: 1,
    publication_type: "Journal",
  })
  const [calcResult, setCalcResult] = useState<number | null>(null)
  const [calcLoading, setCalcLoading] = useState(false)

  useEffect(() => {
    api<Record<string, unknown>>("/api/admin/formula")
      .then(setForm)
      .catch(() => toast.error("Could not load formula"))
  }, [])

  if (!form) {
    return (
      <div>
        <PageHeader title="Formula" subtitle="Formula · Configure payout calculation parameters" />
        <Skeleton className="h-48 w-full rounded-[var(--radius)]" />
      </div>
    )
  }

  async function save(e: FormEvent) {
    e.preventDefault()
    try {
      const res = await api<{ version?: number; name?: string }>("/api/admin/formula", {
        method: "PUT",
        json: form,
      })
      toast.success(res.version ? `Saved ${res.name || "policy"} v${res.version}` : "Formula saved")
      const refreshed = await api<Record<string, unknown>>("/api/admin/formula")
      setForm(refreshed)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Save failed")
    }
  }

  async function runCalc(e: FormEvent) {
    e.preventDefault()
    setCalcLoading(true)
    try {
      const result = await api<{ remuneration?: number | null; error?: string | null }>(
        "/api/calculate",
        { method: "POST", json: calc }
      )
      if (result.error) toast.error(result.error)
      setCalcResult(result.remuneration ?? null)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Calculation failed")
    } finally {
      setCalcLoading(false)
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Formula"
        subtitle={
          form.name
            ? `${String(form.name)} · v${String(form.version ?? 1)} — payout policy for new tickets`
            : "Formula · Active remuneration policy"
        }
      />

      <Section title="Policy identity">
        <FormPanel>
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="policy-name">Policy name</Label>
              <Input
                id="policy-name"
                value={String(form.name || "")}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Version</Label>
              <Input value={String(form.version ?? 1)} disabled />
            </div>
          </div>
        </FormPanel>
      </Section>

      <Section title="Parameters">
        <FormPanel>
          <form className="grid gap-5 md:grid-cols-2" onSubmit={save}>
            {FORMULA_FIELD_META.map(({ key, label, description }) => (
              <div key={key} className="space-y-1.5">
                <Label htmlFor={key}>{label}</Label>
                <Input
                  id={key}
                  type="number"
                  step="any"
                  value={Number(form[key] ?? 0)}
                  onChange={(e) => setForm({ ...form, [key]: Number(e.target.value) })}
                />
                <p className="text-xs text-muted-foreground">{description}</p>
              </div>
            ))}
            <div className="space-y-1.5 md:col-span-2">
              <Label htmlFor="author_point_json">Author points (JSON)</Label>
              <Input
                id="author_point_json"
                value={String(form.author_point_json || "")}
                onChange={(e) => setForm({ ...form, author_point_json: e.target.value })}
                placeholder='{"1":1,"2":[0.7,0.3],"default":1}'
              />
              <p className="text-xs text-muted-foreground">
                Maps total-author count to position weights (arrays) or a flat share.
              </p>
            </div>
            <div className="space-y-1.5 md:col-span-2">
              <Label htmlFor="pub_mult">Publication type multipliers (JSON)</Label>
              <Input
                id="pub_mult"
                value={String(form.publication_type_multipliers_json || "")}
                onChange={(e) =>
                  setForm({ ...form, publication_type_multipliers_json: e.target.value })
                }
              />
              <p className="text-xs text-muted-foreground">
                e.g. Journal 1.0, Conference Proceeding 0.8 — applied to the base amount.
              </p>
            </div>
            <label className="flex items-center gap-2 text-sm md:col-span-2">
              <input
                type="checkbox"
                checked={Boolean(form.student_remuneration_zero)}
                onChange={(e) =>
                  setForm({ ...form, student_remuneration_zero: e.target.checked })
                }
              />
              Student publications pay ₹0
            </label>
            <label className="flex items-center gap-2 text-sm md:col-span-2">
              <input
                type="checkbox"
                checked={Boolean(form.qf_only_for_no_snip)}
                onChange={(e) => setForm({ ...form, qf_only_for_no_snip: e.target.checked })}
              />
              NO_SNIP / Others use QF only when SNIP is missing
            </label>
            <div className="md:col-span-2">
              <Button type="submit">Save as new policy version</Button>
            </div>
          </form>
        </FormPanel>
      </Section>

      <Section
        title="Preview calculator"
        description="What would this claim pay under the active policy?"
      >
        <FormPanel>
          <form className="grid gap-4 md:grid-cols-2" onSubmit={runCalc}>
            <div className="space-y-1.5">
              <Label htmlFor="c-snip">SNIP</Label>
              <Input
                id="c-snip"
                type="number"
                step="any"
                value={calc.snip}
                onChange={(e) => setCalc({ ...calc, snip: Number(e.target.value) })}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="c-quartile">Quartile</Label>
              <Select
                value={calc.quartile}
                onValueChange={(q) => setCalc({ ...calc, quartile: q })}
              >
                <SelectTrigger id="c-quartile">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {QUARTILE_OPTIONS.map((q) => (
                    <SelectItem key={q} value={q}>
                      {q}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="c-total">Total authors</Label>
              <Input
                id="c-total"
                type="number"
                min={1}
                value={calc.total_authors}
                onChange={(e) => setCalc({ ...calc, total_authors: Number(e.target.value) })}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="c-pos">Author position</Label>
              <Input
                id="c-pos"
                type="number"
                min={1}
                value={calc.author_position}
                onChange={(e) => setCalc({ ...calc, author_position: Number(e.target.value) })}
              />
            </div>
            <div className="space-y-1.5 md:col-span-2">
              <Label htmlFor="c-type">Publication type</Label>
              <Select
                value={calc.publication_type}
                onValueChange={(v) => setCalc({ ...calc, publication_type: v })}
              >
                <SelectTrigger id="c-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {["Journal", "Conference Proceeding", "Book Series", "Other"].map((t) => (
                    <SelectItem key={t} value={t}>
                      {t}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-end gap-4 md:col-span-2">
              <Button type="submit" variant="secondary" disabled={calcLoading}>
                {calcLoading ? "Calculating…" : "Calculate"}
              </Button>
              {calcResult !== null && (
                <p className="text-sm">
                  Estimated payout:{" "}
                  <span className="font-semibold text-foreground">
                    <Money value={calcResult} />
                  </span>
                </p>
              )}
            </div>
          </form>
        </FormPanel>
      </Section>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

type AuditRow = {
  id: string
  action: string
  entity?: string | null
  entity_id?: string | null
  actor?: string | null
  detail_json?: string | null
  created_at: string
}

/** Pretty-print the recorded before/after detail. It was stored on every row
 * and never shown anywhere. */
function auditDetail(raw?: string | null): string | null {
  if (!raw) return null
  try {
    return JSON.stringify(JSON.parse(raw), null, 2)
  } catch {
    return raw
  }
}

export function AdminAuditPage() {
  const [offset, setOffset] = useState(0)
  const [q, setQ] = useState("")
  const [debouncedQ, setDebouncedQ] = useState("")
  const [action, setAction] = useState("")
  const [debouncedAction, setDebouncedAction] = useState("")
  const PAGE = 100

  useEffect(() => {
    const t = setTimeout(() => {
      setDebouncedQ(q)
      setDebouncedAction(action)
    }, 250)
    return () => clearTimeout(t)
  }, [q, action])

  const params = new URLSearchParams({ limit: String(PAGE), offset: String(offset) })
  if (debouncedQ.trim()) params.set("q", debouncedQ.trim())
  if (debouncedAction.trim()) params.set("action", debouncedAction.trim())

  const { data, isLoading: loading, isError, refetch } = useApiQuery<{
    total: number
    results: AuditRow[]
  }>(["audit", debouncedQ, debouncedAction, offset], `/api/admin/audit?${params}`)
  const rows = data?.results ?? []
  const total = data?.total ?? 0

  return (
    <div className="space-y-6">
      <PageHeader title="Audit log" subtitle="Audit · Chronological record of all system actions" />

      <div className="flex flex-wrap gap-2">
        <Input
          className="w-56"
          placeholder="Search actor, entity, ticket id…"
          value={q}
          onChange={(e) => {
            setQ(e.target.value)
            setOffset(0)
          }}
        />
        <Input
          className="w-44"
          placeholder="Action, e.g. CLEAR"
          value={action}
          onChange={(e) => {
            setAction(e.target.value)
            setOffset(0)
          }}
        />
      </div>

      {loading ? (
        <Skeleton className="h-40 w-full rounded-[var(--radius)]" />
      ) : isError ? (
        <ErrorState
          title="Could not load the audit log"
          description="The server did not respond."
          onRetry={() => refetch()}
        />
      ) : rows.length === 0 ? (
        <EmptyState
          title={q || action ? "No matching events" : "No audit events yet"}
          description={
            q || action
              ? "Try a different search or action filter."
              : "Actions taken by admin and finance will appear here."
          }
        />
      ) : (
        <>
          <DataTable headers={["When", "Action", "Entity", "Actor", "Detail"]}>
            {rows.map((r) => {
              const detail = auditDetail(r.detail_json)
              return (
                <tr key={r.id} className="border-b border-border/50 last:border-0 align-top">
                  <td className="whitespace-nowrap px-4 py-3 text-muted-foreground">
                    {r.created_at ? new Date(r.created_at).toLocaleString() : "—"}
                  </td>
                  <td className="px-4 py-3 font-medium">{r.action}</td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {r.entity || "—"}
                    {r.entity_id ? (
                      <span className="block font-mono text-[11px] opacity-80">{r.entity_id}</span>
                    ) : null}
                  </td>
                  <td className="px-4 py-3">{r.actor || "—"}</td>
                  <td className="max-w-[22rem] px-4 py-3">
                    {detail ? (
                      <details>
                        <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
                          Show
                        </summary>
                        <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-muted/40 p-2 text-[11px]">
                          {detail}
                        </pre>
                      </details>
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </td>
                </tr>
              )
            })}
          </DataTable>
          <Pager total={total} limit={PAGE} offset={offset} onOffsetChange={setOffset} />
        </>
      )}
    </div>
  )
}
