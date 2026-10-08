import { Fragment, Suspense, useCallback, useEffect, useRef, useState, type ReactNode } from "react"
import { Link, NavLink, Outlet, useLocation, useNavigate } from "react-router-dom"
import * as RadixDialog from "@radix-ui/react-dialog"
import { Check, ChevronRight, ChevronsUpDown, Command, Monitor, Moon, PanelLeft, PanelLeftClose, Search, Sun } from "lucide-react"

import { useAuth, type Role } from "@/app/auth"
import { HOME_DATA } from "@/app/home-data"
import { activeDoor, inResearch, isCurrentEntry, NAV, navBadges, navFor, type NavItem } from "@/app/nav"
import { useApi } from "@/lib/query"
import { Mark } from "@/ui/art"
import { Avatar, initialsOf } from "@/ui/person"
import type { Area } from "@/ui/chip"
import { Button } from "@/ui/button"
import { KbdChord } from "@/ui/kbd"
import { Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from "@/ui/menu"
import { useTheme, type ThemeChoice } from "@/app/theme"
import { NotificationBell } from "@/app/notifications"
import { useUnreadMessages } from "@/app/unread"
import { cn } from "@/lib/cn"
import { api, forgetCsrf } from "@/lib/api"
import { toast } from "@/ui/toast"
import { useCollegeName } from "@/app/institution"
import { CrumbLabelProvider, crumbsFor, useCrumbLabelValue } from "@/app/crumbs"
import { Breadcrumbs } from "@/ui/breadcrumbs"
import { formatCount } from "@/lib/count"
import { ROLE_LABEL } from "@/app/account"
import { Welcome, welcomeOnHome } from "@/app/welcome"
import { motion, useReducedMotion } from "motion/react"
import { PageTransition, sidebarSpring } from "@/ui/motion/page"
import { DetailHost } from "@/ui/detail-sheet"

/**
 * Who you are signed in as, and the two things you can do about it.
 *
 * `signOut` existed in `auth.tsx` from the first day and nothing in the app
 * ever called it: there was no way to leave a session short of clearing
 * cookies, which on a shared departmental machine means the next person
 * files a paper as the last one. The profile route had a quieter version of
 * the same fault, hanging off a bare avatar link with no affordance, and
 * people reported they could not find their account settings at all.
 *
 * The menu comes from `ui/menu.tsx` rather than being assembled here, so it
 * inherits Radix's keyboard handling (arrows, type-ahead, Escape, focus
 * returning to the trigger) and behaves identically in the sidebar and
 * inside the mobile drawer, where it opens on top of a dialog.
 */
const THEMES: { value: ThemeChoice; label: string; icon: typeof Sun }[] = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "system", label: "Match this device", icon: Monitor },
]

function AccountMenu({ collapsed = false }: { collapsed?: boolean }) {
  const { me, signOut } = useAuth()
  const nav = useNavigate()
  const [theme, setTheme] = useTheme()

  return (
    <Menu>
      <MenuTrigger
        aria-label={me?.name ? `Account: ${me.name}` : "Account"}
        className={cn(
          "flex h-14 w-full items-center gap-3 rounded-control px-2 text-left text-sm ring-1 ring-inset ring-transparent",
          "hover:bg-hover hover:ring-edge data-[state=open]:bg-hover data-[state=open]:ring-edge"
        )}
      >
        <Avatar person={me ? { name: me.name, initials: initialsOf(me.name), photo_url: me.photo_url ?? null } : null} size="sm" className="shrink-0" />
        {!collapsed && (
          <>
            <span className="min-w-0 flex-1 leading-tight">
              <span className="block truncate font-medium">{me?.name}</span>
              {me && <span className="block truncate text-xs text-fg-muted">{ROLE_LABEL[me.role]}</span>}
            </span>
            <ChevronsUpDown className="size-3.5 shrink-0 text-fg-subtle" aria-hidden />
          </>
        )}
      </MenuTrigger>
      <MenuContent side="top" align="start" className="min-w-[13rem]">
        {/* No name-and-role block here: the trigger it opens from, directly
            below, already says who this is. */}
        <MenuItem onSelect={() => nav("/me")}>Your profile</MenuItem>
        <MenuItem onSelect={() => nav("/help")}>Help and guides</MenuItem>
        <MenuSeparator />
        <MenuLabel>Appearance</MenuLabel>
        {THEMES.map(({ value, label, icon: Icon }) => (
          <MenuItem
            key={value}
            onSelect={(e) => {
              e.preventDefault()
              setTheme(value)
            }}
            aria-checked={theme === value}
            role="menuitemradio"
          >
            <span className="flex w-full items-center gap-2">
              <Icon className="size-4 text-fg-subtle" aria-hidden />
              <span className="flex-1">{label}</span>
              {theme === value && <Check className="size-4 text-accent" aria-hidden />}
            </span>
          </MenuItem>
        ))}
        <MenuSeparator />
        <MenuItem onSelect={() => void signOut()}>Sign out</MenuItem>
      </MenuContent>
    </Menu>
  )
}

