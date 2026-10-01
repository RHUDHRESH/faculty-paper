import {
  lazy,
  StrictMode,
  Suspense,
  useEffect,
  useRef,
  useState,
  type ComponentType,
  type LazyExoticComponent,
  type ReactNode,
} from "react"
import { MotionConfig } from "motion/react"
import { createRoot, type Root } from "react-dom/client"
import { BrowserRouter, matchPath, Navigate, Route, Routes, useParams } from "react-router-dom"
import { QueryClientProvider } from "@tanstack/react-query"

import { AuthProvider, useAuth, type Role } from "@/app/auth"
import { REDIRECTS } from "@/app/nav"
import { prefetchHome } from "@/app/home-data"
import { usePalette } from "@/app/palette-hook"
import { Shell } from "@/app/shell"
import { Shortcuts } from "@/app/shortcuts"
import { queryClient } from "@/lib/query"
import { SignIn } from "@/pages/sign-in"
import { NotBuilt, NotFound, RoleGate } from "@/pages/not-found"
import { CrashGuard } from "@/pages/crash"

import "@/styles.css"
import "@/ui/motion/motion.css"

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
const FinanceHome = page(() => import("@/pages/home-finance"), "FinanceHome")
const HodHome = page(() => import("@/pages/home-hod"), "HodHome")
const OfficeHome = page(() => import("@/pages/home-staff"), "OfficeHome")
const AdminHome = page(() => import("@/pages/home-admin"), "AdminHome")
const PrincipalHome = page(() => import("@/pages/home-staff"), "PrincipalHome")
const Accreditation = page(() => import("@/pages/accreditation"), "Accreditation")
const Approvals = page(() => import("@/pages/approvals"), "Approvals")
const Budget = page(() => import("@/pages/budget"), "Budget")
const Calendar = page(() => import("@/pages/calendar"), "Calendar")
const Audit = page(() => import("@/pages/audit"), "Audit")
const Faults = page(() => import("@/pages/faults"), "Faults")
const DataFixes = page(() => import("@/pages/data-fixes"), "DataFixes")
const Calculator = page(() => import("@/pages/calculator"), "Calculator")
const Jobs = page(() => import("@/pages/jobs"), "Jobs")
const Help = page(() => import("@/pages/help"), "Help")
const Authorisations = page(() => import("@/pages/authorisations"), "Authorisations")
const Clearing = page(() => import("@/pages/clearing"), "Clearing")
const Coordination = page(() => import("@/pages/coordination"), "Coordination")
const ReviewWorkspace = page(() => import("@/pages/review/review-workspace"), "ReviewWorkspace")
const Data = page(() => import("@/pages/data"), "Data")
const DataHealth = page(() => import("@/pages/data-health"), "DataHealth")
const RecordQuality = page(() => import("@/pages/record-quality"), "RecordQuality")
const HodPaper = page(() => import("@/pages/hod-paper"), "HodPaper")
const Department = page(() => import("@/pages/department"), "Department")
const Collaborate = page(() => import("@/pages/collaborate"), "Collaborate")
const Discover = page(() => import("@/pages/discover"), "Discover")
const Feed = page(() => import("@/pages/feed"), "Feed")
const FeedPostPage = page(() => import("@/pages/feed"), "PostPage")
const Messages = page(() => import("@/pages/messages"), "MessagesStart")
const MessagesOffice = page(() => import("@/pages/messages"), "MessagesOffice")
const MessagesOfficeThread = page(() => import("@/pages/messages"), "MessagesOfficeThread")
const Thread = page(() => import("@/pages/discussions"), "Thread")
const ChatPage = page(() => import("@/pages/messages"), "MessagesChat")
const MyStats = page(() => import("@/pages/stats"), "MyStats")
const PublicProfile = page(() => import("@/pages/person"), "PublicProfile")
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
const Statements = page(() => import("@/pages/statements"), "Statements")
const Papers = page(() => import("@/pages/papers"), "Papers")
const ClaimsList = page(() => import("@/pages/claims-list"), "ClaimsList")
const AppraisalList = page(() => import("@/pages/my-record"), "AppraisalList")
const PaymentStatement = page(() => import("@/pages/my-record"), "PaymentStatement")
const Payments = page(() => import("@/pages/payments"), "Payments")
const PaymentsDone = page(() => import("@/pages/payments"), "PaymentsDone")
const Publications = page(() => import("@/pages/publications"), "Publications")
const ReportBuilder = page(() => import("@/pages/report-builder"), "ReportBuilder")
const Reports = page(() => import("@/pages/reports"), "Reports")
const Track = page(() => import("@/pages/track"), "Track")
const AdminHub = page(() => import("@/pages/hub"), "AdminHub")
const MoneyHub = page(() => import("@/pages/hub"), "MoneyHub")
const ReportsHub = page(() => import("@/pages/hub"), "ReportsHub")
const YearBrief = page(() => import("@/pages/brief"), "YearBrief")
const Departments = page(() => import("@/pages/departments"), "Departments")
const DepartmentPage = page(() => import("@/pages/departments"), "DepartmentPage")
const ReportPapers = page(() => import("@/pages/report-papers"), "ReportPapers")
const Requests = page(() => import("@/pages/requests"), "Requests")
const Search = page(() => import("@/pages/search"), "Search")
const People = page(() => import("@/pages/people"), "People")
const ResearchFaculty = page(() => import("@/pages/research-faculty"), "ResearchFaculty")
const AuthorMatches = page(() => import("@/pages/author-matches"), "AuthorMatches")
const FacultyDirectory = page(() => import("@/pages/faculty"), "FacultyDirectory")
const FacultyRecord = page(() => import("@/pages/faculty-record"), "FacultyRecord")
const Person = page(() => import("@/pages/people"), "Person")
const PeoplePasswords = page(() => import("@/pages/people"), "PeoplePasswords")
const Policy = page(() => import("@/pages/policy"), "Policy")
const Profile = page(() => import("@/pages/profile"), "Profile")
const Research = page(() => import("@/pages/research"), "Research")
const Scout = page(() => import("@/pages/scout"), "Scout")
const Setup = page(() => import("@/pages/setup"), "Setup")
const InstitutionSettings = page(() => import("@/pages/institution-settings"), "InstitutionSettings")
const WallOfFame = page(() => import("@/pages/wall"), "WallOfFame")
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
  SUPER_ADMIN: AdminHome,
}

