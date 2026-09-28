import { useMemo, useState } from "react"
import { CircleCheck, ExternalLink, History, TriangleAlert, Upload } from "lucide-react"

import { api, ApiError } from "@/lib/api"
import { useApi } from "@/lib/query"
import { Button } from "@/ui/button"
import { ConfirmDialog } from "@/ui/dialog"
import { Field, Input } from "@/ui/field"
import { Callout, EmptyState, ErrorState, InlineError, SkeletonText } from "@/ui/state"
import { Table } from "@/ui/table"
import { ColumnLabel, Figure, Meta, PageTitle, SectionTitle, Sub } from "@/ui/text"
import { toast } from "@/ui/toast"

/**
 * The two journal tables every payment is worked out against, and — the point
 * of the screen — which *years* of them are actually loaded.
 *
 * Quartile and SNIP are both terms in the payout formula, so a journal missing
 * from these tables is priced as though it had no standing. The screen used to
 * answer that with one number: "32,189 journals held". That number is true and
 * useless, because coverage is a per-year question. `lookup_scimago` falls back
 * to the newest dump it has when the paper's own year is absent, so a 2021
 * paper priced off the 2025 ranking looks exactly like a paper priced
 * correctly. Nobody could see it, because nothing on the page compared the
 * years held against the years claimed for.
 *
 * The other thing it did was offer a "Fetch it" button that could not ever
 * work: SCImago fronts its portal with a bot challenge only a browser can
 * answer, so the server gets the challenge page instead of the CSV, every
 * single time. A button that always fails teaches people the screen is broken
 * and they stop reading it. It is gone, and the steps that do work are here in
 * its place.
 */

type Stats = { count: number; years: number[] }

type AuditRow = {
  id: number
  action: string
  actor: string | null
  detail_json: string
  created_at: string
}

type AuditPage = { total: number; results: AuditRow[] }

type DimensionRow = { key: string; count: number }
type DimensionTable = { key: string; rows: DimensionRow[] }
type ReportBuild = { tables: DimensionTable[] }

/** One year, and whether each table has anything for it. */
type CoverageRow = {
  year: number
  papers: number
  scimago: boolean
  snip: boolean
}

type Coverage = {
  rows: CoverageRow[]
  /** Years that papers were published in and no ranking is held for. */
  scimagoMissing: number[]
  snipMissing: number[]
  /** Of those, the one holding the most papers — the year to load first,
   *  because it is the one deciding the most money. */
  scimagoWorst: number | null
  snipWorst: number | null
  /** Papers sitting in those years — the figure this page exists to show. */
  scimagoGap: number
  snipGap: number
  papers: number
  undated: number
  scimagoNewest: number | null
  snipNewest: number | null
}

const NUM = (n: number) => n.toLocaleString("en-IN")

function isYear(value: number): boolean {
  return Number.isInteger(value) && value >= 1900 && value <= 2200
}

/** Turn three separate answers into the one question a reader has: which years
 *  am I short of, and how many papers are being priced against the gap. */
