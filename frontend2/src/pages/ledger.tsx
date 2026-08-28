import { useEffect } from "react"
import { useSearchParams } from "react-router-dom"
import { Download, Receipt, SearchX } from "lucide-react"

import { can, useAuth } from "@/app/auth"
import { useApi } from "@/lib/query"
import { Button } from "@/ui/button"
import { Combobox, type ComboboxOption } from "@/ui/combobox"
import { Input } from "@/ui/field"
import { money } from "@/ui/paper"
import { Pagination } from "@/ui/pagination"
import { EmptyState, ErrorState, Skeleton, SkeletonRows } from "@/ui/state"
import { Table, type Column } from "@/ui/table"
import { ColumnLabel, Meta, PageTitle, Sub } from "@/ui/text"

/**
 * Every rupee this college has moved under the scheme, in the order it moved.
 *
 * The ledger is append-only and this screen offers no way to change a row,
 * deliberately: a payment is undone by `void-payment`, which writes a
 * *reversing* row rather than removing the original, so the history of a
 * mistake stays readable. A delete button here would be a lie about what the
 * server does.
 *
 * The figure at the top is the sum of **everything the filter matches**, not
 * of the page on screen. That distinction is not pedantry — the old screen
 * showed one page's worth beside an Export button that wrote every matching
 * row, so the total on screen and the total in the downloaded file disagreed
 * about the same filter, and the person reconciling them had no way to tell
 * which one was wrong.
 */

const PAGE_SIZE = 50

/* ------------------------------------------------------------------------ */
/* Data — read out of _ledger_row_dict() in backend/core/api.py             */
/* ------------------------------------------------------------------------ */

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
  created_at: string | null
}

