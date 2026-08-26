import { useEffect, useMemo, useState } from "react"
import { Link } from "react-router-dom"
import { History, Pencil } from "lucide-react"

import { can, useAuth } from "@/app/auth"
import { cn } from "@/lib/cn"
import { useApi, useApiMutation } from "@/lib/query"
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
import { Checkbox, DateInput, Field, Input, NumberInput, Textarea } from "@/ui/field"
import { money } from "@/ui/paper"
import { Callout, ErrorState, SkeletonRows } from "@/ui/state"
import { ColumnLabel, Meta, PageTitle, SectionTitle, Sub } from "@/ui/text"
import { toast } from "@/ui/toast"

/**
 * The payout policy: every rate, multiplier and threshold that decides what a
 * paper is worth.
 *
 * Two things about this screen are not layout decisions.
 *
 * **Saving does not edit the policy — it publishes a new version of it.** The
 * server deactivates the current row and creates the next one, and from that
 * instant every calculation in the college uses the new numbers. There is no
 * draft state and no preview of unsaved values, because `/api/calculate`
 * prices against whatever is *active*. So the confirmation says what it is
 * really doing, and the worked example on the page is explicitly labelled as
 * the policy that is live right now.
 *
 * **A bad save is close to unrecoverable.** Valid-but-wrong JSON in either of
 * the two JSON fields produced an active policy that raised inside the
 * calculator, and once that is the active row, every submit, clear, payment
 * and preview 500s — including the editor's own. The server validates shape
 * before it touches a row for exactly this reason; this screen mirrors that
 * validation so the reader is told at the keyboard rather than after the
 * damage.
 *
 * Who may do what is worth stating too, because the two are not the same set:
 * `can_view_reports` reads it (the office, the Principal, Finance) and
 * `can_edit_formula` writes it (**Finance and a super admin only** — not the
 * research cell).
 */

/* ------------------------------------------------------------------------ */
/* Data — read out of get_formula() in backend/core/api.py                  */
/* ------------------------------------------------------------------------ */

type Formula = {
  id?: string
  name: string
  version: number
  effective_from?: string | null
  effective_to?: string | null
  snip_multiplier: number
  snip_cap: number
  qf_q1: number
  qf_q2: number
  qf_q3: number
  qf_q4: number
  qf_no_snip: number
  qf_snip_only: number
  /** Retired. The QFA table is Q1–Q4 only; the editor never sends it back. */
  qf_others: number
  author_point_json: string
  publication_type_multipliers_json: string
  student_remuneration_zero: boolean
  qf_only_for_no_snip: boolean
  high_value_threshold: number
  fixed_journal_no_snip: number
  fixed_other_no_snip: number
  fixed_web_of_science: number
  max_authors: number
  min_sec_references: number
  notes?: string | null
}

/* ------------------------------------------------------------------------ */
/* Page                                                                      */
/* ------------------------------------------------------------------------ */

