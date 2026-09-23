import { Fragment, Suspense, useEffect, useState } from "react"
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom"
import * as RadixDialog from "@radix-ui/react-dialog"
import { AnimatePresence, motion } from "motion/react"
import { Check, ChevronsUpDown, Command, Monitor, Moon, PanelLeft, PanelLeftClose, Search, Sun } from "lucide-react"

import { useAuth, type Role } from "@/app/auth"
import { NAV, navFor } from "@/app/nav"
import { Mark } from "@/ui/art"
import { Button } from "@/ui/button"
import { Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from "@/ui/menu"
import { useTheme, type ThemeChoice } from "@/app/theme"
import { NotificationBell } from "@/app/notifications"
import { cn } from "@/lib/cn"
import { api, forgetCsrf } from "@/lib/api"
import { toast } from "@/ui/toast"
import { useCollegeName } from "@/app/institution"

//: The same wording the people screen uses, so an account reads the same
//: name for its own role as the office reads for it.
const ROLE_LABEL: Record<Role, string> = {
  FACULTY: "Faculty",
  HOD: "Head of department",
  PRINCIPAL: "Principal",
  DIRECTOR: "Director",
  FINANCE: "Finance",
  RESEARCH_CELL: "Research cell",
  RESEARCH_COORDINATOR: "Research coordinator",
  SUPER_ADMIN: "Super admin",
}

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
          "flex h-9 w-full items-center gap-2 rounded-md px-1.5 text-left text-sm",
          "hover:bg-hover data-[state=open]:bg-hover"
        )}
      >
        <span className="grid size-6 shrink-0 place-items-center rounded-full bg-accent-wash text-[10px] font-semibold text-accent">
          {(me?.name || "?").slice(0, 2).toUpperCase()}
        </span>
        {!collapsed && (
          <>
            <span className="min-w-0 flex-1 truncate">{me?.name}</span>
            <ChevronsUpDown className="size-3.5 shrink-0 text-fg-subtle" aria-hidden />
          </>
        )}
      </MenuTrigger>
      <MenuContent side="top" align="start" className="min-w-[13rem]">
        {/* Not a MenuLabel: this is the account itself, not a heading over a
            group of items. */}
        <div className="px-2 py-1.5">
          <p className="truncate text-sm font-medium text-fg">{me?.name}</p>
          {me && <p className="truncate text-xs text-fg-muted">{ROLE_LABEL[me.role]}</p>}
        </div>
        <MenuSeparator />
        <MenuItem onSelect={() => nav("/me")}>Your profile</MenuItem>
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
 * The active item is marked with a shared `layoutId`, so moving between pages
 * slides one indicator rather than extinguishing one box and lighting
 * another. It is the cheapest possible signal that this is one place rather
 * than a set of screens.
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
export function Shell({ onOpenPalette }: { onOpenPalette: () => void }) {
  const collegeName = useCollegeName()
  const { me } = useAuth()
  const { pathname } = useLocation()
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
  useEffect(() => {
    const hit = NAV.filter((n) => (n.to === "/" ? pathname === "/" : pathname.startsWith(n.to)))
      .sort((a, b) => b.to.length - a.to.length)[0]
    document.title = hit ? `${hit.label} · Publications` : "Publications"
  }, [pathname])

  const items = navFor(me?.role)
  const seen = new Set<string>()

  return (
    <RadixDialog.Root open={mobileOpen} onOpenChange={setMobileOpen}>
      <div className="flex min-h-svh bg-bg">
        <motion.aside
          initial={false}
          animate={{ width: collapsed ? 56 : 240 }}
          transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
          className={cn(
            "sticky top-0 hidden h-svh shrink-0 flex-col border-r border-line",
            "bg-sunken md:flex print:hidden"
          )}
        >
          <div className="flex h-12 items-center gap-2 px-3">
            {/* Collapsed, the mark is the only thing on screen naming the
                institution, so it carries the name; expanded, the wordmark
                beside it does and a second announcement is noise. */}
            <Mark
              className="size-6 text-accent"
              title={collapsed ? collegeName : undefined}
            />
            {!collapsed && (
              <span className="min-w-0 leading-tight">
                <span className="block truncate text-sm font-semibold">Publications</span>
                <span className="block truncate text-[11px] text-fg-subtle">{collegeName}</span>
              </span>
            )}
            <button
              type="button"
              onClick={() => setCollapsed((v) => !v)}
              aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
              className="ml-auto grid size-6 place-items-center rounded-sm text-fg-subtle hover:bg-hover hover:text-fg"
            >
              {collapsed ? <PanelLeft className="size-4" /> : <PanelLeftClose className="size-4" />}
            </button>
          </div>

          <nav className="flex-1 overflow-y-auto px-2 pb-2" aria-label="Main">
            {items.map((item) => {
              const heading = item.group && !seen.has(item.group) ? item.group : null
              if (item.group) seen.add(item.group)
              const Icon = item.icon
              return (
                <Fragment key={item.to}>
                  {heading && !collapsed ? (
                    <p className="px-2 pb-1 pt-4 text-xs font-medium text-fg-subtle">
                      {heading}
                    </p>
                  ) : null}
                  {heading && collapsed ? (
                    <div className="my-2 border-t border-line" />
                  ) : null}
                  <NavLink
                    to={item.to}
                    end={item.end}
                    title={collapsed ? item.label : undefined}
                    className={({ isActive }) =>
                      cn(
                        "relative flex h-8 items-center gap-2.5 rounded-md px-2 text-sm",
                        "transition-colors duration-[var(--dur-1)]",
                        isActive
                          ? "font-medium text-fg"
                          : "text-fg-muted hover:bg-hover hover:text-fg"
                      )
                    }
                  >
                    {({ isActive }) => (
                      <>
                        {isActive && (
                          <motion.span
                            layoutId="nav-active"
                            className="absolute inset-0 -z-10 rounded-md bg-active"
                            transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
                          />
                        )}
                        <Icon className="size-4 shrink-0" />
                        {!collapsed && <span className="truncate">{item.label}</span>}
                      </>
                    )}
                  </NavLink>
                </Fragment>
              )
            })}
          </nav>

          <div className="border-t border-line p-2">
            <button
              type="button"
              onClick={onOpenPalette}
              className={cn(
                "flex h-8 w-full items-center gap-2 rounded-md px-2 text-sm",
                "text-fg-muted hover:bg-hover hover:text-fg"
              )}
            >
              <Command className="size-4 shrink-0" />
              {!collapsed && (
                <>
                  <span>Jump to…</span>
                  <kbd className="ml-auto rounded border border-edge px-1 text-[10px] text-fg-subtle">
                    Ctrl K
                  </kbd>
                </>
              )}
            </button>
            <div className="mt-1 hidden md:flex md:items-center md:gap-2">
              <NotificationBell />
              {!collapsed && <span className="text-sm text-fg-muted">Notifications</span>}
            </div>
            <div className="mt-1">
              <AccountMenu collapsed={collapsed} />
            </div>
          </div>
        </motion.aside>

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="sticky top-0 z-30 flex h-12 items-center gap-2 border-b border-line bg-bg/85 px-3 backdrop-blur md:hidden print:hidden">
            <RadixDialog.Trigger asChild>
              <Button kind="quiet" size="icon" aria-label="Menu">
                <PanelLeft />
              </Button>
            </RadixDialog.Trigger>
            <Mark className="size-5 text-accent" />
            <span className="text-sm font-semibold">Publications</span>
            <Button
              kind="quiet"
              size="icon"
              className="ml-auto"
              onClick={onOpenPalette}
              aria-label="Jump to a page or ticket"
            >
              <Search />
            </Button>
            <NotificationBell />
          </header>

          {me?.impersonated_by && <ViewingAs name={me.name} role={me.role} />}

          <main className="min-w-0 flex-1 py-8">
            <Suspense fallback={<PageLoading />}>
              <Outlet />
            </Suspense>
          </main>
        </div>
      </div>

      {/* Portalled, so it is last in the document however early it is written
          here, and `AnimatePresence` rather than Radix decides when it leaves
          the tree, the same arrangement as `ui/dialog.tsx`. */}
      <AnimatePresence>
        {mobileOpen && (
          <RadixDialog.Portal forceMount>
            <RadixDialog.Overlay asChild forceMount>
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="fixed inset-0 z-40 bg-black/25 md:hidden"
              />
            </RadixDialog.Overlay>
            <RadixDialog.Content asChild forceMount aria-describedby={undefined}>
              <motion.aside
                initial={{ x: -260 }}
                animate={{ x: 0 }}
                exit={{ x: -260 }}
                transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
                className={cn(
                  "fixed inset-y-0 left-0 z-50 flex w-64 flex-col overflow-hidden",
                  "border-r border-line bg-sunken p-2 md:hidden"
                )}
              >
                <RadixDialog.Title className="sr-only">Menu</RadixDialog.Title>
                {/* The drawer covers the header it was opened from, so
                    without this it is a list of links belonging to nothing. */}
                <div className="mb-2 flex h-9 shrink-0 items-center gap-2 px-2">
                  <Mark className="size-5 text-accent" />
                  <span className="text-sm font-semibold">Publications</span>
                </div>
                <nav className="min-h-0 flex-1 overflow-y-auto" aria-label="Main">
                  {items.map((item) => {
                    const Icon = item.icon
                    return (
                      <NavLink
                        key={item.to}
                        to={item.to}
                        end={item.end}
                        className={({ isActive }) =>
                          cn(
                            "flex h-9 items-center gap-2.5 rounded-md px-2 text-sm",
                            isActive ? "bg-active font-medium" : "text-fg-muted"
                          )
                        }
                      >
                        <Icon className="size-4" />
                        {item.label}
                      </NavLink>
                    )
                  })}
                </nav>
                <div className="mt-2 shrink-0 border-t border-line pt-2">
                  <AccountMenu />
                </div>
              </motion.aside>
            </RadixDialog.Content>
          </RadixDialog.Portal>
        )}
      </AnimatePresence>
    </RadixDialog.Root>
  )
}

/** What the page area shows while a page's code arrives: nothing that could
 *  be mistaken for content, and only after a beat, so a fast load shows
 *  nothing at all. */
function PageLoading() {
  return (
    <div className="page" aria-busy="true" aria-label="Loading">
      <div className="h-7 w-48 animate-[pulse_1.6s_ease-in-out_infinite] rounded-md bg-hover opacity-0 [animation-delay:250ms]" />
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
        You are viewing the app as <strong>{name}</strong> ({ROLE_LABEL[role]}). Anything you do here
        is done as them.
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
        Back to your own account
      </Button>
    </div>
  )
}
