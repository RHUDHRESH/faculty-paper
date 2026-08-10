import { Navigate, Route, Routes } from "react-router-dom";
import { AuthProvider, useAuth } from "@/components/auth-provider";
import {
  AdminShell,
  FacultyShell,
  FinanceShell,
  HodShell,
  PrincipalShell,
  portalPath,
} from "@/components/app-shell";
import { LoginPage } from "@/pages/login";
import { FacultyClaimsPage, FacultyNewClaimPage } from "@/pages/portals/faculty";
import { FacultyProfilePage } from "@/pages/portals/profile";
import { HodQueuePage } from "@/pages/portals/hod";
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

function RequireAuth({
  children,
  portal,
}: {
  children: React.ReactNode;
  portal: "faculty" | "admin" | "finance" | "hod" | "principal";
}) {
  const { user, loading } = useAuth();
  if (loading) {
    return (
      <div className="flex min-h-svh items-center justify-center bg-background p-8">
        <div className="h-8 w-8 animate-pulse rounded-full bg-primary/20" />
      </div>
    );
  }
  if (!user) return <Navigate to="/login" replace />;
  const userPortal = user.portal || portalPathFromRole(user.role);
  if (
    userPortal !== portal &&
    !(user.role === "SUPER_ADMIN" && (portal === "admin" || portal === "finance" || portal === "hod" || portal === "principal"))
  ) {
    return <Navigate to={portalPath(userPortal)} replace />;
  }
  return <>{children}</>;
}

function portalPathFromRole(role: string) {
  if (role === "FINANCE") return "finance";
  if (role === "HOD") return "hod";
  if (role === "PRINCIPAL") return "principal";
  if (role === "FACULTY") return "faculty";
  return "admin";
}

function HomeRedirect() {
  const { user, loading } = useAuth();
  if (loading) {
    return (
      <div className="flex min-h-svh items-center justify-center bg-background p-8">
        <div className="h-8 w-8 animate-pulse rounded-full bg-primary/20" />
      </div>
    );
  }
  if (!user) return <Navigate to="/login" replace />;
  return <Navigate to={portalPath(user.portal || portalPathFromRole(user.role))} replace />;
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
          path="/hod"
          element={
            <RequireAuth portal="hod">
              <HodShell />
            </RequireAuth>
          }
        >
          <Route index element={<HodQueuePage />} />
        </Route>

        <Route
          path="/principal"
          element={
            <RequireAuth portal="principal">
              <PrincipalShell />
            </RequireAuth>
          }
        >
          <Route index element={<PrincipalQueuePage />} />
          <Route path="overview" element={<PrincipalOverviewPage />} />
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
          <Route path="submit" element={<AdminSubmitClaimPage />} />
          <Route path="monthly" element={<AdminMonthlyPage />} />
          <Route path="scimago" element={<AdminScimagoPage />} />
          <Route path="prior" element={<AdminPriorPage />} />
          <Route path="users" element={<AdminUsersPage />} />
          <Route path="formula" element={<AdminFormulaPage />} />
          <Route path="audit" element={<AdminAuditPage />} />
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
        </Route>

        <Route path="*" element={<HomeRedirect />} />
      </Routes>
    </AuthProvider>
  );
}
