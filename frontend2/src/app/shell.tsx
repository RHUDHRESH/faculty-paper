import { Fragment, Suspense, useEffect, useState } from "react"
import { Link, NavLink, Outlet, useLocation, useNavigate } from "react-router-dom"
import * as RadixDialog from "@radix-ui/react-dialog"
import { Check, ChevronRight, ChevronsUpDown, Monitor, Moon, PanelLeft, PanelLeftClose, Search, Sun } from "lucide-react"

import { useAuth, type Role } from "@/app/auth"
import { stageCountsOf, useBadgeClock, useBadges } from "@/app/badges"
import { activeDoor, inResearch, isCurrentEntry, NAV, navBadges, navFor, type NavItem } from "@/app/nav"
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
import { PageTransition } from "@/ui/motion/page"
import { DetailHost } from "@/ui/detail-sheet"

/**
 * Who you are signed in as, and the two things you can do about it.
 *
 * `signOut` existed in `auth.tsx` from the first day and nothing in the app
 * ever called it. The menu comes from `ui/menu.tsx`, so it inherits Radix's
 * keyboard handling and behaves the same in the sidebar, the top bar and the
 * phone drawer.
 */
const THEMES: { value: ThemeChoice; label: string; icon: typeof Sun }[] = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "system", label: "Match this device", icon: Monitor },
]

/**
 * `avatarOnly` is the round avatar in the top bar; otherwise the full row at
 * the foot of the sidebar (or the drawer), which shows the name and role
 * unless the sidebar is collapsed.
 */
function AccountMenu({
  collapsed = false,
  avatarOnly = false,
  side = "top",
}: {
  collapsed?: boolean
  avatarOnly?: boolean
  side?: "top" | "bottom"
}) {
  const { me, signOut } = useAuth()
  const nav = useNavigate()
  const [theme, setTheme] = useTheme()

  return (
    <Menu>
      <MenuTrigger
        aria-label={me?.name ? `Account: ${me.name}` : "Account"}
        className={cn(
          "flex items-center text-left text-sm",
          avatarOnly
            ? "size-10 justify-center rounded-full hover:ring-2 hover:ring-edge data-[state=open]:ring-2 data-[state=open]:ring-edge"
            : "h-14 w-full gap-3 rounded-control px-3 hover:bg-sunken data-[state=open]:bg-sunken"
        )}
      >
        <Avatar person={me ? { name: me.name, initials: initialsOf(me.name), photo_url: me.photo_url ?? null } : null} size="sm" className="shrink-0" />
        {!avatarOnly && !collapsed && (
          <>
            <span className="min-w-0 flex-1 leading-tight">
              <span className="block truncate font-medium">{me?.name}</span>
              {me && <span className="block truncate text-xs text-fg-muted">{ROLE_LABEL[me.role]}</span>}
            </span>
            <ChevronsUpDown className="size-3.5 shrink-0 text-fg-subtle" aria-hidden />
          </>
        )}
      </MenuTrigger>
      <MenuContent side={side} align={avatarOnly ? "end" : "start"} className="min-w-[13rem]">
        {/* No name-and-role block here: the trigger it opens from already says who this is. */}
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

/** The sidebar's collapsed state, remembered on this machine. A preference, so a blocked store is not an error. */
const SIDEBAR_KEY = "sidebar"
function readCollapsed(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_KEY) === "collapsed"
  } catch {
    return false
  }
}
function writeCollapsed(collapsed: boolean) {
  try {
    localStorage.setItem(SIDEBAR_KEY, collapsed ? "collapsed" : "open")
  } catch {
    /* a preference, nothing more */
  }
}

