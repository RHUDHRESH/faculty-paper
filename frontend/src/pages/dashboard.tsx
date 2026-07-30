import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, type Claim } from "@/lib/api";
import { Card, Badge } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

export function DashboardPage() {
  const [data, setData] = useState<{
    by_status: Record<string, number>;
    recent: Claim[];
    total_paid: number;
  } | null>(null);

  useEffect(() => {
    api<typeof data>("/api/dashboard").then(setData).catch(console.error);
  }, []);

  if (!data) return <p className="text-sm text-slate-500">Loading dashboard…</p>;

  const tiles = [
    { label: "Draft", value: data.by_status.DRAFT || 0 },
    { label: "Submitted", value: data.by_status.SUBMITTED || 0 },
    { label: "In approval", value: (data.by_status.HOD_APPROVED || 0) + (data.by_status.RESEARCH_APPROVED || 0) + (data.by_status.FINANCE_APPROVED || 0) },
    { label: "Paid total", value: `₹${(data.total_paid || 0).toLocaleString("en-IN")}` },
  ];

  return (
    <div>
      <div className="mb-6 flex items-end justify-between gap-4">
        <div>
          <div className="text-xs uppercase tracking-[0.14em] text-slate-500">Overview</div>
          <h1 className="text-2xl font-semibold">Dashboard</h1>
        </div>
        <Link to="/claims/new">
          <Button>New claim</Button>
        </Link>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {tiles.map((t) => (
          <Card key={t.label} className="p-4">
            <div className="text-xs uppercase tracking-wide text-slate-500">{t.label}</div>
            <div className="mt-2 text-2xl font-semibold tabular-nums">{t.value}</div>
          </Card>
        ))}
      </div>
      <Card className="mt-6 overflow-hidden">
        <div className="border-b border-slate-200 px-4 py-3 text-sm font-medium">Recent claims</div>
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500">
            <tr>
              <th className="px-4 py-2">Title</th>
              <th className="px-4 py-2">Status</th>
              <th className="px-4 py-2">Amount</th>
            </tr>
          </thead>
          <tbody>
            {data.recent.map((c) => (
              <tr key={c.id} className="border-t border-slate-100">
                <td className="px-4 py-3">
                  <Link className="text-[#0f4c5c] hover:underline" to={`/claims/${c.id}`}>
                    {c.paper_title || "Untitled"}
                  </Link>
                </td>
                <td className="px-4 py-3">
                  <Badge>{c.status.replace(/_/g, " ")}</Badge>
                </td>
                <td className="px-4 py-3 tabular-nums">
                  {c.remuneration != null ? `₹${c.remuneration.toLocaleString("en-IN")}` : "—"}
                </td>
              </tr>
            ))}
            {!data.recent.length && (
              <tr>
                <td colSpan={3} className="px-4 py-6 text-slate-500">
                  No claims yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
