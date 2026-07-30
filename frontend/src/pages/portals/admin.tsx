import { type FormEvent, type ReactNode, useEffect, useState } from "react"
import { toast } from "sonner"

import { PageHeader, StatStrip } from "@/components/layout/page"
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
import { api } from "@/lib/api"

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
    <div>
      <PageHeader
        title="Admin overview"
        subtitle="Approvals live on HoD and Principal portals — use this hub for imports and users"
      />
      {loading ? (
        <Skeleton className="h-20 w-full rounded-[var(--radius)]" />
      ) : (
        <>
          <StatStrip
            items={[
              { label: "Submitted", value: by.SUBMITTED || 0 },
              { label: "HoD approved", value: by.HOD_APPROVED || 0 },
              { label: "Principal approved", value: by.PRINCIPAL_APPROVED || 0 },
              { label: "Paid", value: by.PAID || 0 },
            ]}
          />
          <p className="mt-8 text-sm text-muted-foreground">
            Paid total:{" "}
            <span className="font-semibold text-foreground">
              <Money value={dash?.total_paid || 0} />
            </span>
          </p>
        </>
      )}
    </div>
  )
}

export function AdminMonthlyPage() {
  const [batches, setBatches] = useState<Array<Record<string, unknown>>>([])
  const [name, setName] = useState("Monthly run")
  const [file, setFile] = useState<File | null>(null)
  const [selected, setSelected] = useState<Record<string, unknown> | null>(null)
  const [loading, setLoading] = useState(true)

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
      if (d.status !== "RUNNING") refresh()
    }, 2500)
    return () => clearInterval(t)
  }, [selected?.id, selected?.status])

  async function onUpload(e: FormEvent) {
    e.preventDefault()
    if (!file) return
    try {
      const csrf = await (await fetch("/api/auth/csrf", { credentials: "include" })).json()
      const fd = new FormData()
      fd.append("name", name)
      fd.append("file", file)
      const res = await fetch("/api/monthly/upload", {
        method: "POST",
        credentials: "include",
        headers: { "X-CSRFToken": csrf.csrfToken },
        body: fd,
      })
      const data = await res.json()
      if (!res.ok) throw new Error(JSON.stringify(data))
      toast.success(`Batch ready · ${data.row_count} rows`)
      await refresh()
      setSelected(await api(`/api/monthly/${data.id}`))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Upload failed")
    }
  }

  return (
    <div>
      <PageHeader title="Monthly indexing" subtitle="Upload CSV and run enrichment" />
      <FormPanel className="mb-4">
        <form className="flex flex-wrap items-end gap-3" onSubmit={onUpload}>
          <div className="space-y-1.5">
            <Label htmlFor="batch-name">Name</Label>
            <Input id="batch-name" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <Input
            type="file"
            accept=".csv"
            onChange={(e) => setFile(e.target.files?.[0] || null)}
            className="max-w-xs"
          />
          <Button type="submit" disabled={!file}>
            Upload
          </Button>
        </form>
      </FormPanel>

      {loading ? (
        <Skeleton className="h-40 w-full rounded-[var(--radius)]" />
      ) : (
        <DataTable
          headers={["Name", "Status", ""]}
          empty={
            !batches.length ? (
              <div className="px-4 py-12 text-center text-sm text-muted-foreground">
                No batches yet
              </div>
            ) : null
          }
        >
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
                    await api(`/api/monthly/${b.id}/start`, { method: "POST", json: {} })
                    setSelected(await api(`/api/monthly/${b.id}`))
                    toast.success("Batch started")
                  }}
                >
                  Start
                </Button>
              </td>
            </tr>
          ))}
        </DataTable>
      )}

      {selected ? (
        <FormPanel className="mt-4 overflow-auto">
          <div className="mb-3 flex items-center justify-between gap-2">
            <Badge>{String(selected.status)}</Badge>
            <a href={`/api/monthly/${selected.id}/export`}>
              <Button size="sm" variant="outline">
                Export
              </Button>
            </a>
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
      ) : null}
    </div>
  )
}

