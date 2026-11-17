import { useEffect, useState } from "react"
import { Copy } from "lucide-react"

import { Button } from "@/ui/button"
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/ui/dialog"
import { Field, Input, Radio, Select, Textarea } from "@/ui/field"
import { Callout, InlineError } from "@/ui/state"
import { toast } from "@/ui/toast"
import { useFeed, useSchedule } from "./data"
import {
  describeSchedule,
  FILE_FORMATS,
  hourLabel,
  ordinal,
  VISIBILITY,
  WEEKDAYS,
  type SavedReport,
  type Schedule,
  type Visibility,
} from "./model"
import { PeoplePicker, type Person } from "./people-picker"

/* ------------------------------------------------------------------------ */
/* Save                                                                      */
/* ------------------------------------------------------------------------ */

export type SaveFields = { name: string; description: string; visibility: Visibility }

/**
 * Name a report and say who may open it. The same dialog serves "Save" (a
 * report that is new) and "Save as" (a copy under a new name).
 */
export function SaveDialog({
  open,
  onOpenChange,
  title,
  note,
  initial,
  onSave,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  /** A sentence above the form, for why the dialog opened. */
  note?: string
  initial: SaveFields
  onSave: (fields: SaveFields) => Promise<unknown>
}) {
  const [fields, setFields] = useState<SaveFields>(initial)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // Every opening starts from what the report is now, not from the last try.
  useEffect(() => {
    if (open) {
      setFields(initial)
      setError(null)
      setBusy(false)
    }
    // `initial` is read once per opening on purpose.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!fields.name.trim()) {
      setError("Give the report a name so you can find it again.")
      return
    }
    setBusy(true)
    setError(null)
    try {
      await onSave({ ...fields, name: fields.name.trim(), description: fields.description.trim() })
      onOpenChange(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : "The report could not be saved. Please try again.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="md">
        <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{note ?? "Saved reports are kept under My reports, so you can open them again."}</DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-4">
            <Field label="Name of the report">
              <Input value={fields.name} onChange={(e) => setFields({ ...fields, name: e.target.value })} autoFocus />
            </Field>
            <Field label="What it is for (optional)">
              <Textarea value={fields.description} onChange={(e) => setFields({ ...fields, description: e.target.value })} />
            </Field>
            <div role="radiogroup" aria-label="Who can open this report" className="space-y-2">
              <p className="text-sm font-medium text-fg">Who can open this report</p>
              {VISIBILITY.map((v) => (
                <Radio
                  key={v.key}
                  name="report-visibility"
                  label={v.label}
                  hint={v.hint}
                  checked={fields.visibility === v.key}
                  onChange={() => setFields({ ...fields, visibility: v.key })}
                />
              ))}
            </div>
            {error && <InlineError message={error} />}
          </DialogBody>
          <DialogFooter>
            <Button type="button" kind="quiet" onClick={() => onOpenChange(false)} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" kind="primary" loading={busy}>
              Save report
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/* ------------------------------------------------------------------------ */
/* Schedule                                                                  */
/* ------------------------------------------------------------------------ */

const HOURS = Array.from({ length: 24 }, (_, h) => h)
const MONTH_DAYS = Array.from({ length: 28 }, (_, i) => i + 1)

/**
 * Send the report by email, again and again: every week or every month, on a
 * day and at an hour, as a file, to whoever should have it. Days of the month
 * stop at the 28th so every month has one.
 */
export function ScheduleDialog({
  open,
  onOpenChange,
  report,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  report: SavedReport
}) {
  const { set, stop } = useSchedule(report.id)
  const start: Schedule = report.schedule ?? { frequency: "weekly", day: 0, hour: 8, format: "xlsx", recipients: [] }
  const [form, setForm] = useState<Schedule>(start)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (open) {
      setForm(report.schedule ?? { frequency: "weekly", day: 0, hour: 8, format: "xlsx", recipients: [] })
      setError(null)
    }
    // Read once per opening.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  function changeFrequency(frequency: Schedule["frequency"]) {
    setForm({ ...form, frequency, day: frequency === "weekly" ? 0 : 1 })
  }

  async function save() {
    setError(null)
    try {
      await set.mutateAsync({
        frequency: form.frequency,
        day: form.day,
        hour: form.hour,
        format: form.format,
        recipients: form.recipients.map((p) => p.id),
      })
      toast.ok(`Scheduled. ${describeSchedule(form)}.`)
      onOpenChange(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : "The schedule could not be saved.")
    }
  }

  async function turnOff() {
    setError(null)
    try {
      await stop.mutateAsync()
      toast.ok("The schedule is off. Nothing more will be sent.")
      onOpenChange(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : "The schedule could not be turned off.")
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>Send this report on a schedule</DialogTitle>
          <DialogDescription>The report is made fresh each time and sent as a file to the people you choose.</DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          <Field label="How often">
            <Select value={form.frequency} onChange={(e) => changeFrequency(e.target.value === "monthly" ? "monthly" : "weekly")}>
              <option value="weekly">Every week</option>
              <option value="monthly">Every month</option>
            </Select>
          </Field>
          {form.frequency === "weekly" ? (
            <Field label="On which day">
              <Select value={form.day} onChange={(e) => setForm({ ...form, day: Number(e.target.value) })}>
                {WEEKDAYS.map((d, i) => (
                  <option key={d} value={i}>
                    {d}
                  </option>
                ))}
              </Select>
            </Field>
          ) : (
            <Field label="On which day of the month">
              <Select value={form.day} onChange={(e) => setForm({ ...form, day: Number(e.target.value) })}>
                {MONTH_DAYS.map((d) => (
                  <option key={d} value={d}>
                    The {ordinal(d)}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          <Field label="At what time">
            <Select value={form.hour} onChange={(e) => setForm({ ...form, hour: Number(e.target.value) })}>
              {HOURS.map((h) => (
                <option key={h} value={h}>
                  {hourLabel(h)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Send it as">
            <Select value={form.format} onChange={(e) => setForm({ ...form, format: e.target.value as Schedule["format"] })}>
              {FILE_FORMATS.map((f) => (
                <option key={f.key} value={f.key}>
                  {f.label}
                </option>
              ))}
            </Select>
          </Field>
          <div className="space-y-1.5">
            <label htmlFor="schedule-people" className="block text-sm font-medium text-fg">
              Who should get it
            </label>
            <PeoplePicker id="schedule-people" chosen={form.recipients} onChange={(recipients: Person[]) => setForm({ ...form, recipients })} />
          </div>
          {error && <InlineError message={error} />}
        </DialogBody>
        <DialogFooter>
          {report.schedule && (
            <Button type="button" kind="quiet" onClick={() => void turnOff()} loading={stop.isPending} className="mr-auto">
              Stop sending
            </Button>
          )}
          <Button type="button" kind="quiet" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" kind="primary" onClick={() => void save()} loading={set.isPending} disabled={form.recipients.length === 0}>
            Save the schedule
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/* ------------------------------------------------------------------------ */
/* Live link                                                                 */
/* ------------------------------------------------------------------------ */

/**
 * A web address that always gives the latest figures, for Excel or Google
 * Sheets to read. Whoever has the address can read the report, so the dialog
 * says so and has a button that turns the address off for good.
 */
export function LiveLinkDialog({
  open,
  onOpenChange,
  report,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  report: SavedReport
}) {
  const { make, revoke } = useFeed(report.id)
  const [url, setUrl] = useState<string | null>(report.feed_url)
  const [sure, setSure] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (open) {
      setUrl(report.feed_url)
      setSure(false)
      setError(null)
    }
    // Read once per opening.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  async function create() {
    setError(null)
    try {
      setUrl(await make.mutateAsync())
    } catch (err) {
      setError(err instanceof Error ? err.message : "The link could not be made.")
    }
  }

  async function turnOff() {
    setError(null)
    try {
      await revoke.mutateAsync()
      setUrl(null)
      setSure(false)
      toast.ok("The link is turned off. It no longer gives any figures.")
    } catch (err) {
      setError(err instanceof Error ? err.message : "The link could not be turned off.")
    }
  }

  async function copy() {
    if (!url) return
    try {
      await navigator.clipboard.writeText(url)
      toast.ok("Link copied")
    } catch {
      toast.fail(null, "Could not copy. Select the link and copy it by hand.")
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>Get a live link for Excel or Google Sheets</DialogTitle>
          <DialogDescription>Your spreadsheet reads this link and shows the latest figures each time it refreshes.</DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          {!url ? (
            <p className="text-base">There is no link for this report yet.</p>
          ) : (
            <>
              <Field label="Your link">
                <Input readOnly value={url} onFocus={(e) => e.currentTarget.select()} />
              </Field>
              <Button type="button" kind="primary" onClick={() => void copy()}>
                <Copy />
                Copy the link
              </Button>
              <div className="space-y-3 text-base">
                <div>
                  <p className="font-semibold">In Excel</p>
                  <ol className="list-decimal space-y-1 pl-5 text-fg-muted">
                    <li>Open Excel and choose the Data tab.</li>
                    <li>Choose From Web.</li>
                    <li>Paste the link and press OK.</li>
                    <li>To get new figures later, choose Refresh All.</li>
                  </ol>
                </div>
                <div>
                  <p className="font-semibold">In Google Sheets</p>
                  <p className="text-fg-muted">Click an empty cell, type this and press Enter:</p>
                  <code className="mt-1 block break-all rounded-control bg-sunken px-3 py-2 text-sm">{`=IMPORTDATA("${url}")`}</code>
                </div>
              </div>
              <Callout tone="caution" title="Anyone who has this link can read this report">
                Share it only with people who may see these figures. If it gets to the wrong person, turn the link off.
              </Callout>
            </>
          )}
          {error && <InlineError message={error} />}
        </DialogBody>
        <DialogFooter>
          {url && !sure && (
            <Button type="button" kind="quiet" onClick={() => setSure(true)} className="mr-auto">
              Turn this link off
            </Button>
          )}
          {url && sure && (
            <div className="mr-auto flex flex-wrap items-center gap-2">
              <span className="text-base">Spreadsheets using it will stop updating.</span>
              <Button type="button" kind="danger" onClick={() => void turnOff()} loading={revoke.isPending}>
                Yes, turn it off
              </Button>
              <Button type="button" kind="quiet" onClick={() => setSure(false)}>
                Keep it
              </Button>
            </div>
          )}
          {!url && (
            <Button type="button" kind="primary" onClick={() => void create()} loading={make.isPending}>
              Make a live link
            </Button>
          )}
          <Button type="button" kind="default" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
