import { useEffect, useState } from "react"
import { Link, useSearchParams } from "react-router-dom"
import { ArrowRight, Download, History, Search, SearchX } from "lucide-react"

import { useApi } from "@/lib/query"
import { Answer } from "@/ui/answer"
import { Button } from "@/ui/button"
import { Combobox, type ComboboxOption } from "@/ui/combobox"
import { DateInput, Input } from "@/ui/field"
import { PageHeader } from "@/ui/page-header"
import { Pagination } from "@/ui/pagination"
import { Details, Rows, Section } from "@/ui/section"
import { Sheet, SheetBody, SheetContent, SheetHeader, SheetTitle } from "@/ui/sheet"
import { EmptyState, ErrorState, SkeletonRows } from "@/ui/state"
import { Table, type Column } from "@/ui/table"
import { Meta } from "@/ui/text"

import { count, FaceName, type Face } from "./admin-b-parts"

/**
 * The audit log: who changed what, when, and from what to what.
 *
 * The log stores a code and a blob; the server tells each row in words
 * (`who`, `what`, `changes`, `reason`, `record`). This page shows those, with
 * the raw entry one step away for an auditor. It is append-only: there is no
 * edit here and nothing to remove, and nothing on the page suggests otherwise.
 *
 * The audit endpoint is open to a wider set than "the office" (the Principal,
 * Finance and the Director read it too), so the page does not gate on a client
 * role check. It lets the request run and reads the server's own 403.
 */

type Change = { label: string; from: string; to: string }

type AuditRow = {
  id: string
  action: string
  entity: string
  entity_id: string | null
  actor: string | null
  actor_name?: string | null
  detail_json: string | null
  created_at: string
  who?: Face | null
  what?: string
  changes?: Change[]
  reason?: string | null
  note?: string | null
  record?: { kind: string; id: string | null; label: string }
}

type AuditPayload = {
  total: number
  limit: number
  offset: number
  summary?: { last_week: number; by_people: number; by_system: number }
  results: AuditRow[]
}

const PAGE_SIZE = 50
/** The server's AUDIT_CSV_CAP (backend/core/api/admin.py). */
const AUDIT_CSV_CAP = 50000

function humanizeCode(code: string): string {
  return code.replace(/_/g, " ").toLowerCase()
}

/** Where a record opens, for the two kinds this app has a page for. */
function recordHref(row: AuditRow): string | null {
  const r = row.record
  const kind = r?.kind ?? row.entity
  const id = r?.id ?? row.entity_id
  if (!id) return null
  if (kind === "Claim") return `/papers/${id}`
  if (kind === "User") return `/faculty/${id}`
  return null
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  })
}

type ShownRow = AuditRow & { repeat: number }

/**
 * A run of the same automatic entry, written in the same minute, as one row
 * with a count. The import's check raised fifty-three flags in one second,
 * and the log's first screen was nothing else. Only entries nobody made by
 * hand fold together; a person's actions are always listed one by one.
 */
export function collapseRuns(rows: AuditRow[]): ShownRow[] {
  const out: ShownRow[] = []
  for (const r of rows) {
    const last = out[out.length - 1]
    if (
      last &&
      r.actor == null &&
      last.actor == null &&
      last.action === r.action &&
      last.entity === r.entity &&
      last.created_at.slice(0, 16) === r.created_at.slice(0, 16)
    ) {
      last.repeat += 1
      continue
    }
    out.push({ ...r, repeat: 1 })
  }
  return out
}

function ChangeLines({ changes, max }: { changes: Change[]; max?: number }) {
  const shown = max ? changes.slice(0, max) : changes
  return (
    <>
      {shown.map((c) => (
        <span key={c.label} className="mt-0.5 flex flex-wrap items-baseline gap-x-1.5 text-fg-muted">
          <span>{c.label}:</span>
          <span className="line-through decoration-fg-subtle">{c.from}</span>
          <ArrowRight aria-hidden className="size-3 self-center text-fg-subtle" />
          <span className="font-medium text-fg">{c.to}</span>
        </span>
      ))}
      {max && changes.length > max && <span className="block text-fg-muted">and {changes.length - max} more</span>}
    </>
  )
}

type Origin = { at: string | null; title: string; detail: string; by: string | null }

/**
 * Where the record came from: the imports and restores that built it, worked
 * out by the server from the rows themselves (`/api/admin/audit/origins`). The
 * ERP import wrote no audit entries, so without this the log says nothing
 * about how ninety-four claims and three thousand payments got here.
 */
