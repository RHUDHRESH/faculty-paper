import { Link, NavLink } from "react-router-dom"
import { Compass, Lightbulb, MessageCircleQuestionMark, ShieldCheck, type LucideIcon } from "lucide-react"

import { useAuth, type Role } from "@/app/auth"
import { CLAIMANTS, TRACK_ROLES } from "@/app/nav"
import { Button } from "@/ui/button"
import { PageHeader } from "@/ui/page-header"
import { segmentClass } from "@/ui/toggle"

/** The research compass is for the people who file papers. One check, used by the tabs and the list. */
export function canUseCompass(role: Role | undefined): boolean {
  return !!role && CLAIMANTS.includes(role)
}

type Tool = { to: string; label: string; line: string; icon: LucideIcon; canUse: (role: Role | undefined) => boolean }

const ANYONE = () => true

const TOOLS: Tool[] = [
  {
    to: "/journal-check",
    label: "Check a journal",
    line: "See if a journal is listed, safe, and what it pays before you submit.",
    icon: ShieldCheck,
    canUse: ANYONE,
  },
  {
    to: "/discover",
    label: "Discover",
    line: "Topics growing at the college, journals your colleagues use, and people to meet.",
    icon: Lightbulb,
    canUse: ANYONE,
  },
  {
    to: "/compass",
    label: "Research compass",
    line: "Who you are as a researcher, the paths open to you, and a plan to follow.",
    icon: Compass,
    canUse: canUseCompass,
  },
  {
    to: "/insights",
    label: "Ask the data",
    line: "Ask a question about the papers and claims in plain English.",
    icon: MessageCircleQuestionMark,
    canUse: (role) => !!role && TRACK_ROLES.includes(role),
  },
]

/** `/tools`: the research tools one role can use, as one plain list. */
export function ResearchTools() {
  const { me } = useAuth()
  const tools = TOOLS.filter((t) => t.canUse(me?.role))
  return (
    <div className="page space-y-8">
      <PageHeader title="Research tools" sub="Check a journal, find where to publish, and plan your next steps." />
      <ul className="divide-y divide-line border-y border-line">
        {tools.map((t) => {
          const Icon = t.icon
          return (
            <li key={t.to} className="flex items-center gap-3 py-3">
              <Icon aria-hidden className="size-4 shrink-0 text-fg-muted" strokeWidth={1.75} />
              <div className="min-w-0 flex-1">
                <Link to={t.to} className="font-medium text-fg underline-offset-2 hover:underline">
                  {t.label}
                </Link>
                <p className="text-sm text-fg-muted">{t.line}</p>
              </div>
              <Button kind="default" size="sm" asChild>
                <Link to={t.to}>Open</Link>
              </Button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

const TABS: Tool[] = TOOLS.filter((t) => t.to !== "/insights")

/** The research tools as one row of tabs, shown above each of their pages. The compass is for claimants only. */
export function ResearchToolsTabs() {
  const { me } = useAuth()
  return (
    <div className="flex items-center gap-3">
      <nav aria-label="Research tools" className="flex min-w-0 flex-1 gap-1 overflow-x-auto">
        {TABS.filter((t) => t.canUse(me?.role)).map((t) => (
          <NavLink key={t.to} to={t.to} className={({ isActive }) => segmentClass(isActive, "max-sm:h-10")}>
            {t.label}
          </NavLink>
        ))}
      </nav>
      <Button kind="quiet" size="sm" asChild>
        <Link to="/tools">All research tools</Link>
      </Button>
    </div>
  )
}
