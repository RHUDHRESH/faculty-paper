import { useState } from "react"
import { useQueryClient, type QueryClient } from "@tanstack/react-query"
import { CalendarPlus, Clock, ExternalLink, Landmark, MapPin, Mic } from "lucide-react"

import { api } from "@/lib/api"
import { cn } from "@/lib/cn"
import { formatCount } from "@/lib/count"
import { InvitedBy, InviteSection } from "@/pages/events-invite"
import { Button } from "@/ui/button"
import { Chip } from "@/ui/chip"
import {
  ConfirmDialog,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/ui/dialog"
import { Checkbox, DateInput, Field, Input, Radio, Select, Textarea } from "@/ui/field"
import { InlineError } from "@/ui/state"
import { Sheet, SheetBody, SheetContent, SheetFooter, SheetHeader, SheetTitle } from "@/ui/sheet"
import { toast } from "@/ui/toast"
import { FilterChip } from "@/ui/toggle"
import {
  audienceLine,
  countdown,
  dayRange,
  dayWords,
  isOver,
  kindArea,
  kindWord,
  nextWorkingDay,
  startsIn,
  tile,
  timeSpan,
  type EventsPayload,
  type EventsSummary,
  type HubEvent,
} from "@/pages/events-model"

/* ------------------------------------------------------------------------ */
/* Keeping the lists honest after a press                                    */
/* ------------------------------------------------------------------------ */

/**
 * Change one event wherever the page has it cached: the week, the month list,
 * the archive, and the Home card. A press on "I'm going" answers with the new
 * count, so the number moves at once everywhere without asking for the lists
 * again.
 */
export function patchEvent(qc: QueryClient, id: string, patch: Partial<HubEvent>) {
  const swap = (e: HubEvent) => (e.id === id ? { ...e, ...patch } : e)
  qc.setQueriesData<EventsPayload>({ queryKey: ["events", "list"] }, (old) => old && { ...old, results: old.results.map(swap) })
  qc.setQueriesData<EventsSummary>(
    { queryKey: ["events", "summary"] },
    (old) => old && { ...old, this_week: old.this_week.map(swap), upcoming: old.upcoming.map(swap), next: old.next && swap(old.next) }
  )
}

/** Everything that shows events is stale after one is posted, changed or removed, the calendar included. */
function refreshEvents(qc: QueryClient) {
  void qc.invalidateQueries({ queryKey: ["events"] })
  void qc.invalidateQueries({ queryKey: ["calendar"] })
}

function useGoing(event: HubEvent) {
  const qc = useQueryClient()
  const [pending, setPending] = useState(false)
  async function toggle() {
    setPending(true)
    try {
      const said = await api<{ going: boolean; going_count: number }>(`/api/events/${event.id}/going`, {
        method: event.going ? "DELETE" : "POST",
      })
      patchEvent(qc, event.id, { going: said.going, going_count: said.going_count })
    } catch (err) {
      toast.fail(err)
    } finally {
      setPending(false)
    }
  }
  return { toggle, pending }
}

/* ------------------------------------------------------------------------ */
/* Small pieces                                                              */
/* ------------------------------------------------------------------------ */

/**
 * The day, on the left of everything: a teacher scans down a list of dates
 * before they read a title. Coloured by kind so a seminar and a call for papers
 * differ before a word is read, and never by colour alone: the kind is also
 * written beside it.
 *
 * `lg` is the hero's: the day number is the answer to "when", so it is set as a
 * figure. `md` is a list row's and a phone's, in the ordinary face.
 */
export function DateTile({ event, size = "md", muted }: { event: Pick<HubEvent, "starts_on" | "ends_on" | "kind">; size?: "sm" | "md" | "lg"; muted?: boolean }) {
  const t = tile(event)
  const area = kindArea(event.kind)
  return (
    <div
      data-area={area}
      className={cn(
        // `self-start`: in a row of text the tile is as tall as its own three lines, not as the card.
        "flex shrink-0 flex-col items-center justify-center self-start rounded-control text-center leading-none",
        area ? "bg-(--area-wash) text-(--area)" : "bg-hover text-fg-muted",
        size === "lg" ? "w-[4.5rem] py-3 max-sm:w-16" : size === "md" ? "w-14 py-2 max-sm:w-12" : "w-12 py-1.5",
        muted && "opacity-70"
      )}
    >
      <span className="text-xs font-medium">{t.weekday}</span>
      <span className={cn("tabular", size === "lg" ? "figure my-1 text-figure max-sm:text-lg" : "my-0.5 text-lg font-semibold")}>{t.day}</span>
      <span className="text-xs font-medium">{t.month}</span>
    </div>
  )
}

export function KindChip({ kind }: { kind: string }) {
  const area = kindArea(kind)
  return (
    <Chip tone={area ? "area" : "neutral"} area={area}>
      {kindWord(kind)}
    </Chip>
  )
}

const COUNTDOWN_TONE = { neutral: "neutral", caution: "caution", critical: "critical", quiet: "neutral" } as const

export function CountdownChip({ event, today }: { event: HubEvent; today: string }) {
  const c = countdown(event, today)
  return c ? <Chip tone={COUNTDOWN_TONE[c.tone]}>{c.text}</Chip> : null
}

export function GoingToggle({ event }: { event: HubEvent }) {
  const { toggle, pending } = useGoing(event)
  return (
    <FilterChip on={event.going} onClick={() => void toggle()} disabled={pending}>
      {"I'm going"}
    </FilterChip>
  )
}

export function GoingCount({ event, className }: { event: Pick<HubEvent, "going_count">; className?: string }) {
  if (event.going_count <= 0) return null
  return <span className={cn("tabular text-sm text-fg-muted", className)}>{formatCount(event.going_count)} going</span>
}

/**
 * Downloads the one event as a calendar file. Not Google: that is the calendar
 * page's. `compact` is the same link as an icon, for a card too narrow to spend
 * a line on the words; its name for a screen reader is the same.
 */
export function CalendarLink({ event, compact }: { event: Pick<HubEvent, "id">; compact?: boolean }) {
  const href = `/api/events/${event.id}.ics`
  if (compact) {
    return (
      <Button kind="quiet" size="icon-sm" asChild>
        <a href={href} download aria-label="Add to my calendar" title="Add to my calendar">
          <CalendarPlus aria-hidden />
        </a>
      </Button>
    )
  }
  return (
    <Button kind="quiet" size="sm" asChild>
      <a href={href} download>
        <CalendarPlus aria-hidden />
        Add to my calendar
      </a>
    </Button>
  )
}

/** What the tile does not say: when in the day, or "all day", or the last day for a call for papers. */
function timeLine(e: HubEvent): string | null {
  if (e.kind === "CALL_FOR_PAPERS") return `Closes ${dayRange(e)}`
  if (e.ends_on && e.ends_on !== e.starts_on) return dayRange(e)
  return e.starts_at ? timeSpan(e.starts_at, e.ends_at) : "All day"
}

function Fact({ icon: Icon, children }: { icon: typeof Clock; children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-1.5">
      <Icon aria-hidden className="mt-0.5 size-3.5 shrink-0 text-fg-subtle" />
      <span className="min-w-0">{children}</span>
    </li>
  )
}

/* ------------------------------------------------------------------------ */
/* One event, as a card in the week and as a row in the month                 */
/* ------------------------------------------------------------------------ */

/**
 * `hero` is a card in "This week": a big tile and the way to say you are
 * going. `row` is a line in the month list. `over` (an event in the archive)
 * keeps the title and the details and drops what is no longer possible: you
 * cannot be going to what has happened.
 *
 * The title opens the same sheet as "More details", so the whole card is
 * reachable by the most obvious thing on it.
 */
export function EventCard({
  event,
  today,
  variant,
  lead,
  onOpen,
}: {
  event: HubEvent
  today: string
  variant: "hero" | "row"
  lead?: boolean
  onOpen: () => void
}) {
  const over = isOver(event, today)
  const when = timeLine(event)
  const soon = !over && event.kind !== "CALL_FOR_PAPERS" ? startsIn(event, today) : null
  const hero = variant === "hero"

  const heading = (
    <>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <KindChip kind={event.kind} />
        <CountdownChip event={event} today={today} />
        {soon && (
          <span className={cn("text-sm", soon === "Today" || soon === "Tomorrow" ? "font-medium text-accent" : "text-fg-muted")}>{soon}</span>
        )}
      </div>
      <h3 className={cn("text-pretty font-semibold", hero ? "text-lg" : "text-base")}>
        <button type="button" onClick={onOpen} className="text-left underline-offset-4 hover:underline">
          {event.title}
        </button>
      </h3>
      <InvitedBy event={event} />
    </>
  )
  const facts = (
    <ul className="space-y-0.5 text-sm text-fg-muted">
      {when && <Fact icon={Clock}>{when}</Fact>}
      {event.venue && <Fact icon={MapPin}>{event.venue}</Fact>}
      {event.speaker ? <Fact icon={Mic}>{event.speaker}</Fact> : event.organiser ? <Fact icon={Landmark}>{event.organiser}</Fact> : null}
    </ul>
  )

  // A card in the week: the tile sits beside the kind and the title only, so
  // the place, the speaker and the buttons get the card's whole width. Beside
  // a tile they were squeezed to a column of three words and the buttons
  // stacked one to a line.
  if (hero) {
    return (
      <article aria-label={event.title} className={cn("min-w-0 space-y-3", lead ? "panel-lead" : "panel", "p-4 sm:p-5")}>
        <div className="flex gap-3 sm:gap-4">
          <DateTile event={event} size="lg" muted={over} />
          <div className="min-w-0 flex-1 space-y-2">{heading}</div>
        </div>
        {facts}
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 pt-0.5">
          {!over && <GoingToggle event={event} />}
          {!over && <GoingCount event={event} />}
          <span className="ml-auto flex items-center gap-1">
            {!over && <CalendarLink event={event} compact />}
            <Button kind="quiet" size="sm" onClick={onOpen}>
              More details
            </Button>
          </span>
        </div>
      </article>
    )
  }

  // A line in the month: on a wide screen the buttons are a column on the
  // right, like an agenda; on a phone they sit under the text.
  return (
    <article aria-label={event.title} className="flex min-w-0 gap-4 py-4 max-sm:gap-3">
      <DateTile event={event} size="md" muted={over} />
      <div className="min-w-0 flex-1 gap-8 sm:flex sm:items-start">
        <div className="min-w-0 flex-1 space-y-2">
          {heading}
          {facts}
        </div>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-2 pt-3 sm:w-48 sm:shrink-0 sm:flex-col sm:items-end sm:gap-y-1 sm:pt-0.5">
          {!over && (
            <span className="flex items-center gap-2">
              <GoingToggle event={event} />
              <GoingCount event={event} />
            </span>
          )}
          {!over && <CalendarLink event={event} />}
          <Button kind="quiet" size="sm" onClick={onOpen}>
            More details
          </Button>
        </div>
      </div>
    </article>
  )
}

/* ------------------------------------------------------------------------ */
/* More details                                                              */
/* ------------------------------------------------------------------------ */

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-fg-muted">{label}</dt>
      <dd className="min-w-0 text-fg">{children}</dd>
    </>
  )
}

