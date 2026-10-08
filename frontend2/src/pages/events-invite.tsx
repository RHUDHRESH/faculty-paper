import { useEffect, useState } from "react"

import { ApiError } from "@/lib/api"
import { useApi, useApiMutation } from "@/lib/query"
import { Avatar } from "@/ui/person"
import { Button } from "@/ui/button"
import { Chip } from "@/ui/chip"
import { Checkbox, Input, Select, Textarea } from "@/ui/field"
import { Delayed, InlineError, SkeletonRows } from "@/ui/state"
import { toast } from "@/ui/toast"
import type {
  HubEvent,
  InvitePerson,
  InvitesPayload,
  InviteResult,
  PeoplePayload,
} from "@/pages/events-model"

/* ------------------------------------------------------------------------ */
/* Who was invited by whom, for the person who was asked                     */
/* ------------------------------------------------------------------------ */

/** A quiet line, no colour fill: it says who asked, nothing more. */
export function InvitedBy({ event }: { event: Pick<HubEvent, "invited_by"> }) {
  if (!event.invited_by) return null
  return <p className="text-sm text-fg-muted">Invited by {event.invited_by.name}</p>
}

/* ------------------------------------------------------------------------ */
/* Small helpers                                                             */
/* ------------------------------------------------------------------------ */

function useDebounced<T>(value: T, ms: number): T {
  const [shown, setShown] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setShown(value), ms)
    return () => clearTimeout(t)
  }, [value, ms])
  return shown
}

/** The sentence above the list: where the people came from, and how far to trust them. */
export function matchLine(p: Pick<PeoplePayload, "topics" | "ai" | "counted" | "people">): string {
  if (p.topics.length === 0 || p.people.length === 0) {
    return "No one matched this event's topic yet. Add a description with the topic, or search by name."
  }
  const named = p.topics.slice(0, 3).map((t) => t.name).join(", ")
  const topics = p.topics.length > 3 ? `${named} and ${p.topics.length - 3} more` : named
  if (!p.counted) return `Matched by AI from the event's topic: ${topics}. Check the list before inviting.`
  return `Matched by the event's topic words: ${topics}.`
}

function inviteLabel(n: number): string {
  if (n === 0) return "Invite people"
  return n === 1 ? "Invite 1 person" : `Invite ${n} people`
}

function inviteToast(n: number): string {
  return n === 1 ? "Invited 1 person" : `Invited ${n} people`
}

/* ------------------------------------------------------------------------ */
/* The panel: find people, tick them, invite them                            */
/* ------------------------------------------------------------------------ */

function PersonRow({
  person,
  checked,
  onCheck,
}: {
  person: InvitePerson
  checked: boolean
  onCheck: (on: boolean) => void
}) {
  const taken = person.status !== "none"
  return (
    <li className="flex min-h-[52px] items-start gap-3 py-2">
      {taken ? null : (
        <Checkbox className="mt-1" aria-label={`Invite ${person.name}`} checked={checked} onCheckedChange={(v) => onCheck(v === true)} />
      )}
      <Avatar person={person} size="sm" />
      <div className="min-w-0 flex-1">
        <p className="font-medium">{person.name}</p>
        {person.department && <p className="text-sm text-fg-muted">{person.department}</p>}
        {person.why && <p className="text-sm text-fg-muted">{person.why}</p>}
      </div>
      {person.status === "invited" && <Chip>Invited</Chip>}
      {person.status === "going" && <Chip tone="positive">Going</Chip>}
    </li>
  )
}