function buildCoverage(
  scimagoYears: number[],
  snipYears: number[],
  yearRows: DimensionRow[]
): Coverage {
  const papersByYear = new Map<number, number>()
  let undated = 0
  let papers = 0
  for (const row of yearRows) {
    papers += row.count
    const year = Number(row.key)
    if (isYear(year)) papersByYear.set(year, (papersByYear.get(year) ?? 0) + row.count)
    else undated += row.count
  }

  const scimagoHeld = new Set(scimagoYears)
  const snipHeld = new Set(snipYears)
  const every = [...new Set([...papersByYear.keys(), ...scimagoYears, ...snipYears])]

  const rows: CoverageRow[] = every
    .sort((a, b) => b - a)
    .map((year) => ({
      year,
      papers: papersByYear.get(year) ?? 0,
      scimago: scimagoHeld.has(year),
      snip: snipHeld.has(year),
    }))

  const claimed = rows.filter((r) => r.papers > 0)
  const scimagoGaps = claimed.filter((r) => !r.scimago)
  const snipGaps = claimed.filter((r) => !r.snip)

  // Rows are newest first, so the first maximum is the newest year among
  // equals — the one more papers will keep arriving for.
  const worst = (gaps: CoverageRow[]): number | null =>
    gaps.reduce<CoverageRow | null>(
      (best, r) => (best === null || r.papers > best.papers ? r : best),
      null
    )?.year ?? null

  return {
    rows,
    scimagoMissing: scimagoGaps.map((r) => r.year).sort((a, b) => a - b),
    snipMissing: snipGaps.map((r) => r.year).sort((a, b) => a - b),
    scimagoWorst: worst(scimagoGaps),
    snipWorst: worst(snipGaps),
    scimagoGap: scimagoGaps.reduce((n, r) => n + r.papers, 0),
    snipGap: snipGaps.reduce((n, r) => n + r.papers, 0),
    papers,
    undated,
    scimagoNewest: scimagoYears.length ? Math.max(...scimagoYears) : null,
    snipNewest: snipYears.length ? Math.max(...snipYears) : null,
  }
}

/** "2021, 2022 and 2023" — a list somebody can read out loud. */
function listYears(years: number[]): string {
  if (years.length === 0) return ""
  if (years.length === 1) return String(years[0])
  return `${years.slice(0, -1).join(", ")} and ${years[years.length - 1]}`
}

/* ------------------------------------------------------------------------ */

export function Reference() {
  const scimago = useApi<Stats>(["admin", "scimago", "stats"], "/api/admin/scimago/stats")
  const snip = useApi<Stats>(["admin", "snip", "stats"], "/api/admin/snip/stats")
  // Publication years of every non-draft claim, with how many sit in each.
  // There is no endpoint that answers "which years do we need"; this one
  // answers it as a side effect of being the report builder's year breakdown.
  const claimed = useApi<ReportBuild>(
    ["reports", "build", "year"],
    "/api/reports/build?dimensions=year&limit=1000"
  )

  const loading = scimago.isLoading || snip.isLoading || claimed.isLoading
  const failed = scimago.error || snip.error || claimed.error

  function retry() {
    void scimago.refetch()
    void snip.refetch()
    void claimed.refetch()
  }

  const coverage = useMemo(() => {
    if (!scimago.data || !snip.data || !claimed.data) return null
    const yearTable = claimed.data.tables.find((t) => t.key === "year")
    return buildCoverage(scimago.data.years, snip.data.years, yearTable?.rows ?? [])
  }, [scimago.data, snip.data, claimed.data])

  return (
    <div className="page space-y-8">
      <header>
        <PageTitle>Reference data</PageTitle>
        <Sub className="mt-1">
          The two journal tables every amount is worked out against. Both are
          keyed by year, and a paper whose year is not loaded is priced against
          a different year's ranking without anybody being told.
        </Sub>
      </header>

      {loading ? (
        <div className="panel space-y-3 p-5">
          <SkeletonText lines={3} />
        </div>
      ) : failed ? (
        <ErrorState
          title="Could not read the coverage"
          message="The counts and the years they cover did not load, so this page cannot tell you what is missing. Nothing has been changed."
          onRetry={retry}
        />
      ) : coverage ? (
        <CoveragePanel
          coverage={coverage}
          scimagoCount={scimago.data?.count ?? 0}
          snipCount={snip.data?.count ?? 0}
        />
      ) : null}

      <ScimagoPanel
        stats={scimago.data ?? null}
        loadFirst={coverage?.scimagoWorst ?? null}
        onImported={retry}
      />
      <SnipPanel
        stats={snip.data ?? null}
        loadFirst={coverage?.snipWorst ?? null}
        onImported={retry}
      />
    </div>
  )
}

/* ------------------------------------------------------------------------ */
/* Coverage — the page's one answer                                          */
/* ------------------------------------------------------------------------ */

