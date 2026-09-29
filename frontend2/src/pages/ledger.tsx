import { useEffect, useState } from "react"
import { Link, useSearchParams } from "react-router-dom"
import { Download, Receipt, Search, SearchX, X } from "lucide-react"

import { can, useAuth } from "@/app/auth"
import { cn } from "@/lib/cn"
import { useApi } from "@/lib/query"
import { Button } from "@/ui/button"
import { shortMoney } from "@/ui/chart"
import { Chip } from "@/ui/chip"
import { Combobox, type ComboboxOption } from "@/ui/combobox"
import { Input } from "@/ui/field"
import { filterBar } from "@/ui/filter-bar"
import { money } from "@/ui/paper"
import { Pagination } from "@/ui/pagination"
import { Avatar, initialsOf } from "@/ui/person"
import { EmptyState, ErrorState, Skeleton, SkeletonRows } from "@/ui/state"
import { Table, type Column } from "@/ui/table"
import { ColumnLabel, Meta, PageTitle, SectionTitle, Sub } from "@/ui/text"

/**
 * Every rupee this college has moved under the scheme, in the order it moved.
 *
 * Append-only and read-only here, deliberately: a payment is undone by
 * `void-payment`, which writes a reversing row rather than removing the
 * original. A delete button here would be a lie about what the server does.
 *
 * Every figure on this page (the totals line, the month chart, the
 * department split, the export) is computed by the server over the whole
 * filter, never summed from the page on screen, so the screen and the
 * downloaded file cannot disagree about the same filter.
 */

const PAGE_SIZE = 50

/* ------------------------------------------------------------------------ */
/* Data: _ledger_row_dict() and admin_ledger() in backend/core/api/finance.py */
/* ------------------------------------------------------------------------ */

type Marker = "REVERSAL" | "MONTH_NOT_RECORDED" | "DUPLICATE"

type LedgerRow = {
  id: string
  claim_id: string | null
  /** "YYYY-MM", or null on an imported row that carried no month. */
  payout_month: string | null
  department: string | null
  faculty_name: string | null
  staff_id: string | null
  biometric_id: string | null
  paper_title: string | null
  journal_title: string | null
  amount: number
  voucher_number: string | null
  scheme?: "FYP" | "FACULTY"
  photo_url?: string | null
  markers?: Marker[]
  created_at: string | null
}

type MonthTotal = { month: string | null; amount: number; count: number }
type DeptTotal = { department: string | null; amount: number; count: number }

type LedgerPayload = {
  total: number
  limit: number
  offset: number
  /** The sum across the whole filter. Never the sum of `results`. */
  total_amount: number
  results: LedgerRow[]
  /** Ignores the month filter, so a chosen month is a lit bar among the rest. */
  by_month?: MonthTotal[]
  /** Rows whose month is only the import default; kept out of the bars. */
  no_month?: { amount: number; count: number }
  by_department?: DeptTotal[]
  people?: number
  /** Net payments: rows above ₹0, less reversals. */
  payments?: number
  duplicates_open?: number
}

/* ------------------------------------------------------------------------ */
/* Page                                                                      */
/* ------------------------------------------------------------------------ */

