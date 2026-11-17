import { Link } from "react-router-dom"

import { cn } from "@/lib/cn"
import { paperTitle, unshout } from "@/lib/names"
import { JournalCover } from "@/ui/journal-cover"
import { money, Stage, stageOf } from "@/ui/paper"
import { Callout } from "@/ui/state"
import { Table, type Column } from "@/ui/table"
import { Meta, PageTitle, SectionTitle, Sub } from "@/ui/text"

/**
 * One journal as a faculty member sees it: the journal's own facts and their
 * own papers in it, and nothing about anybody else's.
 *
 * `/api/journals/report` answers a faculty account with this shape
 * (`view: "faculty"`), built on the server from scratch. There is no author
 * list here, no count of colleagues' papers and no amount that is not the
 * reader's own, because none of it is in the response to draw.
 */

export type FacultyStanding = {
  state: "unknown" | "discontinued" | "not_discontinued" | "listed" | "removed" | "not_listed"
  since: string | null
  reason: string | null
}

export type FacultyJournal = {
  view: "faculty"
  journal: {
    title: string
    issn: string | null
    eissn: string | null
    publisher: string | null
    subject_category: string | null
    indexing: string | null
    engineering_class: string | null
    snip_by_year: { year: number; snip: number }[]
    sjr_by_year: {
      year: number
      sjr: number | null
      best_quartile: string | null
      categories: { category: string; quartile: string }[]
    }[]
    standing: { scopus_discontinued: FacultyStanding; ugc_care: FacultyStanding }
  }
  mine: {
    count: number
    claims: {
      id: string
      ticket_number: string | null
      paper_title: string
      publication_year: number | null
      status: string
      quartile: string | null
      snip: number | null
      remuneration: number | null
      remuneration_is_estimate: boolean
    }[]
  }
}

export const isFacultyJournal = (r: unknown): r is FacultyJournal =>
  !!r && typeof r === "object" && (r as { view?: string }).view === "faculty"

const figure = (v: number | null | undefined) => (v == null ? "Not recorded" : v.toFixed(3))

function Stat({ label, value, hint, muted }: { label: string; value: string; hint?: string; muted?: boolean }) {
  return (
    <div>
      <p className="text-sm text-fg-muted">{label}</p>
      <p className={cn("mt-0.5 figure text-figure font-semibold tabular", muted && "text-fg-subtle")}>{value}</p>
      {hint && <p className="mt-0.5 text-sm text-fg-muted">{hint}</p>}
    </div>
  )
}

function shortDate(iso: string | null): string {
  if (!iso) return ""
  const d = new Date(`${iso.slice(0, 10)}T00:00:00`)
  return Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })
}

/** One line on whether Scopus and the UGC-CARE list still recognise the journal. */
export function standingLines(s: FacultyJournal["journal"]["standing"]): { tone: "info" | "positive" | "caution"; text: string }[] {
  const out: { tone: "info" | "positive" | "caution"; text: string }[] = []
  const d = s.scopus_discontinued
  if (d.state === "discontinued") {
    const when = shortDate(d.since)
    out.push({
      tone: "caution",
      text: `Scopus has discontinued this journal${when ? ` (since ${when})` : ""}.${d.reason ? ` ${d.reason}` : ""} A paper published before that date was in a recognised journal at the time.`,
    })
  } else if (d.state === "not_discontinued") {
    out.push({ tone: "positive", text: "Scopus has not discontinued this journal." })
  } else {
    out.push({ tone: "info", text: "We have not loaded Scopus's discontinued list yet, so this is not checked." })
  }
  const u = s.ugc_care
  if (u.state === "removed") {
    const when = shortDate(u.since)
    out.push({
      tone: "caution",
      text: `The UGC-CARE list has removed this journal${when ? ` (since ${when})` : ""}.${u.reason ? ` ${u.reason}` : ""}`,
    })
  } else if (u.state === "listed") {
    out.push({ tone: "positive", text: "The journal is on the UGC-CARE list." })
  } else if (u.state === "not_listed") {
    out.push({ tone: "info", text: "The journal is not on the UGC-CARE list we hold." })
  } else {
    out.push({ tone: "info", text: "We have not loaded the UGC-CARE list yet, so this is not checked." })
  }
  return out
}