/**
 * Everything about one event, kept open by `?event=` in the address so a link
 * in a notification lands on it and Back closes it. A sheet, as everywhere in
 * the app a detail is: the page under it stays where it was.
 */
export function EventSheet({
  event,
  today,
  onClose,
  onEdit,
}: {
  event: HubEvent
  today: string
  onClose: () => void
  onEdit: (e: HubEvent) => void
}) {
  const qc = useQueryClient()
  const [confirm, setConfirm] = useState(false)
  const over = isOver(event, today)
  const call = event.kind === "CALL_FOR_PAPERS"

  async function remove() {
    try {
      await api(`/api/events/${event.id}`, { method: "DELETE" })
      toast.ok(`Deleted: ${event.title}`)
      refreshEvents(qc)
      onClose()
    } catch (err) {
      toast.fail(err)
      throw err
    }
  }

  return (
    <>
      <Sheet open onOpenChange={(o) => !o && onClose()}>
        <SheetContent aria-describedby={undefined}>
          <SheetHeader>
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <KindChip kind={event.kind} />
              <CountdownChip event={event} today={today} />
            </div>
            <SheetTitle className="text-pretty">{event.title}</SheetTitle>
            <InvitedBy event={event} />
          </SheetHeader>
          <SheetBody className="space-y-5">
            <dl className="grid grid-cols-[6rem_minmax(0,1fr)] gap-x-3 gap-y-3 text-sm">
              <Row label={call ? "Closes" : "When"}>
                {call ? dayWords(event.starts_on, { year: true }) : dayRange(event)}
                {!call && !(event.ends_on && event.ends_on !== event.starts_on) && event.starts_at && `, ${timeSpan(event.starts_at, event.ends_at)}`}
              </Row>
              {event.venue && <Row label="Where">{event.venue}</Row>}
              {event.speaker && <Row label="Speaker">{event.speaker}</Row>}
              {event.organiser && <Row label="Organised by">{event.organiser}</Row>}
              <Row label="For">{audienceLine(event)}</Row>
              {event.created_by && <Row label="Posted by">{event.created_by}</Row>}
            </dl>
            {event.description && <p className="whitespace-pre-wrap text-base">{event.description}</p>}
            {event.link && (
              <Button kind="default" asChild>
                <a href={event.link} target="_blank" rel="noopener noreferrer">
                  Register or read more
                  <ExternalLink aria-hidden />
                </a>
              </Button>
            )}
            {!over && (
              <div className="flex flex-wrap items-center gap-3">
                <GoingToggle event={event} />
                <GoingCount event={event} />
              </div>
            )}
            {event.can_edit && <InviteSection event={event} />}
          </SheetBody>
          <SheetFooter className="flex-wrap justify-between">
            <div>{!over && <CalendarLink event={event} />}</div>
            {event.can_edit && (
              <div className="flex gap-2">
                <Button kind="danger" size="sm" onClick={() => setConfirm(true)}>
                  Delete
                </Button>
                <Button kind="default" size="sm" onClick={() => onEdit(event)}>
                  Edit
                </Button>
              </div>
            )}
          </SheetFooter>
        </SheetContent>
      </Sheet>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        danger
        title="Delete this event?"
        description="It goes from the Events page and from everybody's calendar here. Anybody who said they were going is not told."
        confirmLabel="Delete it"
        onConfirm={remove}
      />
    </>
  )
}

