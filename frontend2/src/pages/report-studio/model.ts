import { money } from "@/ui/paper"

/**
 * What the Report studio knows about a report, with no screen in it.
 *
 * The server owns the list of datasets, the fields in each and what a run
 * costs; this file owns the shape of a report as the designer edits it and
 * the one function (`buildRunBody`) that turns it into what `/api/reports/run`
 * and `/api/reports/export` are sent. Keeping that function pure is what lets
 * a test say "this request is exactly right" without drawing anything.
 *
 * The words people read live here too (`OPS`, `FUNCTIONS`, `BUCKETS`): the
 * server's names for an operator or a function never reach a screen.
 */

export type FieldType = "string" | "number" | "money" | "date" | "enum" | "bool"

export type Option = { value: string; label: string }

export type DatasetField = {
  key: string
  label: string
  type: FieldType
  /** The choices of an enum field. */
  options: Option[]
  /** What the server will work out for this field, when it says. */
  functions: string[] | null
  description: string
}

export type Dataset = {
  key: string
  label: string
  description: string
  fields: DatasetField[]
}

export type UiFilter = { id: string; field: string; op: string; value: unknown }
export type Total = { field: string; fn: string; label?: string }
export type Pivot = { rows: string; columns: string; value: { field: string; fn: string } }
export type SortKey = { field: string; dir: "asc" | "desc" }

/** A report as the designer holds it. */
export type Definition = {
  dataset: string
  columns: string[]
  filters: UiFilter[]
  group_by: string[]
  date_bucket: string
  aggregates: Total[]
  pivot: Pivot | null
  sort: SortKey[]
  limit: number
  top_n: number | null
}

export type ResultColumn = { key: string; label: string; type: FieldType }
export type ChartHint = { kind: string | null; x: string | null; y: string | null }
export type RunResult = {
  columns: ResultColumn[]
  rows: unknown[]
  total_rows: number
  truncated: boolean
  chart_hint: ChartHint | null
}

export type Visibility = "private" | "role" | "everyone"

export type Schedule = {
  frequency: "weekly" | "monthly"
  day: number
  hour: number
  format: "xlsx" | "pdf" | "csv"
  recipients: { id: string; name: string }[]
}

export type SavedReport = {
  id: string
  name: string
  description: string
  dataset: string
  visibility: Visibility
  mine: boolean
  owner: string
  last_run_at: string | null
  schedule: Schedule | null
  feed_url: string | null
  definition: Definition
}

export type Template = {
  key: string
  name: string
  description: string
  dataset: string
  definition: Definition
}

/* ------------------------------------------------------------------------ */
/* Words                                                                     */
/* ------------------------------------------------------------------------ */

type OpChoice = { op: string; label: string }

/** Conditions a person can set, by the kind of field. */
export const OPS: Record<FieldType, OpChoice[]> = {
  string: [
    { op: "contains", label: "contains" },
    { op: "eq", label: "is exactly" },
    { op: "ne", label: "is not" },
  ],
  number: [
    { op: "eq", label: "is" },
    { op: "gt", label: "is more than" },
    { op: "gte", label: "is at least" },
    { op: "lt", label: "is less than" },
    { op: "lte", label: "is at most" },
    { op: "between", label: "is between" },
  ],
  money: [
    { op: "eq", label: "is" },
    { op: "gt", label: "is more than" },
    { op: "gte", label: "is at least" },
    { op: "lt", label: "is less than" },
    { op: "lte", label: "is at most" },
    { op: "between", label: "is between" },
  ],
  date: [
    { op: "eq", label: "is on" },
    { op: "gt", label: "is after" },
    { op: "lt", label: "is before" },
    { op: "between", label: "is between" },
  ],
  enum: [
    { op: "in", label: "is one of" },
    { op: "not_in", label: "is not one of" },
  ],
  bool: [{ op: "eq", label: "is" }],
}

/** What to work out. The server's name on the left, a person's word on the right. */
export const FUNCTIONS: Record<string, string> = {
  sum: "Total",
  avg: "Average",
  min: "Smallest",
  max: "Largest",
  count: "How many",
  count_distinct: "How many different",
}

const NUMERIC_FUNCTIONS = ["sum", "avg", "min", "max", "count"]

export function functionsFor(field: DatasetField | undefined): string[] {
  if (!field) return ["count"]
  if (field.functions && field.functions.length > 0) return field.functions
  if (field.type === "number" || field.type === "money") return NUMERIC_FUNCTIONS
  if (field.type === "date") return ["min", "max", "count"]
  return ["count"]
}

