import { useState } from "react"
import { Link, useSearchParams } from "react-router-dom"
import { CalendarDays, ChevronLeft, ChevronRight, Plus } from "lucide-react"

import { useAuth } from "@/app/auth"
import { cn } from "@/lib/cn"
import { useApi, useApiMutation } from "@/lib/query"
import { Button } from "@/ui/button"
import { Combobox, type ComboboxOption } from "@/ui/combobox"
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
import { DateInput, Field, Input, Textarea } from "@/ui/field"
import { Callout, EmptyState, ErrorState, SkeletonRows } from "@/ui/state"
import { ColumnLabel, Meta, PageTitle, SectionTitle, Sub } from "@/ui/text"
import { money } from "@/ui/paper"
import { toast } from "@/ui/toast"

/**
 * The calendar — the first thing in this system that holds a future date.
 *
 * Nothing did before: a payout run was a processing batch with no schedule,
 * and a submission window or a deadline was not modelled at all, so a
 * calendar built on what existed could only have replayed months already
 * paid.
 *
 * Drawn as a list by month rather than as a grid of squares. A month grid is
 * the right shape for a diary with something on most days; this is a
 * calendar with four or five things in a term, and thirty empty boxes around
 * them says nothing a reader wanted to know. Each entry gets its full title
 * and its span instead.
 */

type Visibility = "PUBLIC" | "DEPARTMENT" | "OFFICE"

type EventRow = {
  id: string
  title: string
  kind: string
  kind_label: string
  starts_on: string
  ends_on: string | null
  description: string | null
  visibility: Visibility
  department: string | null
  thread_id: string | null
  claim_id: string | null
  created_by: string | null
  created_by_id: string | null
}

/**
 * A date the record already holds: a month's payments, a paper published, a
 * paper filed. Worked out by the server, never typed, never editable -- and
 * never a date an import stamped on a row because the workbook had none.
 */
type RecordRow = {
  id: string
  kind: "PAID" | "PUBLISHED" | "FILED"
  kind_label: string
  title: string
  starts_on: string
  count: number
  /** The college's total for the office roles; your own for a claimant. */
  amount: number | null
  claim_id: string | null
  titles: string[]
  /** A month's payments, or a month gathered for the college: a month, not its first day. */
  whole_month: boolean
}

type CalendarPayload = {
  start: string
  end: string
  results: EventRow[]
  kinds: { key: string; label: string }[]
  record?: RecordRow[]
  record_kinds?: { key: string; label: string }[]
}

type Item = { type: "event"; row: EventRow } | { type: "record"; row: RecordRow }

const KIND_TONE: Record<string, string> = {
  PAYOUT_RUN: "bg-positive",
  SUBMISSION_WINDOW: "bg-accent",
  DEADLINE: "bg-critical",
  MEETING: "bg-caution",
  OTHER: "bg-fg-subtle",
  PAID: "bg-positive",
  PUBLISHED: "bg-accent",
  FILED: "bg-fg-subtle",
}

/** The last four months and the next five: the quarter just paid is what
 *  most people open this to check, and the window steps either way. */
const BACK_DAYS = 120
const FORWARD_DAYS = 150

/** Who may open the ledger a payments entry points at (nav.ts, Ledger). */
const LEDGER_ROLES = new Set(["FINANCE", "DIRECTOR", "SUPER_ADMIN"])

