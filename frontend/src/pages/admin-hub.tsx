import { Link } from "react-router-dom";
import { Card } from "@/components/ui/input";
import { useAuth } from "@/components/auth-provider";

export function AdminHubPage() {
  const { user } = useAuth();
  const role = user?.role || "";
  const tiles = [
    { href: "/admin/users", title: "Users", body: "Create and manage accounts", show: role === "SUPER_ADMIN" },
    { href: "/admin/formula", title: "Formula", body: "SNIP multiplier and quartile factors", show: role === "FINANCE" || role === "SUPER_ADMIN" },
    { href: "/admin/payouts", title: "Payouts", body: "Finance-approved queue", show: role === "FINANCE" || role === "SUPER_ADMIN" },
    { href: "/admin/prior", title: "Prior CSV", body: "Import already-paid rows", show: role === "RESEARCH_CELL" || role === "SUPER_ADMIN" },
    { href: "/admin/scimago", title: "Scimago", body: "Import yearly dump", show: role === "RESEARCH_CELL" || role === "SUPER_ADMIN" },
    { href: "/admin/audit", title: "Audit", body: "Recent admin actions", show: role === "RESEARCH_CELL" || role === "SUPER_ADMIN" },
  ].filter((t) => t.show);

  return (
    <div>
      <h1 className="mb-6 text-2xl font-semibold">Admin hub</h1>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {tiles.map((t) => (
          <Link key={t.href} to={t.href}>
            <Card className="h-full p-5 transition hover:border-[#0f4c5c]/40">
              <h3 className="font-medium">{t.title}</h3>
              <p className="mt-1 text-sm text-slate-600">{t.body}</p>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}