/**
 * The frame every page sits in.
 *
 * One sidebar, not five. The old app declared a sidebar per portal, so the
 * same page existed in three files and drifted apart; here the list is data
 * and the frame renders whatever this account is allowed to reach.
 *
 * The frame animates with CSS, not `motion/react`: it is on screen before any
 * page, so whatever moves it is on the path to the first paint, and the
 * animation library was ~120 KB of that path for a sidebar width, a highlight
 * and a drawer. Pages that animate load the library with their own code.
 *
 * Pointing at or focusing a link starts loading that page's code
 * (`onPreload`), so by the time the click lands the page is usually already
 * here and only its data is left to fetch.
 *
 * The mobile drawer is a Radix dialog. It was a bare `motion.aside` behind a
 * click-to-dismiss overlay, which meant no focus trap, no Escape, nothing
 * inert behind it, and, because it was written before the header that opens
 * it, a Tab out of the Menu button that walked into the page rather than
 * into the drawer. Radix answers all four at once. `ui/sheet.tsx` would have
 * been the reuse, but it enters only from the right or the bottom and
 * hard-codes its own motion, so a left drawer built on it would fly in from
 * the wrong edge; the dialog primitive underneath it is used directly here
 * and the behaviour is the same.
 */
export function Shell({
  onOpenPalette,
  onPreload,
}: {
  onOpenPalette: () => void
  /** Start fetching the code behind a destination the reader is about to open. */
  onPreload?: (to: string) => void
}) {
  const collegeName = useCollegeName()
  const { me } = useAuth()
  const { pathname } = useLocation()
  const reduceMotion = useReducedMotion()
  const [collapsed, setCollapsed] = useState(
    () => localStorage.getItem("sidebar") === "collapsed"
  )
  const [mobileOpen, setMobileOpen] = useState(false)

  useEffect(() => {
    localStorage.setItem("sidebar", collapsed ? "collapsed" : "open")
  }, [collapsed])

  // A route change closes the drawer. Leaving it open over the page somebody
  // just asked for is the commonest small annoyance in a mobile shell.
  useEffect(() => setMobileOpen(false), [pathname])

  // The drawer is `md:hidden`, but a modal dialog holds the page inert
  // whether or not it is painted. A window widened past the breakpoint with
  // the drawer still open would leave an invisible dialog and a page that
  // answers nothing, so the breakpoint closes it.
  useEffect(() => {
    const wide = window.matchMedia("(min-width: 48rem)")
    const onChange = () => {
      if (wide.matches) setMobileOpen(false)
    }
    wide.addEventListener("change", onChange)
    return () => wide.removeEventListener("change", onChange)
  }, [])

  // The browser tab says where you are, so a row of tabs is not ten copies
  // of the same name. Longest matching route wins (/reports/build over
  // /reports); detail pages fall back to their section.
  const here = NAV.filter((n) => (n.to === "/" ? pathname === "/" : pathname.startsWith(n.to))).sort(
    (a, b) => b.to.length - a.to.length
  )[0]?.label
  useEffect(() => {
    document.title = here ? `${here} · Publications` : "Publications"
  }, [here])

  const items = navFor(me?.role)
  const listed = items.filter((i) => !i.pinned)
  const pinned = items.filter((i) => i.pinned)
  const preload = (to: string) => () => onPreload?.(to)
  const research = useResearchFold(me?.role, pathname)
  // What is waiting at this desk, beside its entry: the same counts the home
  // screens read, so the two can never disagree. Refreshed every minute.
  const stageCounts = useApi<{ counts: Record<string, number> }>(
    HOME_DATA.stageCounts.key,
    HOME_DATA.stageCounts.path,
    { enabled: !!me, refetchInterval: 60_000 }
  )
  // Conversations with a message not yet read sit on Messages, for everybody.
  const unread = useUnreadMessages()
  const badges: Record<string, number> = {
    ...navBadges(me?.role, stageCounts.data?.counts),
    ...(unread.data?.conversations ? { "/messages": unread.data.conversations } : {}),
  }

  return (
    <CrumbLabelProvider>
    <RadixDialog.Root open={mobileOpen} onOpenChange={setMobileOpen}>
      <div className="flex min-h-svh bg-bg">
        <motion.aside
          initial={false}
          animate={{ width: collapsed ? 60 : 256 }}
          transition={reduceMotion ? { duration: 0 } : sidebarSpring}
          className={cn(
            "sticky top-0 hidden h-svh shrink-0 flex-col border-r border-line",
            "bg-sunken md:flex print:hidden"
          )}
        >
          <div className="flex h-14 items-center gap-2.5 px-3.5">
            {/* Collapsed, the mark is the only thing on screen naming the
                institution, so it carries the name; expanded, the wordmark
                beside it does and a second announcement is noise. */}
            <Mark
              className="size-6 text-accent"
              title={collapsed ? collegeName : undefined}
            />
            {!collapsed && (
              <span className="min-w-0 leading-tight">
                <span className="block truncate font-display text-[15px] font-medium">Publications</span>
                <span className="block truncate text-xs text-fg-subtle">{collegeName}</span>
              </span>
            )}
            <Button
              kind="quiet"
              size="icon-sm"
              onClick={() => setCollapsed((v) => !v)}
              aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
              title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
              className="ml-auto"
            >
              {collapsed ? <PanelLeft /> : <PanelLeftClose />}
            </Button>
          </div>

          <FadingNav navClassName="h-full overflow-y-auto px-2.5 pb-2">
            <NavList
              items={listed}
              role={me?.role}
              collapsed={collapsed}
              badges={badges}
              preload={preload}
              research={research}
            />
          </FadingNav>

          {pinned.length > 0 && (
            <div className="px-2 pb-2">
              {pinned.map((item) => {
                const Icon = item.icon
                return (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    data-area={item.area}
                    title={collapsed ? item.label : undefined}
                    onPointerEnter={preload(item.to)}
                    onFocus={preload(item.to)}
                    className={({ isActive }) => navClass(isActive, item.area)}
                  >
                    <Icon className="size-4 shrink-0" />
                    {!collapsed && <span className="truncate">{item.label}</span>}
                  </NavLink>
                )
              })}
            </div>
          )}

          <div className="p-2.5">
            {/* One row for the two utilities: the jump box takes the width, the
                bell sits beside it. (Collapsed, they stack.) The bell names
                itself to a screen reader and in its tooltip, so no second
                "Notifications" label is drawn next to it. */}
            <div className={cn("flex gap-1.5", collapsed ? "flex-col items-center" : "items-center")}>
              <Button
                kind="default"
                onClick={onOpenPalette}
                aria-label={collapsed ? "Jump to a page or claim" : undefined}
                title={collapsed ? "Jump to a page or claim (Ctrl K)" : undefined}
                className={cn("justify-start text-fg-muted hover:text-fg", collapsed ? "size-10 justify-center px-0" : "min-w-0 flex-1")}
              >
                <Command />
                {!collapsed && (
                  <>
                    <span className="truncate">Jump to…</span>
                    <KbdChord keys={["Ctrl", "K"]} className="ml-auto" />
                  </>
                )}
              </Button>
              <NotificationBell className="hidden md:block" />
            </div>
            <div className="mt-1">
              <AccountMenu collapsed={collapsed} />
            </div>
          </div>
        </motion.aside>

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="sticky top-0 z-30 flex h-12 items-center gap-2 border-b border-line bg-bg/90 px-3 backdrop-blur md:hidden print:hidden">
            <RadixDialog.Trigger asChild>
              <Button kind="quiet" size="icon" aria-label="Menu">
                <PanelLeft />
              </Button>
            </RadixDialog.Trigger>
            <Mark className="size-5 text-accent" />
            {/* Says where you are, not what the app is called: the page's own
                name once there is one. */}
            <span className="min-w-0 truncate font-display text-lg font-medium">{here ?? "Publications"}</span>
            <Button
              kind="quiet"
              size="icon"
              className="ml-auto"
              onClick={onOpenPalette}
              aria-label="Jump to a page or claim"
            >
              <Search />
            </Button>
            <NotificationBell />
          </header>

          {me?.impersonated_by && <ViewingAs name={me.name} role={me.role} />}
          <main className="min-w-0 flex-1 pb-16 pt-6 sm:pt-8">
            {me && welcomeOnHome(me, pathname) ? (
              // Home only, in the page flow: the note sits in the same width as
              // the Home title. `empty:hidden` drops the wrapper once dismissed.
              <div className="page mb-6 empty:hidden">
                <Welcome key={me.id} />
              </div>
            ) : null}
            <CrumbStrip />
            <Suspense fallback={<PageLoading />}>
              <PageTransition>
                <Outlet />
              </PageTransition>
            </Suspense>
            <DetailHost />
          </main>
        </div>
      </div>

      {/* Portalled, so it is last in the document however early it is written
          here. Radix keeps it mounted until the closing keyframes end (see
          `frame-drawer` in styles.css). */}
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="frame-overlay fixed inset-0 z-40 bg-brand/45 md:hidden" />
        <RadixDialog.Content asChild aria-describedby={undefined}>
          <aside
            className={cn(
              "frame-drawer fixed inset-y-0 left-0 z-50 flex w-64 flex-col overflow-hidden",
              "border-r border-line bg-sunken p-2.5 md:hidden"
            )}
          >
            <RadixDialog.Title className="sr-only">Menu</RadixDialog.Title>
            {/* The drawer covers the header it was opened from, so
                without this it is a list of links belonging to nothing. */}
            <div className="mb-2 flex h-9 shrink-0 items-center gap-2 px-2">
              <Mark className="size-5 text-accent" />
              <span className="text-sm font-semibold">Publications</span>
            </div>
            <FadingNav navClassName="h-full overflow-y-auto">
              <NavList
                items={[...listed, ...pinned]}
                role={me?.role}
                collapsed={false}
                mobile
                badges={badges}
                preload={preload}
                research={research}
              />
            </FadingNav>
            <div className="mt-2 shrink-0 border-t border-line pt-2">
              <AccountMenu />
            </div>
          </aside>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
    </CrumbLabelProvider>
  )
}

