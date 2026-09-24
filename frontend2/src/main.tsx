import {
  lazy,
  StrictMode,
  Suspense,
  useEffect,
  useRef,
  useState,
  type ComponentType,
  type LazyExoticComponent,
} from "react"
import { MotionConfig } from "motion/react"
import { createRoot, type Root } from "react-dom/client"
import { BrowserRouter, matchPath, Route, Routes } from "react-router-dom"
import { QueryClientProvider } from "@tanstack/react-query"

import { AuthProvider, useAuth, type Role } from "@/app/auth"
import { prefetchHome } from "@/app/home-data"
import { usePalette } from "@/app/palette-hook"
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
 *
 * Each page can also be asked for early (`preload`): the page a visit starts
 * on is fetched at the same moment as the session, not after it, and a link
 * starts fetching its page when it is pointed at.
 */
type Page = LazyExoticComponent<ComponentType> & { preload: () => Promise<unknown> }

function page<K extends string>(load: () => Promise<Record<K, ComponentType>>, name: K): Page {
  let loading: Promise<Record<K, ComponentType>> | null = null
  // One fetch however many times it is asked for; a failed one is forgotten
  // so the next attempt can succeed.
  const once = () =>
    (loading ??= load().catch((err) => {
      loading = null
      throw err
    }))
  const component = lazy(() => once().then((m) => ({ default: m[name] }))) as Page
  component.preload = once
  return component
}

// Only on demand: the palette on Ctrl K, the password dialog for an account
// that owes a change, the toaster once the first screen is up. Each brought
// the animation library or its own weight onto the path to the first paint.
const Palette = lazy(() => import("@/app/palette").then((m) => ({ default: m.Palette })))
const ForcePasswordChange = lazy(() =>
  import("@/app/password").then((m) => ({ default: m.ForcePasswordChange }))
)
const Toaster = lazy(() => import("sonner").then((m) => ({ default: m.Toaster })))
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
const Feed = page(() => import("@/pages/feed"), "Feed")
const FeedPostPage = page(() => import("@/pages/feed"), "PostPage")
const Messages = page(() => import("@/pages/discussions"), "Messages")
const Thread = page(() => import("@/pages/discussions"), "Thread")
const ChatPage = page(() => import("@/pages/chat"), "ChatPage")
const CollegeNetwork = page(() => import("@/pages/network"), "CollegeNetwork")
const MyStats = page(() => import("@/pages/stats"), "MyStats")
const PublicProfile = page(() => import("@/pages/person"), "PublicProfile")
const PeopleDirectory = page(() => import("@/pages/person"), "PeopleDirectory")
const CollegeResearch = page(() => import("@/pages/programme"), "CollegeResearch")
const Duplicates = page(() => import("@/pages/duplicates"), "Duplicates")
const Flags = page(() => import("@/pages/flags"), "Flags")
const PastClaims = page(() => import("@/pages/archive"), "PastClaims")
const FilePaper = page(() => import("@/pages/file-paper"), "FilePaper")
const Imports = page(() => import("@/pages/imports"), "Imports")
const Gallery = page(() => import("@/pages/gallery"), "Gallery")
const Privacy = page(() => import("@/pages/privacy"), "Privacy")
const PaperDetail = page(() => import("@/pages/paper-detail"), "PaperDetail")
const Journals = page(() => import("@/pages/journals"), "Journals")
const Leaderboard = page(() => import("@/pages/leaderboard"), "Leaderboard")
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
const WallOfFame = page(() => import("@/pages/wall"), "WallOfFame")
const ImpactCardPage = page(() => import("@/pages/impact"), "ImpactCardPage")
const GoalsPage = page(() => import("@/pages/goals"), "GoalsPage")
const NotificationsPage = page(() => import("@/pages/notifications"), "NotificationsPage")
const NotificationSettings = page(() => import("@/pages/notification-settings"), "NotificationSettings")

const HOMES: Record<Role, Page> = {
  FACULTY: FacultyHome,
  HOD: HodHome,
  PRINCIPAL: PrincipalHome,
  DIRECTOR: DirectorHome,
  FINANCE: FinanceHome,
  RESEARCH_CELL: OfficeHome,
  RESEARCH_COORDINATOR: OfficeHome,
  SUPER_ADMIN: OfficeHome,
}

/** Path to page, for fetching a page's code before it is rendered. More
 *  specific patterns first; the routes themselves are declared below. */
const PRELOADS: [string, Page][] = [
  ["/papers/new", FilePaper],
  ["/papers/:id/edit", FilePaper],
  ["/papers/:id", PaperDetail],
  ["/papers", Papers],
  ["/search", Search],
  ["/clearing", Clearing],
  ["/approvals", Approvals],
  ["/authorisations", Authorisations],
  ["/payments/done", PaymentsDone],
  ["/payments", Payments],
  ["/programme", Programme],
  ["/discover", Discover],
  ["/collaborate", Collaborate],
  ["/discussions/p/:id", FeedPostPage],
  ["/discussions/:id", Thread],
  ["/discussions", Feed],
  ["/messages/c/:id", ChatPage],
  ["/messages/:id", Thread],
  ["/network", CollegeNetwork],
  ["/u/me/stats", MyStats],
  ["/messages", Messages],
  ["/u/:id", PublicProfile],
  ["/u", PeopleDirectory],
  ["/research", CollegeResearch],
  ["/leaderboard", Leaderboard],
  ["/wall", WallOfFame],
  ["/impact", ImpactCardPage],
  ["/goals", GoalsPage],
  ["/calendar", Calendar],
  ["/department", Department],
  ["/publications", Publications],
  ["/reports/build", ReportBuilder],
  ["/reports", Reports],
  ["/journals/:title", JournalRecord],
  ["/journals", Journals],
  ["/accreditation", Accreditation],
  ["/ledger", Ledger],
  ["/duplicates", Duplicates],
  ["/flags", Flags],
  ["/archive", PastClaims],
  ["/audit", Audit],
  ["/faults", Faults],
  ["/people/:id", Person],
  ["/people", People],
  ["/requests", Requests],
  ["/budget", Budget],
  ["/policy", Policy],
  ["/settings", InstitutionSettings],
  ["/reference", Reference],
  ["/imports", Imports],
  ["/batches/:id", Batch],
  ["/batches", Batches],
  ["/data", Data],
  ["/me", Profile],
]