/**
 * The frame every page sits in.
 *
 * One sidebar, not five: the list is data and the frame renders whatever this
 * account is allowed to reach. From `lg` up the frame is a fixed sidebar (290px,
 * or 90px icons only) and a 64px top bar with search, notifications and the
 * account. Below `lg` the sidebar is a slide-over drawer behind a Menu button.
 *
 * The frame moves with CSS, not `motion/react`: it is on screen before any page.
 * The drawer is a Radix dialog, so it has a focus trap, Escape and an inert page
 * behind it.
 *
 * Pointing at or focusing a link starts loading that page's code (`onPreload`).
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
  const [collapsed, setCollapsed] = useState(readCollapsed)
  const [mobileOpen, setMobileOpen] = useState(false)

  const toggleCollapsed = () => {
    const next = !collapsed
    setCollapsed(next)
    writeCollapsed(next)
  }

  // A route change closes the drawer. Leaving it open over the page somebody
  // just asked for is the commonest small annoyance in a mobile shell.
  useEffect(() => setMobileOpen(false), [pathname])

  // The drawer is `lg:hidden`, but a modal dialog holds the page inert whether
  // or not it is painted. A window widened past the breakpoint with the drawer
  // still open would leave an invisible dialog, so the breakpoint closes it.
  useEffect(() => {
    const wide = window.matchMedia("(min-width: 64rem)")
    const onChange = () => {
      if (wide.matches) setMobileOpen(false)
    }
    wide.addEventListener("change", onChange)
    return () => wide.removeEventListener("change", onChange)
  }, [])

  // The browser tab says where you are. Longest matching route wins.
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
  // screens read (`/claims/counts`), so the two can never disagree. These, the
  // bell and the Messages badge come from one request, read every two minutes
  // while somebody is at the page and not at all once they have left it.
  useBadgeClock(!!me)
  const stageCounts = useBadges(stageCountsOf)
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
        <aside
          className={cn(
            "sticky top-0 hidden h-svh shrink-0 flex-col border-r border-edge bg-surface lg:flex print:hidden",
            "transition-[width] duration-[var(--dur-2)] motion-reduce:transition-none",
            collapsed ? "w-[5.625rem]" : "w-[18.125rem]"
          )}
        >
          <div className={cn("flex h-16 shrink-0 items-center gap-2.5", collapsed ? "justify-center" : "px-5")}>
            {/* Collapsed, the mark is the only thing on screen naming the
                institution, so it carries the name. */}
            <Mark className="size-7 shrink-0 text-accent" title={collapsed ? collegeName : undefined} />
            {!collapsed && (
              <span className="min-w-0 leading-tight">
                <span className="block truncate text-[15px] font-semibold">Publications</span>
                <span className="block truncate text-xs text-fg-subtle">{collegeName}</span>
              </span>
            )}
          </div>

          <nav aria-label="Main" className="min-h-0 flex-1 overflow-y-auto px-3 pb-2">
            <NavList
              items={listed}
              role={me?.role}
              collapsed={collapsed}
              badges={badges}
              preload={preload}
              research={research}
            />
          </nav>

          {pinned.length > 0 && (
            <div className="px-3 pb-2">
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
                    <Icon className="size-5 shrink-0" />
                    {!collapsed && <span className="truncate">{item.label}</span>}
                  </NavLink>
                )
              })}
            </div>
          )}

          <div className="p-3">
            <AccountMenu collapsed={collapsed} />
          </div>
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          {/* Desktop top bar: the collapse toggle, the search that opens the
              finder, and on the right the bell and the account. */}
          <header className="sticky top-0 z-30 hidden h-16 shrink-0 items-center gap-3 border-b border-edge bg-surface px-4 lg:flex xl:px-6 print:hidden">
            <Button
              kind="quiet"
              size="icon-sm"
              onClick={toggleCollapsed}
              aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
              title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
              aria-expanded={!collapsed}
            >
              {collapsed ? <PanelLeft /> : <PanelLeftClose />}
            </Button>
            <Button
              kind="default"
              onClick={onOpenPalette}
              className="h-10 w-full max-w-md justify-start text-fg-subtle"
            >
              <Search />
              <span className="min-w-0 flex-1 truncate text-left">Search papers, people, claims</span>
              <KbdChord keys={["Ctrl", "K"]} className="ml-auto" />
            </Button>
            <div className="ml-auto flex items-center gap-2">
              <NotificationBell />
              <AccountMenu avatarOnly side="bottom" />
            </div>
          </header>

          {/* Phone and tablet: the header that opens the drawer. */}
          <header className="sticky top-0 z-30 flex h-12 items-center gap-2 border-b border-edge bg-surface px-3 lg:hidden print:hidden">
            <RadixDialog.Trigger asChild>
              <Button kind="quiet" size="icon" aria-label="Menu">
                <PanelLeft />
              </Button>
            </RadixDialog.Trigger>
            <Mark className="size-5 text-accent" />
            {/* Says where you are, not what the app is called: the page's own name once there is one. */}
            <span className="min-w-0 truncate text-lg font-semibold">{here ?? "Publications"}</span>
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
          <main className="min-w-0 flex-1 bg-bg pb-16 pt-4 md:pt-6 print:pt-0">
            <div className="mx-auto w-full max-w-[96rem]">
              {me && welcomeOnHome(me, pathname) ? (
                // Home only, in the page flow. `empty:hidden` drops the wrapper once dismissed.
                <div className="page mb-4 empty:hidden">
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
            </div>
          </main>
        </div>
      </div>

      {/* Portalled, so it is last in the document. Radix keeps it mounted until
          the closing keyframes end (see `frame-drawer` in styles.css). */}
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="frame-overlay fixed inset-0 z-40 bg-brand/45 lg:hidden" />
        <RadixDialog.Content asChild aria-describedby={undefined}>
          <aside
            className={cn(
              "frame-drawer fixed inset-y-0 left-0 z-50 flex w-72 flex-col overflow-hidden",
              "border-r border-edge bg-surface p-3 lg:hidden"
            )}
          >
            <RadixDialog.Title className="sr-only">Menu</RadixDialog.Title>
            {/* The drawer covers the header it was opened from, so without this it is a list of links belonging to nothing. */}
            <div className="mb-2 flex h-10 shrink-0 items-center gap-2.5 px-2">
              <Mark className="size-6 text-accent" />
              <span className="text-[15px] font-semibold">Publications</span>
            </div>
            <nav aria-label="Main" className="min-h-0 flex-1 overflow-y-auto">
              <NavList
                items={[...listed, ...pinned]}
                role={me?.role}
                collapsed={false}
                mobile
                badges={badges}
                preload={preload}
                research={research}
              />
            </nav>
            <div className="mt-2 shrink-0 pt-2">
              <AccountMenu />
            </div>
          </aside>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
    </CrumbLabelProvider>
  )
}

