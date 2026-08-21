"use client"

import { useEffect, useMemo, useState } from "react"
import { toast } from "sonner"
import {
  ChevronRight,
  Database,
  Download,
  Filter,
  Pencil,
  Search,
  X,
} from "lucide-react"

import { Callout } from "@/components/form/fields"
import { EmptyState, ErrorState, PageHeader, Section } from "@/components/layout/page"
import { formatDateTime } from "@/components/ticket-ui"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Pager } from "@/components/ui/pagination"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { API_BASE, api } from "@/lib/api"
import { useApiQuery } from "@/lib/queries"
import { cn } from "@/lib/utils"

/**
 * The data underneath, readable without a database client.
 *
 * Every table, every column that is not a secret, any filter, and the rows in
 * whichever format the reader works in. What it deliberately is not is a
 * database shell: the columns the workflow owns are read-only here, because a
 * grid that could set `status = PAID` would make every guard in the system
 * optional. Reference data is correctable, one value at a time, with the
 * reason recorded.
 */

const PAGE = 50

type Column = {
  name: string
  label: string
  type: string
  editable: boolean
  highlighted: boolean
  related: string | null
  choices: string[] | null
}

type TableInfo = {
  name: string
  label: string
  about: string
  group: string
  rows: number
  columns: number
  editable: boolean
}

type Rows = {
  table: { name: string; label: string; about: string; group: string }
  columns: Column[]
  highlight: string[]
  rows: Record<string, unknown>[]
  total: number
  limit: number
  offset: number
  sort: string
  may_edit: boolean
}

const FORMATS = [
  { value: "csv", label: "CSV" },
  { value: "xlsx", label: "Excel" },
  { value: "json", label: "JSON" },
  { value: "tsv", label: "TSV" },
  { value: "md", label: "Markdown" },
]

/** A cell the eye can scan: dates read as dates, nothing runs off the row. */
function cell(value: unknown, type: string, column = ""): string {
  if (value === null || value === undefined || value === "") return "—"
  if (type === "boolean") return value ? "yes" : "no"
  if (type === "datetime") return formatDateTime(String(value))
  if (type === "number") {
    // A year is a number the database's sense but not the reader's: grouping
    // it renders 2026 as "2,026".
    if (/year/i.test(column)) return String(value)
    const n = Number(value)
    return Number.isFinite(n)
      ? n.toLocaleString(undefined, { maximumFractionDigits: 2 })
      : String(value)
  }
  return String(value)
}

