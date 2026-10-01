import { Link } from "react-router-dom"
import { ChevronRight } from "lucide-react"

import { useAuth } from "@/app/auth"
import { HOME_DATA } from "@/app/home-data"
import { hubSections, HUBS, pagesFor, type HubKey, type NavItem } from "@/app/nav"
import { cn } from "@/lib/cn"
import { formatCount } from "@/lib/count"
import { useApi } from "@/lib/query"
import { ReadinessList, unitFor, type DataFixes, type Readiness } from "@/pages/admin-parts"
import { PageHeader } from "@/ui/page-header"
import { MoneyDesk } from "@/pages/money-desk"
import type { IllustrationName } from "@/ui/illustration"
import { ErrorState, InlineError } from "@/ui/state"
import { HodReportsHub } from "@/pages/hod-reports-hub"
import { PrincipalMoneyHub, PrincipalReportsHub } from "@/pages/principal-reports-hub"
import { Meta, SectionTitle } from "@/ui/text"

/**
 * The pages that gather the rest.
 *
 * The office had forty-odd sidebar entries because every page that is opened
 * once a month was given the same standing as the one opened forty times a
 * day. A hub keeps the rare pages one click away instead: each is a row that
 * says what the page is for, and, where the server can tell, how many things
 * are waiting behind it. It is a list, not a grid of identical boxes; a row
 * with nothing waiting recedes, one with something waiting shows a number.
 *
 * The rows come from the same catalogue as the palette (`nav.ts`), so a page
 * cannot be on a hub and missing from Ctrl K, or the other way round.
 */

type Count = { count: number | null; tone: "critical" | "caution" | null; note: string | null }
type HubPayload = { counts: Record<string, Count> }

const HUB_PAGE: Record<HubKey, string> = { admin: "/admin", money: "/money", reports: "/reports/all", claims: "/track" }

const SPOT: Partial<Record<HubKey, IllustrationName>> = {
  admin: "spot-settings",
  money: "spot-budget",
  reports: "spot-reports",
}

function HubRow({ item, entry }: { item: NavItem; entry?: Count }) {
  const Icon = item.icon
  const waiting = entry?.count && entry.count > 0 ? entry.count : 0
  return (
    <li>
      <Link
        to={item.to}
        className="row group flex items-start gap-3 rounded-sm px-1 py-3"
      >
        <Icon className="mt-0.5 size-4 shrink-0 text-fg-subtle" aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="block text-base font-medium">{item.label}</span>
          {item.purpose && <Meta className="mt-0.5 block text-pretty">{item.purpose}</Meta>}
          {entry?.note && (
            <Meta className="mt-0.5 block text-fg-subtle">{entry.note}</Meta>
          )}
        </span>
        {waiting > 0 && (
          <span
            className={cn(
              "mt-0.5 min-w-6 shrink-0 rounded-full px-2 text-center text-xs font-semibold leading-6 tabular",
              entry?.tone === "critical" ? "bg-critical-wash text-critical" : "bg-caution-wash text-caution"
            )}
            aria-label={`${waiting.toLocaleString("en-IN")} need attention`}
          >
            {formatCount(waiting)}
          </span>
        )}
        <ChevronRight
          className="mt-1 size-4 shrink-0 text-fg-subtle opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100 max-sm:hidden"
          aria-hidden
        />
      </Link>
    </li>
  )
}

/**
 * Above the pages on Admin: is the system ready to do its job (six checks,
 * each with its fix), and which old-ERP claims still need a person. Both are
 * one line when there is nothing to do, and a list when there is.
 */
