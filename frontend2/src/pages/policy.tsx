import { useEffect, useId, useMemo, useState } from "react"
import { Link } from "react-router-dom"
import { History, Pencil, Plus, X } from "lucide-react"

import { can, useAuth } from "@/app/auth"
import { api } from "@/lib/api"
import { cn } from "@/lib/cn"
import { useApi, useApiMutation } from "@/lib/query"
import { Button } from "@/ui/button"
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
import {
  Checkbox,
  DateInput,
  Field,
  Input,
  NumberInput,
  Radio,
  Textarea,
} from "@/ui/field"
import { money } from "@/ui/paper"
import { Callout, ErrorState, SkeletonRows } from "@/ui/state"
import { ColumnLabel, Meta, PageTitle, SectionTitle, Sub } from "@/ui/text"
import { toast } from "@/ui/toast"

/**
 * The payout policy: every rate, multiplier and threshold that decides what a
 * paper is worth.
 *
 * Three things about this screen are not layout decisions.
 *
 * **Saving does not edit the policy — it publishes a new version of it.** The
 * server deactivates the current row and creates the next one, and from that
 * instant every calculation in the college uses the new numbers. There is no
 * draft state and no preview of unsaved values, because `/api/calculate`
 * prices against whatever is *active*. So the confirmation says what it is
 * really doing, the worked example on the page is priced by the server against
 * the live policy, and the worked example inside the editor is computed here
 * from the unsaved numbers and labelled an estimate — the server cannot price
 * a version that does not exist yet.
 *
 * **A bad save is close to unrecoverable.** Valid-but-wrong JSON in either of
 * the two JSON fields produced an active policy that raised inside the
 * calculator, and once that is the active row, every submit, clear, payment
 * and preview 500s — including the editor's own. That is why neither field is
 * typed as JSON any more: author points are edited as rows of "1st of 3 →
 * 50%", type multipliers as a name and a `×`, and the JSON is generated from
 * them. A brace cannot be left unclosed if nobody types a brace. The raw
 * strings are still what goes over the wire, unchanged, and are still shown —
 * read-only, behind a disclosure, for whoever genuinely wants to see them.
 *
 * **The publish confirmation cannot sit where the trigger sat.** Replacing the
 * footer button in place with "yes, really" trains a fast clicker to hit the
 * same pixel twice, and this write reprices every unpaid claim in the college
 * with no undo. `ConfirmDialog` moves the second press somewhere else and asks
 * for the version number to be typed.
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

/** The subset of `/api/calculate`'s answer this screen shows. */
type CalcResult = {
  base: number | null
  point: number | null
  remuneration: number | null
  qf: number | null
  error: string | null
  note: string | null
  category_label?: string | null
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

          <LiveExample formula={data} />

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

          <AuthorPointsSection json={data.author_point_json} />

          <MultipliersSection json={data.publication_type_multipliers_json} />

          {data.notes && (
            <section className="space-y-2">
              <SectionTitle>Notes</SectionTitle>
              <p className="max-w-3xl whitespace-pre-wrap text-base text-fg-muted">{data.notes}</p>
            </section>
          )}

          <RawDisclosure
            summary="Advanced — the stored JSON"
            blurb="What the two fields above look like on the wire. Read-only: the rows are the way to change them."
            blobs={[
              ["author_point_json", data.author_point_json],
              ["publication_type_multipliers_json", data.publication_type_multipliers_json],
            ]}
          />

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
 * The author-point table, written out as sentences.
 *
 * The stored form is a JSON string, and reading `{"3": [0.5, 0.3, 0.2]}` to
 * find out what the second of three authors gets is a step nobody should have
 * to take on an oversight document. If the field will not parse that is said
 * outright rather than rendered as an empty table — an unparseable policy
 * field is the exact condition that breaks every calculation in the college,
 * so it is not something to show as "no rules".
 */
function AuthorPointsSection({ json }: { json: string }) {
  const parsed = useMemo(() => parseObject(json), [json])

  return (
    <section className="space-y-3">
      <div>
        <SectionTitle>Author points</SectionTitle>
        <p className="mt-0.5 max-w-3xl text-base text-fg-muted">
          How one paper's amount is split between its authors. Each share is multiplied by the
          paper's amount to get what that one author is paid.
        </p>
      </div>
      {parsed === null ? (
        <Callout tone="critical" title="This field does not parse">
          The stored value is not a JSON object, so the calculator cannot read it. Every
          calculation in the college depends on it — publish a corrected version.
        </Callout>
      ) : (
        <dl className="divide-y divide-line border-y border-line">
          {Object.entries(parsed).map(([key, value]) => (
            <div key={key} className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 py-2.5">
              <dt className="text-base">{authorCountLabel(key)}</dt>
              <dd className="min-w-0 text-base tabular">{describeShares(key, value)}</dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  )
}

/** The type multipliers, with the `×` said out loud and what it does to a
 *  payment spelled out on the row that is not 1. */
function MultipliersSection({ json }: { json: string }) {
  const parsed = useMemo(() => parseObject(json), [json])

  return (
    <section className="space-y-3">
      <div>
        <SectionTitle>Publication type multipliers</SectionTitle>
        <p className="mt-0.5 max-w-3xl text-base text-fg-muted">
          Applied last, to the paper's whole amount. ×1 leaves the amount alone; ×0.5 halves it.
        </p>
      </div>
      {parsed === null ? (
        <Callout tone="critical" title="This field does not parse">
          The stored value is not a JSON object, so the calculator cannot read it. Every
          calculation in the college depends on it — publish a corrected version.
        </Callout>
      ) : (
        <dl className="divide-y divide-line border-y border-line">
          {Object.entries(parsed).map(([key, value]) => (
            <div key={key} className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 py-2.5">
              <dt className="text-base">
                {key}
                <Meta className="mt-0.5 block max-w-xl">{multiplierEffect(value)}</Meta>
              </dt>
              <dd className="shrink-0 text-base font-medium tabular">
                {typeof value === "number" ? `×${trim(value)}` : String(value)}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  )
}

/** The raw strings, kept reachable and kept secondary. Somebody comparing this
 *  screen against a database row or a support ticket needs the exact bytes;
 *  everybody else needs never to see a brace. */
function RawDisclosure({
  summary,
  blurb,
  blobs,
}: {
  summary: string
  blurb: string
  blobs: readonly (readonly [string, string])[]
}) {
  return (
    <details className="border-t border-line pt-3">
      <summary className="cursor-pointer text-sm text-fg-muted hover:text-fg">{summary}</summary>
      <div className="mt-3 space-y-3">
        <Meta className="block max-w-3xl">{blurb}</Meta>
        {blobs.map(([name, value]) => (
          <div key={name} className="space-y-1">
            <ColumnLabel className="block">{name}</ColumnLabel>
            <pre className="overflow-x-auto rounded-md bg-sunken px-3 py-2 font-mono text-xs text-fg-muted">
              {pretty(value)}
            </pre>
          </div>
        ))}
      </div>
    </details>
  )
}

function authorCountLabel(key: string): string {
  if (key === "default") return "Any other number of authors"
  return `${key} ${key === "1" ? "author" : "authors"}`
}

/** `[0.5, 0.3, 0.2]` under key `3` reads as "1st of 3 → 50%". A bare number
 *  reads as one sentence covering everybody, because that is what it means. */
function describeShares(key: string, value: unknown): string {
  const count = key === "default" ? "" : ` of ${key}`
  if (Array.isArray(value)) {
    return value
      .map((v, i) =>
        typeof v === "number" ? `${ordinal(i + 1)}${count} → ${formatShare(v)}` : String(v)
      )
      .join("  ·  ")
  }
  if (typeof value === "number") return `every author → ${formatShare(value)}`
  return String(value)
}

function multiplierEffect(value: unknown): string {
  if (typeof value !== "number") return "Not a number — the calculator cannot read this row."
  if (value === 1) return "Paid the full amount."
  if (value === 0) return "Pays nothing."
  if (value < 1) return `Pays ${formatShare(value)} of the amount — ${money(100000 * value)} where a full-rate paper pays ${money(100000)}.`
  return `Pays ${trim(value)} times the amount — ${money(100000 * value)} where a full-rate paper pays ${money(100000)}.`
}

/** 0.7 reads as a share; 1 reads as a multiplier. Both appear in these two
 *  fields, so neither is forced into the other's clothing. */
function formatShare(value: number): string {
  if (value > 0 && value <= 1) return `${Math.round(value * 1000) / 10}%`
  return String(value)
}

/** Always a percentage, for the editor's share boxes, where the value is a
 *  fraction by definition — `formatShare` would print a bare `0` for an empty
 *  box and read as an amount rather than as none of it. */
function percent(value: number): string {
  return `${Math.round(value * 1000) / 10}%`
}

function ordinal(n: number): string {
  const rem100 = n % 100
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`
  return `${n}${["th", "st", "nd", "rd"][n % 10] || "th"}`
}

/** Drops the trailing zeros a `<input type="number">` round-trip leaves
 *  behind, so a multiplier reads `×1` and not `×1.00`. */
function trim(value: number): string {
  return String(Math.round(value * 10000) / 10000)
}

/* ------------------------------------------------------------------------ */
/* The worked example                                                        */
/* ------------------------------------------------------------------------ */

type Example = {
  snip: string
  quartile: "" | "Q1" | "Q2" | "Q3" | "Q4"
  totalAuthors: string
  position: string
  type: string
  indexing: "Scopus" | "Web of Science"
}

const DEFAULT_EXAMPLE: Example = {
  snip: "1.85",
  quartile: "Q1",
  totalAuthors: "3",
  position: "1",
  type: "Journal",
  indexing: "Scopus",
}

/** The example opens on a type the policy actually names. A college that
 *  renamed every type would otherwise open on "Journal", which is not one of
 *  its own rows and prices at a multiplier of 1 for no stated reason. */
function startingExample(types: string[]): Example {
  if (types.includes(DEFAULT_EXAMPLE.type)) return DEFAULT_EXAMPLE
  return { ...DEFAULT_EXAMPLE, type: types[0] ?? "" }
}

/**
 * The one thing on this page that answers the question everybody actually
 * arrived with: what does this pay?
 *
 * A rate sheet is a list of inputs to an arithmetic nobody performs in their
 * head, so "₹55,000 per SNIP point" and "the second of three gets 0.3" sit
 * one beside the other on the page and still leave the reader unable to say
 * what a paper is worth. This prices a real one, and shows the working.
 */
function LiveExample({ formula }: { formula: Formula }) {
  const types = useMemo(() => typeKeys(formula.publication_type_multipliers_json), [
    formula.publication_type_multipliers_json,
  ])
  const [example, setExample] = useState<Example>(() => startingExample(types))
  const [result, setResult] = useState<CalcResult | null>(null)
  const [failed, setFailed] = useState(false)

  const config = useMemo(() => configFromFormula(formula), [formula])
  const local = useMemo(() => estimate(config, example), [config, example])

  // Debounced, because this fires on every keystroke in the SNIP box and the
  // answer for a half-typed number is not worth a round trip.
  useEffect(() => {
    const t = setTimeout(() => {
      void api<CalcResult>("/api/calculate", {
        method: "POST",
        json: {
          snip: example.snip.trim() ? num(example.snip) : undefined,
          quartile: example.quartile || undefined,
          total_authors: Math.round(num(example.totalAuthors)) || 1,
          author_position: Math.round(num(example.position)) || 1,
          publication_type: example.type || undefined,
          indexing_level: example.indexing,
        },
      })
        .then((r) => {
          setResult(r)
          setFailed(false)
        })
        .catch(() => {
          setResult(null)
          setFailed(true)
        })
    }, 350)
    return () => clearTimeout(t)
  }, [example])

  const live = failed ? null : result
  const amount = live ? live.remuneration : local.amount
  const problem = live ? live.error || undefined : local.problem

  return (
    <section className="space-y-3">
      <div>
        <SectionTitle>What this pays</SectionTitle>
        <p className="mt-0.5 max-w-3xl text-base text-fg-muted">
          {failed
            ? "Worked out on this page from the rates above, because the server did not answer. Treat it as an estimate."
            : `Priced by the server against ${formula.name} v${formula.version} — the policy that is live right now.`}
        </p>
      </div>

      <div className="space-y-4 rounded-md bg-sunken px-4 py-4">
        <ExampleControls
          value={example}
          onChange={setExample}
          types={types}
          maxAuthors={formula.max_authors}
        />
        <ExampleAnswer
          example={example}
          amount={amount}
          problem={problem}
          working={live ? reconcile(local.working, live) : local.working}
          categoryLabel={live?.category_label || local.category}
          note={live?.note || undefined}
        />
      </div>
    </section>
  )
}

/**
 * The headline and the working have to come from the same arithmetic.
 *
 * The amount on the page is the server's; the lines under it are this file's
 * mirror of the same rules. Where the two ever drift — a policy field the
 * mirror does not model, a server change this file has not caught up with —
 * the totals are taken from the server, so the working can never add up to a
 * different number than the one printed above it.
 */
function reconcile(working: WorkingLine[], live: CalcResult): WorkingLine[] {
  return working.map((line) => {
    if (line.id === "base" && live.base != null) return { ...line, value: money(live.base) }
    if (line.id === "share" && live.point != null) {
      return { ...line, value: `× ${formatShare(live.point)}` }
    }
    if (line.id === "total" && live.remuneration != null) {
      return { ...line, value: money(live.remuneration) }
    }
    return line
  })
}

/** The same controls and the same answer, priced from numbers that are not
 *  saved yet. Says so, because `/api/calculate` cannot price a version that
 *  does not exist — the server only knows the active row. */
function DraftExample({ config, types }: { config: EstimateConfig; types: string[] }) {
  const [example, setExample] = useState<Example>(() => startingExample(types))
  const result = useMemo(() => estimate(config, example), [config, example])

  return (
    <section className="space-y-2">
      <SectionTitle>What this would pay</SectionTitle>
      <p className="max-w-3xl text-sm text-fg-muted">
        An estimate, worked out here from the numbers in this form. Nothing is saved and nothing
        is priced from these figures until you publish.
      </p>
      <div className="space-y-4 rounded-md bg-sunken px-4 py-4">
        <ExampleControls
          value={example}
          onChange={setExample}
          types={types}
          maxAuthors={Math.round(config.maxAuthors)}
        />
        <ExampleAnswer
          example={example}
          amount={result.amount}
          problem={result.problem}
          working={result.working}
          categoryLabel={result.category}
        />
      </div>
    </section>
  )
}

function ExampleControls({
  value,
  onChange,
  types,
  maxAuthors,
}: {
  value: Example
  onChange: (next: Example) => void
  types: string[]
  maxAuthors: number
}) {
  const group = useId()
  const set = <K extends keyof Example>(key: K, v: Example[K]) =>
    onChange({ ...value, [key]: v })

  // A type that has just been renamed or removed in the editor above must not
  // vanish out of the select, leaving it showing somebody else's row.
  const options = value.type && !types.includes(value.type) ? [value.type, ...types] : types

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-4">
        <Field label="SNIP" hint="Blank means the journal holds none">
          <NumberInput
            value={value.snip}
            onChange={(e) => set("snip", e.target.value)}
            min={0}
            step="0.05"
          />
        </Field>
        <Field label="Authors on the paper">
          <NumberInput
            value={value.totalAuthors}
            onChange={(e) => set("totalAuthors", e.target.value)}
            min={1}
            max={Math.max(1, maxAuthors)}
            step="1"
          />
        </Field>
        <Field label="You are author number">
          <NumberInput
            value={value.position}
            onChange={(e) => set("position", e.target.value)}
            min={1}
            step="1"
          />
        </Field>
        <Field label="Publication type">
          <select
            value={value.type}
            onChange={(e) => set("type", e.target.value)}
            className={cn(
              "h-8 w-full rounded-md bg-surface px-2.5 text-sm text-fg outline-none",
              "ring-1 ring-inset ring-field focus-visible:ring-2 focus-visible:ring-accent"
            )}
          >
            {options.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <fieldset>
          <legend className="mb-1.5 text-sm font-medium">Quartile</legend>
          <div className="flex flex-wrap gap-x-5 gap-y-2">
            {(["Q1", "Q2", "Q3", "Q4", ""] as const).map((q) => (
              <Radio
                key={q || "none"}
                name={`${group}-q`}
                value={q}
                checked={value.quartile === q}
                onChange={() => set("quartile", q)}
                label={q || "None held"}
              />
            ))}
          </div>
        </fieldset>

        <fieldset>
          <legend className="mb-1.5 text-sm font-medium">Indexed in</legend>
          <div className="flex flex-wrap gap-x-5 gap-y-2">
            {(["Scopus", "Web of Science"] as const).map((i) => (
              <Radio
                key={i}
                name={`${group}-i`}
                value={i}
                checked={value.indexing === i}
                onChange={() => set("indexing", i)}
                label={i}
              />
            ))}
          </div>
        </fieldset>
      </div>
    </div>
  )
}

/**
 * The sentence and the arithmetic under it.
 *
 * The amount alone invites "that cannot be right" and gives nobody a way to
 * check; the working lets a reader find the line they disagree with, which is
 * the whole point of showing an example on a rate sheet.
 */
function ExampleAnswer({
  example,
  amount,
  problem,
  working,
  categoryLabel,
  note,
}: {
  example: Example
  amount: number | null
  problem?: string
  working: WorkingLine[]
  categoryLabel?: string | null
  note?: string
}) {
  const total = Math.round(num(example.totalAuthors)) || 1
  const position = Math.round(num(example.position)) || 1
  const sentence = [
    `A ${example.quartile || "no-quartile"} ${example.type || "paper"} in ${example.indexing}`,
    example.snip.trim() ? `SNIP ${example.snip.trim()}` : "no SNIP",
    `${total} ${total === 1 ? "author" : "authors"}`,
    `you are ${ordinal(position)}`,
  ].join(", ")

  return (
    <div className="space-y-3 border-t border-line pt-3">
      <p className="text-base">
        <span className="text-fg-muted">{sentence} → </span>
        {problem ? (
          <span className="font-semibold text-critical">nothing</span>
        ) : (
          <span className="text-xl font-semibold tabular">{money(amount)}</span>
        )}
      </p>

      {problem ? (
        <Callout tone="caution" title="This paper is not payable">
          {problem}
        </Callout>
      ) : (
        <dl className="divide-y divide-line">
          {working.map((line) => (
            <div key={line.id} className="flex items-baseline justify-between gap-x-6 py-1.5">
              <dt className={cn("text-sm", line.strong ? "font-medium" : "text-fg-muted")}>
                {line.label}
              </dt>
              <dd className={cn("shrink-0 text-sm tabular", line.strong && "font-medium")}>
                {line.value}
              </dd>
            </div>
          ))}
        </dl>
      )}

      {categoryLabel && <Meta className="block">{categoryLabel}</Meta>}
      {note && !problem && <Meta className="block">{note}</Meta>}
    </div>
  )
}

/* ------------------------------------------------------------------------ */
/* Estimating — the calculator's Step 8, mirrored for the unsaved draft      */
/* ------------------------------------------------------------------------ */

type EstimateConfig = {
  snipMultiplier: number
  snipCap: number
  qf: Record<string, number>
  fixedJournal: number
  fixedOther: number
  fixedWos: number
  maxAuthors: number
  points: Record<string, unknown>
  multipliers: Record<string, number>
}

/** `id` and not the label, so `reconcile` can swap a total for the server's
 *  own figure without matching on prose that changes with the inputs. */
type WorkingLine = { id: string; label: string; value: string; strong?: boolean }

type EstimateResult = {
  amount: number | null
  category?: string
  problem?: string
  working: WorkingLine[]
}

/**
 * `calculate_remuneration` in `backend/core/services/remuneration.py`, for the
 * Scopus-indexed Engineering case the example uses.
 *
 * It is a mirror and not the authority, which is why every surface that uses
 * it says "estimate". The page's own example asks the server instead; this
 * exists only for the editor, where the numbers being priced are not saved and
 * so cannot be priced by anything but this.
 */
function estimate(cfg: EstimateConfig, ex: Example): EstimateResult {
  const working: WorkingLine[] = []
  const total = Math.round(num(ex.totalAuthors))
  const position = Math.round(num(ex.position))

  if (total < 1) return { amount: null, working, problem: "There has to be at least one author." }
  if (position < 1 || position > total) {
    return {
      amount: null,
      working,
      problem: `Author ${position} of ${total} is not a position on this paper.`,
    }
  }
  const limit = Math.round(cfg.maxAuthors) || 9
  if (total > limit) {
    return {
      amount: null,
      working,
      problem: `Papers with more than ${limit} authors are not eligible for remuneration, so this one pays nothing to anybody.`,
    }
  }

  const rule = cfg.points[String(total)] ?? cfg.points.default
  if (rule === undefined) {
    return {
      amount: null,
      working,
      problem: `There is no author-point rule for ${total} authors, and no fallback for “any other number”. A paper with ${total} authors cannot be priced.`,
    }
  }
  let share: number
  if (typeof rule === "number") {
    share = rule
  } else if (Array.isArray(rule)) {
    const at = rule[position - 1]
    if (typeof at !== "number") {
      return {
        amount: null,
        working,
        problem: `The rule for ${total} authors lists ${rule.length} ${rule.length === 1 ? "share" : "shares"}, so there is nothing for the ${ordinal(position)}.`,
      }
    }
    share = at
  } else {
    return {
      amount: null,
      working,
      problem: `The rule for ${total} authors is neither a share nor a list of shares.`,
    }
  }

  const snip = ex.snip.trim() ? num(ex.snip) : 0
  if (snip > cfg.snipCap) {
    return {
      amount: null,
      working,
      problem: `A SNIP of ${trim(snip)} is above the cap of ${trim(cfg.snipCap)}, which the calculator rejects as invalid rather than paying it.`,
    }
  }

  const type = ex.type
  const lower = type.toLowerCase()
  const conferenceOrBook = /conference|book|proceeding|chapter/.test(lower)
  const journal = (lower.includes("journal") || type === "") && !conferenceOrBook
  const pubM = cfg.multipliers[type] ?? 1
  const scopus = ex.indexing === "Scopus"

  // The quartile incentive is an Engineering-journal rule: a conference paper
  // carrying a SNIP still earns nothing from its quartile.
  const qf = journal ? cfg.qf[ex.quartile] ?? 0 : 0
  const qfLine: WorkingLine = {
    id: "qf",
    label: journal
      ? ex.quartile
        ? `Quartile incentive for ${ex.quartile}`
        : "Quartile incentive — no quartile held"
      : "Quartile incentive — journals only",
    value: `+ ${money(qf)}`,
  }

  let base: number
  let category: string
  if (scopus && snip > 0) {
    base = (snip * cfg.snipMultiplier + qf) * pubM
    category = "Category I — Scopus indexed, with SNIP"
    working.push({
      id: "snip",
      label: `SNIP ${trim(snip)} × ${money(cfg.snipMultiplier)} per point`,
      value: money(snip * cfg.snipMultiplier),
    })
    working.push(qfLine)
  } else if (scopus && conferenceOrBook) {
    base = cfg.fixedOther * pubM
    category = "Category III — Scopus conference or book chapter without SNIP"
    working.push({
      id: "fixed",
      label: "No SNIP, so the fixed conference or book rate",
      value: money(cfg.fixedOther),
    })
  } else if (scopus && journal) {
    base = cfg.fixedJournal * pubM
    category = "Category II — Scopus journal without SNIP"
    working.push({
      id: "fixed",
      label: "No SNIP, so the fixed journal rate",
      value: money(cfg.fixedJournal),
    })
  } else if (!scopus) {
    // Category IV is a flat rate plus the quartile incentive; a SNIP on a
    // Web of Science paper buys nothing, which is the one result on this
    // screen most likely to be read as a bug rather than as the policy.
    base = (cfg.fixedWos + qf) * pubM
    category = "Category IV — Web of Science (SCIE/ESCI), not in Scopus"
    working.push({ id: "fixed", label: "Web of Science flat rate", value: money(cfg.fixedWos) })
    working.push(qfLine)
  } else {
    return {
      amount: 0,
      category: "Not eligible for remuneration",
      working,
      problem: "This combination of indexing and publication type is not covered by the scheme.",
    }
  }

  if (pubM !== 1) {
    working.push({ id: "mult", label: `${type || "Publication"} multiplier`, value: `× ${trim(pubM)}` })
  }
  working.push({ id: "base", label: "The paper is worth", value: money(round2(base)), strong: true })
  working.push({
    id: "share",
    label: `Your share as the ${ordinal(position)} of ${total}`,
    value: `× ${formatShare(share)}`,
  })
  working.push({ id: "total", label: "You are paid", value: money(round2(base * share)), strong: true })

  return { amount: round2(base * share), category, working }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

function configFromFormula(f: Formula): EstimateConfig {
  return {
    snipMultiplier: f.snip_multiplier,
    snipCap: f.snip_cap,
    qf: { Q1: f.qf_q1, Q2: f.qf_q2, Q3: f.qf_q3, Q4: f.qf_q4 },
    fixedJournal: f.fixed_journal_no_snip,
    fixedOther: f.fixed_other_no_snip,
    fixedWos: f.fixed_web_of_science,
    maxAuthors: f.max_authors,
    points: parseObject(f.author_point_json) || {},
    multipliers: numericMap(f.publication_type_multipliers_json),
  }
}

function numericMap(json: string): Record<string, number> {
  const parsed = parseObject(json) || {}
  const out: Record<string, number> = {}
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === "number") out[key] = value
  }
  return out
}

/** The example's type list comes from the policy's own multiplier keys, so a
 *  college that renamed "Book Series" sees its own word, not ours. */
function typeKeys(json: string): string[] {
  const keys = Object.keys(parseObject(json) || {})
  return keys.length > 0 ? keys : ["Journal"]
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
  student_remuneration_zero: boolean
  qf_only_for_no_snip: boolean
  notes: string
}

/** One author-count rule, as rows rather than as a key and a JSON value. */
type PointRow = {
  /** Stable across re-renders so a numeric input does not lose focus when the
   *  count it is keyed by is being retyped. */
  uid: string
  key: string
  /** `flat` is one share for everybody; `positions` is a share each. */
  mode: "flat" | "positions"
  flat: string
  shares: string[]
}

type MultRow = { uid: string; key: string; value: string }

/** A stored value the row editor cannot represent keeps its text, so a policy
 *  that is already broken can still be repaired from this screen. Losing that
 *  escape hatch would mean a bad save could only be fixed in the database. */
type Editable<T> = { kind: "rows"; rows: T[] } | { kind: "raw"; text: string }

let uidCounter = 0
function uid(): string {
  uidCounter += 1
  return `r${uidCounter}`
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
  const [points, setPoints] = useState<Editable<PointRow>>(() => pointsFrom(current.author_point_json))
  const [mults, setMults] = useState<Editable<MultRow>>(() =>
    multsFrom(current.publication_type_multipliers_json)
  )
  const [confirming, setConfirming] = useState(false)

  useEffect(() => {
    if (open) {
      setForm(stateFrom(current))
      setPoints(pointsFrom(current.author_point_json))
      setMults(multsFrom(current.publication_type_multipliers_json))
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

  // The rows are the editing surface; the JSON string is still exactly what
  // goes over the wire, so the payload the server sees has not changed shape.
  const authorPointJson = useMemo(() => serialisePoints(points), [points])
  const multipliersJson = useMemo(() => serialiseMults(mults), [mults])

  // The same shape checks the server runs, run here so a mistake is caught at
  // the keyboard. The server is still the authority; this only means the
  // reader is not told about it by a 400 after pressing publish.
  const authorPointsError = rowKeyError(points, "author count") || validateAuthorPoints(authorPointJson)
  const multipliersError = rowKeyError(mults, "publication type") || validateMultipliers(multipliersJson)
  const capError =
    Number.parseFloat(form.snip_cap) > 0 ? undefined : "Must be greater than zero."
  const datesError =
    form.effective_from && form.effective_to && form.effective_to < form.effective_from
      ? "The end date is before the start date."
      : undefined

  // Named, in the footer, beside the button they disable. Four validators can
  // block this publish and their messages live in a body that scrolls, so in a
  // twenty-field dialog the reason a pinned button is grey is almost always
  // off-screen — which reads as the app being broken rather than the form.
  const blockers = [
    authorPointsError && `author points — ${lowerFirst(authorPointsError)}`,
    multipliersError && `publication type multipliers — ${lowerFirst(multipliersError)}`,
    capError && `the SNIP cap — ${lowerFirst(capError)}`,
    datesError && `the dates — ${lowerFirst(datesError)}`,
  ].filter((v): v is string => Boolean(v))

  const draftConfig: EstimateConfig = useMemo(
    () => ({
      snipMultiplier: num(form.snip_multiplier),
      snipCap: num(form.snip_cap) || 30,
      qf: {
        Q1: num(form.qf_q1),
        Q2: num(form.qf_q2),
        Q3: num(form.qf_q3),
        Q4: num(form.qf_q4),
      },
      fixedJournal: num(form.fixed_journal_no_snip),
      fixedOther: num(form.fixed_other_no_snip),
      fixedWos: num(form.fixed_web_of_science),
      maxAuthors: num(form.max_authors) || 9,
      points: parseObject(authorPointJson) || {},
      multipliers: numericMap(multipliersJson),
    }),
    [form, authorPointJson, multipliersJson]
  )
  const draftTypes = useMemo(() => typeKeys(multipliersJson), [multipliersJson])

  const nextVersion = current.version + 1

  async function publish() {
    try {
      const result = await save.mutateAsync({
        name: form.name.trim() || `Policy v${nextVersion}`,
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
        author_point_json: authorPointJson,
        publication_type_multipliers_json: multipliersJson,
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
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent size="lg">
          <DialogHeader>
            <DialogTitle>Publish a new policy version</DialogTitle>
            <DialogDescription>
              This does not edit v{current.version}. It retires it and makes v{nextVersion}
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
              <Money
                label="Rate per SNIP point"
                value={form.snip_multiplier}
                onChange={(v) => set("snip_multiplier", v)}
                hint="A SNIP of 1.85 pays 1.85 times this"
              />
              <Field label="SNIP cap" hint="A SNIP above this is rejected as invalid" error={capError}>
                <NumberInput
                  value={form.snip_cap}
                  onChange={(e) => set("snip_cap", e.target.value)}
                  min={0}
                  step="0.5"
                />
              </Field>
            </Fieldset>

            <Fieldset legend="The quartile amounts" hint="Added to the SNIP amount, on Engineering journals only.">
              <Money label="Q1" value={form.qf_q1} onChange={(v) => set("qf_q1", v)} hint="Added on top" />
              <Money label="Q2" value={form.qf_q2} onChange={(v) => set("qf_q2", v)} hint="Added on top" />
              <Money label="Q3" value={form.qf_q3} onChange={(v) => set("qf_q3", v)} hint="Added on top" />
              <Money label="Q4" value={form.qf_q4} onChange={(v) => set("qf_q4", v)} hint="Added on top" />
            </Fieldset>

            <Fieldset
              legend="Fixed amounts"
              hint="What the paper is worth before the author share, where no SNIP is held."
            >
              <Money
                label="Journal, no SNIP"
                value={form.fixed_journal_no_snip}
                onChange={(v) => set("fixed_journal_no_snip", v)}
                hint="Scopus journal article"
              />
              <Money
                label="Other, no SNIP"
                value={form.fixed_other_no_snip}
                onChange={(v) => set("fixed_other_no_snip", v)}
                hint="Conference paper or book chapter"
              />
              <Money
                label="Web of Science"
                value={form.fixed_web_of_science}
                onChange={(v) => set("fixed_web_of_science", v)}
                hint="SCIE or ESCI, not in Scopus"
              />
            </Fieldset>

            <Fieldset legend="Rules">
              <Money
                label="High-value threshold"
                value={form.high_value_threshold}
                onChange={(v) => set("high_value_threshold", v)}
                hint="Above this, a second signature. Zero switches it off"
              />
              <Field label="Eligible authors" hint="More authors than this and the paper pays nothing">
                <NumberInput
                  value={form.max_authors}
                  onChange={(e) => set("max_authors", e.target.value)}
                  min={1}
                  step="1"
                />
              </Field>
              <Field label="Minimum SEC authors" hint="Fewer than this and the paper is counted, not paid">
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

            <AuthorPointsEditor value={points} onChange={setPoints} error={authorPointsError} />

            <MultipliersEditor value={mults} onChange={setMults} error={multipliersError} />

            <DraftExample config={draftConfig} types={draftTypes} />

            <Field label="Notes" hint="What changed and why. Whoever reads the audit entry sees this.">
              <Textarea value={form.notes} onChange={(e) => set("notes", e.target.value)} rows={3} />
            </Field>

            <RawDisclosure
              summary="Advanced — the JSON this will send"
              blurb="Generated from the rows above and shown read-only, so a brace cannot be left unclosed by hand."
              blobs={[
                ["author_point_json", authorPointJson],
                ["publication_type_multipliers_json", multipliersJson],
              ]}
            />
          </DialogBody>
          <DialogFooter className="flex-wrap justify-between gap-x-4 gap-y-2">
            <p
              role="status"
              className={cn("min-w-0 flex-1 text-xs", blockers.length > 0 ? "text-critical" : "text-fg-subtle")}
            >
              {blockers.length > 0
                ? `Cannot publish yet: ${blockers[0]}${
                    blockers.length > 1
                      ? ` (and ${blockers.length - 1} other ${blockers.length === 2 ? "problem" : "problems"})`
                      : ""
                  }`
                : `Publishing makes v${nextVersion} active immediately. There is no undo.`}
            </p>
            <div className="flex shrink-0 items-center gap-2">
              <Button kind="quiet" onClick={() => onOpenChange(false)} disabled={save.isPending}>
                Cancel
              </Button>
              <Button
                kind="primary"
                disabled={blockers.length > 0 || save.isPending}
                onClick={() => setConfirming(true)}
              >
                {save.isPending ? "Publishing…" : "Publish…"}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Not a button swapped in under the pointer: a separate surface, in a
          different place, that will not accept the second half of a double
          click. Typing the version number is the pause this write earns. */}
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        danger
        title={`Make v${nextVersion} the active policy?`}
        description={`v${current.version} is retired the moment you confirm, and every unpaid claim in the college is repriced from these numbers when it next moves. There is no undo.`}
        confirmLabel={`Publish v${nextVersion}`}
        requirePhrase={`v${nextVersion}`}
        onConfirm={publish}
      />
    </>
  )
}

function Fieldset({
  legend,
  hint,
  children,
}: {
  legend: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <fieldset className="space-y-3">
      <legend className="mb-2 text-sm font-medium">{legend}</legend>
      {hint && <p className="text-xs text-fg-muted">{hint}</p>}
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
/* The two former JSON fields, as rows                                       */
/* ------------------------------------------------------------------------ */

/**
 * Author points, edited as "1st of 3 → 0.5" rather than as `{"3":[0.5,...]}`.
 *
 * Typing this field as JSON is what made a bad save possible: a missing brace
 * or a share written as a string produced a policy that looked saved and then
 * raised inside the calculator, taking every submit, clear and payment down
 * with it — including this editor's own. Rows cannot express that shape, so
 * the failure has nowhere left to come from.
 */
function AuthorPointsEditor({
  value,
  onChange,
  error,
}: {
  value: Editable<PointRow>
  onChange: (next: Editable<PointRow>) => void
  error?: string
}) {
  if (value.kind === "raw") {
    return (
      <RepairPanel
        title="Author points"
        text={value.text}
        onChange={(text) => onChange({ kind: "raw", text })}
        onConvert={() => onChange(pointsFrom(value.text))}
        convertible={validateAuthorPoints(value.text) === undefined}
        error={error}
      />
    )
  }

  const rows = value.rows
  const setRows = (next: PointRow[]) => onChange({ kind: "rows", rows: next })
  const update = (uidToChange: string, patch: Partial<PointRow>) =>
    setRows(rows.map((r) => (r.uid === uidToChange ? { ...r, ...patch } : r)))

  const nextCount = String(
    Math.max(0, ...rows.map((r) => (/^\d+$/.test(r.key) ? Number(r.key) : 0))) + 1
  )
  const hasDefault = rows.some((r) => r.key === "default")

  return (
    <section className="space-y-3">
      <div>
        <p className="text-sm font-medium">Author points</p>
        <p className="mt-0.5 text-xs text-fg-muted">
          How one paper's amount is split between its authors. A share of 0.5 pays that author
          half of what the paper is worth.
        </p>
      </div>

      <div className="divide-y divide-line border-y border-line">
        {rows.map((row) => (
          <PointRowEditor
            key={row.uid}
            row={row}
            onChange={(patch) => update(row.uid, patch)}
            onRemove={() => setRows(rows.filter((r) => r.uid !== row.uid))}
          />
        ))}
        {rows.length === 0 && (
          <p className="py-3 text-sm text-critical">
            No rules at all. Every paper in the college would pay nothing.
          </p>
        )}
      </div>

      {error && (
        <p role="alert" className="text-xs text-critical">
          {error}
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        <Button
          kind="default"
          size="sm"
          onClick={() =>
            setRows([
              ...rows,
              {
                uid: uid(),
                key: nextCount,
                mode: "positions",
                flat: "0",
                shares: Array.from({ length: Number(nextCount) }, () => "0"),
              },
            ])
          }
        >
          <Plus />
          Add a rule for {nextCount} {nextCount === "1" ? "author" : "authors"}
        </Button>
        {!hasDefault && (
          <Button
            kind="quiet"
            size="sm"
            onClick={() =>
              setRows([
                ...rows,
                { uid: uid(), key: "default", mode: "flat", flat: "0.1", shares: ["0.1"] },
              ])
            }
          >
            <Plus />
            Add a fallback for any other count
          </Button>
        )}
      </div>
    </section>
  )
}

function PointRowEditor({
  row,
  onChange,
  onRemove,
}: {
  row: PointRow
  onChange: (patch: Partial<PointRow>) => void
  onRemove: () => void
}) {
  const group = useId()
  const isDefault = row.key === "default"
  const count = /^\d+$/.test(row.key) ? Number(row.key) : row.shares.length
  const sum = row.mode === "flat" ? num(row.flat) * (count || 1) : row.shares.reduce((a, s) => a + num(s), 0)

  // The share list is the length the author count says it is: a rule for three
  // authors with two shares silently pays the third of three nothing, and the
  // calculator refuses the whole claim rather than saying so.
  function setKey(next: string) {
    const n = /^\d+$/.test(next) ? Number(next) : 0
    if (n > 0 && row.mode === "positions") {
      const shares = Array.from({ length: n }, (_, i) => row.shares[i] ?? "0")
      onChange({ key: next, shares })
      return
    }
    onChange({ key: next })
  }

  return (
    <div className="space-y-2.5 py-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        {isDefault ? (
          <p className="text-sm font-medium">Any other number of authors</p>
        ) : (
          <label className="flex items-center gap-2 text-sm">
            <span>When a paper has</span>
            <NumberInput
              value={row.key}
              onChange={(e) => setKey(e.target.value)}
              min={1}
              step="1"
              className="w-20"
              aria-label="Number of authors this rule covers"
            />
            <span>authors</span>
          </label>
        )}
        <Button
          kind="quiet"
          size="sm"
          onClick={onRemove}
          aria-label={`Remove the rule for ${isDefault ? "any other number of authors" : `${row.key} authors`}`}
        >
          <X />
          Remove
        </Button>
      </div>

      <div className="flex flex-wrap gap-x-5 gap-y-1">
        <Radio
          name={group}
          checked={row.mode === "flat"}
          onChange={() => onChange({ mode: "flat" })}
          label="Every author gets the same share"
        />
        <Radio
          name={group}
          checked={row.mode === "positions"}
          onChange={() =>
            onChange({
              mode: "positions",
              shares:
                row.shares.length > 0
                  ? row.shares
                  : Array.from({ length: count || 1 }, () => row.flat),
            })
          }
          label="Each position gets its own"
        />
      </div>

      {row.mode === "flat" ? (
        <div className="flex items-center gap-2">
          <span className="text-sm text-fg-muted">Share, each</span>
          <NumberInput
            value={row.flat}
            onChange={(e) => onChange({ flat: e.target.value })}
            min={0}
            step="0.05"
            className="w-24"
            aria-label="Share paid to every author"
          />
          <Meta>{percent(num(row.flat))} of the paper's amount</Meta>
        </div>
      ) : (
        <div className="flex flex-wrap gap-3">
          {row.shares.map((share, i) => (
            <label key={i} className="space-y-1">
              <span className="block text-xs text-fg-muted">
                {ordinal(i + 1)}
                {isDefault ? "" : ` of ${row.key}`}
              </span>
              <NumberInput
                value={share}
                onChange={(e) =>
                  onChange({ shares: row.shares.map((s, j) => (j === i ? e.target.value : s)) })
                }
                min={0}
                step="0.05"
                className="w-24"
              />
            </label>
          ))}
          {isDefault && (
            <div className="flex items-end gap-1">
              <Button
                kind="quiet"
                size="sm"
                onClick={() => onChange({ shares: [...row.shares, "0"] })}
                aria-label="Add a position to the fallback rule"
              >
                <Plus />
                Position
              </Button>
              {row.shares.length > 1 && (
                <Button
                  kind="quiet"
                  size="sm"
                  onClick={() => onChange({ shares: row.shares.slice(0, -1) })}
                  aria-label="Remove the last position from the fallback rule"
                >
                  <X />
                </Button>
              )}
            </div>
          )}
        </div>
      )}

      {/* The one arithmetic mistake this table invites, said out loud. Shares
          that come to 0.9 are legal and may be meant; nobody should discover
          they were not meant from a payslip. */}
      <Meta className="block">
        {`Adds up to ${percent(sum)} of the paper's amount` +
          (Math.abs(sum - 1) < 0.0005
            ? "."
            : sum < 1
              ? " — the rest is not paid to anybody."
              : " — the paper pays out more than it is worth.")}
      </Meta>
    </div>
  )
}

/**
 * Publication type multipliers, edited as a name and a `×`.
 *
 * Same reason as the author points: this was a JSON textarea, and a multiplier
 * typed as `"1"` instead of `1` passes as valid JSON and is rejected by the
 * server only after the reader has pressed publish on a twenty-field form.
 */
function MultipliersEditor({
  value,
  onChange,
  error,
}: {
  value: Editable<MultRow>
  onChange: (next: Editable<MultRow>) => void
  error?: string
}) {
  if (value.kind === "raw") {
    return (
      <RepairPanel
        title="Publication type multipliers"
        text={value.text}
        onChange={(text) => onChange({ kind: "raw", text })}
        onConvert={() => onChange(multsFrom(value.text))}
        convertible={validateMultipliers(value.text) === undefined}
        error={error}
      />
    )
  }

  const rows = value.rows
  const setRows = (next: MultRow[]) => onChange({ kind: "rows", rows: next })

  return (
    <section className="space-y-3">
      <div>
        <p className="text-sm font-medium">Publication type multipliers</p>
        <p className="mt-0.5 text-xs text-fg-muted">
          Applied last, to the paper's whole amount. ×1 leaves it alone; ×0.5 halves it; ×2
          doubles it.
        </p>
      </div>

      <div className="divide-y divide-line border-y border-line">
        {rows.map((row) => (
          <div key={row.uid} className="flex flex-wrap items-end gap-3 py-2.5">
            <label className="min-w-0 flex-1 space-y-1">
              <span className="block text-xs text-fg-muted">Publication type</span>
              <Input value={row.key} onChange={(e) => setRows(rows.map((r) => (r.uid === row.uid ? { ...r, key: e.target.value } : r)))} />
            </label>
            <label className="space-y-1">
              <span className="block text-xs text-fg-muted">Multiplier</span>
              <NumberInput
                value={row.value}
                onChange={(e) => setRows(rows.map((r) => (r.uid === row.uid ? { ...r, value: e.target.value } : r)))}
                min={0}
                step="0.1"
                unit="×"
                className="w-28"
              />
            </label>
            <div className="flex items-center gap-2 pb-1">
              <Meta>{multiplierEffect(num(row.value))}</Meta>
              <Button
                kind="quiet"
                size="sm"
                onClick={() => setRows(rows.filter((r) => r.uid !== row.uid))}
                aria-label={`Remove ${row.key || "this type"}`}
              >
                <X />
              </Button>
            </div>
          </div>
        ))}
        {rows.length === 0 && (
          <p className="py-3 text-sm text-critical">
            No types at all. The server will not accept an empty list.
          </p>
        )}
      </div>

      {error && (
        <p role="alert" className="text-xs text-critical">
          {error}
        </p>
      )}

      <Button
        kind="default"
        size="sm"
        onClick={() => setRows([...rows, { uid: uid(), key: "", value: "1" }])}
      >
        <Plus />
        Add a publication type
      </Button>
    </section>
  )
}

/**
 * The way back from a policy that is already unreadable.
 *
 * A stored value the rows cannot represent is exactly the value that is
 * breaking every calculation in the college, so this is the one place the raw
 * text stays editable — the alternative is a screen that can only display the
 * damage and a fix that has to happen in the database.
 */
function RepairPanel({
  title,
  text,
  onChange,
  onConvert,
  convertible,
  error,
}: {
  title: string
  text: string
  onChange: (text: string) => void
  onConvert: () => void
  convertible: boolean
  error?: string
}) {
  return (
    <section className="space-y-3">
      <p className="text-sm font-medium">{title}</p>
      <Callout tone="critical" title="The stored value cannot be shown as rows">
        It is not a shape the calculator can read, which means the active policy is broken. Fix
        the text below, then switch to the simple editor.
      </Callout>
      <Field label={`${title} (raw)`} error={error}>
        <Textarea
          value={text}
          onChange={(e) => onChange(e.target.value)}
          rows={4}
          className="font-mono text-sm"
        />
      </Field>
      <Button kind="default" size="sm" disabled={!convertible} onClick={onConvert}>
        {convertible ? "Switch to the simple editor" : "Not yet a shape the rows can hold"}
      </Button>
    </section>
  )
}

/* ------------------------------------------------------------------------ */
/* Rows to JSON, and back                                                    */
/* ------------------------------------------------------------------------ */

function pointsFrom(json: string): Editable<PointRow> {
  const parsed = parseObject(json)
  if (parsed === null) return { kind: "raw", text: json }
  const rows: PointRow[] = []
  for (const [key, value] of Object.entries(parsed)) {
    if (key !== "default" && !/^\d+$/.test(key)) return { kind: "raw", text: pretty(json) }
    if (typeof value === "number") {
      rows.push({ uid: uid(), key, mode: "flat", flat: String(value), shares: [String(value)] })
      continue
    }
    if (Array.isArray(value) && value.length > 0 && value.every((v) => typeof v === "number")) {
      rows.push({
        uid: uid(),
        key,
        mode: "positions",
        flat: String(value[0]),
        shares: value.map(String),
      })
      continue
    }
    return { kind: "raw", text: pretty(json) }
  }
  if (rows.length === 0) return { kind: "rows", rows: [] }
  return { kind: "rows", rows }
}

function serialisePoints(value: Editable<PointRow>): string {
  if (value.kind === "raw") return value.text
  const out: Record<string, number | number[]> = {}
  for (const row of value.rows) {
    const key = row.key.trim()
    if (!key) continue
    out[key] = row.mode === "flat" ? num(row.flat) : row.shares.map(num)
  }
  return JSON.stringify(out)
}

function multsFrom(json: string): Editable<MultRow> {
  const parsed = parseObject(json)
  if (parsed === null) return { kind: "raw", text: json }
  const rows: MultRow[] = []
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== "number") return { kind: "raw", text: pretty(json) }
    rows.push({ uid: uid(), key, value: String(value) })
  }
  return { kind: "rows", rows }
}

function serialiseMults(value: Editable<MultRow>): string {
  if (value.kind === "raw") return value.text
  const out: Record<string, number> = {}
  for (const row of value.rows) {
    const key = row.key.trim()
    if (!key) continue
    out[key] = num(row.value)
  }
  return JSON.stringify(out)
}

/**
 * Two rows keyed the same thing, or a row keyed nothing.
 *
 * Serialising rows into an object silently drops both — the second row wins
 * and the blank one vanishes — so the reader would press publish and find one
 * of the rules they had just written gone, with no message anywhere saying so.
 */
function rowKeyError(
  value: Editable<{ key: string }>,
  noun: string
): string | undefined {
  if (value.kind === "raw") return undefined
  const seen = new Set<string>()
  for (const row of value.rows) {
    const key = row.key.trim()
    if (!key) return `One row has no ${noun}. Give it one, or remove the row.`
    if (seen.has(key)) return `Two rows both cover “${key}”. Only the second would be kept.`
    seen.add(key)
  }
  return undefined
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
    student_remuneration_zero: f.student_remuneration_zero,
    qf_only_for_no_snip: f.qf_only_for_no_snip,
    notes: f.notes || "",
  }
}

/** Stored on one line; shown over several, because a policy field nobody can
 *  read is a policy field nobody checks before publishing. */
function pretty(json: string): string {
  const parsed = parseObject(json)
  return parsed === null ? json : JSON.stringify(parsed, null, 2)
}

function num(value: string): number {
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : 0
}

/** The validators write standalone sentences; the footer reads them as the
 *  tail of one, so the capital letter has to go. */
function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1)
}

function formatDay(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })
}
