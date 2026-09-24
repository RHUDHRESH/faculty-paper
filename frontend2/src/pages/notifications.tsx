import { useQueryClient } from "@tanstack/react-query"
import { Link, useNavigate, useSearchParams } from "react-router-dom"

import {
  destinationFor,
  GroupCount,
  listPath,
  relative,
  SECTION_TABS,
  type Notification,
} from "@/app/notifications"
import { api } from "@/lib/api"
import { cn } from "@/lib/cn"
import { useApi } from "@/lib/query"
import { Button } from "@/ui/button"
import { EmptyState, ErrorState, SkeletonRows } from "@/ui/state"
import { Meta, PageTitle, SectionTitle, Sub } from "@/ui/text"
import { toast } from "@/ui/toast"

type Week = {
  eligible: boolean
  reason?: string
  week_of?: string
  standing?: { rank: number; was: number | null; of: number; score: number; line: string } | null
  department?: {
    name: string
    count: number
    papers: { title: string; person: string; journal: string; href: string }[]
  } | null
  collaborator?: { id: string; name: string; department: string; why: string; href: string } | null
  open_items?: { title: string; state: string; reason: string; href: string }[]
  scoring?: string
  level?: string
}

const TABS = [...SECTION_TABS, { key: "week", label: "This week" }]

/**
 * Every alert, filterable by what it is about, and "This week": the Monday
 * summary as it stands right now, so nobody has to wait for Monday or dig
 * through their email to see it.
 */
