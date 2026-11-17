import { Plus, X } from "lucide-react"

import { Button } from "@/ui/button"
import { Checkbox, Field, Input, NumberInput, Select } from "@/ui/field"
import {
  BUCKETS,
  FUNCTIONS,
  functionsFor,
  hasDateGrouping,
  MAX_GROUPS,
  type Dataset,
  type Definition,
  type DatasetField,
  type Pivot,
  type ResultColumn,
  type SortKey,
  type Total,
} from "./model"

type Change = (patch: Partial<Definition>) => void

/* ------------------------------------------------------------------------ */
/* Group by                                                                  */
/* ------------------------------------------------------------------------ */

/**
 * "Group by": one row in the report for each department, each year and so on.
 * Up to three, in the order chosen, with a choice of how dates are cut up
 * once one of them is a date.
 */
export function GroupEditor({ dataset, def, change, off }: { dataset: Dataset; def: Definition; change: Change; off: boolean }) {
  const choices = dataset.fields.filter((f) => f.type !== "money")
  const set = (i: number, key: string) => change({ group_by: def.group_by.map((g, j) => (j === i ? key : g)) })

  return (
    <div className="space-y-3">
      {off && <p className="text-sm text-fg-muted">Not used while the grid below is on.</p>}
      <ul className="space-y-2">
        {def.group_by.map((key, i) => (
          <li key={`${i}-${key}`} className="flex items-center gap-2">
            <Select aria-label={`Group by ${i + 1}`} value={key} disabled={off} onChange={(e) => set(i, e.target.value)}>
              {choices
                .filter((f) => f.key === key || !def.group_by.includes(f.key))
                .map((f) => (
                  <option key={f.key} value={f.key}>
                    {f.label}
                  </option>
                ))}
            </Select>
            <Button
              type="button"
              kind="quiet"
              size="icon"
              aria-label={`Remove group ${i + 1}`}
              disabled={off}
              onClick={() => change({ group_by: def.group_by.filter((_, j) => j !== i) })}
            >
              <X />
            </Button>
          </li>
        ))}
      </ul>
      {def.group_by.length < MAX_GROUPS && (
        <Button
          type="button"
          kind="default"
          disabled={off}
          onClick={() => {
            const next = choices.find((f) => !def.group_by.includes(f.key))
            if (next) change({ group_by: [...def.group_by, next.key] })
          }}
        >
          <Plus />
          {def.group_by.length === 0 ? "Group the report" : "Add another group"}
        </Button>
      )}
      {def.group_by.length >= MAX_GROUPS && <p className="text-sm text-fg-muted">That is the most, three groups.</p>}
      {!off && hasDateGrouping(def, dataset) && (
        <Field label="Group dates">
          <Select value={def.date_bucket} onChange={(e) => change({ date_bucket: e.target.value })}>
            {BUCKETS.map((b) => (
              <option key={b.key} value={b.key}>
                {b.label}
              </option>
            ))}
          </Select>
        </Field>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------------ */
/* Add up                                                                    */
/* ------------------------------------------------------------------------ */

function fieldsFor(dataset: Dataset, fn: string): DatasetField[] {
  return dataset.fields.filter((f) => functionsFor(f).includes(fn))
}

/** The kinds of working-out the dataset offers anywhere, in a fixed order. */
function allFunctions(dataset: Dataset): string[] {
  const seen = new Set(dataset.fields.flatMap((f) => functionsFor(f)))
  const known = Object.keys(FUNCTIONS).filter((f) => seen.has(f))
  const extra = [...seen].filter((f) => !(f in FUNCTIONS))
  return [...known, ...extra]
}

export const functionLabel = (fn: string) => FUNCTIONS[fn] ?? fn

/**
 * "Add up": a total, an average, a count and so on, worked out for each group
 * (or for the whole report when nothing is grouped).
 */
export function TotalsEditor({ dataset, def, change, off }: { dataset: Dataset; def: Definition; change: Change; off: boolean }) {
  const fns = allFunctions(dataset)
  const set = (i: number, patch: Partial<Total>) =>
    change({ aggregates: def.aggregates.map((a, j) => (j === i ? { ...a, ...patch } : a)) })

  function changeFn(i: number, fn: string) {
    const current = def.aggregates[i]
    const ok = fieldsFor(dataset, fn)
    set(i, { fn, field: ok.some((f) => f.key === current.field) ? current.field : (ok[0]?.key ?? current.field) })
  }

  function add() {
    const sum = fieldsFor(dataset, "sum")[0]
    const fn = sum ? "sum" : "count"
    const field = sum ?? dataset.fields[0]
    if (field) change({ aggregates: [...def.aggregates, { fn, field: field.key }] })
  }

  return (
    <div className="space-y-3">
      {off && <p className="text-sm text-fg-muted">Not used while the grid below is on.</p>}
      <ul className="space-y-3">
        {def.aggregates.map((a, i) => (
          <li key={i} className="space-y-2 rounded-control bg-sunken p-3">
            <div className="flex items-start gap-2">
              <div className="grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)] gap-2">
                <Select aria-label={`Add up ${i + 1}: what to work out`} value={a.fn} disabled={off} onChange={(e) => changeFn(i, e.target.value)}>
                  {fns.map((fn) => (
                    <option key={fn} value={fn}>
                      {functionLabel(fn)}
                    </option>
                  ))}
                </Select>
                <Select aria-label={`Add up ${i + 1}: of which column`} value={a.field} disabled={off} onChange={(e) => set(i, { field: e.target.value })}>
                  {fieldsFor(dataset, a.fn).map((f) => (
                    <option key={f.key} value={f.key}>
                      {f.label}
                    </option>
                  ))}
                </Select>
                <Input
                  aria-label={`Add up ${i + 1}: name for the column (optional)`}
                  placeholder="Name for the column (optional)"
                  value={a.label ?? ""}
                  disabled={off}
                  onChange={(e) => set(i, { label: e.target.value })}
                />
              </div>
              <Button
                type="button"
                kind="quiet"
                size="icon"
                aria-label={`Remove add up ${i + 1}`}
                disabled={off}
                onClick={() => change({ aggregates: def.aggregates.filter((_, j) => j !== i) })}
              >
                <X />
              </Button>
            </div>
          </li>
        ))}
      </ul>
      <Button type="button" kind="default" disabled={off} onClick={add}>
        <Plus />
        Add a total
      </Button>
    </div>
  )
}

/* ------------------------------------------------------------------------ */
/* The grid                                                                  */
/* ------------------------------------------------------------------------ */

/**
 * "Show as a grid": one thing down the side, another across the top, and a
 * figure in every box where they meet. The cross-table people already make by
 * hand in Excel.
 */
export function PivotEditor({ dataset, def, change }: { dataset: Dataset; def: Definition; change: Change }) {
  const pivot = def.pivot
  const set = (patch: Partial<Pivot>) => pivot && change({ pivot: { ...pivot, ...patch } })
  const fields = dataset.fields.filter((f) => f.type !== "money")

  function turnOn() {
    const [a, b] = fields
    const sum = fieldsFor(dataset, "sum")[0]
    change({
      pivot: {
        rows: a?.key ?? "",
        columns: (b ?? a)?.key ?? "",
        value: sum ? { field: sum.key, fn: "sum" } : { field: dataset.fields[0]?.key ?? "", fn: "count" },
      },
    })
  }

  function changeFn(fn: string) {
    if (!pivot) return
    const ok = fieldsFor(dataset, fn)
    set({ value: { fn, field: ok.some((f) => f.key === pivot.value.field) ? pivot.value.field : (ok[0]?.key ?? pivot.value.field) } })
  }

  return (
    <div className="space-y-3">
      <Checkbox
        className="size-5"
        label="Show the report as a grid"
        hint="One thing down the side, another across the top."
        checked={!!pivot}
        onCheckedChange={(on) => (on === true ? turnOn() : change({ pivot: null }))}
      />
      {pivot && (
        <div className="grid grid-cols-[minmax(0,1fr)] gap-3 rounded-control bg-sunken p-3">
          <Field label="Down the side">
            <Select value={pivot.rows} onChange={(e) => set({ rows: e.target.value })}>
              {fields.map((f) => (
                <option key={f.key} value={f.key}>
                  {f.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Across the top">
            <Select value={pivot.columns} onChange={(e) => set({ columns: e.target.value })}>
              {fields.map((f) => (
                <option key={f.key} value={f.key}>
                  {f.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="In each box, work out">
            <Select value={pivot.value.fn} onChange={(e) => changeFn(e.target.value)}>
              {allFunctions(dataset).map((fn) => (
                <option key={fn} value={fn}>
                  {functionLabel(fn)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="In each box, of which column">
            <Select value={pivot.value.field} onChange={(e) => set({ value: { ...pivot.value, field: e.target.value } })}>
              {fieldsFor(dataset, pivot.value.fn).map((f) => (
                <option key={f.key} value={f.key}>
                  {f.label}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------------ */
/* Sort and top rows                                                         */
/* ------------------------------------------------------------------------ */

function directions(type: string): { dir: SortKey["dir"]; label: string }[] {
  if (type === "date") return [{ dir: "asc", label: "Oldest first" }, { dir: "desc", label: "Newest first" }]
  if (type === "number" || type === "money") return [{ dir: "asc", label: "Smallest first" }, { dir: "desc", label: "Largest first" }]
  return [{ dir: "asc", label: "A to Z" }, { dir: "desc", label: "Z to A" }]
}

/**
 * "Put in order" and "Only the top": how the rows are ordered, and how many of
 * them to keep. Once a report has been run, the columns it produced (a total,
 * say) can be sorted on too.
 */
export function OrderEditor({
  dataset,
  def,
  change,
  resultColumns,
}: {
  dataset: Dataset
  def: Definition
  change: Change
  resultColumns: ResultColumn[]
}) {
  const options: { key: string; label: string; type: string }[] = [
    ...dataset.fields.map((f) => ({ key: f.key, label: f.label, type: f.type })),
    ...resultColumns.filter((c) => !dataset.fields.some((f) => f.key === c.key)).map((c) => ({ key: c.key, label: c.label, type: c.type })),
  ]
  const typeOf = (key: string) => options.find((o) => o.key === key)?.type ?? "string"
  const set = (i: number, patch: Partial<SortKey>) => change({ sort: def.sort.map((s, j) => (j === i ? { ...s, ...patch } : s)) })

  return (
    <div className="space-y-3">
      <ul className="space-y-2">
        {def.sort.map((s, i) => (
          <li key={i} className="flex items-start gap-2">
            <div className="grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)] gap-2">
              <Select aria-label={`Order ${i + 1}: column`} value={s.field} onChange={(e) => set(i, { field: e.target.value, dir: "asc" })}>
                {options.map((o) => (
                  <option key={o.key} value={o.key}>
                    {o.label}
                  </option>
                ))}
              </Select>
              <Select aria-label={`Order ${i + 1}: direction`} value={s.dir} onChange={(e) => set(i, { dir: e.target.value === "desc" ? "desc" : "asc" })}>
                {directions(typeOf(s.field)).map((d) => (
                  <option key={d.dir} value={d.dir}>
                    {d.label}
                  </option>
                ))}
              </Select>
            </div>
            <Button
              type="button"
              kind="quiet"
              size="icon"
              aria-label={`Remove order ${i + 1}`}
              onClick={() => change({ sort: def.sort.filter((_, j) => j !== i) })}
            >
              <X />
            </Button>
          </li>
        ))}
      </ul>
      {def.sort.length < 3 && (
        <Button
          type="button"
          kind="default"
          onClick={() => {
            const first = options[0]
            if (first) change({ sort: [...def.sort, { field: first.key, dir: "asc" }] })
          }}
        >
          <Plus />
          {def.sort.length === 0 ? "Put the rows in order" : "Then by another column"}
        </Button>
      )}
      <Field label="Show only the top rows" hint="Leave empty to show them all. For example, 10 shows the first ten rows in the order above.">
        <NumberInput
          min={1}
          step={1}
          value={def.top_n ?? ""}
          onChange={(e) => change({ top_n: e.target.value === "" ? null : Math.max(1, Math.floor(Number(e.target.value))) })}
        />
      </Field>
    </div>
  )
}
