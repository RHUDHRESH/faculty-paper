import { Plus } from "lucide-react"

import { Button } from "@/ui/button"
import { cn } from "@/lib/cn"
import { Avatar, initialsOf } from "@/ui/person"
import {
  type CalItem,
  WEEKDAYS,
  clock,
  dayLabel,
  iso,
  kindStyle,
  lanes,
  monthWeeks,
  overlaps,
  parse,
  relative,
  shortDay,
  timeLabel,
  weekDays,
} from "./model"

type Open = (item: CalItem) => void
type Add = (date: string, time?: string) => void

/** A chip: colour is the dot / left rule, the words stay fg. */
export function EventChip({
  item,
  onOpen,
  className,
  continues,
}: {
  item: CalItem
  onOpen: Open
  className?: string
  /** Bar continues from the previous row / into the next. */
  continues?: { before: boolean; after: boolean }
}) {
  const { icon: Icon, colour } = kindStyle(item.kind)
  const span = item.start !== item.end
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation()
        onOpen(item)
      }}
      title={item.title}
      aria-label={`${item.title}, ${item.kindLabel}, ${dayLabel(item.start)}${span ? ` to ${dayLabel(item.end)}` : ""}`}
      style={{ borderLeftColor: colour, backgroundColor: `color-mix(in srgb, ${colour} ${span ? 18 : 10}%, var(--color-surface))` }}
      className={cn(
        "flex h-5 w-full min-w-0 items-center gap-1 rounded-sm border-l-[3px] px-1.5 text-left text-xs text-fg",
        "hover:brightness-95",
        "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--area-time)]",
        continues?.before && "rounded-l-none",
        continues?.after && "rounded-r-none",
        className
      )}
    >
      <Icon className="size-3 shrink-0" style={{ color: colour }} aria-hidden strokeWidth={1.75} />
      {item.startTime && <span className="shrink-0 tabular text-fg-muted">{clock(item.startTime, true)}</span>}
      <span className="truncate">{item.title}</span>
    </button>
  )
}

const MAX_LANES = 3

/* ------------------------------------------------------------------------ */
/* Month                                                                     */
/* ------------------------------------------------------------------------ */

export function MonthView({
  anchor,
  today,
  items,
  onOpen,
  onAdd,
  onMore,
}: {
  anchor: Date
  today: string
  items: CalItem[]
  onOpen: Open
  onAdd: Add
  onMore: (date: string) => void
}) {
  const weeks = monthWeeks(anchor)
  const month = anchor.getMonth()
  return (
    <div role="grid" aria-label="Month" className="overflow-hidden rounded-panel bg-surface ring-1 ring-line">
      <div role="row" className="grid grid-cols-7 border-b border-line bg-sunken">
        {WEEKDAYS.map((d) => (
          <div role="columnheader" key={d} className="px-2 py-1.5 text-xs font-medium text-fg-muted">
            {d}
          </div>
        ))}
      </div>
      {weeks.map((week) => {
        const from = iso(week[0])
        const to = iso(week[6])
        const placed = lanes(items, from, to)
        const hidden = (day: string) =>
          placed.filter((p) => p.lane >= MAX_LANES && overlaps(p.item, day, day)).length
        return (
          <div
            role="row"
            key={from}
            className="relative grid min-h-28 grid-cols-7 grid-rows-[1.75rem_repeat(3,1.375rem)_1.25rem] border-b border-line last:border-b-0"
          >
            {week.map((d, col) => {
              const day = iso(d)
              const isToday = day === today
              const outside = d.getMonth() !== month
              return (
                <div
                  role="gridcell"
                  key={day}
                  onClick={() => onAdd(day)}
                  style={{ gridColumn: col + 1, gridRow: "1 / -1" }}
                  className={cn(
                    "group relative cursor-pointer border-r border-line px-1.5 pt-1 last:border-r-0 hover:bg-hover/60",
                    outside && "bg-sunken/60",
                    isToday && "bg-[var(--area-time-wash)]/50 shadow-[inset_0_2px_0_var(--area-time)]"
                  )}
                >
                  {/* A hint that a day is somewhere to add to; the button below is the real control. */}
                  <Plus
                    aria-hidden
                    className="pointer-events-none absolute right-1.5 top-1.5 size-3.5 text-fg-subtle opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
                  />
                  <button
                    type="button"
                    aria-label={`Add an event on ${dayLabel(day, true)}`}
                    aria-current={isToday ? "date" : undefined}
                    onClick={(e) => {
                      e.stopPropagation()
                      onAdd(day)
                    }}
                    className={cn(
                      "grid size-6 place-items-center rounded-full text-xs tabular",
                      outside ? "text-fg-subtle" : "text-fg",
                      isToday && "bg-[var(--area-time)] font-semibold text-white dark:text-bg"
                    )}
                  >
                    {d.getDate()}
                  </button>
                </div>
              )
            })}
            {placed
              .filter((p) => p.lane < MAX_LANES)
              .map(({ item, lane }) => {
                const s = item.start < from ? from : item.start
                const e = item.end > to ? to : item.end
                const col = (parse(s).getDay() + 6) % 7
                const span = Math.round((parse(e).getTime() - parse(s).getTime()) / 86_400_000) + 1
                return (
                  <div
                    key={item.key + from}
                    style={{ gridColumn: `${col + 1} / span ${span}`, gridRow: lane + 2 }}
                    className="z-10 px-0.5 py-px"
                  >
                    <EventChip
                      item={item}
                      onOpen={onOpen}
                      continues={{ before: item.start < from, after: item.end > to }}
                    />
                  </div>
                )
              })}
            {week.map((d, col) => {
              const n = hidden(iso(d))
              return n > 0 ? (
                <button
                  key={`more-${iso(d)}`}
                  type="button"
                  style={{ gridColumn: col + 1, gridRow: 5 }}
                  onClick={() => onMore(iso(d))}
                  className="z-10 px-1.5 text-left text-xs font-medium text-[var(--area-time)] hover:underline"
                >
                  +{n} more
                </button>
              ) : null
            })}
          </div>
        )
      })}
    </div>
  )
}

