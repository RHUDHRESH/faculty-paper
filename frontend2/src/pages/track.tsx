import { useEffect, useState } from "react"
import { Link, useSearchParams } from "react-router-dom"
import { ChevronRight, Copy, Flag, Search, SearchX, Wrench } from "lucide-react"

import { useAuth, type Role } from "@/app/auth"
import { hubSections } from "@/app/nav"
import { cn } from "@/lib/cn"
import { paperTitle } from "@/lib/names"
import { useApi } from "@/lib/query"
import { Button } from "@/ui/button"
import { Chip } from "@/ui/chip"
import { Combobox, type ComboboxOption } from "@/ui/combobox"
import { Input } from "@/ui/field"
import { filterBar } from "@/ui/filter-bar"
import { money } from "@/ui/paper"
import { Pagination } from "@/ui/pagination"
import { Avatar, initialsOf } from "@/ui/person"
import { EmptyState, ErrorState, Skeleton, SkeletonRows } from "@/ui/state"
import { Meta, SectionTitle } from "@/ui/text"
import { PageHeader } from "@/ui/page-header"
import { Table, type Column } from "@/ui/table"
import { WhyAmountSheet } from "@/pages/track-why"
import type { DataFixes } from "@/pages/admin-parts"
import {
  claimHref,
  clean,
  days,
  isErpNumber,
  MAIN_STAGES,
  paidLabel,
  SIDE_STAGES,
  type Ageing,
  type TrackPayload as Payload,
  type TrackRowData as Row,
  type TrackStage as Stage,
} from "@/pages/track-data"

/**
 * Track: where every claim is, in one view.
 *
 * The desks each show their own queue and nothing else, so nobody could see
 * the whole journey: how many claims are with the research cell, how long the
 * oldest has been at the Principal, what is waiting to be paid. This is that
 * page. A board of stages (a count, what it comes to where the reader may see
 * money, and how long claims have been there), and under it the claims
 * themselves, filterable and searchable, each opening its review page.
 *
 * What a reader sees is decided by the server (`backend/core/api/track.py`):
 * a head of department gets their own department in four coarse stages and
 * no money; flags and duplicate marks only reach the desks that judge a
 * paper. This page draws what it is sent and never guesses at the rest.
 */

const PAGE_SIZE = 25



const AGE_BAR: { key: keyof Ageing; label: string; className: string }[] = [
  { key: "week", label: "a week or less", className: "bg-fg-subtle/40" },
  { key: "fortnight", label: "8 to 14 days", className: "bg-caution/45" },
  { key: "month", label: "15 to 30 days", className: "bg-caution" },
  { key: "older", label: "over 30 days", className: "bg-critical" },
]


function monthLabel(ym: string): string {
  const [y, m] = ym.split("-").map(Number)
  return new Date(y, (m || 1) - 1, 1).toLocaleDateString("en-IN", { month: "long", year: "numeric" })
}


