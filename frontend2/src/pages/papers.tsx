import { useEffect, useState } from "react"
import { Link, useSearchParams } from "react-router-dom"
import { FilePlus, Plus, Search, SearchX, X } from "lucide-react"

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
 *
 * The other question every row is asked is "is this one stuck", so no cell on
 * it is allowed to be a bare "—". A dash is what a column says when it has
 * nothing to say, and every row here has something to say: with whom, since
 * when, and whether that is longer than it should be.
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
  paid_at: string | null
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

// The queues staff work from (`clearing.tsx`, `approvals.tsx`) mark a ticket
// that has stood at one desk for more than a week. The claimant gets the same
// threshold, so "is mine stuck" has the same answer on both sides of the desk.
const SLOW_DAYS = 7

/**
 * Who is holding it, in two words.
 *
 * `stageOf().who` is a whole sentence written for the ticket page ("Waiting
 * for the Principal to approve it."), which is right there and far too long
 * repeated down twenty rows. Same desks, said short. Keyed by status rather
 * than by stage so the imported legacy statuses resolve too.
 */
const DESK: Record<string, string> = {
  SUBMITTED: "the research cell",
  HOD_APPROVED: "the research cell",
  CLEARED: "the Principal",
  RESEARCH_APPROVED: "the Principal",
  PRINCIPAL_APPROVED: "the Director",
  DIRECTOR_APPROVED: "Finance",
  FINANCE_APPROVED: "Finance",
}

function dayCount(days: number): string {
  if (days <= 0) return "Today"
  if (days === 1) return "1 day"
  return `${days} days`
}

