import { useQueryClient } from "@tanstack/react-query"
import { Link, useNavigate, useSearchParams } from "react-router-dom"

import { useAuth } from "@/app/auth"
import {
  destinationFor,
  groupByDay,
  listPath,
  GroupCount,
  NotificationLead,
  relative,
  sectionTabsFor,
  type Notification,
} from "@/app/notifications"
import { api } from "@/lib/api"
import { formatCount } from "@/lib/count"
import { cn } from "@/lib/cn"
import { BADGES_KEY, useApi } from "@/lib/query"
import { ChevronRight, Settings } from "lucide-react"

import { Answer } from "@/ui/answer"
import { Button } from "@/ui/button"
import { filterBar } from "@/ui/filter-bar"
import { toDisplay } from "@/ui/mention-text"
import { Table, type Column } from "@/ui/table"
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
 *
 * The alerts are one table: what happened, when, whether it is still unread,
 * and the one thing to do with it. "This week" is a plain single column.
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
    <div className="page space-y-6">
      <PageHeader title="Notifications" sub={unread > 0 ? `${formatCount(unread)} unread.` : "Nothing unread."} />

      {tab === "week" ? (
        <>
          <Tabs tabs={tabs} tab={tab} pick={pick} />
          <div className="max-w-3xl">
            <ThisWeek />
          </div>
        </>
      ) : (
        <AlertList
          section={tab}
          onShowAll={() => pick("")}
          unread={count.data?.unread}
          tabs={<Tabs tabs={tabs} tab={tab} pick={pick} />}
        />
      )}
    </div>
  )
}

function Tabs({ tabs, tab, pick }: { tabs: { key: string; label: string }[]; tab: string; pick: (key: string) => void }) {
  return (
    <div role="tablist" aria-label="Which notifications" className="well inline-flex max-w-full gap-0.5 overflow-x-auto p-0.5">
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
  )
}

function AlertList({
  section,
  onShowAll,
  unread: unreadAll,
  tabs,
}: {
  section: string
  onShowAll: () => void
  unread: number | undefined
  tabs: React.ReactNode
}) {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const query = useApi<Notification[]>(["notifications", "list", section, "page"], listPath(section))
  const items = query.data ?? []
  const unread = items.some((n) => !n.read)
  const today = groupByDay(items).find(([label]) => label === "Today")?.[1].length ?? 0

  async function markAll() {
    try {
      await api("/api/notifications/read-all", { method: "POST" })
      void qc.invalidateQueries({ queryKey: BADGES_KEY })
      await qc.invalidateQueries({ queryKey: ["notifications"] })
      toast.ok("Marked all read.")
    } catch (err) {
      toast.fail(err)
    }
  }

  function open(item: Notification) {
    if (!item.read) {
      void api(`/api/notifications/${item.id}/read`, { method: "POST" })
        .then(() => {
          void qc.invalidateQueries({ queryKey: BADGES_KEY })
          return qc.invalidateQueries({ queryKey: ["notifications"] })
        })
        .catch(() => {})
    }
    const to = destinationFor(item.href)
    if (to) navigate(to)
  }

  const columns: Column<Notification>[] = [
    {
      key: "what",
      header: "What happened",
      exportValue: (n) => [n.title, n.body ? toDisplay(n.body).text : ""].filter(Boolean).join(". "),
      cell: (n) => (
        <span className="flex items-start gap-3">
          <NotificationLead item={n} />
          <span className="min-w-0">
            <button
              type="button"
              onClick={() => open(n)}
              className={cn("flex items-baseline gap-2 text-left text-base leading-snug hover:text-accent", !n.read && "font-medium")}
            >
              <span>{n.title}</span>
              <GroupCount count={n.count} />
            </button>
            {n.body && (
              <span className="mt-0.5 line-clamp-3 block whitespace-pre-line text-sm text-fg-muted">{toDisplay(n.body).text}</span>
            )}
          </span>
        </span>
      ),
    },
    {
      key: "when",
      header: "When",
      exportKind: "date",
      exportValue: (n) => n.created_at.slice(0, 10),
      cell: (n) => <span className="tabular text-fg-muted">{relative(n.created_at)}</span>,
    },
    {
      key: "status",
      header: "Status",
      exportValue: (n) => (n.read ? "Read" : "Unread"),
      cell: (n) =>
        n.read ? (
          <span className="text-fg-muted">Read</span>
        ) : (
          <span className="inline-flex items-center gap-2 font-medium">
            <span role="img" aria-label="Unread" className="size-2.5 rounded-full bg-accent" />
            Unread
          </span>
        ),
    },
    {
      key: "action",
      header: <span className="sr-only">Next step</span>,
      label: "Next step",
      cell: (n) =>
        n.share_paper_id ? (
          <Button kind="default" size="sm" onClick={() => navigate(`/discussions?share=${n.share_paper_id}`)}>
            Share to the feed
          </Button>
        ) : null,
    },
  ]

  return (
    <>
      <Answer
        items={[
          { value: unreadAll ?? null, label: "Unread", zero: "Nothing unread" },
          { value: query.isPending ? null : today, label: "Today", zero: "Nothing today" },
          { value: query.isPending ? null : items.length, label: section ? "In this tab" : "In all" },
        ]}
      />

      <div className={cn(filterBar, "items-center")}>
        {tabs}
        <Button
          kind="primary"
          disabled={!unread}
          title={unread ? undefined : "Everything here is already read"}
          onClick={() => void markAll()}
          className="sm:ml-auto"
        >
          Mark all read
        </Button>
        <Button kind="quiet" asChild>
          <Link to="/settings/notifications">
            <Settings />
            Notification settings
          </Link>
        </Button>
      </div>

      {query.isError ? (
        <ErrorState
          title="Could not load your notifications"
          message="The server did not answer. Nothing has been lost."
          onRetry={() => void query.refetch()}
        />
      ) : query.isPending ? (
        <SkeletonRows rows={5} rowHeight={56} />
      ) : (
        <Table
          rows={items}
          columns={columns}
          getKey={(n) => n.id}
          maxHeight="none"
          caption="Your notifications"
          tools={{ id: "notifications", title: "Notifications" }}
          empty={{
            illustration: "empty-no-notifications",
            title: section ? "Nothing in this tab" : "You are all caught up",
            action: section ? (
              <Button kind="default" onClick={onShowAll}>
                Show all
              </Button>
            ) : (
              <Button kind="default" asChild>
                <Link to="/settings/notifications">Choose what you hear about</Link>
              </Button>
            ),
          }}
        />
      )}
    </>
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
          <p className="text-base">{w.standing.line}</p>
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
              <li key={p.href} className="text-base">
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
          <p className="text-base">
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
              <li key={i.href} className="text-base">
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