type ResearchFold = { open: boolean; toggle: () => void }

/**
 * Whether an officer's "Research" group is unfolded.
 *
 * Folded by default for the office, open by default for a head of department.
 * Going to any page inside it opens it, and the reader's own choice is remembered.
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
 * A faculty member's list is the coloured groups. Everybody else's is a few
 * doors, lit by the section they are in (`activeDoor`), then the folded
 * Research group.
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
        <Icon className="size-5 shrink-0" />
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
          className={navClass(active)}
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
          className={navClass(current, item.area)}
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
        className={({ isActive }) => navClass(isActive, item.area)}
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
              // A section label: small, muted, sentence case, above its group.
              <p className="px-3 pb-1.5 pt-5 text-xs font-medium text-fg-subtle first:pt-2">{heading}</p>
            ) : null}
            {heading && collapsed ? <div className="my-3 border-t border-edge" /> : null}
            {entry(item, { door: staff && !item.pinned })}
          </Fragment>
        )
      })}

      {folded.length > 0 &&
        (collapsed ? (
          <>
            <div className="my-3 border-t border-edge" />
            {stand && entry({ ...stand, label: "Research" }, { door: false })}
          </>
        ) : (
          <div className="pt-3">
            <button
              type="button"
              aria-expanded={research.open}
              onClick={research.toggle}
              className="flex h-8 w-full items-center gap-1.5 rounded-control px-3 text-xs font-medium text-fg-subtle hover:bg-sunken hover:text-fg"
            >
              <ChevronRight
                className={cn("size-3.5 transition-transform duration-[var(--dur-1)] motion-reduce:transition-none", research.open && "rotate-90")}
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

/** A sidebar link: 40px high, 12px across, the current page washed in the accent. */
function navClass(isActive: boolean, _area?: Area): string {
  return cn(
    "relative flex h-10 items-center gap-3 rounded-control px-3 text-sm",
    "transition-colors duration-[var(--dur-1)] motion-reduce:transition-none",
    isActive
      ? "bg-accent-wash font-medium text-accent"
      : "text-fg-muted hover:bg-sunken hover:text-fg active:bg-hover"
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
        className="absolute right-1.5 top-1.5 size-2 rounded-full bg-accent"
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
 * from the route so no page has to.
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
