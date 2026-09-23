import { lazy, StrictMode, Suspense, type ComponentType } from "react"
import { MotionConfig } from "motion/react"
import { createRoot, type Root } from "react-dom/client"
import { BrowserRouter, Route, Routes } from "react-router-dom"
import { QueryClientProvider } from "@tanstack/react-query"
import { Toaster } from "sonner"

import { AuthProvider, useAuth } from "@/app/auth"
import { Palette, usePalette } from "@/app/palette"
import { ForcePasswordChange } from "@/app/password"
import { Shell } from "@/app/shell"
import { Shortcuts } from "@/app/shortcuts"
import { queryClient } from "@/lib/query"
import { SignIn } from "@/pages/sign-in"
import { NotBuilt, NotFound } from "@/pages/not-found"

import "@/styles.css"

/**
 * Every page loads when it is first opened, not on sign-in. A claimant never
 * downloads the Finance desk, and the first screen arrives in a fraction of
 * the old single bundle.
 */
function page<K extends string>(load: () => Promise<Record<K, ComponentType>>, name: K) {
  return lazy(() => load().then((m) => ({ default: m[name] })))
}
const FacultyHome = page(() => import("@/pages/home-faculty"), "FacultyHome")
const DirectorHome = page(() => import("@/pages/home-director"), "DirectorHome")
const FinanceHome = page(() => import("@/pages/home-staff"), "FinanceHome")
const HodHome = page(() => import("@/pages/home-staff"), "HodHome")
const OfficeHome = page(() => import("@/pages/home-staff"), "OfficeHome")
const PrincipalHome = page(() => import("@/pages/home-staff"), "PrincipalHome")
const Accreditation = page(() => import("@/pages/accreditation"), "Accreditation")
const Approvals = page(() => import("@/pages/approvals"), "Approvals")
const Budget = page(() => import("@/pages/budget"), "Budget")
const Calendar = page(() => import("@/pages/calendar"), "Calendar")
const Audit = page(() => import("@/pages/audit"), "Audit")
const Faults = page(() => import("@/pages/audit"), "Faults")
const Authorisations = page(() => import("@/pages/authorisations"), "Authorisations")
const Clearing = page(() => import("@/pages/clearing"), "Clearing")
const Data = page(() => import("@/pages/data"), "Data")
const Department = page(() => import("@/pages/department"), "Department")
const Collaborate = page(() => import("@/pages/collaborate"), "Collaborate")
const Discover = page(() => import("@/pages/discover"), "Discover")
const Discussions = page(() => import("@/pages/discussions"), "Discussions")
const Thread = page(() => import("@/pages/discussions"), "Thread")
const Duplicates = page(() => import("@/pages/duplicates"), "Duplicates")
const Flags = page(() => import("@/pages/flags"), "Flags")
const PastClaims = page(() => import("@/pages/archive"), "PastClaims")
const FilePaper = page(() => import("@/pages/file-paper"), "FilePaper")
const Imports = page(() => import("@/pages/imports"), "Imports")
const Gallery = page(() => import("@/pages/gallery"), "Gallery")
const Privacy = page(() => import("@/pages/privacy"), "Privacy")
const PaperDetail = page(() => import("@/pages/paper-detail"), "PaperDetail")
const Journals = page(() => import("@/pages/journals"), "Journals")
const JournalRecord = page(() => import("@/pages/journals"), "JournalRecord")
const Batch = page(() => import("@/pages/batches"), "Batch")
const Batches = page(() => import("@/pages/batches"), "Batches")
const Reference = page(() => import("@/pages/reference"), "Reference")
const Ledger = page(() => import("@/pages/ledger"), "Ledger")
const Papers = page(() => import("@/pages/papers"), "Papers")
const Payments = page(() => import("@/pages/payments"), "Payments")
const PaymentsDone = page(() => import("@/pages/payments"), "PaymentsDone")
const Publications = page(() => import("@/pages/publications"), "Publications")
const ReportBuilder = page(() => import("@/pages/report-builder"), "ReportBuilder")
const Reports = page(() => import("@/pages/reports"), "Reports")
const Requests = page(() => import("@/pages/requests"), "Requests")
const Search = page(() => import("@/pages/search"), "Search")
const People = page(() => import("@/pages/people"), "People")
const Person = page(() => import("@/pages/people"), "Person")
const Policy = page(() => import("@/pages/policy"), "Policy")
const Profile = page(() => import("@/pages/profile"), "Profile")
const Programme = page(() => import("@/pages/programme"), "Programme")
const Setup = page(() => import("@/pages/setup"), "Setup")
const InstitutionSettings = page(() => import("@/pages/institution-settings"), "InstitutionSettings")

/**
 * One app, one router, one shell.
 *
 * There are no per-portal route trees here. A page is declared once and the
 * sidebar decides who can see it; the old app's three copies of Reports
 * existed only because each portal owned its own list of routes.
 */

function Home() {
  const { me } = useAuth()
  // Every role gets a different first screen, because they arrive with
  // different questions: a claimant asks where their money is, the office
  // asks what is stuck, the Principal asks what is waiting on them, Finance
  // asks what is payable, and a head asks what their department published.
  // One screen answering all five answers none of them.
  switch (me?.role) {
    case "FACULTY":
      return <FacultyHome />
    case "PRINCIPAL":
      return <PrincipalHome />
    case "DIRECTOR":
      return <DirectorHome />
    case "FINANCE":
      return <FinanceHome />
    case "HOD":
      return <HodHome />
    case "RESEARCH_CELL":
    case "RESEARCH_COORDINATOR":
    case "SUPER_ADMIN":
      return <OfficeHome />
    default:
      // No role at all means a session this app cannot place. That is not a
      // screen waiting to be built, so it is not dressed up as one.
      return (
        <NotBuilt
          name="Home"
          needs="This account has no role on it, so there is no home page to show. An account is given a role when it is created; if this one has lost it, the research cell can put it back."
        />
      )
  }
}