export function Calendar() {
  const { me } = useAuth()
  const [searchParams, setSearchParams] = useSearchParams()
  const kind = searchParams.get("kind") ?? ""
  const offset = Number.parseInt(searchParams.get("offset") ?? "0", 10) || 0

  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<EventRow | null>(null)

  const today = new Date()
  const start = addDays(today, offset * FORWARD_DAYS - BACK_DAYS)
  const end = addDays(today, offset * FORWARD_DAYS + FORWARD_DAYS)

  const recordKind = kind === "PAID" || kind === "PUBLISHED" || kind === "FILED"
  const query = new URLSearchParams({ start: iso(start), end: iso(end) })
  if (kind && !recordKind) query.set("kind", kind)

  const { data, isLoading, isError, refetch } = useApi<CalendarPayload>(
    ["calendar", iso(start), iso(end), kind],
    `/api/calendar?${query.toString()}`
  )

  function setParam(key: string, value: string) {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev)
      if (value) next.set(key, value)
      else next.delete(key)
      return next
    })
  }

  const record = (data?.record ?? []).filter((r) => !kind || r.kind === kind)
  const items: Item[] = [
    ...(recordKind ? [] : (data?.results ?? []).map((row) => ({ type: "event" as const, row }))),
    ...record.map((row) => ({ type: "record" as const, row })),
  ]
  const events = items
  const byMonth = groupByMonth(items)

  const allKinds = [...(data?.record_kinds ?? []), ...(data?.kinds ?? [])]
  const kindOptions: ComboboxOption[] = [
    { value: "", label: "Everything" },
    ...allKinds.map((k) => ({ value: k.key, label: k.label })),
  ]
  // The server's own word for the filter, so an empty result names the thing
  // that is absent rather than the code it is stored under.
  const kindLabel = kind ? allKinds.find((k) => k.key === kind)?.label ?? null : null

  return (
    <div className="page space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <PageTitle>Calendar</PageTitle>
          <Sub className="mt-1">
            Payments made, papers published and filed, and any dates the college adds —
            submission windows, deadlines, payout runs.
          </Sub>
        </div>
        <Button kind="primary" size="md" onClick={() => setAdding(true)}>
          <Plus />
          Add a date
        </Button>
      </header>

      <div className="flex flex-wrap items-center gap-3">
        <Combobox
          value={kind}
          onChange={(v) => setParam("kind", v)}
          options={kindOptions}
          aria-label="Filter by kind"
          className="w-52"
        />
        <div className="ml-auto flex items-center gap-1">
          <Button
            kind="quiet"
            size="sm"
            onClick={() => setParam("offset", String(offset - 1))}
            aria-label="Earlier"
          >
            <ChevronLeft />
            Earlier
          </Button>
          {offset !== 0 && (
            <Button kind="quiet" size="sm" onClick={() => setParam("offset", "")}>
              Today
            </Button>
          )}
          <Button
            kind="quiet"
            size="sm"
            onClick={() => setParam("offset", String(offset + 1))}
            aria-label="Later"
          >
            Later
            <ChevronRight />
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 border-y border-line py-2">
        <Meta>
          {formatDay(iso(start))} to {formatDay(iso(end))}
        </Meta>
        {data?.kinds && <CalendarLegend kinds={allKinds} />}
      </div>

      {isLoading ? (
        <SkeletonRows rows={5} rowHeight={56} />
      ) : isError ? (
        <ErrorState
          title="Could not load the calendar"
          // Written, not relayed. `error.message` is the raw `detail` string
          // or, on a dropped connection, whatever `fetch` threw — "Failed to
          // fetch", "Request failed (500)" — which tells a reader nothing
          // about whether their dates are still there.
          message="The server did not answer. Nothing on the calendar has been changed or removed."
          onRetry={() => refetch()}
        />
      ) : events.length === 0 ? (
        <EmptyState
          // A kind filter turns this into "no deadlines in these five
          // months", which is not "the calendar is empty" — and the reader
          // who filtered is one click from the dates they are looking for,
          // so that is the button they get rather than "Add a date".
          art={kind ? "no-results" : "empty-queue"}
          icon={CalendarDays}
          title={kindLabel ? `No ${kindLabel.toLowerCase()} in this window` : "Nothing in this window"}
          message={
            kindLabel
              ? "Something else may fall in these months. Show everything, or step the window."
              : "No payment, publication or filing on record falls in these months, and no date has been added. Step the window earlier to see what has been paid, or add a submission window or a deadline."
          }
          action={
            kind ? (
              <Button kind="default" size="sm" onClick={() => setParam("kind", "")}>
                Show everything
              </Button>
            ) : (
              <span className="flex flex-wrap justify-center gap-2">
                <Button kind="default" size="sm" onClick={() => setParam("offset", String(offset - 1))}>
                  <ChevronLeft />
                  Earlier
                </Button>
                <Button kind="primary" size="sm" onClick={() => setAdding(true)}>
                  Add a date
                </Button>
              </span>
            )
          }
        />
      ) : (
        byMonth.map(([month, rows]) => (
          <section key={month} className="space-y-2">
            <SectionTitle>{month}</SectionTitle>
            <ul className="divide-y divide-line border-y border-line">
              {rows.map((item) =>
                item.type === "record" ? (
                  <RecordEntry key={item.row.id} r={item.row} ledger={LEDGER_ROLES.has(me?.role ?? "")} />
                ) : (
                  <EventEntry
                    key={item.row.id}
                    e={item.row}
                    canChange={item.row.created_by_id === me?.id || canModerate(me?.role)}
                    onChange={() => setEditing(item.row)}
                  />
                )
              )}
            </ul>
          </section>
        ))
      )}

      {(adding || editing) && (
        <EventDialog
          existing={editing}
          kinds={data?.kinds ?? []}
          onClose={() => {
            setAdding(false)
            setEditing(null)
          }}
        />
      )}
    </div>
  )
}