/* ------------------------------------------------------------------------ */
/* Month, compact (phone): dots per day, the day's events below              */
/* ------------------------------------------------------------------------ */

export function CompactMonth({
  anchor,
  today,
  items,
  selected,
  onSelect,
  onOpen,
  onAdd,
}: {
  anchor: Date
  today: string
  items: CalItem[]
  selected: string
  onSelect: (day: string) => void
  onOpen: Open
  onAdd: Add
}) {
  const weeks = monthWeeks(anchor)
  const month = anchor.getMonth()
  const dayItems = items.filter((i) => overlaps(i, selected, selected))
  return (
    <div className="space-y-3">
      <div role="grid" aria-label="Month" className="rounded-panel bg-surface p-2 ring-1 ring-line">
        <div role="row" className="grid grid-cols-7">
          {WEEKDAYS.map((d) => (
            <div role="columnheader" key={d} className="py-1 text-center text-[11px] font-medium text-fg-muted">
              {d[0]}
            </div>
          ))}
        </div>
        {weeks.map((week) => (
          <div role="row" key={iso(week[0])} className="grid grid-cols-7">
            {week.map((d) => {
              const day = iso(d)
              const on = items.filter((i) => overlaps(i, day, day))
              return (
                <div role="gridcell" key={day} className="grid place-items-center py-0.5">
                  <button
                    type="button"
                    onClick={() => onSelect(day)}
                    aria-pressed={day === selected}
                    aria-current={day === today ? "date" : undefined}
                    aria-label={`${dayLabel(day, true)}, ${on.length} ${on.length === 1 ? "event" : "events"}`}
                    className={cn(
                      "flex h-10 w-10 flex-col items-center justify-center rounded-full text-sm tabular",
                      d.getMonth() !== month && "text-fg-subtle",
                      day === today && "font-semibold text-[var(--area-time)]",
                      day === selected && "bg-[var(--area-time)] text-white dark:text-bg"
                    )}
                  >
                    {d.getDate()}
                    <span className="flex h-1.5 gap-0.5" aria-hidden>
                      {on.slice(0, 3).map((i) => (
                        <span
                          key={i.key}
                          className="size-1 rounded-full"
                          style={{ background: day === selected ? "currentColor" : kindStyle(i.kind).colour }}
                        />
                      ))}
                    </span>
                  </button>
                </div>
              )
            })}
          </div>
        ))}
      </div>
      <DayList day={selected} items={dayItems} onOpen={onOpen} onAdd={onAdd} />
    </div>
  )
}

function DayList({ day, items, onOpen, onAdd }: { day: string; items: CalItem[]; onOpen: Open; onAdd: Add }) {
  return (
    <section aria-label={dayLabel(day, true)}>
      <h3 className="mb-1 text-sm font-semibold">{dayLabel(day, true)}</h3>
      {items.length === 0 ? (
        <Button kind="default" size="sm" onClick={() => onAdd(day)}>
          <Plus />
          Add a reminder
        </Button>
      ) : (
        <ul className="divide-y divide-line rounded-panel bg-surface ring-1 ring-line">
          {items.map((i) => (
            <AgendaRow key={i.key} item={i} onOpen={onOpen} />
          ))}
        </ul>
      )}
    </section>
  )
}