export function Policy() {
  const { me } = useAuth()
  const allowed = can(me?.role).viewReports
  // Mirrors `rbac.can_edit_formula`, which is deliberately narrower than the
  // read gate — the research cell may look at the policy and may not change
  // what the college pays.
  const mayEdit = me?.role === "FINANCE" || me?.role === "SUPER_ADMIN"

  const [editing, setEditing] = useState(false)

  const { data, isLoading, isError, error, refetch } = useApi<Formula>(
    ["admin", "formula"],
    "/api/admin/formula",
    { enabled: allowed }
  )

  if (!allowed) {
    return (
      <div className="page py-8">
        <ErrorState
          title="Not open to this account"
          message="The policy sheet is an oversight document. A claimant sees what their own paper is worth on the paper itself."
        />
      </div>
    )
  }

  return (
    <div className="page space-y-8">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <PageTitle>Policy</PageTitle>
          <Sub className="mt-1">
            What a paper is worth, and the rules that decide it. Every claim in the college is
            priced from this sheet.
          </Sub>
        </div>
        <div className="flex items-center gap-2">
          <Button kind="quiet" size="md" asChild>
            <Link to="/audit?action=FORMULA_UPDATE">
              <History />
              History
            </Link>
          </Button>
          {mayEdit && data && (
            <Button kind="primary" size="md" onClick={() => setEditing(true)}>
              <Pencil />
              Publish a new version
            </Button>
          )}
        </div>
      </header>

      {isLoading ? (
        <SkeletonRows rows={8} rowHeight={44} />
      ) : isError ? (
        <ErrorState
          title="Could not load the policy"
          message={
            error?.status === 403
              ? "Not allowed. The office, the Principal and Finance can read the policy."
              : "The server did not answer. Nothing has changed — claims are still priced from the active policy."
          }
          onRetry={error?.status === 403 ? undefined : () => refetch()}
        />
      ) : !data ? null : (
        <>
          <Header formula={data} />

          {!data.id && (
            <Callout tone="caution" title="No policy row is active">
              These are the built-in fallback rates, which is what every claim is being priced
              from right now. Publishing a version writes them down so a change is recorded
              against somebody's name rather than living in the source code.
            </Callout>
          )}

          {!mayEdit && (
            <Meta className="block">
              Read-only for this account. Finance and a super admin can publish a new version.
            </Meta>
          )}

          <Section
            title="The SNIP amount"
            blurb="A journal's SNIP, multiplied and capped. This is the main path — everything below it is what happens when a SNIP is not available."
          >
            <Row label="Multiplier" value={money(data.snip_multiplier)} hint="per point of SNIP" />
            <Row
              label="Cap"
              value={String(data.snip_cap)}
              hint={`SNIP above this counts as ${data.snip_cap} — worth at most ${money(data.snip_multiplier * data.snip_cap)}`}
            />
          </Section>

          <Section
            title="The quartile amounts"
            blurb={
              data.qf_only_for_no_snip
                ? "Used only when no SNIP is held for the journal — a paper with a SNIP is priced from it, not from its quartile."
                : "Added to the SNIP amount, not only used in its place. That is unusual — check it is meant."
            }
          >
            <Row label="Q1" value={money(data.qf_q1)} />
            <Row label="Q2" value={money(data.qf_q2)} />
            <Row label="Q3" value={money(data.qf_q3)} />
            <Row label="Q4" value={money(data.qf_q4)} />
            {data.qf_others > 0 && (
              <Row
                label="Others"
                value={money(data.qf_others)}
                hint="Retired — the QFA table is Q1 to Q4. Publishing a new version clears it."
                tone="caution"
              />
            )}
          </Section>

          <Section
            title="Fixed amounts"
            blurb="Where neither a SNIP nor a quartile is held, the paper still pays these."
          >
            <Row label="Journal, no SNIP" value={money(data.fixed_journal_no_snip)} />
            <Row label="Other, no SNIP" value={money(data.fixed_other_no_snip)} />
            <Row label="Web of Science" value={money(data.fixed_web_of_science)} />
          </Section>

          <Section title="Rules" blurb="Who is eligible, and what needs a second signature.">
            <Row
              label="High-value threshold"
              value={data.high_value_threshold > 0 ? money(data.high_value_threshold) : "Off"}
              hint={
                data.high_value_threshold > 0
                  ? "Above this, a claim needs a second, different signature before Finance can pay it"
                  : "No claim is held for a second signature"
              }
              tone={data.high_value_threshold > 0 ? undefined : "caution"}
            />
            <Row
              label="Eligible authors"
              value={String(data.max_authors)}
              hint="Papers with more authors than this pay nothing"
            />
            <Row
              label="Minimum SEC authors"
              value={String(data.min_sec_references)}
              hint="How many authors must be from this college"
            />
            <Row
              label="Students paid"
              value={data.student_remuneration_zero ? "No" : "Yes"}
              hint={
                data.student_remuneration_zero
                  ? "A student author's share is zero"
                  : "Students are paid the same as staff"
              }
            />
          </Section>

          <JsonSection
            title="Author points"
            blurb="How one paper's amount is split between its authors, keyed by how many there are. A single number gives every author that share; a list gives each position its own."
            json={data.author_point_json}
          />

          <JsonSection
            title="Publication type multipliers"
            blurb="Applied after everything above. A conference paper worth half a journal paper is a 0.5 here."
            json={data.publication_type_multipliers_json}
          />

          {data.notes && (
            <section className="space-y-2">
              <SectionTitle>Notes</SectionTitle>
              <p className="max-w-3xl whitespace-pre-wrap text-base text-fg-muted">{data.notes}</p>
            </section>
          )}

          {mayEdit && (
            <EditDialog open={editing} onOpenChange={setEditing} current={data} />
          )}
        </>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------------ */
/* Display                                                                   */
/* ------------------------------------------------------------------------ */

function Header({ formula }: { formula: Formula }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-8 gap-y-2 border-y border-line py-3">
      <div>
        <ColumnLabel className="block">Active policy</ColumnLabel>
        <p className="mt-0.5 text-lg font-semibold">
          {formula.name} <span className="text-fg-muted">v{formula.version}</span>
        </p>
      </div>
      <Meta>
        {formula.effective_from ? `In effect from ${formatDay(formula.effective_from)}` : "No start date recorded"}
        {formula.effective_to ? ` until ${formatDay(formula.effective_to)}` : ""}
      </Meta>
    </div>
  )
}

function Section({
  title,
  blurb,
  children,
}: {
  title: string
  blurb: string
  children: React.ReactNode
}) {
  return (
    <section className="space-y-3">
      <div>
        <SectionTitle>{title}</SectionTitle>
        <p className="mt-0.5 max-w-3xl text-base text-fg-muted">{blurb}</p>
      </div>
      <dl className="divide-y divide-line border-y border-line">{children}</dl>
    </section>
  )
}

function Row({
  label,
  value,
  hint,
  tone,
}: {
  label: string
  value: string
  hint?: string
  tone?: "caution"
}) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 py-2.5">
      <dt className="text-base">
        {label}
        {hint && <Meta className="mt-0.5 block max-w-xl">{hint}</Meta>}
      </dt>
      <dd className={cn("shrink-0 text-base font-medium tabular", tone === "caution" && "text-caution")}>
        {value}
      </dd>
    </div>
  )
}

/**
 * A JSON field, shown as the table it actually is.
 *
 * The stored form is a JSON string and the editor edits it as one, but nobody
 * reading the policy should have to parse `{"2": [0.7, 0.3]}` in their head to
 * find out that the first of two authors gets 70%. If it will not parse, that
 * is said outright rather than rendered as an empty table — an unparseable
 * policy field is the exact condition that breaks every calculation in the
 * college, so it is not something to show as "no rules".
 */
function JsonSection({ title, blurb, json }: { title: string; blurb: string; json: string }) {
  const parsed = useMemo(() => parseObject(json), [json])

  return (
    <section className="space-y-3">
      <div>
        <SectionTitle>{title}</SectionTitle>
        <p className="mt-0.5 max-w-3xl text-base text-fg-muted">{blurb}</p>
      </div>
      {parsed === null ? (
        <Callout tone="critical" title="This field does not parse">
          The stored value is not a JSON object, so the calculator cannot read it. Every
          calculation in the college depends on it — publish a corrected version.
        </Callout>
      ) : (
        <dl className="divide-y divide-line border-y border-line">
          {Object.entries(parsed).map(([key, value]) => (
            <div key={key} className="flex flex-wrap items-baseline justify-between gap-x-6 py-2.5">
              <dt className="text-base">{describeKey(key, title)}</dt>
              <dd className="shrink-0 text-base tabular">{describeValue(value)}</dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  )
}

function describeKey(key: string, title: string): string {
  if (!title.startsWith("Author")) return key
  if (key === "default") return "Any other number of authors"
  return `${key} ${key === "1" ? "author" : "authors"}`
}

function describeValue(value: unknown): string {
  if (Array.isArray(value)) {
    return value.map((v) => (typeof v === "number" ? formatShare(v) : String(v))).join(" · ")
  }
  if (typeof value === "number") return formatShare(value)
  return String(value)
}

/** 0.7 reads as a share; 1 reads as a multiplier. Both appear in these two
 *  fields, so neither is forced into the other's clothing. */
function formatShare(value: number): string {
  if (value > 0 && value <= 1) return `${Math.round(value * 1000) / 10}%`
  return String(value)
}

/* ------------------------------------------------------------------------ */
/* Editing — which is publishing                                            */
/* ------------------------------------------------------------------------ */

type FormState = {
  name: string
  effective_from: string
  effective_to: string
  snip_multiplier: string
  snip_cap: string
  qf_q1: string
  qf_q2: string
  qf_q3: string
  qf_q4: string
  high_value_threshold: string
  fixed_journal_no_snip: string
  fixed_other_no_snip: string
  fixed_web_of_science: string
  max_authors: string
  min_sec_references: string
  author_point_json: string
  publication_type_multipliers_json: string
  student_remuneration_zero: boolean
  qf_only_for_no_snip: boolean
  notes: string
}

function EditDialog({
  open,
  onOpenChange,
  current,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  current: Formula
}) {
  const [form, setForm] = useState<FormState>(() => stateFrom(current))
  const [confirming, setConfirming] = useState(false)

  useEffect(() => {
    if (open) {
      setForm(stateFrom(current))
      setConfirming(false)
    }
  }, [open, current])

  const save = useApiMutation<Record<string, unknown>, { version: number; name: string }>(
    "/api/admin/formula",
    { method: "PUT", invalidates: [["admin", "formula"]] }
  )

  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }))
  }

  // The same shape checks the server runs, run here so a mistake is caught
  // at the keyboard. The server is still the authority; this only means the
  // reader is not told about it by a 400 after pressing publish.
  const authorPointsError = validateAuthorPoints(form.author_point_json)
  const multipliersError = validateMultipliers(form.publication_type_multipliers_json)
  const capError =
    Number.parseFloat(form.snip_cap) > 0 ? undefined : "Must be greater than zero."
  const datesError =
    form.effective_from && form.effective_to && form.effective_to < form.effective_from
      ? "The end date is before the start date."
      : undefined

  const blocked = Boolean(authorPointsError || multipliersError || capError || datesError)

  async function publish() {
    try {
      const result = await save.mutateAsync({
        name: form.name.trim() || `Policy v${current.version + 1}`,
        effective_from: form.effective_from || undefined,
        effective_to: form.effective_to || undefined,
        snip_multiplier: num(form.snip_multiplier),
        snip_cap: num(form.snip_cap),
        qf_q1: num(form.qf_q1),
        qf_q2: num(form.qf_q2),
        qf_q3: num(form.qf_q3),
        qf_q4: num(form.qf_q4),
        qf_no_snip: current.qf_no_snip,
        qf_snip_only: current.qf_snip_only,
        // Retired deliberately: sending the stored value back would write
        // the withdrawn incentive into every future version.
        qf_others: 0,
        author_point_json: form.author_point_json,
        publication_type_multipliers_json: form.publication_type_multipliers_json,
        student_remuneration_zero: form.student_remuneration_zero,
        qf_only_for_no_snip: form.qf_only_for_no_snip,
        high_value_threshold: num(form.high_value_threshold),
        fixed_journal_no_snip: num(form.fixed_journal_no_snip),
        fixed_other_no_snip: num(form.fixed_other_no_snip),
        fixed_web_of_science: num(form.fixed_web_of_science),
        max_authors: Math.round(num(form.max_authors)),
        min_sec_references: Math.round(num(form.min_sec_references)),
        notes: form.notes.trim() || undefined,
      })
      toast.ok(`Published — ${result.name} v${result.version} now prices every claim`)
      onOpenChange(false)
    } catch (err) {
      toast.fail(err)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>Publish a new policy version</DialogTitle>
          <DialogDescription>
            This does not edit v{current.version}. It retires it and makes v{current.version + 1}
            {" "}the active policy, from the moment you publish.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-6">
          <Callout tone="caution" title="Everything is priced from this the instant it saves">
            Claims already paid keep the amount they were paid. Everything not yet paid —
            including anything sitting in the clearing queue or waiting on the Principal — is
            recalculated from these numbers when it next moves.
          </Callout>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Name">
              <Input value={form.name} onChange={(e) => set("name", e.target.value)} />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="In effect from">
                <DateInput
                  value={form.effective_from}
                  onChange={(e) => set("effective_from", e.target.value)}
                />
              </Field>
              <Field label="Until" error={datesError}>
                <DateInput
                  value={form.effective_to}
                  onChange={(e) => set("effective_to", e.target.value)}
                />
              </Field>
            </div>
          </div>

          <Fieldset legend="The SNIP amount">
            <Money label="Multiplier" value={form.snip_multiplier} onChange={(v) => set("snip_multiplier", v)} />
            <Field label="Cap" error={capError}>
              <NumberInput
                value={form.snip_cap}
                onChange={(e) => set("snip_cap", e.target.value)}
                min={0}
                step="0.5"
              />
            </Field>
          </Fieldset>

          <Fieldset legend="The quartile amounts">
            <Money label="Q1" value={form.qf_q1} onChange={(v) => set("qf_q1", v)} />
            <Money label="Q2" value={form.qf_q2} onChange={(v) => set("qf_q2", v)} />
            <Money label="Q3" value={form.qf_q3} onChange={(v) => set("qf_q3", v)} />
            <Money label="Q4" value={form.qf_q4} onChange={(v) => set("qf_q4", v)} />
          </Fieldset>

          <Fieldset legend="Fixed amounts">
            <Money
              label="Journal, no SNIP"
              value={form.fixed_journal_no_snip}
              onChange={(v) => set("fixed_journal_no_snip", v)}
            />
            <Money
              label="Other, no SNIP"
              value={form.fixed_other_no_snip}
              onChange={(v) => set("fixed_other_no_snip", v)}
            />
            <Money
              label="Web of Science"
              value={form.fixed_web_of_science}
              onChange={(v) => set("fixed_web_of_science", v)}
            />
          </Fieldset>

          <Fieldset legend="Rules">
            <Money
              label="High-value threshold"
              value={form.high_value_threshold}
              onChange={(v) => set("high_value_threshold", v)}
              hint="Zero switches the second signature off entirely"
            />
            <Field label="Eligible authors" hint="More authors than this and the paper pays nothing">
              <NumberInput
                value={form.max_authors}
                onChange={(e) => set("max_authors", e.target.value)}
                min={1}
                step="1"
              />
            </Field>
            <Field label="Minimum SEC authors">
              <NumberInput
                value={form.min_sec_references}
                onChange={(e) => set("min_sec_references", e.target.value)}
                min={0}
                step="1"
              />
            </Field>
          </Fieldset>

          <div className="space-y-2">
            <Checkbox
              checked={form.student_remuneration_zero}
              onCheckedChange={(v) => set("student_remuneration_zero", v === true)}
              label="A student author's share is zero"
            />
            <Checkbox
              checked={form.qf_only_for_no_snip}
              onCheckedChange={(v) => set("qf_only_for_no_snip", v === true)}
              label="Quartile amounts apply only when no SNIP is held"
            />
          </div>

          <Field
            label="Author points"
            hint='Keyed by author count. A number is every author&apos;s share; a list gives each position its own. e.g. {"1": 1, "2": [0.7, 0.3], "default": 0.2}'
            error={authorPointsError}
          >
            <Textarea
              value={form.author_point_json}
              onChange={(e) => set("author_point_json", e.target.value)}
              rows={4}
              className="font-mono text-sm"
            />
          </Field>

          <Field
            label="Publication type multipliers"
            hint='An object of type to multiplier. e.g. {"Journal": 1, "Conference Proceeding": 1}'
            error={multipliersError}
          >
            <Textarea
              value={form.publication_type_multipliers_json}
              onChange={(e) => set("publication_type_multipliers_json", e.target.value)}
              rows={3}
              className="font-mono text-sm"
            />
          </Field>

          <Field label="Notes" hint="What changed and why. Whoever reads the audit entry sees this.">
            <Textarea value={form.notes} onChange={(e) => set("notes", e.target.value)} rows={3} />
          </Field>
        </DialogBody>
        <DialogFooter>
          <Button kind="quiet" onClick={() => onOpenChange(false)} disabled={save.isPending}>
            Cancel
          </Button>
          {confirming ? (
            <Button kind="danger" disabled={blocked || save.isPending} onClick={() => void publish()}>
              {save.isPending ? "Publishing…" : `Yes — make v${current.version + 1} active`}
            </Button>
          ) : (
            // A second press, in the same place, but with the consequence
            // written on the button. There is no undo behind this one.
            <Button kind="primary" disabled={blocked} onClick={() => setConfirming(true)}>
              Publish
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function Fieldset({ legend, children }: { legend: string; children: React.ReactNode }) {
  return (
    <fieldset className="space-y-3">
      <legend className="mb-2 text-sm font-medium">{legend}</legend>
      <div className="grid gap-3 sm:grid-cols-3">{children}</div>
    </fieldset>
  )
}

function Money({
  label,
  value,
  onChange,
  hint,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  hint?: string
}) {
  return (
    <Field label={label} hint={hint}>
      <NumberInput value={value} onChange={(e) => onChange(e.target.value)} min={0} step="500" unit="₹" />
    </Field>
  )
}

/* ------------------------------------------------------------------------ */
/* Validation — the same shape checks the server runs                       */
/* ------------------------------------------------------------------------ */

function parseObject(json: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(json)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
    return parsed as Record<string, unknown>
  } catch {
    return null
  }
}

function validateAuthorPoints(json: string): string | undefined {
  const parsed = parseObject(json)
  if (parsed === null) return "Must be a JSON object."
  const entries = Object.entries(parsed)
  if (entries.length === 0) return "Cannot be empty — every paper would pay nothing."
  for (const [key, value] of entries) {
    if (key !== "default" && !/^\d+$/.test(key)) {
      return `“${key}” must be an author count, or “default”.`
    }
    if (typeof value === "number") continue
    if (
      Array.isArray(value) &&
      value.length > 0 &&
      value.every((v) => typeof v === "number")
    ) {
      continue
    }
    return `The rule for “${key}” must be a number, or a non-empty list of numbers.`
  }
  return undefined
}

function validateMultipliers(json: string): string | undefined {
  const parsed = parseObject(json)
  if (parsed === null) return "Must be a JSON object."
  const entries = Object.entries(parsed)
  if (entries.length === 0) return "Cannot be empty."
  for (const [key, value] of entries) {
    if (typeof value !== "number") return `The multiplier for “${key}” must be a number.`
  }
  return undefined
}

/* ------------------------------------------------------------------------ */
/* Helpers                                                                   */
/* ------------------------------------------------------------------------ */

function stateFrom(f: Formula): FormState {
  return {
    name: f.name || "",
    effective_from: f.effective_from || "",
    effective_to: f.effective_to || "",
    snip_multiplier: String(f.snip_multiplier),
    snip_cap: String(f.snip_cap),
    qf_q1: String(f.qf_q1),
    qf_q2: String(f.qf_q2),
    qf_q3: String(f.qf_q3),
    qf_q4: String(f.qf_q4),
    high_value_threshold: String(f.high_value_threshold),
    fixed_journal_no_snip: String(f.fixed_journal_no_snip),
    fixed_other_no_snip: String(f.fixed_other_no_snip),
    fixed_web_of_science: String(f.fixed_web_of_science),
    max_authors: String(f.max_authors),
    min_sec_references: String(f.min_sec_references),
    author_point_json: pretty(f.author_point_json),
    publication_type_multipliers_json: pretty(f.publication_type_multipliers_json),
    student_remuneration_zero: f.student_remuneration_zero,
    qf_only_for_no_snip: f.qf_only_for_no_snip,
    notes: f.notes || "",
  }
}

/** Stored on one line; edited over several, because a policy field nobody can
 *  read is a policy field nobody checks before publishing. */
function pretty(json: string): string {
  const parsed = parseObject(json)
  return parsed === null ? json : JSON.stringify(parsed, null, 2)
}

function num(value: string): number {
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function formatDay(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })
}