/**
 * The sidebar's scrolling list, with a soft fade at its foot while there is
 * more below. The fade is the only cue that the list goes on.
 */
function FadingNav({ navClassName, children }: { navClassName: string; children: ReactNode }) {
  const ref = useRef<HTMLElement>(null)
  const [more, setMore] = useState(false)
  const measure = useCallback(() => {
    const el = ref.current
    if (el) setMore(el.scrollHeight - el.scrollTop - el.clientHeight > 2)
  }, [])
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.addEventListener("scroll", measure, { passive: true })
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null
    ro?.observe(el)
    return () => {
      el.removeEventListener("scroll", measure)
      ro?.disconnect()
    }
  }, [measure])
  // A folder opening grows the content, not the box, so measure after each render too.
  useEffect(() => {
    measure()
  })
  return (
    <div className="relative min-h-0 flex-1">
      <nav ref={ref} className={navClassName} aria-label="Main">
        {children}
      </nav>
      {more && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-gradient-to-t from-sunken to-transparent"
        />
      )}
    </div>
  )
}

type ResearchFold = { open: boolean; toggle: () => void }

/**
 * Whether an officer's "Research" group is unfolded.
 *
 * Folded by default for the office, where the desk is the day's work and a
 * dozen research links beside it are a pile; open by default for a head of
 * department, who is a faculty member first. Going to any page inside it
 * opens it, and the reader's own choice is remembered.
 */