/** How dates are cut up when they are grouped. `none` leaves them as they are. */
export const BUCKETS: { key: string; label: string }[] = [
  { key: "none", label: "As they are" },
  { key: "month", label: "By month" },
  { key: "quarter", label: "By quarter" },
  { key: "year", label: "By year" },
  { key: "academic_year", label: "By academic year" },
]

export const BUCKET_WORDS: Record<string, string> = {
  month: "month",
  quarter: "quarter",
  year: "year",
  academic_year: "academic year",
}

export const MAX_GROUPS = 3

export const VISIBILITY: { key: Visibility; label: string; hint: string }[] = [
  { key: "private", label: "Only me", hint: "Nobody else can see it." },
  { key: "role", label: "People in my role", hint: "Everyone with the same role as you can open it." },
  { key: "everyone", label: "Everyone who can make reports", hint: "Anyone who uses the Report studio can open it." },
]

/** Weekdays, Monday first, as the schedule stores them. */
export const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]

export const FILE_FORMATS: { key: "xlsx" | "pdf" | "csv"; label: string }[] = [
  { key: "xlsx", label: "Excel" },
  { key: "pdf", label: "PDF" },
  { key: "csv", label: "CSV" },
]

export function hourLabel(hour: number): string {
  const h = ((hour + 11) % 12) + 1
  return `${h}:00 ${hour < 12 ? "am" : "pm"}`
}

export function ordinal(n: number): string {
  const v = n % 100
  if (v >= 11 && v <= 13) return `${n}th`
  return `${n}${({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th"}`
}

/** "Every Monday at 8:00 am, as Excel". */
export function describeSchedule(s: Schedule | null): string {
  if (!s) return "Not scheduled"
  const when =
    s.frequency === "weekly" ? `Every ${WEEKDAYS[s.day] ?? "week"}` : `On the ${ordinal(s.day)} of every month`
  const file = FILE_FORMATS.find((f) => f.key === s.format)?.label ?? s.format
  return `${when} at ${hourLabel(s.hour)}, as ${file}`
}

/* ------------------------------------------------------------------------ */
/* Reading what the server sends                                             */
/* ------------------------------------------------------------------------ */

const FIELD_TYPES: FieldType[] = ["string", "number", "money", "date", "enum", "bool"]

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)
const str = (v: unknown, fallback = ""): string =>
  typeof v === "string" ? v : typeof v === "number" ? String(v) : fallback

function listOf(raw: unknown, ...keys: string[]): unknown[] {
  if (Array.isArray(raw)) return raw
  if (isRecord(raw)) {
    for (const k of keys) if (Array.isArray(raw[k])) return raw[k] as unknown[]
  }
  return []
}

function readOptions(raw: unknown): Option[] {
  const list = Array.isArray(raw) ? raw : []
  return list.flatMap((o): Option[] => {
    if (typeof o === "string" || typeof o === "number") return [{ value: String(o), label: String(o) }]
    if (isRecord(o)) {
      const value = str(o.value ?? o.key ?? o.id)
      return value ? [{ value, label: str(o.label ?? o.name, value) }] : []
    }
    return []
  })
}

function readField(raw: unknown): DatasetField | null {
  if (!isRecord(raw)) return null
  const key = str(raw.key ?? raw.name)
  if (!key) return null
  const type = FIELD_TYPES.includes(raw.type as FieldType) ? (raw.type as FieldType) : "string"
  const fns = raw.functions ?? raw.aggregates
  return {
    key,
    label: str(raw.label, key),
    type,
    options: readOptions(raw.options ?? raw.values ?? raw.choices),
    functions: Array.isArray(fns) ? fns.filter((f): f is string => typeof f === "string") : null,
    description: str(raw.description),
  }
}

export function readDatasets(raw: unknown): Dataset[] {
  return listOf(raw, "datasets", "results").flatMap((d): Dataset[] => {
    if (!isRecord(d)) return []
    const key = str(d.key ?? d.id ?? d.name)
    if (!key) return []
    const fields = listOf(d.fields).flatMap((f) => {
      const one = readField(f)
      return one ? [one] : []
    })
    return [{ key, label: str(d.label ?? d.title, key), description: str(d.description), fields }]
  })
}

let counter = 0
export function newId(): string {
  counter += 1
  return `f${counter}`
}

export function emptyDefinition(dataset = ""): Definition {
  return {
    dataset,
    columns: [],
    filters: [],
    group_by: [],
    date_bucket: "none",
    aggregates: [],
    pivot: null,
    sort: [],
    limit: 1000,
    top_n: null,
  }
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [])

