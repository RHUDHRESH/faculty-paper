import { useEffect, useState } from "react"
import { Link, useParams, useSearchParams } from "react-router-dom"
import { ArrowLeft, BookOpen, Search, SearchX } from "lucide-react"

import { can, useAuth } from "@/app/auth"
import { cn } from "@/lib/cn"
import { useApi } from "@/lib/query"
import { RankedBars, MixBar, Trend, type Point } from "@/ui/chart"
import { Input } from "@/ui/field"
import { money, Stage, stageOf } from "@/ui/paper"
import { Callout, EmptyState, ErrorState, Skeleton, SkeletonRows, SkeletonText } from "@/ui/state"
import { Table, type Column } from "@/ui/table"
import { Meta, PageTitle, SectionTitle, Sub } from "@/ui/text"

/**
 * Where this college publishes (`Journals`) and one journal's record
 * (`JournalRecord`) — SJR, SNIP, quartile per subject, and who here has
 * published there, each name a door to `/people/{id}`.
 *
 * The rule that matters more than any layout choice: a head of department
 * must never see a rupee figure here, by any route. `/api/journals/top` and
 * `/api/journals/report` already strip every money key server-side for an
 * HOD (`hod.without_money`), but this file does not rely on that alone —
 * every chart is still told `showAmounts={false}` and handed points with
 * `amount` stripped, because a chart's own "show the numbers" table reads
 * straight off the point regardless of which axis (`unit`) it was drawing.
 * Without both, a column added to `Figure` later would leak a figure the
 * component was never meant to hold.
 *
 * `/api/journals/top` returns `{ key, count, amount }` per journal and
 * nothing else — no quartile. A journal's quartile lives only behind
 * `/api/journals/report`, which is a per-journal lookup, so the list below
 * shows what the list endpoint actually has (name, papers, paid) rather than
 * guessing at a field that was never in the response.
 */

/* ------------------------------------------------------------------------ */
/* Journals — where this college publishes                                  */
/* ------------------------------------------------------------------------ */

type JournalRow = {
  key: string
  count: number
  amount?: number
}

type JournalsPayload = {
  results: JournalRow[]
}

// journals/top has no offset/total — it is one ranked list, capped
// server-side at 500. A page this size never needs client pagination, only
// the search box below to narrow it.
const RESULT_LIMIT = 500

/**
 * The journals this college has actually published in, most-used first and
 * searchable by name. Each row links to its record.
 */
