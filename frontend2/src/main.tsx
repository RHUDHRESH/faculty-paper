import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom"
import { QueryClientProvider } from "@tanstack/react-query"
import { Toaster } from "sonner"

import { AuthProvider, useAuth } from "@/app/auth"
import { Palette, usePalette } from "@/app/palette"
import { Shell } from "@/app/shell"
import { queryClient } from "@/lib/query"
import { FacultyHome } from "@/pages/home-faculty"
import { Gallery } from "@/pages/gallery"
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
          <Route path="/papers" element={<Placeholder name="My papers" />} />
          <Route path="/papers/new" element={<Placeholder name="File a paper" />} />
          <Route path="/papers/:id" element={<Placeholder name="Paper" />} />
          <Route path="/clearing" element={<Placeholder name="Clearing queue" />} />
          <Route path="/approvals" element={<Placeholder name="Approvals" />} />
          <Route path="/payments" element={<Placeholder name="Payment orders" />} />
          <Route path="/discover" element={<Placeholder name="Discover" />} />
          <Route path="/collaborate" element={<Placeholder name="Who to work with" />} />
          <Route path="/discussions" element={<Placeholder name="Discussions" />} />
          <Route path="/calendar" element={<Placeholder name="Calendar" />} />
          <Route path="/publications" element={<Placeholder name="Publications" />} />
          <Route path="/reports" element={<Placeholder name="Reports" />} />
          <Route path="/journals" element={<Placeholder name="Journals" />} />
          <Route path="/accreditation" element={<Placeholder name="Accreditation" />} />
          <Route path="/ledger" element={<Placeholder name="Ledger" />} />
          <Route path="/duplicates" element={<Placeholder name="Duplicates" />} />
          <Route path="/audit" element={<Placeholder name="Audit log" />} />
          <Route path="/people" element={<Placeholder name="People" />} />
          <Route path="/people/:id" element={<Placeholder name="Person" />} />
          <Route path="/requests" element={<Placeholder name="Profile requests" />} />
          <Route path="/budget" element={<Placeholder name="Budget" />} />
          <Route path="/policy" element={<Placeholder name="Policy" />} />
          <Route path="/data" element={<Placeholder name="Data" />} />
          <Route path="/me" element={<Placeholder name="Your profile" />} />
          {/* Not in the sidebar. Deleted before the switch. */}
          <Route path="/gallery" element={<Gallery />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
      <Palette open={palette.open} onClose={() => palette.setOpen(false)} />
    </>
  )
}

createRoot(document.getElementById("root")!).render(
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