type YearRow = { year: number; snip: number | null; sjr: number | null; quartile: string | null }

/** SNIP and SJR share a year column; either may be missing for a year. */
function byYear(j: FacultyJournal["journal"]): YearRow[] {
  const rows = new Map<number, YearRow>()
  for (const s of j.snip_by_year) rows.set(s.year, { year: s.year, snip: s.snip, sjr: null, quartile: null })
  for (const r of j.sjr_by_year) {
    const row = rows.get(r.year) ?? { year: r.year, snip: null, sjr: null, quartile: null }
    rows.set(r.year, { ...row, sjr: r.sjr, quartile: r.best_quartile })
  }
  return [...rows.values()].sort((a, b) => b.year - a.year)
}

export function FacultyJournalRecord({ report }: { report: FacultyJournal }) {
  const { journal: j, mine } = report
  const years = byYear(j)
  const latest = years[0]
  const latestSjr = j.sjr_by_year[0]
  const quartileYears = j.sjr_by_year.map((r) => r.year)
  const categories = [...new Set(j.sjr_by_year.flatMap((r) => r.categories.map((c) => c.category)))]
  const quartileOf = (category: string, year: number) =>
    j.sjr_by_year.find((r) => r.year === year)?.categories.find((c) => c.category === category)?.quartile

  const yearColumns: Column<YearRow>[] = [
    { key: "year", header: "Year", cell: (r) => <span className="tabular">{r.year}</span> },
    { key: "snip", header: "SNIP", align: "right", empty: "Not recorded", cell: (r) => (r.snip == null ? null : <span className="tabular">{figure(r.snip)}</span>) },
    { key: "sjr", header: "SJR", align: "right", empty: "Not recorded", cell: (r) => (r.sjr == null ? null : <span className="tabular">{figure(r.sjr)}</span>) },
    { key: "quartile", header: "Best quartile", align: "right", empty: "Not recorded", cell: (r) => r.quartile },
  ]

  const claimColumns: Column<FacultyJournal["mine"]["claims"][number]>[] = [
    {
      key: "paper",
      header: "Paper",
      className: "max-w-[22rem]",
      cell: (c) => (
        <span className="block min-w-0">
          <span className="block truncate text-base">{paperTitle(c.paper_title)}</span>
          <Meta className="mt-0.5 block truncate">{c.ticket_number || "Not numbered yet"}</Meta>
        </span>
      ),
    },
    { key: "year", header: "Year", className: "w-16", cell: (c) => <span className="tabular">{c.publication_year ?? ""}</span>, empty: "Not recorded" },
    { key: "stage", header: "Stage", className: "w-36", cell: (c) => <Stage stage={stageOf(c.status)} /> },
    {
      key: "amount",
      header: "Amount",
      align: "right",
      empty: "Not worked out",
      cell: (c) =>
        c.remuneration == null ? null : (
          <span className="inline-flex flex-col items-end">
            <span className="tabular">{money(c.remuneration)}</span>
            {c.remuneration_is_estimate && <span className="text-xs leading-tight text-caution">Estimate</span>}
          </span>
        ),
    },
  ]

  const ids = [j.issn && `ISSN ${j.issn}`, j.eissn && `eISSN ${j.eissn}`].filter(Boolean).join(" · ")
  const classification = [
    j.subject_category && ["Subject", j.subject_category],
    j.indexing && ["Indexed in", j.indexing],
    j.engineering_class && ["Engineering class", j.engineering_class],
  ].filter(Boolean) as [string, string][]
  const lines = standingLines(j.standing)

  return (
    <div className="page space-y-10 py-8">
      <header className="flex items-start gap-4">
        <JournalCover title={j.title} size="lg" className="max-sm:hidden" />
        <JournalCover title={j.title} size="md" className="sm:hidden" />
        <div className="min-w-0 space-y-1">
          <PageTitle>{unshout(j.title)}</PageTitle>
          {j.publisher && <Sub>{j.publisher}</Sub>}
          {ids && <Meta className="block">{ids}</Meta>}
        </div>
      </header>

      <section className="space-y-4" aria-labelledby="jf-standing">
        <SectionTitle id="jf-standing">Standing</SectionTitle>
        <div className="grid grid-cols-[minmax(0,1fr)] gap-x-10 gap-y-6 sm:grid-cols-3">
          <Stat
            label="Latest SNIP"
            value={latest?.snip != null ? figure(latest.snip) : "No SNIP recorded"}
            hint={latest?.snip != null ? String(latest.year) : undefined}
            muted={latest?.snip == null}
          />
          <Stat
            label="Latest SJR"
            value={latestSjr?.sjr != null ? figure(latestSjr.sjr) : "Not recorded"}
            hint={latestSjr?.sjr != null ? String(latestSjr.year) : undefined}
            muted={latestSjr?.sjr == null}
          />
          <Stat label="Best quartile" value={latestSjr?.best_quartile ?? "Not recorded"} muted={!latestSjr?.best_quartile} />
        </div>
        <div className="space-y-2">
          {lines.map((l) => (
            <Callout key={l.text} tone={l.tone}>
              {l.text}
            </Callout>
          ))}
        </div>
        {classification.length > 0 && (
          <dl className="grid grid-cols-[minmax(0,1fr)] gap-x-10 gap-y-3 sm:grid-cols-3">
            {classification.map(([k, v]) => (
              <div key={k}>
                <dt className="text-sm text-fg-muted">{k}</dt>
                <dd className="text-base">{v}</dd>
              </div>
            ))}
          </dl>
        )}
      </section>

      <section className="space-y-3" aria-labelledby="jf-years">
        <SectionTitle id="jf-years">Year by year</SectionTitle>
        {years.length > 0 ? (
          <Table rows={years} columns={yearColumns} getKey={(r) => String(r.year)} minWidth="22rem" maxHeight="none" caption="SNIP, SJR and best quartile by year" />
        ) : (
          <p className="text-sm text-fg-muted">
            Not matched against Scimago or the SNIP list, so there is no yearly figure on file for this journal.
          </p>
        )}
      </section>

      {categories.length > 0 && (
        <section className="space-y-3" aria-labelledby="jf-quartiles">
          <SectionTitle id="jf-quartiles">Quartile by subject</SectionTitle>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[22rem] text-sm">
              <caption className="sr-only">Quartile in each subject category, by year</caption>
              <thead>
                <tr className="border-b border-line text-left text-fg-muted">
                  <th scope="col" className="py-1.5 pr-4 font-normal">
                    Subject
                  </th>
                  {quartileYears.map((y) => (
                    <th key={y} scope="col" className="px-2 py-1.5 text-right font-normal tabular">
                      {y}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {categories.map((c) => (
                  <tr key={c} className="border-b border-line last:border-0">
                    <th scope="row" className="py-1.5 pr-4 text-left font-normal">
                      {c}
                    </th>
                    {quartileYears.map((y) => (
                      <td key={y} className="px-2 py-1.5 text-right tabular">
                        {quartileOf(c, y) ?? "Not listed"}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section className="space-y-3" aria-labelledby="jf-mine">
        <SectionTitle id="jf-mine">Your papers here</SectionTitle>
        {mine.claims.length > 0 ? (
          <Table
            rows={mine.claims}
            columns={claimColumns}
            getKey={(c) => c.id}
            rowLink={(c) => `/papers/${c.id}`}
            minWidth="36rem"
            maxHeight="none"
            caption="Your claims in this journal"
          />
        ) : (
          <p className="text-sm text-fg-muted">
            You have no claim in this journal.{" "}
            <Link to="/journal-check" className="text-accent underline-offset-4 hover:underline">
              Check a journal before you submit
            </Link>
            .
          </p>
        )}
      </section>
    </div>
  )
}