function CoveragePanel({
  coverage,
  scimagoCount,
  snipCount,
}: {
  coverage: Coverage
  scimagoCount: number
  snipCount: number
}) {
  const nothingLoaded = scimagoCount === 0 && snipCount === 0
  const complete = coverage.scimagoGap === 0 && coverage.snipGap === 0

  if (nothingLoaded) {
    return (
      <EmptyState
        icon={TriangleAlert}
        title="Neither table has been loaded"
        message={`All ${NUM(coverage.papers)} papers on record are being priced with no quartile and no SNIP — that is the flat conference rate, whatever the journal. Load a year with the steps below.`}
      />
    )
  }

  return (
    <section className="panel-lead space-y-5 p-5">
      <div>
        <SectionTitle>Years you are short of</SectionTitle>
        <Sub className="mt-1">
          Measured against the {NUM(coverage.papers)} papers on record, not
          against the calendar.
        </Sub>
      </div>

      {complete ? (
        <p className="flex items-start gap-2 text-base">
          <CircleCheck
            aria-hidden="true"
            className="mt-0.5 size-4 shrink-0 text-positive"
          />
          <span>
            Every publication year on record has a row in both tables. Nothing
            here is falling back to another year's figures.
          </span>
        </p>
      ) : (
        <div className="grid gap-5 sm:grid-cols-2">
          <Gap
            label="Priced on the wrong year's quartile"
            count={coverage.scimagoGap}
            missing={coverage.scimagoMissing}
            explanation={
              coverage.scimagoNewest === null
                ? "No SCImago year is loaded at all, so none of these papers has a quartile."
                : `Their years are not in the SCImago table, so each one falls back to the newest ranking that journal has — ${coverage.scimagoNewest} for most of them. A journal that moved between Q1 and Q2 in the meantime is being paid at the wrong rate.`
            }
          />
          <Gap
            label="Priced on the wrong year's SNIP"
            count={coverage.snipGap}
            missing={coverage.snipMissing}
            explanation={
              coverage.snipNewest === null
                ? "No SNIP year is loaded at all, so these fall back to the flat rate."
                : "The SNIP lookup does not filter by year at all — it takes whichever row matches the ISSN, from whatever years are loaded. Unlike the quartile, nothing on the claim records that it did."
            }
          />
        </div>
      )}

      {coverage.undated > 0 && (
        <Meta className="block">
          {NUM(coverage.undated)}{" "}
          {coverage.undated === 1 ? "paper carries" : "papers carry"} no
          publication year, so no year of either table can be the right one for{" "}
          {coverage.undated === 1 ? "it" : "them"}. Loading more data will not
          fix that; the year has to go on the claim.
        </Meta>
      )}

      <hr className="hairline" />

      <CoverageTable coverage={coverage} />

      <Meta className="block">
        {NUM(scimagoCount)} SCImago rows and {NUM(snipCount)} SNIP rows in
        total, across the years above.
      </Meta>
    </section>
  )
}

function Gap({
  label,
  count,
  missing,
  explanation,
}: {
  label: string
  count: number
  missing: number[]
  explanation: string
}) {
  const clean = count === 0
  return (
    <div className="space-y-1.5">
      <ColumnLabel>{label}</ColumnLabel>
      {/* Tone is never the only signal — the label above says what a high
          number here means, in words. */}
      <Figure tone={clean ? "positive" : "caution"} className="block">
        {NUM(count)}
      </Figure>
      {clean ? (
        <p className="text-sm text-fg-muted">Every year on record is loaded.</p>
      ) : (
        <p className="text-sm text-fg-muted">
          <span className="font-medium text-fg">
            Missing: {listYears(missing)}.
          </span>{" "}
          {explanation}
        </p>
      )}
    </div>
  )
}

