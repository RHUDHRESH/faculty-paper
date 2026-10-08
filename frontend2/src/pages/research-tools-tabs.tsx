import { Navigate, NavLink } from "react-router-dom"

import { useAuth } from "@/app/auth"
import { CLAIMANTS } from "@/app/nav"
import { segmentClass } from "@/ui/toggle"

/** `/tools` opens the compass for people who file papers, and Discover for everybody else. */
export function ToolsRedirect() {
  const { me, loading } = useAuth()
  if (loading) return null
  const to = me && CLAIMANTS.includes(me.role) ? "/compass" : "/discover"
  return <Navigate to={to} replace />
}

const TOOLS = [
  { to: "/compass", label: "Compass", claimantOnly: true },
  { to: "/discover", label: "Discover" },
  { to: "/journal-check", label: "Check a journal" },
]

/** The three research tools as one row of tabs, shown above each of their pages. The compass is for claimants only. */
export function ResearchToolsTabs() {
  const { me } = useAuth()
  const isClaimant = !!me && CLAIMANTS.includes(me.role)
  return (
    <nav aria-label="Research tools" className="flex gap-1 overflow-x-auto">
      {TOOLS.filter((t) => !t.claimantOnly || isClaimant).map((t) => (
        <NavLink key={t.to} to={t.to} className={({ isActive }) => segmentClass(isActive, "max-sm:h-10")}>
          {t.label}
        </NavLink>
      ))}
    </nav>
  )
}
