import { useEffect, useState } from "react"
import { useSearchParams } from "react-router-dom"
import { keepPreviousData, useQueryClient } from "@tanstack/react-query"
import { ListFilter, Plus, Search as SearchIcon } from "lucide-react"

import { cn } from "@/lib/cn"
import { useApi } from "@/lib/query"
import { Button } from "@/ui/button"
import { Input, Select } from "@/ui/field"
import { PageHeader } from "@/ui/page-header"
import { Details, Rows, Section } from "@/ui/section"
import { Delayed, EmptyState, ErrorState, InlineError, Skeleton } from "@/ui/state"
import { FilterChip, Segmented } from "@/ui/toggle"
import {
  addDays,
  dayRange,
  dayWords,
  eventsPath,
  groupByMonth,
  kindWord,
  type EventFilters,
  type EventsPayload,
  type HubEvent,
} from "@/pages/events-model"
import { EventCard, EventDialog, EventSheet } from "@/pages/events-parts"
import { Showcase } from "@/pages/events-showcase"

/**
 * Seminars, workshops and calls for papers, and what the college has published
 * lately, on one page.
 *
 * The owner's words were "practically invisible": the only place a seminar
 * could be was the calendar, and research work was visible only to whoever
 * went looking. So this page leads with what is on this week, then the rest by
 * month, and keeps the archive folded away; its other half is the research
 * showcase (`events-showcase.tsx`).
 *
 * Everything that narrows the list lives in the address (`?kind=`,
 * `?department=`, `?q=`), and so does the open event (`?event=`), so a
 * filtered view can be shared and a link in a notification opens its seminar.
 */

function useEventList(when: string, filters: EventFilters, limit: number | undefined, enabled = true) {
  return useApi<EventsPayload>(
    ["events", "list", when, filters.kind ?? "", filters.department ?? "", filters.q ?? "", limit ?? 0],
    eventsPath(when, filters, limit),
    // The old list stays up while the new one arrives: a page that blanks on
    // every keystroke looks broken.
    { enabled, placeholderData: keepPreviousData }
  )
}

/** An event the page has already been sent, wherever it came from: the week, the month or the archive. */
function useKnownEvent(id: string | null): HubEvent | null {
  const qc = useQueryClient()
  if (!id) return null
  for (const [, payload] of qc.getQueriesData<EventsPayload>({ queryKey: ["events", "list"] })) {
    const hit = payload?.results.find((e) => e.id === id)
    if (hit) return hit
  }
  return null
}

