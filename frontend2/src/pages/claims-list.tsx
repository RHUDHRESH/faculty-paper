import { paperTitle } from "@/lib/names"
import { useEffect, useState } from "react"
import { Link, useSearchParams } from "react-router-dom"
import { Plus, Search } from "lucide-react"

import { useApi } from "@/lib/query"
import { api } from "@/lib/api"
import { cn } from "@/lib/cn"
import { Answer } from "@/ui/answer"
import { Button } from "@/ui/button"
import { Input, Select } from "@/ui/field"
import { filterBar } from "@/ui/filter-bar"
import { ErrorState, SkeletonRows } from "@/ui/state"
import { Table, type Column } from "@/ui/table"
import { PageHeader } from "@/ui/page-header"
import { money } from "@/ui/paper"
import { CopyButton } from "@/ui/copy"
import { ClaimThresholdNote, ThresholdCard, useMyThreshold, type ClaimThreshold } from "@/ui/research-threshold"
import { Pagination } from "@/ui/pagination"
import { reasonOf } from "@/pages/home-faculty"
import {
  amountView,
  filedSentence,
  monthPaid,
  SLOW_DAYS,
  stageWord,
  statementLink,
  type PayoutOutlook,
  type TrackClaim,
} from "@/pages/claims-track"

/**
 * My claims: every paper a faculty member has filed, and every draft still
 * waiting on them, sorted by what each one asks of them.
 *
 * Three groups, in the order a person needs them (docs/ux/25):
 *
 *   Needs you   a draft, or a claim the college sent back. One button each.
 *   On the way  claims with the college. Each is drawn with its thread (four
 *               stages, no desk), how long it has waited and what it will pay.
 *   Paid        one line each: the month the money went out and the amount.
 *               A claim that is paid needs nothing from anybody, so it does
 *               not get a thread and a paragraph.
 *
 * The stages are the claimant's own and never say which desk or person holds
 * a claim. Four tabs cut the same list; each is a count the server worked out
 * (`/api/claims/counts`), and each is in the URL, so a link and a reload keep
 * the place. A failed request is never drawn as "you have filed nothing".
 */

type Claim = TrackClaim &
  ClaimThreshold & {
    id: string
    paper_title: string
    journal_title: string | null
    publication_year: number | null
    status_note?: string | null
  }

type ClaimsPayload = {
  total: number
  limit: number
  offset: number
  results: Claim[]
}

/**
 * The tabs. Each is a set of the claimant's stages and asks the server for
 * every status that set covers; the counts come from `/api/claims/counts`,
 * summed the same way. "On the way" is five of the chain's steps to the
 * college and, to the claimant, one wait.
 */
const GROUPS = [
  { key: "", label: "All", statuses: "", counts: ["all"] },
  { key: "NEEDS", label: "Needs you", statuses: "DRAFT,REJECTED", counts: ["draft", "sent_back"] },
  {
    key: "WAY",
    label: "On the way",
    statuses:
      "SUBMITTED,HOD_APPROVED,CLEARED,RESEARCH_APPROVED,PRINCIPAL_APPROVED,DIRECTOR_APPROVED,FINANCE_APPROVED",
    counts: ["filed", "checked", "approved", "authorised"],
  },
  { key: "PAID", label: "Paid", statuses: "PAID", counts: ["paid"] },
] as const

/** A link written before the tabs were these four still lands on the right one. */
function groupKeyOf(param: string): string {
  if (!param) return ""
  if (GROUPS.some((g) => g.key === param)) return param
  if (param === "DRAFT" || param === "REJECTED") return "NEEDS"
  if (param === "PAID") return "PAID"
  if (param === "CHECKING" || param === "APPROVED") return "WAY"
  return GROUPS.find((g) => g.key && g.statuses.split(",").includes(param))?.key ?? ""
}

function groupOf(c: Claim): "NEEDS" | "WAY" | "PAID" {
  const s = stageWord(c)
  if (s === "Draft" || s === "Withdrawn" || s === "Sent back" || s === "Not accepted") return "NEEDS"
  if (s === "Paid") return "PAID"
  return "WAY"
}

