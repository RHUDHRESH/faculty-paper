import { keepPreviousData, useQueryClient } from "@tanstack/react-query"
import { useEffect, useRef, useState } from "react"
import { Link, useNavigate, useSearchParams } from "react-router-dom"

import { useAuth } from "@/app/auth"
import { notificationsOf, useBadges } from "@/app/badges"
import {
  destinationFor,
  groupByDay,
  listPath,
  GroupCount,
  NotificationLead,
  readLabel,
  relative,
  sectionTabsFor,
  useNotificationActions,
  type Notification,
  type ReadState,
} from "@/app/notifications"
import { cn } from "@/lib/cn"
import { formatCount } from "@/lib/count"
import { useApi } from "@/lib/query"
import { ChevronRight, Settings } from "lucide-react"

import { Button } from "@/ui/button"
import { toDisplay } from "@/ui/mention-text"
import { InfoTip } from "@/ui/info"
import { segmentClass } from "@/ui/toggle"
import { EmptyState, ErrorState, SkeletonRows } from "@/ui/state"
import { Meta, SectionTitle } from "@/ui/text"
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

/** How many rows one page of the list shows. The list asks for one more, to know there is another page. */
const PAGE = 30

const STATES: { key: ReadState; label: string }[] = [
  { key: "", label: "All" },
  { key: "unread", label: "Unread" },
  { key: "read", label: "Read" },
]

/**
 * Every alert, newest first and grouped by day, and "This week": the Monday
 * summary as it stands right now, so nobody has to wait for Monday or dig
 * through their email to see it.
 *
 * Each row is a link to what it is about, and opening it marks it read. What
 * has not been read is marked by a bar, a dot, a heavier title and the word
 * "Unread"; what has been read is plain text, not faded. The number in the
 * heading is the bell's own number, so the two cannot disagree.
 */