export function Events() {
  const [params, setParams] = useSearchParams()
  const view = params.get("view") === "research" ? "research" : "events"
  const filters: EventFilters = {
    kind: params.get("kind") ?? "",
    department: params.get("department") ?? "",
    q: params.get("q") ?? "",
  }
  const eventId = params.get("event")

  function change(changes: Record<string, string | null>) {
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        for (const [key, value] of Object.entries(changes)) {
          if (value) next.set(key, value)
          else next.delete(key)
        }
        return next
      },
      { replace: true }
    )
  }

  const upcoming = useEventList("upcoming", filters, 200, view === "events")
  const meta = upcoming.data
  const [dialog, setDialog] = useState<{ existing: HubEvent | null } | null>(null)
  const open = useKnownEvent(view === "events" ? eventId : null)

  // `/events?add=1` opens the add dialog straight away: the Discussions
  // composer links here so an announced seminar can become a real listing.
  const wantsAdd = params.get("add") === "1"
  useEffect(() => {
    if (!wantsAdd || view !== "events" || !meta) return
    if (meta.can_add) setDialog({ existing: null })
    change({ add: null })
    // `change` only rewrites the address; running again on every render would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wantsAdd, view, meta?.can_add])

  return (
    <div className="page space-y-8 pb-16">
      <PageHeader
        title="Events and research"
        sub="What is on at the college, and what your colleagues have been publishing."
        spot="spot-calendar"
        action={
          view === "events" && meta?.can_add ? (
            <Button kind="primary" onClick={() => setDialog({ existing: null })}>
              <Plus />
              Add an event
            </Button>
          ) : undefined
        }
      />
      <Segmented
        label="Show"
        value={view}
        onChange={(id) => change({ view: id === "research" ? "research" : null, event: null })}
        items={[
          { id: "events", label: "Events" },
          { id: "research", label: "Research showcase" },
        ]}
      />

      {view === "events" ? (
        <EventsView
          filters={filters}
          upcoming={upcoming}
          change={change}
          onAdd={() => setDialog({ existing: null })}
          onOpen={(e) => change({ event: e.id })}
        />
      ) : (
        <Showcase />
      )}

      {open && meta && (
        <EventSheet
          event={open}
          today={meta.today}
          onClose={() => change({ event: null })}
          onEdit={(e) => {
            change({ event: null })
            setDialog({ existing: e })
          }}
        />
      )}
      {dialog && meta && <EventDialog existing={dialog.existing} meta={meta} onClose={() => setDialog(null)} />}
    </div>
  )
}

/* ------------------------------------------------------------------------ */
/* The events half                                                           */
/* ------------------------------------------------------------------------ */

type View = {
  filters: EventFilters
  upcoming: ReturnType<typeof useEventList>
  change: (changes: Record<string, string | null>) => void
  onAdd: () => void
  onOpen: (e: HubEvent) => void
}

function EventsView({ filters, upcoming, change, onAdd, onOpen }: View) {
  const week = useEventList("week", filters, undefined)
  const data = upcoming.data
  const filtered = Boolean(filters.kind || filters.department || filters.q)

  if (upcoming.isError) {
    return <ErrorState what="events" onRetry={() => void upcoming.refetch()} />
  }
  if (!data) {
    return (
      <Delayed>
        <Skeleton className="h-64" />
      </Delayed>
    )
  }

  const inWeek = new Set((week.data?.results ?? []).map((e) => e.id))
  const later = data.results.filter((e) => !inWeek.has(e.id))
  const nothing = data.results.length === 0
  const clear = () => change({ kind: null, department: null, q: null })

  return (
    <div className="space-y-10">
      <FilterBar filters={filters} data={data} change={change} />

      {nothing ? (
        filtered ? (
          <EmptyState
            illustration="empty-no-results"
            title="Nothing matches that"
            message="Try another kind or department, or look at everything that is coming."
            action={<Button onClick={clear}>Clear the filters</Button>}
          />
        ) : (
          <EmptyState
            illustration="empty-calendar"
            title="Nothing is on yet"
            message="Seminars, workshops, conferences and calls for papers are listed here once somebody posts one."
            action={
              data.can_add ? (
                <Button kind="primary" onClick={onAdd}>
                  <Plus />
                  Add an event
                </Button>
              ) : undefined
            }
          />
        )
      ) : (
        <>
          <ThisWeek week={week.data} failed={week.isError} next={data.results[0]} today={data.today} onOpen={onOpen} />
          {(week.data || week.isError) &&
            groupByMonth(later).map((group) => (
              <Section key={group.key} title={group.label}>
                <Rows>
                  {group.events.map((e) => (
                    <li key={e.id}>
                      <EventCard event={e} today={data.today} variant="row" onOpen={() => onOpen(e)} />
                    </li>
                  ))}
                </Rows>
              </Section>
            ))}
        </>
      )}

      <div className="space-y-1">
        <p className="text-sm text-fg-muted">
          {data.seminars_this_year > 0 ? `Seminars so far this year: ${data.seminars_this_year}` : "No seminars so far this year."}
        </p>
        <Details summary="Past events">
          <PastEvents filters={filters} today={data.today} onOpen={onOpen} />
        </Details>
      </div>
    </div>
  )
}

function FilterBar({
  filters,
  data,
  change,
}: {
  filters: EventFilters
  data: EventsPayload
  change: View["change"]
}) {
  // The search box answers at once; the request waits until the typing stops.
  const [typed, setTyped] = useState(filters.q ?? "")
  useEffect(() => {
    const wanted = typed.trim()
    if (wanted === (filters.q ?? "")) return
    const timer = setTimeout(() => change({ q: wanted || null }), 300)
    return () => clearTimeout(timer)
  }, [typed, filters.q, change])
  useEffect(() => {
    // Cleared from outside (Clear the filters).
    if (!filters.q) setTyped("")
  }, [filters.q])

  const total = Object.values(data.counts).reduce((a, b) => a + b, 0)
  const chips = data.kinds.filter((k) => (data.counts[k.key] ?? 0) > 0 || filters.kind === k.key)
  // On a phone the kinds and the department fold behind one button, so the
  // first screen is the week and not a block of controls. The search stays out.
  const [folded, setFolded] = useState(true)
  const narrowedBy = [filters.kind, filters.department].filter(Boolean).length
  // The DOM runs in the order it reads on a desk (kinds, department, search), so
  // the keyboard follows the eye; on a phone `order` puts the search first.
  return (
    <div className="well grid grid-cols-1 gap-3 p-3 sm:grid-cols-[15rem_minmax(0,1fr)] sm:gap-x-3 sm:p-4">
      <div role="group" aria-label="Kind" className={cn("flex flex-wrap gap-2 sm:col-span-2", "max-sm:order-3", folded && "max-sm:hidden")}>
        <FilterChip
          on={!filters.kind}
          onClick={() => change({ kind: null })}
          count={total}
          className={cn(!filters.kind && "bg-navy-wash text-fg ring-navy/40 hover:bg-navy-wash")}
        >
          All
        </FilterChip>
        {chips.map((k) => (
          <FilterChip
            key={k.key}
            on={filters.kind === k.key}
            onClick={() => change({ kind: filters.kind === k.key ? null : k.key })}
            count={data.counts[k.key] ?? 0}
            className={cn(filters.kind === k.key && "bg-navy-wash text-fg ring-navy/40 hover:bg-navy-wash")}
          >
            {kindWord(k.key)}
          </FilterChip>
        ))}
      </div>
      <div className={cn("max-sm:order-4", folded && "max-sm:hidden")}>
        <Select
          aria-label="Department"
          value={filters.department ?? ""}
          onChange={(e) => change({ department: e.target.value || null })}
        >
          <option value="">All departments</option>
          {data.departments.map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </Select>
      </div>
      <div className="relative min-w-0 max-sm:order-1">
        <SearchIcon aria-hidden className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-fg-subtle" />
        <Input
          type="search"
          aria-label="Search events"
          placeholder="Search by title, speaker or place"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          className="pl-10"
        />
      </div>
      <Button
        kind="quiet"
        size="sm"
        className="justify-self-start sm:hidden max-sm:order-2"
        aria-expanded={!folded}
        onClick={() => setFolded((v) => !v)}
      >
        <ListFilter />
        {folded ? "Kind and department" : "Hide kind and department"}
        {folded && narrowedBy > 0 && <span className="tabular text-accent">({narrowedBy})</span>}
      </Button>
    </div>
  )
}

/**
 * What is on in the next seven days: the first card carries the page's answer
 * (the next thing to go to), the rest are ordinary cards. Said as "This week"
 * with the days it covers, because a week that begins on a Saturday is not the
 * one on the wall.
 */
function ThisWeek({
  week,
  failed,
  next,
  today,
  onOpen,
}: {
  week: EventsPayload | undefined
  failed: boolean
  next: HubEvent | undefined
  today: string
  onOpen: (e: HubEvent) => void
}) {
  const range = dayRange({ starts_on: today, ends_on: addDays(today, 6) })
  const events = week?.results ?? []
  return (
    <Section title="This week" action={<span className="text-fg-muted">{range}</span>}>
      {failed ? (
        <InlineError message="Could not load this week. The list below is still right." />
      ) : !week ? (
        <Delayed>
          <Skeleton className="h-40" />
        </Delayed>
      ) : events.length === 0 ? (
        <p className="max-w-prose text-base text-fg-muted">
          Nothing is on this week.
          {next && (
            <>
              {" "}
              The next one is{" "}
              <button type="button" onClick={() => onOpen(next)} className="font-medium text-fg underline underline-offset-4">
                {next.title}
              </button>
              , {dayWords(next.starts_on)}.
            </>
          )}
        </p>
      ) : (
        <div className="space-y-4">
          <EventCard key={events[0].id} event={events[0]} today={today} variant="hero" lead onOpen={() => onOpen(events[0])} />
          {events.length > 1 && (
            <Rows>
              {events.slice(1).map((e) => (
                <li key={e.id}>
                  <EventCard event={e} today={today} variant="row" onOpen={() => onOpen(e)} />
                </li>
              ))}
            </Rows>
          )}
        </div>
      )}
    </Section>
  )
}

/** The archive: asked for only when it is opened. */
function PastEvents({ filters, today, onOpen }: { filters: EventFilters; today: string; onOpen: (e: HubEvent) => void }) {
  const past = useEventList("past", filters, 60)
  if (past.isError) return <InlineError message="Could not load the past events." onRetry={() => void past.refetch()} />
  if (!past.data) {
    return (
      <Delayed>
        <Skeleton className="h-24" />
      </Delayed>
    )
  }
  if (past.data.results.length === 0) return <p className="text-sm text-fg-muted">Nothing has happened yet that matches.</p>
  return (
    <Rows>
      {past.data.results.map((e) => (
        <li key={e.id}>
          <EventCard event={e} today={today} variant="row" onOpen={() => onOpen(e)} />
        </li>
      ))}
    </Rows>
  )
}