function App() {
  const { me, loading } = useAuth()
  const palette = usePalette()

  if (loading) {
    return (
      <div className="grid min-h-svh place-items-center">
        <span className="size-5 animate-spin rounded-full border-2 border-line border-t-accent" />
      </div>
    )
  }

  if (!me) {
    return (
      <Suspense fallback={null}>
      <Routes>
        {/* The component gallery is a development tool: absent from a
            production build, so it cannot be reached without an account. */}
        {import.meta.env.DEV && <Route path="/gallery" element={<Gallery />} />}
        {/* First-run setup: reachable only while the system has no accounts,
            and the page itself says "already set up" otherwise. */}
        <Route path="/setup" element={<Setup />} />
        <Route path="/privacy" element={<Privacy />} />
        <Route path="*" element={<SignIn />} />
      </Routes>
      </Suspense>
    )
  }

  return (
    <>
      <Routes>
        <Route element={<Shell onOpenPalette={() => palette.setOpen(true)} />}>
          <Route index element={<Home />} />
          <Route path="/search" element={<Search />} />
          <Route path="/papers" element={<Papers />} />
          <Route path="/papers/new" element={<FilePaper />} />
          <Route path="/papers/:id/edit" element={<FilePaper />} />
          <Route path="/papers/:id" element={<PaperDetail />} />
          <Route path="/clearing" element={<Clearing />} />
          <Route path="/approvals" element={<Approvals />} />
          <Route path="/authorisations" element={<Authorisations />} />
          <Route path="/payments" element={<Payments />} />
          <Route path="/payments/done" element={<PaymentsDone />} />
          <Route path="/programme" element={<Programme />} />
          <Route path="/discover" element={<Discover />} />
          <Route path="/collaborate" element={<Collaborate />} />
          <Route path="/discussions" element={<Discussions />} />
          <Route path="/discussions/:id" element={<Thread />} />
          <Route path="/calendar" element={<Calendar />} />
          <Route path="/department" element={<Department />} />
          <Route path="/publications" element={<Publications />} />
          <Route path="/reports" element={<Reports />} />
          <Route path="/reports/build" element={<ReportBuilder />} />
          <Route path="/journals" element={<Journals />} />
          <Route path="/journals/:title" element={<JournalRecord />} />
          <Route path="/accreditation" element={<Accreditation />} />
          <Route path="/ledger" element={<Ledger />} />
          <Route path="/duplicates" element={<Duplicates />} />
          <Route path="/flags" element={<Flags />} />
          <Route path="/archive" element={<PastClaims />} />
          <Route path="/audit" element={<Audit />} />
          <Route path="/faults" element={<Faults />} />
          <Route path="/people" element={<People />} />
          <Route path="/people/:id" element={<Person />} />
          <Route path="/requests" element={<Requests />} />
          <Route path="/budget" element={<Budget />} />
          <Route path="/policy" element={<Policy />} />
          <Route path="/settings" element={<InstitutionSettings />} />
          <Route path="/reference" element={<Reference />} />
          <Route path="/imports" element={<Imports />} />
          <Route path="/batches" element={<Batches />} />
          <Route path="/batches/:id" element={<Batch />} />
          <Route path="/data" element={<Data />} />
          <Route path="/me" element={<Profile />} />
          <Route path="/privacy" element={<Privacy />} />
          {import.meta.env.DEV && <Route path="/gallery" element={<Gallery />} />}
          {/* Never a silent redirect home: see the note in not-found.tsx. */}
          <Route path="*" element={<NotFound />} />
        </Route>
      </Routes>
      <Palette open={palette.open} onClose={() => palette.setOpen(false)} />
      {/* Mounted here rather than on the profile page, because the accounts
          that owe a password change are precisely the ones who have never
          been to their profile. 498 of 508 live accounts carry the flag. */}
      <ForcePasswordChange />
      <Shortcuts />
    </>
  )
}

/**
 * One root, kept across hot reloads.
 *
 * Vite re-evaluates this module on every edit, and a bare `createRoot` call
 * therefore builds a second React root over the same element. The two then
 * fight for the same DOM nodes and the console fills with
 * `removeChild: The node to be removed is not a child of this node` — after
 * which effects in the losing tree silently stop taking, which looks exactly
 * like a component that does not work.
 */
const container = document.getElementById("root")!
const root = (window as unknown as { __root?: Root }).__root ?? createRoot(container)
;(window as unknown as { __root?: Root }).__root = root

root.render(
  <StrictMode>
    {/* Reduced motion, applied to everything at once.
        `styles.css` caps `animation-duration` and `transition-duration` under
        `prefers-reduced-motion`, which reaches CSS and nothing else --
        `motion/react` drives the Web Animations API, which that rule never
        touches. So every JS-animated surface in the app was ignoring the
        setting outright. Components that ask `useReducedMotion()` themselves
        were already correct; this covers the ones that forget, including any
        added later. */}
    <MotionConfig reducedMotion="user">
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AuthProvider>
          <App />
          <Toaster position="bottom-right" toastOptions={{ duration: 4000 }} />
        </AuthProvider>
      </BrowserRouter>
    </QueryClientProvider>
    </MotionConfig>
  </StrictMode>
)
