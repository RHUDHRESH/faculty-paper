import { useEffect, useMemo, useState } from "react"
import { keepPreviousData, useQuery } from "@tanstack/react-query"
import { X } from "lucide-react"

import { api } from "@/lib/api"
import { cn } from "@/lib/cn"
import { useApi } from "@/lib/query"
import {
  indexingChoice,
  type Options,
  type PersonHit,
  type Prefill,
  type PriceResult,
  rs,
} from "@/pages/calculator-types"
import { FaceName } from "@/pages/admin-b-parts"
import { Button } from "@/ui/button"
import { Checkbox, Field, Input, NumberInput, Select } from "@/ui/field"
import { Table } from "@/ui/table"
import { Details, Rows, Section } from "@/ui/section"
import { Callout, ErrorState, SkeletonText } from "@/ui/state"
import { ColumnLabel, Meta } from "@/ui/text"

/**
 * Tab 1: price a paper.
 *
 * The amount comes from the server, which prices it with the same function a
 * claim is priced with. The browser does no sums: while the server thinks, the
 * last answer stays on screen, dimmed and labelled "Updating", and a paper
 * that cannot be priced says why in the place the amount would be.
 */

type Form = {
  type: string
  indexing: string
  subject: string
  quartile: string
  snip: string
  total: string
  positions: number[]
  refs: string
  student: boolean
  countedOnly: boolean
  policyId: string
  person: PersonHit | null
}

const START: Form = {
  type: "Journal",
  indexing: "Scopus",
  subject: "Engineering",
  quartile: "Q1",
  snip: "",
  total: "1",
  positions: [1],
  refs: "2",
  student: false,
  countedOnly: false,
  policyId: "",
  person: null,
}

const INDEXING = [
  { value: "Scopus", label: "Scopus" },
  { value: "SCIE", label: "Web of Science only" },
  { value: "Scopus, SCIE", label: "Scopus and Web of Science" },
  { value: "", label: "Not stated" },
]

const SUBJECTS = [
  { value: "Engineering", label: "Engineering" },
  { value: "Non-Engineering", label: "Not Engineering" },
  { value: "", label: "Not classified yet" },
]

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms)
    return () => clearTimeout(t)
  }, [value, ms])
  return v
}

function numberOrNull(text: string): number | null {
  const t = text.trim()
  if (!t) return null
  const n = Number(t)
  return Number.isFinite(n) ? n : null
}

