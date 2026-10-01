import { useEffect, useMemo, useState } from "react"
import { useSearchParams } from "react-router-dom"
import { CalendarDays, ChevronLeft, ChevronRight, Plus } from "lucide-react"

import { cn } from "@/lib/cn"
import { useApi } from "@/lib/query"
import { Button } from "@/ui/button"
import { PageHeader } from "@/ui/page-header"
import { SectionTitle } from "@/ui/text"
import { Avatar, initialsOf } from "@/ui/person"
import { EmptyState, ErrorState, SkeletonRows } from "@/ui/state"

import { DayDialog, EventDetails, EventDialog, GoogleMenu, type Prefill } from "./calendar/dialogs"
import {
  type CalItem,
  type CalendarPayload,
  type EventRow,
  type Layer,
  ALL_LAYERS,
  addDays,
  addMonths,
  agendaWindow,
  dayLabel,
  iso,
  kindStyle,
  monthLabel,
  monthWeeks,
  overlaps,
  parse,
  relative,
  toItems,
  weekDays,
} from "./calendar/model"
import { AgendaView, CompactMonth, MonthView, WeekView } from "./calendar/views"

/**
 * The calendar: month, week and agenda, with college dates, the record's
 * dates and my own reminders layered and switchable. docs/ux/12-calendar.md.
 */

type View = "month" | "week" | "agenda"

const LAYERS: { key: Layer | "all"; label: string }[] = [
  { key: "all", label: "All" },
  { key: "college", label: "College dates" },
  { key: "papers", label: "My papers" },
  { key: "colleagues", label: "Colleagues" },
  { key: "mine", label: "My reminders" },
]

function usePhone(): boolean {
  const query = "(max-width: 47.99rem)"
  const [phone, setPhone] = useState(() => window.matchMedia(query).matches)
  useEffect(() => {
    const m = window.matchMedia(query)
    const on = () => setPhone(m.matches)
    m.addEventListener?.("change", on)
    return () => m.removeEventListener?.("change", on)
  }, [])
  return phone
}