function Origins() {
  const { data } = useApi<{ events: Origin[] }>(["audit", "origins"], "/api/admin/audit/origins")
  if (!data || data.events.length === 0) return null
  return (
    <Details label="where the record came from" count={data.events.length}>
      <Rows>
        {data.events.map((e, i) => (
          <li key={i} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 py-2.5">
            <span className="min-w-0">
              <span className="block text-sm">{e.title}</span>
              {e.detail && <Meta className="block">{e.detail}</Meta>}
            </span>
            <Meta className="shrink-0">
              {[e.by, e.at ? formatDateTime(e.at) : null].filter(Boolean).join(", ")}
            </Meta>
          </li>
        ))}
      </Rows>
    </Details>
  )
}

export function Audit() {
  const [searchParams, setSearchParams] = useSearchParams()
  const q = searchParams.get("q") ?? ""
  const action = searchParams.get("action") ?? ""
  const from = searchParams.get("from") ?? ""
  const to = searchParams.get("to") ?? ""
  const person = searchParams.get("person") ?? ""
  const claim = searchParams.get("claim") ?? ""
  const page = Math.max(0, Number.parseInt(searchParams.get("page") ?? "0", 10) || 0)

  const [searchDraft, setSearchDraft] = useState(q)
  const [selected, setSelected] = useState<AuditRow | null>(null)

  useEffect(() => setSearchDraft(q), [q])

  useEffect(() => {
    if (searchDraft === q) return
    const t = setTimeout(() => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev)
          if (searchDraft) next.set("q", searchDraft)
          else next.delete("q")
          next.delete("page")
          return next
        },
        { replace: true }
      )
    }, 250)
    return () => clearTimeout(t)
  }, [searchDraft, q, setSearchParams])

  function setParam(name: string, value: string) {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev)
      if (value) next.set(name, value)
      else next.delete(name)
      next.delete("page")
      return next
    })
  }

  function goToPage(next: number) {
    setSearchParams((prev) => {
      const p = new URLSearchParams(prev)
      if (next > 0) p.set("page", String(next))
      else p.delete("page")
      return p
    })
  }

  function clearFilters() {
    setSearchDraft("")
    setSearchParams(new URLSearchParams())
  }

  // Every filter is applied by the server, so the total and the CSV agree
  // with what is on screen whatever the date range.
  const filterQuery = new URLSearchParams()
  if (q) filterQuery.set("q", q)
  if (action) filterQuery.set("action", action)
  if (person) filterQuery.set("person", person)
  if (claim) filterQuery.set("claim", claim)
  if (from) filterQuery.set("date_from", from)
  if (to) filterQuery.set("date_to", to)
  const listQuery = new URLSearchParams(filterQuery)
  listQuery.set("limit", String(PAGE_SIZE))
  listQuery.set("offset", String(page * PAGE_SIZE))
  const csvHref = `/api/admin/audit.csv${filterQuery.toString() ? `?${filterQuery.toString()}` : ""}`

  const { data, isLoading, isError, error, refetch } = useApi<AuditPayload>(
    ["audit", q, action, person, claim, from, to, page],
    `/api/admin/audit?${listQuery.toString()}`,
    { placeholderData: (prev) => prev }
  )
  const actions = useApi<{ actions: { value: string; label: string }[] }>(["audit", "actions"], "/api/admin/audit/actions")
  const actionOptions: ComboboxOption[] = [
    { value: "", label: "Anything" },
    ...(actions.data?.actions ?? []).map((a) => ({ value: a.value, label: a.label })),
  ]

  const rows = data?.results ?? []
  const total = data?.total ?? 0

  useEffect(() => {
    if (!data) return
    const maxPage = Math.max(0, Math.ceil(total / PAGE_SIZE) - 1)
    if (page > maxPage) goToPage(maxPage)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, total])

  const extraFilters = Boolean(action || from || to || person || claim)
  const filtered = Boolean(q || extraFilters)
  const shown = collapseRuns(rows)
  const summary = data?.summary

  const columns: Column<ShownRow>[] = [
    {
      key: "when",
      header: "When",
      className: "whitespace-nowrap",
      cell: (r) => <span className="tabular">{formatDateTime(r.created_at)}</span>,
    },
    {
      key: "who",
      header: "Who",
      empty: "The system",
      cell: (r) =>
        r.who ? (
          <FaceName person={r.who} />
        ) : r.actor ? (
          <Link to={`/faculty?q=${encodeURIComponent(r.actor)}`} className="underline-offset-2 hover:underline">
            {r.actor_name || r.actor}
          </Link>
        ) : null,
    },
    {
      key: "what",
      header: "What happened",
      cell: (r) => (
        <span className="block min-w-0">
          <span className="block">
            {r.what ?? humanizeCode(r.action)}
            {r.repeat > 1 && <span className="text-fg-muted"> × {r.repeat}</span>}
          </span>
          {r.changes && r.changes.length > 0 && (
            <span className="block text-sm">
              <ChangeLines changes={r.changes} max={2} />
            </span>
          )}
          {r.reason && <span className="mt-0.5 block text-sm text-fg-muted">Reason given: {r.reason}</span>}
          {r.note && <span className="mt-0.5 line-clamp-2 block text-sm text-fg-muted">{r.note}</span>}
        </span>
      ),
    },
    {
      key: "record",
      header: "Record",
      cell: (r) => {
        const href = recordHref(r)
        const label = r.record?.label ?? r.entity
        return href ? (
          <Link to={href} className="underline-offset-2 hover:underline">
            {label}
          </Link>
        ) : (
          <span className="text-fg-muted">{label}</span>
        )
      },
    },
    {
      key: "open",
      header: "More",
      label: "More",
      cell: (r) => (
        <Button kind="quiet" size="sm" onClick={() => setSelected(r)} aria-label={`Details of: ${r.what ?? humanizeCode(r.action)}`}>
          Details
        </Button>
      ),
    },
  ]

  return (
    <div className="page space-y-10">
      <PageHeader
        title="Audit log"
        sub="Who changed what, and when. Nothing can be edited."
        spot="spot-audit"
        action={
          <Button kind="primary" asChild>
            <a href={csvHref} download>
              <Download aria-hidden />
              Download CSV
              {total
                ? total > AUDIT_CSV_CAP
                  ? ` (newest ${count(AUDIT_CSV_CAP)} of ${count(total)})`
                  : ` (${count(total)})`
                : ""}
            </a>
          </Button>
        }
      />

      <section aria-label="The answer" className="space-y-3">
        <Answer
          items={[
            { value: data ? total : null, label: filtered ? "Entries match" : "Entries in all", to: filtered ? "/audit" : undefined, zero: "Nothing recorded yet" },
            { value: summary ? summary.last_week : null, label: "In the last 7 days", zero: "Nothing in the last 7 days" },
            { value: summary ? summary.by_people : null, label: "Made by people", zero: "Nothing made by a person" },
            { value: summary ? summary.by_system : null, label: "Made by the system", zero: "Nothing automatic" },
          ]}
        />
        {total > AUDIT_CSV_CAP && (
          <p className="text-sm text-fg-muted">
            The CSV stops at {count(AUDIT_CSV_CAP)} rows. Narrow the dates to export the rest.
          </p>
        )}
      </section>

      <Section title="Find an entry" className="space-y-3">
        <div className="relative w-full max-w-md">
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-fg-subtle"
            aria-hidden
          />
          <Input
            value={searchDraft}
            onChange={(e) => setSearchDraft(e.target.value)}
            placeholder="A person's name, a claim number or a record ID"
            aria-label="Search the audit log"
            className="pl-8"
          />
        </div>
        <Details label="more filters" defaultOpen={extraFilters}>
          <div className="flex flex-wrap items-end gap-3 max-sm:[&>*]:w-full max-sm:[&>*]:max-w-none">
            <label className="block w-56">
              <span className="mb-1.5 block text-xs text-fg-muted">What happened</span>
              <Combobox
                value={action}
                onChange={(v) => setParam("action", v)}
                options={actionOptions}
                placeholder="Anything"
                aria-label="Filter by what happened"
              />
            </label>
            <label className="block">
              <span className="mb-1.5 block text-xs text-fg-muted">Who did it</span>
              <Input
                defaultValue={person}
                key={`p-${person}`}
                onBlur={(e) => setParam("person", e.target.value.trim())}
                onKeyDown={(e) => {
                  if (e.key === "Enter") setParam("person", e.currentTarget.value.trim())
                }}
                placeholder="Name or email"
                aria-label="Filter by who did it"
                className="w-full sm:w-48"
              />
            </label>
            <label className="block">
              <span className="mb-1.5 block text-xs text-fg-muted">Claim number</span>
              <Input
                defaultValue={claim}
                key={`c-${claim}`}
                onBlur={(e) => setParam("claim", e.target.value.trim())}
                onKeyDown={(e) => {
                  if (e.key === "Enter") setParam("claim", e.currentTarget.value.trim())
                }}
                placeholder="FP-2026-000001"
                aria-label="Filter by claim number"
                className="w-full sm:w-44"
              />
            </label>
            <label className="block">
              <span className="mb-1.5 block text-xs text-fg-muted">From</span>
              <DateInput value={from} onChange={(e) => setParam("from", e.target.value)} aria-label="From date" className="w-full sm:w-36" />
            </label>
            <label className="block">
              <span className="mb-1.5 block text-xs text-fg-muted">To</span>
              <DateInput value={to} onChange={(e) => setParam("to", e.target.value)} aria-label="To date" className="w-full sm:w-36" />
            </label>
          </div>
        </Details>
        {filtered && (
          <Button kind="quiet" size="sm" onClick={clearFilters}>
            Clear filters
          </Button>
        )}
      </Section>

      <Section title={filtered ? `${count(total)} matching` : "Newest first"}>
        {isLoading ? (
          <SkeletonRows rows={8} rowHeight={48} />
        ) : isError ? (
          error?.status === 403 ? (
            <ErrorState
              art="closed-gate"
              title="Not open to this account"
              message="Open to the research office, system admins, the Principal, the Director and Finance."
            />
          ) : (
            <ErrorState
              title="Could not load the audit log"
              message="The server did not answer."
              onRetry={() => refetch()}
            />
          )
        ) : rows.length === 0 ? (
          <EmptyState
            art={filtered ? "no-results" : "nothing-filed"}
            icon={filtered ? SearchX : History}
            title={filtered ? "Nothing matches" : "No activity recorded yet"}
            message={
              filtered
                ? "Try a wider date range or fewer filters."
                : "Every change appears here as it happens."
            }
            action={
              filtered ? (
                <Button kind="default" size="sm" onClick={clearFilters}>
                  Clear filters
                </Button>
              ) : undefined
            }
          />
        ) : (
          <div className="space-y-3">
            <Table rows={shown} getKey={(r) => r.id} columns={columns} caption="Audit log entries" maxHeight="none" />
            <Pagination page={page} pageSize={PAGE_SIZE} total={total} onChange={goToPage} />
          </div>
        )}
      </Section>

      {!filtered && page === 0 && <Origins />}

      <Sheet open={!!selected} onOpenChange={(open) => !open && setSelected(null)}>
        <SheetContent>
          {selected && (
            <>
              <SheetHeader>
                <SheetTitle>{selected.what ?? humanizeCode(selected.action)}</SheetTitle>
                <Meta className="mt-1 block">{formatDateTime(selected.created_at)}</Meta>
              </SheetHeader>
              <SheetBody className="space-y-4">
                <dl className="space-y-1.5 text-sm">
                  <div className="flex items-baseline justify-between gap-3">
                    <dt className="text-fg-muted">Who</dt>
                    <dd className="text-right font-medium">
                      {selected.who ? <FaceName person={selected.who} /> : (selected.actor_name ?? selected.actor ?? "The system")}
                    </dd>
                  </div>
                  <div className="flex items-baseline justify-between gap-3">
                    <dt className="text-fg-muted">Record</dt>
                    <dd className="text-right font-medium">
                      {(() => {
                        const href = recordHref(selected)
                        const label = selected.record?.label ?? selected.entity
                        return href ? (
                          <Link to={href} className="underline-offset-2 hover:underline">
                            {label}
                          </Link>
                        ) : (
                          label
                        )
                      })()}
                    </dd>
                  </div>
                </dl>
                {selected.changes && selected.changes.length > 0 ? (
                  <div className="border-t border-line pt-4 text-sm">
                    <p className="mb-1 font-medium">What changed</p>
                    <ChangeLines changes={selected.changes} />
                  </div>
                ) : (
                  <p className="border-t border-line pt-4 text-sm text-fg-muted">
                    No before and after recorded.
                  </p>
                )}
                {selected.reason && (
                  <p className="text-sm">
                    <span className="font-medium">Reason given:</span> {selected.reason}
                  </p>
                )}
                <Details label="the entry as recorded">
                  <dl className="space-y-1 text-sm">
                    <div className="flex justify-between gap-3">
                      <dt className="text-fg-muted">Action code</dt>
                      <dd className="break-all text-right">{selected.action}</dd>
                    </div>
                    <div className="flex justify-between gap-3">
                      <dt className="text-fg-muted">Record ID</dt>
                      <dd className="break-all text-right">{selected.entity_id ?? "None"}</dd>
                    </div>
                  </dl>
                  {selected.detail_json && (
                    <pre className="mt-2 max-h-64 overflow-auto rounded-control bg-sunken p-3 text-xs">
                      {prettyJson(selected.detail_json)}
                    </pre>
                  )}
                </Details>
              </SheetBody>
            </>
          )}
        </SheetContent>
      </Sheet>
    </div>
  )
}

function prettyJson(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2)
  } catch {
    return raw
  }
}