function useResearchFold(role: Role | undefined, pathname: string): ResearchFold {
  const KEY = "sidebar-research"
  const [stored, setStored] = useState<boolean | null>(() => {
    try {
      const v = localStorage.getItem(KEY)
      return v === "open" ? true : v === "closed" ? false : null
    } catch {
      return null
    }
  })
  useEffect(() => {
    if (inResearch(pathname)) setStored(true)
  }, [pathname])
  useEffect(() => {
    if (stored === null) return
    try {
      localStorage.setItem(KEY, stored ? "open" : "closed")
    } catch {
      /* a preference, nothing more */
    }
  }, [stored])
  const open = stored ?? role === "HOD"
  return { open, toggle: () => setStored(!open) }
}

/**
 * The list of sidebar links, for the desktop rail and the phone drawer.
 *
 * A faculty member's list is the four coloured groups. Everybody else's is a
 * few doors, lit by the section they are in (`activeDoor`, so Budget lights
 * Money and an import lights Admin, not nothing), then the folded Research
 * group.
 */
function NavList({
  items,
  role,
  collapsed,
  mobile = false,
  badges,
  preload,
  research,
}: {
  items: NavItem[]
  role: Role | undefined
  collapsed: boolean
  mobile?: boolean
  badges: Record<string, number>
  preload: (to: string) => () => void
  research: ResearchFold
}) {
  const { pathname } = useLocation()
  const staff = !!role && role !== "FACULTY"
  const doorTo = staff ? activeDoor(role, pathname) : undefined
  const plain = items.filter((i) => !i.fold && !(mobile && i.pinned))
  const folded = items.filter((i) => i.fold)
  const pinnedHere = mobile ? items.filter((i) => i.pinned) : []
  const seen = new Set<string>()

  const entry = (item: NavItem, opts: { door: boolean }) => {
    const Icon = item.icon
    const badge = (
      <NavBadge n={badges[item.to]} compact={collapsed} label={badgeLabel(item.to, badges[item.to])} />
    )
    const inner = (
      <>
        <Icon className="size-4 shrink-0" />
        {!collapsed && <span className="truncate">{item.label}</span>}
        {badge}
      </>
    )
    if (opts.door) {
      const active = doorTo === item.to
      return (
        <Link
          key={item.to}
          to={item.to}
          aria-current={active ? "page" : undefined}
          title={collapsed ? item.label : undefined}
          onPointerEnter={preload(item.to)}
          onFocus={preload(item.to)}
          className={cn(navClass(active), mobile && "h-9")}
        >
          {inner}
        </Link>
      )
    }
    if (item.activeFor) {
      // A door for several pages: lit by any of them, not only its own route.
      const current = isCurrentEntry(item, pathname)
      return (
        <Link
          key={item.to}
          to={item.to}
          aria-current={current ? "page" : undefined}
          data-area={item.area}
          title={collapsed ? item.label : undefined}
          onPointerEnter={preload(item.to)}
          onFocus={preload(item.to)}
          className={cn(navClass(current, item.area), mobile && "h-9")}
        >
          {inner}
        </Link>
      )
    }
    return (
      <NavLink
        key={item.to}
        to={item.to}
        end={item.end}
        data-area={item.area}
        title={collapsed ? item.label : undefined}
        onPointerEnter={preload(item.to)}
        onFocus={preload(item.to)}
        className={({ isActive }) => cn(navClass(isActive, item.area), mobile && "h-9")}
      >
        {inner}
      </NavLink>
    )
  }

  const foldedBadge = folded.reduce((n, i) => n + (badges[i.to] ?? 0), 0)
  const stand = folded.find((i) => i.to === "/research") ?? folded[0]

  return (
    <>
      {plain.map((item) => {
        const heading = !mobile && item.group && !seen.has(item.group) ? item.group : null
        if (item.group) seen.add(item.group)
        return (
          <Fragment key={item.to}>
            {heading && !collapsed ? (
              <p
                data-area={item.area}
                className="flex items-center gap-1.5 px-2.5 pb-1.5 pt-5 text-xs font-medium text-fg-subtle"
              >
                {heading}
              </p>
            ) : null}
            {heading && collapsed ? <div className="my-2 border-t border-line" /> : null}
            {entry(item, { door: staff && !item.pinned })}
          </Fragment>
        )
      })}

      {folded.length > 0 &&
        (collapsed ? (
          <>
            <div className="my-2 border-t border-line" />
            {stand && entry({ ...stand, label: "Research" }, { door: false })}
          </>
        ) : (
          <div className="pt-3">
            <button
              type="button"
              aria-expanded={research.open}
              onClick={research.toggle}
              className="flex h-8 w-full items-center gap-1.5 rounded-control px-2.5 text-xs font-medium text-fg-subtle hover:bg-hover hover:text-fg"
            >
              <ChevronRight
                className={cn("size-3.5 transition-transform duration-[var(--dur-1)]", research.open && "rotate-90")}
                aria-hidden
              />
              Research
              {!research.open && foldedBadge > 0 && (
                <span
                  className="ml-auto size-2 rounded-full bg-accent"
                  role="status"
                  aria-label={`${foldedBadge} waiting under Research`}
                />
              )}
            </button>
            {research.open && folded.map((item) => entry(item, { door: false }))}
          </div>
        ))}

      {pinnedHere.map((item) => entry(item, { door: false }))}
    </>
  )
}

