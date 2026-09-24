import { useState } from "react"
import { Link } from "react-router-dom"
import { CalendarPlus, ChevronDown, Copy, ExternalLink, FileText, RotateCcw } from "lucide-react"

import { useAuth } from "@/app/auth"
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
import { Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from "@/ui/menu"
import { money } from "@/ui/paper"
import { toast } from "@/ui/toast"
import {
  type CalItem,
  type EventRow,
  type FeedLink,
  type Visibility,
  dayLabel,
  googleTemplateUrl,
  kindStyle,
  paperLink,
  timeLabel,
} from "./model"

/* ------------------------------------------------------------------------ */
/* Add / edit                                                                */
/* ------------------------------------------------------------------------ */

const KIND_CHOICES = [
  { value: "OTHER", label: "Reminder" },
  { value: "MEETING", label: "Meeting" },
  { value: "DEADLINE", label: "Deadline" },
  { value: "SUBMISSION_WINDOW", label: "Window" },
  { value: "PAYOUT_RUN", label: "Payout run" },
]

const AUDIENCE: Record<Visibility, string> = {
  PRIVATE: "Only me",
  DEPARTMENT: "My department",
  PUBLIC: "College",
  OFFICE: "The office",
}

export type Prefill = { date: string; time?: string }

type MyPaper = { id: string; paper_title: string | null }

export function EventDialog({
  existing,
  prefill,
  visibilities,
  onClose,
}: {
  existing: EventRow | null
  prefill: Prefill
  visibilities: Visibility[]
  onClose: () => void
}) {
  const { me } = useAuth()
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
  const [toGoogle, setToGoogle] = useState(false)

  const papers = useApi<{ results: MyPaper[] }>(["calendar", "my-papers"], "/api/claims?mine=1&limit=200", {
    staleTime: 60_000,
  })
  const save = useApiMutation<Record<string, unknown>, EventRow>(
    existing ? `/api/calendar/${existing.id}` : "/api/calendar",
    { method: existing ? "PATCH" : "POST", invalidates: [["calendar"]] }
  )

  const kinds = visibilities.length > 1 ? KIND_CHOICES : KIND_CHOICES.slice(0, 1).concat(KIND_CHOICES[2])
  const backwards = (range && endsOn < startsOn) || (!allDay && !range && endsAt < startsAt)
  const canSubmit = title.trim().length >= 3 && Boolean(startsOn) && !backwards && !save.isPending

  async function submit() {
    try {
      const saved = await save.mutateAsync({
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
      if (toGoogle) {
        window.open(
          googleTemplateUrl({
            key: saved.id,
            title: saved.title,
            kind: saved.kind,
            kindLabel: saved.kind_label,
            start: saved.starts_on,
            end: saved.ends_on ?? saved.starts_on,
            startTime: saved.starts_at,
            endTime: saved.ends_at,
            layer: "mine",
            event: saved,
          }),
          "_blank",
          "noopener"
        )
      }
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
        <DialogBody className="space-y-4">
          <Field label="Title">
            <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Send revisions to the editor" autoFocus />
          </Field>

          <fieldset>
            <legend className="mb-1.5 text-sm font-medium">Kind</legend>
            <div className="flex flex-wrap gap-x-4 gap-y-2">
              {kinds.map((k) => (
                <Radio key={k.value} name="kind" label={k.label} checked={kind === k.value} onChange={() => setKind(k.value)} />
              ))}
            </div>
          </fieldset>

          <div className="space-y-2">
            <div className="grid grid-cols-[1fr_auto_auto] items-end gap-2">
              <Field label="When">
                <DateInput value={startsOn} onChange={(e) => setStartsOn(e.target.value)} />
              </Field>
              {!allDay && (
                <>
                  <Field label="From">
                    <Input type="time" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} className="w-28" />
                  </Field>
                  <Field label="To">
                    <Input type="time" value={endsAt} onChange={(e) => setEndsAt(e.target.value)} className="w-28" />
                  </Field>
                </>
              )}
            </div>
            <div className="flex flex-wrap gap-x-5 gap-y-2">
              <Checkbox label="All day" checked={allDay} onCheckedChange={(v) => setAllDay(v === true)} />
              <Checkbox label="Ends on a different day" checked={range} onCheckedChange={(v) => setRange(v === true)} />
            </div>
            {range && (
              <Field label="Until" error={backwards ? "That is before it starts." : undefined}>
                <DateInput value={endsOn} onChange={(e) => setEndsOn(e.target.value)} />
              </Field>
            )}
          </div>

          {!existing && visibilities.length > 1 && (
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

          <Field label="About one of my papers" hint="Optional.">
            <Combobox value={claimId} onChange={setClaimId} options={paperOptions} aria-label="About one of my papers" />
          </Field>

          <Field label="Notes" hint="Optional.">
            <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} />
          </Field>

          {!existing && (
            <Checkbox label="Add to my Google Calendar after saving" checked={toGoogle} onCheckedChange={(v) => setToGoogle(v === true)} />
          )}
        </DialogBody>
        <DialogFooter>
          <Button kind="quiet" onClick={onClose} disabled={save.isPending}>
            Cancel
          </Button>
          <Button kind="primary" disabled={!canSubmit} onClick={() => void submit()}>
            {save.isPending ? "Saving…" : "Save event"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function plusHour(t: string): string {
  const [h, m] = t.split(":").map(Number)
  return `${String(Math.min(h + 1, 23)).padStart(2, "0")}:${String(m).padStart(2, "0")}`
}

/* ------------------------------------------------------------------------ */
/* An event's details                                                        */
/* ------------------------------------------------------------------------ */

/** Who may open the ledger a payments entry points at (nav.ts, Ledger). */
const LEDGER_ROLES = new Set(["FINANCE", "DIRECTOR", "SUPER_ADMIN"])
const OFFICE = new Set(["SUPER_ADMIN", "RESEARCH_CELL", "RESEARCH_COORDINATOR"])

export function EventDetails({
  item,
  onClose,
  onEdit,
}: {
  item: CalItem
  onClose: () => void
  onEdit: (e: EventRow) => void
}) {
  const { me } = useAuth()
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
  const when = r?.whole_month
    ? new Date(`${r.starts_on}T00:00:00`).toLocaleDateString("en-IN", { month: "long", year: "numeric" })
    : item.start === item.end
      ? `${dayLabel(item.start, true)}${item.startTime ? `, ${timeLabel(item)}` : ""}`
      : `${dayLabel(item.start, true)} → ${dayLabel(item.end, true)}`

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
      <Dialog open onOpenChange={(o) => !o && onClose()}>
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle className="flex items-start gap-2 pr-6">
              <Icon className="mt-1 size-4 shrink-0" style={{ color: colour }} aria-hidden />
              {item.title}
            </DialogTitle>
            <DialogDescription>
              {when} · {item.kindLabel}
              {r ? " · from the record" : e?.visibility === "PRIVATE" ? " · only you" : e?.department ? ` · ${e.department}` : ""}
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-2 text-sm">
            {e?.description && <p className="whitespace-pre-wrap">{e.description}</p>}
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
            {r?.amount != null && r.amount > 0 && <p className="tabular">{money(r.amount)}</p>}
            {e?.created_by && e.created_by_id !== me?.id && <p className="text-fg-muted">Added by {e.created_by}</p>}
          </DialogBody>
          <DialogFooter className="flex-wrap justify-between gap-2">
            <div className="flex flex-wrap gap-2">
              <Button kind="default" size="sm" asChild>
                <a href={googleTemplateUrl(item)} target="_blank" rel="noopener noreferrer">
                  <CalendarPlus />
                  Add to Google Calendar
                  <ExternalLink />
                </a>
              </Button>
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
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        danger
        title="Delete this event?"
        description="It goes from your calendar and your feed. Any paper it mentions is untouched."
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

/* ------------------------------------------------------------------------ */
/* Google Calendar menu                                                      */
/* ------------------------------------------------------------------------ */

export function GoogleMenu() {
  const [confirm, setConfirm] = useState(false)
  const link = useApi<FeedLink>(["calendar", "feed-link"], "/api/calendar/feed-link", { staleTime: Infinity })
  const reset = useApiMutation<void, FeedLink>("/api/calendar/feed-link/reset", {
    invalidates: [["calendar", "feed-link"]],
  })

  async function copy() {
    if (!link.data) return
    try {
      await navigator.clipboard.writeText(link.data.url)
      toast.ok("Feed link copied. Paste it into Outlook or Apple Calendar.")
    } catch {
      toast.fail(new Error("Could not copy. Select the link and copy it by hand."))
    }
  }

  async function doReset() {
    await reset.mutateAsync(undefined as never)
    toast.ok("New link made. The old one no longer works.")
  }

  return (
    <>
      <Menu>
        <MenuTrigger asChild>
          <Button kind="default" size="md">
            <CalendarPlus />
            Google Calendar
            <ChevronDown />
          </Button>
        </MenuTrigger>
        <MenuContent align="end" className="w-80">
          <MenuItem
            disabled={!link.data}
            onSelect={() => link.data && window.open(link.data.google_subscribe_url, "_blank", "noopener")}
          >
            Subscribe in Google Calendar
          </MenuItem>
          <MenuItem disabled={!link.data} onSelect={() => void copy()}>
            <span className="inline-flex items-center gap-1.5">
              <Copy className="size-3.5" aria-hidden /> Copy feed link (for Outlook / Apple)
            </span>
          </MenuItem>
          <MenuItem danger onSelect={() => setConfirm(true)}>
            <span className="inline-flex items-center gap-1.5">
              <RotateCcw className="size-3.5" aria-hidden /> Reset link
            </span>
          </MenuItem>
          <MenuSeparator />
          <MenuLabel className="whitespace-normal leading-4">
            Your feed shows titles and dates only — never amounts. Google checks for changes every
            8–24 hours. For an event you need right away, use "Add to Google Calendar" on the event.
          </MenuLabel>
        </MenuContent>
      </Menu>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        danger
        title="Reset your calendar link?"
        description="The old link stops working. You'll need to subscribe again."
        confirmLabel="Reset link"
        onConfirm={doReset}
      />
    </>
  )
}