export function DataExplorerPage() {
  const [table, setTable] = useState<string | null>(null)
  const [q, setQ] = useState("")
  const [term, setTerm] = useState("")
  const [filters, setFilters] = useState<{ column: string; value: string }[]>([])
  const [sort, setSort] = useState("")
  const [offset, setOffset] = useState(0)
  const [open, setOpen] = useState<Record<string, unknown> | null>(null)
  const [edit, setEdit] = useState<{ column: Column; row: Record<string, unknown> } | null>(null)
  const [draft, setDraft] = useState("")
  const [reason, setReason] = useState("")
  const [busy, setBusy] = useState(false)

  const { data: catalogue, isError: catalogueError, refetch: refetchTables } =
    useApiQuery<{ tables: TableInfo[]; may_edit: boolean; note: string }>(
      ["data-tables"],
      "/api/admin/data/tables"
    )

  const query = useMemo(() => {
    const p = new URLSearchParams({ limit: String(PAGE), offset: String(offset) })
    if (term.trim()) p.set("q", term.trim())
    if (sort) p.set("sort", sort)
    const active = filters.filter((f) => f.column && f.value !== "")
    if (active.length) p.set("filters", active.map((f) => `${f.column}:${f.value}`).join("|"))
    return p.toString()
  }, [term, sort, filters, offset])

  const { data, isLoading, isError, refetch } = useApiQuery<Rows>(
    ["data-rows", table, query],
    `/api/admin/data/${table}?${query}`,
    { enabled: !!table }
  )

  useEffect(() => {
    setOffset(0)
  }, [term, sort, filters, table])

  const grouped = useMemo(() => {
    const out: Record<string, TableInfo[]> = {}
    for (const t of catalogue?.tables || []) (out[t.group] ||= []).push(t)
    return out
  }, [catalogue])

  const shown = useMemo(() => {
    if (!data) return []
    // Highlighted columns first, then the rest: ninety-five columns in schema
    // order puts the interesting ones nowhere near the left edge.
    const highlighted = data.columns.filter((c) => c.highlighted)
    const rest = data.columns.filter((c) => !c.highlighted)
    return [...highlighted, ...rest]
  }, [data])

  async function saveEdit() {
    if (!edit || !table) return
    if (reason.trim().length < 5) {
      toast.error("Say why this is being changed")
      return
    }
    setBusy(true)
    try {
      const res = await api<{ was: string }>(
        `/api/admin/data/${table}/${edit.row.id}`,
        {
          method: "PATCH",
          json: { column: edit.column.name, value: draft, reason: reason.trim() },
        }
      )
      toast.success(`${edit.column.name}: ${res.was} → ${draft || "empty"}`)
      setEdit(null)
      setReason("")
      await refetch()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save that")
    } finally {
      setBusy(false)
    }
  }

  if (catalogueError) return <ErrorState onRetry={() => refetchTables()} />

  // ---- the table picker -----------------------------------------------
  if (!table) {
    return (
      <div className="space-y-6">
        <PageHeader
          title="Data"
          subtitle="Every table underneath, readable without a database client"
        />
        {catalogue?.note ? (
          <Callout tone="info" title="Wide to read, narrow to write">
            {catalogue.note}
          </Callout>
        ) : null}

        {Object.entries(grouped).map(([group, tables]) => (
          <Section key={group} title={group}>
            <div className="grid gap-3 sm:grid-cols-2">
              {tables.map((t) => (
                <button
                  key={t.name}
                  type="button"
                  onClick={() => {
                    setTable(t.name)
                    setSort("")
                    setFilters([])
                    setQ("")
                    setTerm("")
                  }}
                  className="interactive rounded-[var(--radius)] border border-border bg-card p-4 text-left hover:border-primary/50"
                >
                  <div className="flex items-start justify-between gap-3">
                    <span className="flex items-center gap-2 font-medium text-foreground">
                      <Database className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                      {t.label}
                    </span>
                    <span className="shrink-0 text-sm tabular-nums text-muted-foreground">
                      {t.rows.toLocaleString()}
                    </span>
                  </div>
                  <p className="mt-1.5 text-xs text-muted-foreground">{t.about}</p>
                  <p className="mt-2 text-xs text-muted-foreground">
                    {t.columns} columns
                    {t.editable ? " · correctable here" : " · read-only"}
                  </p>
                </button>
              ))}
            </div>
          </Section>
        ))}
      </div>
    )
  }

  // ---- one table -------------------------------------------------------
  return (
    <div className="space-y-5">
      <PageHeader
        title={data?.table.label || table}
        subtitle={data?.table.about}
        actions={
          <div className="flex flex-wrap gap-2">
            <Button variant="ghost" onClick={() => setTable(null)}>
              All tables
            </Button>
            {FORMATS.map((f) => (
              <Button key={f.value} asChild variant="secondary" size="sm">
                <a href={`${API_BASE}/api/admin/data/${table}/export?${query}&fmt=${f.value}`}>
                  <Download className="size-3.5" />
                  {f.label}
                </a>
              </Button>
            ))}
          </div>
        }
      />

      <div className="flex flex-wrap items-end gap-3">
        <form
          className="flex items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            setTerm(q)
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="dx-q" className="text-xs">
              Search every text column
            </Label>
            <div className="relative w-64">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input id="dx-q" className="pl-9" value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
          </div>
          <Button type="submit" variant="secondary">
            Search
          </Button>
        </form>

        <div className="space-y-1.5">
          <Label htmlFor="dx-sort" className="text-xs">
            Sort
          </Label>
          <Select value={sort || data?.sort || ""} onValueChange={setSort}>
            <SelectTrigger id="dx-sort" className="w-56">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(data?.columns || []).map((c) => (
                <SelectItem key={c.name} value={c.name}>
                  {c.name} ↑
                </SelectItem>
              ))}
              {(data?.columns || []).map((c) => (
                <SelectItem key={`-${c.name}`} value={`-${c.name}`}>
                  {c.name} ↓
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <Button
          variant="secondary"
          onClick={() => setFilters((f) => [...f, { column: "", value: "" }])}
        >
          <Filter className="size-4" />
          Add a filter
        </Button>
      </div>

      {filters.length ? (
        <div className="space-y-2">
          {filters.map((f, i) => (
            <div key={i} className="flex flex-wrap items-center gap-2">
              <Select
                value={f.column}
                onValueChange={(v) =>
                  setFilters((all) => all.map((x, n) => (n === i ? { ...x, column: v } : x)))
                }
              >
                <SelectTrigger className="w-56">
                  <SelectValue placeholder="Column" />
                </SelectTrigger>
                <SelectContent>
                  {(data?.columns || []).map((c) => (
                    <SelectItem key={c.name} value={c.name}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Input
                className="w-56"
                placeholder="contains… (empty matches blanks)"
                value={f.value}
                onChange={(e) =>
                  setFilters((all) =>
                    all.map((x, n) => (n === i ? { ...x, value: e.target.value } : x))
                  )
                }
              />
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setFilters((all) => all.filter((_, n) => n !== i))}
              >
                <X className="size-3.5" />
              </Button>
            </div>
          ))}
        </div>
      ) : null}

      {isError ? (
        <ErrorState onRetry={() => refetch()} />
      ) : isLoading ? null : !data || data.rows.length === 0 ? (
        <EmptyState title="No rows match" description="Loosen the search or the filters." />
      ) : (
        <>
          <p className="text-xs text-muted-foreground">
            {data.total.toLocaleString()} rows · {data.columns.length} columns
            {data.may_edit ? " · reference values are correctable" : " · read-only"}
          </p>
          <div className="overflow-x-auto rounded-[var(--radius)] border border-border">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-border bg-muted/30 text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium" />
                  {shown.map((c) => (
                    <th key={c.name} className="whitespace-nowrap px-3 py-2 font-medium">
                      {c.name}
                      {c.editable ? (
                        <Pencil className="ml-1 inline size-3 text-primary" aria-label="editable" />
                      ) : null}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.rows.map((row, i) => (
                  <tr key={String(row.id ?? i)} className="border-b border-border/50 last:border-0 hover:bg-accent/20">
                    <td className="px-3 py-2">
                      <button
                        type="button"
                        onClick={() => setOpen(row)}
                        className="interactive text-muted-foreground hover:text-foreground"
                        aria-label="Open this row"
                      >
                        <ChevronRight className="size-4" />
                      </button>
                    </td>
                    {shown.map((c) => (
                      <td
                        key={c.name}
                        className={cn(
                          "max-w-[22rem] truncate whitespace-nowrap px-3 py-2",
                          c.type === "number" && "tabular-nums",
                          c.highlighted && "font-medium"
                        )}
                        title={String(row[c.name] ?? "")}
                      >
                        {c.editable && data.may_edit ? (
                          <button
                            type="button"
                            onClick={() => {
                              setEdit({ column: c, row })
                              setDraft(row[c.name] === null ? "" : String(row[c.name]))
                            }}
                            className="interactive underline decoration-dotted underline-offset-4 hover:text-primary"
                          >
                            {cell(row[c.name], c.type, c.name)}
                          </button>
                        ) : (
                          cell(row[c.name], c.type)
                        )}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pager total={data.total} limit={PAGE} offset={offset} onOffsetChange={setOffset} />
        </>
      )}

      {/* One row, every column — the reason a ninety-five-column table is
          worth having at all. */}
      <Dialog open={!!open} onOpenChange={(o) => !o && setOpen(null)}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>One row · {data?.table.label}</DialogTitle>
            <DialogDescription>Every column, including the ones off the side of the grid.</DialogDescription>
          </DialogHeader>
          <dl className="divide-y divide-border">
            {(data?.columns || []).map((c) => (
              <div key={c.name} className="grid grid-cols-[13rem_1fr] gap-3 py-2">
                <dt className="text-xs text-muted-foreground">{c.name}</dt>
                <dd className="min-w-0 break-words text-sm">
                  {cell(open?.[c.name], c.type, c.name)}
                </dd>
              </div>
            ))}
          </dl>
        </DialogContent>
      </Dialog>

      <Dialog open={!!edit} onOpenChange={(o) => !o && setEdit(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Correct {edit?.column.name}</DialogTitle>
            <DialogDescription>
              Currently {cell(edit?.row[edit.column.name], edit?.column.type || "string", edit?.column.name)}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="dx-value">New value</Label>
              <Input id="dx-value" value={draft} onChange={(e) => setDraft(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="dx-reason">Why</Label>
              <Textarea
                id="dx-reason"
                rows={2}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="e.g. the ISSN was transposed in the imported sheet"
              />
              <p className="text-xs text-muted-foreground">
                Recorded in the audit log with the old value and the new one.
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setEdit(null)}>
              Cancel
            </Button>
            <Button disabled={busy} onClick={saveEdit}>
              {busy ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