/** A definition from a template, a saved report or the AI, with every part present. */
export function readDefinition(raw: unknown, fallbackDataset = ""): Definition {
  const r = isRecord(raw) ? raw : {}
  const base = emptyDefinition(str(r.dataset, fallbackDataset))
  const pivot = isRecord(r.pivot) && isRecord(r.pivot.value) ? r.pivot : null
  const pivotValue = pivot && isRecord(pivot.value) ? pivot.value : {}
  return {
    ...base,
    columns: strings(r.columns),
    filters: listOf(r.filters).flatMap((f): UiFilter[] =>
      isRecord(f) && str(f.field) ? [{ id: newId(), field: str(f.field), op: str(f.op, "eq"), value: f.value }] : []
    ),
    group_by: strings(r.group_by).slice(0, MAX_GROUPS),
    date_bucket: str(r.date_bucket) || "none",
    aggregates: listOf(r.aggregates).flatMap((a): Total[] =>
      isRecord(a) && str(a.field) && str(a.fn)
        ? [{ field: str(a.field), fn: str(a.fn), ...(str(a.label) ? { label: str(a.label) } : {}) }]
        : []
    ),
    pivot: pivot
      ? {
          rows: str(pivot.rows),
          columns: str(pivot.columns),
          value: { field: str(pivotValue.field), fn: str(pivotValue.fn, "count") },
        }
      : null,
    sort: listOf(r.sort).flatMap((s): SortKey[] =>
      isRecord(s) && str(s.field) ? [{ field: str(s.field), dir: s.dir === "desc" ? "desc" : "asc" }] : []
    ),
    limit: typeof r.limit === "number" && r.limit > 0 ? r.limit : base.limit,
    top_n: typeof r.top_n === "number" && r.top_n > 0 ? r.top_n : null,
  }
}

export function readSchedule(raw: unknown): Schedule | null {
  if (!isRecord(raw)) return null
  const frequency = raw.frequency === "monthly" ? "monthly" : raw.frequency === "weekly" ? "weekly" : null
  if (!frequency) return null
  const format = raw.format === "pdf" || raw.format === "csv" ? raw.format : "xlsx"
  const people = listOf(raw.recipients).flatMap((p): { id: string; name: string }[] => {
    if (typeof p === "string" || typeof p === "number") return [{ id: String(p), name: String(p) }]
    if (isRecord(p) && str(p.id ?? p.user_id)) {
      return [{ id: str(p.id ?? p.user_id), name: str(p.name ?? p.label, str(p.id ?? p.user_id)) }]
    }
    return []
  })
  return {
    frequency,
    day: typeof raw.day === "number" ? raw.day : Number(raw.day) || (frequency === "weekly" ? 0 : 1),
    hour: typeof raw.hour === "number" ? raw.hour : Number(raw.hour) || 8,
    format,
    recipients: people,
  }
}

export function readSaved(raw: unknown, mineHint?: boolean): SavedReport | null {
  if (!isRecord(raw)) return null
  const id = str(raw.id)
  if (!id) return null
  const owner = isRecord(raw.owner) ? str(raw.owner.name) : str(raw.owner_name ?? raw.owner)
  const def = readDefinition(raw.definition ?? raw, str(raw.dataset))
  const visibility = raw.visibility === "role" || raw.visibility === "everyone" ? raw.visibility : "private"
  return {
    id,
    name: str(raw.name, "Untitled report"),
    description: str(raw.description),
    dataset: str(raw.dataset, def.dataset),
    visibility,
    mine: typeof raw.mine === "boolean" ? raw.mine : (mineHint ?? true),
    owner,
    last_run_at: typeof raw.last_run_at === "string" ? raw.last_run_at : null,
    schedule: readSchedule(raw.schedule),
    feed_url: typeof raw.feed_url === "string" && raw.feed_url ? raw.feed_url : null,
    definition: def,
  }
}

/** Both lists on the start screen, whether the server sends one list or two. */
export function readSavedLists(raw: unknown): { mine: SavedReport[]; shared: SavedReport[] } {
  if (isRecord(raw) && (Array.isArray(raw.mine) || Array.isArray(raw.shared))) {
    const take = (v: unknown, mine: boolean) =>
      (Array.isArray(v) ? v : []).flatMap((x) => {
        const one = readSaved(x, mine)
        return one ? [{ ...one, mine }] : []
      })
    return { mine: take(raw.mine, true), shared: take(raw.shared, false) }
  }
  const all = listOf(raw, "results", "reports").flatMap((x) => {
    const one = readSaved(x)
    return one ? [one] : []
  })
  return { mine: all.filter((r) => r.mine), shared: all.filter((r) => !r.mine) }
}

