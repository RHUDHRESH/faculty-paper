import { useEffect, useState } from "react"
import { Link, useSearchParams } from "react-router-dom"
import { FilePlus, Plus, Search, SearchX } from "lucide-react"

import { useApi } from "@/lib/query"
import { cn } from "@/lib/cn"
import { Button } from "@/ui/button"
import { Input } from "@/ui/field"
import { Table, type Column } from "@/ui/table"
import { EmptyState, ErrorState, SkeletonRows } from "@/ui/state"
import { Meta, PageTitle, Sub } from "@/ui/text"
import { money, Stage, stageOf } from "@/ui/paper"
import { Pagination } from "@/ui/pagination"

/**
 * A faculty member's own papers — every ticket they have ever filed, plus
 * the drafts they haven't.
 *
 * This is one of the two screens almost every one of the 499 faculty
 * accounts opens, usually looking for one paper among dozens, so the three
 * things that matter are: finding it fast (stage filter, search, both in the
 * URL so a filtered view survives a reload or gets sent to someone), never
 * mistaking "the server did not answer" for "you have filed nothing" (a
 * claimant who sees that believes their work was lost), and never showing an
 * unverified amount as though it were settled — the figure is what somebody
 * plans a purchase around.
 */

type Claim = {
  id: string
  ticket_number: string | null
  paper_title: string
  journal_title: string | null
  publication_year: number | null
  status: string
  remuneration: number | null
  remuneration_is_estimate: boolean
  calc_error: string | null
  waiting_days: number | null
}

type ClaimsPayload = {
  total: number
  limit: number
  offset: number
  results: Claim[]
}

const PAGE_SIZE = 20

// The chain from API.md, mapped to the one status value each stage's
// button asks the server for. `stageOf` still does the actual status-to-
// stage reading everywhere a row is drawn — this list only exists so the
// filter buttons have something to query and count against.
//
// `stage` is the key `/api/claims/counts` groups by, and it covers the legacy
// ERP aliases too — "Filed" counts SUBMITTED *and* HOD_APPROVED, "Checked"
// counts CLEARED *and* RESEARCH_APPROVED. The list endpoint still takes a
// single `status`, so selecting a chip asks for the modern one; an imported
// legacy row is therefore counted correctly but not yet listed under its
// chip. Fixing that properly means the list endpoint accepting a stage, which
// is a server change rather than something to paper over here.
const STAGE_FILTERS: { status: string; stage: string; label: string }[] = [
  { status: "", stage: "all", label: "All" },
  { status: "DRAFT", stage: "draft", label: "Draft" },
  { status: "SUBMITTED", stage: "filed", label: "Filed" },
  { status: "CLEARED", stage: "checked", label: "Checked" },
  { status: "PRINCIPAL_APPROVED", stage: "approved", label: "Approved" },
  { status: "DIRECTOR_APPROVED", stage: "authorised", label: "Authorised" },
  { status: "PAID", stage: "paid", label: "Paid" },
  { status: "REJECTED", stage: "sent_back", label: "Sent back" },
]

function waitingLabel(days: number | null | undefined): string {
  if (days == null) return "—"
  if (days <= 0) return "Today"
  if (days === 1) return "1 day"
  return `${days} days`
}

