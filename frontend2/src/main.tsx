import { StrictMode } from "react"
import { MotionConfig } from "motion/react"
import { createRoot, type Root } from "react-dom/client"
import { BrowserRouter, Route, Routes } from "react-router-dom"
import { QueryClientProvider } from "@tanstack/react-query"
import { Toaster } from "sonner"

import { AuthProvider, useAuth } from "@/app/auth"
import { Palette, usePalette } from "@/app/palette"
import { ForcePasswordChange } from "@/app/password"
import { Shell } from "@/app/shell"
import { queryClient } from "@/lib/query"
import { FacultyHome } from "@/pages/home-faculty"
import { DirectorHome } from "@/pages/home-director"
import { FinanceHome, HodHome, OfficeHome, PrincipalHome } from "@/pages/home-staff"
import { Accreditation } from "@/pages/accreditation"
import { Approvals } from "@/pages/approvals"
import { Budget } from "@/pages/budget"
import { Calendar } from "@/pages/calendar"
import { Audit, Faults } from "@/pages/audit"
import { Authorisations } from "@/pages/authorisations"
import { Clearing } from "@/pages/clearing"
import { Data } from "@/pages/data"
import { Department } from "@/pages/department"
import { Collaborate } from "@/pages/collaborate"
import { Discover } from "@/pages/discover"
import { Discussions, Thread } from "@/pages/discussions"
import { Duplicates } from "@/pages/duplicates"
import { FilePaper } from "@/pages/file-paper"
import { Imports } from "@/pages/imports"
import { Gallery } from "@/pages/gallery"
import { PaperDetail } from "@/pages/paper-detail"
import { Journals, JournalRecord } from "@/pages/journals"
import { NotBuilt, NotFound } from "@/pages/not-found"
import { Batch, Batches } from "@/pages/batches"
import { Reference } from "@/pages/reference"
import { Ledger } from "@/pages/ledger"
import { Papers } from "@/pages/papers"
import { Payments, PaymentsDone } from "@/pages/payments"
import { Publications } from "@/pages/publications"
import { ReportBuilder } from "@/pages/report-builder"
import { Reports } from "@/pages/reports"
import { Requests } from "@/pages/requests"
import { People, Person } from "@/pages/people"
import { Policy } from "@/pages/policy"
import { Profile } from "@/pages/profile"
import { Programme } from "@/pages/programme"
import { SignIn } from "@/pages/sign-in"

import "@/styles.css"

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
      <Routes>
        {/* The gallery renders components against fixed props and asks the
            server for nothing, so it is reachable without signing in. It is
            how the components get looked at, and needing an account first is
            how a component gallery stops being used. Deleted before switch. */}
        <Route path="/gallery" element={<Gallery />} />
        <Route path="*" element={<SignIn />} />
      </Routes>
    )
  }

  return (
    <>
      <Routes>
        <Route element={<Shell onOpenPalette={() => palette.setOpen(true)} />}>
          <Route index element={<Home />} />
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
          <Route path="/audit" element={<Audit />} />
          <Route path="/faults" element={<Faults />} />
          <Route path="/people" element={<People />} />
          <Route path="/people/:id" element={<Person />} />
          <Route path="/requests" element={<Requests />} />
          <Route path="/budget" element={<Budget />} />
          <Route path="/policy" element={<Policy />} />
          <Route path="/reference" element={<Reference />} />
          <Route path="/imports" element={<Imports />} />
          <Route path="/batches" element={<Batches />} />
          <Route path="/batches/:id" element={<Batch />} />
          <Route path="/data" element={<Data />} />
          <Route path="/me" element={<Profile />} />
          {/* Not in the sidebar. Deleted before the switch. */}
          <Route path="/gallery" element={<Gallery />} />
          {/* Never a silent redirect home: see the note in not-found.tsx. */}
          <Route path="*" element={<NotFound />} />
        </Route>
      </Routes>
      <Palette open={palette.open} onClose={() => palette.setOpen(false)} />
      {/* Mounted here rather than on the profile page, because the accounts
          that owe a password change are precisely the ones who have never
          been to their profile. 498 of 508 live accounts carry the flag. */}
      <ForcePasswordChange />
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