export function AdminScimagoPage() {
  const [stats, setStats] = useState<{ count: number; years: number[] } | null>(null)
  const [year, setYear] = useState(2024)
  const [file, setFile] = useState<File | null>(null)

  useEffect(() => {
    api<{ count: number; years: number[] }>("/api/admin/scimago/stats")
      .then(setStats)
      .catch(() => toast.error("Could not load Scimago stats"))
  }, [])

  async function upload(e: FormEvent) {
    e.preventDefault()
    if (!file) return
    try {
      const csrf = await (await fetch("/api/auth/csrf", { credentials: "include" })).json()
      const fd = new FormData()
      fd.append("file", file)
      fd.append("year", String(year))
      const res = await fetch("/api/admin/scimago/import", {
        method: "POST",
        credentials: "include",
        headers: { "X-CSRFToken": csrf.csrfToken },
        body: fd,
      })
      const data = await res.json()
      if (!res.ok) throw new Error(JSON.stringify(data))
      toast.success(`Imported ${data.imported} rows`)
      setStats(await api<{ count: number; years: number[] }>("/api/admin/scimago/stats"))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Import failed")
    }
  }

  return (
    <div>
      <PageHeader
        title="Scimago dump"
        subtitle="Official yearly CSV for quartile resolution"
      />
      <FormPanel className="mb-4 text-sm">
        <p>
          Rows: <strong>{stats?.count ?? 0}</strong>
          {" · "}
          Years: {(stats?.years || []).join(", ") || "—"}
        </p>
      </FormPanel>
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
          <Input
            type="file"
            accept=".csv"
            onChange={(e) => setFile(e.target.files?.[0] || null)}
            className="max-w-xs"
          />
          <Button type="submit" disabled={!file}>
            Import
          </Button>
        </form>
      </FormPanel>
    </div>
  )
}

