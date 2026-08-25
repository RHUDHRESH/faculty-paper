import { StrictMode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom"
import { QueryClientProvider } from "@tanstack/react-query"
import { Toaster } from "sonner"

import { AuthProvider, useAuth } from "@/app/auth"
import { Palette, usePalette } from "@/app/palette"
import { Shell } from "@/app/shell"
import { queryClient } from "@/lib/query"
import { FacultyHome } from "@/pages/home-faculty"
import { Approvals } from "@/pages/approvals"
import { Audit, Faults } from "@/pages/audit"
import { Clearing } from "@/pages/clearing"
import { Collaborate } from "@/pages/collaborate"
import { Discover } from "@/pages/discover"
import { FilePaper } from "@/pages/file-paper"
import { Gallery } from "@/pages/gallery"
import { PaperDetail } from "@/pages/paper-detail"
import { Journals, JournalRecord } from "@/pages/journals"
import { Papers } from "@/pages/papers"
import { Payments, PaymentsDone } from "@/pages/payments"
import { Publications } from "@/pages/publications"
import { Reports } from "@/pages/reports"
import { Requests } from "@/pages/requests"
import { People, Person } from "@/pages/people"
import { Profile } from "@/pages/profile"
import { SignIn } from "@/pages/sign-in"

import "@/styles.css"

/**
 * One app, one router, one shell.
 *
 * There are no per-portal route trees here. A page is declared once and the
 * sidebar decides who can see it; the old app's three copies of Reports
 * existed only because each portal owned its own list of routes.
 */

function Placeholder({ name }: { name: string }) {
  return (
    <div className="page">
      <h1 className="text-xl font-semibold">{name}</h1>
      <p className="mt-1 text-base text-fg-muted">
        Not built yet. This page is next in the rebuild.
      </p>
    </div>
  )
}

function Home() {
  const { me } = useAuth()
  // Every role gets a different first screen, because they arrive with
  // different questions. Faculty is built; the rest are stubs for now.
  if (me?.role === "FACULTY") return <FacultyHome />
  return <Placeholder name="Home" />
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
          <Route path="/payments" element={<Payments />} />
          <Route path="/payments/done" element={<PaymentsDone />} />
          <Route path="/discover" element={<Discover />} />
          <Route path="/collaborate" element={<Collaborate />} />
          <Route path="/discussions" element={<Placeholder name="Discussions" />} />
          <Route path="/calendar" element={<Placeholder name="Calendar" />} />
          <Route path="/publications" element={<Publications />} />
          <Route path="/reports" element={<Reports />} />
          <Route path="/journals" element={<Journals />} />
          <Route path="/journals/:title" element={<JournalRecord />} />
          <Route path="/accreditation" element={<Placeholder name="Accreditation" />} />
          <Route path="/ledger" element={<Placeholder name="Ledger" />} />
          <Route path="/duplicates" element={<Placeholder name="Duplicates" />} />
          <Route path="/audit" element={<Audit />} />
          <Route path="/faults" element={<Faults />} />
          <Route path="/people" element={<People />} />
          <Route path="/people/:id" element={<Person />} />
          <Route path="/requests" element={<Requests />} />
          <Route path="/budget" element={<Placeholder name="Budget" />} />
          <Route path="/policy" element={<Placeholder name="Policy" />} />
          <Route path="/data" element={<Placeholder name="Data" />} />
          <Route path="/me" element={<Profile />} />
          {/* Not in the sidebar. Deleted before the switch. */}
          <Route path="/gallery" element={<Gallery />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
      <Palette open={palette.open} onClose={() => palette.setOpen(false)} />
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
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AuthProvider>
          <App />
          <Toaster position="bottom-right" toastOptions={{ duration: 4000 }} />
        </AuthProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>
)