export function Track() {
  const { me } = useAuth()
  const role = me?.role
  const [params, setParams] = useSearchParams()
  const stage = params.get("stage") ?? ""
  const department = params.get("department") ?? ""
  const month = params.get("month") ?? ""
  const q = params.get("q") ?? ""
  const fix = params.get("fix") ?? ""
  const why = params.get("why") ?? ""
  const page = Math.max(0, Number.parseInt(params.get("page") ?? "0", 10) || 0)
  const office = role === "SUPER_ADMIN" || role === "RESEARCH_CELL" || role === "RESEARCH_COORDINATOR"

  function setParam(name: string, value: string) {
    setParams((prev) => {
      const next = new URLSearchParams(prev)
      if (value) next.set(name, value)
      else next.delete(name)
      if (name !== "page") next.delete("page")
      return next
    })
  }

  // A typed search settles before it asks the server.
  const [draft, setDraft] = useState(q)
  useEffect(() => setDraft(q), [q])
  useEffect(() => {
    if (draft === q) return
    const t = setTimeout(() => setParam("q", draft.trim()), 300)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft])

  const query = new URLSearchParams()
  if (stage) query.set("stage", stage)
  if (department) query.set("department", department)
  if (month) query.set("month", month)
  if (q) query.set("q", q)
  if (fix && office) query.set("fix", fix)
  query.set("limit", String(PAGE_SIZE))
  query.set("offset", String(page * PAGE_SIZE))

  const { data, isLoading, isError, error, refetch } = useApi<Payload>(
    ["track", query.toString()],
    `/api/track?${query.toString()}`,
    { placeholderData: (prev) => prev }
  )

  const fixes = useApi<DataFixes>(["admin", "data-fixes", "track"], "/api/admin/data-fixes?limit=1", {
    enabled: office,
  })
  const whyRow = data?.results.find((r) => r.id === why)
  const stages = data?.stages ?? []
  // The server sends the stages in order, and which ones this reader has.
  const main = stages.filter((s) => MAIN_STAGES.includes(s.key))
  const side = stages.filter((s) => SIDE_STAGES.includes(s.key))
  const chosen = stages.find((s) => s.key === stage)
  const filtered = Boolean(stage || department || month || q || fix)
  const head = data?.scope === "department"
  const related = hubSections("claims", role).flatMap((s) => s.items)

  if (isError && error?.status === 403) {
    return (
      <div className="page py-8">
        <ErrorState
          art="closed-gate"
          title="Not open to this account"
          message="Your own claims are under My papers."
        />
      </div>
    )
  }

  const departmentOptions: ComboboxOption[] = [
    { value: "", label: "Every department" },
    ...(data?.departments ?? []).map((d) => ({ value: d, label: d })),
  ]
  const monthOptions: ComboboxOption[] = [
    { value: "", label: "Any month filed" },
    ...(data?.months ?? []).map((m) => ({ value: m, label: monthLabel(m) })),
  ]

  return (
    <div className="page space-y-8">
      <PageHeader
        title="Track"
        sub={
          head
            ? `Where ${data?.department ?? "your department"}'s claims are.`
            : "Where every claim is, and how long it has waited."
        }
      >
        {related.length > 0 && (
          <p className="mt-3 flex flex-wrap items-center gap-x-1 gap-y-1 text-sm text-fg-muted">
            <span>Also look at</span>
            {related.map((r, i) => (
              <span key={r.to} className="inline-flex items-center gap-1">
                {i > 0 && <span aria-hidden>·</span>}
                <Link to={r.to} className="text-accent underline-offset-4 hover:underline">
                  {r.label}
                </Link>
              </span>
            ))}
          </p>
        )}
      </PageHeader>

      {head && data && <HeadLine stages={data.stages} department={data.department} />}

      <Board
        loading={isLoading && !data}
        main={main}
        side={side}
        selected={stage}
        onSelect={(k) => setParam("stage", k === stage ? "" : k)}
        money={data?.sees_money ?? false}
        flags={data?.sees_flags ?? false}
        total={data?.total_claims ?? 0}
      />

      {office && (fixes.data?.claims_needing_a_fix ?? 0) > 0 && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-base" data-testid="track-fixes">
          <span className="tabular">
            {fixes.data!.claims_needing_a_fix.toLocaleString("en-IN")} claims from the old ERP need fixing
          </span>
          <Button asChild size="sm" kind="quiet">
            <Link to="/track?fix=1">Show them here</Link>
          </Button>
          <Button asChild size="sm">
            <Link to="/data/fixes">Open the fix list</Link>
          </Button>
        </div>
      )}

      <section className="space-y-4" aria-label="Claims">
        <div className={filterBar} role="search" aria-label="Filter claims">
          <div className="relative min-w-0 flex-1 sm:min-w-[16rem]">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-fg-subtle" aria-hidden />
            <Input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Claim no., claimant or paper"
              aria-label="Search claims"
              className="pl-8"
            />
          </div>
          {!head && (
            <Combobox
              value={department}
              onChange={(v) => setParam("department", v)}
              options={departmentOptions}
              aria-label="Department"
              className="sm:w-52"
            />
          )}
          <Combobox
            value={month}
            onChange={(v) => setParam("month", v)}
            options={monthOptions}
            aria-label="Month filed"
            className="sm:w-48"
          />
        </div>

        <div className="flex min-h-7 flex-wrap items-center gap-2" role="status" aria-live="polite">
          {data && (
            <Meta className="tabular">
              {chosen ? `${chosen.label}: ` : ""}
              {data.total === 1 ? "1 claim" : `${data.total.toLocaleString("en-IN")} claims`}
              {fix ? " that need fixing" : filtered ? " matching" : ""}
            </Meta>
          )}
          {filtered && (
            <Button
              kind="quiet"
              size="sm"
              onClick={() => {
                setDraft("")
                setParams(new URLSearchParams())
              }}
            >
              Clear all
            </Button>
          )}
        </div>

        {isLoading && !data ? (
          <SkeletonRows rows={8} rowHeight={56} />
        ) : isError ? (
          <ErrorState
            title="Could not load the claims"
            message="The server did not answer. Nothing has been changed."
            onRetry={() => refetch()}
          />
        ) : (data?.results.length ?? 0) === 0 ? (
          <EmptyState
            art="no-results"
            icon={SearchX}
            title={filtered ? "No claim matches these filters" : "No claims have been filed yet"}
            message={
              filtered
                ? "Try a different stage or month, or clear the filters."
                : "A claim shows up here the moment it is filed."
            }
          />
        ) : (
          <>
            <ClaimTable
              rows={data!.results}
              role={role}
              money={data!.sees_money}
              flags={data!.sees_flags}
              sinceFiling={head}
              office={office}
              onWhy={(id) => setParam("why", id)}
            />
            <Pagination
              page={page}
              pageSize={PAGE_SIZE}
              total={data!.total}
              onChange={(n) => setParam("page", n > 0 ? String(n) : "")}
            />
          </>
        )}
      </section>

      {data?.sees_money && (
        <WhyAmountSheet
          claimId={why || null}
          openHref={why ? claimHref(role, whyRow ?? { id: why, is_mine: false }) : null}
          onClose={() => setParam("why", "")}
        />
      )}
    </div>
  )
}