export function PriceTab() {
  const options = useApi<Options>(["calculator", "options"], "/api/calculator/options")
  const [form, setForm] = useState<Form>(START)
  const set = (patch: Partial<Form>) => setForm((f) => ({ ...f, ...patch }))

  const total = Math.max(1, Math.round(numberOrNull(form.total) ?? 1))
  const ticked = form.positions.filter((p) => p <= total)
  const positions = ticked.length > 0 ? ticked : [1]

  const body = useMemo(
    () => ({
      publication_type: form.type || null,
      indexing_level: form.indexing || null,
      quartile: form.quartile || null,
      snip: numberOrNull(form.snip),
      engineering_class: form.subject || null,
      total_authors: total,
      positions,
      sec_reference_count: form.student ? null : numberOrNull(form.refs),
      student_project: form.student,
      counted_only: form.countedOnly,
      policy_id: form.policyId || null,
      person_id: form.person?.user_id ?? null,
    }),
    [form, total, positions]
  )
  const settled = useDebounced(body, 350)

  const price = useQuery<PriceResult>({
    queryKey: ["calculator", "price", settled],
    queryFn: () => api<PriceResult>("/api/calculator/price", { method: "POST", json: settled }),
    placeholderData: keepPreviousData,
    enabled: !!options.data,
  })

  if (options.isError) {
    return <ErrorState what="the calculator's policy list" onRetry={() => void options.refetch()} />
  }
  const opt = options.data
  const types = opt
    ? form.type && !opt.publication_types.includes(form.type)
      ? [form.type, ...opt.publication_types]
      : opt.publication_types
    : []

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-x-10 gap-y-8 lg:grid-cols-[minmax(0,24rem)_minmax(0,1fr)]">
      <form
        aria-label="The paper"
        className="min-w-0 space-y-5"
        onSubmit={(e) => e.preventDefault()}
      >
        <Prefiller
          onFill={(inputs) =>
            set({
              type: inputs.publication_type ?? "",
              indexing: indexingChoice(inputs.indexing_level),
              subject: inputs.engineering_class ?? "",
              quartile: inputs.quartile ?? "",
              snip: inputs.snip == null ? "" : String(inputs.snip),
              total: String(inputs.total_authors || 1),
              positions: [Math.min(inputs.author_position || 1, inputs.total_authors || 1)],
              student: inputs.student_project,
              countedOnly: inputs.counted_only,
            })
          }
        />

        <Field label="Paper type">
          <Select value={form.type} onChange={(e) => set({ type: e.target.value })} disabled={!opt}>
            {types.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
            <option value="">Not stated</option>
          </Select>
        </Field>

        {!form.student && (
          <>
            <Field label="Indexed in">
              <Select value={form.indexing} onChange={(e) => set({ indexing: e.target.value })}>
                {INDEXING.map((o) => (
                  <option key={o.label} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </Select>
            </Field>

            <div className="grid grid-cols-2 gap-4">
              <Field label="Subject area" hint="The quartile incentive is for Engineering journals only.">
                <Select value={form.subject} onChange={(e) => set({ subject: e.target.value })}>
                  {SUBJECTS.map((o) => (
                    <option key={o.label} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Quartile">
                <Select value={form.quartile} onChange={(e) => set({ quartile: e.target.value })}>
                  <option value="">No quartile</option>
                  {(opt?.quartiles ?? ["Q1", "Q2", "Q3", "Q4"]).map((q) => (
                    <option key={q} value={q}>
                      {q}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <Field label="SNIP" hint="Empty if none: the fixed no-SNIP rate applies.">
                <NumberInput
                  step="0.001"
                  min={0}
                  value={form.snip}
                  onChange={(e) => set({ snip: e.target.value })}
                  placeholder="None"
                />
              </Field>
              <Field
                label="SEC references"
                hint={`The policy needs ${opt?.limits.min_sec_references ?? 2}. Empty if not checked.`}
              >
                <NumberInput
                  min={0}
                  step={1}
                  value={form.refs}
                  onChange={(e) => set({ refs: e.target.value })}
                  placeholder="Not checked"
                />
              </Field>
            </div>
          </>
        )}

        <Field label="Total authors">
          <NumberInput
            min={1}
            max={30}
            step={1}
            value={form.total}
            onChange={(e) => set({ total: e.target.value })}
          />
        </Field>

        {!form.student && (
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">Author position at the college</legend>
            <p className="text-xs text-fg-muted">
              Pick one. Pick several to price each co-author from the college.
            </p>
            <div className="flex flex-wrap gap-2">
              {Array.from({ length: Math.min(total, 30) }, (_, i) => i + 1).map((p) => {
                const on = positions.includes(p)
                return (
                  <button
                    key={p}
                    type="button"
                    aria-pressed={on}
                    aria-label={`Author ${p}`}
                    onClick={() =>
                      set({ positions: on ? positions.filter((x) => x !== p) : [...positions, p].sort((a, b) => a - b) })
                    }
                    className={cn(
                      "h-9 min-w-9 rounded-full px-3 text-sm tabular ring-1 ring-inset max-sm:h-10 max-sm:min-w-10",
                      on ? "bg-accent text-accent-fg ring-accent" : "bg-surface text-fg ring-edge hover:bg-hover"
                    )}
                  >
                    {p}
                  </button>
                )
              })}
            </div>
          </fieldset>
        )}

        <Checkbox
          checked={form.student}
          onCheckedChange={(v) => set({ student: v === true })}
          label="Final-year student project"
          hint={
            opt
              ? `A fixed ${rs(opt.limits.student_project_amount)} for each team's conference paper, paid once per team.`
              : "A fixed amount for each team's conference paper."
          }
        />

        <Field label="Policy version">
          <Select value={form.policyId} onChange={(e) => set({ policyId: e.target.value })} disabled={!opt}>
            <option value="">{opt?.in_force ? `${opt.in_force.label}, in force now` : "The policy in force now"}</option>
            {(opt?.policies ?? [])
              .filter((p) => !p.in_force)
              .map((p) => (
                <option key={p.id ?? p.label} value={p.id ?? ""}>
                  {p.label}
                  {p.effective_from ? `, from ${p.effective_from}` : ""}
                </option>
              ))}
          </Select>
        </Field>

        <PersonPicker value={form.person} onChange={(person) => set({ person })} />

        {!form.student && (
          <Details label="more options">
            <Checkbox
              checked={form.countedOnly}
              onCheckedChange={(v) => set({ countedOnly: v === true })}
              label="Counted only"
              hint="A student paper filed to be counted. It carries no incentive."
            />
          </Details>
        )}
      </form>

      <Answer price={price.data} fetching={price.isFetching} failed={price.isError} onRetry={() => void price.refetch()} />
    </div>
  )
}

function Answer({
  price,
  fetching,
  failed,
  onRetry,
}: {
  price: PriceResult | undefined
  fetching: boolean
  failed: boolean
  onRetry: () => void
}) {
  if (failed && !price) {
    return (
      <div className="max-lg:order-first">
        <ErrorState what="the price" message="The server did not answer, so no amount is shown." onRetry={onRetry} />
      </div>
    )
  }
  if (!price) {
    return (
      <div className="max-lg:order-first">
        <SkeletonText lines={4} />
      </div>
    )
  }
  const cannot = !price.ok
  return (
    <div className="min-w-0 space-y-8 max-lg:order-first" aria-busy={fetching}>
      <section
        aria-label="The incentive"
        className={cn("panel-lead p-5 sm:p-6 lg:sticky lg:top-4", fetching && "opacity-70")}
      >
        <div className="flex flex-wrap items-baseline justify-between gap-x-4">
          <ColumnLabel>{cannot ? "Cannot be priced" : "The incentive for this paper"}</ColumnLabel>
          {fetching && (
            <span className="text-xs text-fg-muted" role="status">
              Updating
            </span>
          )}
        </div>
        <p className="figure mt-1 text-4xl [overflow-wrap:anywhere] max-sm:text-3xl" data-testid="calc-amount">
          {cannot ? "No amount" : rs(price.amount)}
        </p>
        <p className="mt-2 max-w-prose text-pretty text-base text-fg-muted" data-testid="calc-sentence">
          {price.sentence}
        </p>
        {price.category_label && !cannot && (
          <Meta className="mt-2 block text-xs">{price.category_label}</Meta>
        )}
      </section>

      {price.cautions.length > 0 && (
        <Callout tone="caution" title="Worth knowing">
          <ul className="list-disc space-y-1 pl-4">
            {price.cautions.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        </Callout>
      )}

      {price.working.length > 0 && (
        <Section
          title="How it was worked out"
          sub={`Under ${price.policy.label}${price.policy.in_force ? ", the policy in force now" : ", not the policy in force now"}.`}
        >
          <Rows>
            {price.working.map((l) => (
              <li key={l.key} className="flex items-baseline justify-between gap-4 py-2.5">
                <div className="min-w-0">
                  <span className="block text-sm font-medium">{l.label}</span>
                  <span className="block text-pretty text-sm text-fg-muted">{l.text}</span>
                </div>
                <span className="shrink-0 text-sm font-medium tabular">{l.amount == null ? "" : rs(l.amount)}</span>
              </li>
            ))}
          </Rows>
        </Section>
      )}

      {price.threshold && (price.working.every((l) => l.key !== "threshold") || cannot) && (
        <p className="text-pretty text-sm text-fg-muted">{price.threshold.text}</p>
      )}

      {price.authors.length > 1 && (
        <Section title="Each author at the college" sub="Each share is worked out by the same rule and they add up to the paper's value.">
          <Table
            rows={price.authors}
            getKey={(a) => String(a.position)}
            footer={{ position: "Total to the college", incentive: rs(price.college_total) }}
            columns={[
              { key: "position", header: "Author position", cell: (a) => `Author ${a.position}` },
              {
                key: "point",
                header: "Share of the paper",
                align: "right",
                cell: (a) => (a.point == null ? null : a.point.toString()),
              },
              {
                key: "incentive",
                header: "Incentive",
                align: "right",
                cell: (a) => (a.incentive == null ? (a.problem ?? null) : rs(a.incentive)),
              },
            ]}
          />
        </Section>
      )}
    </div>
  )
}

function Prefiller({ onFill }: { onFill: (inputs: NonNullable<Prefill["inputs"]>) => void }) {
  const [typed, setTyped] = useState("")
  const [note, setNote] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function fill() {
    const q = typed.trim()
    if (!q) return
    setBusy(true)
    setNote(null)
    try {
      const r = await api<Prefill>(`/api/calculator/prefill?q=${encodeURIComponent(q)}`)
      setNote(r.message)
      if (r.inputs) onFill(r.inputs)
    } catch {
      // A lookup must never block the form: say so and carry on by hand.
      setNote("The lookup did not answer. Enter the figures by hand.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-1.5">
      <label htmlFor="calc-prefill" className="block text-sm font-medium">
        Start from a claim no. or DOI (optional)
      </label>
      <div className="flex gap-2">
        <Input
          id="calc-prefill"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault()
              void fill()
            }
          }}
          placeholder="FP-2026-000123 or 10.1016/..."
        />
        <Button type="button" onClick={() => void fill()} disabled={busy || !typed.trim()}>
          {busy ? "Looking" : "Fill the form"}
        </Button>
      </div>
      {note && (
        <p className="text-xs text-fg-muted" role="status">
          {note}
        </p>
      )}
    </div>
  )
}

function PersonPicker({ value, onChange }: { value: PersonHit | null; onChange: (p: PersonHit | null) => void }) {
  const [term, setTerm] = useState("")
  const q = useDebounced(term.trim(), 250)
  const hits = useApi<{ results: PersonHit[] }>(
    ["calculator", "people", q],
    `/api/calculator/people?q=${encodeURIComponent(q)}`,
    { enabled: q.length >= 2 }
  )

  if (value) {
    return (
      <div className="space-y-1.5">
        <span className="block text-sm font-medium">Person, for their research threshold</span>
        <div className="flex items-center justify-between gap-2 rounded-control bg-sunken px-3 py-2">
          <FaceName person={value} link={false} size="sm" />
          <Button type="button" kind="quiet" size="sm" onClick={() => onChange(null)} aria-label={`Remove ${value.name}`}>
            <X aria-hidden />
            Remove
          </Button>
        </div>
        <p className="text-xs text-fg-muted">Applied to the first position ticked, as the next claim they are paid.</p>
      </div>
    )
  }
  return (
    <div className="space-y-1.5">
      <label htmlFor="calc-person" className="block text-sm font-medium">
        Person, for their research threshold (optional)
      </label>
      <Input
        id="calc-person"
        value={term}
        onChange={(e) => setTerm(e.target.value)}
        placeholder="Search by name, email or staff ID"
        autoComplete="off"
      />
      {q.length >= 2 && hits.data && (
        <ul className="divide-y divide-line rounded-control ring-1 ring-inset ring-line">
          {hits.data.results.length === 0 ? (
            <li className="px-3 py-2 text-sm text-fg-muted">No one by that name.</li>
          ) : (
            hits.data.results.map((p) => (
              <li key={p.user_id}>
                <button
                  type="button"
                  className="flex min-h-10 w-full items-center justify-between gap-2 px-3 py-1.5 text-left hover:bg-hover"
                  onClick={() => {
                    onChange(p)
                    setTerm("")
                  }}
                >
                  <FaceName person={p} link={false} />
                  <Meta className="shrink-0 text-xs">{p.research ? "Research faculty" : (p.department ?? "Regular faculty")}</Meta>
                </button>
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  )
}
