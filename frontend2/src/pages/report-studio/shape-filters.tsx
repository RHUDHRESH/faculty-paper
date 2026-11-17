import { Plus, X } from "lucide-react"

import { Button } from "@/ui/button"
import { Checkbox, DateInput, Input, NumberInput, Select } from "@/ui/field"
import {
  emptyValue,
  filterIsComplete,
  newFilter,
  OPS,
  type Dataset,
  type DatasetField,
  type UiFilter,
} from "./model"

/**
 * "Only where": the conditions a row must meet to be in the report.
 *
 * Each condition is a sentence the person builds left to right: a field, how
 * it is compared ("is more than", "is one of"), and a value. The comparison
 * choices and the value control both follow the kind of field, so a date is
 * always a date picker and a department is always a list of departments to
 * tick, never a box to type a spelling into.
 */
export function FiltersEditor({
  dataset,
  value,
  onChange,
}: {
  dataset: Dataset
  value: UiFilter[]
  onChange: (filters: UiFilter[]) => void
}) {
  const fieldOf = (key: string) => dataset.fields.find((f) => f.key === key)

  function patch(id: string, change: Partial<UiFilter>) {
    onChange(value.map((f) => (f.id === id ? { ...f, ...change } : f)))
  }

  function changeField(f: UiFilter, key: string) {
    const next = fieldOf(key)
    if (!next) return
    const fresh = newFilter(next)
    patch(f.id, { field: key, op: fresh.op, value: fresh.value })
  }

  function changeOp(f: UiFilter, field: DatasetField, op: string) {
    // A value survives a change of comparison only when it is the same shape:
    // one value, a pair (between) or a list (one of).
    const shape = (o: string) => (o === "between" ? "pair" : o === "in" || o === "not_in" ? "list" : "one")
    patch(f.id, { op, value: shape(op) === shape(f.op) ? f.value : emptyValue(field.type, op) })
  }

  return (
    <div className="space-y-3">
      {value.length === 0 && <p className="text-sm text-fg-muted">Every row is included. Add a condition to narrow it down.</p>}
      <ul className="space-y-3">
        {value.map((f, i) => {
          const field = fieldOf(f.field)
          if (!field) return null
          return (
            <li key={f.id} className="space-y-2 rounded-control bg-sunken p-3">
              <div className="flex items-start gap-2">
                <div className="grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)] gap-2">
                  <Select
                    aria-label={`Condition ${i + 1}: field`}
                    value={f.field}
                    onChange={(e) => changeField(f, e.target.value)}
                  >
                    {dataset.fields.map((x) => (
                      <option key={x.key} value={x.key}>
                        {x.label}
                      </option>
                    ))}
                  </Select>
                  <Select
                    aria-label={`Condition ${i + 1}: how to compare`}
                    value={f.op}
                    onChange={(e) => changeOp(f, field, e.target.value)}
                  >
                    {OPS[field.type].map((o) => (
                      <option key={o.op} value={o.op}>
                        {o.label}
                      </option>
                    ))}
                  </Select>
                  <ValueInput n={i + 1} field={field} filter={f} onChange={(v) => patch(f.id, { value: v })} />
                </div>
                <Button
                  type="button"
                  kind="quiet"
                  size="icon"
                  aria-label={`Remove condition ${i + 1}`}
                  onClick={() => onChange(value.filter((x) => x.id !== f.id))}
                >
                  <X />
                </Button>
              </div>
              {!filterIsComplete(f) && (
                <p className="text-sm text-fg-muted">Not used yet. Fill in a value, or remove it.</p>
              )}
            </li>
          )
        })}
      </ul>
      <Button
        type="button"
        kind="default"
        onClick={() => {
          const first = dataset.fields[0]
          if (first) onChange([...value, newFilter(first)])
        }}
      >
        <Plus />
        Add a condition
      </Button>
    </div>
  )
}

function ValueInput({
  n,
  field,
  filter,
  onChange,
}: {
  n: number
  field: DatasetField
  filter: UiFilter
  onChange: (value: unknown) => void
}) {
  const name = `Condition ${n}`
  const text = (v: unknown) => (typeof v === "string" || typeof v === "number" ? String(v) : "")
  const pair = Array.isArray(filter.value) ? filter.value : ["", ""]

  if (field.type === "enum") {
    const chosen = Array.isArray(filter.value) ? filter.value.map(String) : []
    if (field.options.length === 0) {
      // The server did not list the choices: type them, separated by commas.
      return (
        <Input
          aria-label={`${name}: values, separated by commas`}
          placeholder="Type values, separated by commas"
          value={chosen.join(", ")}
          onChange={(e) => onChange(e.target.value.split(",").map((s) => s.trim()).filter(Boolean))}
        />
      )
    }
    return (
      <ul aria-label={`${name}: choose one or more`} className="max-h-48 space-y-0.5 overflow-y-auto rounded-control bg-surface p-1 ring-1 ring-inset ring-edge">
        {field.options.map((o) => (
          <li key={o.value} className="rounded-control px-2 py-2 hover:bg-hover">
            <Checkbox
className="size-5"
              label={o.label}
              checked={chosen.includes(o.value)}
              onCheckedChange={(on) => onChange(on === true ? [...chosen, o.value] : chosen.filter((v) => v !== o.value))}
            />
          </li>
        ))}
      </ul>
    )
  }

  if (field.type === "bool") {
    return (
      <Select aria-label={`${name}: yes or no`} value={text(filter.value) || "true"} onChange={(e) => onChange(e.target.value)}>
        <option value="true">Yes</option>
        <option value="false">No</option>
      </Select>
    )
  }

  if (field.type === "date") {
    if (filter.op === "between") {
      return (
        <div className="grid grid-cols-[minmax(0,1fr)] gap-2 sm:grid-cols-2">
          <DateInput aria-label={`${name}: from`} value={text(pair[0])} onChange={(e) => onChange([e.target.value, text(pair[1])])} />
          <DateInput aria-label={`${name}: to`} value={text(pair[1])} onChange={(e) => onChange([text(pair[0]), e.target.value])} />
        </div>
      )
    }
    return <DateInput aria-label={`${name}: date`} value={text(filter.value)} onChange={(e) => onChange(e.target.value)} />
  }

  if (field.type === "number" || field.type === "money") {
    const unit = field.type === "money" ? "₹" : undefined
    if (filter.op === "between") {
      return (
        <div className="grid grid-cols-[minmax(0,1fr)] gap-2 sm:grid-cols-2">
          <NumberInput aria-label={`${name}: from`} unit={unit} value={text(pair[0])} onChange={(e) => onChange([e.target.value, text(pair[1])])} />
          <NumberInput aria-label={`${name}: to`} unit={unit} value={text(pair[1])} onChange={(e) => onChange([text(pair[0]), e.target.value])} />
        </div>
      )
    }
    return <NumberInput aria-label={`${name}: number`} unit={unit} value={text(filter.value)} onChange={(e) => onChange(e.target.value)} />
  }

  return <Input aria-label={`${name}: text`} value={text(filter.value)} onChange={(e) => onChange(e.target.value)} />
}