/* ------------------------------------------------------------------------ */
/* The board                                                              */
/* ------------------------------------------------------------------------ */

function Board({
  loading,
  main,
  side,
  selected,
  onSelect,
  money: showMoney,
  flags,
  total,
}: {
  loading: boolean
  main: Stage[]
  side: Stage[]
  selected: string
  onSelect: (key: string) => void
  money: boolean
  flags: boolean
  total: number
}) {
  if (loading) {
    return (
      <div className="grid grid-cols-[minmax(0,1fr)] gap-3 sm:grid-cols-5" aria-hidden>
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-32" />
        ))}
      </div>
    )
  }
  return (
    <section className="space-y-3" aria-labelledby="track-board">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <SectionTitle>
          <span id="track-board">The journey</span>
        </SectionTitle>
        <Meta className="tabular">{total.toLocaleString("en-IN")} claims in all. Choose a stage to list its claims.</Meta>
      </div>

      <ol
        className="grid grid-cols-[minmax(0,1fr)] overflow-hidden rounded-panel border border-line bg-surface sm:auto-cols-fr sm:grid-flow-col sm:divide-x sm:divide-line max-sm:divide-y max-sm:divide-line"
        aria-label="Claims by stage"
      >
        {main.map((s, i) => (
          <li key={s.key} className="relative min-w-0">
            <StageButton stage={s} selected={selected === s.key} onSelect={onSelect} money={showMoney} flags={flags} />
            {i < main.length - 1 && (
              <ChevronRight
                className="pointer-events-none absolute -right-2 top-4 z-10 hidden size-4 rounded-full bg-surface text-fg-subtle sm:block"
                aria-hidden
              />
            )}
          </li>
        ))}
      </ol>

      {side.length > 0 && (
        <ul className="flex flex-wrap items-center gap-2" aria-label="Claims off the main path">
          <li>
            <Meta>Off the main path</Meta>
          </li>
          {side.map((s) => (
            <li key={s.key}>
              <button
                type="button"
                aria-pressed={selected === s.key}
                onClick={() => onSelect(s.key)}
                title={s.caption}
                className={cn(
                  "inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-sm ring-1 ring-inset",
                  selected === s.key ? "bg-accent text-accent-fg ring-accent" : "bg-surface text-fg-muted ring-line hover:text-fg",
                  s.count === 0 && selected !== s.key && "text-fg-subtle"
                )}
              >
                <span>{s.label}</span>
                <span className="tabular font-semibold">{s.count.toLocaleString("en-IN")}</span>
                {showMoney && (s.amount ?? 0) > 0 && <span className="tabular text-xs">{money(s.amount)}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function StageButton({
  stage: s,
  selected,
  onSelect,
  money: showMoney,
  flags,
}: {
  stage: Stage
  selected: boolean
  onSelect: (key: string) => void
  money: boolean
  flags: boolean
}) {
  const waiting = s.ageing ? Object.values(s.ageing).reduce((a, b) => a + b, 0) : 0
  const old = s.oldest_days
  // An amount of nothing is not a figure worth drawing.
  const hasMoney = showMoney && (s.amount ?? 0) > 0
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={() => onSelect(s.key)}
      className={cn(
        // A phone gets a slim row (the count, then the stage); a wide screen
        // gets a column with the count at its corner.
        "relative grid h-full w-full grid-cols-[2.75rem_minmax(0,1fr)] items-start gap-x-3 px-4 py-3 text-left",
        "transition-colors duration-[var(--dur-1)] sm:flex sm:flex-col sm:gap-1 sm:py-4",
        selected ? "bg-active" : "hover:bg-hover"
      )}
    >
      <span className="text-2xl font-semibold tabular leading-none max-sm:pt-0.5 sm:absolute sm:right-4 sm:top-4">
        {s.count.toLocaleString("en-IN")}
      </span>
      <span className="flex min-w-0 flex-col gap-1 sm:w-full">
        <span className="text-sm font-medium sm:pr-12">
          {s.label}
          {hasMoney && (
            <span className="ml-2 font-normal tabular text-fg-muted sm:hidden">{money(s.amount)}</span>
          )}
        </span>
        <span className="text-pretty text-xs text-fg-muted max-sm:hidden">{s.caption}</span>
        {hasMoney && <span className="text-sm tabular text-fg max-sm:hidden">{money(s.amount)}</span>}
        {s.ageing && waiting > 0 ? (
          <>
            <span
              className="mt-1 flex h-1.5 w-full overflow-hidden rounded-full bg-line"
              role="img"
              aria-label={AGE_BAR.map((a) => `${s.ageing![a.key]} ${a.label}`).join(", ")}
            >
              {AGE_BAR.map((a) => {
                const n = s.ageing![a.key]
                return n ? <span key={a.key} className={a.className} style={{ width: `${(n / waiting) * 100}%` }} /> : null
              })}
            </span>
            <span
              className={cn(
                "text-xs tabular text-fg-muted",
                old != null && old > 30 && "font-medium text-critical",
                old != null && old > 14 && old <= 30 && "text-caution"
              )}
            >
              Longest {days(old)}
              {s.average_days != null && waiting > 1 ? `, usually ${days(s.average_days)}` : ""}
            </span>
          </>
        ) : (
          <span className="mt-1 h-1.5 max-sm:hidden" aria-hidden />
        )}
        {flags && (s.flagged ?? 0) > 0 && (
          <span className="inline-flex items-center gap-1 text-xs text-caution">
            <Flag className="size-3" aria-hidden />
            {s.flagged === 1 ? "1 with an open flag" : `${s.flagged} with open flags`}
          </span>
        )}
      </span>
    </button>
  )
}

/* ------------------------------------------------------------------------ */
/* The claims                                                               */
/* ------------------------------------------------------------------------ */

/**
 * What an "ERP-" claim number is, said once above the table instead of on every
 * row. Without it the numbers read as codes: nobody who did not run the import
 * knows that RAW means "still waiting when it was imported" and PROCESSED
 * means "already paid".
 */
function ErpLegend({ head }: { head?: boolean }) {
  return (
    <details className="max-w-3xl text-sm text-fg-muted" data-testid="erp-legend">
      <summary className="cursor-pointer list-none underline-offset-4 hover:text-fg hover:underline">
        What an ERP- number is
      </summary>
      <p className="mt-1 text-pretty">
        {head
          ? "A claim number that starts ERP- was brought over from the college's earlier system, so it has no FP- number."
          : "A claim number that starts ERP- came from the old ERP and has no FP- number. ERP-RAW claims were still waiting when they were imported. ERP-PROCESSED claims had already been paid."}
      </p>
    </details>
  )
}

/**
 * A head's answer, in one sentence: how many of the department's claims are
 * still being checked, how long the longest has waited, and how many are done.
 * A head is not in the chain, so it also says what they can do about one.
 */
function HeadLine({ stages, department }: { stages: Stage[]; department: string | null | undefined }) {
  const by = (k: string) => stages.find((s) => s.key === k)
  const review = by("review")
  const approved = by("approved")
  const done = by("completed")
  const sentBack = by("sent_back")
  const total = stages.filter((s) => MAIN_STAGES.includes(s.key) || s.key === "sent_back").reduce((a, s) => a + s.count, 0)
  const part = (n: number, one: string, many: string) => `${n.toLocaleString("en-IN")} ${n === 1 ? one : many}`
  const bits = [
    review?.count
      ? `${part(review.count, "claim is", "claims are")} being checked by the college${review.oldest_days ? `, the longest for ${days(review.oldest_days)}` : ""}`
      : "No claim is waiting to be checked",
    approved?.count ? `${part(approved.count, "is", "are")} approved and being paid` : "",
    sentBack?.count ? `${part(sentBack.count, "was", "were")} sent back to the claimant` : "",
    done?.count ? `${part(done.count, "is", "are")} complete` : "",
  ].filter(Boolean)
  return (
    <p className="max-w-3xl text-pretty text-base" role="status" data-testid="track-head-line">
      {total ? `${department ?? "Your department"} has ${part(total, "claim", "claims")}: ` : ""}
      {bits.join("; ")}.{" "}
      <span className="text-fg-muted">
        You are not in the chain, so you cannot move a claim. If one is stuck, ask its owner.
      </span>
    </p>
  )
}

function ClaimTable({
  rows,
  role,
  money: showMoney,
  flags,
  sinceFiling,
  office,
  onWhy,
}: {
  rows: Row[]
  role: Role | undefined
  money: boolean
  flags: boolean
  /** A head is told days since filing, never how long a desk has had it. */
  sinceFiling: boolean
  office: boolean
  onWhy: (id: string) => void
}) {
  const hasErp = rows.some((r) => isErpNumber(r.ticket_number))

  const columns: Column<Row>[] = [
    {
      key: "number",
      header: "Claim no.",
      empty: "No number yet",
      className: "whitespace-nowrap",
      cell: (r) =>
        r.ticket_number ? (
          <span
            className="tabular text-xs text-fg-muted"
            title={isErpNumber(r.ticket_number) ? "Imported from the old ERP, so it has no FP- number" : undefined}
          >
            {r.ticket_number}
          </span>
        ) : null,
    },
    {
      key: "claimant",
      header: "Claimant",
      className: "md:max-w-[11rem]",
      cell: (r) => {
        const notFound = clean(r.owner_name) === null
        return (
          <span className="flex min-w-0 items-center gap-2.5">
            <Avatar
              person={{
                name: notFound ? "" : r.owner_name,
                initials: notFound ? "?" : (r.owner_initials ?? initialsOf(r.owner_name)),
                photo_url: r.owner_photo_url ?? null,
              }}
              size="sm"
            />
            <span className="min-w-0">
              <span className={cn("block truncate font-medium", notFound && "font-normal text-fg-muted")}>
                {notFound ? "Claimant not identified" : r.owner_name}
                {r.is_mine && <span className="ml-1.5 font-normal text-fg-muted">(you)</span>}
              </span>
              {clean(r.owner_department) && !notFound && (
                <Meta className="block truncate text-xs">{r.owner_department}</Meta>
              )}
            </span>
          </span>
        )
      },
    },
    {
      key: "paper",
      header: "Paper",
      className: "md:max-w-[17rem]",
      cell: (r) => {
        const title = clean(r.paper_title)
        const where = [clean(r.journal_title), clean(r.quartile), r.publication_year].filter(Boolean).join(" · ")
        return (
          <span className="block min-w-0">
            <Link
              to={claimHref(role, r)}
              className={cn("line-clamp-2 text-base underline-offset-4 hover:underline", !title && "text-fg-muted")}
            >
              {title ? paperTitle(title) : "Title not recorded"}
            </Link>
            <Meta className="block truncate text-xs">{where || "Journal not recorded"}</Meta>
          </span>
        )
      },
    },
    {
      key: "stands",
      header: "Where it stands",
      className: "min-w-[6rem]",
      cell: (r) => (
        <span className="flex flex-wrap items-center gap-1.5">
          <span>{r.stage_label}</span>
          {flags && (r.open_flags ?? 0) > 0 && (
            <Chip tone="caution" icon={Flag} title="Has an open flag">
              Flag
            </Chip>
          )}
          {flags && r.duplicate && (
            <Chip tone="caution" icon={Copy} title="May be a duplicate">
              Duplicate?
            </Chip>
          )}
          {office && (r.fixes?.length ?? 0) > 0 && (
            <Chip tone="caution" icon={Wrench} title={`Needs fixing: ${r.fixes!.join(", ").toLowerCase()}`}>
              Needs fixing
            </Chip>
          )}
        </span>
      ),
    },
    {
      key: "time",
      header: sinceFiling ? "Since filed" : "Time in stage",
      align: "right",
      className: "whitespace-nowrap",
      cell: (r) => {
        const d = r.days_in_stage
        const paid = r.stage === "paid" || r.stage === "completed"
        const late = !paid && d != null && d > 30
        const slow = !paid && d != null && d > 14 && d <= 30
        return (
          <span
            className={cn("font-normal text-fg-muted", late && "font-medium text-critical", slow && "text-caution")}
            title={!paid && d != null ? `${days(d)} at this stage` : undefined}
          >
            {paid && r.paid_on ? paidLabel(r.paid_on, r.paid_month_only) : paid && sinceFiling ? "Complete" : days(d)}
            {late && <span className="sr-only"> (over a month)</span>}
          </span>
        )
      },
    },
  ]

  if (showMoney) {
    columns.push({
      key: "amount",
      header: "Amount",
      align: "right",
      className: "min-w-[7.5rem]",
      cell: (r) => (
        <span className="flex flex-col md:items-end">
          {r.amount ? (
            <span>{money(r.amount)}</span>
          ) : (
            <>
              <span className="font-normal">{r.amount_note ?? "Not recorded"}</span>
              {r.amount_reason && (
                <span className="text-xs font-normal leading-tight text-fg-muted md:text-right">{r.amount_reason}</span>
              )}
            </>
          )}
          <Button
            kind="quiet"
            size="sm"
            onClick={() => onWhy(r.id)}
            className="mt-0.5 h-7 px-2 text-xs md:-mr-2"
            aria-label={`Why this amount: ${clean(r.paper_title) ?? r.ticket_number ?? "claim"}`}
          >
            Why this amount
          </Button>
        </span>
      ),
    })
  }

  return (
    <div className="space-y-3">
      {hasErp && <ErpLegend head={sinceFiling} />}
      <Table
        rows={rows}
        columns={columns}
        getKey={(r) => r.id}
        maxHeight="none"
        caption="Claims and where each one stands"
      />
    </div>
  )
}
