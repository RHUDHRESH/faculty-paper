import { Link } from "react-router-dom"
import { ChevronRight } from "lucide-react"

import { useAuth } from "@/app/auth"
import { hubSections, HUBS, pagesFor, type HubKey, type NavItem } from "@/app/nav"
import { AdminDirectory } from "@/pages/admin-directory"
import { PageHeader } from "@/ui/page-header"
import { MoneyDesk } from "@/pages/money-desk"
import type { IllustrationName } from "@/ui/illustration"
import { NotOpen } from "@/ui/state"
import { HodReportsHub } from "@/pages/hod-reports-hub"
import { PrincipalMoneyHub, PrincipalReportsHub } from "@/pages/principal-reports-hub"
import { Meta, SectionTitle } from "@/ui/text"

/**
 * The pages that gather the rest.
 *
 * The office had forty-odd sidebar entries because every page that is opened
 * once a month was given the same standing as the one opened forty times a
 * day. A hub keeps the rare pages one click away instead: each is a row that
 * says what the page is for. It is a list, not a grid of identical boxes.
 *
 * The rows come from the same catalogue as the palette (`nav.ts`), so a page
 * cannot be on a hub and missing from Ctrl K, or the other way round. The
 * Admin page is its own directory (`admin-directory.tsx`, docs/ux/29).
 */

const HUB_PAGE: Record<HubKey, string> = { admin: "/admin", money: "/money", reports: "/reports/all", claims: "/track" }

const SPOT: Partial<Record<HubKey, IllustrationName>> = {
  admin: "spot-settings",
  money: "spot-budget",
  reports: "spot-reports",
}

function HubRow({ item }: { item: NavItem }) {
  const Icon = item.icon
  return (
    <li>
      <Link to={item.to} className="row group flex items-start gap-3 rounded-sm px-1 py-3">
        <Icon className="mt-0.5 size-4 shrink-0 text-fg-subtle" aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="block text-base font-medium">{item.label}</span>
          {item.purpose && <Meta className="mt-0.5 block text-pretty">{item.purpose}</Meta>}
        </span>
        <ChevronRight
          className="mt-1 size-4 shrink-0 text-fg-subtle opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100 max-sm:hidden"
          aria-hidden
        />
      </Link>
    </li>
  )
}

function Hub({ hub }: { hub: HubKey }) {
  const { me } = useAuth()
  const def = HUBS[hub]
  const sections = hubSections(hub, me?.role)
  const spot = SPOT[hub]

  // A page that exists for everybody in the router is still not everybody's.
  if (me && !pagesFor(me.role).some((p) => p.to === HUB_PAGE[hub])) {
    return (
      <div className="page py-8">
        <NotOpen message="Ask the research office if you think it should be yours." />
      </div>
    )
  }

  return (
    <div className="page space-y-10">
      <PageHeader title={def.title} sub={def.sub} spot={spot} />

      <div className="lg:columns-2 lg:gap-x-12">
        {sections.map((s) => (
          <section key={s.title} aria-labelledby={`hub-${s.title}`} className="mb-10 min-w-0 break-inside-avoid">
            <SectionTitle>
              <span id={`hub-${s.title}`}>{s.title}</span>
            </SectionTitle>
            {s.blurb && <Meta className="mt-0.5 block">{s.blurb}</Meta>}
            <ul className="mt-2 divide-y divide-line border-y border-line">
              {s.items.map((item) => (
                <HubRow key={item.to} item={item} />
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  )
}

/** Set-up, data, money and the system, for the office. */
export function AdminHub() {
  return <AdminDirectory />
}

/** What is spent, the rules behind an amount, and the statements. */
export function MoneyHub() {
  const { me } = useAuth()
  if (me?.role === "PRINCIPAL") return <PrincipalMoneyHub />
  // The Director and Finance get the year's position first, and a live line
  // under each page (`money-desk.tsx`); everyone else keeps the plain hub.
  if (me?.role === "DIRECTOR" || me?.role === "FINANCE") return <MoneyDesk role={me.role} />
  return <Hub hub="money" />
}

/** Every report and lookup. */
export function ReportsHub() {
  const { me } = useAuth()
  // The Principal is asked questions, not for reports: her hub is the questions.
  if (me?.role === "PRINCIPAL") return <PrincipalReportsHub />
  // A head is asked "are we on track?", not for reports either.
  if (me?.role === "HOD") return <HodReportsHub />
  return <Hub hub="reports" />
}
