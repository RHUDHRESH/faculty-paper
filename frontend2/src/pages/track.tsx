import { useEffect, useState } from "react"
import { Link, useSearchParams } from "react-router-dom"
import { Copy, Flag, Search, SearchX, Wrench } from "lucide-react"

import { useAuth, type Role } from "@/app/auth"
import { api } from "@/lib/api"
import { cn } from "@/lib/cn"
import { paperTitle } from "@/lib/names"
import { useApi } from "@/lib/query"
import { Button } from "@/ui/button"
import { Chip } from "@/ui/chip"
import { Answer } from "@/ui/answer"
import { Combobox, type ComboboxOption } from "@/ui/combobox"
import { Input, Select } from "@/ui/field"
import { filterBar } from "@/ui/filter-bar"
import { money } from "@/ui/paper"
import { Pagination } from "@/ui/pagination"
import { Avatar, initialsOf } from "@/ui/person"
import { EmptyState, ErrorState, NotOpen, Skeleton, SkeletonRows } from "@/ui/state"
import { Meta } from "@/ui/text"
import { PageHeader } from "@/ui/page-header"
import { Table, type Column } from "@/ui/table"
import { WhyAmountSheet } from "@/pages/track-why"
import type { DataFixes } from "@/pages/admin-parts"
import {
  claimHref,
  clean,
  days,
  isErpNumber,
  paidLabel,
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

/** The four stages shown as figures; every stage is in the Stage filter. */
const KPI_STAGES = ["submitted", "checked", "approved", "paid"]
const HEAD_KPI_STAGES = ["review", "approved", "completed", "sent_back"]

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
  const sort = ["oldest", "newest", "amount"].includes(params.get("sort") ?? "") ? params.get("sort")! : "oldest"
  const pageSize = [30, 50, 100].includes(Number(params.get("size"))) ? Number(params.get("size")) : 30
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
  query.set("sort", sort)
  const filterQuery = query.toString()
  query.set("limit", String(pageSize))
  query.set("offset", String(page * pageSize))

  async function allRows(): Promise<Row[]> {
    const out: Row[] = []
    for (let offset = 0; offset < 5000; offset += 100) {
      const res = await api<Payload>(`/api/track?${filterQuery}&limit=100&offset=${offset}`)
      out.push(...res.results)
      if (out.length >= res.total || res.results.length === 0) break
    }
    return out
  }

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
  const filtered = Boolean(stage || department || month || q || fix)
  const head = data?.scope === "department"
  const stageText = (s: Stage) => `${s.label} (${s.count.toLocaleString("en-IN")})`
  const kpis = (head ? HEAD_KPI_STAGES : KPI_STAGES)
    .map((k) => stages.find((s) => s.key === k))
    .filter((s): s is Stage => Boolean(s))
    .map((s) => {
      const next = new URLSearchParams(params)
      if (stage === s.key) next.delete("stage")
      else next.set("stage", s.key)
      next.delete("page")
      const qs = next.toString()
      return {
        value: s.count,
        label: data?.sees_money && (s.amount ?? 0) > 0 ? `${s.label}, ${money(s.amount)}` : s.label,
        to: qs ? `/track?${qs}` : "/track",
      }
    })

  if (isError && error?.status === 403) {
    return (
      <div className="page py-8">
        <NotOpen message="Your own claims are under My papers." />
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
/>

      {data ? <Answer items={kpis} /> : <Skeleton className="h-20" />}

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
          <Select aria-label="Stage" value={stage} onChange={(e) => setParam("stage", e.target.value)} className="sm:w-52">
            <option value="">Every stage</option>
            {stages.map((s) => (
              <option key={s.key} value={s.key}>
                {stageText(s)}
              </option>
            ))}
          </Select>
          {filtered && (
            <Button
              kind="quiet"
              onClick={() => {
                setDraft("")
                setParams(new URLSearchParams())
              }}
            >
              Clear
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
            message={filtered ? "Clear the filters to see every claim." : "A claim shows up here the moment it is filed."}
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
              sort={sort}
              onSort={(k) =>
                setParam("sort", k === "amount" ? "amount" : sort === "oldest" ? "newest" : "oldest")
              }
              getAllRows={allRows}
            />
            <div className="flex flex-wrap items-center justify-between gap-3">
              <Pagination
                page={page}
                pageSize={pageSize}
                total={data!.total}
                onChange={(n) => setParam("page", n > 0 ? String(n) : "")}
              />
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

function ClaimTable({
  rows,
  role,
  money: showMoney,
  flags,
  sinceFiling,
  office,
  onWhy,
  sort,
  onSort,
  getAllRows,
}: {
  rows: Row[]
  role: Role | undefined
  money: boolean
  flags: boolean
  /** A head is told days since filing, never how long a desk has had it. */
  sinceFiling: boolean
  office: boolean
  onWhy: (id: string) => void
  sort: string
  onSort: (key: string) => void
  getAllRows: () => Promise<Row[]>
}) {
  const columns: Column<Row>[] = [
    {
      key: "number",
      header: "Claim no.",
      empty: "No number yet",
      sortable: false,
      exportValue: (r) => r.ticket_number ?? null,
      className: "whitespace-nowrap",
      cell: (r) =>
        r.ticket_number ? (
          <Link
            to={claimHref(role, r)}
            className="tabular text-sm text-accent underline-offset-4 hover:underline"
            title={isErpNumber(r.ticket_number) ? "Imported from the old ERP, so it has no FP- number" : undefined}
          >
            {r.ticket_number}
          </Link>
        ) : null,
    },
    {
      key: "claimant",
      header: "Claimant",
      exportValue: (r) => clean(r.owner_name),
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
      exportValue: (r) => clean(r.paper_title),
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
      exportValue: (r) => r.stage_label,
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
      sortable: true,
      exportKind: "number",
      exportValue: (r) => r.days_in_stage ?? null,
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
      sortable: true,
      exportKind: "money",
      exportValue: (r) => r.amount || null,
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
    <Table
      rows={rows}
      columns={columns}
      getKey={(r) => r.id}
      maxHeight="none"
      caption="Claims and where each one stands"
      sortKey={sort === "amount" ? "amount" : "time"}
      sortDir={sort === "oldest" || sort === "amount" ? "desc" : "asc"}
      onSort={onSort}
      tools={{ id: "track", title: "Track", getAllRows }}
    />
  )
}
