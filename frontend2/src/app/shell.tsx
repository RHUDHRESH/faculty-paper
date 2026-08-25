import { Fragment, useEffect, useState } from "react"
import { NavLink, Outlet, useLocation } from "react-router-dom"
import { AnimatePresence, motion } from "motion/react"
import { Bell, PanelLeft, PanelLeftClose, Search } from "lucide-react"

import { useAuth } from "@/app/auth"
import { navFor } from "@/app/nav"
import { Button } from "@/ui/button"
import { cn } from "@/lib/cn"

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
 */
export function Shell({ onOpenPalette }: { onOpenPalette: () => void }) {
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

  const items = navFor(me?.role)
  const seen = new Set<string>()

  return (
    <div className="flex min-h-svh bg-bg">
      <motion.aside
        initial={false}
        animate={{ width: collapsed ? 56 : 240 }}
        transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
        className={cn(
          "sticky top-0 hidden h-svh shrink-0 flex-col border-r border-line",
          "bg-sunken md:flex"
        )}
      >
        <div className="flex h-12 items-center gap-2 px-3">
          <div className="grid size-6 shrink-0 place-items-center rounded-sm bg-accent text-[11px] font-semibold text-white">
            SE
          </div>
          {!collapsed && <span className="truncate text-sm font-semibold">Publications</span>}
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
            <Search className="size-4 shrink-0" />
            {!collapsed && (
              <>
                <span>Search</span>
                <kbd className="ml-auto rounded border border-edge px-1 text-[10px] text-fg-subtle">
                  Ctrl K
                </kbd>
              </>
            )}
          </button>
          <NavLink
            to="/me"
            className={cn(
              "mt-1 flex h-9 items-center gap-2 rounded-md px-1.5 text-sm",
              "hover:bg-hover"
            )}
          >
            <span className="grid size-6 shrink-0 place-items-center rounded-full bg-accent-wash text-[10px] font-semibold text-accent">
              {(me?.name || "?").slice(0, 2).toUpperCase()}
            </span>
            {!collapsed && <span className="min-w-0 flex-1 truncate text-left">{me?.name}</span>}
          </NavLink>
        </div>
      </motion.aside>

      <AnimatePresence>
        {mobileOpen && (
          <>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setMobileOpen(false)}
              className="fixed inset-0 z-40 bg-black/25 md:hidden"
            />
            <motion.aside
              initial={{ x: -260 }}
              animate={{ x: 0 }}
              exit={{ x: -260 }}
              transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
              className="fixed inset-y-0 left-0 z-50 w-64 overflow-y-auto border-r border-line bg-sunken p-2 md:hidden"
            >
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
            </motion.aside>
          </>
        )}
      </AnimatePresence>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-12 items-center gap-2 border-b border-line bg-bg/85 px-3 backdrop-blur md:hidden">
          <Button kind="quiet" size="icon" onClick={() => setMobileOpen(true)} aria-label="Menu">
            <PanelLeft />
          </Button>
          <span className="text-sm font-semibold">Publications</span>
          <Button
            kind="quiet"
            size="icon"
            className="ml-auto"
            onClick={onOpenPalette}
            aria-label="Search"
          >
            <Search />
          </Button>
          <Button kind="quiet" size="icon" aria-label="Notifications">
            <Bell />
          </Button>
        </header>

        <main className="min-w-0 flex-1 py-8">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