function InvitePanel({ event }: { event: HubEvent }) {
  const [q, setQ] = useState("")
  const term = useDebounced(q.trim(), 250)
  const [department, setDepartment] = useState("")
  const [departments, setDepartments] = useState<string[]>([])
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [note, setNote] = useState("")

  const params = new URLSearchParams()
  if (department) params.set("department", department)
  if (term) params.set("q", term)
  const qs = params.toString()
  const people = useApi<PeoplePayload>(
    ["events", "people", event.id, department, term],
    `/api/events/${event.id}/people${qs ? `?${qs}` : ""}`
  )

  // The department list is what the results hold when nothing narrows them,
  // so picking one does not make the others vanish from the choice.
  const data = people.data
  useEffect(() => {
    if (data && !department) {
      setDepartments([...new Set(data.people.map((p) => p.department).filter((d): d is string => Boolean(d)))].sort())
    }
  }, [data, department])

  const invite = useApiMutation<{ user_ids: string[]; note?: string }, InviteResult>(`/api/events/${event.id}/invite`, {
    invalidates: [["events"]],
  })

  const shown = data?.people ?? []
  const open = shown.filter((p) => p.status === "none")
  const count = selected.size

  function setOne(id: string, on: boolean) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (on) next.add(id)
      else next.delete(id)
      return next
    })
  }

  function selectAll() {
    setSelected((prev) => new Set([...prev, ...open.map((p) => p.id)]))
  }

  async function send() {
    const body: { user_ids: string[]; note?: string } = { user_ids: Array.from(selected) }
    if (note.trim()) body.note = note.trim()
    try {
      const said = await invite.mutateAsync(body)
      toast.ok(inviteToast(said.invited))
      setSelected(new Set())
      setNote("")
    } catch {
      // Shown inline below, next to the button that failed.
    }
  }

  const inviteError = invite.error
  const inviteMessage =
    inviteError instanceof ApiError && inviteError.status === 403
      ? "Only the person who posted this, or the office, can invite people to it."
      : inviteError?.message || "Could not send the invitations. Please try again."

  return (
    <div className="space-y-4 border-t border-line pt-4">
      {people.isError ? (
        people.error instanceof ApiError && people.error.status === 403 ? (
          <InlineError message="Only the person who posted this, or the office, can invite people to it." />
        ) : (
          <InlineError message="Could not load the people. Please try again." onRetry={() => void people.refetch()} />
        )
      ) : people.isLoading ? (
        <Delayed>
          <SkeletonRows rows={5} rowHeight={52} />
        </Delayed>
      ) : data ? (
        <>
          <p className="text-sm text-fg-muted">{matchLine(data)}</p>

          <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_14rem]">
            <Input
              type="search"
              aria-label="Search by name"
              placeholder="Search by name"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
            <Select aria-label="Department" value={department} onChange={(e) => setDepartment(e.target.value)}>
              <option value="">All departments</option>
              {departments.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </Select>
          </div>

          {shown.length > 0 && (
            <div className="flex items-center justify-between gap-3">
              <Button kind="quiet" size="sm" onClick={selectAll} disabled={open.length === 0}>
                Select all {shown.length} shown
              </Button>
            </div>
          )}

          <ul className="divide-y divide-line">
            {shown.map((p) => (
              <PersonRow key={p.id} person={p} checked={selected.has(p.id)} onCheck={(on) => setOne(p.id, on)} />
            ))}
          </ul>

          <div className="space-y-3 border-t border-line pt-3">
            <Textarea
              aria-label="Add a note (optional)"
              placeholder="Add a note (optional)"
              rows={2}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
            {inviteError && <InlineError message={inviteMessage} />}
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm text-fg-muted">{count === 0 ? "Tick the people to invite" : ""}</p>
              <Button
                kind="primary"
                disabled={count === 0 || invite.isPending}
                loading={invite.isPending}
                onClick={() => void send()}
              >
                {inviteLabel(count)}
              </Button>
            </div>
          </div>
        </>
      ) : null}
    </div>
  )
}

/* ------------------------------------------------------------------------ */
/* Who is invited                                                            */
/* ------------------------------------------------------------------------ */

function InvitedList({ eventId }: { eventId: string }) {
  const invites = useApi<InvitesPayload>(["events", "invites", eventId], `/api/events/${eventId}/invites`)
  if (invites.isError) return <InlineError message="Could not load who is invited." />
  if (invites.isLoading) {
    return (
      <Delayed>
        <SkeletonRows rows={3} rowHeight={52} />
      </Delayed>
    )
  }
  const rows = invites.data?.people ?? []
  if (rows.length === 0) return <p className="pt-2 text-sm text-fg-muted">Nobody has been invited yet.</p>
  return (
    <ul className="divide-y divide-line">
      {rows.map((p) => (
        <li key={p.id} className="flex min-h-[52px] items-start gap-3 py-2">
          <Avatar person={p} size="sm" />
          <div className="min-w-0 flex-1">
            <p className="font-medium">{p.name}</p>
            {p.department && <p className="text-sm text-fg-muted">{p.department}</p>}
          </div>
          {p.going ? <Chip tone="positive">Going</Chip> : <Chip>Invited</Chip>}
        </li>
      ))}
    </ul>
  )
}

/* ------------------------------------------------------------------------ */
/* The section in "More details", for an editor only                         */
/* ------------------------------------------------------------------------ */

export function InviteSection({ event }: { event: HubEvent }) {
  const [panel, setPanel] = useState(false)
  const [listing, setListing] = useState(false)
  const invited = event.invited_count ?? 0

  return (
    <section aria-labelledby={`invite-${event.id}`} className="space-y-3 border-t border-line pt-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 id={`invite-${event.id}`} className="text-base font-semibold">
            Invite people
          </h3>
          <p className="tabular text-sm text-fg-muted">
            {invited} invited · {event.going_count} going
          </p>
        </div>
        {panel ? (
          <Button kind="quiet" size="sm" onClick={() => setPanel(false)}>
            Close
          </Button>
        ) : (
          <Button kind="default" size="sm" onClick={() => setPanel(true)}>
            Find people to invite
          </Button>
        )}
      </div>

      {panel && <InvitePanel event={event} />}

      <div className="space-y-2">
        <Button kind="quiet" size="sm" aria-expanded={listing} onClick={() => setListing((v) => !v)}>
          {listing ? "Hide who is invited" : `Show who is invited (${invited})`}
        </Button>
        {listing && <InvitedList eventId={event.id} />}
      </div>
    </section>
  )
}