export function Papers() {
  const [searchParams, setSearchParams] = useSearchParams()
  const status = searchParams.get("status") ?? ""
  const q = searchParams.get("q") ?? ""
  const page = Math.max(0, Number.parseInt(searchParams.get("page") ?? "0", 10) || 0)

  // The box's own state, so typing feels instant; the URL only catches up
  // once typing pauses, which is what keeps a search from rewriting history
  // on every keystroke.
  const [searchDraft, setSearchDraft] = useState(q)

  useEffect(() => {
    setSearchDraft(q)
  }, [q])

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

  function selectStatus(next: string) {
    setSearchParams((prev) => {
      const params = new URLSearchParams(prev)
      if (next) params.set("status", next)
      else params.delete("status")
      params.delete("page")
      return params
    })
  }

  function goToPage(next: number) {
    setSearchParams((prev) => {
      const params = new URLSearchParams(prev)
      if (next > 0) params.set("page", String(next))
      else params.delete("page")
      return params
    })
  }

  function clearFilters() {
    setSearchDraft("")
    setSearchParams(new URLSearchParams())
  }

  const listQuery = new URLSearchParams()
  if (status) listQuery.set("status", status)
  if (q) listQuery.set("q", q)
  listQuery.set("limit", String(PAGE_SIZE))
  listQuery.set("offset", String(page * PAGE_SIZE))

  const { data, isLoading, isError, refetch } = useApi<ClaimsPayload>(
    ["claims", status, q, page],
    `/api/claims?${listQuery.toString()}`,
    // Keeps the previous page's rows on screen while the next page loads,
    // so turning a page doesn't flash a skeleton over a list already full
    // of real rows.
    { placeholderData: (prev) => prev }
  )

  // Every chip's number in one request, scoped to the current search text so
  // the counts describe what is actually reachable right now rather than the
  // whole account. This was seven requests — one per chip — until the server
  // grew an endpoint that groups by stage in a single query.
  const { data: countData } = useApi<{ counts: Record<string, number> }>(
    ["claims-counts", q] as const,
    `/api/claims/counts${q ? `?q=${encodeURIComponent(q)}` : ""}`,
    { staleTime: 30_000 }
  )
  const counts = countData?.counts

  // The offset can end up past the end after a filter narrows the result
  // set out from under the current page — back to the last real page
  // rather than showing a page that no longer exists.
  useEffect(() => {
    if (!data) return
    const maxPage = Math.max(0, Math.ceil(data.total / PAGE_SIZE) - 1)
    if (page > maxPage) goToPage(maxPage)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data])

  const claims = data?.results ?? []
  const total = data?.total ?? 0
  const filtered = Boolean(status) || Boolean(q)

  const columns: Column<Claim>[] = [
    {
      key: "title",
      header: "Paper",
      className: "max-w-[22rem]",
      cell: (c) => (
        <span className="block">
          <span className="block truncate text-base">{c.paper_title || "Untitled"}</span>
          <Meta className="mt-0.5 block truncate">
            {c.ticket_number || (c.status === "DRAFT" ? "Not filed yet" : "—")}
          </Meta>
        </span>
      ),
    },
    {
      key: "stage",
      header: "Stage",
      className: "w-36",
      cell: (c) => <Stage stage={stageOf(c.status)} />,
    },
    {
      key: "journal",
      header: "Journal",
      className: "max-w-[14rem]",
      cell: (c) => <span className="line-clamp-2 text-sm text-fg-muted">{c.journal_title || "—"}</span>,
    },
    {
      key: "year",
      header: "Year",
      className: "w-16",
      cell: (c) => <span className="tabular">{c.publication_year ?? "—"}</span>,
    },
    {
      key: "amount",
      header: "Amount",
      align: "right",
      cell: (c) => <AmountCell claim={c} />,
    },
    {
      key: "waiting",
      header: "Waiting",
      align: "right",
      cell: (c) => <span className="text-fg-muted">{waitingLabel(c.waiting_days)}</span>,
    },
  ]

  return (
    <div className="page space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <PageTitle>Your papers</PageTitle>
          <Sub className="mt-1">Every paper you have filed, and every draft still waiting on you.</Sub>
        </div>
        <Button kind="primary" asChild>
          <Link to="/papers/new">
            <Plus />
            File a paper
          </Link>
        </Button>
      </header>

      <div className="flex flex-wrap items-center gap-4">
        <div role="tablist" aria-label="Filter by stage" className="flex flex-wrap gap-1">
          {STAGE_FILTERS.map((f) => {
            const active = status === f.status
            const count = counts?.[f.stage]
            return (
              <button
                key={f.label}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => selectStatus(f.status)}
                className={cn(
                  "rounded-md px-2.5 py-1.5 text-sm font-medium transition-colors duration-[var(--dur-1)] ease-out",
                  active ? "bg-selected text-accent" : "text-fg-muted hover:bg-hover hover:text-fg"
                )}
              >
                {f.label}
                <span className={cn("ml-1.5 tabular", active ? "text-accent" : "text-fg-subtle")}>
                  {count ?? "…"}
                </span>
              </button>
            )
          })}
        </div>

        <div className="relative ml-auto w-full max-w-xs">
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-fg-subtle"
            aria-hidden
          />
          <Input
            value={searchDraft}
            onChange={(e) => setSearchDraft(e.target.value)}
            placeholder="Search title or ticket number"
            aria-label="Search your papers"
            className="pl-8"
          />
        </div>
      </div>

      {isLoading ? (
        <>
          <SkeletonRows rows={8} rowHeight={44} className="hidden md:block" />
          <SkeletonRows rows={5} rowHeight={68} className="md:hidden" />
        </>
      ) : isError ? (
        <ErrorState
          title="Could not load your papers"
          message="The server did not answer. Nothing has been lost."
          onRetry={() => refetch()}
        />
      ) : claims.length === 0 ? (
        <EmptyState
          icon={filtered ? SearchX : FilePlus}
          title={filtered ? "Nothing matches" : "Nothing filed yet"}
          message={
            filtered
              ? "No paper matches this stage and search. Try a different stage or clear the search."
              : "File a paper and it goes to the research cell to be checked, then to the Principal, then to Finance."
          }
          action={
            filtered ? (
              <Button kind="default" size="sm" onClick={clearFilters}>
                Clear filters
              </Button>
            ) : (
              <Button kind="primary" size="sm" asChild>
                <Link to="/papers/new">
                  <Plus />
                  File your first paper
                </Link>
              </Button>
            )
          }
        />
      ) : (
        <>
          <Table
            className="hidden md:block"
            rows={claims}
            getKey={(c) => c.id}
            rowLink={(c) => `/papers/${c.id}`}
            minWidth="50rem"
            columns={columns}
          />

          <ul className="divide-y divide-line border-y border-line md:hidden">
            {claims.map((c) => (
              <PaperCard key={c.id} claim={c} />
            ))}
          </ul>

          <Pagination page={page} pageSize={PAGE_SIZE} total={total} onChange={goToPage} />
        </>
      )}
    </div>
  )
}