/* ------------------------------------------------------------------------ */
/* Week                                                                      */
/* ------------------------------------------------------------------------ */

const FIRST_HOUR = 8
const LAST_HOUR = 20
const HOUR_PX = 48

function minutes(t: string): number {
  const [h, m] = t.split(":").map(Number)
  return h * 60 + m
}

export function WeekView({
  anchor,
  today,
  items,
  onOpen,
  onAdd,
}: {
  anchor: Date
  today: string
  items: CalItem[]
  onOpen: Open
  onAdd: Add
}) {
  const days = weekDays(anchor)
  const from = iso(days[0])
  const to = iso(days[6])
  const allDay = items.filter((i) => !i.startTime)
  const timed = items.filter((i) => i.startTime)
  const placed = lanes(allDay, from, to)
  const laneCount = Math.max(1, ...placed.map((p) => p.lane + 1))
  const hours = Array.from({ length: LAST_HOUR - FIRST_HOUR }, (_, i) => FIRST_HOUR + i)

  return (
    <div role="grid" aria-label="Week" className="overflow-hidden rounded-panel bg-surface ring-1 ring-line">
      <div role="row" className="grid grid-cols-[3.5rem_repeat(7,minmax(0,1fr))] border-b border-line bg-sunken">
        <div />
        {days.map((d) => {
          const day = iso(d)
          return (
            <div role="columnheader" key={day} aria-current={day === today ? "date" : undefined} className="px-2 py-1.5 text-xs text-fg-muted">
              {WEEKDAYS[(d.getDay() + 6) % 7]}{" "}
              <span
                className={cn(
                  "ml-0.5 inline-grid size-6 place-items-center rounded-full text-sm tabular text-fg",
                  day === today && "bg-[var(--area-time)] font-semibold text-white dark:text-bg"
                )}
              >
                {d.getDate()}
              </span>
            </div>
          )
        })}
      </div>

      {/* All-day row: windows, deadlines, the record. */}
      <div
        role="row"
        className="grid grid-cols-[3.5rem_repeat(7,minmax(0,1fr))] border-b border-line"
        style={{ gridTemplateRows: `repeat(${laneCount}, 1.375rem)` }}
      >
        <div style={{ gridRow: `1 / span ${laneCount}` }} className="px-1 pt-1 text-[11px] text-fg-subtle">
          All day
        </div>
        {days.map((d, col) => (
          <button
            key={iso(d)}
            type="button"
            aria-label={`Add an all-day event on ${dayLabel(iso(d), true)}`}
            onClick={() => onAdd(iso(d))}
            style={{ gridColumn: col + 2, gridRow: `1 / span ${laneCount}` }}
            className="border-l border-line hover:bg-hover/60"
          />
        ))}
        {placed.map(({ item, lane }) => {
          const s = item.start < from ? from : item.start
          const e = item.end > to ? to : item.end
          const col = (parse(s).getDay() + 6) % 7
          const span = Math.round((parse(e).getTime() - parse(s).getTime()) / 86_400_000) + 1
          return (
            <div key={item.key} style={{ gridColumn: `${col + 2} / span ${span}`, gridRow: lane + 1 }} className="z-10 px-0.5 py-px">
              <EventChip item={item} onOpen={onOpen} continues={{ before: item.start < from, after: item.end > to }} />
            </div>
          )
        })}
      </div>

      {/* The hours. */}
      <div className="grid grid-cols-[3.5rem_repeat(7,minmax(0,1fr))]">
        <div>
          {hours.map((h) => (
            <div key={h} style={{ height: HOUR_PX }} className="-mt-px pr-1 text-right text-[11px] tabular text-fg-subtle">
              {clock(`${h}:00`, true)}
            </div>
          ))}
        </div>
        {days.map((d) => {
          const day = iso(d)
          const mine = timed.filter((i) => i.start === day)
          return (
            <div key={day} role="gridcell" className={cn("relative border-l border-line", day === today && "bg-[var(--area-time-wash)]/40")}>
              {hours.map((h) => (
                <button
                  key={h}
                  type="button"
                  aria-label={`Add an event on ${dayLabel(day, true)} at ${h}:00`}
                  onClick={() => onAdd(day, `${String(h).padStart(2, "0")}:00`)}
                  style={{ height: HOUR_PX }}
                  className="block w-full border-b border-line/70 hover:bg-hover/60"
                />
              ))}
              {mine.map((item) => {
                const start = Math.max(minutes(item.startTime!), FIRST_HOUR * 60)
                const end = Math.min(
                  item.endTime ? Math.max(minutes(item.endTime), start + 30) : start + 60,
                  LAST_HOUR * 60
                )
                return (
                  <div
                    key={item.key}
                    className="absolute inset-x-0.5 z-10"
                    style={{
                      top: ((start - FIRST_HOUR * 60) / 60) * HOUR_PX,
                      height: Math.max(((end - start) / 60) * HOUR_PX - 2, 20),
                    }}
                  >
                    <EventChip item={item} onOpen={onOpen} className="h-full items-start bg-surface pt-0.5 shadow-sm" />
                  </div>
                )
              })}
            </div>
          )
        })}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------------ */
/* Agenda                                                                    */
/* ------------------------------------------------------------------------ */

export function AgendaRow({ item, onOpen }: { item: CalItem; onOpen: Open }) {
  const { icon: Icon, colour } = kindStyle(item.kind)
  return (
    <li>
      <button
        type="button"
        onClick={() => onOpen(item)}
        className="flex min-h-11 w-full items-start gap-3 border-l-[3px] px-3 py-2 text-left hover:bg-hover"
        style={{ borderLeftColor: colour }}
      >
        {item.record?.person ? (
          <Avatar
            size="xs"
            person={{
              name: item.record.person.name,
              initials: item.record.person.initials ?? initialsOf(item.record.person.name),
              photo_url: item.record.person.photo_url ?? null,
            }}
          />
        ) : (
          <Icon className="mt-0.5 size-4 shrink-0" style={{ color: colour }} aria-hidden strokeWidth={1.75} />
        )}
        <span className="min-w-0 flex-1">
          <span className="block text-base leading-5">{item.title}</span>
          <span className="block text-xs text-fg-muted">
            {timeLabel(item)} · {item.kindLabel}
            {item.event?.venue ? ` · ${item.event.venue}` : ""}
          </span>
        </span>
      </button>
    </li>
  )
}

/**
 * What the colours and shapes on the grid mean, for the kinds that are on it.
 * A tint says nothing to somebody who cannot tell it apart, and nothing at all
 * to somebody who has never been told: the shape and the word beside it do.
 */
export function KindLegend({ items }: { items: CalItem[] }) {
  const seen = new Map<string, CalItem>()
  for (const i of items) if (!seen.has(i.kindLabel)) seen.set(i.kindLabel, i)
  if (seen.size === 0) return null
  return (
    <ul aria-label="What the symbols mean" className="flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-fg-muted">
      {[...seen.entries()].map(([label, i]) => {
        const { icon: Icon, colour } = kindStyle(i.kind)
        return (
          <li key={label} className="inline-flex items-center gap-1.5">
            <Icon className="size-3.5" style={{ color: colour }} aria-hidden strokeWidth={1.75} />
            {label}
          </li>
        )
      })}
    </ul>
  )
}

export function AgendaView({
  items,
  from,
  to,
  today,
  onOpen,
}: {
  items: CalItem[]
  from: string
  to: string
  today: string
  onOpen: Open
}) {
  const days = new Map<string, CalItem[]>()
  for (const i of items) {
    if (!overlaps(i, from, to)) continue
    const day = i.start < from ? from : i.start
    days.set(day, [...(days.get(day) ?? []), i])
  }
  const sorted = [...days.entries()].sort(([a], [b]) => a.localeCompare(b))
  return (
    <div className="space-y-5">
      {sorted.map(([day, list]) => (
        <section key={day} aria-label={dayLabel(day, true)} className="sm:grid sm:grid-cols-[8.5rem_minmax(0,1fr)] sm:gap-x-4">
          <h3 className="mb-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm sm:mb-0 sm:block sm:pt-2.5">
            <span className={cn("font-semibold", day === today && "text-[var(--area-time)]")}>{shortDay(day)}</span>
            {day === today ? (
              <span className="rounded-full bg-[var(--area-time-wash)] px-2 py-0.5 text-xs font-medium text-[var(--area-time)] sm:mt-1 sm:block sm:w-fit">
                Today
              </span>
            ) : (
              <span className="text-xs font-normal text-fg-muted sm:mt-0.5 sm:block">{relative(day, today)}</span>
            )}
          </h3>
          <ul className="divide-y divide-line overflow-hidden rounded-panel bg-surface ring-1 ring-line">
            {list.map((i) => (
              <AgendaRow key={i.key} item={i} onOpen={onOpen} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}
