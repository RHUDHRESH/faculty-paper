import { useQueryClient } from "@tanstack/react-query"
import { Link, useNavigate, useSearchParams } from "react-router-dom"

import { useAuth } from "@/app/auth"
import {
  destinationFor,
  groupByDay,
  listPath,
  NotificationLine,
  sectionTabsFor,
  type Notification,
} from "@/app/notifications"
import { api } from "@/lib/api"
import { formatCount } from "@/lib/count"
import { cn } from "@/lib/cn"
import { useApi } from "@/lib/query"
import { ChevronRight, Settings } from "lucide-react"

import { Button } from "@/ui/button"
import { InfoTip } from "@/ui/info"
import { segmentClass } from "@/ui/toggle"
import { EmptyState, ErrorState, SkeletonRows } from "@/ui/state"
import { Meta, SectionTitle } from "@/ui/text"
import { toast } from "@/ui/toast"
import { PageHeader } from "@/ui/page-header"

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


/**
 * Every alert, filterable by what it is about, and "This week": the Monday
 * summary as it stands right now, so nobody has to wait for Monday or dig
 * through their email to see it.
 */
export function NotificationsPage() {
  const [params, setParams] = useSearchParams()
  const tab = ["papers", "people", "work", "updates", "week"].includes(params.get("tab") ?? "") ? (params.get("tab") as string) : ""

  function pick(key: string) {
    setParams((prev) => {
      const next = new URLSearchParams(prev)
      if (key) next.set("tab", key)
      else next.delete("tab")
      return next
    })
  }

  const { me } = useAuth()
  const tabs = sectionTabsFor(me?.role)
  const count = useApi<{ unread: number }>(["notifications", "unread"], "/api/notifications/unread-count")
  const unread = count.data?.unread ?? 0
  return (
    <div className="page max-w-3xl space-y-6 py-8">
      <PageHeader
        title="Notifications"
        sub={unread > 0 ? `${formatCount(unread)} unread.` : "Nothing unread."}
        action={
          <Button kind="default" size="md" asChild>
            <Link to="/settings/notifications">
              <Settings />
              Notification settings
            </Link>
          </Button>
        }
      />

      <div
        role="tablist"
        aria-label="Which notifications"
        className="well inline-flex max-w-full gap-0.5 overflow-x-auto p-0.5"
      >
        {[...tabs, { key: "week", label: "This week" }].map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={tab === t.key}
            onClick={() => pick(t.key)}
            className={segmentClass(tab === t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "week" ? <ThisWeek /> : <AlertList section={tab} onShowAll={() => pick("")} />}
    </div>
  )
}

function AlertList({ section, onShowAll }: { section: string; onShowAll: () => void }) {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const query = useApi<Notification[]>(["notifications", "list", section, "page"], listPath(section))
  const items = query.data ?? []
  const unread = items.some((n) => !n.read)

  async function markAll() {
    try {
      await api("/api/notifications/read-all", { method: "POST" })
      await qc.invalidateQueries({ queryKey: ["notifications"] })
      toast.ok("Marked all read.")
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
        <Button
          kind="quiet"
          size="sm"
          disabled={!unread}
          title={unread ? undefined : "Everything here is already read"}
          onClick={() => void markAll()}
        >
          Mark all read
        </Button>
      </div>
      {items.length === 0 ? (
        <EmptyState
          illustration="empty-no-notifications"
          title={section ? "Nothing in this tab" : "You are all caught up"}
          action={
            section ? (
              <Button kind="default" size="sm" onClick={onShowAll}>
                Show all
              </Button>
            ) : (
              <Button kind="default" size="sm" asChild>
                <Link to="/settings/notifications">Choose what you hear about</Link>
              </Button>
            )
          }
        />
      ) : (
        groupByDay(items).map(([label, group]) => (
          <section key={label} aria-label={label} className="space-y-1">
            <h2 className="px-3 text-xs font-medium text-fg-subtle">{label}</h2>
            <ul className="divide-y divide-line border-y border-line">
              {group.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    onClick={() => open(item)}
                    className={cn(
                      "block w-full px-3 py-3 text-left outline-none transition-colors duration-[var(--dur-1)] ease-out hover:bg-hover",
                      "focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent",
                      !item.read && "bg-accent-wash"
                    )}
                  >
                    <NotificationLine item={item} />
                  </button>
                  {item.share_paper_id && (
                    <div className="pb-3 pl-14 pr-3">
                      <Button
                        kind="default"
                        size="sm"
                        onClick={() => navigate(`/discussions?share=${item.share_paper_id}`)}
                      >
                        Share to the feed
                      </Button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </section>
        ))
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
        onRetry={() => void query.refetch()}
      />
    )
  const w = query.data
  if (!w.eligible) return <EmptyState title="No weekly summary" message={w.reason ?? ""} />
  const nothing = !w.standing && !w.department && !w.collaborator && !w.open_items?.length
  return (
    <div className="space-y-6">
      <Meta className="flex items-center gap-1.5">
        The week of {w.week_of}
        <InfoTip label="About the weekly summary">
          As it stands now. The summary goes out on Monday at 8am
          {w.level === "off" ? ", but you have it switched off." : "."}
        </InfoTip>
      </Meta>
      {nothing && <EmptyState title="A quiet week" />}

      {w.standing && (
        <section className="space-y-1" aria-labelledby="week-standing">
          <SectionTitle id="week-standing">Where you stand</SectionTitle>
          <p className="text-sm">{w.standing.line}</p>
          {w.scoring && <Meta className="block">{w.scoring}</Meta>}
          <Button asChild kind="default" size="sm" className="mt-1">
            <Link to="/leaderboard">
              Open the leaderboard
              <ChevronRight />
            </Link>
          </Button>
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