function AdminStatus({ role }: { role: string | undefined }) {
  const isSuper = role === "SUPER_ADMIN"
  const ready = useApi<Readiness>(HOME_DATA.readiness.key, HOME_DATA.readiness.path, { enabled: isSuper })
  const fixes = useApi<DataFixes>(["admin", "data-fixes", "hub"], "/api/admin/data-fixes?limit=1", {
    enabled: !!role,
  })
  const r = ready.data
  const allReady = r ? r.ok === r.total : false

  return (
    <div className="space-y-10">
      {isSuper && (
        <section aria-labelledby="readiness-title" className="space-y-3">
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <SectionTitle>
              <span id="readiness-title">Is the system ready?</span>
            </SectionTitle>
            {r && (
              <p className="text-sm text-fg-muted tabular" role="status">
                {allReady ? `All ${r.total} checks are ready.` : `${r.ok} of ${r.total} checks are ready.`}
              </p>
            )}
          </div>
          {ready.isError ? (
            <InlineError message="Could not run the readiness checks." onRetry={() => void ready.refetch()} />
          ) : !r ? (
            <div className="h-40" aria-hidden />
          ) : allReady ? (
            <details className="text-sm text-fg-muted">
              <summary className="cursor-pointer list-none underline-offset-4 hover:text-fg hover:underline">
                Show the checks
              </summary>
              <div className="mt-2">
                <ReadinessList data={r} />
              </div>
            </details>
          ) : (
            <ReadinessList data={r} />
          )}
        </section>
      )}

      {fixes.data && (
        <section aria-labelledby="fixes-title" className="space-y-3">
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <SectionTitle>
              <span id="fixes-title">Claims from the old ERP that need fixing</span>
            </SectionTitle>
            <Link to="/data/fixes" className="text-sm text-accent underline-offset-4 hover:underline">
              Open the fix list
            </Link>
          </div>
          {fixes.data.claims_needing_a_fix === 0 ? (
            <Meta className="block">Every claim imported from the old ERP has an amount, a title and a quartile.</Meta>
          ) : (
            <>
              <Meta className="block max-w-2xl">
                {fixes.data.claims_needing_a_fix.toLocaleString("en-IN")} claims came in with a hole in them.
                A claim number that starts ERP- was imported from the old ERP.
              </Meta>
              <ul className="divide-y divide-line border-y border-line">
                {fixes.data.queues.map((q) => (
                  <li key={q.key}>
                    <Link to={`/data/fixes?kind=${q.key}`} className="row flex items-start gap-3 px-1 py-2.5 sm:px-2">
                      <span className="min-w-0 flex-1">
                        <span className="block text-base">{q.label}</span>
                        <Meta className="block text-pretty">{q.why}</Meta>
                      </span>
                      <span className="shrink-0 text-right">
                        <span className={cn("block text-lg font-semibold leading-tight tabular", q.count === 0 && "text-fg-subtle")}>
                          {q.count.toLocaleString("en-IN")}
                        </span>
                        <span className="block text-xs text-fg-muted">{unitFor(q.count, "claims")}</span>
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      )}
    </div>
  )
}

function Hub({ hub, withCounts = false }: { hub: HubKey; withCounts?: boolean }) {
  const { me } = useAuth()
  const def = HUBS[hub]
  const sections = hubSections(hub, me?.role)
  const counts = useApi<HubPayload>(["admin", "hub"], "/api/admin/hub", {
    enabled: withCounts && !!me,
    refetchInterval: 60_000,
  })
  const byRoute = counts.data?.counts ?? {}
  const needing = sections
    .flatMap((s) => s.items)
    .filter((i) => (byRoute[i.to]?.count ?? 0) > 0 && byRoute[i.to]?.tone)
  const spot = SPOT[hub]
  const sub =
    hub === "admin"
      ? "Keep the people, the records, the money rules and the system right. A number beside a page is how many things wait there."
      : def.sub

  // A page that exists for everybody in the router is still not everybody's.
  if (me && !pagesFor(me.role).some((p) => p.to === HUB_PAGE[hub])) {
    return (
      <div className="page py-8">
        <ErrorState art="closed-gate" title="Not open to this account" message="Ask the research cell if you think it should be yours." />
      </div>
    )
  }

  return (
    <div className="page space-y-10">
      <PageHeader title={def.title} sub={sub} spot={spot}>
        {withCounts && counts.data && (
          <p className={cn("mt-3 text-base", needing.length ? "text-fg" : "text-fg-muted")} role="status">
            {needing.length === 0
              ? "Nothing on these pages is waiting."
              : needing.length === 1
                ? `Something is waiting on one page: ${needing[0].label}.`
                : `Something is waiting on ${needing.length} pages: ${needing.map((i) => i.label).join(", ")}.`}
          </p>
        )}
      </PageHeader>

      {withCounts && <AdminStatus role={me?.role} />}

      <div className="lg:columns-2 lg:gap-x-12">
        {sections.map((s) => (
          <section key={s.title} aria-labelledby={`hub-${s.title}`} className="mb-10 min-w-0 break-inside-avoid">
            <SectionTitle>
              <span id={`hub-${s.title}`}>{s.title}</span>
            </SectionTitle>
            {s.blurb && <Meta className="mt-0.5 block">{s.blurb}</Meta>}
            <ul className="mt-2 divide-y divide-line border-y border-line">
              {s.items.map((item) => (
                <HubRow key={item.to} item={item} entry={byRoute[item.to]} />
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
  return <Hub hub="admin" withCounts />
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
