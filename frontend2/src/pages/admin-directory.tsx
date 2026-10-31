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
import { Input, Select } from "@/ui/field"
import { filterBar } from "@/ui/filter-bar"
import { Answer } from "@/ui/answer"
import { Table, type Column } from "@/ui/table"
import { PageHeader } from "@/ui/page-header"
import { NotOpen } from "@/ui/state"

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

type DirRow = { item: NavItem; group: string; entry?: Count }

export function AdminDirectory() {
  const { me } = useAuth()
  const [find, setFind] = useState("")
  const [group, setGroup] = useState("")
  // A role that cannot open this page never calls the hub endpoint.
  const allowed = !me || pagesFor(me.role).some((p) => p.to === "/admin")
  const counts = useApi<HubPayload>(["admin", "hub"], "/api/admin/hub", {
    enabled: !!me && allowed,
    refetchInterval: 60_000,
  })
  const start = useStart(me?.role === "SUPER_ADMIN")
  const byRoute = counts.data?.counts ?? {}

  if (me && !allowed) {
    return (
      <div className="page py-8">
        <NotOpen message="Ask the research office if you think it should be yours." />
      </div>
    )
  }

  const q = find.trim().toLowerCase()
  const all = hubSections("admin", me?.role)
  const rows: DirRow[] = all
    .filter((s) => !group || s.title === group)
    .flatMap((s) => s.items.map((item) => ({ item, group: s.title, entry: byRoute[item.to] })))
    .filter((r) => !q || [r.item.label, r.item.purpose ?? "", ...(r.item.keywords ?? [])].some((t) => t.toLowerCase().includes(q)))
  const left = start.data ? start.data.total - start.data.done : 0
  const waitingTotal = Object.values(byRoute).reduce((s, c) => s + (c.count && c.count > 0 ? c.count : 0), 0)
  const pageCount = all.reduce((s, g) => s + g.items.length, 0)

  const columns: Column<DirRow>[] = [
    {
      key: "page",
      header: "Page",
      exportValue: (r) => r.item.label,
      cell: (r) => {
        const Icon = r.item.icon
        return (
          <span className="flex min-w-0 items-center gap-3 text-base font-medium">
            <Icon className="size-4 shrink-0 text-fg-subtle" aria-hidden />
            <span className="min-w-0 truncate">{r.item.label}</span>
          </span>
        )
      },
    },
    { key: "group", header: "Kind of work", exportValue: (r) => r.group, cell: (r) => r.group },
    {
      key: "purpose",
      header: "What it is for",
      empty: "No description",
      exportValue: (r) => r.item.purpose ?? "",
      cell: (r) => r.item.purpose ?? null,
    },
    {
      key: "waiting",
      header: "Waiting",
      align: "right",
      exportKind: "number",
      exportValue: (r) => (r.entry?.count && r.entry.count > 0 ? r.entry.count : 0),
      cell: (r) => {
        const waiting = r.entry?.count && r.entry.count > 0 ? r.entry.count : 0
        if (r.entry?.note && !waiting) return <span className="font-normal text-fg-muted">{r.entry.note}</span>
        return waiting > 0 ? (
          <span
            className={cn("font-semibold", r.entry?.tone === "critical" ? "text-critical" : "text-caution")}
            aria-label={`${waiting.toLocaleString("en-IN")} need attention`}
          >
            {formatCount(waiting)}
          </span>
        ) : (
          <span className="font-normal text-fg-muted">Nothing</span>
        )
      },
    },
  ]

  return (
    <div className="page space-y-6">
      <PageHeader
        title="Admin"
        sub="Every admin page, by the job it does. Open one from the table."
        action={
          start.data && !start.data.complete ? (
            <Button asChild kind="primary">
              <Link to="/admin/start">{left === 1 ? "Do the last step" : "Continue"}</Link>
            </Button>
          ) : undefined
        }
      />

      <Answer
        items={[
          { value: pageCount, label: "Admin pages" },
          { value: counts.data ? waitingTotal : null, label: "Things waiting on these pages", tone: "caution", zero: "Nothing is waiting" },
          ...(start.data
            ? [{ value: left, label: "Steps left to get the college running", to: "/admin/start", zero: "The college is running" }]
            : []),
        ]}
      />

      <div className={filterBar} role="search">
        <Input
          type="search"
          value={find}
          onChange={(e) => setFind(e.target.value)}
          placeholder="Find a page"
          aria-label="Find an admin page"
          className="w-full min-w-0 sm:w-80"
        />
        <Select aria-label="Kind of work" value={group} onChange={(e) => setGroup(e.target.value)} className="w-auto max-sm:w-full">
          <option value="">Every kind of work</option>
          {all.map((s) => (
            <option key={s.title} value={s.title}>
              {s.title}
            </option>
          ))}
        </Select>
        {(find || group) && (
          <Button
            kind="quiet"
            onClick={() => {
              setFind("")
              setGroup("")
            }}
          >
            Clear filters
          </Button>
        )}
      </div>

      <Table
        rows={rows}
        columns={columns}
        getKey={(r) => r.item.to}
        rowLink={(r) => r.item.to}
        maxHeight="none"
        caption="Admin pages"
        tools={{ id: "admin-pages", title: "Admin pages" }}
        empty={{
          icon: Search,
          title: "No admin page matches",
          message: find.trim() ? `Nothing matches \u201C${find.trim()}\u201D.` : "No page in this kind of work.",
          action: (
            <Button
              kind="default"
              onClick={() => {
                setFind("")
                setGroup("")
              }}
            >
              Clear filters
            </Button>
          ),
        }}
      />
    </div>
  )
}
