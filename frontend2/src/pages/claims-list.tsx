import { paperTitle } from "@/lib/names"
import { useEffect, useState } from "react"
import { Link, useSearchParams } from "react-router-dom"
import { ArrowRight, FilePlus, Plus, Search, SearchX, X } from "lucide-react"

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
import { Details, Rows, Section } from "@/ui/section"
import { Tabs } from "@/ui/tabs"
import { reasonOf } from "@/pages/home-faculty"
import {
  amountView,
  filedSentence,
  monthPaid,
  needFromYou,
  payoutLine,
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

const PAGE_SIZE = 50

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

  function selectGroup(next: string) {
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

  // `mine`: for an officer who files their own papers `/api/claims` is the
  // college's; this page is theirs alone. A no-op for faculty and a head.
  const listQuery = new URLSearchParams({ mine: "1" })
  if (group.statuses) listQuery.set("status", group.statuses)
  if (q) listQuery.set("q", q)
  listQuery.set("limit", String(PAGE_SIZE))
  listQuery.set("offset", String(page * PAGE_SIZE))

  const threshold = useMyThreshold()
  const { data, isLoading, isError, refetch } = useApi<ClaimsPayload>(
    ["claims", groupKey, q, page],
    `/api/claims?${listQuery.toString()}`,
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
    const maxPage = Math.max(0, Math.ceil(data.total / PAGE_SIZE) - 1)
    if (page > maxPage) goToPage(maxPage)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data])

  const claims = data?.results ?? []
  const total = data?.total ?? 0
  const filtered = Boolean(groupKey) || Boolean(q)
  const needs = claims.filter((c) => groupOf(c) === "NEEDS")
  const way = claims
    .filter((c) => groupOf(c) === "WAY")
    .sort((a, b) => (b.days_waiting ?? -1) - (a.days_waiting ?? -1))
  const paid = claims.filter((c) => groupOf(c) === "PAID")

  const tabs = GROUPS.map((g) => ({
    id: g.key || "all",
    label: g.label,
    count: counts ? g.counts.reduce((sum, k) => sum + (counts[k] ?? 0), 0) : null,
  }))

  return (
    <div className="page space-y-10">
      <PageHeader
        title="My claims"
        sub="Where each paper you have filed is, and when the money comes."
        action={
          <>
            <Button kind="default" onClick={() => downloadMine().catch((err) => toast.fail(err))}>
              Download as spreadsheet
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
        <Details label="when the next payment is" className="-mt-4" data-testid="payout-line">
          <p className="max-w-prose text-sm leading-relaxed text-fg-muted">{outlook.sentence}</p>
        </Details>
      )}

      <ThresholdCard s={threshold.data} link={false} className="-mt-4" />

      <div className="space-y-4">
        <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
          <Tabs
            label="Filter claims"
            idPrefix="claims"
            value={groupKey || "all"}
            onChange={(id) => selectGroup(id === "all" ? "" : id)}
            tabs={tabs}
            className="min-w-0 flex-1 sm:flex-none"
          />
          <div className="relative w-full sm:max-w-xs">
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
        </div>
        {/* A search typed three minutes ago does not read as a filter at all,
            which is how somebody ends up believing the account is empty.
            It says so here, and can be undone from here. */}
        {q && (
          <div className="flex min-h-7 flex-wrap items-center gap-2" role="status" aria-live="polite">
            <Meta className="tabular">
              {total === 1 ? "1 claim" : `${total} claims`} matching “{q}”
            </Meta>
            <Button kind="quiet" size="sm" onClick={clearFilters}>
              <X />
              Clear search
            </Button>
          </div>
        )}
      </div>

      {isLoading ? (
        <SkeletonRows rows={5} rowHeight={96} />
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
              ? "No claim matches this tab and search. Try another tab or clear the search."
              : "File a paper and follow it here from filing to payment, with what is needed from you at each step."
          }
          action={
            filtered ? (
              <Button kind="default" size="sm" onClick={clearFilters}>
                Clear filters
              </Button>
            ) : (
              <Button kind="primary" asChild>
                <Link to="/papers/new">
                  <Plus />
                  File your first paper
                </Link>
              </Button>
            )
          }
        />
      ) : (
        <div role="tabpanel" id={`claims-${groupKey || "all"}`} aria-labelledby={`claims-tab-${groupKey || "all"}`} className="space-y-12">
          {needs.length > 0 && (
            <Section title="Needs you" aria-label="Needs you">
              <Rows>
                {needs.map((c) => (
                  <NeedsRow key={c.id} claim={c} />
                ))}
              </Rows>
            </Section>
          )}
          {way.length > 0 && (
            <Section title="On the way" aria-label="On the way">
              <Rows>
                {way.map((c) => (
                  <WayRow key={c.id} claim={c} outlook={outlook} />
                ))}
              </Rows>
            </Section>
          )}
          {paid.length > 0 && (
            <Section
              title="Paid"
              aria-label="Paid"
              action={
                <Link to="/papers/statement" className="text-accent hover:underline">
                  Payment statement
                </Link>
              }
            >
              <Rows>
                {paid.map((c) => (
                  <PaidRow key={c.id} claim={c} />
                ))}
              </Rows>
            </Section>
          )}
          <Pagination page={page} pageSize={PAGE_SIZE} total={total} onChange={goToPage} />
        </div>
      )}
    </div>
  )
}