export function NotificationsPage() {
  const [params, setParams] = useSearchParams()
  const tab = TABS.some((t) => t.key === params.get("tab")) ? (params.get("tab") as string) : ""

  function pick(key: string) {
    setParams((prev) => {
      const next = new URLSearchParams(prev)
      if (key) next.set("tab", key)
      else next.delete("tab")
      return next
    })
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <PageTitle>Notifications</PageTitle>
          <Sub>What happened to your papers, your posts and your work.</Sub>
        </div>
        <Link to="/settings/notifications" className="text-sm underline underline-offset-2">
          Notification settings
        </Link>
      </div>

      <div
        role="tablist"
        aria-label="Which notifications"
        className="inline-flex max-w-full gap-0.5 overflow-x-auto rounded-md bg-sunken p-0.5"
      >
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={tab === t.key}
            onClick={() => pick(t.key)}
            className={cn(
              "h-7 shrink-0 rounded-sm px-3 text-sm font-medium transition-colors",
              "duration-[var(--dur-1)] ease-out",
              tab === t.key ? "bg-surface text-fg" : "text-fg-muted hover:text-fg"
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "week" ? <ThisWeek /> : <AlertList section={tab} />}
    </div>
  )
}

function AlertList({ section }: { section: string }) {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const query = useApi<Notification[]>(["notifications", "list", section, "page"], listPath(section))
  const items = query.data ?? []
  const unread = items.some((n) => !n.read)

  async function markAll() {
    try {
      await api("/api/notifications/read-all", { method: "POST" })
      await qc.invalidateQueries({ queryKey: ["notifications"] })
    } catch (err) {
      toast.fail(err)
    }
  }

  function open(item: Notification) {
    if (!item.read) {
      void api(`/api/notifications/${item.id}/read`, { method: "POST" })
        .then(() => qc.invalidateQueries({ queryKey: ["notifications"] }))
        .catch(() => {})
    }
    const to = destinationFor(item.href)
    if (to) navigate(to)
  }

  if (query.isPending) return <SkeletonRows rows={5} rowHeight={56} />
  if (query.isError)
    return (
      <ErrorState
        title="Could not load your notifications"
        message="The server did not answer. Nothing has been lost."
        onRetry={() => void query.refetch()}
      />
    )
  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <Button kind="quiet" size="sm" disabled={!unread} onClick={() => void markAll()}>
          Mark all read
        </Button>
      </div>
      {items.length === 0 ? (
        <EmptyState title="Nothing here" message="You will hear when something concerns you." />
      ) : (
        <ul className="divide-y divide-line rounded-lg ring-1 ring-inset ring-edge">
          {items.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                onClick={() => open(item)}
                className={cn(
                  "block w-full px-3 py-3 text-left transition-colors duration-[var(--dur-1)] ease-out hover:bg-hover",
                  !item.read && "bg-accent-wash"
                )}
              >
                <span className="flex items-baseline gap-2">
                  <span className={cn("min-w-0 flex-1 text-sm", !item.read && "font-medium")}>{item.title}</span>
                  <GroupCount count={item.count} />
                  <Meta className="shrink-0 text-xs">{relative(item.created_at)}</Meta>
                </span>
                {item.body && <span className="mt-0.5 block whitespace-pre-line text-sm text-fg-muted">{item.body}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function ThisWeek() {
  const query = useApi<Week>(["notifications", "week"], "/api/notifications/digest")
  if (query.isPending) return <SkeletonRows rows={4} rowHeight={48} />
  if (query.isError)
    return (
      <ErrorState
        title="Could not put this week together"
        message="The server did not answer. Try again in a moment."
        onRetry={() => void query.refetch()}
      />
    )
  const w = query.data
  if (!w.eligible) return <EmptyState title="No weekly summary" message={w.reason ?? ""} />
  const nothing = !w.standing && !w.department && !w.collaborator && !w.open_items?.length
  return (
    <div className="space-y-6">
      <Meta className="block">
        The week of {w.week_of}, as it stands now. The summary goes out on Monday at 8am
        {w.level === "off" ? ", but you have it switched off." : "."}
      </Meta>
      {nothing && <EmptyState title="A quiet week" message="Nothing to report yet this week." />}

      {w.standing && (
        <section className="space-y-1" aria-labelledby="week-standing">
          <SectionTitle id="week-standing">Where you stand</SectionTitle>
          <p className="text-sm">{w.standing.line}</p>
          {w.scoring && <Meta className="block">{w.scoring}</Meta>}
          <Link to="/leaderboard" className="text-sm underline underline-offset-2">
            Open the leaderboard
          </Link>
        </section>
      )}

      {w.department && (
        <section className="space-y-2" aria-labelledby="week-department">
          <SectionTitle id="week-department">New in {w.department.name}</SectionTitle>
          <ul className="space-y-1.5">
            {w.department.papers.map((p) => (
              <li key={p.href} className="text-sm">
                <Link to={p.href} className="font-medium underline-offset-2 hover:underline">
                  {p.title}
                </Link>
                <Meta className="block">
                  {p.person}
                  {p.journal ? ` · ${p.journal}` : ""}
                </Meta>
              </li>
            ))}
          </ul>
          {w.department.count > w.department.papers.length && (
            <Meta className="block">and {w.department.count - w.department.papers.length} more.</Meta>
          )}
        </section>
      )}

      {w.collaborator && (
        <section className="space-y-1" aria-labelledby="week-collaborator">
          <SectionTitle id="week-collaborator">Somebody to write with</SectionTitle>
          <p className="text-sm">
            <Link to={w.collaborator.href} className="font-medium underline underline-offset-2">
              {w.collaborator.name}
            </Link>
            {w.collaborator.department ? `, ${w.collaborator.department}` : ""}
          </p>
          <Meta className="block">{w.collaborator.why}</Meta>
        </section>
      )}

      {!!w.open_items?.length && (
        <section className="space-y-2" aria-labelledby="week-open">
          <SectionTitle id="week-open">Waiting on you</SectionTitle>
          <ul className="space-y-1.5">
            {w.open_items.map((i) => (
              <li key={i.href} className="text-sm">
                <Link to={i.href} className="font-medium underline-offset-2 hover:underline">
                  {i.title}
                </Link>
                <Meta className="block">
                  {i.state}
                  {i.reason ? `: ${i.reason}` : ""}
                </Meta>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}