type LedgerPayload = {
  total: number
  limit: number
  offset: number
  /** The sum across the whole filter. Never the sum of `results`. */
  total_amount: number
  results: LedgerRow[]
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
  const page = Math.max(0, Number.parseInt(searchParams.get("page") ?? "0", 10) || 0)

  function setFilter(name: "month" | "department", value: string) {
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

  // Built once and used for both the list and the export link, so the file
  // and the screen can never be looking at two different filters.
  const filters = new URLSearchParams()
  if (month) filters.set("month", month)
  if (department) filters.set("department", department)

  const listQuery = new URLSearchParams(filters)
  listQuery.set("limit", String(PAGE_SIZE))
  listQuery.set("offset", String(page * PAGE_SIZE))

  const { data, isLoading, isError, error, refetch } = useApi<LedgerPayload>(
    ["ledger", month, department, page],
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
          message="The ledger is money, and money is not a head of department's business. Finance, the Principal and the research cell can read it."
        />
      </div>
    )
  }

  const rows = data?.results ?? []
  const total = data?.total ?? 0
  const filtered = Boolean(month) || Boolean(department)

  const columns: Column<LedgerRow>[] = [
    {
      key: "paper",
      header: "Paper",
      cell: (r) => (
        <span className="block min-w-0">
          <span className="block truncate text-base">{r.paper_title || "Untitled"}</span>
          <Meta className="mt-0.5 block truncate">{r.journal_title || "Journal not recorded"}</Meta>
        </span>
      ),
    },
    {
      key: "faculty",
      header: "Paid to",
      className: "max-w-[14rem]",
      cell: (r) => (
        <span className="block min-w-0">
          <span className="block truncate text-sm">{r.faculty_name || "—"}</span>
          <Meta className="mt-0.5 block truncate">{r.department || "No department"}</Meta>
        </span>
      ),
    },
    {
      key: "month",
      header: "Payout month",
      className: "w-32",
      cell: (r) => <span className="text-sm tabular">{monthLabel(r.payout_month)}</span>,
    },
    {
      key: "voucher",
      header: "Voucher",
      className: "w-36",
      cell: (r) =>
        r.voucher_number ? (
          <span className="text-sm tabular">{r.voucher_number}</span>
        ) : (
          // An imported historical row often has no voucher. Saying so beats
          // a blank cell, which reads as a field somebody forgot to fill in.
          <Meta>Not recorded</Meta>
        ),
    },
    {
      key: "amount",
      header: "Amount",
      align: "right",
      className: "w-32",
      cell: (r) => <span className="text-sm font-medium">{money(r.amount)}</span>,
    },
  ]

  return (
    <div className="page space-y-6">
      <header>
        <PageTitle>Ledger</PageTitle>
        <Sub className="mt-1">
          Every payment made under the scheme. Nothing here is ever deleted — a payment that
          was wrong is voided, which writes a reversing row of its own.
        </Sub>
      </header>

      <div className="flex flex-wrap items-end gap-3">
        <label className="block">
          <ColumnLabel className="mb-1 block">Payout month</ColumnLabel>
          <Input
            type="month"
            value={month}
            onChange={(e) => setFilter("month", e.target.value)}
            aria-label="Filter by payout month"
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
            className="w-56"
          />
        </div>
        {filtered && (
          <Button kind="quiet" size="md" onClick={() => setSearchParams(new URLSearchParams())}>
            Clear
          </Button>
        )}
        <div className="ml-auto">
          {/* A real link, not a fetch: the browser's own download machinery
              handles the file, the cookie goes with it same-origin, and a
              120MB export never has to be held in memory first. */}
          <Button kind="default" size="md" asChild>
            <a href={`/api/admin/ledger/export?${filters.toString()}`} download>
              <Download />
              Export {filtered ? "these rows" : "everything"}
            </a>
          </Button>
        </div>
      </div>

      {/* Withheld entirely when the request failed and there is nothing
          cached behind it. `money(undefined)` renders an em dash and the
          sentence under it would go on claiming "across 0 payments" — a
          figure and a count that read as "nothing was ever paid" sitting
          directly above a banner saying the server did not answer. */}
      {!(isError && !data) && (
        <Totals
          amount={data?.total_amount}
          count={total}
          filtered={filtered}
          loading={isLoading && !data}
        />
      )}

      {isLoading && !data ? (
        <SkeletonRows rows={10} rowHeight={48} />
      ) : isError ? (
        <ErrorState
          title="Could not load the ledger"
          message={
            error?.status === 403
              ? "Not allowed. Finance, the Principal and the research cell can read the ledger."
              : "The server did not answer. No payment has been lost — this screen only reads."
          }
          onRetry={error?.status === 403 ? undefined : () => refetch()}
        />
      ) : rows.length === 0 ? (
        <EmptyState
          // `art` wins over `icon`, so the scene has to carry the whole
          // distinction: a filter that matched none of a populated ledger is
          // not the same picture as a ledger nothing has ever been paid out
          // of, and one drawing for both says the wrong thing to whichever
          // reader is looking at the other case.
          art={filtered ? "no-results" : "nothing-paid"}
          icon={filtered ? SearchX : Receipt}
          title={filtered ? "No payment matches this filter" : "No payment has been made yet"}
          message={
            filtered
              ? "Nothing was paid in this month, to this department, or both. Try widening it."
              : "Once Finance settles the first claim, it appears here and stays here."
          }
          action={
            filtered ? (
              <Button
                kind="default"
                size="sm"
                onClick={() => setSearchParams(new URLSearchParams())}
              >
                Clear filters
              </Button>
            ) : undefined
          }
        />
      ) : (
        <>
          <Table
            rows={rows}
            columns={columns}
            getKey={(r) => r.id}
            // Only rows that came from a claim have somewhere to go; an
            // imported ERP payment has no ticket behind it, and a link that
            // 404s is worse than no link.
            rowLink={(r) => (r.claim_id ? `/papers/${r.claim_id}` : null)}
            minWidth="52rem"
          />
          <Pagination page={page} pageSize={PAGE_SIZE} total={total} onChange={goToPage} />
        </>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------------ */
/* Totals                                                                    */
/* ------------------------------------------------------------------------ */

/**
 * What the current filter comes to, in full.
 *
 * The sentence under the figure exists because the number is not the sum of
 * the rows visible on screen, and a reader adding up the page to check it
 * would find it did not tally and conclude the ledger was wrong.
 */
function Totals({
  amount,
  count,
  filtered,
  loading,
}: {
  amount: number | undefined
  count: number
  filtered: boolean
  loading: boolean
}) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1 border-y border-line py-3">
      <div>
        <ColumnLabel className="block">{filtered ? "Matching this filter" : "Paid in total"}</ColumnLabel>
        {loading ? (
          <Skeleton className="mt-1 h-7 w-32" />
        ) : (
          <p className="text-2xl font-semibold tabular">{money(amount)}</p>
        )}
      </div>
      {loading ? (
        // The count is as unknown as the figure while the request is out,
        // and "across 0 payments" is a claim, not a placeholder.
        <Skeleton className="h-3 w-72" />
      ) : (
        <Meta>
          across {count.toLocaleString("en-IN")} {count === 1 ? "payment" : "payments"} — the whole
          filter, not this page, and the same rows the export writes
        </Meta>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------------ */
/* Helpers                                                                   */
/* ------------------------------------------------------------------------ */

/** "2026-08" as "Aug 2026". The raw form sorts, but nobody reads a month
 *  as a number when it sits in a column beside a person's name. */
function monthLabel(value: string | null): string {
  if (!value) return "—"
  const [year, month] = value.split("-")
  const index = Number.parseInt(month ?? "", 10)
  if (!year || Number.isNaN(index) || index < 1 || index > 12) return value
  const d = new Date(Date.UTC(Number.parseInt(year, 10), index - 1, 1))
  return d.toLocaleDateString("en-IN", { month: "short", year: "numeric", timeZone: "UTC" })
}