export function Calendar() {
  const phone = usePhone()
  const [params, setParams] = useSearchParams()
  const today = iso(new Date())
  const view: View = (["month", "week", "agenda"] as const).find((v) => v === params.get("view")) ?? (phone ? "agenda" : "month")
  const anchor = parse(params.get("date") ?? today)
  const [layers, setLayers] = useState<Set<Layer>>(new Set(ALL_LAYERS))
  const [adding, setAdding] = useState<Prefill | null>(null)
  const [editing, setEditing] = useState<EventRow | null>(null)
  const [open, setOpen] = useState<CalItem | null>(null)
  const [moreDay, setMoreDay] = useState<string | null>(null)
  const [selected, setSelected] = useState(params.get("date") ?? today)

  function go(next: Partial<{ view: View; date: string }>) {
    setParams(
      (prev) => {
        const p = new URLSearchParams(prev)
        if (next.view) p.set("view", next.view)
        if (next.date) p.set("date", next.date)
        return p
      },
      { replace: true }
    )
  }

  function step(n: number) {
    const d = view === "week" ? addDays(anchor, 7 * n) : addMonths(anchor, n)
    go({ date: iso(d) })
    setSelected(iso(d))
  }

  // ← / → move by period, T jumps to today. Not while typing, not with a dialog open.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const t = e.target instanceof Element ? e.target : null
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (t && (t.closest("input,textarea,select,[contenteditable=true],[role=dialog],[role=menu]"))) return
      if (e.key === "ArrowLeft") step(-1)
      else if (e.key === "ArrowRight") step(1)
      else if (e.key === "t" || e.key === "T") {
        go({ date: today })
        setSelected(today)
      } else return
      e.preventDefault()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  })

  // The window the grid shows; the hero's "Next" looks 30 days past today too.
  const [from, to] = useMemo(() => {
    if (view === "week") {
      const days = weekDays(anchor)
      return [iso(days[0]), iso(days[6])]
    }
    const weeks = monthWeeks(anchor)
    return [iso(weeks[0][0]), iso(weeks[weeks.length - 1][6])]
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, iso(anchor)])
  const fetchFrom = from < today ? from : today
  const horizon = iso(addDays(parse(today), 30))
  const fetchTo = to > horizon ? to : horizon

  const { data, isLoading, isError, refetch } = useApi<CalendarPayload>(
    ["calendar", fetchFrom, fetchTo],
    `/api/calendar?start=${fetchFrom}&end=${fetchTo}`
  )
  const all = useMemo(() => toItems(data), [data])
  const items = all.filter((i) => layers.has(i.layer))
  const [agendaFrom, agendaTo] = agendaWindow(from, to, today, horizon, sameMonth(anchor, today))
  const next = all.find((i) => i.end >= today && i.start <= horizon && i.layer !== "papers")
    ?? all.find((i) => i.start >= today && i.start <= horizon)

  function toggle(key: Layer | "all") {
    if (key === "all") return setLayers(new Set(ALL_LAYERS))
    setLayers((prev) => {
      const everything = prev.size === ALL_LAYERS.length
      const n = new Set(everything ? [] : prev)
      if (n.has(key)) n.delete(key)
      else n.add(key)
      return n.size === 0 ? new Set(ALL_LAYERS) : n
    })
  }

  const title = view === "week" ? weekTitle(anchor) : monthLabel(anchor)
  const add = (date: string, time?: string) => setAdding({ date, time })

  return (
    <div className="page space-y-4">
      <PageHeader
        title="Calendar"
        spot="spot-calendar"
        sub={
          isLoading ? undefined : next ? (
            <span className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
              <span className="font-medium text-fg">Next:</span>
              <NextIcon kind={next.kind} />
              <button type="button" className="min-w-0 truncate font-medium text-fg hover:underline" onClick={() => setOpen(next)}>
                {next.title}
              </button>
              <span>
                {next.start <= today && next.end > today
                  ? `closes ${dayLabel(next.end, true)} (${relative(next.end, today)})`
                  : `${dayLabel(next.start, true)} (${relative(next.start, today)})`}
              </span>
            </span>
          ) : (
            "Nothing on the calendar in the next 30 days."
          )
        }
        action={
          <Button kind="primary" size="md" className="max-md:hidden" onClick={() => add(view === "month" ? selectedIn(anchor, today) : today)}>
            <Plus />
            Add event
          </Button>
        }
      />

      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <div className="flex items-center gap-1">
          <Button kind="quiet" size="icon" aria-label={view === "week" ? "Previous week" : "Previous month"} onClick={() => step(-1)}>
            <ChevronLeft />
          </Button>
          <h2 className="min-w-40 text-center text-base font-semibold tabular" aria-live="polite">
            {title}
          </h2>
          <Button kind="quiet" size="icon" aria-label={view === "week" ? "Next week" : "Next month"} onClick={() => step(1)}>
            <ChevronRight />
          </Button>
        </div>
        <Button
          kind="default"
          size="sm"
          onClick={() => {
            go({ date: today })
            setSelected(today)
          }}
        >
          Today
        </Button>
        <div role="tablist" aria-label="View" className="inline-flex rounded-control bg-surface p-0.5 ring-1 ring-line">
          {(["month", "week", "agenda"] as const).map((v) => (
            <button
              key={v}
              role="tab"
              aria-selected={view === v}
              onClick={() => go({ view: v })}
              className={cn(
                "h-8 rounded-control px-3 text-sm capitalize",
                view === v ? "bg-[var(--area-time-wash)] font-medium text-[var(--area-time)]" : "text-fg-muted hover:text-fg"
              )}
            >
              {v}
            </button>
          ))}
        </div>
        <div className="ml-auto">
          <GoogleMenu />
        </div>
      </div>

      {/* Layers. */}
      <div role="group" aria-label="Show" className="flex flex-wrap gap-2">
        {LAYERS.map((l) => {
          const on = l.key === "all" ? layers.size === ALL_LAYERS.length : layers.has(l.key) && layers.size < ALL_LAYERS.length
          return (
            <button
              key={l.key}
              type="button"
              aria-pressed={on}
              onClick={() => toggle(l.key)}
              className={cn(
                "h-7 rounded-full px-3 text-xs font-medium ring-1",
                on
                  ? "bg-[var(--area-time-wash)] text-[var(--area-time)] ring-[var(--area-time)]"
                  : "bg-surface text-fg-muted ring-line hover:text-fg"
              )}
            >
              {l.label}
            </button>
          )
        })}
      </div>

      {isLoading ? (
        <SkeletonRows rows={6} rowHeight={96} />
      ) : isError ? (
        <ErrorState
          title="Could not load the calendar"
          message="Could not load the calendar. Nothing on it has been changed."
          onRetry={() => refetch()}
        />
      ) : view === "agenda" ? (
        !items.some((i) => overlaps(i, agendaFrom, agendaTo)) ? (
          <QuietMonth onAdd={() => add(today)} />
        ) : (
          <AgendaView items={items} from={agendaFrom} to={agendaTo} today={today} onOpen={setOpen} />
        )
      ) : view === "week" ? (
        <WeekView anchor={anchor} today={today} items={items} onOpen={setOpen} onAdd={add} />
      ) : phone ? (
        <CompactMonth
          anchor={anchor}
          today={today}
          items={items}
          selected={selected}
          onSelect={setSelected}
          onOpen={setOpen}
          onAdd={add}
        />
      ) : (
        <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_17rem]">
          <div className="min-w-0 space-y-4">
            <MonthView anchor={anchor} today={today} items={items} onOpen={setOpen} onAdd={add} onMore={setMoreDay} />
            {!items.some((i) => overlaps(i, iso(anchor).slice(0, 8) + "01", iso(new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0)))) && <QuietMonth onAdd={() => add(selectedIn(anchor, today))} />}
          </div>
          <UpNext items={items} today={today} horizon={horizon} onOpen={setOpen} />
        </div>
      )}

      {/* Phone: the floating add button. */}
      <Button
        kind="primary"
        size="icon"
        aria-label="Add event"
        className="fixed bottom-5 right-5 z-30 size-14 rounded-full shadow-lg md:hidden"
        onClick={() => add(phone && view === "month" ? selected : today)}
      >
        <Plus className="size-6" />
      </Button>

      {(adding || editing) && (
        <EventDialog
          existing={editing}
          prefill={adding ?? { date: today }}
          visibilities={data?.visibilities ?? ["PRIVATE"]}
          onClose={() => {
            setAdding(null)
            setEditing(null)
          }}
        />
      )}
      {open && !editing && (
        <EventDetails
          item={open}
          onClose={() => setOpen(null)}
          onEdit={(e) => {
            setOpen(null)
            setEditing(e)
          }}
        />
      )}
      {moreDay && !open && (
        <DayDialog
          day={moreDay}
          items={items.filter((i) => overlaps(i, moreDay, moreDay))}
          onOpen={(i) => {
            setMoreDay(null)
            setOpen(i)
          }}
          onClose={() => setMoreDay(null)}
        />
      )}
    </div>
  )
}