/** What a badge says aloud: work waiting at a desk, or conversations with news. */
/** A sidebar link. Active takes its area's wash (docs/ux/00 §9), not `selected`. */
function navClass(isActive: boolean, _area?: Area): string {
  // The current page is lifted: a surface-coloured pill with a hairline, as a
  // sheet of paper lies on the sunken rail. No stripe, no area colour, one
  // calm shape whatever the area (DESIGN.md, "Components").
  return cn(
    "relative flex h-10 items-center gap-3 rounded-control px-3 text-sm",
    "transition-colors duration-[var(--dur-1)]",
    isActive
      ? "bg-surface font-medium text-fg ring-1 ring-inset ring-edge"
      : "text-fg-muted ring-1 ring-inset ring-transparent hover:bg-hover hover:text-fg hover:ring-edge active:bg-active"
  )
}

function badgeLabel(to: string, n: number | undefined): string | undefined {
  if (!n || to !== "/messages") return undefined
  return `${n} conversation${n === 1 ? "" : "s"} with new messages`
}

/** How many are waiting at this entry's desk (or, on Messages, how many
 *  conversations have news). A dot when the sidebar is collapsed; nothing at
 *  all for an empty queue. */
function NavBadge({ n, compact = false, label: said }: { n: number | undefined; compact?: boolean; label?: string }) {
  if (!n) return null
  const label = said ?? `${n} waiting`
  if (compact) {
    return (
      <span
        className="absolute right-1 top-1 size-2 rounded-full bg-accent"
        aria-label={label}
        role="status"
      />
    )
  }
  return (
    <span
      className="ml-auto min-w-5 shrink-0 rounded-full bg-accent-wash px-1.5 text-center text-xs font-semibold leading-5 text-accent tabular"
      aria-label={label}
    >
      {formatCount(n)}
    </span>
  )
}

