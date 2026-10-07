import { useState } from "react"
import { Link } from "react-router-dom"
import { Search } from "lucide-react"

import { useAuth } from "@/app/auth"
import { hubSections, pagesFor, type NavItem } from "@/app/nav"
import { cn } from "@/lib/cn"
import { formatCount } from "@/lib/count"
import { useApi } from "@/lib/query"
import { useStart } from "@/pages/admin-start"
import { Button } from "@/ui/button"
import { Input } from "@/ui/field"
import { PageHeader } from "@/ui/page-header"
import { ErrorState } from "@/ui/state"
import { SectionTitle } from "@/ui/text"

/**
 * The Admin page (docs/ux/29): every admin page, grouped by the job it does,
 * each a name and, where something waits behind it, one number. It is a
 * directory, not a report. Whether anything is wrong is Home's answer, and
 * "what is left before people can sign in" is the Get the college running page,
 * so neither is repeated here; what each page is for is the row's hover note
 * and the page's own header.
 *
 * The rows come from the same catalogue as Ctrl K (`nav.ts`), so a page cannot
 * be here and missing from the finder, or the other way round.
 */

type Count = { count: number | null; tone: "critical" | "caution" | null; note: string | null }
type HubPayload = { counts: Record<string, Count> }

function Row({ item, entry }: { item: NavItem; entry?: Count }) {
  const Icon = item.icon
  const waiting = entry?.count && entry.count > 0 ? entry.count : 0
  return (
    <li>
      <Link
        to={item.to}
        title={item.purpose}
        className="row group flex min-h-11 items-center gap-3 rounded-sm px-1 py-2"
      >
        <Icon className="size-4 shrink-0 text-fg-subtle" aria-hidden />
        <span className="min-w-0 flex-1 truncate text-base">{item.label}</span>
        {entry?.note && !waiting && <span className="shrink-0 text-sm text-fg-muted tabular">{entry.note}</span>}
        {waiting > 0 && (
          <span
            className={cn(
              "min-w-6 shrink-0 rounded-full px-2 text-center text-xs font-semibold leading-6 tabular",
              entry?.tone === "critical" ? "bg-critical-wash text-critical" : "bg-caution-wash text-caution"
            )}
            aria-label={`${waiting.toLocaleString("en-IN")} need attention`}
          >
            {formatCount(waiting)}
          </span>
        )}
      </Link>
    </li>
  )
}

export function AdminDirectory() {
  const { me } = useAuth()
  const [find, setFind] = useState("")
  const counts = useApi<HubPayload>(["admin", "hub"], "/api/admin/hub", {
    enabled: !!me,
    refetchInterval: 60_000,
  })
  const start = useStart(me?.role === "SUPER_ADMIN")
  const byRoute = counts.data?.counts ?? {}

  if (me && !pagesFor(me.role).some((p) => p.to === "/admin")) {
    return (
      <div className="page py-8">
        <ErrorState art="closed-gate" title="Not open to this account" message="Ask the research office if you think it should be yours." />
      </div>
    )
  }

  const q = find.trim().toLowerCase()
  const sections = hubSections("admin", me?.role)
    .map((s) => ({
      ...s,
      items: q
        ? s.items.filter((i) =>
            [i.label, i.purpose ?? "", ...(i.keywords ?? [])].some((t) => t.toLowerCase().includes(q))
          )
        : s.items,
    }))
    .filter((s) => s.items.length > 0)

  const left = start.data ? start.data.total - start.data.done : 0

  return (
    <div className="page space-y-10">
      <PageHeader title="Admin" spot="spot-settings" />

      {start.data && !start.data.complete && (
        <div className="flex flex-wrap items-center justify-between gap-3 border-y border-line py-4">
          <div>
            <p className="text-base font-medium">Get the college running</p>
            <p className="text-sm text-fg-muted tabular">
              {start.data.done} of {start.data.total} steps done
            </p>
          </div>
          <Button asChild kind="primary">
            <Link to="/admin/start">{left === 1 ? "Do the last step" : "Continue"}</Link>
          </Button>
        </div>
      )}

      <div className="relative max-w-md">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-fg-subtle" aria-hidden />
        <Input
          type="search"
          value={find}
          onChange={(e) => setFind(e.target.value)}
          placeholder="Find a page"
          aria-label="Find an admin page"
          className="pl-9"
        />
      </div>

      {sections.length === 0 ? (
        <p className="text-base text-fg-muted">No admin page matches &ldquo;{find.trim()}&rdquo;.</p>
      ) : (
        <div className="lg:columns-2 lg:gap-x-12">
          {sections.map((s) => (
            <section key={s.title} aria-labelledby={`dir-${s.title}`} className="mb-8 min-w-0 break-inside-avoid">
              <SectionTitle>
                <span id={`dir-${s.title}`}>{s.title}</span>
              </SectionTitle>
              <ul className="mt-1 divide-y divide-line border-y border-line">
                {s.items.map((item) => (
                  <Row key={item.to} item={item} entry={byRoute[item.to]} />
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  )
}