/** Path to page, for fetching a page's code before it is rendered. More
 *  specific patterns first; the routes themselves are declared below. */

const PRELOADS: [string, Page][] = [
  ["/papers/claims", ClaimsList],
  ["/papers/appraisal", AppraisalList],
  ["/papers/statement", PaymentStatement],
  ["/papers/new", FilePaper],
  ["/papers/:id/edit", FilePaper],
  ["/papers/:id", PaperDetail],
  ["/papers", Papers],
  ["/search", Search],
  ["/review/:claimId", ReviewWorkspace],
  ["/clearing", Clearing],
  ["/coordination", Coordination],
  ["/approvals", Approvals],
  ["/authorisations", Authorisations],
  ["/payments/done", PaymentsDone],
  ["/payments", Payments],
  ["/discover", Discover],
  ["/collaborate", Collaborate],
  ["/discussions/p/:id", FeedPostPage],
  ["/discussions/:id", Thread],
  ["/discussions", Feed],
  ["/messages/c/:id", ChatPage],
  ["/messages/office", MessagesOffice],
  ["/messages/o/:id", MessagesOfficeThread],
  ["/messages/:id", MessagesOfficeThread],
  ["/u/me/stats", MyStats],
  ["/messages", Messages],
  ["/u/:id", PublicProfile],
  ["/research", Research],
  ["/scout", Scout],
  ["/leaderboard", Leaderboard],
  ["/wall", WallOfFame],
  ["/calendar", Calendar],
  ["/department", Department],
  ["/publications", Publications],
  ["/reports/build", ReportBuilder],
  ["/track", Track],
  ["/admin", AdminHub],
  ["/money", MoneyHub],
  ["/reports/all", ReportsHub],
  ["/reports/brief", YearBrief],
  ["/reports/departments/:name", DepartmentPage],
  ["/reports/departments", Departments],
  ["/reports/papers", ReportPapers],
  ["/reports", Reports],
  ["/journals/:title", JournalRecord],
  ["/journals", Journals],
  ["/accreditation", Accreditation],
  ["/ledger", Ledger],
  ["/statements", Statements],
  ["/duplicates", Duplicates],
  ["/flags", Flags],
  ["/archive", PastClaims],
  ["/audit", Audit],
  ["/faults", Faults],
  ["/jobs", Jobs],
  ["/help", Help],
  ["/faculty/:id", FacultyRecord],
  ["/faculty", FacultyDirectory],
  ["/people/matches", AuthorMatches],
  ["/people/passwords", PeoplePasswords],
  ["/research-faculty", ResearchFaculty],
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
  ["/data/fixes", DataFixes],
  ["/calculator", Calculator],
  ["/data/health", DataHealth],
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
      return <OfficeHome />
    case "SUPER_ADMIN":
      return <AdminHome />
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

/** The desks that check and approve claims. Anybody else who is sent to
 *  /review/:id (a pasted link) lands on the claim's own page, which says what
 *  they may see, instead of a workspace whose every request is refused. */
const REVIEW_DESKS: Role[] = ["SUPER_ADMIN", "RESEARCH_CELL", "RESEARCH_COORDINATOR", "PRINCIPAL", "DIRECTOR"]
function ReviewGate({ children }: { children: ReactNode }) {
  const { me } = useAuth()
  const { claimId } = useParams<{ claimId: string }>()
  if (me && !REVIEW_DESKS.includes(me.role)) {
    // A head of department reads a department's paper in their own view.
    return <Navigate to={`${me.role === "HOD" ? "/department/papers" : "/papers"}/${claimId ?? ""}`} replace />
  }
  return <>{children}</>
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
        {/* The review workspace is a full-height page of its own, not a page
            in the shell: the shell's sidebar and padding would take a third
            of the room the document needs. It carries its own way out. */}
        <Route
          path="/review/:claimId"
          element={
            <Suspense fallback={null}>
              <ReviewGate>
                <ReviewWorkspace />
              </ReviewGate>
            </Suspense>
          }
        />
        <Route
          element={
            <Shell
              onOpenPalette={() => palette.setOpen(true)}
              onPreload={(to) => preloadPath(to, me.role)}
            />
          }
        >
          <Route element={<RoleGate />}>
          <Route index element={<Home />} />
          <Route path="/search" element={<Search />} />
          <Route path="/papers" element={<Papers />} />
          <Route path="/papers/claims" element={<ClaimsList />} />
          <Route path="/papers/appraisal" element={<AppraisalList />} />
          <Route path="/papers/statement" element={<PaymentStatement />} />
          <Route path="/papers/new" element={<FilePaper />} />
          <Route path="/papers/:id/edit" element={<FilePaper />} />
          <Route path="/papers/:id" element={<PaperDetail />} />
          <Route path="/clearing" element={<Clearing />} />
          <Route path="/coordination" element={<Coordination />} />
          <Route path="/approvals" element={<Approvals />} />
          <Route path="/authorisations" element={<Authorisations />} />
          <Route path="/payments" element={<Payments />} />
          <Route path="/payments/done" element={<PaymentsDone />} />
          <Route path="/research" element={<Research />} />
          {Object.entries(REDIRECTS).map(([from, to]) => (
            <Route key={from} path={from} element={<Navigate to={to} replace />} />
          ))}
          <Route path="/discover" element={<Discover />} />
          <Route path="/scout" element={<Scout />} />
          <Route path="/collaborate" element={<Collaborate />} />
          <Route path="/leaderboard" element={<Leaderboard />} />
          <Route path="/discussions" element={<Feed />} />
          <Route path="/discussions/p/:id" element={<FeedPostPage />} />
          {/* Old thread links (and notifications carrying them) still land:
              a private one opens, an open one is sent on to its post. */}
          <Route path="/discussions/:id" element={<Thread />} />
          <Route path="/messages" element={<Messages />} />
          <Route path="/messages/c/:id" element={<ChatPage />} />
          <Route path="/messages/office" element={<MessagesOffice />} />
          <Route path="/messages/o/:id" element={<MessagesOfficeThread />} />
          <Route path="/messages/:id" element={<MessagesOfficeThread />} />
          <Route path="/u/me/stats" element={<MyStats />} />
          <Route path="/u/:id" element={<PublicProfile />} />
          <Route path="/calendar" element={<Calendar />} />
          <Route path="/department" element={<Department />} />
          <Route path="/department/papers/:id" element={<HodPaper />} />
          <Route path="/publications" element={<Publications />} />
          <Route path="/track" element={<Track />} />
          <Route path="/admin" element={<AdminHub />} />
          <Route path="/money" element={<MoneyHub />} />
          <Route path="/reports/all" element={<ReportsHub />} />
          <Route path="/reports/brief" element={<YearBrief />} />
          <Route path="/reports/departments" element={<Departments />} />
          <Route path="/reports/departments/:name" element={<DepartmentPage />} />
          <Route path="/reports/papers" element={<ReportPapers />} />
          <Route path="/reports" element={<Reports />} />
          <Route path="/reports/build" element={<ReportBuilder />} />
          <Route path="/journals" element={<Journals />} />
          <Route path="/journals/:title" element={<JournalRecord />} />
          <Route path="/accreditation" element={<Accreditation />} />
          <Route path="/ledger" element={<Ledger />} />
          <Route path="/statements" element={<Statements />} />
          <Route path="/duplicates" element={<Duplicates />} />
          <Route path="/flags" element={<Flags />} />
          <Route path="/archive" element={<PastClaims />} />
          <Route path="/audit" element={<Audit />} />
          <Route path="/faults" element={<Faults />} />
          <Route path="/jobs" element={<Jobs />} />
          <Route path="/help" element={<Help />} />
          {/* Setup is first-run only; a signed-in admin wants the institution settings. */}
          <Route path="/setup" element={<Navigate to="/settings" replace />} />
          <Route path="/faculty" element={<FacultyDirectory />} />
          <Route path="/faculty/:id" element={<FacultyRecord />} />
          <Route path="/people" element={<People />} />
          <Route path="/people/matches" element={<AuthorMatches />} />
          <Route path="/people/passwords" element={<PeoplePasswords />} />
          <Route path="/research-faculty" element={<ResearchFaculty />} />
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
          <Route path="/data/fixes" element={<DataFixes />} />
          <Route path="/calculator" element={<Calculator />} />
          <Route path="/data/health" element={<DataHealth />} />
          <Route path="/data/record" element={<RecordQuality />} />
          <Route path="/data" element={<Data />} />
          <Route path="/me" element={<Profile />} />
          <Route path="/wall" element={<WallOfFame />} />
          <Route path="/privacy" element={<Privacy />} />
          {import.meta.env.DEV && <Route path="/gallery" element={<Gallery />} />}
          {/* Never a silent redirect home: see the note in not-found.tsx. */}
          <Route path="*" element={<NotFound />} />
          </Route>
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
        <CrashGuard>
          <AuthProvider>
            <App />
            <LateToaster />
          </AuthProvider>
        </CrashGuard>
      </BrowserRouter>
    </QueryClientProvider>
    </MotionConfig>
  </StrictMode>
)
