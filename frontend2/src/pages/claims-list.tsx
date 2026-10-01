import { paperTitle } from "@/lib/names"
import { useEffect, useState } from "react"
import { Link, useSearchParams } from "react-router-dom"
import { ArrowRight, FilePlus, Plus, Receipt, Search, SearchX, X } from "lucide-react"

import { useApi } from "@/lib/query"
import { api } from "@/lib/api"
import { cn } from "@/lib/cn"
import { Button } from "@/ui/button"
import { Input } from "@/ui/field"
import { toast } from "@/ui/toast"
import { EmptyState, ErrorState, SkeletonRows } from "@/ui/state"
import { Meta } from "@/ui/text"
import { PageHeader } from "@/ui/page-header"
import { money } from "@/ui/paper"
import { ClaimTrack } from "@/ui/claim-track"
import { CopyButton } from "@/ui/copy"
import { claimStatus, facultyStage } from "@/ui/journey"
import { ClaimThresholdNote, ThresholdCard, useMyThreshold, type ClaimThreshold } from "@/ui/research-threshold"
import { Pagination } from "@/ui/pagination"
import {
  amountView,
  filedSentence,
  monthPaid,
  needFromYou,
  payoutLine,
  stageWord,
  statementLink,
  type PayoutOutlook,
  type TrackClaim,
} from "@/pages/claims-track"

/**
 * My claims: every paper a faculty member has filed, and every draft still
 * waiting on them, each as a timeline.
 *
 * The question this page answers, for each claim and in this order: where is
 * it (the timeline, in faculty stages only), how long since I filed it, what
 * will I be paid and when, and is there anything I have to do. The last one
 * is a single sentence, always present, so a claimant never has to work out
 * from a stage whether they should be doing something: "Nothing. We'll tell
 * you when it moves." is an answer too.
 *
 * Never which desk or person holds a claim. The server withholds that from
 * the claimant's copy, and nothing here reintroduces it: the stage filters
 * are the claimant's stages, not the chain's.
 *
 * It is one of the two screens almost every faculty account opens, usually
 * looking for one paper among dozens, so finding it fast (a stage filter and
 * a search, both in the URL) and never mistaking "the server did not answer"
 * for "you have filed nothing" both matter.
 */

type Claim = TrackClaim &
  ClaimThreshold & {
  id: string
  paper_title: string
  journal_title: string | null
  publication_year: number | null
}

type ClaimsPayload = {
  total: number
  limit: number
  offset: number
  results: Claim[]
}

const PAGE_SIZE = 20

/**
 * The stage chips. Each is one of the claimant's stages, and asks the server
 * for every status that stage covers (comma-separated); the counts come from
 * `/api/claims/counts`, summed the same way. "Being checked" is three of the
 * chain's steps to the college and one to the claimant.
 */
const STAGE_FILTERS: { key: string; label: string; statuses: string; counts: string[] }[] = [
  { key: "", label: "All", statuses: "", counts: ["all"] },
  { key: "DRAFT", label: "Draft", statuses: "DRAFT", counts: ["draft"] },
  {
    key: "CHECKING",
    label: "Being checked",
    statuses: "SUBMITTED,HOD_APPROVED,CLEARED,RESEARCH_APPROVED,PRINCIPAL_APPROVED",
    counts: ["filed", "checked", "approved"],
  },
  {
    key: "APPROVED",
    label: "Approved for payment",
    statuses: "DIRECTOR_APPROVED,FINANCE_APPROVED",
    counts: ["authorised"],
  },
  { key: "PAID", label: "Paid", statuses: "PAID", counts: ["paid"] },
  { key: "REJECTED", label: "Sent back", statuses: "REJECTED", counts: ["sent_back"] },
]

/** A link written before the chips were the claimant's stages still lands on the right one. */
function filterKeyOf(param: string): string {
  if (!param) return ""
  const direct = STAGE_FILTERS.find((f) => f.key === param)
  if (direct) return direct.key
  return STAGE_FILTERS.find((f) => f.key && f.statuses.split(",").includes(param))?.key ?? ""
}