function NextIcon({ kind }: { kind: string }) {
  const { icon: Icon, colour } = kindStyle(kind)
  return <Icon className="size-4 shrink-0" style={{ color: colour }} aria-hidden />
}

/** The next few things from today, beside the month on wide screens. */
function UpNext({ items, today, horizon, onOpen }: { items: CalItem[]; today: string; horizon: string; onOpen: (i: CalItem) => void }) {
  const ahead = items.filter((i) => i.end >= today && i.start <= horizon).slice(0, 8)
  const days: [string, CalItem[]][] = []
  for (const i of ahead) {
    const day = i.start < today ? today : i.start
    const last = days.at(-1)
    if (last && last[0] === day) last[1].push(i)
    else days.push([day, [i]])
  }
  return (
    <aside aria-labelledby="up-next" className="hidden xl:block">
      <SectionTitle id="up-next">Up next</SectionTitle>
      <p className="text-sm text-fg-muted">The next 30 days</p>
      {days.length === 0 ? (
        <p className="mt-4 text-sm text-fg-muted">Nothing ahead yet. Dates you add, and dates from the record, show here.</p>
      ) : (
        <ol className="mt-3 space-y-4">
          {days.map(([day, list]) => (
            <li key={day}>
              <p className={cn("text-xs font-medium", day === today ? "text-[var(--area-time)]" : "text-fg-muted")}>
                {day === today ? "Today" : relative(day, today).replace(/^in /, "In ")} · {dayLabel(day, true)}
              </p>
              <ul className="mt-1 divide-y divide-line/60 border-y border-line/60">
                {list.map((i) => {
                  const { icon: Icon, colour } = kindStyle(i.kind)
                  const p = i.record?.person
                  return (
                    <li key={i.key}>
                      <button type="button" onClick={() => onOpen(i)} className="flex w-full items-start gap-2 py-2 text-left hover:bg-hover/60">
                        {p ? (
                          <Avatar size="xs" person={{ name: p.name, initials: p.initials ?? initialsOf(p.name), photo_url: p.photo_url ?? null }} />
                        ) : (
                          <span className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full" style={{ backgroundColor: `color-mix(in srgb, ${colour} 14%, transparent)` }}>
                            <Icon className="size-3" style={{ color: colour }} aria-hidden />
                          </span>
                        )}
                        <span className="min-w-0 flex-1">
                          <span className="line-clamp-2 text-sm">{i.title}</span>
                          <span className="block text-xs text-fg-muted">{i.kindLabel}{i.startTime ? ` · ${i.startTime}` : ""}</span>
                        </span>
                      </button>
                    </li>
                  )
                })}
              </ul>
            </li>
          ))}
        </ol>
      )}
    </aside>
  )
}

function QuietMonth({ onAdd }: { onAdd: () => void }) {
  return (
    <EmptyState
      icon={CalendarDays}
      illustration="empty-calendar"
      title="A quiet month"
      message="Nothing on the record for this month. Add a reminder, or step to another month."
      action={
        <Button kind="primary" size="sm" onClick={onAdd}>
          <Plus />
          Add a reminder
        </Button>
      }
    />
  )
}

function sameMonth(a: Date, b: string): boolean {
  return iso(a).slice(0, 7) === b.slice(0, 7)
}

/** Add from the month header: today if it is this month, else the 1st. */
function selectedIn(anchor: Date, today: string): string {
  return sameMonth(anchor, today) ? today : iso(new Date(anchor.getFullYear(), anchor.getMonth(), 1))
}

function weekTitle(anchor: Date): string {
  const days = weekDays(anchor)
  const a = days[0]
  const b = days[6]
  const left = a.toLocaleDateString("en-IN", { day: "numeric", month: "short" })
  const right = b.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })
  return `${left} – ${right}`
}