function onDate(iso: string | null | undefined): string | null {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })
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

  function clearSearch() {
    setSearchDraft("")
    setSearchParams((prev) => {
      const params = new URLSearchParams(prev)
      params.delete("q")
      params.delete("page")
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
  const stageLabel = STAGE_FILTERS.find((f) => f.status === status && f.status !== "")?.label ?? null

  const columns: Column<Claim>[] = [
    {
      key: "title",
      header: "Paper",
      className: "max-w-[22rem]",
      cell: (c) => (
        <span className="block">
          <span className="block truncate text-base">{c.paper_title || "Untitled"}</span>
          <Meta className="mt-0.5 block truncate">
            {c.ticket_number || (c.status === "DRAFT" ? "Not filed yet" : "No ticket number")}
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
      className: "w-40",
      cell: (c) => <WaitingCell claim={c} />,
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
        {/* These are filter toggles, not tabs. They do not swap between
            panels — they set one query parameter and the single results
            region below redraws. Said as a tablist they announced "tab 1 of
            8" and promised arrow-key movement nothing implemented, and all
            eight sat in the tab order anyway. A pressed-or-not button is
            what each one actually is, so that is what it says. */}
        {/* Every stage stays on the bar, including the ones reading zero.
            Four of seven are empty on a typical account, and hiding them was
            tempting — but the row is in chain order, so it is also the only
            place this screen says what the chain *is*: draft, filed, checked,
            approved, authorised, paid. A zero is an answer to a question
            somebody actually asks ("is anything of mine stuck at Approved?"),
            and a chip that vanishes cannot give it; the bar would also change
            shape and length every time a ticket moved, so the control a
            reader clicked yesterday would be somewhere else today.
            What an empty stage does not deserve is a click that can only
            land on "Nothing matches", so it is dimmed and disabled until it
            has something in it. The active chip is never disabled — that
            would trap a reader in a filter they could not clear. */}
        <div role="group" aria-label="Filter by stage" className="flex flex-wrap gap-1">
          {STAGE_FILTERS.map((f) => {
            const active = status === f.status
            const count = counts?.[f.stage]
            const empty = count === 0 && !active
            return (
              <button
                key={f.label}
                type="button"
                aria-pressed={active}
                disabled={empty}
                // The count is part of what the control says, but "Draft, …"
                // is not — while the counts are still in flight the name is
                // just the stage.
                aria-label={count == null ? f.label : `${f.label}, ${count}`}
                onClick={() => selectStatus(f.status)}
                className={cn(
                  "rounded-md px-2.5 py-1.5 text-sm font-medium transition-colors duration-[var(--dur-1)] ease-out",
                  active && "bg-selected text-accent",
                  !active && empty && "cursor-default text-fg-subtle",
                  !active && !empty && "text-fg-muted hover:bg-hover hover:text-fg"
                )}
              >
                {f.label}
                <span
                  aria-hidden
                  className={cn("ml-1.5 tabular", active ? "text-accent" : "text-fg-subtle")}
                >
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

      {/* What is being asked, and how much came back — the two things a
          reader needs to understand a short list. A stage filter shows in
          the button above, but a search term typed three minutes ago does
          not read as a filter at all, which is how somebody ends up
          believing the account is empty. Both say so here, and both can be
          undone from here. */}
      <div className="flex min-h-7 flex-wrap items-center gap-2">
        <div role="status" aria-live="polite">
          {!isLoading && !isError && (
            <Meta className="tabular">
              {total === 1 ? "1 paper" : `${total} papers`}
              {filtered ? " matching these filters" : ""}
            </Meta>
          )}
        </div>
        {stageLabel && <Chip label={`Stage: ${stageLabel}`} onRemove={() => selectStatus("")} />}
        {q && <Chip label={`Search: ${q}`} onRemove={clearSearch} />}
        {filtered && (
          <Button kind="quiet" size="sm" onClick={clearFilters}>
            Clear all
          </Button>
        )}
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
          art="nothing-filed"
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

/** One active filter, said as a removable chip. Never a naked value — a
 *  reader glancing at "Q1" cannot tell a quartile from a search term, so
 *  every chip names its own dimension. Redeclared here rather than imported
 *  from `publications.tsx`, which is a page and exports only its route. */
function Chip({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <span className="inline-flex max-w-full items-center gap-1 rounded-md bg-selected px-2 py-1 text-sm text-fg">
      {/* A pasted search term is not length-limited, and a chip that cannot
          shrink pushes the page itself sideways on a phone. */}
      <span className="min-w-0 truncate">{label}</span>
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove filter: ${label}`}
        className="grid size-4 shrink-0 place-items-center rounded-sm text-fg-muted hover:bg-hover hover:text-fg"
      >
        <X className="size-3" aria-hidden />
      </button>
    </span>
  )
}

/**
 * The amount, and which kind of amount it is.
 *
 * Four different facts used to arrive here as two strings. `money(null)` is
 * "—" and `money(0)` is "₹0", so "nobody has worked this out yet" rendered as
 * a dash that reads like a missing column, and a draft whose journal metrics
 * are not on record yet rendered as a confident "₹0 · Estimate" — which is
 * not an estimate of zero, it is the formula having nothing to price the
 * paper with. A genuine zero (a count-only filing, a paper short of the SEC
 * reference minimum) is a real answer and says so in words, so nobody reads
 * it as a bug.
 *
 * The estimate marker stays, because an estimate rests on numbers the
 * claimant reported themselves, and a calculation error stays loud, because
 * it means there is no figure here at all.
 */
function AmountCell({ claim }: { claim: Claim }) {
  if (claim.calc_error) {
    return <span className="text-xs text-critical">Could not calculate</span>
  }
  if (claim.remuneration == null || (claim.remuneration === 0 && claim.remuneration_is_estimate)) {
    return <span className="text-xs font-normal text-fg-muted">Not worked out yet</span>
  }
  return (
    <span className="inline-flex flex-col items-end">
      <span className="tabular">{money(claim.remuneration)}</span>
      {claim.remuneration_is_estimate && (
        <span className="text-xs font-normal leading-tight text-caution">Estimate</span>
      )}
      {claim.remuneration === 0 && !claim.remuneration_is_estimate && (
        <span className="text-xs font-normal leading-tight text-fg-muted">No payment due</span>
      )}
    </span>
  )
}

/**
 * How long it has waited, and on whom.
 *
 * The column rendered `waiting_days` and nothing else, and the server only
 * measures that for a ticket standing at one of the four desks — so a draft,
 * a sent-back paper, a settled one and every imported legacy row all came out
 * as a bare "—". On the account this was read on, that was every row in the
 * table: a column of dashes under a heading, which is furniture, not
 * information. Each of those is a different fact and each now says which,
 * with the desk named underneath, because "21 days" is only useful once you
 * know whose desk it has been on. More than a week at one desk is marked in
 * words ("over a week") as well as in colour, so the flag survives a reader
 * who cannot use the colour.
 */
function WaitingCell({ claim, className }: { claim: Claim; className?: string }) {
  const stage = stageOf(claim.status)
  const desk = DESK[claim.status]
  const days = claim.waiting_days

  let value = "—"
  let under: string | null = null
  let late = false

  if (claim.status === "DRAFT") {
    value = "With you"
    under = "not filed yet"
  } else if (claim.status === "REJECTED") {
    value = "With you"
    under = "sent back for changes"
  } else if (claim.status === "PAID") {
    value = "Settled"
    under = onDate(claim.paid_at)
  } else if (desk) {
    late = (days ?? 0) > SLOW_DAYS
    value = days == null ? "Not recorded" : dayCount(days)
    under = `with ${desk}${late ? " · over a week" : ""}`
  } else {
    // An unknown status: `stageOf` still has a word for it, and printing that
    // beats a dash nobody can interpret.
    value = stage.label
  }

  return (
    <span className={cn("inline-flex flex-col items-end", className)}>
      <span className={cn("tabular", late && "text-caution")}>{value}</span>
      {under && (
        <span
          className={cn(
            "text-xs font-normal leading-tight",
            late ? "text-caution" : "text-fg-muted"
          )}
        >
          {under}
        </span>
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
          {/* The same component the table cell uses, so the phone cannot end
              up saying something the desktop does not. */}
          <span className="shrink-0 text-right text-base">
            <AmountCell claim={claim} />
          </span>
        </div>
        <div className="mt-2 flex items-end justify-between gap-3">
          <Stage stage={stage} className="w-[8rem]" />
          <WaitingCell claim={claim} className="text-sm" />
        </div>
      </Link>
    </li>
  )
}

