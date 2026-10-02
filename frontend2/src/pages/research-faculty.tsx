import { useMemo, useState } from "react"
import { Link } from "react-router-dom"
import { Pencil, Search } from "lucide-react"

import { useAuth } from "@/app/auth"
import { api, ApiError } from "@/lib/api"
import { cn } from "@/lib/cn"
import { queryClient, useApi } from "@/lib/query"
import { Button } from "@/ui/button"
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/ui/dialog"
import { DateInput, Field, Input, NumberInput, Textarea } from "@/ui/field"
import { Details } from "@/ui/section"
import { PageHeader } from "@/ui/page-header"
import { money } from "@/ui/paper"
import { Avatar } from "@/ui/person"
import { Chip } from "@/ui/chip"
import { Callout, EmptyState, ErrorState, SkeletonRows } from "@/ui/state"
import { Meta } from "@/ui/text"
import { toast } from "@/ui/toast"
import {
  longDate,
  ThresholdMeter,
  type ThresholdHistory,
  type ThresholdSummary,
} from "@/ui/research-threshold"

/**
 * Research faculty and their yearly rupee threshold.
 *
 * Research faculty are already paid to do research, so the first part of the
 * incentives they earn each year is not paid. The research coordinator or a
 * super admin sets that amount for each person; this page lists everybody who
 * is research faculty with what is used and what is left, and sets or edits
 * it with a note. Every change is kept with who made it and when, so a past
 * year keeps the threshold that applied then.
 *
 * Who is research faculty is ticked on the person's own page (People).
 */

type Row = {
  user_id: string
  name: string
  initials: string
  photo_url: string | null
  department: string | null
  designation: string | null
  threshold: number | null
  unset: boolean
  used: number
  left: number | null
  on_the_way: number
  on_the_way_above: number
  year: string
  old_quota: number | null
  needs_rupee_threshold: boolean
  set_by: string | null
  set_at: string | null
  effective_from: string | null
  note: string | null
}

type List = {
  year: string
  year_start: string
  year_end: string
  count: number
  unset_count: number
  old_rule_count: number
  rows: Row[]
}

const LIST_KEY = ["research-faculty"] as const