function EventEntry({
  e,
  canChange,
  onChange,
}: {
  e: EventRow
  canChange: boolean
  onChange: () => void
}) {
  return (
    <li className="row flex items-start gap-3 py-3">
      <span
        className={cn("mt-1.5 size-2 shrink-0 rounded-full", KIND_TONE[e.kind] ?? KIND_TONE.OTHER)}
        aria-hidden
      />
      <span className="min-w-0 flex-1">
        <span className="block text-base">{e.title}</span>
        <Meta className="block">
          {spanLabel(e)} · {e.kind_label}
          {e.department ? ` · ${e.department}` : ""}
          {e.created_by ? ` · ${e.created_by}` : ""}
        </Meta>
        {e.description && <span className="mt-0.5 block text-sm text-fg-muted">{e.description}</span>}
        {e.thread_id && (
          <Link
            to={`/discussions/${e.thread_id}`}
            className="mt-0.5 inline-block text-sm text-accent underline-offset-2 hover:underline"
          >
            From a discussion
          </Link>
        )}
      </span>
      {canChange && (
        <Button kind="quiet" size="sm" className="reveal shrink-0" onClick={onChange}>
          Change
        </Button>
      )}
    </li>
  )
}

/**
 * One date from the record. No "Change": nobody typed it, so nobody edits it
 * here -- it moves when the payment or the paper it comes from does.
 */
function RecordEntry({ r, ledger }: { r: RecordRow; ledger: boolean }) {
  const month = r.starts_on.slice(0, 7)
  const to =
    r.claim_id != null
      ? `/papers/${r.claim_id}`
      : r.kind === "PAID" && ledger
        ? `/ledger?month=${month}`
        : null
  const when = r.whole_month
    ? new Date(`${r.starts_on}T00:00:00`).toLocaleDateString("en-IN", { month: "long", year: "numeric" })
    : formatDay(r.starts_on)
  return (
    <li className="row flex items-start gap-3 py-3">
      <span className={cn("mt-1.5 size-2 shrink-0 rounded-full", KIND_TONE[r.kind])} aria-hidden />
      <span className="min-w-0 flex-1">
        {to ? (
          <Link to={to} className="block text-base underline-offset-2 hover:underline">
            {r.title}
          </Link>
        ) : (
          <span className="block text-base">{r.title}</span>
        )}
        <Meta className="block">
          {when} · {r.kind_label} · from the record
        </Meta>
        {r.titles.length > 1 && (
          <span className="mt-0.5 block truncate text-sm text-fg-muted">
            {r.titles.join(" · ")}
            {r.count > r.titles.length ? ` and ${r.count - r.titles.length} more` : ""}
          </span>
        )}
      </span>
      {r.amount != null && r.amount > 0 && (
        <span className="shrink-0 text-base tabular">{money(r.amount)}</span>
      )}
    </li>
  )
}

function canModerate(role: string | undefined): boolean {
  return role === "SUPER_ADMIN" || role === "RESEARCH_CELL" || role === "RESEARCH_COORDINATOR"
}

/* ------------------------------------------------------------------------ */
/* Adding and changing                                                       */
/* ------------------------------------------------------------------------ */