export function Journals() {
  const { me } = useAuth()
  const showMoney = can(me?.role).seeMoney

  const [searchParams, setSearchParams] = useSearchParams()
  const q = searchParams.get("q") ?? ""

  // The box's own state so typing feels instant; the URL only catches up
  // once typing pauses, matching `people.tsx`.
  const [searchDraft, setSearchDraft] = useState(q)
  useEffect(() => setSearchDraft(q), [q])

  useEffect(() => {
    if (searchDraft === q) return
    const t = setTimeout(() => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev)
          if (searchDraft) next.set("q", searchDraft)
          else next.delete("q")
          return next
        },
        { replace: true }
      )
    }, 250)
    return () => clearTimeout(t)
  }, [searchDraft, q, setSearchParams])

  const listQuery = new URLSearchParams()
  if (q) listQuery.set("q", q)
  listQuery.set("limit", String(RESULT_LIMIT))

  const { data, isLoading, isError, error, refetch } = useApi<JournalsPayload>(
    ["journals-top", q],
    `/api/journals/top?${listQuery.toString()}`
  )

  const journals = data?.results ?? []
  const filtered = Boolean(q)

  const columns: Column<JournalRow>[] = [
    {
      key: "journal",
      header: "Journal",
      cell: (j) => (
        <span className="block min-w-0 truncate text-base" title={j.key}>
          {j.key}
        </span>
      ),
    },
    {
      key: "count",
      header: "Papers",
      align: "right",
      className: "w-28",
      cell: (j) => <span className="tabular">{j.count.toLocaleString("en-IN")}</span>,
    },
    ...(showMoney
      ? [
          {
            key: "amount",
            header: "Paid",
            align: "right" as const,
            className: "w-36",
            cell: (j: JournalRow) => <span className="tabular">{money(j.amount)}</span>,
          },
        ]
      : []),
  ]

  return (
    <div className="page space-y-6">
      <header>
        <PageTitle>Journals</PageTitle>
        <Sub className="mt-1">Where this college actually publishes, most-used first.</Sub>
      </header>

      {!showMoney && (
        <Callout tone="info" title="Payment figures are not shown for this role">
          As a head of department you can see how much a journal is used, not what the college
          has paid for it.
        </Callout>
      )}

      <div className="relative w-full max-w-xs">
        <Search
          className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-fg-subtle"
          aria-hidden
        />
        <Input
          value={searchDraft}
          onChange={(e) => setSearchDraft(e.target.value)}
          placeholder="Search journal name"
          aria-label="Search journals"
          className="pl-8"
        />
      </div>

      {isLoading ? (
        <SkeletonRows rows={8} rowHeight={48} />
      ) : isError ? (
        error?.status === 403 ? (
          <ErrorState
            title="Not visible to this account"
            message="This list is open to heads of department, the principal, finance and the research cell — not to faculty accounts."
          />
        ) : (
          <ErrorState
            title="Could not load the journal list"
            message="The server did not answer. Nothing has been lost."
            onRetry={() => refetch()}
          />
        )
      ) : journals.length === 0 ? (
        <EmptyState
          icon={filtered ? SearchX : BookOpen}
          title={filtered ? "No journal matches" : "Nothing published yet"}
          message={
            filtered
              ? "No journal name matches this search. Try a shorter or different term."
              : "Journals appear here once a paper is filed against one."
          }
        />
      ) : (
        <>
          <Table
            rows={journals}
            columns={columns}
            getKey={(j) => j.key}
            rowLink={(j) => `/journals/${encodeURIComponent(j.key)}`}
            minWidth="30rem"
          />
          {journals.length >= RESULT_LIMIT && (
            <Meta className="block">
              Showing the top {RESULT_LIMIT}. Narrow the search to find one further down.
            </Meta>
          )}
        </>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------------ */
/* JournalRecord — one journal                                              */
/* ------------------------------------------------------------------------ */

type ScimagoCategory = { category: string; quartile: string }

type ScimagoInfo = {
  source_id: string | null
  sjr: number | null
  year: number | null
  issn: string | null
  eissn: string | null
  verified_live: boolean
  categories: ScimagoCategory[]
  best_quartile: string | null
}

type SnipInfo = {
  snip: number | null
  sjr: number | null
  year: number | null
}

type JournalInfo = {
  title: string
  issn: string | null
  indexing: string | null
  engineering_class: string | null
  subject_category: string | null
  snip_on_record: number | null
  snip_year_on_record: number | null
  scimago: ScimagoInfo | null
  snip: SnipInfo | null
}

type JournalTotals = {
  publications: number
  authors: number
  departments: number
  paid_claims: number
  // Absent entirely for an HOD — `hod.without_money` removes the key rather
  // than sending a null, so a screen that forgot the role check would find
  // nothing here to render by mistake.
  paid_amount?: number
  first_year: number | null
  last_year: number | null
}

type JournalAuthor = {
  key: string
  id: string
  department: string
  count: number
  amount?: number
}

type JournalClaimRow = {
  id: string
  ticket_number: string | null
  paper_title: string
  owner_id: string | null
  owner_name: string | null
  publication_year: number | null
  // Raw status, present for everyone but an HOD.
  status?: string
  // A head reads progress instead — see `hod.progress_of` on the server.
  progress?: string
  remuneration?: number | null
  remuneration_is_estimate?: boolean
  calc_error?: string | null
}

type JournalReport = {
  journal: JournalInfo
  totals: JournalTotals
  by_year: Point[]
  by_quartile: Point[]
  by_status: Point[]
  by_department: Point[]
  authors: JournalAuthor[]
  claims: JournalClaimRow[]
}

/** Every `amount` dropped, `count` left alone — belt and braces alongside the
 *  server's own stripping, so a chart handed these points cannot show a
 *  rupee figure even in its own "show the numbers" table, which reads
 *  straight off the point rather than off whichever axis the chart was told
 *  to draw. Mirrors `people.tsx`'s `countOnly`, redeclared locally since that
 *  one is not exported and this file may not touch `people.tsx`. */
function countOnly(points: Point[]): Point[] {
  return points.map(({ amount: _amount, ...rest }) => rest)
}

function metric(n: number | null | undefined): string {
  return n == null ? "—" : n.toFixed(3)
}

/**
 * One journal: its standing (SJR, SNIP, quartile per subject) and who at
 * this college publishes there — the screen somebody opens to decide whether
 * a venue is worth submitting to.
 */
export function JournalRecord() {
  const { title: rawTitle } = useParams<{ title: string }>()
  // react-router decodes a path param for you; a second decode here would
  // mangle a title that happens to contain a literal "%".
  const title = rawTitle ?? ""
  const { me } = useAuth()
  const showMoney = can(me?.role).seeMoney

  const {
    data: report,
    isLoading,
    error,
    refetch,
  } = useApi<JournalReport>(
    ["journal-report", title],
    `/api/journals/report?title=${encodeURIComponent(title)}`,
    { enabled: !!title }
  )

  if (!title) {
    return (
      <div className="page py-8">
        <ErrorState title="No such journal" message="No journal name was given in the link." />
      </div>
    )
  }

  if (isLoading) {
    return (
      <div className="page space-y-8 py-8">
        <Skeleton className="h-4 w-24" />
        <div className="space-y-2">
          <Skeleton className="h-7 w-2/3 max-w-md" />
          <Skeleton className="h-4 w-48" />
        </div>
        <SkeletonText lines={4} />
      </div>
    )
  }

  if (error) {
    if (error.status === 403) {
      return (
        <div className="page py-8">
          <ErrorState
            title="Not visible to this account"
            message="This record is open to heads of department, the principal, finance and the research cell — not to faculty accounts."
          />
        </div>
      )
    }
    if (error.status === 404) {
      return (
        <div className="page py-8">
          <ErrorState
            title="No such journal"
            message="No publication on record names this journal. It may have been renamed, or nothing has been filed under it yet."
          />
        </div>
      )
    }
    return (
      <div className="page py-8">
        <ErrorState
          title="Could not load this record"
          message="The server did not answer. Nothing has been lost."
          onRetry={() => void refetch()}
        />
      </div>
    )
  }

  if (!report) {
    return (
      <div className="page py-8">
        <EmptyState title="Nothing here" message="This journal has no record to show." />
      </div>
    )
  }

  const { journal, totals, by_year, by_quartile, by_status, by_department, authors, claims } =
    report

  const stagePoints = (showMoney ? by_status : countOnly(by_status)).map((p) => ({
    ...p,
    label: stageOf(p.key).label,
  }))

  const authorPoints: Point[] = authors.map((a) => ({
    key: a.id,
    label: `${a.key} · ${a.department}`,
    count: a.count,
    amount: showMoney ? a.amount : undefined,
    to: `/people/${a.id}`,
  }))

  const activeYears =
    totals.first_year && totals.last_year
      ? totals.first_year === totals.last_year
        ? String(totals.first_year)
        : `${totals.first_year}–${totals.last_year}`
      : "—"

  const claimColumns: Column<JournalClaimRow>[] = [
    {
      key: "paper",
      header: "Paper",
      className: "max-w-[22rem]",
      cell: (c) => (
        <span className="block min-w-0">
          <span className="block truncate text-base">{c.paper_title || "Untitled"}</span>
          <Meta className="mt-0.5 block truncate">{c.ticket_number || "—"}</Meta>
        </span>
      ),
    },
    {
      key: "author",
      header: "Author",
      className: "max-w-[12rem]",
      cell: (c) =>
        c.owner_id ? (
          <Link
            to={`/people/${c.owner_id}`}
            className="block truncate text-sm hover:text-accent hover:underline"
          >
            {c.owner_name || "—"}
          </Link>
        ) : (
          <span className="block truncate text-sm text-fg-muted">{c.owner_name || "—"}</span>
        ),
    },
    {
      key: "year",
      header: "Year",
      className: "w-16",
      cell: (c) => <span className="tabular">{c.publication_year ?? "—"}</span>,
    },
    {
      key: "stage",
      header: "Stage",
      className: "w-36",
      cell: (c) =>
        showMoney ? (
          <Stage stage={stageOf(c.status ?? "")} />
        ) : (
          <span className="text-sm">{c.progress ?? "—"}</span>
        ),
    },
    ...(showMoney
      ? [
          {
            key: "amount",
            header: "Amount",
            align: "right" as const,
            cell: (c: JournalClaimRow) => <AmountCell claim={c} />,
          },
        ]
      : []),
  ]

  return (
    <div className="page space-y-10 py-8">
      <Link
        to="/journals"
        className="inline-flex items-center gap-1 text-sm text-fg-muted hover:text-fg"
      >
        <ArrowLeft className="size-3.5" aria-hidden />
        Journals
      </Link>

      <header className="space-y-1">
        <PageTitle>{journal.title}</PageTitle>
        <Sub>
          {[journal.subject_category, journal.indexing].filter(Boolean).join(" · ") || "—"}
        </Sub>
        {journal.issn && <Meta className="block">ISSN {journal.issn}</Meta>}
      </header>

      {!showMoney && (
        <Callout tone="info" title="Payment figures are not shown for this role">
          As a head of department you can see who publishes here and what it is worth
          academically, not what the college has paid for it.
        </Callout>
      )}

      <section className="grid gap-x-10 gap-y-6 sm:grid-cols-3 md:grid-cols-5">
        <Stat label="Publications" value={String(totals.publications)} />
        <Stat label="Authors" value={String(totals.authors)} />
        <Stat label="Departments" value={String(totals.departments)} />
        <Stat label="Active" value={activeYears} muted={activeYears === "—"} />
        {showMoney && (
          <Stat label="Paid" value={String(totals.paid_claims)} hint={money(totals.paid_amount)} />
        )}
      </section>

      <section className="space-y-4">
        <SectionTitle>Standing</SectionTitle>
        <div className="grid gap-x-10 gap-y-6 sm:grid-cols-3">
          <Stat label="SJR" value={metric(journal.scimago?.sjr)} muted={journal.scimago?.sjr == null} />
          <Stat
            label="SNIP"
            value={journal.snip?.snip != null ? metric(journal.snip.snip) : "No SNIP recorded"}
            muted={journal.snip?.snip == null}
          />
          <Stat
            label="Best quartile"
            value={journal.scimago?.best_quartile ?? "—"}
            muted={!journal.scimago?.best_quartile}
          />
        </div>

        {journal.scimago && journal.scimago.categories.length > 0 ? (
          <ul>
            {journal.scimago.categories.map((c) => (
              <li
                key={c.category}
                className="flex items-center justify-between gap-3 border-b border-line py-1.5 text-sm last:border-0"
              >
                <span className="text-fg-muted">{c.category}</span>
                <span className="tabular">{c.quartile}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-fg-muted">
            Not matched against Scimago, so there is no subject-level quartile on file for this
            journal.
          </p>
        )}

        {journal.snip_on_record != null && (
          <p className="text-sm text-fg-muted">
            The claims filed here were verified against a SNIP of{" "}
            <span className="tabular">{metric(journal.snip_on_record)}</span>
            {journal.snip_year_on_record ? ` (${journal.snip_year_on_record})` : ""} at the time
            of filing — which can differ from the current figure above, since a journal's SNIP
            moves year to year.
          </p>
        )}
      </section>

      <section className="space-y-10">
        <Trend
          title="Publications over time"
          dimension="Year"
          points={showMoney ? by_year : countOnly(by_year)}
          unit="count"
          showAmounts={showMoney}
        />
        <MixBar
          title="Quartile mix"
          dimension="Quartile"
          points={showMoney ? by_quartile : countOnly(by_quartile)}
          unit="count"
          showAmounts={showMoney}
        />
        <MixBar
          title="Where each paper stands"
          dimension="Stage"
          points={stagePoints}
          unit="count"
          showAmounts={showMoney}
        />
        {by_department.length > 1 && (
          <MixBar
            title="Departments publishing here"
            dimension="Department"
            points={showMoney ? by_department : countOnly(by_department)}
            unit="count"
            showAmounts={showMoney}
          />
        )}
        <RankedBars
          title="Who publishes here"
          dimension="Author"
          points={authorPoints}
          unit="count"
          showAmounts={showMoney}
        />
      </section>

      <section className="space-y-3">
        <SectionTitle>Papers</SectionTitle>
        <Table
          rows={claims}
          columns={claimColumns}
          getKey={(c) => c.id}
          rowLink={(c) => `/papers/${c.id}`}
          minWidth="44rem"
          empty="Nothing published here yet."
        />
        {totals.publications > claims.length && (
          <Meta className="block">
            Showing the {claims.length} most recent of {totals.publications}.
          </Meta>
        )}
      </section>
    </div>
  )
}

/* ------------------------------------------------------------------------ */
/* Shared pieces                                                            */
/* ------------------------------------------------------------------------ */

/** The amount, with the two things that make it not a settled figure shown
 *  beside it — mirrors `people.tsx`'s `AmountCell`, redeclared locally for
 *  the same reason as `countOnly`. */
function AmountCell({ claim }: { claim: JournalClaimRow }) {
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

/** A number that is an answer, not a tile — matches `people.tsx`'s local
 *  `Figure`, renamed here to avoid reading as the module-private `Figure`
 *  that `@/ui/chart` already builds every chart's shell from. */
function Stat({
  label,
  value,
  hint,
  muted,
}: {
  label: string
  value: string
  hint?: string
  muted?: boolean
}) {
  return (
    <div>
      <p className="text-sm text-fg-muted">{label}</p>
      <p className={cn("mt-0.5 text-2xl font-semibold tabular", muted && "text-fg-subtle")}>
        {value}
      </p>
      {hint && <p className="mt-0.5 text-sm text-fg-muted">{hint}</p>}
    </div>
  )
}
