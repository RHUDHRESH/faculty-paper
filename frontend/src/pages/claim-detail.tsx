import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { api, type Claim } from "@/lib/api";
import { useAuth } from "@/components/auth-provider";
import { Button } from "@/components/ui/button";
import { Card, Badge, Input } from "@/components/ui/input";

export function ClaimDetailPage() {
  const { id } = useParams();
  const { user } = useAuth();
  const [claim, setClaim] = useState<Claim | null>(null);
  const [note, setNote] = useState("");
  const [voucher, setVoucher] = useState("");
  const [msg, setMsg] = useState("");

  async function load() {
    if (!id) return;
    setClaim(await api<Claim>(`/api/claims/${id}`));
  }

  useEffect(() => {
    load().catch(console.error);
  }, [id]);

  async function act(path: string, body: Record<string, unknown> = {}) {
    setMsg("");
    try {
      await api(`/api/claims/${id}/${path}`, { method: "POST", json: { note, ...body } });
      await load();
      setMsg("Updated");
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Failed");
    }
  }

  if (!claim) return <p className="text-sm text-slate-500">Loading…</p>;
  const role = user?.role || "";

  return (
    <div className="space-y-4">
      <div>
        <Badge>{claim.status.replace(/_/g, " ")}</Badge>
        <h1 className="mt-2 text-2xl font-semibold">{claim.paper_title || "Untitled"}</h1>
        <p className="text-sm text-slate-600">{claim.journal_title}</p>
      </div>
      <Card className="grid gap-3 p-5 sm:grid-cols-2 text-sm">
        <div><span className="text-slate-500">DOI</span><div>{claim.doi || "—"}</div></div>
        <div><span className="text-slate-500">ISSN</span><div>{claim.issn || "—"}</div></div>
        <div><span className="text-slate-500">SNIP</span><div>{claim.snip ?? "—"}</div></div>
        <div><span className="text-slate-500">Quartile</span><div>{claim.quartile || "—"}</div></div>
        <div><span className="text-slate-500">EID</span><div>{claim.eid || "—"}</div></div>
        <div><span className="text-slate-500">Amount</span><div className="text-lg font-semibold">{claim.remuneration != null ? `₹${claim.remuneration.toLocaleString("en-IN")}` : "—"}</div></div>
      </Card>

      <Card className="space-y-3 p-5">
        <div className="text-sm font-medium">Workflow actions</div>
        <Input placeholder="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
        {claim.status === "FINANCE_APPROVED" && (
          <Input placeholder="Voucher number" value={voucher} onChange={(e) => setVoucher(e.target.value)} />
        )}
        <div className="flex flex-wrap gap-2">
          {claim.status === "SUBMITTED" && ["HOD", "SUPER_ADMIN"].includes(role) && (
            <Button onClick={() => act("hod-approve")}>HOD approve</Button>
          )}
          {claim.status === "HOD_APPROVED" && ["RESEARCH_CELL", "SUPER_ADMIN"].includes(role) && (
            <Button onClick={() => act("research-approve")}>Research approve</Button>
          )}
          {claim.status === "RESEARCH_APPROVED" && ["FINANCE", "SUPER_ADMIN"].includes(role) && (
            <Button onClick={() => act("finance-approve")}>Finance approve</Button>
          )}
          {claim.status === "FINANCE_APPROVED" && ["FINANCE", "SUPER_ADMIN"].includes(role) && (
            <Button onClick={() => act("mark-paid", { voucher_number: voucher })}>Mark paid</Button>
          )}
          {!["PAID", "REJECTED", "DRAFT"].includes(claim.status) &&
            ["HOD", "RESEARCH_CELL", "FINANCE", "SUPER_ADMIN"].includes(role) && (
              <Button variant="danger" onClick={() => act("reject")}>
                Reject
              </Button>
            )}
        </div>
        {msg ? <p className="text-sm text-slate-600">{msg}</p> : null}
      </Card>

      <Card className="p-5">
        <div className="mb-2 text-sm font-medium">History</div>
        <ul className="space-y-2 text-sm">
          {(claim.actions || []).map((a) => (
            <li key={a.id} className="border-b border-slate-100 pb-2">
              <span className="font-medium">{a.action}</span> · {a.actor_name}
              <div className="text-xs text-slate-500">{a.created_at}</div>
              {a.note ? <div className="text-slate-600">{a.note}</div> : null}
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
