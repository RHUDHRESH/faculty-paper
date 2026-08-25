import { useEffect, useMemo, useState } from "react"
import { Link, useSearchParams } from "react-router-dom"
import {
  ArrowRight,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  History,
  Search,
  SearchX,
  ShieldAlert,
} from "lucide-react"

import { cn } from "@/lib/cn"
import { useApi } from "@/lib/query"
import { Button } from "@/ui/button"
import { Combobox, type ComboboxOption } from "@/ui/combobox"
import { DateInput, Input } from "@/ui/field"
import { money } from "@/ui/paper"
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/ui/sheet"
import { EmptyState, ErrorState, SkeletonRows } from "@/ui/state"
import { Table, type Column } from "@/ui/table"
import { Meta, PageTitle, SectionTitle, Sub } from "@/ui/text"

/**
 * `Audit` — who did what, and when — and `Faults` — what is broken, blocked
 * or unreconciled. Both read `backend/core/api.py` directly rather than
 * `API.md`'s summary of it: the audit endpoint takes only `q`, `action`,
 * `limit` and `offset` (no server-side entity or date parameter exists),
 * and each screen is open to a different, wider set of roles than the
 * "office" the rest of the app means by that word — `can_view_audit` also
 * admits the Principal and Finance, `admin_faults` also admits the
 * Principal. So neither screen gates on a client-side role check; both let
 * the request run and read the server's own 403, the same way `Person` in
 * `people.tsx` already does, because a client guess at "who is office" here
 * would have been wrong twice.
 */

/* ------------------------------------------------------------------------ */
/* Shared: reading an action code the way a person would say it             */
/* ------------------------------------------------------------------------ */

// Every `action=` value `AuditLog.objects.create()` is ever called with in
// backend/core/api.py, read off the source rather than guessed — the
// four-step chain's own transitions (CLEAR, PRINCIPAL_APPROVE, MARK_PAID...)
// plus everything else that ever writes to the log. A code missing from this
// map still renders — `actionSentence` below falls back to humanising it —
// so a new action added on the server does not blank this screen, it just
// reads a little plainer until this list catches up.
const ACTION_SENTENCES: Record<string, string> = {
  CREATE_DRAFT: "saved a draft",
  ADMIN_CREATE: "created a claim on someone else's behalf",
  SUBMIT: "filed a paper",
  CONTEST_FORWARD: "forwarded a contested claim",
  RESUBMIT: "resubmitted a sent-back claim",
  CLEAR: "cleared a claim",
  PRINCIPAL_APPROVE: "approved a claim",
  PRINCIPAL_SEND_BACK: "sent a claim back",
  MARK_PAID: "marked a claim paid",
  VOID_PAYMENT: "voided a payment",
  STATUS_OVERRIDE: "overrode a claim's status",
  WITHDRAW: "withdrew a claim",
  REJECT: "rejected a claim",
  PROFILE_UPDATE: "updated their profile",
  PROFILE_CORRECTION_REQUEST: "requested a profile correction",
  PROFILE_CORRECTION_DECIDED: "decided a profile correction request",
  PASSWORD_CHANGE: "changed their password",
  CLAIM_RECALC_SKIP_EXTERNAL: "recalculated a claim without an external lookup",
  CLAIM_SECOND_APPROVE: "gave the second approval on a high-value claim",
  CLAIM_MANUAL_VERIFY: "manually verified a claim's SNIP or quartile",
  CLAIM_NOTE: "left a note on a claim",
  REPORT_PACK: "generated a report pack",
  PACK_CORRECT: "corrected a value in a report pack",
  DATA_DELETE: "deleted a database row",
  SYSTEM_WIPE: "wiped system data",
  DISCOVER_VENUES: "asked Discover for venue suggestions",
  HOD_EXPORT: "exported a department's data",
  DATA_EXPORT: "exported a data table",
  DATA_EDIT: "edited a database row",
  BUDGET_SET: "set a budget",
  BUDGET_DELETE: "deleted a budget",
  DUPLICATE_REVIEW: "reviewed a duplicate-payment finding",
  CLAIM_ADMIN_EDIT: "edited a claim's stored values",
  CLAIM_REASSIGN: "reassigned a claim to a different account",
  IMPERSONATE_START: "started impersonating an account",
  IMPERSONATE_STOP: "stopped impersonating an account",
  USER_CREATE: "created an account",
  USER_UPDATE: "updated an account",
  USER_RESET_PASSWORD: "reset an account's password",
  FORMULA_UPDATE: "updated the payout formula",
  SCIMAGO_IMPORT: "imported a Scimago dataset",
  SCIMAGO_SYNC: "synced Scimago data",
  PRIOR_PAYMENT_IMPORT: "imported prior-payment records",
  SNIP_IMPORT: "imported SNIP data",
  FACULTY_MASTER_IMPORT: "imported the faculty master list",
  ERP_XLSX_IMPORT_QUEUED: "queued an ERP spreadsheet import",
}