function Title({ claim, to }: { claim: Claim; to: string }) {
  return (
    <Link to={to} className="line-clamp-2 text-base font-medium leading-snug hover:text-accent">
      {paperTitle(claim.paper_title)}
    </Link>
  )
}

function ClaimNo({ claim }: { claim: Claim }) {
  if (!claim.ticket_number?.startsWith("FP-")) return null
  return (
    <span className="inline-flex items-center gap-0.5 tabular">
      Claim no. {claim.ticket_number}
      <CopyButton value={claim.ticket_number} label="claim number" />
    </span>
  )
}

/** A draft or a claim that came back: one sentence on what to do, and the button that does it. */
function NeedsRow({ claim }: { claim: Claim }) {
  const stage = stageWord(claim)
  const need = needFromYou(claim)
  const sentBack = stage === "Sent back"
  const draft = stage === "Draft" || stage === "Withdrawn"
  const why = sentBack ? reasonOf(claim.status_note) : null
  const to = draft ? `/papers/${claim.id}/edit` : `/papers/${claim.id}`
  return (
    <li className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 py-5">
      <div className="min-w-0 flex-1 space-y-1">
        <p className={cn("text-sm font-medium", sentBack ? "text-caution" : "text-fg-muted")}>
          {sentBack ? "Sent back to you" : stage === "Not accepted" ? "Not accepted" : "Draft"}
        </p>
        <Title claim={claim} to={to} />
        <p className="max-w-prose text-sm text-fg-muted">
          {why ? (
            <>
              <span className="text-fg">The college asked: </span>
              {why}
            </>
          ) : (
            need.text
          )}
        </p>
        <p className="text-sm text-fg-muted">
          <ClaimNo claim={claim} />
        </p>
      </div>
      {sentBack && (
        <Button kind="primary" asChild>
          <Link to={`/papers/${claim.id}#fix`}>
            Fix this claim
            <ArrowRight />
          </Link>
        </Button>
      )}
      {draft && (
        <Button kind="default" asChild>
          <Link to={to}>Finish and file</Link>
        </Button>
      )}
    </li>
  )
}

/** A claim with the college: its thread, how long it has waited, what it will pay. */
function WayRow({ claim, outlook }: { claim: Claim; outlook?: PayoutOutlook | null }) {
  const stage = stageWord(claim)
  const amount = amountView(claim)
  const line = payoutLine(claim, outlook)
  const slow = (claim.days_waiting ?? 0) > SLOW_DAYS
  return (
    <li className="py-5">
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-1">
        <div className="min-w-0 flex-1">
          <Title claim={claim} to={`/papers/${claim.id}`} />
          <p className="mt-0.5 line-clamp-1 text-sm text-fg-muted">
            {[claim.journal_title, claim.publication_year].filter(Boolean).join(", ")}
          </p>
        </div>
        <div className="shrink-0 text-right">
          {amount.amount != null ? (
            <>
              <p className="figure text-xl tabular">{money(amount.amount)}</p>
              <p className="text-xs text-fg-muted">{claim.remuneration_is_estimate ? "Expected, an estimate" : "Expected"}</p>
            </>
          ) : (
            <p className="text-sm text-fg-muted">{amount.note}</p>
          )}
        </div>
      </div>
      <ClaimTrack stage={stage} filedOn={claim.submitted_at} className="mt-4 max-w-xl" />
      <p className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-fg-muted">
        <span className="tabular">{filedSentence(claim)}</span>
        {slow && <span className="text-caution">Taking longer than usual</span>}
        <ClaimNo claim={claim} />
      </p>
      {line && stage === "Approved for payment" && <p className="mt-1 text-sm text-fg-muted">{line}</p>}
      <ClaimThresholdNote c={{ ...claim, remuneration: claim.remuneration ?? null }} mine className="mt-2 text-sm" />
    </li>
  )
}

/** A paid claim is one line: when the money went out, and how much. */
function PaidRow({ claim }: { claim: Claim }) {
  const month = monthPaid(claim)
  const amount = amountView(claim)
  return (
    <li className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-6 gap-y-0.5 py-3.5 sm:grid-cols-[8.5rem_minmax(0,1fr)_8rem]">
      <p className="order-2 col-span-2 text-sm text-fg-muted sm:order-none sm:col-span-1">{month ?? "Month not recorded"}</p>
      <div className="order-1 min-w-0 sm:order-none">
        <Title claim={claim} to={`/papers/${claim.id}`} />
        <p className="mt-0.5 text-sm text-fg-muted">
          <ClaimNo claim={claim} />
        </p>
      </div>
      <p className="order-1 text-right tabular sm:order-none">
        {amount.amount ? (
          <Link to={statementLink(claim)} className="font-medium hover:underline hover:underline-offset-4">
            {money(amount.amount)}
          </Link>
        ) : null}
      </p>
    </li>
  )
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
