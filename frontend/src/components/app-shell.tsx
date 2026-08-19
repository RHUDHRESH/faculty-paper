"use client"

import { useEffect, useState } from "react"
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom"
import {
  BarChart3,
  BookOpen,
  ClipboardCheck,
  FileSpreadsheet,
  LayoutDashboard,
  LogOut,
  Menu,
  Monitor,
  Moon,
  Receipt,
  Search,
  Settings2,
  Shield,
  Sun,
  Ticket,
  TriangleAlert,
  UserPlus,
  Users,
  Wallet,
  UserSearch,
  CheckCheck,
  Copy,
} from "lucide-react"
import { toast } from "sonner"

import { useAuth } from "@/components/auth-provider"
import { useTheme } from "@/lib/use-theme"
import { ChangePasswordDialog, ChangePasswordGate } from "@/components/change-password"
import { NotificationBell } from "@/components/notification-bell"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet"
import { cn, portalPath } from "@/lib/utils"
import { ImpersonationBanner } from "@/components/impersonation-banner"

type Tab = {
  to: string
  label: string
  icon: React.ComponentType<{ className?: string }>
  end?: boolean
}

function initials(name?: string) {
  if (!name) return "?"
  return name
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join("")
}

function BrandMark({ title }: { title: string }) {
  return (
    <div className="flex items-center gap-3 px-4 py-5">
      {/* A mark, not three stacked lines of text. It gives the sidebar a
          fixed anchor point and lets the portal name carry the weight. */}
      <span
        aria-hidden
        className="grid size-9 shrink-0 place-items-center rounded-[calc(var(--radius)*0.7)] bg-primary text-primary-foreground shadow-e1"
      >
        <span className="text-[0.9375rem] font-semibold tracking-tight">SE</span>
      </span>
      <span className="min-w-0">
        <span className="block truncate text-[0.9375rem] font-semibold leading-tight tracking-tight text-sidebar-foreground">
          {title}
        </span>
        <span className="block truncate text-xs leading-tight text-muted-foreground">
          Saveetha Engineering College
        </span>
      </span>
    </div>
  )
}

function NavItems({
  tabs,
  onNavigate,
  className,
}: {
  tabs: Tab[]
  onNavigate?: () => void
  className?: string
}) {
  return (
    <nav className={cn("flex flex-col gap-1 p-2", className)} aria-label="Main">
      {tabs.map((t) => {
        const Icon = t.icon
        return (
          <NavLink
            key={t.to}
            to={t.to}
            end={t.end}
            onClick={onNavigate}
            className={({ isActive }) =>
              cn(
                "group relative flex items-center gap-2.5 rounded-[calc(var(--radius)*0.7)] px-3 py-2 text-sm transition-colors duration-[120ms]",
                isActive
                  ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
                  : "font-normal text-sidebar-foreground/75 hover:bg-sidebar-accent/50 hover:text-sidebar-accent-foreground"
              )
            }
          >
            {({ isActive }) => (
              <>
                {/* A marker on the rail rather than only a filled pill: it
                    survives at a glance and points at the page you are on. */}
                <span
                  aria-hidden
                  className={cn(
                    "absolute left-0 top-1/2 h-4 w-[3px] -translate-y-1/2 rounded-r-full bg-primary transition-all duration-[160ms]",
                    isActive ? "opacity-100" : "opacity-0"
                  )}
                />
                <Icon
                  className={cn(
                    "size-4 shrink-0 transition-opacity",
                    isActive ? "opacity-100" : "opacity-60 group-hover:opacity-90"
                  )}
                  aria-hidden
                />
                <span>{t.label}</span>
              </>
            )}
          </NavLink>
        )
      })}
    </nav>
  )
}

