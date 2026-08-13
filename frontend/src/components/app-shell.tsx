"use client"

import { useState } from "react"
import { NavLink, Outlet, useNavigate } from "react-router-dom"
import {
  BookOpen,
  ClipboardCheck,
  FileSpreadsheet,
  LayoutDashboard,
  LogOut,
  Menu,
  Receipt,
  Settings2,
  Shield,
  Ticket,
  UserPlus,
  Users,
  Wallet,
} from "lucide-react"
import { toast } from "sonner"

import { useAuth } from "@/components/auth-provider"
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
    <div className="border-b border-sidebar-border px-4 py-5">
      <p className="text-xs text-muted-foreground">Saveetha Engineering College</p>
      <p className="mt-1 truncate text-base font-semibold tracking-tight text-sidebar-foreground">
        {title}
      </p>
      <p className="mt-1 text-xs text-muted-foreground">Publication remuneration</p>
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
                "flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                isActive
                  ? "bg-sidebar-accent text-sidebar-accent-foreground"
                  : "text-sidebar-foreground/80 hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground"
              )
            }
          >
            <Icon className="size-4 shrink-0 opacity-80" aria-hidden />
            <span>{t.label}</span>
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

  return (
    <div className="flex min-h-svh bg-background">
      <ChangePasswordGate />
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

        <main
          className={cn(
            "mx-auto w-full flex-1 px-4 py-5 md:px-6 md:py-6",
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

export function HodShell() {
  return (
    <AppShell
      title="HoD"
      tabs={[{ to: "/hod", label: "Approvals", icon: ClipboardCheck, end: true }]}
    />
  )
}

export function PrincipalShell() {
  return (
    <AppShell
      title="Principal"
      tabs={[
        { to: "/principal", label: "Approvals", icon: Shield, end: true },
        { to: "/principal/overview", label: "Overview", icon: LayoutDashboard },
      ]}
    />
  )
}

export function AdminShell() {
  const { user } = useAuth()
  // Only a super admin can actually use these two — the API refuses everyone
  // else, so showing them to the research cell offered a screen that 403s.
  const isSuperAdmin = user?.role === "SUPER_ADMIN"
  return (
    <AppShell
      title="Admin"
      wide
      tabs={[
        { to: "/admin", label: "Overview", icon: LayoutDashboard, end: true },
        { to: "/admin/submit", label: "Submit for faculty", icon: UserPlus },
        ...(isSuperAdmin
          ? [
              { to: "/admin/users", label: "Users", icon: Users },
              { to: "/admin/formula", label: "Formula", icon: Settings2 },
            ]
          : []),
        { to: "/admin/scimago", label: "Imports", icon: BookOpen },
        { to: "/admin/prior", label: "Prior payments", icon: Receipt },
        { to: "/admin/monthly", label: "Monthly", icon: FileSpreadsheet },
        { to: "/admin/audit", label: "Audit", icon: ClipboardCheck },
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
        // Finance owns the remuneration policy — can_edit_formula is FINANCE or
        // SUPER_ADMIN — but the only screen for it lived under /admin, which the
        // portal guard keeps Finance out of.
        { to: "/finance/formula", label: "Formula", icon: Settings2 },
      ]}
    />
  )
}

export { portalPath }