export function readTemplates(raw: unknown): Template[] {
  return listOf(raw, "templates", "results").flatMap((t): Template[] => {
    if (!isRecord(t)) return []
    const key = str(t.key ?? t.id ?? t.slug)
    if (!key) return []
    const def = readDefinition(t.definition ?? t, str(t.dataset))
    return [{ key, name: str(t.name ?? t.title, key), description: str(t.description), dataset: def.dataset, definition: def }]
  })
}

/* ------------------------------------------------------------------------ */
/* The request                                                               */
/* ------------------------------------------------------------------------ */

export function fieldOf(dataset: Dataset | undefined, key: string): DatasetField | undefined {
  return dataset?.fields.find((f) => f.key === key)
}

export function emptyValue(type: FieldType, op: string): unknown {
  if (op === "in" || op === "not_in") return []
  if (op === "between") return ["", ""]
  if (type === "bool") return "true"
  return ""
}

/** The first condition a field offers, with an empty value to fill in. */
export function newFilter(field: DatasetField): UiFilter {
  const op = OPS[field.type][0].op
  return { id: newId(), field: field.key, op, value: emptyValue(field.type, op) }
}

function blank(v: unknown): boolean {
  return v === "" || v === null || v === undefined
}

/** Whether a condition has everything it needs to be sent. */
export function filterIsComplete(f: UiFilter): boolean {
  if (Array.isArray(f.value)) {
    if (f.op === "between") return f.value.length === 2 && f.value.every((v) => !blank(v))
    return f.value.length > 0
  }
  return !blank(f.value)
}

function sendValue(type: FieldType, op: string, value: unknown): unknown {
  const one = (v: unknown) => {
    if (type === "number" || type === "money") return Number(v)
    if (type === "bool") return v === true || v === "true"
    return v
  }
  if (Array.isArray(value)) return op === "between" ? value.map(one) : value
  return one(value)
}

const usesDate = (dataset: Dataset | undefined, keys: string[]) =>
  keys.some((k) => fieldOf(dataset, k)?.type === "date")

export function pivotComplete(p: Pivot | null): p is Pivot {
  return !!p && !!p.rows && !!p.columns && !!p.value.field && !!p.value.fn
}

/** What `/api/reports/run` and `/api/reports/export` are sent. */
export function buildRunBody(def: Definition, dataset: Dataset | undefined) {
  const pivot = pivotComplete(def.pivot) ? def.pivot : null
  const bucketed = usesDate(dataset, pivot ? [pivot.rows, pivot.columns] : def.group_by)
  return {
    dataset: def.dataset,
    columns: def.columns,
    filters: def.filters
      .filter(filterIsComplete)
      .map((f) => ({
        field: f.field,
        op: f.op,
        value: sendValue(fieldOf(dataset, f.field)?.type ?? "string", f.op, f.value),
      })),
    // A grid is its own shape: groups and totals are not mixed into it.
    group_by: pivot ? [] : def.group_by,
    date_bucket: bucketed && def.date_bucket !== "none" ? def.date_bucket : null,
    aggregates: pivot
      ? []
      : def.aggregates
          .filter((a) => a.field && a.fn)
          .map((a) => ({ field: a.field, fn: a.fn, ...(a.label?.trim() ? { label: a.label.trim() } : {}) })),
    pivot: pivot ? { rows: pivot.rows, columns: pivot.columns, value: { ...pivot.value } } : null,
    sort: def.sort.filter((s) => s.field),
    limit: def.limit,
    top_n: def.top_n,
  }
}

export type RunBody = ReturnType<typeof buildRunBody>

/** Plain reasons a report cannot be run yet. Empty means go ahead. */
export function problemsWith(def: Definition): string[] {
  const out: string[] = []
  if (!def.dataset) out.push("Choose what the report is about.")
  const shaped = def.group_by.length > 0 || def.aggregates.length > 0 || pivotComplete(def.pivot)
  if (def.dataset && def.columns.length === 0 && !shaped) {
    out.push("Choose at least one thing to show, or group the report.")
  }
  if (def.pivot && !pivotComplete(def.pivot)) {
    out.push("Finish the grid: choose the rows, the columns and what to put in each box.")
  }
  return out
}

/* ------------------------------------------------------------------------ */
/* Reading a result                                                          */
/* ------------------------------------------------------------------------ */