function toIso(d: Date) {
  const z = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`
}

export function ResearchFaculty() {
  const { me } = useAuth()
  const list = useApi<List>(LIST_KEY, "/api/research-faculty")
  const [q, setQ] = useState("")
  const [onlyUnset, setOnlyUnset] = useState(false)
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null)

  const rows = useMemo(() => {
    const term = q.trim().toLowerCase()
    return (list.data?.rows ?? []).filter(
      (r) =>
        (!onlyUnset || r.unset) &&
        (!term || `${r.name} ${r.department ?? ""}`.toLowerCase().includes(term))
    )
  }, [list.data, q, onlyUnset])

  const d = list.data
  const yearRange = d ? `${longDate(d.year_start)} to ${longDate(toIso(new Date(new Date(`${d.year_end}T00:00:00`).getTime() - 86400000)))}` : ""

  return (
    <div className="page space-y-6 pb-24">
      <PageHeader
        title="Research faculty"
        sub={d ? `${d.count} on research posts. Threshold year ${d.year}: ${yearRange}.` : undefined}
        action={
          <>
            {me?.role === "SUPER_ADMIN" && (
              <Button kind="quiet" size="md" asChild>
                <Link to="/policy">Change the year in policy</Link>
              </Button>
            )}
            <Button kind="default" size="md" asChild>
              <Link to="/people?research=RESEARCH">Mark someone as research faculty</Link>
            </Button>
          </>
        }
      />

      {list.isError ? (
        <ErrorState
          title={list.error instanceof ApiError && list.error.status === 403 ? "This page is for the research coordinator" : "Could not load research faculty"}
          message={list.error?.message}
          onRetry={() => void list.refetch()}
        />
      ) : (
        <>
          {d && d.unset_count > 0 && (
            <Callout tone="caution" title={`${d.unset_count} ${d.unset_count === 1 ? "person has" : "people have"} no threshold set`}>
              <p>
                Until you set one they are paid as regular faculty, in full.
                {d.old_rule_count > 0
                  ? ` ${d.old_rule_count} of them still carry the old papers-a-year rule. Please set a rupee threshold.`
                  : ""}
              </p>
            </Callout>
          )}

          <div className="flex flex-wrap items-center gap-3">
            <div className="relative min-w-0 flex-1 basis-56 sm:max-w-xs">
              <Search aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-fg-subtle" />
              <Input
                aria-label="Find a person or department"
                placeholder="Find a person or department"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                className="pl-8"
              />
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={onlyUnset}
                onChange={(e) => setOnlyUnset(e.target.checked)}
                className="size-4 accent-[var(--color-accent)]"
              />
              Only those with no threshold
            </label>
          </div>

          {list.isLoading ? (
            <SkeletonRows rows={5} />
          ) : rows.length === 0 ? (
            <EmptyState
              illustration="spot-people"
              title={d && d.count === 0 ? "No research faculty yet" : "Nobody matches"}
              message={
                d && d.count === 0
                  ? "Mark someone as research faculty on their People page."
                  : "Try a different name, or clear the filter."
              }
            />
          ) : (
            <ul className="divide-y divide-line rounded-lg bg-surface ring-1 ring-line" data-testid="research-faculty-list">
              {rows.map((r) => (
                <li
                  key={r.user_id}
                  className="grid grid-cols-[minmax(0,1fr)] gap-x-6 gap-y-3 px-4 py-4 md:grid-cols-[minmax(0,1.3fr)_minmax(0,1.5fr)_minmax(0,1.6fr)_auto] md:items-center"
                >
                  <div className="flex min-w-0 items-center gap-3">
                    <Avatar person={r} />
                    <div className="min-w-0">
                      <Link to={`/faculty/${r.user_id}`} className="block truncate font-medium hover:underline">
                        {r.name}
                      </Link>
                      <Meta className="block truncate">
                        {[r.department, r.designation].filter(Boolean).join(", ") || "No department"}
                      </Meta>
                    </div>
                  </div>

                  <div className="min-w-0">
                    <p className="text-xs text-fg-muted">Threshold a year</p>
                    {r.unset ? (
                      <div className="flex flex-wrap items-center gap-2">
                        <Chip tone="caution">Not set</Chip>
                        {r.needs_rupee_threshold && (
                          <span className="text-xs text-fg-muted">
                            Old rule: {r.old_quota} {r.old_quota === 1 ? "paper" : "papers"} a year. Please set a rupee threshold.
                          </span>
                        )}
                      </div>
                    ) : (
                      <p className="figure text-lg">{money(r.threshold)}</p>
                    )}
                    {r.set_at && (
                      <Meta className="mt-0.5 block">
                        {r.set_by ? `Set by ${r.set_by}` : "Set"} on {longDate(r.set_at)}
                        {r.note ? `. ${r.note}` : ""}
                      </Meta>
                    )}
                  </div>

                  <div className="min-w-0">
                    {r.unset || r.threshold == null ? null : (
                      <>
                        <div className="flex flex-wrap items-baseline justify-between gap-x-4 text-sm">
                          <span>
                            <span className="figure">{money(r.used)}</span> <span className="text-fg-muted">used in {r.year}, approved or paid</span>
                          </span>
                          <span>
                            <span className="figure">{money(r.left)}</span> <span className="text-fg-muted">left</span>
                          </span>
                        </div>
                        <ThresholdMeter used={r.used} threshold={r.threshold} onTheWay={r.on_the_way} className="mt-1.5" />
                        {(r.on_the_way > 0 || r.on_the_way_above > 0) && (
                          <Meta className="mt-1 block">
                            On the way, not used yet: would use {money(r.on_the_way)}
                            {r.on_the_way_above > 0 ? `; ${money(r.on_the_way_above)} above it would be paid` : ""}.
                          </Meta>
                        )}
                      </>
                    )}
                  </div>

                  <div className="md:justify-self-end">
                    <Button size="sm" onClick={() => setEditing({ id: r.user_id, name: r.name })}>
                      <Pencil aria-hidden />
                      {r.unset ? "Set threshold" : "Change threshold"}
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      {editing && (
        <ThresholdDialog
          userId={editing.id}
          name={editing.name}
          open
          onOpenChange={(o) => !o && setEditing(null)}
        />
      )}
    </div>
  )
}

/* ------------------------------------------------------------------------ */
/* Set or change one person's threshold                                      */
/* ------------------------------------------------------------------------ */

export function ThresholdDialog({
  userId,
  name,
  open,
  onOpenChange,
}: {
  userId: string
  name: string
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const detail = useApi<ThresholdSummary>(["research-faculty", userId], `/api/research-faculty/${userId}/threshold`, {
    enabled: open,
  })
  const s = detail.data
  const [amount, setAmount] = useState<string | null>(null)
  const [from, setFrom] = useState(toIso(new Date()))
  const [note, setNote] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const value = amount ?? (s?.threshold != null ? String(s.threshold) : "")
  const n = value.trim() === "" ? null : Number(value)
  const invalid = n !== null && (!Number.isFinite(n) || n < 0)

  async function save(clear: boolean) {
    setBusy(true)
    setError(null)
    try {
      await api(`/api/research-faculty/${userId}/threshold`, {
        method: "PUT",
        json: { amount: clear ? null : n, effective_from: from || undefined, note: note.trim() || undefined },
      })
      toast.ok(clear ? `Threshold cleared for ${name}` : `Threshold set to ${money(n)} for ${name}`)
      void queryClient.invalidateQueries({ queryKey: ["research-faculty"] })
      void queryClient.invalidateQueries({ queryKey: ["people"] })
      void queryClient.invalidateQueries({ queryKey: ["person"] })
      onOpenChange(false)
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not save. Try again.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>Research threshold for {name}</DialogTitle>
          <DialogDescription className="sr-only">Set a yearly rupee threshold.</DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          {detail.isLoading ? (
            <SkeletonRows rows={3} />
          ) : (
            <>
              {s?.research && !s.unset && s.threshold != null && (
                <p className="text-sm text-fg-muted">
                  Now {money(s.threshold)} a year. {money(s.used)} used in {s.year}, {money(s.left)} left.
                </p>
              )}
              {s?.research && s.unset && s.needs_rupee_threshold && (
                <Callout tone="caution" title="Old rule">
                  This person still carries the old rule of {s.old_quota} {s.old_quota === 1 ? "paper" : "papers"} a year, which no longer decides anything. Please set a rupee threshold.
                </Callout>
              )}
              <Field label="Threshold a year" hint={n != null && !invalid ? `${money(n)} a year` : "Leave empty to clear it. They are then paid as regular faculty."} error={invalid ? "A rupee amount, not below zero." : undefined}>
                <NumberInput
                  value={value}
                  onChange={(e) => setAmount(e.target.value)}
                  min={0}
                  step={10000}
                  unit="₹"
                />
              </Field>
              <Details label="how the threshold works">
                <p className="text-sm text-fg-muted">
                  Each year&apos;s incentives count against this amount, in the order claims are paid. A claim wholly
                  inside it pays nothing, the claim that crosses it pays only the part above, and later claims are
                  paid in full.
                </p>
              </Details>
              <Field label="Takes effect from" hint="Money already paid is never changed.">
                <DateInput value={from} onChange={(e) => setFrom(e.target.value)} />
              </Field>
              <Field label="Note" hint="Shown to the person.">
                <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Agreed at appointment, 2026-27" />
              </Field>
              {error && (
                <p role="alert" className="text-sm text-critical">
                  {error}
                </p>
              )}
              <History rows={s?.history ?? []} />
            </>
          )}
        </DialogBody>
        <DialogFooter>
          <Button kind="quiet" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          {s?.research && !s.unset && (
            <Button kind="quiet" onClick={() => void save(true)} disabled={busy}>
              Clear threshold
            </Button>
          )}
          <Button kind="primary" onClick={() => void save(false)} disabled={busy || invalid || n === null}>
            {busy ? "Saving…" : "Save threshold"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function History({ rows }: { rows: ThresholdHistory[] }) {
  if (rows.length === 0) return null
  return (
    <div>
      <p className="text-xs font-medium text-fg-muted">Earlier decisions</p>
      <ul className="mt-1.5 space-y-1 text-sm">
        {rows.slice(0, 8).map((h, i) => (
          <li key={h.id ?? i} className={cn("flex flex-wrap gap-x-2", i === 0 && "text-fg")}>
            <span className="figure">{h.amount == null ? "Cleared" : money(h.amount)}</span>
            <span className="text-fg-muted">
              from {longDate(h.effective_from)}
              {h.set_by ? `, set by ${h.set_by}` : ""}
              {h.note ? `. ${h.note}` : ""}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

/* ------------------------------------------------------------------------ */
/* For a person's own admin page                                             */
/* ------------------------------------------------------------------------ */

/**
 * The threshold on a person's page, for whoever may set it: the amount, what
 * is used and left, and a button to change it. Rendered by the person page
 * and the People account editor so the rule is stated once.
 */
export function ResearchThresholdPanel({ userId, name }: { userId: string; name: string }) {
  const q = useApi<ThresholdSummary>(["research-faculty", userId], `/api/research-faculty/${userId}/threshold`)
  const [open, setOpen] = useState(false)
  const s = q.data
  if (q.isLoading || !s?.research) return null
  return (
    <div className="space-y-2" data-testid="threshold-panel">
      {s.unset ? (
        <Callout tone="caution" title="Threshold not set">
          Until one is set, {name} is paid as regular faculty and every incentive is paid in full.
          {s.needs_rupee_threshold ? ` They still carry the old rule of ${s.old_quota} papers a year, which decides nothing now.` : ""}
        </Callout>
      ) : (
        <div className="text-sm">
          <p>
            <span className="figure text-lg">{money(s.threshold)}</span> <span className="text-fg-muted">a year</span>
          </p>
          <p className="text-fg-muted">
            {money(s.used)} used in {s.year}, {money(s.left)} left before incentives are paid.
            {(s.on_the_way ?? 0) > 0 || (s.on_the_way_above ?? 0) > 0
              ? ` On the way, not used yet: would use ${money(s.on_the_way)}${
                  (s.on_the_way_above ?? 0) > 0 ? `; ${money(s.on_the_way_above)} above it would be paid` : ""
                }.`
              : ""}
          </p>
          {s.threshold != null && (
            <ThresholdMeter used={s.used ?? 0} threshold={s.threshold} onTheWay={s.on_the_way ?? 0} className="mt-2 max-w-sm" />
          )}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <Button size="sm" onClick={() => setOpen(true)}>
          <Pencil aria-hidden />
          {s.unset ? "Set threshold" : "Change threshold"}
        </Button>
        <Button kind="quiet" size="sm" asChild>
          <Link to="/research-faculty">All research faculty</Link>
        </Button>
      </div>
      {open && <ThresholdDialog userId={userId} name={name} open onOpenChange={setOpen} />}
    </div>
  )
}