export function NotificationsPage() {
  const [params, setParams] = useSearchParams()
  const tab = ["papers", "people", "work", "updates", "week"].includes(params.get("tab") ?? "") ? (params.get("tab") as string) : ""
  const state: ReadState = params.get("state") === "unread" ? "unread" : params.get("state") === "read" ? "read" : ""

  function change(key: string, value: string) {
    setParams((prev) => {
      const next = new URLSearchParams(prev)
      if (value) next.set(key, value)
      else next.delete(key)
      return next
    })
  }

  const { me } = useAuth()
  const tabs = sectionTabsFor(me?.role)
  // The same slice the bell reads, so the heading and the badge are one number.
  const count = useBadges(notificationsOf)
  const unread = count.data?.unread
  return (
    <div className="page space-y-6">
      <PageHeader title="Notifications" sub={unread ? `${formatCount(unread)} unread.` : "Nothing unread."} />

      {tab === "week" ? (
        <>
          <Tabs tabs={tabs} tab={tab} pick={(key) => change("tab", key)} />
          <div className="max-w-3xl">
            <ThisWeek />
          </div>
        </>
      ) : (
        <AlertList
          section={tab}
          state={state}
          unread={unread}
          onState={(key) => change("state", key)}
          onShowAll={() => setParams({})}
          tabs={<Tabs tabs={tabs} tab={tab} pick={(key) => change("tab", key)} />}
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

function emptyTitle(section: string, state: ReadState): string {
  if (state === "unread") return "Nothing unread."
  if (state === "read") return "Nothing has been read yet."
  return section ? "Nothing in this tab." : "You are all caught up."
}

function AlertList({
  section,
  state,
  unread: unreadAll,
  onState,
  onShowAll,
  tabs,
}: {
  section: string
  state: ReadState
  unread: number | undefined
  onState: (key: ReadState) => void
  onShowAll: () => void
  tabs: React.ReactNode
}) {
  const qc = useQueryClient()
  const { me } = useAuth()
  const { markAll } = useNotificationActions()
  const [shown, setShown] = useState(PAGE)
  // Ask for one more than is shown: if it comes back, there is another page.
  const query = useApi<Notification[]>(
    ["notifications", "list", section, state, shown],
    listPath(section, state, shown + 1),
    { placeholderData: keepPreviousData }
  )
  const rows = query.data ?? []
  const items = rows.slice(0, shown)
  const hasMore = rows.length > shown
  const anyUnread = section ? items.some((n) => !n.read) : (unreadAll ?? 0) > 0

  // A new alert arrived (the badge's number moved): read the list again, so the
  // page never sits on a list older than its own heading.
  const seen = useRef<number | undefined>(undefined)
  useEffect(() => {
    if (unreadAll === undefined) return
    if (seen.current !== undefined && seen.current !== unreadAll) {
      void qc.invalidateQueries({ queryKey: ["notifications", "list"] })
    }
    seen.current = unreadAll
  }, [unreadAll, qc])

  // A different tab or filter starts again at the first page.
  useEffect(() => {
    setShown(PAGE)
  }, [section, state])

  return (
    <>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        {tabs}
        <div role="group" aria-label="Read or unread" className="well inline-flex gap-0.5 p-0.5">
          {STATES.map((s) => (
            <button
              key={s.key}
              type="button"
              aria-pressed={state === s.key}
              onClick={() => onState(s.key)}
              className={segmentClass(state === s.key)}
            >
              {s.label}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2 sm:ml-auto">
          {anyUnread && state !== "read" && (
            <Button kind="primary" onClick={() => void markAll(section)}>
              Mark all read
            </Button>
          )}
          <Button kind="quiet" asChild>
            <Link to="/settings/notifications">
              <Settings />
              Notification settings
            </Link>
          </Button>
        </div>
      </div>

      {query.isError ? (
        <ErrorState
          title="Could not load your notifications"
          message="The server did not answer. Nothing has been lost."
          onRetry={() => void query.refetch()}
        />
      ) : query.isPending ? (
        <SkeletonRows rows={5} rowHeight={56} />
      ) : items.length === 0 ? (
        <EmptyState
          illustration="empty-no-notifications"
          title={emptyTitle(section, state)}
          action={
            section || state ? (
              <Button kind="default" onClick={onShowAll}>
                Show all
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div className="space-y-5">
          {groupByDay(items).map(([label, group]) => (
            <section key={label} aria-label={label} className="space-y-1.5">
              <h2 className="px-1 text-sm font-medium text-fg-subtle">{label}</h2>
              <ul className="divide-y divide-line overflow-hidden rounded-xl border border-edge bg-surface">
                {group.map((n) => (
                  <li key={n.id}>
                    <AlertRow item={n} role={me?.role} />
                  </li>
                ))}
              </ul>
            </section>
          ))}
          {hasMore && (
            <div className="flex justify-center">
              <Button kind="default" onClick={() => setShown((n) => n + PAGE)}>
                Show older
              </Button>
            </div>
          )}
        </div>
      )}
    </>
  )
}

/**
 * One alert. A link to what it is about when that still exists, and opening it
 * reads it. An alert about something since deleted says so and goes nowhere,
 * but can still be read.
 */
function AlertRow({ item, role }: { item: Notification; role: string | undefined }) {
  const navigate = useNavigate()
  const { markRead } = useNotificationActions()
  const to = item.gone ? null : destinationFor(item.href, role)
  const open = () => {
    if (!item.read) void markRead(item.id)
  }

  const inner = (
    <>
      <NotificationLead item={item} />
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-baseline gap-x-2">
          <span className={cn("text-base leading-snug", item.read ? "font-normal" : "font-semibold")}>{item.title}</span>
          <GroupCount count={item.count} />
        </span>
        {item.body && (
          <span className="mt-0.5 line-clamp-3 block whitespace-pre-line text-sm text-fg-muted">{toDisplay(item.body).text}</span>
        )}
        {item.gone && <span className="mt-0.5 block text-sm text-fg-subtle">No longer available.</span>}
        <span className="mt-1 flex items-center gap-2 text-sm text-fg-muted sm:hidden">
          <span className="tabular">{relative(item.created_at)}</span>
          <ReadMark item={item} />
        </span>
      </span>
      <span className="hidden w-28 shrink-0 flex-col items-end gap-0.5 text-right text-sm text-fg-muted sm:flex">
        <span className="tabular">{relative(item.created_at)}</span>
        <ReadMark item={item} />
      </span>
    </>
  )

  const shell = cn(
    "flex w-full items-start gap-3 px-4 py-3 text-left outline-none",
    "focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent"
  )

  return (
    // The bar and the wash are on the whole row, share button included.
    <div className={cn("border-l-[3px]", item.read ? "border-transparent" : "border-accent bg-accent-wash")}>
      {to ? (
        <Link to={to} onClick={open} className={cn(shell, "hover:bg-hover")}>
          {inner}
        </Link>
      ) : (
        <button type="button" onClick={open} className={cn(shell, !item.read && "hover:bg-hover")}>
          {inner}
        </button>
      )}
      {item.share_paper_id && (
        // Outside the row's link: a control inside a link is two targets read as one.
        <div className="pb-3 pl-[4.25rem] pr-4">
          <Button
            kind="default"
            size="sm"
            onClick={() => {
              open()
              navigate(`/discussions?share=${item.share_paper_id}`)
            }}
          >
            Share to the feed
          </Button>
        </div>
      )}
    </div>
  )
}

/** Unread, with a dot, or when it was read. Never "not recorded": an old row has no date and says just "Read". */
function ReadMark({ item }: { item: Notification }) {
  if (!item.read) {
    return (
      <span className="inline-flex items-center gap-1.5 font-medium text-fg">
        <span aria-hidden="true" className="size-2 rounded-full bg-accent" />
        Unread
      </span>
    )
  }
  return <span>{readLabel(item)}</span>
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