function UserMenu() {
  const { user, logout, refresh } = useAuth()
  const nav = useNavigate()
  const [pwdOpen, setPwdOpen] = useState(false)
  const { theme, setTheme } = useTheme()

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            className="h-auto w-full justify-start gap-3 px-2 py-2 text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
            aria-label="Account menu"
          >
            <Avatar className="size-8 border border-sidebar-border">
              <AvatarFallback className="bg-sidebar-accent text-xs text-sidebar-accent-foreground">
                {initials(user?.name)}
              </AvatarFallback>
            </Avatar>
            <div className="min-w-0 flex-1 text-left">
              <div className="truncate text-sm font-medium">{user?.name}</div>
              <div className="truncate text-xs text-muted-foreground">
                {user?.role?.replace(/_/g, " ")}
              </div>
            </div>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" side="top" className="w-56">
          <DropdownMenuLabel className="font-normal">
            <div className="flex flex-col space-y-1">
              <p className="text-sm font-medium">{user?.name}</p>
              <p className="text-xs text-muted-foreground">{user?.email}</p>
            </div>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          {user?.role === "FACULTY" ? (
            <DropdownMenuItem onClick={() => nav("/faculty/profile")}>
              <Settings2 className="mr-2 size-4" />
              Profile
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem onClick={() => setPwdOpen(true)}>
            <Shield className="mr-2 size-4" />
            Change password
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
            Appearance
          </DropdownMenuLabel>
          <div className="px-1 pb-1">
            <div
              role="radiogroup"
              aria-label="Appearance"
              className="flex gap-1 rounded-lg bg-muted/60 p-1"
            >
              {(
                [
                  { value: "light", label: "Light", Icon: Sun },
                  { value: "dark", label: "Dark", Icon: Moon },
                  { value: "system", label: "Auto", Icon: Monitor },
                ] as const
              ).map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  role="radio"
                  aria-checked={theme === opt.value}
                  onClick={() => setTheme(opt.value)}
                  className={cn(
                    "flex flex-1 items-center justify-center gap-1 rounded-md px-2 py-1 text-xs font-medium transition-colors outline-none",
                    "focus-visible:ring-2 focus-visible:ring-ring/40",
                    theme === opt.value
                      ? "bg-card text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  <opt.Icon className="size-3.5" aria-hidden />
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onClick={async () => {
              await logout()
              toast.success("Signed out")
              nav("/login")
            }}
          >
            <LogOut className="mr-2 size-4" />
            Sign out
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <ChangePasswordDialog
        open={pwdOpen}
        onOpenChange={async (open) => {
          setPwdOpen(open)
          if (!open) await refresh()
        }}
      />
    </>
  )
}

export function AppShell({
  tabs,
  title,
  wide,
}: {
  tabs: Tab[]
  title: string
  wide?: boolean
}) {
  const [mobileOpen, setMobileOpen] = useState(false)
  const location = useLocation()
  // Radix sheets/dialogs set pointer-events:none on body. A leftover overlay
  // from My tickets made New ticket look frozen after the route had changed.
  useEffect(() => {
    document.body.style.pointerEvents = ""
    setMobileOpen(false)
  }, [location.pathname])

  return (
    <div className="flex min-h-svh bg-background">
      <ChangePasswordGate />
      {/* First tab stop on every page: without it a keyboard user walks the
          whole nav rail again on each navigation before reaching the form. */}
      <a
        href="#main-content"
        className="sr-only left-4 top-4 z-50 rounded-xl bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground focus:not-sr-only focus:absolute focus:outline-none focus:ring-3 focus:ring-ring/40"
        onClick={(e) => {
          e.preventDefault()
          const main = document.getElementById("main-content")
          main?.focus()
          main?.scrollIntoView({ block: "start" })
        }}
      >
        Skip to main content
      </a>
      <aside className="sticky top-0 hidden h-svh w-60 shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground md:flex">
        <BrandMark title={title} />
        <ScrollArea className="flex-1">
          <NavItems tabs={tabs} />
        </ScrollArea>
        <div className="space-y-3 border-t border-sidebar-border p-3">
          <div className="flex items-center justify-between px-1">
            <span className="text-xs text-muted-foreground">Notifications</span>
            <NotificationBell />
          </div>
          <Separator className="bg-sidebar-border" />
          <UserMenu />
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-border bg-background px-4 md:hidden">
          <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
            <SheetTrigger asChild>
              <Button variant="ghost" size="icon" className="shrink-0" aria-label="Open menu">
                <Menu className="size-5" />
              </Button>
            </SheetTrigger>
            <SheetContent
              side="left"
              className="flex w-72 flex-col border-sidebar-border bg-sidebar p-0 text-sidebar-foreground"
            >
              <SheetHeader className="p-0 text-left">
                <SheetTitle className="sr-only">{title} navigation</SheetTitle>
                <BrandMark title={title} />
              </SheetHeader>
              <div className="flex-1">
                <NavItems tabs={tabs} onNavigate={() => setMobileOpen(false)} />
              </div>
              <div className="mt-auto space-y-3 border-t border-sidebar-border p-3">
                <div className="flex items-center justify-between px-1">
                  <span className="text-xs text-muted-foreground">Notifications</span>
                  <NotificationBell />
                </div>
                <UserMenu />
              </div>
            </SheetContent>
          </Sheet>
          <div className="min-w-0 flex-1">
            <div className="truncate text-base font-semibold tracking-tight">{title}</div>
          </div>
          <NotificationBell />
        </header>

        {/* Sticky, undismissable: the whole risk of "view as" is forgetting. */}
        <ImpersonationBanner />

        <main
          id="main-content"
          tabIndex={-1}
          className={cn(
            "mx-auto w-full flex-1 px-4 py-5 outline-none md:px-6 md:py-6",
            wide ? "max-w-6xl" : "max-w-5xl"
          )}
        >
          <Outlet />
        </main>
      </div>
    </div>
  )
}

export function FacultyShell() {
  return (
    <AppShell
      title="Faculty"
      tabs={[
        { to: "/faculty", label: "My tickets", icon: Ticket, end: true },
        { to: "/faculty/new", label: "New ticket", icon: ClipboardCheck },
        { to: "/faculty/profile", label: "Profile", icon: Settings2 },
      ]}
    />
  )
}

export function PrincipalShell() {
  return (
    <AppShell
      title="Principal"
      tabs={[
        { to: "/principal", label: "Approvals", icon: CheckCheck, end: true },
        { to: "/principal/all", label: "All tickets", icon: Shield },
        { to: "/principal/overview", label: "Overview", icon: LayoutDashboard },
        // A ticket number off an email, or a staff id off a spreadsheet.
        { to: "/principal/find", label: "Find", icon: UserSearch },
        { to: "/principal/budget", label: "Budget", icon: Wallet },
        { to: "/principal/query", label: "Query", icon: Search },
        { to: "/principal/reports", label: "Reports", icon: BarChart3 },
      ]}
    />
  )
}

export function AdminShell() {
  const { user } = useAuth()
  // These two do not share a rule. can_manage_users accepts the whole admin
  // group, RESEARCH_CELL included — hiding Users from the research cell kept
  // them out of a screen the API grants them. can_edit_formula really is
  // FINANCE or SUPER_ADMIN only, so Formula stays behind the narrower check.
  const canManageUsers = user?.role === "SUPER_ADMIN" || user?.role === "RESEARCH_CELL"
  const canEditFormula = user?.role === "SUPER_ADMIN"
  return (
    <AppShell
      title="Admin"
      wide
      tabs={[
        { to: "/admin", label: "Overview", icon: LayoutDashboard, end: true },
        { to: "/admin/clearing", label: "Clearing queue", icon: ClipboardCheck },
        // Somebody rings about a ticket number; this is where it is looked up.
        { to: "/admin/find", label: "Find", icon: UserSearch },
        { to: "/admin/budget", label: "Budget", icon: Wallet },
        { to: "/admin/duplicates", label: "Duplicates", icon: Copy },
        { to: "/admin/submit", label: "Submit for faculty", icon: UserPlus },
        ...(canManageUsers ? [{ to: "/admin/users", label: "Users", icon: Users }] : []),
        ...(canEditFormula
          ? [{ to: "/admin/formula", label: "Formula", icon: Settings2 }]
          : []),
        { to: "/admin/scimago", label: "Imports", icon: BookOpen },
        { to: "/admin/prior", label: "Prior payments", icon: Receipt },
        { to: "/admin/monthly", label: "Monthly", icon: FileSpreadsheet },
        { to: "/admin/query", label: "Query", icon: Search },
        { to: "/admin/reports", label: "Reports", icon: BarChart3 },
        { to: "/admin/audit", label: "Audit", icon: ClipboardCheck },
        ...(canManageUsers
          ? [{ to: "/admin/faults", label: "Faults", icon: TriangleAlert }]
          : []),
      ]}
    />
  )
}

export function FinanceShell() {
  return (
    <AppShell
      title="Finance"
      wide
      tabs={[
        { to: "/finance", label: "Payment orders", icon: Wallet, end: true },
        { to: "/finance/paid", label: "Processed", icon: Receipt },
        { to: "/finance/ledger", label: "Ledger", icon: FileSpreadsheet },
        { to: "/finance/find", label: "Find", icon: UserSearch },
        { to: "/finance/budget", label: "Budget", icon: Wallet },
        { to: "/finance/duplicates", label: "Duplicates", icon: Copy },
        { to: "/finance/query", label: "Query", icon: Search },
        { to: "/finance/reports", label: "Reports", icon: BarChart3 },
        // Finance owns the remuneration policy — can_edit_formula is FINANCE or
        // SUPER_ADMIN — but the only screen for it lived under /admin, which the
        // portal guard keeps Finance out of.
        { to: "/finance/formula", label: "Formula", icon: Settings2 },
      ]}
    />
  )
}

export { portalPath }