const LAST_ROLE = "last-role"

function rememberedRole(): Role | null {
  try {
    return (localStorage.getItem(LAST_ROLE) as Role | null) || null
  } catch {
    return null
  }
}

/** Start fetching the code for `pathname`. Home depends on who is asking,
 *  so it is guessed from the role this device last signed in with. */
function preloadPath(pathname: string, role: Role | null | undefined) {
  if (pathname === "/") {
    if (role && HOMES[role]) void HOMES[role].preload().catch(() => {})
    return
  }
  const hit = PRELOADS.find(([pattern]) => matchPath(pattern, pathname))
  if (hit) void hit[1].preload().catch(() => {})
}

// At boot, before the session has answered: the two travel together instead
// of one after the other.
preloadPath(window.location.pathname, rememberedRole())

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
  // Fetched the first time it is opened, and kept thereafter so it can close
  // with its animation.
  const paletteWanted = useRef(false)
  if (palette.open) paletteWanted.current = true

  useEffect(() => {
    if (!me?.role) return
    // The home's data, asked for alongside the home's code rather than after
    // it has arrived; only when the visit starts at home.
    if (window.location.pathname === "/") prefetchHome(me.role)
    try {
      localStorage.setItem(LAST_ROLE, me.role)
    } catch {
      /* a guess for next time, nothing more */
    }
  }, [me?.role])

  if (loading) {
    // Identical to the placeholder index.html paints before any script runs,
    // so the hand-over is invisible.
    return (
      <div className="grid min-h-svh place-content-center justify-items-center gap-3" aria-busy="true">
        <span className="size-5 animate-spin rounded-full border-2 border-line border-t-accent" />
        <span className="text-sm text-fg-subtle">Loading…</span>
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
        <Route
          element={
            <Shell
              onOpenPalette={() => palette.setOpen(true)}
              onPreload={(to) => preloadPath(to, me.role)}
            />
          }
        >
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
          <Route path="/research" element={<CollegeResearch />} />
          <Route path="/discover" element={<Discover />} />
          <Route path="/collaborate" element={<Collaborate />} />
          <Route path="/leaderboard" element={<Leaderboard />} />
          <Route path="/discussions" element={<Feed />} />
          <Route path="/discussions/p/:id" element={<FeedPostPage />} />
          {/* Old thread links (and notifications carrying them) still land:
              a private one opens, an open one is sent on to its post. */}
          <Route path="/discussions/:id" element={<Thread />} />
          <Route path="/messages" element={<Messages />} />
          <Route path="/messages/c/:id" element={<ChatPage />} />
          <Route path="/messages/:id" element={<Thread />} />
          <Route path="/network" element={<CollegeNetwork />} />
          <Route path="/u" element={<PeopleDirectory />} />
          <Route path="/u/me/stats" element={<MyStats />} />
          <Route path="/u/:id" element={<PublicProfile />} />
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
          <Route path="/settings/notifications" element={<NotificationSettings />} />
          <Route path="/notifications" element={<NotificationsPage />} />
          <Route path="/reference" element={<Reference />} />
          <Route path="/imports" element={<Imports />} />
          <Route path="/batches" element={<Batches />} />
          <Route path="/batches/:id" element={<Batch />} />
          <Route path="/data" element={<Data />} />
          <Route path="/me" element={<Profile />} />
          <Route path="/wall" element={<WallOfFame />} />
          <Route path="/impact" element={<ImpactCardPage />} />
          <Route path="/goals" element={<GoalsPage />} />
          <Route path="/privacy" element={<Privacy />} />
          {import.meta.env.DEV && <Route path="/gallery" element={<Gallery />} />}
          {/* Never a silent redirect home: see the note in not-found.tsx. */}
          <Route path="*" element={<NotFound />} />
        </Route>
      </Routes>
      {paletteWanted.current && (
        <Suspense fallback={null}>
          <Palette open={palette.open} onClose={() => palette.setOpen(false)} />
        </Suspense>
      )}
      {/* Mounted here rather than on the profile page, because the accounts
          that owe a password change are precisely the ones who have never
          been to their profile. 498 of 508 live accounts carry the flag. */}
      {me.must_change_password && !me.impersonated_by && (
        <Suspense fallback={null}>
          <ForcePasswordChange />
        </Suspense>
      )}
      <Shortcuts />
    </>
  )
}

/**
 * The toaster, once the first screen is up. Nothing toasts before somebody
 * has pressed something, so it has no business competing with the first
 * page for the network.
 */
function LateToaster() {
  const [ready, setReady] = useState(false)
  useEffect(() => {
    const idle = window.requestIdleCallback ?? ((fn: () => void) => window.setTimeout(fn, 1200))
    idle(() => setReady(true))
  }, [])
  if (!ready) return null
  return (
    <Suspense fallback={null}>
      <Toaster position="bottom-right" toastOptions={{ duration: 4000 }} />
    </Suspense>
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
          <LateToaster />
        </AuthProvider>
      </BrowserRouter>
    </QueryClientProvider>
    </MotionConfig>
  </StrictMode>
)
