import { useState } from "react"
import { Link, useSearchParams } from "react-router-dom"
import { useQueryClient } from "@tanstack/react-query"
import { CheckCircle2, MoreHorizontal, SearchX } from "lucide-react"

import { useAuth } from "@/app/auth"
import { pagesFor } from "@/app/nav"
import { ApiError, api } from "@/lib/api"
import { useApi } from "@/lib/query"
import { Answer } from "@/ui/answer"
import { Button } from "@/ui/button"
import { Chip } from "@/ui/chip"
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/ui/dialog"
import { Field, Input, Select, Textarea } from "@/ui/field"
import { filterBar } from "@/ui/filter-bar"
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/ui/menu"
import { PageHeader } from "@/ui/page-header"
import { Avatar, initialsOf } from "@/ui/person"
import { ErrorState, InlineError, NotOpen, SkeletonRows } from "@/ui/state"
import { Table, type Column } from "@/ui/table"
import { toast } from "@/ui/toast"

import {
  changeText,
  DONE,
  inTheApp,
  inTheFile,
  LABEL,
  matches,
  menuOf,
  primaryOf,
  question,
  whatDiffers,
  type Action,
  type ConflictList,
  type ConflictRow,
  type ResolveResult,
} from "./conflicts-model"

/**
 * Data conflicts: where the college's files and the app disagree.
 *
 * The two monthly imports (faculty list, settled claims) never overwrite what
 * the app already holds. Each difference they find is listed here, one row
 * each, and the office settles it by choosing: use the file's value, keep the
 * app's, update the ledger, or switch the account off until it is sorted out.
 * Every choice opens a dialog that names the exact change before anything is
 * written, and a ledger update will not go ahead without a note saying why.
 */

const STATUSES = ["open", "resolved", "all"] as const
type StatusFilter = (typeof STATUSES)[number]
const STATUS_WORD: Record<StatusFilter, string> = { open: "Open", resolved: "Resolved", all: "Open and resolved" }

const dayOf = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }) : ""

