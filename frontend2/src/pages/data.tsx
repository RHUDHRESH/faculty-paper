import { useEffect, useMemo, useState } from "react"
import { useSearchParams } from "react-router-dom"
import {
  ArrowLeft,
  Database,
  Download,
  Pencil,
  Search,
  SearchX,
  Trash2,
  TriangleAlert,
} from "lucide-react"

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
import { Checkbox, Field, Input, Textarea } from "@/ui/field"
import { money } from "@/ui/paper"
import { Pagination } from "@/ui/pagination"
import { Callout, EmptyState, ErrorState, SkeletonRows } from "@/ui/state"
import { stickyHeadCell, TableScroller } from "@/ui/table"
import { ColumnLabel, Meta, PageTitle, SectionTitle, Sub } from "@/ui/text"
import { toast } from "@/ui/toast"

/**
 * Every table in the system, readable, with a narrow lane for correcting
 * reference data and two destructive operations behind real guards.
 *
 * The shape of the permissions is the thing to understand before changing
 * anything here, because reading and writing are deliberately very different
 * sizes:
 *
 * - **Reading** is wide — every table, every column that is not a secret.
 * - **Editing** is limited to reference data (the journal tables, the faculty
 *   master, budgets, journal standing) and to a super admin. Everything the
 *   workflow owns — a status, a money column, who approved what — moves
 *   through the screen that recalculates it and records who did it. The
 *   server refuses those columns outright; this screen does not offer them.
 * - **Deleting** is a super admin only, refuses anything carrying a payment,
 *   and refuses the audit log entirely.
 *
 * An edit is one column at a time with a reason each time. A grid that lets
 * somebody change forty things and press save produces an audit entry nobody
 * can reconstruct a decision from — which is the same as no audit entry.
 */

const PAGE_SIZE = 50

/* ------------------------------------------------------------------------ */
/* Data — read out of data_tables()/data_rows() in backend/core/api.py      */
/* ------------------------------------------------------------------------ */

type TableSummary = {
  name: string
  label: string
  about: string
  group: string
  rows: number
  columns: number
  editable: boolean
}

type TablesPayload = {
  tables: TableSummary[]
  may_edit: boolean
  note: string
}

type ColumnMeta = {
  name: string
  label: string
  type: "reference" | "boolean" | "number" | "datetime" | "date" | "text" | "string"
  editable: boolean
  highlighted: boolean
  related: string | null
  choices: string[] | null
}

/** A reference column serialises as a readable string plus `{name}__id`. */
type Row = Record<string, unknown>

type RowsPayload = {
  table: { name: string; label: string; about: string; group: string }
  columns: ColumnMeta[]
  highlight: string[]
  rows: Row[]
  total: number
  limit: number
  offset: number
  sort: string
  may_edit: boolean
}

/* ------------------------------------------------------------------------ */
/* Page                                                                      */
/* ------------------------------------------------------------------------ */

export function Data() {
  const { me } = useAuth()
  // `_may_browse_data` — the office and the Principal. Finance reads money
  // through its own screens, which are shaped for that job.
  const allowed = can(me?.role).clear || me?.role === "PRINCIPAL"

  const [searchParams, setSearchParams] = useSearchParams()
  const table = searchParams.get("table") ?? ""

  if (!allowed) {
    return (
      <div className="page py-8">
        <ErrorState
          title="Not open to this account"
          message="The raw tables are an admin tool. Everything in them is reachable through the screens built for the job."
        />
      </div>
    )
  }

  if (table) {
    return (
      <TableView
        name={table}
        onBack={() =>
          setSearchParams((prev) => {
            const next = new URLSearchParams(prev)
            next.delete("table")
            next.delete("page")
            next.delete("q")
            return next
          })
        }
      />
    )
  }

  return <TableIndex onOpen={(name) => setSearchParams({ table: name })} />
}

/* ------------------------------------------------------------------------ */
/* The index                                                                 */
/* ------------------------------------------------------------------------ */