function CoverageTable({ coverage }: { coverage: Coverage }) {
  return (
    <Table
      rows={coverage.rows}
      getKey={(r) => String(r.year)}
      minWidth="30rem"
      maxHeight="24rem"
      caption="Publication years, how many papers sit in each, and whether each reference table covers that year"
      empty="No publication years on record and no reference data loaded."
      columns={[
        {
          key: "year",
          header: "Year",
          cell: (r) => <span className="tabular font-medium">{r.year}</span>,
        },
        {
          key: "papers",
          header: "Papers",
          align: "right",
          cell: (r) =>
            r.papers > 0 ? (
              NUM(r.papers)
            ) : (
              <span className="text-fg-subtle">none</span>
            ),
        },
        {
          key: "scimago",
          header: "Quartile",
          cell: (r) => <Held held={r.scimago} needed={r.papers > 0} />,
        },
        {
          key: "snip",
          header: "SNIP",
          cell: (r) => <Held held={r.snip} needed={r.papers > 0} />,
        },
      ]}
    />
  )
}

/** Loaded, missing-and-wanted, or missing-and-nobody-asked. The third is not a
 *  problem and must not be drawn like one, or a reader scanning the column
 *  counts eleven faults where there are three. */
function Held({ held, needed }: { held: boolean; needed: boolean }) {
  if (held) {
    return (
      <span className="inline-flex items-center gap-1.5 text-fg-muted">
        <CircleCheck className="size-3.5 text-positive" aria-hidden="true" />
        Loaded
      </span>
    )
  }
  if (!needed) return <span className="text-fg-subtle">not loaded</span>
  return (
    <span className="inline-flex items-center gap-1.5 font-medium text-caution">
      <TriangleAlert className="size-3.5" aria-hidden="true" />
      Missing
    </span>
  )
}

/* ------------------------------------------------------------------------ */
/* Last refreshed                                                            */
/* ------------------------------------------------------------------------ */

/**
 * When this table was last loaded, and by whom.
 *
 * Neither stats endpoint carries a timestamp, so this reads the audit trail —
 * the same rows the import writes. If that is refused or fails, the panel says
 * the page cannot tell rather than showing a blank where a date goes, because
 * "never loaded" and "we could not find out" are different sentences and only
 * one of them is a reason to load the file again.
 */
function LastLoaded({ action, label }: { action: string; label: string }) {
  const { data, isLoading, error, refetch } = useApi<AuditPage>(
    ["admin", "audit", action],
    `/api/admin/audit?action=${action}&limit=1`
  )

  if (isLoading) return <SkeletonText lines={1} className="max-w-sm" />

  if (error) {
    return (
      <InlineError
        message={
          error instanceof ApiError && error.status === 403
            ? `This page cannot tell you when the ${label} table was last refreshed — reading the audit trail is not permitted for your role.`
            : `Could not read when the ${label} table was last refreshed. The table itself is fine; only this date is missing.`
        }
        onRetry={() => void refetch()}
      />
    )
  }

  const last = data?.results[0]
  if (!last) {
    return (
      <Meta className="flex items-start gap-2">
        <History className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
        No import of the {label} table has ever been recorded here. Anything
        already loaded went in before this screen existed, from a shell.
      </Meta>
    )
  }

  const when = new Date(last.created_at).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
  })

  return (
    <Meta className="flex items-start gap-2">
      <History className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
      <span>
        Last loaded {when} by {last.actor ?? "somebody no longer on the system"}
        {describeImport(last)}.
      </span>
    </Meta>
  )
}

/** The import records what it did; say it rather than storing it and never
 *  showing it. Detail shapes differ per action and are not to be trusted. */
function describeImport(row: AuditRow): string {
  let detail: unknown
  try {
    detail = JSON.parse(row.detail_json)
  } catch {
    return ""
  }
  if (typeof detail !== "object" || detail === null) return ""
  const bag = detail as Record<string, unknown>
  const rows = typeof bag.imported === "number" ? bag.imported : bag.n
  const year = typeof bag.year === "number" ? bag.year : null
  const bits: string[] = []
  if (typeof rows === "number") bits.push(`${NUM(rows)} rows`)
  if (year !== null) bits.push(`for ${year}`)
  if (row.action.endsWith("_SYNC")) bits.push("by automatic download")
  return bits.length ? ` — ${bits.join(" ")}` : ""
}