/**
 * Where this page sits, above the page ("Admin / Imports"). Drawn by the frame
 * from the route so no page has to; a page that knows the record's name says
 * so with `useCrumbLabel`. On a page with no trail it is only the space the
 * title used to have, so titles sit at the same height either way.
 */
function CrumbStrip() {
  const { me } = useAuth()
  const { pathname } = useLocation()
  const dynamic = useCrumbLabelValue()
  const items = crumbsFor(me?.role, pathname, dynamic)
  if (items.length === 0) return <div className="h-4" aria-hidden />
  return (
    <div className="page pb-3">
      <Breadcrumbs items={items} />
    </div>
  )
}

/** What the page area shows while a page's code arrives: nothing that could
 *  be mistaken for content, and only after a beat, so a fast load shows
 *  nothing at all. */
function PageLoading() {
  return (
    <div className="page" role="status" aria-busy="true" aria-label="Loading">
      <div className="h-7 w-48 animate-[pulse_1.6s_ease-in-out_infinite] rounded-md bg-hover opacity-0 [animation-delay:300ms]" />
    </div>
  )
}

/**
 * Always on screen while a super admin is viewing as somebody else, so no
 * action taken in that state can be mistaken for one's own. The server
 * records the start and the end; this is the way back.
 */
function ViewingAs({ name, role }: { name: string; role: Role }) {
  const { refresh } = useAuth()
  const nav = useNavigate()
  const [busy, setBusy] = useState(false)
  return (
    <div
      role="status"
      className="sticky top-0 z-40 flex flex-wrap items-center gap-3 bg-caution-wash px-4 py-2 text-sm text-caution ring-1 ring-inset ring-caution/30 print:hidden"
    >
      <span className="flex-1">
        Viewing as <strong>{name}</strong> ({ROLE_LABEL[role]}). Read only.
      </span>
      <Button
        kind="default"
        size="sm"
        disabled={busy}
        onClick={async () => {
          setBusy(true)
          try {
            await api("/api/admin/stop-impersonating", { method: "POST" })
            forgetCsrf() // back to our own session: a new token again
            await refresh()
            nav("/people")
          } catch (err) {
            toast.fail(err)
          } finally {
            setBusy(false)
          }
        }}
      >
        Stop viewing
      </Button>
    </div>
  )
}