function TableIndex({ onOpen }: { onOpen: (name: string) => void }) {
  const { me } = useAuth()
  const isSuperAdmin = can(me?.role).admin
  const { data, isLoading, isError, error, refetch } = useApi<TablesPayload>(
    ["admin", "data", "tables"],
    "/api/admin/data/tables"
  )

  const groups = useMemo(() => {
    const out = new Map<string, TableSummary[]>()
    for (const t of data?.tables ?? []) {
      const list = out.get(t.group) ?? []
      list.push(t)
      out.set(t.group, list)
    }
    return [...out.entries()]
  }, [data])

  return (
    <div className="page space-y-8">
      <header>
        <PageTitle>Data</PageTitle>
        <Sub className="mt-1">
          Every table the system keeps, as it is actually stored. Useful when a screen shows
          something odd and you need to see the row behind it.
        </Sub>
      </header>

      {data?.note && <Callout tone="info" title="What can be changed here">{data.note}</Callout>}

      {isLoading ? (
        <SkeletonRows rows={8} rowHeight={56} />
      ) : isError ? (
        <ErrorState
          title="Could not load the table list"
          message={
            error?.status === 403
              ? "Not allowed. The raw tables are open to the office and the Principal."
              : "The server did not answer."
          }
          onRetry={error?.status === 403 ? undefined : () => refetch()}
        />
      ) : (
        groups.map(([group, tables]) => (
          <section key={group} className="space-y-2">
            <SectionTitle>{group}</SectionTitle>
            <ul className="divide-y divide-line border-y border-line">
              {tables.map((t) => (
                <li key={t.name}>
                  <button
                    type="button"
                    onClick={() => onOpen(t.name)}
                    className="row flex w-full items-center gap-4 px-1 py-3 text-left sm:px-2"
                  >
                    <Database className="size-4 shrink-0 text-fg-subtle" aria-hidden />
                    <span className="min-w-0 flex-1">
                      <span className="block text-base">
                        {t.label}
                        {t.editable && (
                          <span className="ml-2 rounded-sm bg-accent-wash px-1.5 py-0.5 text-xs font-medium text-fg">
                            correctable
                          </span>
                        )}
                      </span>
                      <Meta className="block truncate">{t.about}</Meta>
                    </span>
                    <span className="shrink-0 text-right">
                      <span className="block text-base tabular">
                        {t.rows.toLocaleString("en-IN")}
                      </span>
                      <Meta className="block text-xs">{t.columns} columns</Meta>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))
      )}

      {isSuperAdmin && <WipeSection />}
    </div>
  )
}

/* ------------------------------------------------------------------------ */
/* One table                                                                 */
/* ------------------------------------------------------------------------ */

function TableView({ name, onBack }: { name: string; onBack: () => void }) {
  const { me } = useAuth()
  const isSuperAdmin = can(me?.role).admin

  const [searchParams, setSearchParams] = useSearchParams()
  const q = searchParams.get("q") ?? ""
  const sort = searchParams.get("sort") ?? ""
  const page = Math.max(0, Number.parseInt(searchParams.get("page") ?? "0", 10) || 0)

  const [draft, setDraft] = useState(q)
  useEffect(() => setDraft(q), [q])

  useEffect(() => {
    if (draft === q) return
    const t = setTimeout(() => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev)
          if (draft) next.set("q", draft)
          else next.delete("q")
          next.delete("page")
          return next
        },
        { replace: true }
      )
    }, 250)
    return () => clearTimeout(t)
  }, [draft, q, setSearchParams])

  function setParam(key: string, value: string) {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev)
      if (value) next.set(key, value)
      else next.delete(key)
      if (key !== "page") next.delete("page")
      return next
    })
  }

  const query = new URLSearchParams()
  if (q) query.set("q", q)
  if (sort) query.set("sort", sort)
  query.set("limit", String(PAGE_SIZE))
  query.set("offset", String(page * PAGE_SIZE))

  const { data, isLoading, isError, error, refetch } = useApi<RowsPayload>(
    ["admin", "data", name, q, sort, page],
    `/api/admin/data/${encodeURIComponent(name)}?${query.toString()}`,
    { placeholderData: (prev) => prev }
  )

  const [editing, setEditing] = useState<{ row: Row; column: ColumnMeta } | null>(null)
  const [deleting, setDeleting] = useState<Row | null>(null)

  const columns = data?.columns ?? []
  const rows = data?.rows ?? []
  // The audit log is append-only by design, and the server refuses a delete
  // against it — so the column of delete buttons is not drawn at all rather
  // than drawn and guaranteed to fail.
  const mayDelete = isSuperAdmin && name !== "AuditLog"

  return (
    <div className="page space-y-6">
      <header className="space-y-2">
        <Button kind="quiet" size="sm" onClick={onBack} className="-ml-2">
          <ArrowLeft />
          All tables
        </Button>
        <div>
          <PageTitle>{data?.table.label ?? name}</PageTitle>
          {data?.table.about && <Sub className="mt-1">{data.table.about}</Sub>}
        </div>
      </header>

      <div className="flex flex-wrap items-center gap-3">
        <div className="relative w-full max-w-xs">
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-fg-subtle"
            aria-hidden
          />
          <Input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Search this table"
            aria-label={`Search ${data?.table.label ?? name}`}
            className="pl-8"
          />
        </div>
        <Meta className="tabular">
          {(data?.total ?? 0).toLocaleString("en-IN")} rows
        </Meta>
        <div className="ml-auto">
          <Button kind="default" size="md" asChild>
            <a href={`/api/admin/data/${encodeURIComponent(name)}/export?${q ? `q=${encodeURIComponent(q)}` : ""}`} download>
              <Download />
              Export
            </a>
          </Button>
        </div>
      </div>

      {data?.may_edit && (
        <Meta className="block">
          Correctable columns show a pencil on hover. Each change takes a reason and is written
          to the audit log on its own.
        </Meta>
      )}

      {isLoading && !data ? (
        <SkeletonRows rows={10} rowHeight={40} />
      ) : isError ? (
        <ErrorState
          title="Could not load this table"
          message={
            error?.status === 404
              ? "There is no table by that name."
              : error?.status === 403
                ? "Not allowed."
                : "The server did not answer."
          }
          onRetry={error && error.status < 400 ? () => refetch() : () => refetch()}
        />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={q ? SearchX : Database}
          title={q ? "Nothing matches that search" : "This table is empty"}
          message={
            q
              ? "No row in this table contains that text in any of its searchable columns."
              : "Nothing has been written to it yet."
          }
        />
      ) : (
        <>
          <TableScroller minWidth={`${Math.max(48, columns.length * 10)}rem`}>
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr>
                  {columns.map((c) => (
                    <th
                      key={c.name}
                      scope="col"
                      className={cn(stickyHeadCell, c.type === "number" && "text-right")}
                    >
                      <button
                        type="button"
                        onClick={() => setParam("sort", sort === c.name ? `-${c.name}` : c.name)}
                        className="hover:text-fg"
                      >
                        <ColumnLabel>
                          {c.label}
                          {sort === c.name ? " ↑" : sort === `-${c.name}` ? " ↓" : ""}
                        </ColumnLabel>
                      </button>
                    </th>
                  ))}
                  {mayDelete && (
                    <th scope="col" className={cn(stickyHeadCell, "w-12")}>
                      <span className="sr-only">Delete</span>
                    </th>
                  )}
                </tr>
              </thead>
              <tbody>
                {rows.map((row, i) => (
                  <tr key={String(row.id ?? i)} className="row border-b border-line last:border-b-0">
                    {columns.map((c) => (
                      <td
                        key={c.name}
                        className={cn(
                          "max-w-[22rem] px-3 py-2 align-middle",
                          c.type === "number" && "text-right tabular",
                          c.highlighted && "font-medium"
                        )}
                      >
                        <span className="flex items-center gap-1">
                          <span className="min-w-0 flex-1 truncate">{display(row[c.name], c)}</span>
                          {c.editable && data?.may_edit && (
                            <button
                              type="button"
                              onClick={() => setEditing({ row, column: c })}
                              className="reveal shrink-0 text-fg-subtle hover:text-fg"
                              aria-label={`Correct ${c.label}`}
                            >
                              <Pencil className="size-3.5" />
                            </button>
                          )}
                        </span>
                      </td>
                    ))}
                    {mayDelete && (
                      <td className="px-3 py-2 align-middle">
                        <button
                          type="button"
                          onClick={() => setDeleting(row)}
                          className="reveal text-fg-subtle hover:text-critical"
                          aria-label="Delete this row"
                        >
                          <Trash2 className="size-3.5" />
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroller>
          <Pagination
            page={page}
            pageSize={PAGE_SIZE}
            total={data?.total ?? 0}
            onChange={(next) => setParam("page", next > 0 ? String(next) : "")}
          />
        </>
      )}

      {editing && (
        <EditCellDialog
          table={name}
          row={editing.row}
          column={editing.column}
          onClose={() => setEditing(null)}
        />
      )}
      {deleting && (
        <DeleteRowDialog
          table={name}
          tableLabel={data?.table.label ?? name}
          row={deleting}
          onClose={() => setDeleting(null)}
        />
      )}
    </div>
  )
}

/** One cell, as something a person reads rather than as the stored form. */
function display(value: unknown, column: ColumnMeta): string {
  if (value === null || value === undefined || value === "") return "—"
  if (column.type === "boolean") return value ? "Yes" : "No"
  if (column.type === "datetime" || column.type === "date") {
    const d = new Date(String(value))
    if (Number.isNaN(d.getTime())) return String(value)
    return d.toLocaleString("en-IN", {
      day: "numeric",
      month: "short",
      year: "numeric",
      ...(column.type === "datetime" ? { hour: "numeric", minute: "2-digit" } : {}),
    })
  }
  return String(value)
}

/* ------------------------------------------------------------------------ */
/* Correcting one value                                                      */
/* ------------------------------------------------------------------------ */

function EditCellDialog({
  table,
  row,
  column,
  onClose,
}: {
  table: string
  row: Row
  column: ColumnMeta
  onClose: () => void
}) {
  const before = row[column.name]
  const [value, setValue] = useState(before === null || before === undefined ? "" : String(before))
  const [reason, setReason] = useState("")

  const edit = useApiMutation<
    { column: string; value: unknown; reason: string },
    { ok: boolean; column: string; value: unknown; was: string }
  >(`/api/admin/data/${encodeURIComponent(table)}/${encodeURIComponent(String(row.id))}`, {
    method: "PATCH",
    invalidates: [["admin", "data"]],
  })

  const trimmed = reason.trim()
  const tooShort = trimmed.length > 0 && trimmed.length < 5
  const numberInvalid =
    column.type === "number" && value.trim() !== "" && !Number.isFinite(Number(value))
  const canSubmit = trimmed.length >= 5 && !numberInvalid && !edit.isPending

  async function submit() {
    try {
      await edit.mutateAsync({
        column: column.name,
        // Empty means null on the server; sending "" would store an empty
        // string in a column whose absent state is null.
        value: value.trim() === "" ? null : value,
        reason: trimmed,
      })
      toast.ok(`Corrected — ${column.label} is now “${value.trim() || "empty"}”`)
      onClose()
    } catch (err) {
      toast.fail(err)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>Correct {column.label}</DialogTitle>
          <DialogDescription>
            On row {String(row.id)} of {table}. The change is written to the audit log with your
            name and this reason against it.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          <div>
            <ColumnLabel className="block">Currently</ColumnLabel>
            <p className="mt-1 rounded-md bg-sunken px-2 py-1.5 text-sm">
              {display(before, column)}
            </p>
          </div>

          <Field
            label="New value"
            hint={
              column.type === "boolean"
                ? "true or false"
                : column.type === "number"
                  ? "A number. Leave empty to clear it."
                  : "Leave empty to clear it."
            }
            error={numberInvalid ? "This column takes a number." : undefined}
          >
            <Input value={value} onChange={(e) => setValue(e.target.value)} autoFocus />
          </Field>

          <Field
            label="Reason"
            hint="What was wrong and how you know. This is the whole record of the change."
            error={tooShort ? "At least 5 characters." : undefined}
          >
            <Textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={2}
              placeholder="ISSN was stored as a float by the import"
            />
          </Field>
        </DialogBody>
        <DialogFooter>
          <Button kind="quiet" onClick={onClose} disabled={edit.isPending}>
            Cancel
          </Button>
          <Button kind="primary" disabled={!canSubmit} onClick={() => void submit()}>
            {edit.isPending ? "Saving…" : "Save the correction"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/* ------------------------------------------------------------------------ */
/* Deleting one row                                                          */
/* ------------------------------------------------------------------------ */

/**
 * The server refuses a row that carries a payment, and says why in a full
 * sentence. That refusal is shown here as the answer rather than as a failed
 * request, because it is not an error — it is the rule working.
 */
function DeleteRowDialog({
  table,
  tableLabel,
  row,
  onClose,
}: {
  table: string
  tableLabel: string
  row: Row
  onClose: () => void
}) {
  const [reason, setReason] = useState("")

  const remove = useApiMutation<{ reason: string }, { ok: boolean; deleted: string }>(
    `/api/admin/data/${encodeURIComponent(table)}/row/${encodeURIComponent(String(row.id))}`,
    { method: "DELETE", invalidates: [["admin", "data"]] }
  )

  const trimmed = reason.trim()
  const tooShort = trimmed.length > 0 && trimmed.length < 10
  const canSubmit = trimmed.length >= 10 && !remove.isPending

  async function submit() {
    try {
      const result = await remove.mutateAsync({ reason: trimmed })
      toast.ok(`Deleted — ${result.deleted}`)
      onClose()
    } catch (err) {
      toast.fail(err)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>Delete this row?</DialogTitle>
          <DialogDescription>
            Row {String(row.id)} of {tableLabel}. This cannot be undone.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          <Callout tone="caution" title="Anything carrying a payment is refused">
            A paid publication, a ledger row and the audit log cannot be deleted — the server
            refuses them outright. If a payment was made in error, void it instead: that keeps
            the reversal on the ledger rather than erasing the fact that money moved.
          </Callout>

          <Field
            label="Reason"
            hint="A sentence. It is written to the audit log before the row goes, because afterwards there is nothing left to describe."
            error={tooShort ? "At least 10 characters — a sentence, not a word." : undefined}
          >
            <Textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              placeholder="Duplicate row created by the ERP import; the surviving row is ERP-001934"
              autoFocus
            />
          </Field>
        </DialogBody>
        <DialogFooter>
          <Button kind="quiet" onClick={onClose} disabled={remove.isPending}>
            Cancel
          </Button>
          <Button kind="danger" disabled={!canSubmit} onClick={() => void submit()}>
            {remove.isPending ? "Deleting…" : "Delete the row"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/* ------------------------------------------------------------------------ */
/* Emptying the system                                                       */
/* ------------------------------------------------------------------------ */

type WipePreview = {
  counts: Record<string, number>
  total_rows: number
  paid_claims: number
  paid_amount: number
  phrase: string
  kept: string[]
}

/**
 * The one operation on this screen that cannot be undone by anybody.
 *
 * Every guard the server imposes is surfaced *before* the reader acts rather
 * than after: what will go, what survives, how many settled payments are
 * about to stop being on record and what they came to. `expect_rows` is sent
 * with the confirmation, so if anything changed between reading the preview
 * and typing the phrase the server answers 409 and empties nothing — the
 * figures on screen are the figures being agreed to, or the wipe does not
 * happen.
 */
function WipeSection() {
  const [open, setOpen] = useState(false)
  const preview = useApi<WipePreview>(["admin", "wipe", "preview"], "/api/admin/wipe/preview", {
    enabled: open,
  })

  return (
    <section className="space-y-3 border-t border-line pt-8">
      <SectionTitle className="text-critical">Empty the system</SectionTitle>
      <p className="max-w-2xl text-base text-fg-muted">
        Removes every publication, claim, payment record and ledger row. Accounts, the audit log,
        the journal reference data and the payout policy all survive. There is no undo and no
        backup taken on the way out.
      </p>
      <Button kind="danger" size="md" onClick={() => setOpen(true)}>
        <TriangleAlert />
        Empty the system
      </Button>

      {open && (
        <WipeDialog
          preview={preview.data}
          loading={preview.isLoading}
          failed={preview.isError}
          onClose={() => setOpen(false)}
        />
      )}
    </section>
  )
}

function WipeDialog({
  preview,
  loading,
  failed,
  onClose,
}: {
  preview: WipePreview | undefined
  loading: boolean
  failed: boolean
  onClose: () => void
}) {
  const [phrase, setPhrase] = useState("")
  const [reason, setReason] = useState("")
  const [acknowledged, setAcknowledged] = useState(false)

  const wipe = useApiMutation<
    {
      confirm: string
      reason: string
      expect_rows: number
      i_understand_payments_will_be_lost: boolean
    },
    { ok: boolean }
  >("/api/admin/wipe", { invalidates: [["admin", "data"], ["dashboard"]] })

  const trimmedReason = reason.trim()
  const phraseOk = preview ? phrase === preview.phrase : false
  const needsAck = (preview?.paid_claims ?? 0) > 0
  const canSubmit =
    Boolean(preview) &&
    phraseOk &&
    trimmedReason.length >= 10 &&
    (!needsAck || acknowledged) &&
    !wipe.isPending

  async function submit() {
    if (!preview) return
    try {
      await wipe.mutateAsync({
        confirm: phrase,
        reason: trimmedReason,
        // The figure the reader was actually shown. If the system moved
        // underneath them, the server refuses rather than emptying a
        // different set of rows than the one they agreed to.
        expect_rows: preview.total_rows,
        i_understand_payments_will_be_lost: acknowledged,
      })
      toast.ok(`Emptied — ${preview.total_rows.toLocaleString("en-IN")} rows removed`)
      onClose()
    } catch (err) {
      toast.fail(err)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>Empty the system?</DialogTitle>
          <DialogDescription>
            This is not reversible by anybody, including whoever runs the server.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          {loading ? (
            <SkeletonRows rows={5} rowHeight={28} />
          ) : failed || !preview ? (
            <ErrorState
              title="Could not read what would be deleted"
              message="Nothing is going to be emptied without that list. Close this and try again."
            />
          ) : (
            <>
              {preview.paid_claims > 0 && (
                <Callout tone="critical" title={`${preview.paid_claims.toLocaleString("en-IN")} settled payments would stop being on record`}>
                  Worth {money(preview.paid_amount)}. That is the evidence the college would
                  show if anybody asked why the money left the account.
                </Callout>
              )}

              <div>
                <ColumnLabel className="block">What goes</ColumnLabel>
                <dl className="mt-1 divide-y divide-line border-y border-line">
                  {Object.entries(preview.counts).map(([name, count]) => (
                    <div key={name} className="flex justify-between gap-4 py-1.5 text-sm">
                      <dt>{name}</dt>
                      <dd className="tabular">{count.toLocaleString("en-IN")}</dd>
                    </div>
                  ))}
                  <div className="flex justify-between gap-4 py-1.5 text-sm font-medium">
                    <dt>Total</dt>
                    <dd className="tabular">{preview.total_rows.toLocaleString("en-IN")}</dd>
                  </div>
                </dl>
              </div>

              <div>
                <ColumnLabel className="block">What stays</ColumnLabel>
                <ul className="mt-1 space-y-1 text-sm text-fg-muted">
                  {preview.kept.map((k) => (
                    <li key={k}>{k}</li>
                  ))}
                </ul>
              </div>

              <Field
                label="Reason"
                hint="A sentence, kept in the audit log — which survives this."
              >
                <Textarea
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  rows={2}
                  placeholder="Resetting the staging database before the live import"
                />
              </Field>

              {needsAck && (
                <Checkbox
                  checked={acknowledged}
                  onCheckedChange={(v) => setAcknowledged(v === true)}
                  label={`I understand that ${preview.paid_claims.toLocaleString("en-IN")} settled payments worth ${money(preview.paid_amount)} will no longer be on record`}
                />
              )}

              <Field label={`Type “${preview.phrase}” to confirm`}>
                <Input
                  value={phrase}
                  onChange={(e) => setPhrase(e.target.value)}
                  placeholder={preview.phrase}
                  autoComplete="off"
                />
              </Field>
            </>
          )}
        </DialogBody>
        <DialogFooter>
          <Button kind="quiet" onClick={onClose} disabled={wipe.isPending}>
            Cancel
          </Button>
          <Button kind="danger" disabled={!canSubmit} onClick={() => void submit()}>
            {wipe.isPending
              ? "Emptying…"
              : preview
                ? `Empty ${preview.total_rows.toLocaleString("en-IN")} rows`
                : "Empty the system"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