export function Conflicts() {
  const { me } = useAuth()
  const qc = useQueryClient()
  const [params, setParams] = useSearchParams()
  const status: StatusFilter = (STATUSES as readonly string[]).includes(params.get("status") ?? "")
    ? (params.get("status") as StatusFilter)
    : "open"
  const kind = params.get("kind") === "faculty" || params.get("kind") === "amount" ? params.get("kind")! : ""
  const [q, setQ] = useState("")
  const [asking, setAsking] = useState<{ row: ConflictRow; action: Action } | null>(null)

  const allowed = !me || pagesFor(me.role).some((p) => p.to === "/admin/conflicts")
  const qs = new URLSearchParams({ status })
  if (kind) qs.set("kind", kind)
  const { data, isLoading, isError, refetch } = useApi<ConflictList>(
    ["import-conflicts", status, kind],
    `/api/admin/conflicts?${qs}`,
    { enabled: !!me && allowed }
  )

  if (me && !allowed) {
    return (
      <div className="page py-8">
        <NotOpen message="Ask the research office if you think it should be yours." />
      </div>
    )
  }

  function setFilter(next: Record<string, string>) {
    const p = new URLSearchParams(params)
    for (const [k, v] of Object.entries(next)) {
      if (v && !(k === "status" && v === "open")) p.set(k, v)
      else p.delete(k)
    }
    setParams(p, { replace: true })
  }

  const rows = (data?.rows ?? []).filter((r) => matches(r, q))
  const c = data?.counts
  const filtered = q.trim() !== "" || kind !== "" || status !== "open"

  function done(result: ResolveResult) {
    setAsking(null)
    void qc.invalidateQueries({ queryKey: ["import-conflicts"] })
    void qc.invalidateQueries({ queryKey: ["admin", "hub"] })
    toast.ok(result.warning && !result.message.includes(result.warning) ? `${result.message} ${result.warning}` : result.message)
  }

  const columns = columnsFor(data?.may_resolve ?? false, (row, action) => setAsking({ row, action }))

  return (
    <div className="page space-y-6">
      <PageHeader
        title="Data conflicts"
        sub="Differences between the college's files and the app. Nothing changes until you choose."
      />

      <Answer
        items={[
          { value: c?.open_faculty, label: "Open faculty differences", zero: "No faculty differences open", tone: c?.open_faculty ? "caution" : "neutral" },
          { value: c?.open_amount, label: "Open amounts", zero: "No amounts differ", tone: c?.open_amount ? "caution" : "neutral" },
          { value: c?.resolved_week, label: "Resolved this week", zero: "None resolved this week" },
        ]}
      />

      <div className={filterBar} role="search">
        <Input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search a name, Staff ID or paper"
          aria-label="Search conflicts"
          className="w-full min-w-0 sm:w-80"
        />
        <Select aria-label="Kind" value={kind} onChange={(e) => setFilter({ kind: e.target.value })} className="w-auto max-sm:w-full">
          <option value="">Every kind</option>
          <option value="faculty">Faculty list</option>
          <option value="amount">Amounts</option>
        </Select>
        <Select
          aria-label="Status"
          value={status}
          onChange={(e) => setFilter({ status: e.target.value })}
          className="w-auto max-sm:w-full"
        >
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {STATUS_WORD[s]}
            </option>
          ))}
        </Select>
        {filtered && (
          <Button
            kind="quiet"
            onClick={() => {
              setQ("")
              setParams(new URLSearchParams(), { replace: true })
            }}
          >
            Clear filters
          </Button>
        )}
      </div>

      {data && !data.may_resolve && (
        <p className="text-sm text-fg-muted">Read only. The people who manage accounts settle these.</p>
      )}
      {data?.truncated && (
        <p className="text-sm text-fg-muted">Showing the newest {data.total.toLocaleString("en-IN")}. Settle some, then look again.</p>
      )}

      {isLoading ? (
        <SkeletonRows rows={5} rowHeight={56} />
      ) : isError || !data ? (
        <ErrorState title="Could not load the conflicts" message="Nothing has been changed. Try again." onRetry={() => refetch()} />
      ) : (
        <Table
          rows={rows}
          columns={columns}
          getKey={(r) => r.id}
          caption="Data conflicts"
          maxHeight="none"
          minWidth="52rem"
          tools={{ id: "data-conflicts", title: "Data conflicts" }}
          empty={
            data.rows.length === 0 && !filtered
              ? {
                  icon: CheckCircle2,
                  title: "No conflicts to settle",
                  message: "When a file differs from the app, the difference is listed here.",
                  action: (
                    <Button kind="default" asChild>
                      <Link to="/imports">Open the imports</Link>
                    </Button>
                  ),
                }
              : {
                  icon: SearchX,
                  title: "No conflict matches",
                  message: "Change the search or the filters to see more.",
                  action: (
                    <Button
                      kind="default"
                      onClick={() => {
                        setQ("")
                        setParams(new URLSearchParams(), { replace: true })
                      }}
                    >
                      Clear filters
                    </Button>
                  ),
                }
          }
        />
      )}

      {asking && <Confirm key={`${asking.row.id}-${asking.action}`} row={asking.row} action={asking.action} onClose={() => setAsking(null)} onDone={done} />}
    </div>
  )
}

/* ------------------------------------------------------------------------ */
/* The table                                                                 */
/* ------------------------------------------------------------------------ */

function columnsFor(may: boolean, ask: (row: ConflictRow, action: Action) => void): Column<ConflictRow>[] {
  return [
    {
      key: "person",
      header: "Person",
      exportValue: (r) => (r.staff_id ? `${r.name} (${r.staff_id})` : r.name),
      cell: (r) => <PersonCell row={r} />,
    },
    {
      key: "differs",
      header: "What differs",
      truncate: (r) => whatDiffers(r),
      className: "max-w-[18rem]",
      exportValue: (r) => (r.kind === "amount" && r.month ? `${whatDiffers(r)} (${r.month})` : whatDiffers(r)),
      cell: (r) => (
        <span className="block min-w-0">
          <span className="block truncate">{whatDiffers(r)}</span>
          {r.kind === "amount" && r.month && <span className="block text-xs text-fg-muted">Month {r.month.slice(0, 7)}</span>}
        </span>
      ),
    },
    {
      key: "app",
      header: "In the app",
      empty: "Empty",
      exportValue: (r) => (r.kind === "amount" ? r.ledger_amount : (r.current ?? "")),
      cell: (r) => inTheApp(r) || null,
    },
    {
      key: "file",
      header: "In the file",
      empty: "Empty",
      exportValue: (r) => (r.kind === "amount" ? r.file_amount : (r.incoming ?? "")),
      cell: (r) => inTheFile(r) || null,
    },
    {
      key: "status",
      header: "Status",
      defaultHidden: true,
      exportValue: (r) => (r.status === "open" ? "Open" : `${DONE[r.resolution] ?? "Resolved"}${r.resolved_by ? ` by ${r.resolved_by}` : ""}`),
      cell: (r) => (r.status === "open" ? "Open" : (DONE[r.resolution] ?? "Resolved")),
    },
    {
      key: "found",
      header: "Found in",
      defaultHidden: true,
      exportValue: (r) => `${r.source_file} ${dayOf(r.detected_at)}`.trim(),
      cell: (r) => `${r.source_file || "A file"}, ${dayOf(r.detected_at)}`,
    },
    {
      key: "actions",
      header: "Actions",
      label: "Actions",
      cell: (r) => <ActionsCell row={r} may={may} ask={ask} />,
    },
  ]
}


