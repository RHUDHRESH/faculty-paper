import { useEffect, useState } from "react"
import { Link, Navigate, Route, Routes } from "react-router-dom";
import { AuthProvider, useAuth } from "@/components/auth-provider";
import {
  AdminShell,
  FacultyShell,
  FinanceShell,
  PrincipalShell,
  portalPath,
} from "@/components/app-shell";
import { LoginPage } from "@/pages/login";
import { FacultyClaimsPage, FacultyNewClaimPage } from "@/pages/portals/faculty";
import { FacultyProfilePage } from "@/pages/portals/profile";
import { AdminClearingQueuePage } from "@/pages/portals/review-queue";
import { ReportsPage } from "@/pages/portals/reports";
import { SearchPage } from "@/pages/portals/search";
import { AdminFaultsPage } from "@/pages/portals/faults";
import { LookupPage } from "@/pages/portals/lookup";
import { PrincipalApprovalsPage } from "@/pages/portals/principal-approvals";
import { PrincipalOverviewPage, PrincipalQueuePage } from "@/pages/portals/principal";
import {
  AdminApprovalsPage,
  AdminAuditPage,
  AdminFormulaPage,
  AdminMonthlyPage,
  AdminPriorPage,
  AdminScimagoPage,
  AdminUsersPage,
} from "@/pages/portals/admin";
import { AdminSubmitClaimPage } from "@/pages/portals/admin-submit";
import { FinanceLedgerPage, FinancePaidPage, FinancePayoutsPage } from "@/pages/portals/finance";

function BootSpinner() {
  const [slow, setSlow] = useState(false)
  useEffect(() => {
    const t = window.setTimeout(() => setSlow(true), 2500)
    return () => window.clearTimeout(t)
  }, [])
  return (
    <div className="flex min-h-svh flex-col items-center justify-center gap-3 bg-background p-8">
      <div className="h-8 w-8 animate-pulse rounded-full bg-primary/20" />
      {slow ? (
        <p className="max-w-sm text-center text-sm text-muted-foreground">
          Waking the server. The first request after idle can take up to half a minute.
        </p>
      ) : null}
    </div>
  )
}

function RequireAuth({
  children,
  portal,
}: {
  children: React.ReactNode;
  portal: "faculty" | "admin" | "finance" | "principal";
}) {
  const { user, loading } = useAuth();
  if (loading) return <BootSpinner />;
  if (!user) return <Navigate to="/login" replace />;
  const userPortal = user.portal || portalPathFromRole(user.role);
  if (
    userPortal !== portal &&
    !(user.role === "SUPER_ADMIN" && (portal === "admin" || portal === "finance" || portal === "principal"))
  ) {
    return <Navigate to={portalPath(userPortal)} replace />;
  }
  return <>{children}</>;
}

function portalPathFromRole(role: string) {
  if (role === "FINANCE") return "finance";
  if (role === "PRINCIPAL") return "principal";
  if (role === "FACULTY") return "faculty";
  return "admin";
}

function HomeRedirect() {
  const { user, loading } = useAuth();
  if (loading) return <BootSpinner />;
  if (!user) return <Navigate to="/login" replace />;
  return <Navigate to={portalPath(user.portal || portalPathFromRole(user.role))} replace />;
}

/** A typo'd URL used to bounce silently to the portal index, which made bad
 * links (in emails, chats, bookmarks) indistinguishable from working ones. */
function NotFoundPage() {
  const { user, loading } = useAuth();
  const home =
    user ? portalPath(user.portal || portalPathFromRole(user.role)) : "/login";
  if (loading) return null;
  return (
    <div className="flex min-h-svh flex-col items-center justify-center gap-4 bg-background p-8 text-center">
      <p className="font-mono text-sm text-muted-foreground">404</p>
      <h1 className="text-2xl font-semibold tracking-tight">This page does not exist</h1>
      <p className="max-w-sm text-sm text-muted-foreground">
        The link may be misspelt or out of date. Your tickets and queues are unaffected.
      </p>
      <Link
        to={home}
        className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
      >
        {user ? "Go to my portal" : "Go to sign in"}
      </Link>
    </div>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/" element={<HomeRedirect />} />

        <Route
          path="/faculty"
          element={
            <RequireAuth portal="faculty">
              <FacultyShell />
            </RequireAuth>
          }
        >
          <Route index element={<FacultyClaimsPage />} />
          <Route path="new" element={<FacultyNewClaimPage />} />
          <Route path="profile" element={<FacultyProfilePage />} />
        </Route>


        <Route
          path="/principal"
          element={
            <RequireAuth portal="principal">
              <PrincipalShell />
            </RequireAuth>
          }
        >
          {/* Approvals first: it is the one thing only this account can do. */}
          <Route index element={<PrincipalApprovalsPage />} />
          <Route path="all" element={<PrincipalQueuePage />} />
          <Route path="overview" element={<PrincipalOverviewPage />} />
          <Route path="reports" element={<ReportsPage />} />
          <Route path="find" element={<LookupPage />} />
          <Route path="query" element={<SearchPage />} />
        </Route>

        <Route
          path="/admin"
          element={
            <RequireAuth portal="admin">
              <AdminShell />
            </RequireAuth>
          }
        >
          <Route index element={<AdminApprovalsPage />} />
          {/* The one approval step in the chain. */}
          <Route path="clearing" element={<AdminClearingQueuePage />} />
          <Route path="submit" element={<AdminSubmitClaimPage />} />
          <Route path="monthly" element={<AdminMonthlyPage />} />
          <Route path="scimago" element={<AdminScimagoPage />} />
          <Route path="prior" element={<AdminPriorPage />} />
          <Route path="users" element={<AdminUsersPage />} />
          <Route path="formula" element={<AdminFormulaPage />} />
          <Route path="reports" element={<ReportsPage />} />
          <Route path="query" element={<SearchPage />} />
          <Route path="audit" element={<AdminAuditPage />} />
          <Route path="faults" element={<AdminFaultsPage />} />
          <Route path="find" element={<LookupPage />} />
        </Route>

        <Route
          path="/finance"
          element={
            <RequireAuth portal="finance">
              <FinanceShell />
            </RequireAuth>
          }
        >
          <Route index element={<FinancePayoutsPage />} />
          <Route path="paid" element={<FinancePaidPage />} />
          <Route path="ledger" element={<FinanceLedgerPage />} />
          <Route path="find" element={<LookupPage />} />
          <Route path="reports" element={<ReportsPage />} />
          <Route path="query" element={<SearchPage />} />
          {/* Editing the pay policy needs FINANCE or SUPER_ADMIN, so the screen
              has to be reachable from the Finance portal too. */}
          <Route path="formula" element={<AdminFormulaPage />} />
        </Route>

        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </AuthProvider>
  );
}