export function ClaimsList() {
  const [searchParams, setSearchParams] = useSearchParams()
  const groupKey = groupKeyOf(searchParams.get("status") ?? "")
  const group = GROUPS.find((g) => g.key === groupKey)!
  const q = searchParams.get("q") ?? ""
  const page = Math.max(0, Number.parseInt(searchParams.get("page") ?? "0", 10) || 0)
  const sort = ["recent", "amount", "title"].includes(searchParams.get("sort") ?? "") ? searchParams.get("sort")! : "recent"
  const pageSize = [30, 50, 100].includes(Number(searchParams.get("size"))) ? Number(searchParams.get("size")) : 30

  function setParam(key: string, value: string) {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev)
      if (value) next.set(key, value)
      else next.delete(key)
      if (key !== "page") next.delete("page")
      return next
    })
  }

  // The box's own state, so typing feels instant; the URL only catches up
  // once typing pauses, which keeps a search from rewriting history on every
  // keystroke.
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

  // `mine`: for an officer who files their own papers `/api/claims` is the
  // college's; this page is theirs alone. A no-op for faculty and a head.
  const listQuery = new URLSearchParams({ mine: "1" })
  if (group.statuses) listQuery.set("status", group.statuses)
  if (q) listQuery.set("q", q)
  listQuery.set("sort", sort)
  const pageQuery = new URLSearchParams(listQuery)
  pageQuery.set("limit", String(pageSize))
  pageQuery.set("offset", String(page * pageSize))

  const threshold = useMyThreshold()
  const { data, isLoading, isError, refetch } = useApi<ClaimsPayload>(
    ["claims", groupKey, q, page, sort, pageSize],
    `/api/claims?${pageQuery.toString()}`,
    // Keeps the previous page's rows on screen while the next page loads,
    // so turning a page doesn't flash a skeleton over a list already full.
    { placeholderData: (prev) => prev }
  )

  // Every tab's number in one request, scoped to the current search text so
  // the counts describe what is reachable right now.
  const { data: countData } = useApi<{ counts: Record<string, number> }>(
    ["claims-counts", q] as const,
    `/api/claims/counts?mine=1${q ? `&q=${encodeURIComponent(q)}` : ""}`,
    { staleTime: 30_000 }
  )
  const counts = countData?.counts

  // When the next payment run is, from the college's own pattern.
  const { data: outlook } = useApi<PayoutOutlook>(["next-payout"], "/api/me/next-payout", {
    staleTime: 10 * 60_000,
  })

  // The offset can end up past the end after a filter narrows the result
  // set out from under the current page.
  useEffect(() => {
    if (!data) return
    const maxPage = Math.max(0, Math.ceil(data.total / pageSize) - 1)
    if (page > maxPage) goToPage(maxPage)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data])

  const claims = data?.results ?? []
  const total = data?.total ?? 0
  const filtered = Boolean(groupKey) || Boolean(q)
  const kpis = GROUPS.map((g) => ({
    value: counts ? g.counts.reduce((sum, k) => sum + (counts[k] ?? 0), 0) : null,
    label: g.label,
    to: g.key ? `/papers/claims?status=${g.key}` : "/papers/claims",
  }))

  async function allRows(): Promise<Claim[]> {
    const out: Claim[] = []
    for (let offset = 0; offset < 5000; offset += 200) {
      const pq = new URLSearchParams(listQuery)
      pq.set("limit", "200")
      pq.set("offset", String(offset))
      const res = await api<ClaimsPayload>(`/api/claims?${pq.toString()}`)
      out.push(...res.results)
      if (out.length >= res.total || res.results.length === 0) break
    }
    return out
  }

  const columns: Column<Claim>[] = [
    {
      key: "paper",
      header: "Paper",
      sortable: true,
      exportValue: (c) => paperTitle(c.paper_title),
      cell: (c) => (
        <Link
          to={groupOf(c) === "NEEDS" && ["Draft", "Withdrawn"].includes(stageWord(c)) ? `/papers/${c.id}/edit` : `/papers/${c.id}`}
          className="line-clamp-2 text-base font-medium leading-snug hover:text-accent"
        >
          {paperTitle(c.paper_title)}
        </Link>
      ),
    },
    {
      key: "claim_no",
      header: "Claim no.",
      exportValue: (c) => c.ticket_number ?? null,
      cell: (c) =>
        c.ticket_number?.startsWith("FP-") ? (
          <span className="inline-flex items-center gap-0.5 tabular">
            {c.ticket_number}
            <CopyButton value={c.ticket_number} label="claim number" />
          </span>
        ) : null,
    },
    {
      key: "journal",
      header: "Journal",
      exportValue: (c) => c.journal_title,
      cell: (c) => <span className="line-clamp-2">{[c.journal_title, c.publication_year].filter(Boolean).join(", ")}</span>,
    },
    {
      key: "stage",
      header: "Where it is",
      sortable: true,
      exportValue: (c) => stageWord(c),
      cell: (c) => {
        const stage = stageWord(c)
        const slow = groupOf(c) === "WAY" && (c.days_waiting ?? 0) > SLOW_DAYS
        const why = stage === "Sent back" ? reasonOf(c.status_note) : null
        return (
          <div className="min-w-0 space-y-0.5">
            <p className={cn("font-medium", stage === "Sent back" && "text-caution")}>{stage}</p>
            {groupOf(c) === "WAY" && <p className="text-sm text-fg-muted tabular">{filedSentence(c)}</p>}
            {slow && <p className="text-sm text-caution">Taking longer than usual</p>}
            {why && <p className="text-sm text-fg-muted">The college asked: {why}</p>}
            {groupOf(c) === "WAY" && (
              <ClaimThresholdNote c={{ ...c, remuneration: c.remuneration ?? null }} mine className="text-sm" />
            )}
          </div>
        )
      },
    },
    {
      key: "amount",
      header: "Amount",
      align: "right",
      sortable: true,
      exportKind: "money",
      exportValue: (c) => amountView(c).amount ?? null,
      cell: (c) => {
        const a = amountView(c)
        if (a.amount == null) return <span className="text-sm text-fg-muted">{a.note}</span>
        return groupOf(c) === "PAID" ? (
          <Link to={statementLink(c)} className="hover:underline hover:underline-offset-4">
            {money(a.amount)}
          </Link>
        ) : (
          money(a.amount)
        )
      },
    },
    {
      key: "paid_month",
      header: "Month paid",
      exportValue: (c) => (groupOf(c) === "PAID" ? monthPaid(c) : null),
      cell: (c) => (groupOf(c) === "PAID" ? (monthPaid(c) ?? "Month not recorded") : null),
    },
    {
      key: "action",
      header: <span className="sr-only">Next step</span>,
      label: "Next step",
      cell: (c) => {
        const stage = stageWord(c)
        if (stage === "Sent back")
          return (
            <Button kind="primary" size="sm" asChild>
              <Link to={`/papers/${c.id}#fix`}>Fix this claim</Link>
            </Button>
          )
        if (stage === "Draft" || stage === "Withdrawn")
          return (
            <Button kind="default" size="sm" asChild>
              <Link to={`/papers/${c.id}/edit`}>Finish and file</Link>
            </Button>
          )
        return null
      },
    },
  ]

  return (
    <div className="page space-y-6">
      <PageHeader
        title="My claims"
        sub={outlook?.sentence ?? "Every paper you have filed, and when the money comes."}
        action={
          <Button kind="primary" asChild>
            <Link to="/papers/new">
              <Plus />
              File a paper
            </Link>
          </Button>
        }
      />

      <ThresholdCard s={threshold.data} link={false} />

      <Answer items={kpis} />

      <div className={filterBar} role="search">
        <div className="relative sm:w-72">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-fg-subtle"
            aria-hidden
          />
          <Input
            value={searchDraft}
            onChange={(e) => setSearchDraft(e.target.value)}
            placeholder="Search title or claim number"
            aria-label="Search your claims"
            className="pl-9"
          />
        </div>
        {filtered && (
          <Button kind="quiet" onClick={clearFilters}>
            Clear
          </Button>
        )}
        <Link to="/papers/statement" className="text-sm text-accent hover:underline sm:ml-auto">
          Payment statement
        </Link>
      </div>

      {isError ? (
        <ErrorState
          title="Could not load your claims"
          message="The server did not answer. Nothing has been lost."
          onRetry={() => refetch()}
        />
      ) : isLoading ? (
        <SkeletonRows rows={5} rowHeight={56} />
      ) : (
        <>
          <Table
            rows={claims}
            columns={columns}
            getKey={(c) => c.id}
            maxHeight="none"
            caption="Your claims"
            sortKey={sort === "title" ? "paper" : sort === "amount" ? "amount" : "stage"}
            sortDir={sort === "title" ? "asc" : "desc"}
            onSort={(k) => setParam("sort", k === "paper" ? "title" : k === "amount" ? "amount" : "recent")}
            tools={{ id: "my-claims", title: "My claims", getAllRows: allRows }}
            empty={{
              art: filtered ? "no-results" : "nothing-filed",
              title: filtered ? "Nothing matches" : "Nothing filed yet",
              message: filtered
                ? "No claim matches this tab and search."
                : "File a paper and follow it here from filing to payment.",
              action: filtered ? (
                <Button kind="default" onClick={clearFilters}>
                  Clear filters
                </Button>
              ) : (
                <Button kind="primary" asChild>
                  <Link to="/papers/new">
                    <Plus />
                    File your first paper
                  </Link>
                </Button>
              ),
            }}
          />
          <div className="flex flex-wrap items-center justify-between gap-3">
            <Pagination page={page} pageSize={pageSize} total={total} onChange={goToPage} />
            <Select
              aria-label="Rows per page"
              value={String(pageSize)}
              onChange={(e) => setParam("size", e.target.value === "30" ? "" : e.target.value)}
              className="w-auto"
            >
              {[30, 50, 100].map((n) => (
                <option key={n} value={n}>
                  {n} per page
                </option>
              ))}
            </Select>
          </div>
        </>
      )}
    </div>
  )
}