function EventDialog({
  existing,
  kinds,
  onClose,
}: {
  existing: EventRow | null
  kinds: { key: string; label: string }[]
  onClose: () => void
}) {
  const { me } = useAuth()
  const [title, setTitle] = useState(existing?.title ?? "")
  const [kind, setKind] = useState(existing?.kind ?? "DEADLINE")
  const [startsOn, setStartsOn] = useState(existing?.starts_on ?? iso(new Date()))
  const [endsOn, setEndsOn] = useState(existing?.ends_on ?? "")
  const [description, setDescription] = useState(existing?.description ?? "")
  const [visibility, setVisibility] = useState<Visibility>(existing?.visibility ?? "PUBLIC")
  const [confirmDelete, setConfirmDelete] = useState(false)

  const save = useApiMutation<Record<string, unknown>, EventRow>(
    existing ? `/api/calendar/${existing.id}` : "/api/calendar",
    { method: existing ? "PATCH" : "POST", invalidates: [["calendar"]] }
  )
  const remove = useApiMutation<void, unknown>(() => `/api/calendar/${existing?.id ?? ""}`, {
    method: "DELETE",
    invalidates: [["calendar"]],
  })

  const backwards = Boolean(endsOn) && endsOn < startsOn
  const canSubmit = title.trim().length >= 3 && startsOn && !backwards && !save.isPending

  async function submit() {
    try {
      await save.mutateAsync({
        title: title.trim(),
        kind,
        starts_on: startsOn,
        ends_on: endsOn || undefined,
        description: description.trim() || undefined,
        visibility,
        department: visibility === "DEPARTMENT" ? me?.department || undefined : undefined,
      })
      toast.ok(`${existing ? "Updated" : "Added"} — ${title.trim()} on ${formatDay(startsOn)}`)
      onClose()
    } catch (err) {
      toast.fail(err)
    }
  }

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
            <DialogTitle>{existing ? "Change this date" : "Add a date"}</DialogTitle>
            <DialogDescription>
              Whoever it concerns sees it, on the same rule threads use.
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-4">
            <Field label="What is it">
              <Input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="March payout run"
                autoFocus
              />
            </Field>

            <Field label="Kind">
              <Combobox
                value={kind}
                onChange={setKind}
                options={kinds.map((k) => ({ value: k.key, label: k.label }))}
              />
            </Field>

            <div className="grid grid-cols-2 gap-3">
              <Field label="From">
                <DateInput value={startsOn} onChange={(e) => setStartsOn(e.target.value)} />
              </Field>
              <Field
                label="Until"
                hint="Leave empty for a single day."
                error={backwards ? "That is before it starts." : undefined}
              >
                <DateInput value={endsOn} onChange={(e) => setEndsOn(e.target.value)} />
              </Field>
            </div>

            <Field label="Who can see it">
              <Combobox
                value={visibility}
                onChange={(v) => setVisibility(v as Visibility)}
                options={[
                  { value: "PUBLIC", label: "Everybody" },
                  {
                    value: "DEPARTMENT",
                    label: `My department${me?.department ? ` — ${me.department}` : ""}`,
                  },
                  { value: "OFFICE", label: "The office only" },
                ]}
                disabled={Boolean(existing)}
              />
            </Field>

            {visibility === "DEPARTMENT" && !me?.department && (
              <Callout tone="caution" title="No department is set on your account">
                Ask the research cell to set one, or make this public.
              </Callout>
            )}

            <Field label="Notes" hint="Optional — what people need to do about it.">
              <Textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={2}
              />
            </Field>
          </DialogBody>
          <DialogFooter className="justify-between">
            {existing ? (
              <Button kind="danger" onClick={() => setConfirmDelete(true)} disabled={save.isPending}>
                Remove
              </Button>
            ) : (
              <span />
            )}
            <div className="flex gap-2">
              <Button kind="quiet" onClick={onClose} disabled={save.isPending}>
                Cancel
              </Button>
              <Button kind="primary" disabled={!canSubmit} onClick={() => void submit()}>
                {save.isPending ? "Saving…" : "Save"}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        danger
        title="Remove this from the calendar?"
        description="The date goes. Anything it was about — a thread, a paper — is untouched."
        confirmLabel="Remove it"
        onConfirm={deleteIt}
      />
    </>
  )
}

/* ------------------------------------------------------------------------ */
/* Dates                                                                     */
/* ------------------------------------------------------------------------ */

/** The local calendar date, never `toISOString().slice(0, 10)`.
 *
 *  `toISOString` converts to UTC first, so anywhere east of Greenwich — this
 *  college is at +05:30 — a date built from `new Date()` before 05:30 in the
 *  morning comes out as yesterday. That silently shifted the window's ends by
 *  a day and pre-filled "Add a date" with the wrong day for anybody working
 *  early, which is exactly the class of mistake nobody thinks to check a
 *  date field for. */
function iso(d: Date): string {
  const year = d.getFullYear()
  const month = String(d.getMonth() + 1).padStart(2, "0")
  const day = String(d.getDate()).padStart(2, "0")
  return `${year}-${month}-${day}`
}

function addDays(d: Date, days: number): Date {
  const next = new Date(d)
  next.setDate(next.getDate() + days)
  return next
}

function formatDay(value: string): string {
  const d = new Date(`${value}T00:00:00`)
  if (Number.isNaN(d.getTime())) return value
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })
}

/** A span reads as a span; a single day reads as a day. */
function spanLabel(e: EventRow): string {
  if (!e.ends_on || e.ends_on === e.starts_on) return formatDay(e.starts_on)
  return `${formatDay(e.starts_on)} → ${formatDay(e.ends_on)}`
}

function groupByMonth(items: Item[]): [string, Item[]][] {
  const out = new Map<string, Item[]>()
  const sorted = [...items].sort((a, b) => a.row.starts_on.localeCompare(b.row.starts_on))
  for (const e of sorted) {
    const d = new Date(`${e.row.starts_on}T00:00:00`)
    const key = Number.isNaN(d.getTime())
      ? "Undated"
      : d.toLocaleDateString("en-IN", { month: "long", year: "numeric" })
    out.set(key, [...(out.get(key) ?? []), e])
  }
  return [...out.entries()]
}

/** The colour key, so a dot beside an entry means something. */
function CalendarLegend({ kinds }: { kinds: { key: string; label: string }[] }) {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1">
      {kinds.map((k) => (
        <span key={k.key} className="inline-flex items-center gap-1.5">
          <span
            className={cn("size-2 rounded-full", KIND_TONE[k.key] ?? KIND_TONE.OTHER)}
            aria-hidden
          />
          <ColumnLabel>{k.label}</ColumnLabel>
        </span>
      ))}
    </div>
  )
}