/* ------------------------------------------------------------------------ */
/* Posting and editing                                                       */
/* ------------------------------------------------------------------------ */

export type DialogMeta = Pick<EventsPayload, "today" | "kinds" | "departments" | "audiences" | "can_pick_department">

/**
 * Posting a seminar has to be one go: the form opens ready (tomorrow, three
 * o'clock, my department, a seminar), so a title is the only thing a person has
 * to type. Everything else is there to add, not to fill in.
 *
 * A call for papers is a deadline and a link, so it loses the time and the
 * place. Who may tell the whole college is the server's say, sent as
 * `audiences`; this only offers what it will accept.
 */
export function EventDialog({ existing, meta, onClose }: { existing: HubEvent | null; meta: DialogMeta; onClose: () => void }) {
  const qc = useQueryClient()
  const multiDay = Boolean(existing?.ends_on && existing.ends_on !== existing.starts_on)
  const [title, setTitle] = useState(existing?.title ?? "")
  const [kind, setKind] = useState<string>(existing?.kind ?? "SEMINAR")
  const [day, setDay] = useState(existing?.starts_on ?? nextWorkingDay(meta.today))
  const [multi, setMulti] = useState(multiDay)
  const [lastDay, setLastDay] = useState(existing?.ends_on ?? "")
  const [allDay, setAllDay] = useState(existing ? existing.all_day : false)
  const [from, setFrom] = useState(existing?.starts_at ?? "15:00")
  const [to, setTo] = useState(existing?.ends_at ?? "16:00")
  const [venue, setVenue] = useState(existing?.venue ?? "")
  const [speaker, setSpeaker] = useState(existing?.speaker ?? "")
  const [organiser, setOrganiser] = useState(existing?.organiser ?? "")
  const [link, setLink] = useState(existing?.link ?? "")
  const [details, setDetails] = useState(existing?.description ?? "")
  const [audience, setAudience] = useState<string>(existing?.visibility ?? meta.audiences[0]?.key ?? "DEPARTMENT")
  const [department, setDepartment] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const call = kind === "CALL_FOR_PAPERS"
  const timed = !call && !allDay
  const runs = multi && !call
  const needsDepartment = !existing && meta.can_pick_department && audience === "DEPARTMENT"
  const backwards = (runs && Boolean(lastDay) && lastDay < day) || (timed && !runs && to <= from)
  const ready = title.trim().length >= 3 && Boolean(day) && (!runs || Boolean(lastDay)) && !backwards && (!needsDepartment || Boolean(department))

  async function submit() {
    setBusy(true)
    setError(null)
    const text = (v: string) => v.trim() || undefined
    try {
      await api(existing ? `/api/events/${existing.id}` : "/api/events", {
        method: existing ? "PATCH" : "POST",
        json: {
          title: title.trim(),
          kind,
          starts_on: day,
          ends_on: runs ? lastDay : undefined,
          all_day: !timed,
          starts_at: timed ? from : undefined,
          ends_at: timed ? to : undefined,
          description: text(details),
          venue: call ? undefined : text(venue),
          speaker: call ? undefined : text(speaker),
          organiser: text(organiser),
          link: text(link),
          visibility: audience,
          department: needsDepartment ? department : undefined,
        },
      })
      toast.ok(existing ? `Saved: ${title.trim()}` : `Posted: ${title.trim()}, ${dayWords(day)}`)
      refreshEvents(qc)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save it. Please try again.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>{existing ? "Edit event" : "Add an event"}</DialogTitle>
          <DialogDescription>
            {existing ? "Changes show for everybody it was posted for. Nobody is told again." : "Everybody it is for is told once."}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          <Field label="Title">
            <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Seminar on power electronics" autoFocus />
          </Field>

          {/* Who it is for comes straight after the title: it is the one choice
              that cannot be taken back, so it is never below the fold. */}
          {!existing && meta.audiences.length > 0 && (
            <fieldset>
              <legend className="mb-1.5 text-base font-medium">Who is it for</legend>
              <div className="flex flex-wrap gap-x-5 gap-y-2">
                {meta.audiences.map((a) => (
                  <Radio key={a.key} name="audience" label={a.label} checked={audience === a.key} onChange={() => setAudience(a.key)} />
                ))}
              </div>
            </fieldset>
          )}
          {needsDepartment && (
            <Field label="Which department">
              <Select value={department} onChange={(e) => setDepartment(e.target.value)}>
                <option value="">Choose a department</option>
                {meta.departments.map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </Select>
            </Field>
          )}

          <div className="grid gap-x-4 gap-y-4 sm:grid-cols-2">
            <Field label="Kind">
              <Select value={kind} onChange={(e) => setKind(e.target.value)}>
                {meta.kinds.map((k) => (
                  <option key={k.key} value={k.key}>
                    {k.key === "OTHER" ? "Other" : k.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={call ? "Deadline" : "Day"}>
              <DateInput value={day} onChange={(e) => setDay(e.target.value)} />
            </Field>
            {timed && (
              <>
                <Field label="From">
                  <Input type="time" value={from} onChange={(e) => setFrom(e.target.value)} />
                </Field>
                <Field label="To">
                  <Input type="time" value={to} onChange={(e) => setTo(e.target.value)} />
                </Field>
              </>
            )}
            {!call && (
              <div className="flex flex-wrap gap-x-5 gap-y-2 sm:col-span-2">
                <Checkbox label="All day" checked={allDay} onCheckedChange={(v) => setAllDay(v === true)} />
                <Checkbox label="Runs over more than one day" checked={multi} onCheckedChange={(v) => setMulti(v === true)} />
              </div>
            )}
            {runs && (
              <Field label="Last day" error={backwards && lastDay ? "That is before it starts." : undefined}>
                <DateInput value={lastDay} onChange={(e) => setLastDay(e.target.value)} />
              </Field>
            )}
            {timed && !runs && to <= from && <p className="text-sm text-critical sm:col-span-2">It has to end after it starts.</p>}
            {!call && (
              <>
                <Field label="Venue">
                  <Input value={venue} onChange={(e) => setVenue(e.target.value)} placeholder="Seminar Hall 2" />
                </Field>
                <Field label="Speaker">
                  <Input value={speaker} onChange={(e) => setSpeaker(e.target.value)} placeholder="Dr Leela Nair" />
                </Field>
              </>
            )}
            <Field label="Organiser">
              <Input value={organiser} onChange={(e) => setOrganiser(e.target.value)} placeholder={call ? "The journal or publisher" : "Optional"} />
            </Field>
            <Field label="Link">
              <Input type="url" value={link} onChange={(e) => setLink(e.target.value)} placeholder="Web address to register or read more" />
            </Field>
            <Field label="Details" className="sm:col-span-2">
              <Textarea value={details} onChange={(e) => setDetails(e.target.value)} rows={2} placeholder="Optional" />
            </Field>
          </div>
          {error && <InlineError message={error} />}
        </DialogBody>
        <DialogFooter>
          <Button kind="quiet" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button kind="primary" disabled={!ready || busy} loading={busy} onClick={() => void submit()}>
            {existing ? "Save changes" : "Post event"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