export function ClaimsList() {
  const [searchParams, setSearchParams] = useSearchParams()
  const stageKey = filterKeyOf(searchParams.get("status") ?? "")
  const stageFilter = STAGE_FILTERS.find((f) => f.key === stageKey)!
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

  function selectStage(next: string) {
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

  // `mine`: for an officer who files their own papers `/api/claims` is the
  // college's; this page is theirs alone. A no-op for faculty and a head.
  const listQuery = new URLSearchParams({ mine: "1" })
  if (stageFilter.statuses) listQuery.set("status", stageFilter.statuses)
  if (q) listQuery.set("q", q)
  listQuery.set("limit", String(PAGE_SIZE))
  listQuery.set("offset", String(page * PAGE_SIZE))

  const threshold = useMyThreshold()
  const { data, isLoading, isError, refetch } = useApi<ClaimsPayload>(
    ["claims", stageKey, q, page],
    `/api/claims?${listQuery.toString()}`,
    // Keeps the previous page's rows on screen while the next page loads,
    // so turning a page doesn't flash a skeleton over a list already full
    // of real rows.
    { placeholderData: (prev) => prev }
  )

  // Every chip's number in one request, scoped to the current search text so
  // the counts describe what is actually reachable right now rather than the
  // whole account.
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
  const filtered = Boolean(stageKey) || Boolean(q)

  return (
    <div className="page space-y-6">
      <PageHeader
        title="My claims"
        sub="Where each paper you have filed is, what you will be paid and when, and whether anything is needed from you."
        action={
          <>
            <Button kind="quiet" onClick={() => downloadMine().catch((err) => toast.fail(err))}>
              Download all as CSV
            </Button>
            <Button kind="primary" asChild>
              <Link to="/papers/new">
                <Plus />
                File a paper
              </Link>
            </Button>
          </>
        }
      />

      {outlook && (
        <p className="max-w-3xl text-base leading-relaxed" data-testid="payout-line">
          <span className="font-medium">When the money comes. </span>
          <span className="text-fg-muted">{outlook.sentence}</span>{" "}
          <Link to="/papers/statement" className="whitespace-nowrap text-accent underline-offset-4 hover:underline">
            See your payment statement
          </Link>
        </p>
      )}

      <ThresholdCard s={threshold.data} link={false} />

      <div className="flex flex-wrap items-center gap-4">
        {/* These are filter toggles, not tabs: they set one query parameter
            and the single results region below redraws. A pressed-or-not
            button is what each one is. Every stage stays on the bar, even at
            zero, so the bar keeps its shape and is also the place this screen
            says what the stages are; an empty stage is dimmed and disabled
            until it has something in it, and the active chip is never
            disabled, which would trap a reader in a filter they could not
            clear. */}
        <div role="group" aria-label="Filter by stage" className="flex flex-wrap gap-1">
          {STAGE_FILTERS.map((f) => {
            const active = stageKey === f.key
            const count = counts ? f.counts.reduce((sum, k) => sum + (counts[k] ?? 0), 0) : undefined
            const empty = count === 0 && !active
            return (
              <button
                key={f.label}
                type="button"
                aria-pressed={active}
                disabled={empty}
                aria-label={count == null ? f.label : `${f.label}, ${count}`}
                onClick={() => selectStage(f.key)}
                className={cn(
                  "rounded-md px-2.5 py-1.5 text-sm font-medium transition-colors duration-[var(--dur-1)] ease-out",
                  active && "bg-selected text-accent",
                  !active && empty && "cursor-default text-fg-subtle",
                  !active && !empty && "text-fg-muted hover:bg-hover hover:text-fg"
                )}
              >
                {f.label}
                <span aria-hidden className={cn("ml-1.5 tabular", active ? "text-accent" : "text-fg-subtle")}>
                  {count ?? "…"}
                </span>
              </button>
            )
          })}
        </div>

        <div className="relative w-full sm:ml-auto sm:max-w-xs">
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-fg-subtle"
            aria-hidden
          />
          <Input
            value={searchDraft}
            onChange={(e) => setSearchDraft(e.target.value)}
            placeholder="Search title or claim number"
            aria-label="Search your papers"
            className="pl-8"
          />
        </div>
      </div>

      {/* What is being asked, and how much came back. A stage filter shows
          in the button above, but a search term typed three minutes ago does
          not read as a filter at all, which is how somebody ends up
          believing the account is empty. Both say so here, and both can be
          undone from here. */}
      <div className="flex min-h-7 flex-wrap items-center gap-2">
        <div role="status" aria-live="polite">
          {!isLoading && !isError && (
            <Meta className="tabular">
              {total === 1 ? "1 claim" : `${total} claims`}
              {filtered ? " matching these filters" : ""}
            </Meta>
          )}
        </div>
        {stageKey && <Chip label={`Stage: ${stageFilter.label}`} onRemove={() => selectStage("")} />}
        {q && <Chip label={`Search: ${q}`} onRemove={clearSearch} />}
        {filtered && (
          <Button kind="quiet" size="sm" onClick={clearFilters}>
            Clear all
          </Button>
        )}
      </div>

      {isLoading ? (
        <SkeletonRows rows={5} rowHeight={112} />
      ) : isError ? (
        <ErrorState
          title="Could not load your claims"
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
              ? "No claim matches this stage and search. Try a different stage or clear the search."
              : "File a paper and you can follow it here from filing to payment, and see what is needed from you at each step."
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
          <ul className="divide-y divide-line border-y border-line">
            {claims.map((c) => (
              <ClaimRow key={c.id} claim={c} outlook={outlook} />
            ))}
          </ul>

          <Pagination page={page} pageSize={PAGE_SIZE} total={total} onChange={goToPage} />
        </>
      )}
    </div>
  )
}

/** One active filter, said as a removable chip. Never a naked value: every
 *  chip names its own dimension. */
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
 * One claim: title and number, the timeline, the amount, and the sentence
 * that says what is needed from the claimant.
 */
export function ClaimRow({ claim, outlook }: { claim: Claim; outlook?: PayoutOutlook | null }) {
  const stage = stageWord(claim)
  const need = needFromYou(claim)
  const amount = amountView(claim)
  const paidIn = monthPaid(claim)
  const draft = stage === "Draft" || stage === "Withdrawn"
  const line = payoutLine(claim, outlook)

  return (
    <li className="relative grid grid-cols-[minmax(0,1fr)] gap-x-8 gap-y-3 py-5 [&>*]:min-w-0 lg:grid-cols-[minmax(0,1fr)_11rem]">
      <div className="space-y-3">
        <div>
          <Link
            to={draft ? `/papers/${claim.id}/edit` : `/papers/${claim.id}`}
            className="block text-base font-medium leading-snug after:absolute after:inset-0 hover:text-accent"
          >
            <span className="line-clamp-2">{paperTitle(claim.paper_title)}</span>
          </Link>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-sm text-fg-muted">
            {claim.ticket_number ? (
              <>
                <span className="tabular">Claim no. {claim.ticket_number}</span>
                <span className="relative z-10">
                  <CopyButton value={claim.ticket_number} label="claim number" />
                </span>
              </>
            ) : (
              <span>{draft ? "Not filed yet" : "No claim number"}</span>
            )}
            {[claim.journal_title, claim.publication_year].filter(Boolean).length > 0 && (
              <span className="min-w-0 truncate">
                · {[claim.journal_title, claim.publication_year].filter(Boolean).join(" · ")}
              </span>
            )}
          </p>
        </div>

        {!draft && (
          <ClaimTrack
            stage={stage}
            filedOn={claim.submitted_at}
            paidMonth={paidIn}
            className="max-w-xl"
          />
        )}

        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          {!draft && <Meta className="tabular">{filedSentence(claim)}</Meta>}
          <p className={cn("text-sm", need.action ? "font-medium text-fg" : "text-fg-muted")}>
            <span className="text-fg-muted">Needed from you: </span>
            {need.text}
          </p>
        </div>
        {line && stage === "Approved for payment" && <p className="text-sm text-fg-muted">{line}</p>}
        <ClaimThresholdNote c={{ ...claim, remuneration: claim.remuneration ?? null }} mine />
      </div>

      <div className="flex items-start justify-between gap-3 lg:flex-col lg:items-end lg:justify-start lg:text-right">
        <div>
          <p className="text-xs text-fg-muted">{amount.caption}</p>
          {amount.amount != null ? (
            <p className="figure text-xl tabular">{money(amount.amount)}</p>
          ) : (
            <p className="text-sm text-fg-muted">{amount.note}</p>
          )}
          {amount.amount != null && amount.note && (
            <p className={cn("text-xs", amount.note.startsWith("An estimate") ? "text-caution" : "text-fg-muted")}>
              {amount.note}
            </p>
          )}
          {paidIn && <p className="text-sm text-fg-muted">Paid in {paidIn}</p>}
        </div>
        <RowAction claim={claim} />
      </div>
    </li>
  )
}

function RowAction({ claim }: { claim: Claim }) {
  const stage = stageWord(claim)
  // Sits above the stretched title link so it can be pressed on its own.
  const on = "relative z-10"
  if (stage === "Sent back") {
    return (
      <Button kind="primary" size="sm" asChild className={on}>
        <Link to={`/papers/${claim.id}#fix`}>
          Fix this claim
          <ArrowRight />
        </Link>
      </Button>
    )
  }
  if (stage === "Draft" || stage === "Withdrawn") {
    return (
      <Button kind="default" size="sm" asChild className={on}>
        <Link to={`/papers/${claim.id}/edit`}>Continue</Link>
      </Button>
    )
  }
  if (stage === "Paid") {
    return (
      <Button kind="quiet" size="sm" asChild className={on}>
        <Link to={statementLink(claim)}>
          <Receipt />
          Payment statement
        </Link>
      </Button>
    )
  }
  return null
}

/** Every paper on record, for the claimant's own spreadsheet or appraisal
 *  file: what, where, which stage, how much. */
async function downloadMine() {
  const res = await api<{ results: (Claim & Record<string, unknown>)[] }>("/api/claims?mine=1&limit=500")
  const cell = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`
  const head = ["Claim no.", "Paper", "Journal", "Year", "DOI", "Stage", "Amount (INR)", "Month paid"]
  const rows = res.results.map((c) =>
    [
      c.ticket_number,
      c.paper_title,
      c.journal_title,
      c.publication_year,
      c.doi,
      stageWord(c) || facultyStage(claimStatus(c)),
      c.remuneration,
      c.payout_month || (c.paid_at ? String(c.paid_at).slice(0, 7) : ""),
    ]
      .map(cell)
      .join(",")
  )
  const blob = new Blob(["﻿" + [head.map(cell).join(","), ...rows].join("\r\n")], {
    type: "text/csv;charset=utf-8",
  })
  const a = document.createElement("a")
  a.href = URL.createObjectURL(blob)
  a.download = `my-papers-${new Date().toISOString().slice(0, 10)}.csv`
  a.click()
  URL.revokeObjectURL(a.href)
}
