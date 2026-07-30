import { FormEvent, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, Input, Label, Badge } from "@/components/ui/input";

type Batch = {
  id: string;
  name: string;
  status: string;
  row_count: number;
  created_at: string;
  error_message?: string | null;
};

type BatchDetail = Batch & {
  rows: Array<Record<string, unknown>>;
};

export function MonthlyPage() {
  const [batches, setBatches] = useState<Batch[]>([]);
  const [name, setName] = useState("Monthly run");
  const [file, setFile] = useState<File | null>(null);
  const [selected, setSelected] = useState<BatchDetail | null>(null);
  const [msg, setMsg] = useState("");

  async function refresh() {
    setBatches(await api<Batch[]>("/api/monthly"));
  }

  useEffect(() => {
    refresh().catch(console.error);
  }, []);

  useEffect(() => {
    if (!selected || selected.status !== "RUNNING") return;
    const t = setInterval(async () => {
      const d = await api<BatchDetail>(`/api/monthly/${selected.id}`);
      setSelected(d);
      if (d.status !== "RUNNING") refresh();
    }, 2500);
    return () => clearInterval(t);
  }, [selected?.id, selected?.status]);

  async function onUpload(e: FormEvent) {
    e.preventDefault();
    if (!file) return;
    setMsg("");
    const fd = new FormData();
    fd.append("name", name);
    fd.append("file", file);
    const csrf = await (await fetch("/api/auth/csrf", { credentials: "include" })).json();
    const res = await fetch("/api/monthly/upload", {
      method: "POST",
      credentials: "include",
      headers: { "X-CSRFToken": csrf.csrfToken },
      body: fd,
    });
    if (!res.ok) {
      setMsg(await res.text());
      return;
    }
    const data = await res.json();
    setMsg(`Created batch ${data.id} with ${data.row_count} rows`);
    await refresh();
    setSelected(await api<BatchDetail>(`/api/monthly/${data.id}`));
  }

  async function start(id: string) {
    await api(`/api/monthly/${id}/start`, { method: "POST", json: {} });
    setSelected(await api<BatchDetail>(`/api/monthly/${id}`));
    await refresh();
  }

  return (
    <div className="space-y-6">
      <div>
        <div className="text-xs uppercase tracking-[0.14em] text-slate-500">Scopus batch</div>
        <h1 className="text-2xl font-semibold">Monthly indexing</h1>
        <p className="mt-1 text-sm text-slate-600">
          Upload CSV with <code>author_id</code> and <code>title</code> columns — ports PROCESS_MONTHLY_DATA_V3.
        </p>
      </div>

      <Card className="p-5">
        <form className="grid gap-3 md:grid-cols-3" onSubmit={onUpload}>
          <div className="space-y-1.5">
            <Label>Batch name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label>CSV file</Label>
            <Input type="file" accept=".csv" onChange={(e) => setFile(e.target.files?.[0] || null)} />
          </div>
          <div className="flex items-end">
            <Button type="submit" disabled={!file}>
              Upload batch
            </Button>
          </div>
        </form>
        {msg ? <p className="mt-3 text-sm text-slate-600">{msg}</p> : null}
      </Card>

      <Card className="overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500">
            <tr>
              <th className="px-4 py-2">Name</th>
              <th className="px-4 py-2">Status</th>
              <th className="px-4 py-2">Rows</th>
              <th className="px-4 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {batches.map((b) => (
              <tr key={b.id} className="border-t border-slate-100">
                <td className="px-4 py-3">{b.name}</td>
                <td className="px-4 py-3">
                  <Badge>{b.status}</Badge>
                </td>
                <td className="px-4 py-3">{b.row_count}</td>
                <td className="px-4 py-3 text-right">
                  <Button size="sm" variant="secondary" onClick={async () => setSelected(await api(`/api/monthly/${b.id}`))}>
                    Open
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      {selected && (
        <Card className="p-5">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div>
              <div className="font-medium">{selected.name}</div>
              <Badge className="mt-1">{selected.status}</Badge>
            </div>
            <div className="flex gap-2">
              <Button
                size="sm"
                onClick={() => start(selected.id)}
                disabled={selected.status === "RUNNING"}
              >
                Start processing
              </Button>
              <a href={`/api/monthly/${selected.id}/export`}>
                <Button size="sm" variant="secondary">
                  Export CSV
                </Button>
              </a>
            </div>
          </div>
          <div className="overflow-auto">
            <table className="w-full min-w-[900px] text-xs">
              <thead className="bg-slate-50 text-left uppercase text-slate-500">
                <tr>
                  {["#", "Title", "Status", "Link", "Journal", "ISSN", "DOI", "Quartile", "SNIP", "Eng"].map((h) => (
                    <th key={h} className="px-2 py-2">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {selected.rows.map((r) => (
                  <tr key={String(r.id)} className="border-t border-slate-100">
                    <td className="px-2 py-2">{String(r.row_number)}</td>
                    <td className="px-2 py-2 max-w-[220px] truncate">{String(r.paper_title || "")}</td>
                    <td className="px-2 py-2">{String(r.index_status || "")}</td>
                    <td className="px-2 py-2">{String(r.linkage || "")}</td>
                    <td className="px-2 py-2">{String(r.journal || "")}</td>
                    <td className="px-2 py-2">{String(r.issn || "")}</td>
                    <td className="px-2 py-2">{String(r.doi || "")}</td>
                    <td className="px-2 py-2">{String(r.sjr_quartile || "")}</td>
                    <td className="px-2 py-2">{String(r.snip || "")}</td>
                    <td className="px-2 py-2">{String(r.engineering_class || "")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}