export function readResult(raw: unknown): RunResult {
  const r = isRecord(raw) ? raw : {}
  const columns = listOf(r.columns).flatMap((c): ResultColumn[] => {
    if (typeof c === "string") return [{ key: c, label: c, type: "string" }]
    if (!isRecord(c) || !str(c.key)) return []
    return [
      {
        key: str(c.key),
        label: str(c.label, str(c.key)),
        type: FIELD_TYPES.includes(c.type as FieldType) ? (c.type as FieldType) : "string",
      },
    ]
  })
  const rows = Array.isArray(r.rows) ? r.rows : []
  const hint = isRecord(r.chart_hint)
    ? {
        kind: typeof r.chart_hint.kind === "string" ? r.chart_hint.kind : null,
        x: typeof r.chart_hint.x === "string" ? r.chart_hint.x : null,
        // The server names the value column as a list (it can suggest several); the chart draws the first.
        y:
          typeof r.chart_hint.y === "string"
            ? r.chart_hint.y
            : Array.isArray(r.chart_hint.y) && typeof r.chart_hint.y[0] === "string"
              ? r.chart_hint.y[0]
              : null,
      }
    : null
  return {
    columns,
    rows,
    total_rows: typeof r.total_rows === "number" ? r.total_rows : rows.length,
    truncated: r.truncated === true,
    chart_hint: hint,
  }
}

/** Rows as objects by column key, whichever way the server sent them. */
export function rowObjects(result: RunResult): Record<string, unknown>[] {
  return result.rows.map((row) => {
    if (Array.isArray(row)) return Object.fromEntries(result.columns.map((c, i) => [c.key, row[i]]))
    return isRecord(row) ? row : {}
  })
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

/** "2026-04-01" as "1 Apr 2026" and "2026-04" as "Apr 2026"; anything else as it came. */
export function formatDate(value: string): string {
  const full = /^(\d{4})-(\d{2})-(\d{2})/.exec(value)
  if (full) return `${Number(full[3])} ${MONTHS[Number(full[2]) - 1] ?? full[2]} ${full[1]}`
  const month = /^(\d{4})-(\d{2})$/.exec(value)
  if (month) return `${MONTHS[Number(month[2]) - 1] ?? month[2]} ${month[1]}`
  return value
}

/** A cell as a person reads it. Null stays null so the table says "Not recorded". */
export function formatCell(type: FieldType, value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null
  switch (type) {
    case "money":
      return typeof value === "number" || /^-?\d+(\.\d+)?$/.test(String(value)) ? money(Number(value)) : String(value)
    case "number":
      return typeof value === "number" ? value.toLocaleString("en-IN", { maximumFractionDigits: 2 }) : String(value)
    case "date":
      return formatDate(String(value))
    case "bool":
      return value === true || value === "true" ? "Yes" : "No"
    default:
      return String(value)
  }
}

function andList(items: string[]): string {
  if (items.length <= 1) return items.join("")
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`
}

/** "1,234 rows, grouped by department and academic year". */
export function describeResult(def: Definition, dataset: Dataset | undefined, result: RunResult): string {
  const n = result.total_rows
  const lead = `${n.toLocaleString("en-IN")} ${n === 1 ? "row" : "rows"}`
  const label = (k: string) => (fieldOf(dataset, k)?.label ?? k).toLowerCase()
  const pivot = pivotComplete(def.pivot) ? def.pivot : null
  const bucket = BUCKET_WORDS[def.date_bucket]
  const named = (keys: string[]) =>
    keys.map((k) => (bucket && fieldOf(dataset, k)?.type === "date" ? `${label(k)} (by ${bucket})` : label(k)))
  const parts: string[] = [lead]
  if (pivot) {
    parts.push(`as a grid of ${named([pivot.rows])[0]} down the side and ${named([pivot.columns])[0]} across the top`)
  } else if (def.group_by.length > 0) {
    parts.push(`grouped by ${andList(named(def.group_by))}`)
  }
  const conditions = def.filters.filter(filterIsComplete).length
  if (conditions > 0) parts.push(`narrowed by ${conditions} ${conditions === 1 ? "condition" : "conditions"}`)
  return parts.join(", ")
}

/** True when the grouping puts a date in the report, so the month/year choice matters. */
export function hasDateGrouping(def: Definition, dataset: Dataset | undefined): boolean {
  return usesDate(dataset, pivotComplete(def.pivot) ? [def.pivot.rows, def.pivot.columns] : def.group_by)
}