export function AdminPriorPage() {
  const [file, setFile] = useState<File | null>(null)

  async function upload(e: FormEvent) {
    e.preventDefault()
    if (!file) return
    try {
      const csrf = await (await fetch("/api/auth/csrf", { credentials: "include" })).json()
      const fd = new FormData()
      fd.append("file", file)
      const res = await fetch("/api/admin/prior/import", {
        method: "POST",
        credentials: "include",
        headers: { "X-CSRFToken": csrf.csrfToken },
        body: fd,
      })
      const data = await res.json()
      if (!res.ok) throw new Error(JSON.stringify(data))
      toast.success(`Imported ${data.imported}`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Import failed")
    }
  }

  return (
    <div>
      <PageHeader title="Prior payments" subtitle="Import prior-payment CSV" />
      <FormPanel>
        <form className="flex flex-wrap gap-3" onSubmit={upload}>
          <Input
            type="file"
            accept=".csv"
            onChange={(e) => setFile(e.target.files?.[0] || null)}
            className="max-w-xs"
          />
          <Button type="submit" disabled={!file}>
            Import
          </Button>
        </form>
      </FormPanel>
    </div>
  )
}

const ROLES = ["FACULTY", "HOD", "PRINCIPAL", "RESEARCH_CELL", "FINANCE", "SUPER_ADMIN"] as const

export function AdminUsersPage() {
  const [users, setUsers] = useState<Array<Record<string, unknown>>>([])
  const [loading, setLoading] = useState(true)
  const [form, setForm] = useState({
    email: "",
    name: "",
    password: "",
    role: "FACULTY",
    department: "",
  })

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
      setForm({ email: "", name: "", password: "", role: "FACULTY", department: "" })
      toast.success("User created")
      await load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Create failed")
    }
  }

  return (
    <div>
      <PageHeader title="Users" subtitle="Create accounts and assign roles" />
      <FormPanel className="mb-4">
        <form className="grid gap-3 md:grid-cols-2" onSubmit={onCreate}>
          <Input
            required
            placeholder="Email"
            value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
          />
          <Input
            required
            placeholder="Name"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
          <Input
            required
            type="password"
            placeholder="Password"
            value={form.password}
            onChange={(e) => setForm({ ...form, password: e.target.value })}
          />
          <Input
            placeholder="Department"
            value={form.department}
            onChange={(e) => setForm({ ...form, department: e.target.value })}
          />
          <Select
            value={form.role}
            onValueChange={(role) => setForm({ ...form, role })}
          >
            <SelectTrigger>
              <SelectValue placeholder="Role" />
            </SelectTrigger>
            <SelectContent>
              {ROLES.map((r) => (
                <SelectItem key={r} value={r}>
                  {r}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button type="submit">Create</Button>
        </form>
      </FormPanel>

      {loading ? (
        <Skeleton className="h-40 w-full rounded-[var(--radius)]" />
      ) : (
        <DataTable headers={["Email", "Name", "Role"]}>
          {users.map((u) => (
            <tr key={String(u.id)} className="border-b border-border/50 last:border-0">
              <td className="px-4 py-3">{String(u.email)}</td>
              <td className="px-4 py-3">{String(u.name || "")}</td>
              <td className="px-4 py-3">
                <Badge variant="outline">{String(u.role)}</Badge>
              </td>
            </tr>
          ))}
        </DataTable>
      )}
    </div>
  )
}

export function AdminFormulaPage() {
  const [form, setForm] = useState<Record<string, unknown> | null>(null)

  useEffect(() => {
    api<Record<string, unknown>>("/api/admin/formula")
      .then(setForm)
      .catch(() => toast.error("Could not load formula"))
  }, [])

  if (!form) {
    return (
      <div>
        <PageHeader title="Formula" />
        <Skeleton className="h-48 w-full rounded-[var(--radius)]" />
      </div>
    )
  }

  async function save(e: FormEvent) {
    e.preventDefault()
    try {
      await api("/api/admin/formula", { method: "PUT", json: form })
      toast.success("Formula saved")
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Save failed")
    }
  }

  return (
    <div>
      <PageHeader title="Formula" subtitle="SNIP × multiplier + quartile factors × author points" />
      <FormPanel>
        <form className="grid gap-3 md:grid-cols-2" onSubmit={save}>
          {["snip_multiplier", "qf_q1", "qf_q2", "qf_q3", "qf_q4"].map((k) => (
            <div key={k} className="space-y-1.5">
              <Label htmlFor={k}>{k}</Label>
              <Input
                id={k}
                type="number"
                value={Number(form[k] ?? 0)}
                onChange={(e) => setForm({ ...form, [k]: Number(e.target.value) })}
              />
            </div>
          ))}
          <div className="space-y-1.5 md:col-span-2">
            <Label htmlFor="author_point_json">author_point_json</Label>
            <Input
              id="author_point_json"
              value={String(form.author_point_json || "")}
              onChange={(e) => setForm({ ...form, author_point_json: e.target.value })}
            />
          </div>
          <Button type="submit">Save</Button>
        </form>
      </FormPanel>
    </div>
  )
}

export function AdminAuditPage() {
  const [rows, setRows] = useState<Array<Record<string, unknown>>>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    api<Array<Record<string, unknown>>>("/api/admin/audit")
      .then(setRows)
      .catch(() => toast.error("Could not load audit"))
      .finally(() => setLoading(false))
  }, [])

  return (
    <div>
      <PageHeader title="Audit" subtitle="Recent system actions" />
      {loading ? (
        <Skeleton className="h-40 w-full rounded-[var(--radius)]" />
      ) : (
        <DataTable
          headers={["When", "Action", "Actor"]}
          empty={
            !rows.length ? (
              <div className="px-4 py-12 text-center text-sm text-muted-foreground">
                No audit events
              </div>
            ) : null
          }
        >
          {rows.map((r) => (
            <tr key={String(r.id)} className="border-b border-border/50 last:border-0">
              <td className="px-4 py-3 text-muted-foreground">
                {r.created_at ? new Date(String(r.created_at)).toLocaleString() : "—"}
              </td>
              <td className="px-4 py-3 font-medium">{String(r.action)}</td>
              <td className="px-4 py-3">{String(r.actor || "")}</td>
            </tr>
          ))}
        </DataTable>
      )}
    </div>
  )
}