function humanizeCode(code: string): string {
  return code.replace(/_/g, " ").toLowerCase()
}

function actionSentence(code: string): string {
  return ACTION_SENTENCES[code] ?? humanizeCode(code)
}

const ACTION_OPTIONS: ComboboxOption[] = [
  { value: "", label: "All actions" },
  ...Object.entries(ACTION_SENTENCES)
    .map(([value, sentence]) => ({
      value,
      label: sentence.charAt(0).toUpperCase() + sentence.slice(1),
    }))
    .sort((a, b) => a.label.localeCompare(b.label)),
]

/** Where an entry names a claim or a person, per the brief — the only two
 *  entities this app has a detail page for. Everything else (a budget, the
 *  formula, an import batch) has no route of its own, so it stays text. */
function entityHref(entity: string, entityId: string | null): string | null {
  if (!entityId) return null
  if (entity === "Claim") return `/papers/${entityId}`
  if (entity === "User") return `/people/${entityId}`
  return null
}

/* ------------------------------------------------------------------------ */
/* Reading detail_json — the before/after a person auditing a payment needs */
/* ------------------------------------------------------------------------ */

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v)
}

function parseDetail(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    return isPlainObject(parsed) ? parsed : null
  } catch {
    return null
  }
}

function humanizeKey(key: string): string {
  const label = key.replace(/_/g, " ")
  return label.charAt(0).toUpperCase() + label.slice(1)
}

// A value that is itself one of this app's own status/source constants
// reads as a sentence, not a shout — but a department code like "CSE" is
// not a constant, it is an abbreviation, so only a value with an underscore
// (unambiguously machine-shaped) or one from this short known list gets
// re-cased.
const KNOWN_CODE_WORDS = new Set([
  "SCOPUS",
  "SCIMAGO",
  "MANUAL",
  "SNIP_DUMP",
  "DRAFT",
  "SUBMITTED",
  "CLEARED",
  "REJECTED",
  "PAID",
  "PRINCIPAL_APPROVED",
  "HOD_APPROVED",
  "RESEARCH_APPROVED",
  "FINANCE_APPROVED",
])

function looksLikeCode(v: string): boolean {
  return v.includes("_") ? /^[A-Z0-9_]+$/.test(v) : KNOWN_CODE_WORDS.has(v)
}

function formatDetailValue(key: string, value: unknown): string {
  if (value === null || value === undefined || value === "") return "—"
  if (typeof value === "boolean") return value ? "Yes" : "No"
  if (typeof value === "number") {
    return /amount|remuneration/i.test(key) ? money(value) : value.toLocaleString("en-IN")
  }
  if (typeof value === "string") {
    return looksLikeCode(value) ? humanizeCode(value) : value
  }
  if (Array.isArray(value)) {
    return value.length ? value.map((v) => formatDetailValue(key, v)).join(", ") : "—"
  }
  if (isPlainObject(value)) return JSON.stringify(value)
  return String(value)
}

/** The before/after (or, failing that, whatever else was recorded) behind
 *  one audit entry — never the raw JSON blob, which is what this screen
 *  replaces. */
