import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, type Claim } from "@/lib/api";
import { Card, Badge } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

export function ClaimsPage() {
  const [claims, setClaims] = useState<Claim[]>([]);
  useEffect(() => {
    api<Claim[]>("/api/claims").then(setClaims).catch(console.error);
  }, []);

  return (
    <div>
      <div className="mb-6 flex items-end justify-between">
        <div>
          <div className="text-xs uppercase tracking-[0.14em] text-slate-500">Ledger</div>
          <h1 className="text-2xl font-semibold">Claims</h1>
        </div>
        <Link to="/claims/new">
          <Button>New claim</Button>
        </Link>
      </div>
      <Card className="overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500">
            <tr>
              <th className="px-4 py-2">Paper</th>
              <th className="px-4 py-2">Owner</th>
              <th className="px-4 py-2">Status</th>
              <th className="px-4 py-2">Amount</th>
            </tr>
          </thead>
          <tbody>
            {claims.map((c) => (
              <tr key={c.id} className="border-t border-slate-100 hover:bg-slate-50/80">
                <td className="px-4 py-3">
                  <Link to={`/claims/${c.id}`} className="font-medium text-[#0f4c5c] hover:underline">
                    {c.paper_title || "Untitled"}
                  </Link>
                  <div className="text-xs text-slate-500">{c.journal_title}</div>
                </td>
                <td className="px-4 py-3">{c.owner_name}</td>
                <td className="px-4 py-3">
                  <Badge>{c.status.replace(/_/g, " ")}</Badge>
                </td>
                <td className="px-4 py-3 tabular-nums">
                  {c.remuneration != null ? `₹${c.remuneration.toLocaleString("en-IN")}` : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