function PersonCell({ row }: { row: ConflictRow }) {
  const face = { name: row.name, initials: row.initials ?? initialsOf(row.name), photo_url: row.photo_url ?? null }
  const inner = (
    <>
      <Avatar person={face} size="xs" />
      <span className="min-w-0">
        <span className="block truncate font-medium">{row.name || row.staff_id}</span>
        {row.staff_id && <span className="block truncate text-xs text-fg-muted">{row.staff_id}</span>}
      </span>
    </>
  )
  const cls = "inline-flex min-w-0 max-w-full items-center gap-2"
  return row.user_id ? (
    <Link to={`/faculty/${row.user_id}`} className={`${cls} hover:underline`}>
      {inner}
    </Link>
  ) : (
    <span className={cls}>{inner}</span>
  )
}

function ActionsCell({ row, may, ask }: { row: ConflictRow; may: boolean; ask: (row: ConflictRow, action: Action) => void }) {
  if (!may) return <span className="text-fg-muted">Read only</span>
  if (row.locked) {
    return (
      <span className="text-sm text-fg-muted" title={row.locked}>
        Super admin only
      </span>
    )
  }
  const lead = primaryOf(row)
  const rest = menuOf(row)
  return (
    <div className="flex flex-wrap items-center gap-2">
      {row.status !== "open" && (
        <span className="text-sm text-fg-muted">
          {DONE[row.resolution] ?? "Resolved"}
          {row.resolved_by ? ` by ${row.resolved_by}` : ""}
          {row.resolved_at ? `, ${dayOf(row.resolved_at)}` : ""}
        </span>
      )}
      {row.paused && (
        <Chip tone="caution" title="This person cannot sign in until the account is reactivated.">
          Account paused
        </Chip>
      )}
      {lead && (
        <Button
          kind={row.status === "open" ? "primary" : "default"}
          size="sm"
          aria-label={`${LABEL[lead]} for ${row.name || row.staff_id}, ${whatDiffers(row)}`}
          onClick={() => ask(row, lead)}
        >
          {LABEL[lead]}
        </Button>
      )}
      {rest.length > 0 && (
        <Menu>
          <MenuTrigger asChild>
            <Button kind="quiet" size="sm" aria-label={`More choices for ${row.name || row.staff_id}, ${whatDiffers(row)}`}>
              <MoreHorizontal aria-hidden />
              More
            </Button>
          </MenuTrigger>
          <MenuContent align="end">
            {rest.map((a) => (
              <MenuItem key={a} onSelect={() => ask(row, a)}>
                {LABEL[a]}
              </MenuItem>
            ))}
          </MenuContent>
        </Menu>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------------ */
/* The dialog that names the change                                          */
/* ------------------------------------------------------------------------ */

function Confirm({
  row,
  action,
  onClose,
  onDone,
}: {
  row: ConflictRow
  action: Action
  onClose: () => void
  onDone: (result: ResolveResult) => void
}) {
  const needsNote = action === "update_ledger"
  const [note, setNote] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const qc = useQueryClient()

  async function go() {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const result = await api<ResolveResult>(`/api/admin/conflicts/${row.id}/resolve`, {
        method: "POST",
        json: { action, note: note.trim() },
      })
      onDone(result)
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "The change could not be made. Nothing was changed.")
      // A refusal usually means the record moved: show the list as it is now.
      void qc.invalidateQueries({ queryKey: ["import-conflicts"] })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>{question(action)}</DialogTitle>
          <DialogDescription>{changeText(row, action)}</DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-3.5">
          <Field
            label={needsNote ? "Note" : "Note (optional)"}
            hint={needsNote ? "Required. Say why the ledger is being changed." : "Kept with the change in the audit log."}
          >
            <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} />
          </Field>
          {error && <InlineError message={error} />}
        </DialogBody>
        <DialogFooter>
          <Button kind="quiet" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button kind="primary" loading={busy} disabled={busy || (needsNote && note.trim() === "")} onClick={() => void go()}>
            {LABEL[action]}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