function AuditDetail({ raw }: { raw: string | null }) {
  const detail = useMemo(() => parseDetail(raw), [raw])

  if (!detail) {
    return <p className="text-sm text-fg-muted">No further detail was recorded with this entry.</p>
  }

  const { before, after, from, to, ...rest } = detail

  const changedKeys =
    isPlainObject(before) && isPlainObject(after)
      ? Array.from(new Set([...Object.keys(before), ...Object.keys(after)])).filter(
          (k) => JSON.stringify(before[k]) !== JSON.stringify(after[k])
        )
      : []

  const hasFromTo = !changedKeys.length && (from !== undefined || to !== undefined)
  const restEntries = Object.entries(rest).filter(([, v]) => v !== undefined)

  if (!changedKeys.length && !hasFromTo && !restEntries.length) {
    return <p className="text-sm text-fg-muted">No further detail was recorded with this entry.</p>
  }

  return (
    <div className="space-y-4">
      {changedKeys.length > 0 && (
        <section className="space-y-2">
          <SectionTitle>What changed</SectionTitle>
          <div className="space-y-2">
            {changedKeys.map((k) => (
              <div key={k} className="flex items-baseline justify-between gap-3 text-sm">
                <span className="text-fg-muted">{humanizeKey(k)}</span>
                <span className="flex items-baseline gap-1.5 text-right">
                  <span className="text-fg-subtle line-through">
                    {formatDetailValue(k, (before as Record<string, unknown>)[k])}
                  </span>
                  <ArrowRight className="size-3 shrink-0 text-fg-subtle" aria-hidden />
                  <span className="font-medium">
                    {formatDetailValue(k, (after as Record<string, unknown>)[k])}
                  </span>
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      {hasFromTo && (
        <section className="space-y-2">
          <SectionTitle>What changed</SectionTitle>
          <div className="flex items-center gap-2 text-sm">
            <span className="text-fg-subtle">{formatDetailValue("from", from)}</span>
            <ArrowRight className="size-3.5 shrink-0 text-fg-subtle" aria-hidden />
            <span className="font-medium">{formatDetailValue("to", to)}</span>
          </div>
        </section>
      )}

      {restEntries.length > 0 && (
        <section className="space-y-2">
          <SectionTitle>Recorded with this entry</SectionTitle>
          <dl className="space-y-1.5 text-sm">
            {restEntries.map(([k, v]) => (
              <div key={k} className="flex items-baseline justify-between gap-3">
                <dt className="text-fg-muted">{humanizeKey(k)}</dt>
                <dd className="max-w-[60%] text-right font-medium">{formatDetailValue(k, v)}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------------ */
/* Audit                                                                    */
/* ------------------------------------------------------------------------ */

type AuditRow = {
  id: string
  action: string
  entity: string
  entity_id: string | null
  actor: string | null
  detail_json: string | null
  created_at: string
}

type AuditPayload = {
  total: number
  limit: number
  offset: number
  results: AuditRow[]
}

const PAGE_SIZE = 50
// The server caps `limit` at 500 — the ceiling this screen asks for whenever
// a date range narrows the list, since `created_at` has no server-side
// filter to hand that work to. See the note near `refining` below.
const DATE_FETCH_CAP = 500

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })
}

function withinRange(iso: string, from: string, to: string): boolean {
  const t = new Date(iso).getTime()
  if (from && t < new Date(`${from}T00:00:00`).getTime()) return false
  if (to && t > new Date(`${to}T23:59:59.999`).getTime()) return false
  return true
}

/**
 * The record of every consequential action in a system that pays people.
 * Append-only by design — there is no edit here and no delete, and nothing
 * on this screen implies otherwise: no row menu, no edit affordance, just a
 * "View" onto what was recorded.
 */
export function Audit() {
  const [searchParams, setSearchParams] = useSearchParams()
  const q = searchParams.get("q") ?? ""
  const action = searchParams.get("action") ?? ""
  const from = searchParams.get("from") ?? ""
  const to = searchParams.get("to") ?? ""
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

  // The server has no `from`/`to` — it only knows `q`, `action`, `limit`
  // and `offset` (read straight off `admin_audit` in backend/core/api.py).
  // A date range is therefore applied on whatever the server hands back
  // rather than by the server, which means fetching more than one page's
  // worth up front. `refining` picks between the cheap, common path (server
  // pagination, one page at a time) and the wider one only when a date
  // range is actually asked for.
  const refining = Boolean(from || to)

  const listQuery = new URLSearchParams()
  if (q) listQuery.set("q", q)
  if (action) listQuery.set("action", action)
  listQuery.set("limit", String(refining ? DATE_FETCH_CAP : PAGE_SIZE))
  listQuery.set("offset", String(refining ? 0 : page * PAGE_SIZE))

  const { data, isLoading, isError, error, refetch } = useApi<AuditPayload>(
    ["audit", q, action, refining, refining ? null : page],
    `/api/admin/audit?${listQuery.toString()}`,
    { placeholderData: (prev) => prev }
  )

  const dateFiltered = useMemo(() => {
    if (!refining || !data) return null
    return data.results.filter((r) => withinRange(r.created_at, from, to))
  }, [refining, data, from, to])

  const rows = refining
    ? (dateFiltered ?? []).slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)
    : data?.results ?? []
  const total = refining ? dateFiltered?.length ?? 0 : data?.total ?? 0
  // The batch this screen widened to for the date filter is itself capped —
  // if more rows matched the search and action than that cap, an older
  // entry inside the chosen range can be missing rather than merely absent.
  const maybeIncomplete = refining && (data?.total ?? 0) > DATE_FETCH_CAP

  useEffect(() => {
    if (!data) return
    const maxPage = Math.max(0, Math.ceil(total / PAGE_SIZE) - 1)
    if (page > maxPage) goToPage(maxPage)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, total])

  const filtered = Boolean(q) || Boolean(action) || Boolean(from) || Boolean(to)

  const columns: Column<AuditRow>[] = [
    {
      key: "when",
      header: "When",
      className: "w-40",
      cell: (r) => <span className="text-sm tabular">{formatDateTime(r.created_at)}</span>,
    },
    {
      key: "actor",
      header: "Actor",
      className: "max-w-[14rem]",
      cell: (r) =>
        r.actor ? (
          <Link
            to={`/people?q=${encodeURIComponent(r.actor)}`}
            className="block truncate text-sm underline-offset-2 hover:underline"
          >
            {r.actor}
          </Link>
        ) : (
          <span className="text-sm text-fg-muted">System</span>
        ),
    },
    {
      key: "action",
      header: "Action",
      cell: (r) => (
        <span className="block">
          <span className="block text-sm">{actionSentence(r.action)}</span>
          <Meta className="mt-0.5 block text-xs">{r.action}</Meta>
        </span>
      ),
    },
    {
      key: "entity",
      header: "Entity",
      className: "max-w-[12rem]",
      cell: (r) => {
        const href = entityHref(r.entity, r.entity_id)
        const label = r.entity_id ? `${r.entity} · ${r.entity_id}` : r.entity
        return href ? (
          <Link to={href} className="block truncate text-sm underline-offset-2 hover:underline" title={label}>
            {label}
          </Link>
        ) : (
          <span className="block truncate text-sm text-fg-muted" title={label}>
            {label}
          </span>
        )
      },
    },
    {
      key: "view",
      header: "",
      className: "w-20",
      cell: (r) => (
        <Button kind="quiet" size="sm" onClick={() => setSelected(r)}>
          View
        </Button>
      ),
    },
  ]

  return (
    <div className="page space-y-6">
      <header>
        <PageTitle>Audit log</PageTitle>
        <Sub className="mt-1">
          Every consequential action, recorded as it happened. Append-only — there is no edit here and
          nothing is ever removed.
        </Sub>
      </header>

      <div className="flex flex-wrap items-end gap-3">
        <div className="relative w-full max-w-xs">
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-fg-subtle"
            aria-hidden
          />
          <Input
            value={searchDraft}
            onChange={(e) => setSearchDraft(e.target.value)}
            placeholder="Actor, entity or record ID"
            aria-label="Search the audit log"
            className="pl-8"
          />
        </div>
        <Combobox
          value={action}
          onChange={(v) => setParam("action", v)}
          options={ACTION_OPTIONS}
          placeholder="All actions"
          aria-label="Filter by action"
          className="w-56"
        />
        <div className="flex items-end gap-2">
          <label className="block">
            <span className="mb-1.5 block text-xs text-fg-muted">From</span>
            <DateInput
              value={from}
              onChange={(e) => setParam("from", e.target.value)}
              aria-label="From date"
              className="w-36"
            />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-xs text-fg-muted">To</span>
            <DateInput
              value={to}
              onChange={(e) => setParam("to", e.target.value)}
              aria-label="To date"
              className="w-36"
            />
          </label>
        </div>
        {filtered && (
          <Button kind="quiet" size="sm" onClick={clearFilters}>
            Clear filters
          </Button>
        )}
      </div>

      {maybeIncomplete && (
        <p className="text-xs text-caution">
          More than {DATE_FETCH_CAP} entries match this search and action — an entry older than the most
          recent {DATE_FETCH_CAP} may fall inside this date range without appearing here. Narrow the
          search or action to be sure.
        </p>
      )}

      {isLoading ? (
        <>
          <SkeletonRows rows={10} rowHeight={44} className="hidden md:block" />
          <SkeletonRows rows={6} rowHeight={68} className="md:hidden" />
        </>
      ) : isError ? (
        error?.status === 403 ? (
          <ErrorState
            title="Not open to this account"
            message="The audit log is open to the research cell, system admins, the Principal and Finance."
          />
        ) : (
          <ErrorState
            title="Could not load the audit log"
            message="The server did not answer. Nothing has been lost."
            onRetry={() => refetch()}
          />
        )
      ) : rows.length === 0 ? (
        <EmptyState
          icon={filtered ? SearchX : History}
          title={filtered ? "Nothing matches" : "No activity recorded yet"}
          message={
            filtered
              ? "No entry matches this search, action and date range. Try a wider one."
              : "Consequential actions will appear here as they happen."
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
        <>
          <Table
            className="hidden md:block"
            rows={rows}
            getKey={(r) => r.id}
            minWidth="52rem"
            columns={columns}
          />

          <ul className="divide-y divide-line border-y border-line md:hidden">
            {rows.map((r) => (
              <AuditCard key={r.id} row={r} onOpen={() => setSelected(r)} />
            ))}
          </ul>

          <Pagination page={page} pageSize={PAGE_SIZE} total={total} onChange={goToPage} />
        </>
      )}

      <Sheet open={!!selected} onOpenChange={(open) => !open && setSelected(null)}>
        <SheetContent>
          {selected && (
            <>
              <SheetHeader>
                <SheetTitle>{actionSentence(selected.action)}</SheetTitle>
                <Meta className="mt-1 block">{formatDateTime(selected.created_at)}</Meta>
              </SheetHeader>
              <SheetBody className="space-y-4">
                <dl className="space-y-1.5 text-sm">
                  <div className="flex items-baseline justify-between gap-3">
                    <dt className="text-fg-muted">Actor</dt>
                    <dd className="text-right font-medium">
                      {selected.actor ? (
                        <Link
                          to={`/people?q=${encodeURIComponent(selected.actor)}`}
                          className="underline-offset-2 hover:underline"
                        >
                          {selected.actor}
                        </Link>
                      ) : (
                        "System"
                      )}
                    </dd>
                  </div>
                  <div className="flex items-baseline justify-between gap-3">
                    <dt className="text-fg-muted">Action code</dt>
                    <dd className="text-right font-medium">{selected.action}</dd>
                  </div>
                  <div className="flex items-baseline justify-between gap-3">
                    <dt className="text-fg-muted">Entity</dt>
                    <dd className="text-right font-medium">
                      {(() => {
                        const href = entityHref(selected.entity, selected.entity_id)
                        const label = selected.entity_id
                          ? `${selected.entity} · ${selected.entity_id}`
                          : selected.entity
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
                <div className="border-t border-line pt-4">
                  <AuditDetail raw={selected.detail_json} />
                </div>
              </SheetBody>
            </>
          )}
        </SheetContent>
      </Sheet>
    </div>
  )
}

/** The table's row, redrawn as a card below `md` — the same fields, stacked,
 *  and tapping it opens the same detail sheet the "View" button does. */
function AuditCard({ row, onOpen }: { row: AuditRow; onOpen: () => void }) {
  const href = entityHref(row.entity, row.entity_id)
  return (
    <li className="row">
      <button type="button" onClick={onOpen} className="block w-full px-1 py-3 text-left">
        <div className="flex items-start justify-between gap-3">
          <span className="min-w-0 flex-1">
            <span className="block text-base">{actionSentence(row.action)}</span>
            <Meta className="mt-0.5 block truncate">
              {row.actor ?? "System"} · {row.entity}
            </Meta>
          </span>
          <Meta className="shrink-0 text-right">{formatDateTime(row.created_at)}</Meta>
        </div>
      </button>
      {href && (
        <Link
          to={href}
          className="mb-2 ml-1 inline-flex items-center gap-1 text-xs text-fg-muted underline-offset-2 hover:underline"
        >
          Open {row.entity.toLowerCase()}
          <ExternalLink className="size-3" aria-hidden />
        </Link>
      )}
    </li>
  )
}

/** `total`/`offset` from the server when a page is fetched straight from it;
 *  the client-filtered count when a date range widened the fetch instead.
 *  Never a slice of rows already known to be incomplete without saying so —
 *  see `maybeIncomplete` above. */
function Pagination({
  page,
  pageSize,
  total,
  onChange,
}: {
  page: number
  pageSize: number
  total: number
  onChange: (page: number) => void
}) {
  if (total <= pageSize) return null

  const pageCount = Math.max(1, Math.ceil(total / pageSize))
  const start = page * pageSize + 1
  const end = Math.min(total, (page + 1) * pageSize)

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
      <Meta>
        {start}–{end} of {total}
      </Meta>
      <div className="flex items-center gap-1">
        <Button kind="quiet" size="sm" onClick={() => onChange(page - 1)} disabled={page === 0}>
          <ChevronLeft />
          Previous
        </Button>
        <Meta className="px-1 tabular">
          Page {page + 1} of {pageCount}
        </Meta>
        <Button kind="quiet" size="sm" onClick={() => onChange(page + 1)} disabled={page + 1 >= pageCount}>
          Next
          <ChevronRight />
        </Button>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------------ */
/* Faults                                                                   */
/* ------------------------------------------------------------------------ */

type FaultSeverity = "critical" | "warning" | "info"

type Fault = {
  key: string
  title: string
  detail: string
  count: number
  severity: FaultSeverity
  to: string | null
  sample: string[]
}

type FaultGroup = {
  key: string
  title: string
  blurb: string
  faults: Fault[]
}

type FaultsPayload = {
  groups: FaultGroup[]
  total: number
  urgent: number
  checked_at: string
}

const SEVERITY_RANK: Record<FaultSeverity, number> = { critical: 0, warning: 1, info: 2 }

const SEVERITY_TEXT: Record<FaultSeverity, string> = {
  critical: "text-critical",
  warning: "text-caution",
  info: "text-fg-muted",
}

// `admin_faults` points a fault at a path this app calls something else —
// `/admin/users`, `/admin/clearing` and `/finance` are not routes `main.tsx`
// declares (`/people`, `/clearing` and `/payments` are). Sending a reader to
// the literal string would be exactly the dead link `audit/routes.mjs` exists
// to catch elsewhere, so it is translated here instead of trusted outright.
const FAULT_DESTINATIONS: Record<string, string> = {
  "/admin/users": "/people",
  "/admin/clearing": "/clearing",
  "/finance": "/payments",
}

function destinationFor(to: string | null): string | null {
  if (!to) return null
  return FAULT_DESTINATIONS[to] ?? to
}

// A sample is a ticket number for a claim-shaped fault, or a name/email for
// a person-shaped one — the endpoint does not say which and does not carry
// an id either way, so a sample is only linked when it looks like a real
// ticket or contains an "@", using the same search the list screens already
// support rather than inventing a lookup.
function sampleHref(sample: string): string | null {
  if (sample === "(draft)") return null
  if (sample.includes("@")) return `/people?q=${encodeURIComponent(sample)}`
  if (/^[A-Za-z0-9/-]{4,}$/.test(sample)) return `/papers?q=${encodeURIComponent(sample)}`
  return `/people?q=${encodeURIComponent(sample)}`
}

function formatCheckedAt(iso: string): string {
  return new Date(iso).toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  })
}

/**
 * What is broken, blocked or unreconciled — grouped, counted, and openable,
 * so this replaces going and finding each of these by hand. A `count` of
 * zero for a check that ran is not hidden: it is what tells the reader the
 * check happened and found nothing, which is the only way an empty list
 * here reads as clean rather than as untried.
 */
export function Faults() {
  const { data, isLoading, isError, error, refetch } = useApi<FaultsPayload>(
    ["admin-faults"],
    "/api/admin/faults"
  )

  const sortedGroups = useMemo(() => {
    if (!data) return []
    const criticalCount = (g: FaultGroup) =>
      g.faults.reduce((sum, f) => sum + (f.severity === "critical" ? f.count : 0), 0)
    return [...data.groups]
      .sort((a, b) => criticalCount(b) - criticalCount(a))
      .map((g) => ({
        ...g,
        faults: [...g.faults].sort((a, b) => {
          const rank = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]
          return rank !== 0 ? rank : b.count - a.count
        }),
      }))
  }, [data])

  return (
    <div className="page space-y-6">
      <header>
        <PageTitle>Faults</PageTitle>
        <Sub className="mt-1">
          Data that blocks a person, work that has stalled, verification that could not confirm, and money
          that does not add up.
        </Sub>
      </header>

      {isLoading ? (
        <SkeletonRows rows={6} rowHeight={64} />
      ) : isError ? (
        error?.status === 403 ? (
          <ErrorState
            title="Not open to this account"
            message="This list is open to the research cell, system admins and the Principal."
          />
        ) : (
          <ErrorState
            title="Could not run the checks"
            message="The server did not answer. Nothing has been lost."
            onRetry={() => refetch()}
          />
        )
      ) : !data ? null : data.total === 0 ? (
        <EmptyState
          icon={CheckCircle2}
          title="Nothing broken, blocked or unreconciled"
          message={`Every check the office runs against the queue and the ledger came back clean, as of ${formatCheckedAt(data.checked_at)}.`}
        />
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-4 text-sm text-fg-muted">
            <span>
              <span className="tabular font-medium text-fg">{data.total}</span> fault
              {data.total === 1 ? "" : "s"} found
            </span>
            {data.urgent > 0 && (
              <span className="flex items-center gap-1.5 text-critical">
                <ShieldAlert className="size-4" aria-hidden />
                <span className="tabular font-medium">{data.urgent}</span> urgent
              </span>
            )}
            <span>Checked {formatCheckedAt(data.checked_at)}</span>
          </div>

          <div className="space-y-8">
            {sortedGroups.map((group) => (
              <FaultGroupSection key={group.key} group={group} />
            ))}
          </div>
        </>
      )}
    </div>
  )
}

function FaultGroupSection({ group }: { group: FaultGroup }) {
  return (
    <section>
      <SectionTitle>{group.title}</SectionTitle>
      <Sub className="mt-0.5">{group.blurb}</Sub>
      <ul className="mt-3 divide-y divide-line border-y border-line">
        {group.faults.map((fault) => (
          <FaultRow key={fault.key} fault={fault} />
        ))}
      </ul>
    </section>
  )
}

function FaultRow({ fault }: { fault: Fault }) {
  const destination = fault.count > 0 ? destinationFor(fault.to) : null
  const clear = fault.count === 0

  return (
    <li className={cn("flex flex-col gap-2 px-1 py-3", !clear && "row")}>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <p className={cn("text-base", clear ? "text-fg-muted" : "text-fg")}>{fault.title}</p>
          <p className="mt-0.5 text-sm text-fg-muted">{fault.detail}</p>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <span className={cn("tabular text-lg font-semibold", clear ? "text-fg-subtle" : SEVERITY_TEXT[fault.severity])}>
            {fault.count}
          </span>
          {destination && (
            <Button kind="default" size="sm" asChild>
              <Link to={destination}>
                Open
                <ExternalLink className="size-3.5" />
              </Link>
            </Button>
          )}
        </div>
      </div>
      {fault.count > 0 && fault.sample.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-fg-muted">
          <span>For example:</span>
          {fault.sample.map((s, i) => {
            const href = sampleHref(s)
            return (
              <span key={`${s}-${i}`} className="inline-flex items-center">
                {href ? (
                  <Link to={href} className="underline-offset-2 hover:underline">
                    {s}
                  </Link>
                ) : (
                  <span>{s}</span>
                )}
                {i < fault.sample.length - 1 && <span className="ml-1.5 text-fg-subtle">·</span>}
              </span>
            )
          })}
          {fault.count > fault.sample.length && <span>and {fault.count - fault.sample.length} more</span>}
        </div>
      )}
    </li>
  )
}
