import { FormEvent, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, Input, Label } from "@/components/ui/input";

export function AdminUsersPage() {
  const [users, setUsers] = useState<Array<Record<string, unknown>>>([]);
  const [form, setForm] = useState({ email: "", name: "", password: "", role: "FACULTY", department: "" });

  async function load() {
    setUsers(await api("/api/admin/users"));
  }
  useEffect(() => {
    load().catch(console.error);
  }, []);

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    await api("/api/admin/users", { method: "POST", json: form });
    setForm({ email: "", name: "", password: "", role: "FACULTY", department: "" });
    await load();
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Users</h1>
      <Card className="p-5">
        <form className="grid gap-3 md:grid-cols-2" onSubmit={onCreate}>
          <div className="space-y-1"><Label>Email</Label><Input required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></div>
          <div className="space-y-1"><Label>Name</Label><Input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
          <div className="space-y-1"><Label>Password</Label><Input required type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} /></div>
          <div className="space-y-1"><Label>Department</Label><Input value={form.department} onChange={(e) => setForm({ ...form, department: e.target.value })} /></div>
          <div className="space-y-1">
            <Label>Role</Label>
            <select className="h-9 w-full rounded-md border border-slate-300 px-3 text-sm" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
              {["FACULTY", "HOD", "RESEARCH_CELL", "FINANCE", "SUPER_ADMIN"].map((r) => (
                <option key={r}>{r}</option>
              ))}
            </select>
          </div>
          <div className="flex items-end"><Button type="submit">Create user</Button></div>
        </form>
      </Card>
      <Card className="overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500"><tr><th className="px-4 py-2">Email</th><th className="px-4 py-2">Name</th><th className="px-4 py-2">Role</th></tr></thead>
          <tbody>
            {users.map((u) => (
              <tr key={String(u.id)} className="border-t"><td className="px-4 py-2">{String(u.email)}</td><td className="px-4 py-2">{String(u.name)}</td><td className="px-4 py-2">{String(u.role)}</td></tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

export function AdminFormulaPage() {
  const [form, setForm] = useState({
    snip_multiplier: 55000,
    qf_q1: 50000,
    qf_q2: 30000,
    qf_q3: 15000,
    qf_q4: 5000,
    qf_no_snip: 0,
    qf_snip_only: 0,
    author_point_json: "",
    notes: "",
  });
  const [msg, setMsg] = useState("");
  useEffect(() => {
    api<typeof form>("/api/admin/formula").then(setForm).catch(console.error);
  }, []);
  async function save(e: FormEvent) {
    e.preventDefault();
    await api("/api/admin/formula", { method: "PUT", json: form });
    setMsg("Saved");
  }
  return (
    <div>
      <h1 className="mb-4 text-2xl font-semibold">Formula</h1>
      <Card className="p-5">
        <form className="grid gap-3 md:grid-cols-2" onSubmit={save}>
          {(["snip_multiplier", "qf_q1", "qf_q2", "qf_q3", "qf_q4", "qf_no_snip", "qf_snip_only"] as const).map((k) => (
            <div key={k} className="space-y-1">
              <Label>{k}</Label>
              <Input type="number" value={(form as any)[k]} onChange={(e) => setForm({ ...form, [k]: Number(e.target.value) })} />
            </div>
          ))}
          <div className="space-y-1 md:col-span-2">
            <Label>author_point_json</Label>
            <Input value={form.author_point_json} onChange={(e) => setForm({ ...form, author_point_json: e.target.value })} />
          </div>
          <Button type="submit">Save</Button>
          {msg ? <p className="text-sm text-slate-600">{msg}</p> : null}
        </form>
      </Card>
    </div>
  );
}

export function AdminPayoutsPage() {
  const [rows, setRows] = useState<Array<Record<string, unknown>>>([]);
  useEffect(() => {
    api("/api/admin/payouts").then(setRows).catch(console.error);
  }, []);
  return (
    <div>
      <h1 className="mb-4 text-2xl font-semibold">Payouts</h1>
      <Card className="overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500"><tr><th className="px-4 py-2">Paper</th><th className="px-4 py-2">Owner</th><th className="px-4 py-2">Amount</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={String(r.id)} className="border-t">
                <td className="px-4 py-2">{String(r.paper_title)}</td>
                <td className="px-4 py-2">{String(r.owner_name)}</td>
                <td className="px-4 py-2">{r.remuneration != null ? `₹${Number(r.remuneration).toLocaleString("en-IN")}` : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

export function AdminPriorPage() {
  const [file, setFile] = useState<File | null>(null);
  const [msg, setMsg] = useState("");
  async function upload(e: FormEvent) {
    e.preventDefault();
    if (!file) return;
    const csrf = await (await fetch("/api/auth/csrf", { credentials: "include" })).json();
    const fd = new FormData();
    fd.append("file", file);
    const res = await fetch("/api/admin/prior/import", { method: "POST", credentials: "include", headers: { "X-CSRFToken": csrf.csrfToken }, body: fd });
    const data = await res.json();
    setMsg(res.ok ? `Imported ${data.imported}` : JSON.stringify(data));
  }
  return (
    <div>
      <h1 className="mb-4 text-2xl font-semibold">Prior CSV import</h1>
      <Card className="p-5">
        <form className="flex flex-wrap items-end gap-3" onSubmit={upload}>
          <Input type="file" accept=".csv" onChange={(e) => setFile(e.target.files?.[0] || null)} />
          <Button type="submit">Import</Button>
        </form>
        {msg ? <p className="mt-3 text-sm">{msg}</p> : null}
      </Card>
    </div>
  );
}

export function AdminScimagoPage() {
  const [stats, setStats] = useState<{ count: number; years: number[] } | null>(null);
  const [year, setYear] = useState(2024);
  const [file, setFile] = useState<File | null>(null);
  const [msg, setMsg] = useState("");
  useEffect(() => {
    api("/api/admin/scimago/stats").then(setStats).catch(console.error);
  }, []);
  async function upload(e: FormEvent) {
    e.preventDefault();
    if (!file) return;
    const csrf = await (await fetch("/api/auth/csrf", { credentials: "include" })).json();
    const fd = new FormData();
    fd.append("file", file);
    fd.append("year", String(year));
    const res = await fetch("/api/admin/scimago/import", { method: "POST", credentials: "include", headers: { "X-CSRFToken": csrf.csrfToken }, body: fd });
    const data = await res.json();
    setMsg(res.ok ? `Imported ${data.imported}` : JSON.stringify(data));
    setStats(await api("/api/admin/scimago/stats"));
  }
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Scimago dump</h1>
      <Card className="p-5 text-sm">Rows: {stats?.count ?? "—"} · Years: {(stats?.years || []).join(", ") || "—"}</Card>
      <Card className="p-5">
        <form className="flex flex-wrap items-end gap-3" onSubmit={upload}>
          <div><Label>Year</Label><Input type="number" value={year} onChange={(e) => setYear(Number(e.target.value))} /></div>
          <Input type="file" accept=".csv" onChange={(e) => setFile(e.target.files?.[0] || null)} />
          <Button type="submit">Import</Button>
        </form>
        {msg ? <p className="mt-3 text-sm">{msg}</p> : null}
      </Card>
    </div>
  );
}

export function AdminAuditPage() {
  const [rows, setRows] = useState<Array<Record<string, unknown>>>([]);
  useEffect(() => {
    api("/api/admin/audit").then(setRows).catch(console.error);
  }, []);
  return (
    <div>
      <h1 className="mb-4 text-2xl font-semibold">Audit</h1>
      <Card className="overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500"><tr><th className="px-4 py-2">When</th><th className="px-4 py-2">Action</th><th className="px-4 py-2">Actor</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={String(r.id)} className="border-t"><td className="px-4 py-2">{String(r.created_at)}</td><td className="px-4 py-2">{String(r.action)}</td><td className="px-4 py-2">{String(r.actor || "")}</td></tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
