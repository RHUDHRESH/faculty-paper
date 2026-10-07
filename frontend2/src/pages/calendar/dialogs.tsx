import { useState } from "react"
import { Link } from "react-router-dom"
import { CalendarCheck, CalendarPlus, ChevronDown, ExternalLink, FileText, MapPin, UserRound } from "lucide-react"

import { useAuth } from "@/app/auth"
import { cn } from "@/lib/cn"
import { useApi, useApiMutation } from "@/lib/query"
import { Button } from "@/ui/button"
import { Combobox } from "@/ui/combobox"
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
import { Checkbox, DateInput, Field, Input, Radio, Textarea } from "@/ui/field"
import { money } from "@/ui/paper"
import { Avatar, initialsOf } from "@/ui/person"
import { Sheet, SheetBody, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/ui/sheet"
import { toast } from "@/ui/toast"
import { useGoogleStatus } from "./google"
import {
  type CalItem,
  type EventRow,
  type Visibility,
  dayLabel,
  googleTemplateUrl,
  kindLabelOf,
  kindStyle,
  paperLink,
  plusHour,
  rangeLabel,
  shortDay,
  timeLabel,
} from "./model"
import { usePhone } from "./use-phone"

/* ------------------------------------------------------------------------ */
/* Add / edit                                                                */
/* ------------------------------------------------------------------------ */

const AUDIENCE: Record<Visibility, string> = {
  PRIVATE: "Only me",
  DEPARTMENT: "My department",
  PUBLIC: "College",
  OFFICE: "The office",
}

/** The order kinds are offered in: the everyday ones first, whatever order the server lists them. */
const KIND_ORDER = ["OTHER", "MEETING", "DEADLINE", "SUBMISSION_WINDOW", "PAYOUT_RUN", "SEMINAR", "WORKSHOP", "CONFERENCE", "FDP", "CALL_FOR_PAPERS"]
const kindRank = (k: string) => (KIND_ORDER.indexOf(k) === -1 ? KIND_ORDER.length : KIND_ORDER.indexOf(k))

/** What older servers offer when they do not send their own list of kinds. */
const BASE_KINDS = KIND_ORDER.slice(0, 5)

export type Prefill = { date: string; time?: string }

type MyPaper = { id: string; paper_title: string | null }

/**
 * Add an event, or change one.
 *
 * Adding asks for a title and a day and nothing more: the rest (a time, who
 * sees it, a kind, a paper, notes) is one tap away under "More options", with
 * a sensible default for each. A form of eight fields in front of someone who
 * wanted to jot down a deadline is a form they close.
 */
export function EventDialog({
  existing,
  prefill,
  visibilities,
  kinds,
  onClose,
}: {
  existing: EventRow | null
  prefill: Prefill
  visibilities: Visibility[]
  /** The kinds the server knows, so a kind added there appears here without a release. */
  kinds: { key: string; label: string }[]
  onClose: () => void
}) {
  const { me } = useAuth()
  const google = useGoogleStatus()
  const [title, setTitle] = useState(existing?.title ?? "")
  const [kind, setKind] = useState(existing?.kind ?? "OTHER")
  const [startsOn, setStartsOn] = useState(existing?.starts_on ?? prefill.date)
  const [allDay, setAllDay] = useState(existing ? existing.all_day : !prefill.time)
  const [startsAt, setStartsAt] = useState(existing?.starts_at ?? prefill.time ?? "10:00")
  const [endsAt, setEndsAt] = useState(existing?.ends_at ?? plusHour(prefill.time ?? "10:00"))
  const [range, setRange] = useState(Boolean(existing?.ends_on))
  const [endsOn, setEndsOn] = useState(existing?.ends_on ?? prefill.date)
  const [visibility, setVisibility] = useState<Visibility>(existing?.visibility ?? "PRIVATE")
  const [notes, setNotes] = useState(existing?.description ?? "")
  const [claimId, setClaimId] = useState(existing?.claim_id ?? "")
  const [more, setMore] = useState(Boolean(existing))

  // Only fetched once somebody opens the part of the form that uses it.
  const papers = useApi<{ results: MyPaper[] }>(["calendar", "my-papers"], "/api/claims?mine=1&limit=200", {
    staleTime: 60_000,
    enabled: more,
  })
  const save = useApiMutation<Record<string, unknown>, EventRow>(
    existing ? `/api/calendar/${existing.id}` : "/api/calendar",
    { method: existing ? "PATCH" : "POST", invalidates: [["calendar"]] }
  )

  const hasAudience = visibilities.length > 1
  const known = kinds.length > 0 ? kinds.map((k) => k.key) : BASE_KINDS
  // Somebody who can only tell themselves is offered the two things a person
  // keeps for themselves: a reminder and a deadline.
  const offered = (hasAudience ? known : known.filter((k) => k === "OTHER" || k === "DEADLINE"))
    .filter((k, i, all) => all.indexOf(k) === i)
    .sort((a, b) => kindRank(a) - kindRank(b))
  const backwards = (range && endsOn < startsOn) || (!allDay && !range && endsAt < startsAt)
  const canSubmit = title.trim().length >= 3 && Boolean(startsOn) && !backwards && !save.isPending
  const synced = Boolean(google.data?.connected && !google.data.needs_reconnect)

  async function submit() {
    if (!canSubmit) return
    try {
      await save.mutateAsync({
        title: title.trim(),
        kind,
        starts_on: startsOn,
        ends_on: range ? endsOn : undefined,
        all_day: allDay,
        starts_at: allDay ? undefined : startsAt,
        ends_at: allDay ? undefined : endsAt,
        description: notes.trim() || undefined,
        visibility,
        department: visibility === "DEPARTMENT" ? me?.department || undefined : undefined,
        claim_id: claimId || undefined,
      })
      toast.ok(`${existing ? "Updated" : "Added"}: ${title.trim()}, ${dayLabel(startsOn)}`)
      onClose()
    } catch (err) {
      toast.fail(err)
    }
  }

  const paperOptions = [
    { value: "", label: "None" },
    ...(papers.data?.results ?? []).map((p) => ({ value: p.id, label: p.paper_title || "Untitled paper" })),
  ]

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>{existing ? "Edit event" : "Add event"}</DialogTitle>
          <DialogDescription>
            {visibility === "PRIVATE" ? "Only you see this." : `${AUDIENCE[visibility]} sees this.`}
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={(e) => {
            e.preventDefault()
            void submit()
          }}
        >
          <DialogBody className="space-y-4">
            <Field label="Title">
              <Input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="For example: Send revisions to the editor"
                autoComplete="off"
                autoFocus
              />
            </Field>

            <Field label="Date">
              <DateInput value={startsOn} onChange={(e) => setStartsOn(e.target.value)} />
            </Field>

            <div>
              <Checkbox label="Add a time" checked={!allDay} onCheckedChange={(v) => setAllDay(v !== true)} />
            </div>
            {!allDay && (
              <div className="grid grid-cols-2 gap-3">
                <Field label="From">
                  <Input type="time" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} />
                </Field>
                <Field label="To" error={backwards && !range ? "That is before it starts." : undefined}>
                  <Input type="time" value={endsAt} onChange={(e) => setEndsAt(e.target.value)} />
                </Field>
              </div>
            )}

            {!existing && hasAudience && (
              <fieldset>
                <legend className="mb-1.5 text-sm font-medium">Who sees it</legend>
                <div className="flex flex-wrap gap-x-4 gap-y-2">
                  {visibilities.map((v) => (
                    <Radio
                      key={v}
                      name="visibility"
                      label={v === "DEPARTMENT" && me?.department ? `${AUDIENCE[v]} (${me.department})` : AUDIENCE[v]}
                      checked={visibility === v}
                      onChange={() => setVisibility(v)}
                    />
                  ))}
                </div>
              </fieldset>
            )}

            <div>
              <button
                type="button"
                aria-expanded={more}
                onClick={() => setMore((m) => !m)}
                className="inline-flex items-center gap-1 text-sm font-medium text-fg-muted hover:text-fg"
              >
                More options
                <ChevronDown className={cn("size-4 transition-transform", more && "rotate-180")} aria-hidden />
              </button>
            </div>

            {more && (
              <div className="space-y-4">
                {offered.length > 1 && (
                  <fieldset>
                    <legend className="mb-1.5 text-sm font-medium">Kind</legend>
                    <div className="flex flex-wrap gap-x-4 gap-y-2">
                      {offered.map((k) => (
                        <Radio
                          key={k}
                          name="kind"
                          label={k === "OTHER" ? (visibility === "PRIVATE" ? "Reminder" : "Event") : kindLabelOf(k)}
                          checked={kind === k}
                          onChange={() => setKind(k)}
                        />
                      ))}
                    </div>
                  </fieldset>
                )}

                <div className="space-y-2">
                  <Checkbox label="Runs over more than one day" checked={range} onCheckedChange={(v) => setRange(v === true)} />
                  {range && (
                    <Field label="Until" error={backwards ? "That is before it starts." : undefined}>
                      <DateInput value={endsOn} onChange={(e) => setEndsOn(e.target.value)} />
                    </Field>
                  )}
                </div>

                <Field label="About one of my papers" hint="Optional.">
                  <Combobox value={claimId} onChange={setClaimId} options={paperOptions} aria-label="About one of my papers" />
                </Field>

                <Field label="Notes" hint="Optional.">
                  <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} />
                </Field>
              </div>
            )}

            {synced && !existing && (
              <p className="text-sm text-fg-muted">It will reach your Google Calendar by itself.</p>
            )}
          </DialogBody>
          <DialogFooter>
            <Button type="button" kind="quiet" onClick={onClose} disabled={save.isPending}>
              Cancel
            </Button>
            <Button type="submit" kind="primary" disabled={!canSubmit} loading={save.isPending}>
              {existing ? "Save changes" : "Add event"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/* ------------------------------------------------------------------------ */
/* An event's details                                                        */
/* ------------------------------------------------------------------------ */

/** Who may open the ledger a payments entry points at (nav.ts, Ledger). */
const LEDGER_ROLES = new Set(["FINANCE", "DIRECTOR", "SUPER_ADMIN"])
const OFFICE = new Set(["SUPER_ADMIN", "RESEARCH_CELL", "RESEARCH_COORDINATOR"])

/** The details of one date, in a sheet that leaves the calendar where it was. */
export function EventSheet({
  item,
  onClose,
  onEdit,
}: {
  item: CalItem
  onClose: () => void
  onEdit: (e: EventRow) => void
}) {
  const { me } = useAuth()
  const phone = usePhone()
  const google = useGoogleStatus()
  const [confirm, setConfirm] = useState(false)
  const remove = useApiMutation<void, unknown>(() => `/api/calendar/${item.event?.id ?? ""}`, {
    method: "DELETE",
    invalidates: [["calendar"]],
  })
  const { icon: Icon, colour } = kindStyle(item.kind)
  const e = item.event
  const r = item.record
  const canChange = Boolean(e && (e.created_by_id === me?.id || (OFFICE.has(me?.role ?? "") && e.visibility !== "PRIVATE")))
  const paper = paperLink(item)
  const ledger = r?.kind === "PAID" && !r.claim_id && LEDGER_ROLES.has(me?.role ?? "") ? `/ledger?month=${r.starts_on.slice(0, 7)}` : null
  const inGoogle = Boolean(google.data?.connected && !google.data.needs_reconnect)
  const day =
    r?.whole_month
      ? new Date(`${r.starts_on}T00:00:00`).toLocaleDateString("en-IN", { month: "long", year: "numeric" })
      : item.start === item.end
        ? shortDay(item.start)
        : rangeLabel(item.start, item.end)
  const audience = r
    ? "From the record"
    : e?.visibility === "PRIVATE"
      ? "Only you see this"
      : e?.visibility === "DEPARTMENT"
        ? `${e.department ?? "Your department"} sees this`
        : e?.visibility === "OFFICE"
          ? "The office sees this"
          : "Everyone at the college sees this"

  async function deleteIt() {
    try {
      await remove.mutateAsync(undefined as never)
      toast.ok("Removed from the calendar")
      onClose()
    } catch (err) {
      toast.fail(err)
      throw err
    }
  }

  return (
    <>
      <Sheet open onOpenChange={(o) => !o && onClose()}>
        <SheetContent side={phone ? "bottom" : "right"}>
          <SheetHeader className="space-y-1.5">
            <p className="flex items-center gap-2 text-sm text-fg-muted">
              <span
                aria-hidden
                className="grid size-6 place-items-center rounded-full"
                style={{ backgroundColor: `color-mix(in srgb, ${colour} 14%, transparent)` }}
              >
                <Icon className="size-3.5" style={{ color: colour }} />
              </span>
              {item.kindLabel}
            </p>
            <SheetTitle>{item.title}</SheetTitle>
            <SheetDescription>
              {day}
              {!r?.whole_month && item.startTime ? ` · ${timeLabel(item)}` : ""}
            </SheetDescription>
          </SheetHeader>
          <SheetBody className="space-y-3 text-sm">
            {e?.description && <p className="whitespace-pre-wrap text-base">{e.description}</p>}
            {e?.venue && (
              <p className="flex items-start gap-2">
                <MapPin className="mt-0.5 size-4 shrink-0 text-fg-subtle" aria-hidden />
                <span>{e.venue}</span>
              </p>
            )}
            {e?.speaker && (
              <p className="flex items-start gap-2">
                <UserRound className="mt-0.5 size-4 shrink-0 text-fg-subtle" aria-hidden />
                <span>{e.speaker}</span>
              </p>
            )}
            {e?.link && (
              <p>
                <a
                  href={e.link}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 font-medium text-accent underline-offset-2 hover:underline"
                >
                  Open the event link
                  <ExternalLink className="size-3.5" aria-hidden />
                </a>
              </p>
            )}
            {e?.claim_title && (
              <p className="flex items-center gap-1.5 text-fg-muted">
                <FileText className="size-4" aria-hidden /> {e.claim_title}
              </p>
            )}
            {r && r.titles.length > 1 && (
              <p className="text-fg-muted">
                {r.titles.join(" · ")}
                {r.count > r.titles.length ? ` and ${r.count - r.titles.length} more` : ""}
              </p>
            )}
            {/* The server sends an amount only to whoever may see it: your own, or the office's total. */}
            {r?.amount != null && r.amount > 0 && <p className="tabular text-base">{money(r.amount)}</p>}
            {r?.person && (
              <Link to={`/people/${r.person.user_id}`} className="flex items-center gap-2 hover:underline">
                <Avatar size="sm" person={{ name: r.person.name, initials: r.person.initials ?? initialsOf(r.person.name), photo_url: r.person.photo_url ?? null }} />
                <span className="font-medium">{r.person.name}</span>
              </Link>
            )}
            {r?.kind === "SCOUT" && (
              <p className="text-fg-muted">
                Found by your latest Research scout run.{" "}
                {r.url ? (
                  <a href={r.url} target="_blank" rel="noopener noreferrer" className="text-fg underline">
                    Open the call
                  </a>
                ) : (
                  <Link to="/scout" className="text-fg underline">Open Research scout</Link>
                )}
              </p>
            )}
            <p className="text-fg-muted">
              {audience}
              {e?.created_by && e.created_by_id !== me?.id ? ` · added by ${e.created_by}` : ""}
            </p>
            {inGoogle && (
              <p className="flex items-center gap-1.5 text-fg-muted">
                <CalendarCheck className="size-4 text-positive" aria-hidden />
                It is in your Google Calendar. Changes reach it by themselves.
              </p>
            )}
          </SheetBody>
          <SheetFooter className="flex-wrap justify-between gap-2">
            <div className="flex flex-wrap gap-2">
              {!inGoogle && (
                <Button kind="default" size="sm" asChild>
                  <a href={googleTemplateUrl(item)} target="_blank" rel="noopener noreferrer">
                    <CalendarPlus />
                    Add to Google Calendar
                    <ExternalLink />
                  </a>
                </Button>
              )}
              {paper && (
                <Button kind="quiet" size="sm" asChild>
                  <Link to={paper}>Open paper</Link>
                </Button>
              )}
              {ledger && (
                <Button kind="quiet" size="sm" asChild>
                  <Link to={ledger}>Open ledger</Link>
                </Button>
              )}
            </div>
            {canChange && e && (
              <div className="flex gap-2">
                <Button kind="danger" size="sm" onClick={() => setConfirm(true)}>
                  Delete
                </Button>
                <Button kind="default" size="sm" onClick={() => onEdit(e)}>
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
        description="It goes from your calendar and from your Google Calendar. Any paper it mentions is untouched."
        confirmLabel="Delete it"
        onConfirm={deleteIt}
      />
    </>
  )
}

/* ------------------------------------------------------------------------ */
/* A day with more than fits                                                 */
/* ------------------------------------------------------------------------ */

export function DayDialog({
  day,
  items,
  onOpen,
  onClose,
}: {
  day: string
  items: CalItem[]
  onOpen: (i: CalItem) => void
  onClose: () => void
}) {
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>{dayLabel(day, true)}</DialogTitle>
          <DialogDescription>{items.length} on this day</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <ul className="divide-y divide-line">
            {items.map((i) => {
              const { icon: Icon, colour } = kindStyle(i.kind)
              return (
                <li key={i.key}>
                  <button type="button" onClick={() => onOpen(i)} className="flex w-full items-center gap-2 py-2 text-left hover:bg-hover">
                    <Icon className="size-4 shrink-0" style={{ color: colour }} aria-hidden />
                    <span className="min-w-0 flex-1 truncate">{i.title}</span>
                    <span className="text-xs text-fg-muted">{timeLabel(i)}</span>
                  </button>
                </li>
              )
            })}
          </ul>
        </DialogBody>
      </DialogContent>
    </Dialog>
  )
}