export function Ledger() {
  const { me } = useAuth()
  const allowed = can(me?.role).viewReports

  const [searchParams, setSearchParams] = useSearchParams()
  const month = searchParams.get("month") ?? ""
  const department = searchParams.get("department") ?? ""
  const q = searchParams.get("q") ?? ""
  const page = Math.max(0, Number.parseInt(searchParams.get("page") ?? "0", 10) || 0)

  // Typing stays local and reaches the URL (and the server) after a pause,
  // so a name is one request, not one per letter.
  const [draft, setDraft] = useState(q)
  useEffect(() => setDraft(q), [q])
  useEffect(() => {
    if (draft.trim() === q) return
    const t = window.setTimeout(() => setFilter("q", draft.trim()), 250)
    return () => window.clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft])

  function setFilter(name: "month" | "department" | "q", value: string) {
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

  function clearAll() {
    setDraft("")
    setSearchParams(new URLSearchParams())
  }

  // Built once and used for both the list and the export link, so the file
  // and the screen can never be looking at two different filters.
  const filters = new URLSearchParams()
  if (q) filters.set("q", q)
  if (month) filters.set("month", month)
  if (department) filters.set("department", department)

  const listQuery = new URLSearchParams(filters)
  listQuery.set("limit", String(PAGE_SIZE))
  listQuery.set("offset", String(page * PAGE_SIZE))

  const { data, isLoading, isError, error, refetch } = useApi<LedgerPayload>(
    ["ledger", q, month, department, page],
    `/api/admin/ledger?${listQuery.toString()}`,
    { enabled: allowed, placeholderData: (prev) => prev }
  )

  const departmentsQuery = useApi<string[]>(["meta", "departments"], "/api/meta/departments", {
    enabled: allowed,
  })
  const departmentOptions: ComboboxOption[] = [
    { value: "", label: "All departments" },
    ...(departmentsQuery.data || []).map((d) => ({ value: d, label: d })),
  ]

  // A filter can narrow the results out from under the page you are on.
  useEffect(() => {
    if (!data) return
    const maxPage = Math.max(0, Math.ceil(data.total / PAGE_SIZE) - 1)
    if (page > maxPage) goToPage(maxPage)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data])

  if (!allowed) {
    return (
      <div className="page py-8">
        <ErrorState
          art="closed-gate"
          title="Not open to this account"
          message="The ledger shows what each person was paid. Finance, the Principal and the research cell can read it."
        />
      </div>
    )
  }

  const rows = data?.results ?? []
  const total = data?.total ?? 0
  const filtered = Boolean(q) || Boolean(month) || Boolean(department)
  const loadingFirst = isLoading && !data

  return (
    <div className="page space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <PageTitle>Ledger</PageTitle>
          <Sub className="mt-1">
            Every payment made under the scheme, imported from the ERP and paid in this app.
            Nothing is ever deleted: a wrong payment is voided by a reversing row.
          </Sub>
        </div>
        {data && (data.duplicates_open ?? 0) > 0 && (
          <Button kind="quiet" size="sm" asChild>
            <Link to="/duplicates">
              {data.duplicates_open} possible {data.duplicates_open === 1 ? "duplicate" : "duplicates"} to
              review
            </Link>
          </Button>
        )}
      </header>

      {!(isError && !data) && (
        <Totals data={data} filtered={filtered} month={month} loading={loadingFirst} />
      )}

      {data && (data.by_month?.length ?? 0) > 1 && (
        <MonthBars
          months={data.by_month ?? []}
          noMonth={data.no_month}
          selected={month}
          onPick={(m) => setFilter("month", m === month ? "" : m)}
        />
      )}

      <div className={filterBar}>
        <label className="block min-w-0 grow basis-64">
          <ColumnLabel className="mb-1 block">Find a payment</ColumnLabel>
          <span className="relative block">
            <Search
              aria-hidden
              className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-fg-muted"
            />
            <Input
              type="search"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Name, staff id, paper, voucher"
              aria-label="Search payments by name, staff id, paper or voucher"
              className="w-full pl-8"
            />
          </span>
        </label>
        <label className="block">
          <ColumnLabel className="mb-1 block">Month paid</ColumnLabel>
          <Input
            type="month"
            value={month}
            onChange={(e) => setFilter("month", e.target.value)}
            aria-label="Filter by month paid"
            className="w-44"
          />
        </label>
        <div className="block">
          <ColumnLabel className="mb-1 block">Department</ColumnLabel>
          <Combobox
            value={department}
            onChange={(next) => setFilter("department", next)}
            options={departmentOptions}
            placeholder={departmentsQuery.isLoading ? "Loading…" : "All departments"}
            disabled={departmentsQuery.isLoading}
            aria-label="Filter by department"
            className="w-56 max-w-full"
          />
        </div>
        <div className="flex flex-wrap items-center gap-2 sm:ml-auto">
          {filtered && (
            <Button kind="quiet" size="md" onClick={clearAll}>
              <X />
              Clear filters
            </Button>
          )}
          {/* A real link, not a fetch: the browser's own download machinery
              handles the file and the cookie goes with it same-origin. */}
          <Button kind="default" size="md" asChild>
            <a href={`/api/admin/ledger/export?${filters.toString()}`} download>
              <Download />
              {filtered
                ? `Export ${total.toLocaleString("en-IN")} ${total === 1 ? "row" : "rows"} (CSV)`
                : "Export everything (CSV)"}
            </a>
          </Button>
        </div>
      </div>

      {loadingFirst ? (
        <SkeletonRows rows={10} rowHeight={56} />
      ) : isError ? (
        <ErrorState
          title="Could not load the ledger"
          message={
            error?.status === 403
              ? "Not allowed. Finance, the Principal and the research cell can read the ledger."
              : "The server did not answer. No payment has been lost; this screen only reads."
          }
          onRetry={error?.status === 403 ? undefined : () => refetch()}
        />
      ) : rows.length === 0 ? (
        <EmptyState
          art={filtered ? "no-results" : "nothing-paid"}
          icon={filtered ? SearchX : Receipt}
          title={filtered ? "No payment matches" : "No payment has been made yet"}
          message={
            filtered
              ? "Nothing matches this search and filter. Try a shorter name or fewer filters."
              : "Once Finance settles the first claim, it appears here and stays here."
          }
          action={
            filtered ? (
              <Button kind="default" size="sm" onClick={clearAll}>
                Clear filters
              </Button>
            ) : undefined
          }
        />
      ) : (
        <>
          <div className="hidden md:block">
            <Table
              rows={rows}
              columns={columns}
              getKey={(r) => r.id}
              // Only rows that came from a claim have somewhere to go; an
              // imported ERP payment has no ticket behind it.
              rowLink={(r) => (r.claim_id ? `/papers/${r.claim_id}` : null)}
              minWidth="56rem"
              caption="Payments matching the filter"
            />
          </div>
          <ul className="grid grid-cols-[minmax(0,1fr)] gap-2 md:hidden" aria-label="Payments">
            {rows.map((r) => (
              <PaymentCard key={r.id} row={r} />
            ))}
          </ul>
          <Pagination page={page} pageSize={PAGE_SIZE} total={total} onChange={goToPage} />
        </>
      )}

      {data && (data.by_department?.length ?? 0) > 1 && (
        <Departments
          rows={data.by_department ?? []}
          total={data.total_amount}
          selected={department}
          onPick={(d) => setFilter("department", d === department ? "" : d)}
        />
      )}
    </div>
  )
}

/* ------------------------------------------------------------------------ */
/* Table columns and phone cards                                              */
/* ------------------------------------------------------------------------ */

const MARKER_TEXT: Record<Marker, string> = {
  REVERSAL: "Reversal",
  MONTH_NOT_RECORDED: "Month not recorded",
  DUPLICATE: "On the duplicates list",
}

const MARKER_WHY: Record<Marker, string> = {
  REVERSAL: "A voided payment, written as a negative row so the original stays readable.",
  MONTH_NOT_RECORDED: "The ERP sheet gave no month; the one shown is the import's.",
  DUPLICATE: "The same person may have been paid twice for this paper. Reviewed on the duplicates page.",
}

function Markers({ row }: { row: LedgerRow }) {
  // "Month not recorded" is said in the month itself, not as a chip.
  const markers = (row.markers ?? []).filter((m) => m !== "MONTH_NOT_RECORDED")
  if (!markers.length && row.scheme !== "FYP") return null
  return (
    <span className="mt-1 flex flex-wrap gap-1">
      {row.scheme === "FYP" && <Chip>Final-year project scheme</Chip>}
      {markers.map((m) =>
        m === "DUPLICATE" ? (
          <Link
            key={m}
            to="/duplicates"
            title={MARKER_WHY[m]}
            onClick={(e) => e.stopPropagation()}
            className="relative z-10 rounded-full focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
          >
            <Chip tone="caution">{MARKER_TEXT[m]}</Chip>
          </Link>
        ) : (
          <Chip key={m} tone={m === "REVERSAL" ? "caution" : "neutral"} title={MARKER_WHY[m]}>
            {MARKER_TEXT[m]}
          </Chip>
        )
      )}
    </span>
  )
}

function Face({ row, size = "sm" }: { row: LedgerRow; size?: "sm" | "md" }) {
  const name = row.faculty_name || "Unknown"
  return (
    <Avatar
      size={size}
      person={{ name, initials: initialsOf(name), photo_url: row.photo_url ?? null }}
    />
  )
}

function Amount({ value }: { value: number }) {
  return (
    <span className={cn("tabular font-medium whitespace-nowrap", value < 0 && "text-caution")}>
      {money(value)}
    </span>
  )
}

const columns: Column<LedgerRow>[] = [
  {
    key: "faculty",
    header: "Paid to",
    className: "w-[15rem] max-w-[15rem]",
    cell: (r) => (
      <span className="flex min-w-0 items-center gap-2.5">
        <Face row={r} />
        <span className="block min-w-0">
          <span className="block truncate text-sm font-medium">{r.faculty_name || "Name not recorded"}</span>
          <Meta className="block truncate">
            {[r.staff_id, r.department].filter(Boolean).join(" · ") || "No staff id"}
          </Meta>
        </span>
      </span>
    ),
  },
  {
    key: "paper",
    header: "Paper",
    cell: (r) => (
      <span className="block min-w-0 max-w-[26rem]">
        <span className="block truncate">{r.paper_title || "Title not recorded"}</span>
        <Meta className="block truncate">{r.journal_title || "Journal not recorded"}</Meta>
        <Markers row={r} />
      </span>
    ),
  },
  {
    key: "month",
    header: "Month",
    className: "w-28 whitespace-nowrap",
    cell: (r) =>
      hasMonth(r) ? <span className="tabular">{monthLabel(r.payout_month)}</span> : <Meta>Not recorded</Meta>,
  },
  {
    key: "voucher",
    header: "Voucher",
    className: "w-32",
    cell: (r) =>
      r.voucher_number ? <span className="tabular">{r.voucher_number}</span> : <Meta>Not recorded</Meta>,
  },
  {
    key: "amount",
    header: "Amount",
    align: "right",
    className: "w-32",
    cell: (r) => <Amount value={r.amount} />,
  },
]

function PaymentCard({ row }: { row: LedgerRow }) {
  const body = (
    <>
      <span className="flex items-start gap-3">
        <Face row={row} size="md" />
        <span className="min-w-0 grow">
          <span className="flex items-baseline justify-between gap-2">
            <span className="truncate font-medium">{row.faculty_name || "Name not recorded"}</span>
            <Amount value={row.amount} />
          </span>
          <Meta className="block truncate">
            {[hasMonth(row) ? monthLabel(row.payout_month) : "Month not recorded", row.department, row.staff_id].filter(Boolean).join(" · ")}
          </Meta>
        </span>
      </span>
      <span className="mt-2 block text-sm break-words">{row.paper_title || "Title not recorded"}</span>
      <Meta className="block">
        {row.voucher_number ? `Voucher ${row.voucher_number}` : "Voucher not recorded"}
      </Meta>
      <Markers row={row} />
    </>
  )
  const box = "block rounded-lg bg-surface p-3 ring-1 ring-edge"
  return (
    <li>
      {row.claim_id ? (
        <Link
          to={`/papers/${row.claim_id}`}
          className={cn(box, "hover:bg-hover focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none")}
        >
          {body}
        </Link>
      ) : (
        <div className={box}>{body}</div>
      )}
    </li>
  )
}

/* ------------------------------------------------------------------------ */
/* Totals: how much, when, to whom, in one line                               */
/* ------------------------------------------------------------------------ */

function Totals({
  data,
  filtered,
  month,
  loading,
}: {
  data: LedgerPayload | undefined
  filtered: boolean
  month: string
  loading: boolean
}) {
  if (loading || !data) {
    return (
      <div className="border-y border-line py-3">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="mt-2 h-3 w-80 max-w-full" />
      </div>
    )
  }
  const months = (data.by_month ?? []).filter((m) => m.month)
  const first = months[0]?.month
  const last = months[months.length - 1]?.month
  const span = month
    ? `in ${monthLabel(month)}`
    : first && last
      ? first === last
        ? `in ${monthLabel(first)}`
        : `from ${monthLabel(first)} to ${monthLabel(last)}`
      : ""
  const people = data.people ?? 0
  // Rows are not payments: a ₹0 quota row pays nobody and a reversal cancels one.
  const payments = data.payments ?? data.total
  return (
    <section
      aria-label="Totals"
      className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-y border-line py-3"
    >
      <span className="text-3xl font-semibold tabular">{money(data.total_amount)}</span>
      <span className="text-fg-muted">
        {filtered ? "matching this filter, " : "paid "}
        {span && `${span}, `}
        across {payments.toLocaleString("en-IN")} {payments === 1 ? "payment" : "payments"}
        {people > 0 && ` to ${people.toLocaleString("en-IN")} ${people === 1 ? "person" : "people"}`}
      </span>
    </section>
  )
}

/* ------------------------------------------------------------------------ */
/* Month by month                                                             */
/* ------------------------------------------------------------------------ */

/**
 * One bar per payout month, a single hue, zero baseline, and the full figure
 * on hover and focus. Each bar is a button that filters to its month; the
 * numbers behind the picture are one click away as a real table.
 */
function MonthBars({
  months,
  noMonth,
  selected,
  onPick,
}: {
  months: MonthTotal[]
  noMonth?: { amount: number; count: number }
  selected: string
  onPick: (month: string) => void
}) {
  const shown = months.filter((m) => m.month)
  const top = Math.max(1, ...shown.map((m) => m.amount))
  const [at, setAt] = useState<number | null>(null)
  const focus = at != null ? shown[at] : shown.find((m) => m.month === selected)
  const everyYear = shown.map((m, i) => i === 0 || m.month!.endsWith("-01"))

  return (
    <section aria-label="Paid each month" className="space-y-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <SectionTitle>Paid each month</SectionTitle>
        <Meta aria-live="polite">
          {focus
            ? `${monthLabel(focus.month)}: ${money(focus.amount)} in ${focus.count.toLocaleString("en-IN")} ${focus.count === 1 ? "payment" : "payments"}`
            : "Choose a bar to see that month's payments"}
        </Meta>
      </div>
      <div className="flex gap-2">
        <div className="flex h-36 flex-col justify-between py-0.5 text-right text-xs text-fg-muted tabular">
          <span>{shortMoney(top)}</span>
          <span>{shortMoney(top / 2)}</span>
          <span>₹0</span>
        </div>
        <div className="min-w-0 grow">
          <div
            className="flex h-36 items-end gap-px border-b border-line"
            onMouseLeave={() => setAt(null)}
          >
            {shown.map((m, i) => {
              const on = m.month === selected
              const h = Math.max(0, (m.amount / top) * 100)
              return (
                <button
                  key={m.month}
                  type="button"
                  onClick={() => onPick(m.month!)}
                  onMouseEnter={() => setAt(i)}
                  onFocus={() => setAt(i)}
                  onBlur={() => setAt(null)}
                  aria-pressed={on}
                  aria-label={`${monthLabel(m.month)}, ${money(m.amount)}, ${m.count} payments`}
                  className="group flex h-full min-w-0 flex-1 items-end rounded-t-sm focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
                >
                  <span
                    className={cn(
                      "block w-full rounded-t-sm transition-colors",
                      on
                        ? "bg-accent"
                        : selected
                          ? "bg-accent/25 group-hover:bg-accent/60"
                          : "bg-accent/70 group-hover:bg-accent"
                    )}
                    style={{ height: `${h}%`, minHeight: m.amount > 0 ? 2 : 0 }}
                  />
                </button>
              )
            })}
          </div>
          <div className="flex gap-px text-xs text-fg-muted" aria-hidden>
            {shown.map((m, i) => (
              <span key={m.month} className="min-w-0 flex-1 overflow-visible whitespace-nowrap">
                {everyYear[i] ? m.month!.slice(0, 4) : ""}
              </span>
            ))}
          </div>
        </div>
      </div>
      {noMonth && noMonth.count > 0 && (
        <Meta className="block">
          {money(noMonth.amount)} in {noMonth.count.toLocaleString("en-IN")}{" "}
          {noMonth.count === 1 ? "payment has" : "payments have"} no month recorded, so{" "}
          {noMonth.count === 1 ? "it is" : "they are"} not in the bars (the total above includes{" "}
          {noMonth.count === 1 ? "it" : "them"}).
        </Meta>
      )}
      <details className="text-sm">
        <summary className="cursor-pointer text-fg-muted hover:text-fg">Show the numbers</summary>
        <div className="mt-2 max-h-72 overflow-auto rounded-lg ring-1 ring-edge">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-sunken">
                <th scope="col" className="px-3 py-1.5 text-left font-medium">Month</th>
                <th scope="col" className="px-3 py-1.5 text-right font-medium">Payments</th>
                <th scope="col" className="px-3 py-1.5 text-right font-medium">Amount</th>
              </tr>
            </thead>
            <tbody>
              {[...shown].reverse().map((m) => (
                <tr key={m.month} className="border-t border-line">
                  <td className="px-3 py-1.5">{monthLabel(m.month)}</td>
                  <td className="px-3 py-1.5 text-right tabular">{m.count.toLocaleString("en-IN")}</td>
                  <td className="px-3 py-1.5 text-right tabular">{money(m.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </section>
  )
}

/* ------------------------------------------------------------------------ */
/* By department                                                              */
/* ------------------------------------------------------------------------ */

function Departments({
  rows,
  total,
  selected,
  onPick,
}: {
  rows: DeptTotal[]
  total: number
  selected: string
  onPick: (department: string) => void
}) {
  const top = Math.max(1, ...rows.map((r) => r.amount))
  return (
    <section aria-label="By department" className="space-y-2">
      <SectionTitle>By department</SectionTitle>
      <ul className="grid grid-cols-[minmax(0,1fr)] gap-x-8 gap-y-1 md:grid-cols-2">
        {rows.map((r) => {
          const name = r.department || "No department"
          const share = total > 0 ? Math.round((r.amount / total) * 100) : 0
          return (
            <li key={name}>
              <button
                type="button"
                disabled={!r.department}
                title={r.department ? undefined : "These rows carry no department to filter by"}
                onClick={() => r.department && onPick(r.department)}
                aria-pressed={r.department === selected}
                className="grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 rounded px-1 py-1 text-left hover:bg-hover focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none disabled:cursor-default disabled:hover:bg-transparent"
              >
                <span className="truncate text-sm">{name}</span>
                <span className="text-sm font-medium tabular">{money(r.amount)}</span>
                <span className="col-span-2 mt-1 flex items-center gap-2">
                  <span className="h-1.5 grow rounded-full bg-sunken">
                    <span
                      className="block h-full rounded-full bg-accent/70"
                      style={{ width: `${Math.max(0, (r.amount / top) * 100)}%` }}
                    />
                  </span>
                  <Meta className="w-28 text-right tabular">
                    {share}% · {r.count.toLocaleString("en-IN")} paid
                  </Meta>
                </span>
              </button>
            </li>
          )
        })}
      </ul>
    </section>
  )
}

/* ------------------------------------------------------------------------ */
/* Helpers                                                                   */
/* ------------------------------------------------------------------------ */

function hasMonth(r: LedgerRow): boolean {
  return Boolean(r.payout_month) && !(r.markers ?? []).includes("MONTH_NOT_RECORDED")
}

/** "2026-08" as "Aug 2026". */
function monthLabel(value: string | null | undefined): string {
  if (!value) return "Month not recorded"
  const [year, month] = value.split("-")
  const index = Number.parseInt(month ?? "", 10)
  if (!year || Number.isNaN(index) || index < 1 || index > 12) return value
  const d = new Date(Date.UTC(Number.parseInt(year, 10), index - 1, 1))
  return d.toLocaleDateString("en-IN", { month: "short", year: "numeric", timeZone: "UTC" })
}
