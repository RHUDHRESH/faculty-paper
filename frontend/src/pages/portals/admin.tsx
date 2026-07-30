import { type FormEvent, type ReactNode, useEffect, useState } from "react"
import { toast } from "sonner"

import { EmptyState, PageHeader, Section, StatStrip } from "@/components/layout/page"
import { Money } from "@/components/ticket-ui"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { api, ensureCsrf } from "@/lib/api"

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
      className={`rounded-[var(--radius)] border border-border/80 bg-card p-5 ${className || ""}`}
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
    <div className="overflow-hidden rounded-[var(--radius)] border border-border/80 bg-card">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[480px] text-sm">
          <thead>
            <tr className="border-b border-border/60 text-left text-xs uppercase tracking-wide text-muted-foreground">
              {headers.map((h) => (
                <th key={h} className="px-4 py-3 font-medium">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>{children}</tbody>
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
  const res = await fetch(path, {
    method: "POST",
    credentials: "include",
    headers: { "X-CSRFToken": csrfToken },
    body: fd,
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data?.detail || JSON.stringify(data))
  return data
}

// ---------------------------------------------------------------------------
// Admin overview (index route)
// ---------------------------------------------------------------------------

export function AdminApprovalsPage() {
  const [dash, setDash] = useState<{
    by_status?: Record<string, number>
    total_paid?: number
  } | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    api<{ by_status?: Record<string, number>; total_paid?: number }>("/api/dashboard")
      .then(setDash)
      .catch(() => toast.error("Could not load overview"))
      .finally(() => setLoading(false))
  }, [])

  const by = dash?.by_status || {}

  return (
    <div className="space-y-6">
      <PageHeader
        title="Admin overview"
        subtitle="Overview · Users · Formula · Imports · Monthly · Audit — manage the system from this hub"
      />
      {loading ? (
        <Skeleton className="h-20 w-full rounded-[var(--radius)]" />
      ) : (
        <Section title="Claim pipeline">
          <StatStrip
            items={[
              { label: "Submitted", value: by.SUBMITTED || 0 },
              { label: "HoD approved", value: by.HOD_APPROVED || 0 },
              { label: "Principal approved", value: by.PRINCIPAL_APPROVED || 0 },
              { label: "Paid", value: by.PAID || 0 },
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
                    variant={
                      b.status === "RUNNING"
                        ? "warning"
                        : b.status === "DONE"
                          ? "success"
                          : "secondary"
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
                        await api(`/api/monthly/${b.id}/start`, { method: "POST", json: {} })
                        toast.dismiss(tid)
                        toast.success("Batch started — refreshing every 2.5 s")
                        setSelected(await api(`/api/monthly/${b.id}`))
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
            <a href={`/api/monthly/${selected.id}/export`}>
              <Button size="sm" variant="outline">
                Export
              </Button>
            </a>
          }
        >
          <FormPanel className="overflow-auto">
            <div className="mb-3">
              <Badge
                variant={
                  selected.status === "RUNNING"
                    ? "warning"
                    : selected.status === "DONE"
                      ? "success"
                      : "secondary"
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

  return (
    <div className="space-y-6">
      <PageHeader
        title="Scimago import"
        subtitle="Imports · Official yearly CSV for quartile resolution"
      />
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

  return (
    <div className="space-y-6">
      <PageHeader
        title="Prior payments"
        subtitle="Imports · Upload a prior-payment CSV to pre-populate historical records"
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
    </div>
  )
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

const ROLES = ["FACULTY", "HOD", "PRINCIPAL", "RESEARCH_CELL", "FINANCE", "SUPER_ADMIN"] as const

const ROLE_LABELS: Record<string, string> = {
  FACULTY: "Faculty",
  HOD: "Head of Department",
  PRINCIPAL: "Principal",
  RESEARCH_CELL: "Research Cell",
  FINANCE: "Finance",
  SUPER_ADMIN: "Super Admin",
}

const EMPTY_FORM = {
  email: "",
  name: "",
  password: "",
  role: "FACULTY",
  department: "",
}

export function AdminUsersPage() {
  const [users, setUsers] = useState<Array<Record<string, unknown>>>([])
  const [loading, setLoading] = useState(true)
  const [form, setForm] = useState({ ...EMPTY_FORM })
  const [resetEmail, setResetEmail] = useState("")
  const [resetPw, setResetPw] = useState("")

  async function load() {
    setUsers(await api("/api/admin/users"))
  }

  useEffect(() => {
    load()
      .catch(() => toast.error("Could not load users"))
      .finally(() => setLoading(false))
  }, [])

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
      const match = users.find(
        (u) => String(u.email || "").toLowerCase() === resetEmail.trim().toLowerCase()
      )
      if (!match?.id) {
        toast.error("No user with that email")
        return
      }
      await api(`/api/admin/users/${match.id}/reset-password`, {
        method: "POST",
        json: { password: resetPw },
      })
      setResetEmail("")
      setResetPw("")
      toast.success(`Password reset for ${resetEmail}`)
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

      <Section title="All users">
        {loading ? (
          <Skeleton className="h-40 w-full rounded-[var(--radius)]" />
        ) : users.length === 0 ? (
          <EmptyState title="No users yet" description="Create the first account above." />
        ) : (
          <DataTable headers={["Email", "Name", "Role", "Department"]}>
            {users.map((u) => (
              <tr key={String(u.id)} className="border-b border-border/50 last:border-0">
                <td className="px-4 py-3">{String(u.email)}</td>
                <td className="px-4 py-3">{String(u.name || "—")}</td>
                <td className="px-4 py-3">
                  <Badge variant="outline">{ROLE_LABELS[String(u.role)] ?? String(u.role)}</Badge>
                </td>
                <td className="px-4 py-3 text-muted-foreground">
                  {String(u.department || "—")}
                </td>
              </tr>
            ))}
          </DataTable>
        )}
      </Section>
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

export function AdminAuditPage() {
  const [rows, setRows] = useState<Array<Record<string, unknown>>>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    api<Array<Record<string, unknown>>>("/api/admin/audit")
      .then(setRows)
      .catch(() => toast.error("Could not load audit log"))
      .finally(() => setLoading(false))
  }, [])

  return (
    <div className="space-y-6">
      <PageHeader title="Audit log" subtitle="Audit · Chronological record of all system actions" />
      {loading ? (
        <Skeleton className="h-40 w-full rounded-[var(--radius)]" />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No audit events yet"
          description="Actions taken by admin, HoD, and Principal will appear here."
        />
      ) : (
        <DataTable headers={["When", "Action", "Actor"]}>
          {rows.map((r) => (
            <tr key={String(r.id)} className="border-b border-border/50 last:border-0">
              <td className="px-4 py-3 text-muted-foreground">
                {r.created_at ? new Date(String(r.created_at)).toLocaleString() : "—"}
              </td>
              <td className="px-4 py-3 font-medium">{String(r.action)}</td>
              <td className="px-4 py-3">{String(r.actor || "—")}</td>
            </tr>
          ))}
        </DataTable>
      )}
    </div>
  )
}