/** The amount, with the two things that make it not a settled figure shown
 *  beside it rather than left for the reader to notice on the detail page —
 *  an estimate rests on numbers the claimant reported themselves, and a
 *  calculation error means there is no real figure here at all yet. */
function AmountCell({ claim }: { claim: Claim }) {
  if (claim.calc_error) {
    return <span className="text-xs text-critical">Could not calculate</span>
  }
  return (
    <span className="inline-flex flex-col items-end">
      <span className="tabular">{money(claim.remuneration)}</span>
      {claim.remuneration != null && claim.remuneration_is_estimate && (
        <span className="text-xs font-normal leading-tight text-caution">Estimate</span>
      )}
    </span>
  )
}

/** The table's row, redrawn as a card for a screen too narrow for six
 *  columns — the same fields, stacked, because leaving one off below `md`
 *  is how a claimant misses the one thing they opened the page to check. */
function PaperCard({ claim }: { claim: Claim }) {
  const stage = stageOf(claim.status)
  return (
    <li className="row">
      <Link to={`/papers/${claim.id}`} className="block px-1 py-3">
        <div className="flex items-start justify-between gap-3">
          <span className="min-w-0 flex-1">
            <span className="block truncate text-base">{claim.paper_title || "Untitled"}</span>
            <Meta className="mt-0.5 block truncate">
              {[claim.journal_title, claim.publication_year, claim.ticket_number || (claim.status === "DRAFT" ? "Not filed yet" : null)]
                .filter(Boolean)
                .join(" · ")}
            </Meta>
          </span>
          <span className="shrink-0 text-right">
            {claim.calc_error ? (
              <span className="text-xs text-critical">Could not calculate</span>
            ) : (
              <>
                <span className="block text-base tabular">{money(claim.remuneration)}</span>
                {claim.remuneration != null && claim.remuneration_is_estimate && (
                  <span className="block text-xs text-caution">Estimate</span>
                )}
              </>
            )}
          </span>
        </div>
        <div className="mt-2 flex items-center justify-between gap-3">
          <Stage stage={stage} className="w-[8rem]" />
          <Meta>{waitingLabel(claim.waiting_days)}</Meta>
        </div>
      </Link>
    </li>
  )
}