/* ------------------------------------------------------------------------ */
/* Importing                                                                 */
/* ------------------------------------------------------------------------ */

/** The upload form both tables share. It is the same three questions each
 *  time — which year, which file, and are you sure if the year already has
 *  rows — and two copies of it drift. */
function ImportForm({
  suggestedYear,
  heldYears,
  fileHint,
  label,
  onSubmit,
}: {
  suggestedYear: number
  heldYears: number[]
  fileHint: string
  label: string
  onSubmit: (file: File, year: number) => Promise<void>
}) {
  const [year, setYear] = useState(String(suggestedYear))
  const [file, setFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState(false)

  const parsed = Number(year)
  const yearOk = isYear(parsed)
  const replacing = yearOk && heldYears.includes(parsed)
  const ready = Boolean(file) && yearOk && !busy

  async function run() {
    if (!file || !yearOk) return
    setBusy(true)
    try {
      await onSubmit(file, parsed)
      setFile(null)
    } catch (err) {
      toast.fail(err)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <div className="well grid gap-4 p-4 sm:grid-cols-[8rem_1fr_auto] sm:items-end">
        <Field
          label="Year"
          hint="The year of the data, not today."
          error={year.trim() && !yearOk ? "A four-digit year." : undefined}
        >
          <Input
            value={year}
            onChange={(e) => setYear(e.target.value)}
            inputMode="numeric"
            className="tabular"
          />
        </Field>

        <Field label="File" hint={fileHint}>
          <input
            type="file"
            accept=".csv,text/csv"
            onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
              setFile(e.target.files?.[0] || null)
            }
            className="block w-full rounded-md bg-surface py-1 text-sm shadow-well ring-1 ring-inset ring-field file:mr-3 file:h-7 file:rounded-sm file:border-0 file:bg-sunken file:px-3 file:text-sm file:font-medium file:text-fg hover:file:bg-hover"
          />
        </Field>

        <Button
          kind="primary"
          disabled={!ready}
          onClick={() => (replacing ? setConfirming(true) : void run())}
          className="w-full sm:w-auto"
        >
          <Upload />
          {busy ? "Loading…" : replacing ? `Replace ${parsed}` : "Import"}
        </Button>
      </div>

      {replacing && !busy && (
        <Meta className="block">
          {parsed} is already loaded. Importing again replaces the figures for
          every journal in the file.
        </Meta>
      )}

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={`Replace the ${parsed} ${label} figures?`}
        // What the importer actually does, checked against the backend: it
        // upserts on (ISSN, year). So matching rows are overwritten, unmatched
        // ones are added, and rows for this year that are not in the file are
        // left exactly as they are. Nothing is deleted, and no other year is
        // touched. Saying "this wipes the year" would be a lie in the
        // frightening direction, which is still a lie.
        description={`Every journal in this file replaces the ${parsed} figures already held for it, and any journal not yet held is added. Rows for ${parsed} that the file does not mention are left alone — nothing is deleted, and no other year is touched. Papers already paid keep the amount they were paid; anything still being checked is repriced against whatever is here afterwards.`}
        confirmLabel={`Replace ${parsed}`}
        cancelLabel="Leave it as it is"
        onConfirm={run}
      />
    </>
  )
}

/* ------------------------------------------------------------------------ */

function ScimagoPanel({
  stats,
  loadFirst,
  onImported,
}: {
  stats: Stats | null
  loadFirst: number | null
  onImported: () => void
}) {
  // The missing year with the most papers behind it, so the form opens on the
  // one worth doing first rather than on a year that is already loaded.
  const suggested = loadFirst ?? new Date().getFullYear() - 1

  async function upload(file: File, year: number) {
    const body = new FormData()
    body.append("file", file)
    body.append("year", String(year))
    const res = await api<{ imported: number; skipped: number; year: number }>(
      "/api/admin/scimago/import",
      { method: "POST", body } as unknown as Parameters<typeof api>[1]
    )
    toast.ok(
      `${NUM(res.imported)} journals loaded for ${res.year}${
        res.skipped ? `, ${NUM(res.skipped)} rows skipped` : ""
      }.`
    )
    onImported()
  }

  return (
    <section className="panel space-y-5 p-5">
      <div>
        <SectionTitle>SCImago — where a quartile comes from</SectionTitle>
        <Sub className="mt-1">
          Q1 to Q4 is a multiplier in the payout, and almost every quartile on
          the system was read out of this table rather than typed by a person.
          One row per journal per year.
        </Sub>
      </div>

      {/* The server cannot fetch this (SCImago answers a server with a
          403 challenge page -- checked 2026-09-23), but a browser can: this
          opens SCImago's own export for the year, which the browser saves,
          ready for the upload below. */}
      <div className="flex flex-wrap items-center gap-3 rounded-md bg-sunken p-3 text-sm">
        <a
          className="font-medium text-accent hover:underline"
          href={`https://www.scimagojr.com/journalrank.php?year=${suggested}&out=xls`}
          target="_blank"
          rel="noreferrer"
        >
          Download the {suggested} rankings from SCImago
        </a>
        <span className="text-fg-muted">
          Opens in your browser and saves the file; then upload it below with the same year.
        </span>
      </div>

      <Steps
        title="Or get it by hand"
        note="There is no button here that fetches it for you, and there should not be: SCImago fronts its portal with a bot-protection challenge that only a browser can answer, so a server asking for the file gets the challenge page instead of the CSV. Every time, not intermittently."
        steps={[
          <>
            Open{" "}
            <Link href="https://www.scimagojr.com/journalrank.php">
              scimagojr.com journal rankings
            </Link>{" "}
            in a browser.
          </>,
          <>
            Set <b>Year</b> in the row of dropdowns above the table to the year
            you need. Leave subject area, category, region and type on{" "}
            <b>All</b> — narrowing any of them silently exports a slice, and a
            journal outside the slice reads afterwards as a journal with no
            standing.
          </>,
          <>
            Use <b>Download data</b> at the top right of the table. It saves a
            semicolon-separated CSV.
          </>,
          <>
            Upload it below with the same year. Nothing needs editing first:
            the parser reads either delimiter, splits the two ISSNs the dump
            packs into one column, and knows that an SJR of{" "}
            <span className="tabular">0,137</span> is a decimal and not{" "}
            <span className="tabular">137</span>.
          </>,
        ]}
      />

      {/* Keyed on the suggestion: coverage arrives after this form first
          renders, and a year box still showing last year when the page has
          just worked out that 2021 is the gap is the whole problem again in
          miniature. Remounting also clears the chosen file after an import,
          so the next one cannot be sent twice by accident. */}
      <ImportForm
        key={suggested}
        label="quartile"
        suggestedYear={suggested}
        heldYears={stats?.years ?? []}
        fileHint="The SCImago rank export. Title, Issn, SJR and Categories are the columns that matter."
        onSubmit={upload}
      />

      <LastLoaded action="SCIMAGO" label="quartile" />
    </section>
  )
}

/* ------------------------------------------------------------------------ */

function SnipPanel({
  stats,
  loadFirst,
  onImported,
}: {
  stats: Stats | null
  loadFirst: number | null
  onImported: () => void
}) {
  const suggested = loadFirst ?? new Date().getFullYear() - 1
  const held = [...(stats?.years ?? [])].sort((a, b) => a - b)

  async function upload(file: File, year: number) {
    const body = new FormData()
    body.append("file", file)
    body.append("year", String(year))
    const res = await api<{ imported?: number }>("/api/admin/snip/import", {
      method: "POST",
      body,
    } as unknown as Parameters<typeof api>[1])
    toast.ok(`${NUM(res.imported ?? 0)} sources loaded for ${year}.`)
    onImported()
  }

  return (
    <section className="panel space-y-5 p-5">
      <div>
        <SectionTitle>SNIP — citation impact</SectionTitle>
        <Sub className="mt-1">
          The figure the amount is multiplied by. A journal with no SNIP here
          falls back to a flat conference or book-chapter rate, whatever the
          journal actually is.
        </Sub>
      </div>

      <Callout tone="caution" title="This lookup ignores the year">
        The quartile lookup at least records that it used another year's
        ranking. The SNIP lookup does not filter by year at all — it takes
        whichever row matches the ISSN, from whatever years are loaded.
        {held.length > 0 && (
          <>
            {" "}
            Only {listYears(held)} {held.length === 1 ? "is" : "are"} loaded, so
            a paper of any vintage is priced on{" "}
            {held.length === 1 ? "that year's" : "one of those years'"} SNIP and
            nothing on the claim says so.
          </>
        )}{" "}
        Loading the other years is what fixes it.
      </Callout>

      <Steps
        title="Getting the file"
        note="Where the college's existing file came from is not recorded anywhere in this system, so check with whoever loaded it before assuming a source. What the importer needs is fixed, and it is listed below."
        steps={[
          <>
            SNIP is published per year by CWTS Leiden at{" "}
            <Link href="https://www.journalindicators.com">
              journalindicators.com
            </Link>
            , free, and appears in Scopus's own annual source-title list. Either
            is a defensible source; both give one row per journal per year.
          </>,
          <>
            The importer reads these column headings, and ignores anything
            else: <b>Title</b>, <b>Print ISSN</b>, <b>E-ISSN</b>, <b>SNIP</b>,{" "}
            <b>SJR</b>, <b>Source ID</b>. Rename the columns in the spreadsheet
            before saving if they do not match, or every row will be skipped
            for having no title.
          </>,
          <>
            Save as CSV, not xlsx. Format the two ISSN columns as <b>text</b>{" "}
            first: read as numbers, <span className="tabular">0390-6663</span>{" "}
            arrives as <span className="tabular">3906663</span> and matches
            nothing. That has happened here before, to 53,848 values.
          </>,
          <>Upload it below with the year the figures are for.</>,
        ]}
      />

      <ImportForm
        key={suggested}
        label="SNIP"
        suggestedYear={suggested}
        heldYears={stats?.years ?? []}
        fileHint="Columns Title, Print ISSN, E-ISSN, SNIP, SJR, Source ID."
        onSubmit={upload}
      />

      <Meta className="block">
        This importer writes row by row rather than in one transaction, so if it
        fails part-way the year is left half-loaded rather than untouched. If an
        import here reports an error, check the count above before assuming
        nothing happened.
      </Meta>

      <LastLoaded action="SNIP_IMPORT" label="SNIP" />
    </section>
  )
}

/* ------------------------------------------------------------------------ */

/** Numbered instructions with the caveat that governs them stated first.
 *  A note printed under a list of steps is read after the steps have been
 *  attempted, which is too late for "this cannot be automated". */
function Steps({
  title,
  note,
  steps,
}: {
  title: string
  note: string
  steps: React.ReactNode[]
}) {
  return (
    <div className="space-y-3">
      <ColumnLabel>{title}</ColumnLabel>
      <p className="text-sm text-fg-muted">{note}</p>
      <ol className="space-y-2.5">
        {steps.map((step, i) => (
          <li key={i} className="flex gap-3 text-base">
            <span
              aria-hidden="true"
              className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-sm bg-hover text-xs font-medium tabular text-fg-muted"
            >
              {i + 1}
            </span>
            <span className="min-w-0 text-pretty">{step}</span>
          </li>
        ))}
      </ol>
    </div>
  )
}

/** An outbound link, marked as one. A reader following these steps is being
 *  sent to another site and should know before they click, not after. */
function Link({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      className="inline-flex items-baseline gap-1 font-medium text-accent underline decoration-accent-line underline-offset-2 hover:decoration-accent"
    >
      {children}
      <ExternalLink className="size-3 shrink-0 self-center" aria-hidden="true" />
    </a>
  )
}
