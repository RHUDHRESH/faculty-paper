import { Link } from "react-router-dom"
import { ChevronRight, Download } from "lucide-react"

import { leadSentence, n, papersLink, useBrief } from "@/pages/hod-parts"
import { Answer } from "@/ui/answer"
import { Button } from "@/ui/button"
import { PageHeader } from "@/ui/page-header"
import { Rows, Section } from "@/ui/section"
import { ErrorState } from "@/ui/state"
import { Meta } from "@/ui/text"

/**
 * Reports, as a head of department meets them (docs/jtbd/hod.md).
 *
 * A head is not asked for "reports"; they are asked "are we on track?" and
 * "what do I tell the Principal?". Each row is the question, with today's
 * answer under it, and opens the page that holds the proof. The two files a
 * head hands upward, the note for the Principal and the NBA and NAAC
 * workbook, are one click from here.
 */

function Question({
  question,
  answer,
  to,
  action,
}: {
  question: string
  answer: React.ReactNode
  to: string
  action?: React.ReactNode
}) {
  return (
    <li className="flex items-start gap-3 px-1 py-3 sm:px-2">
      <Link to={to} className="row group -m-1 flex min-w-0 flex-1 items-start gap-3 rounded-control p-1">
        <span className="min-w-0 flex-1">
          <span className="block text-base font-medium group-hover:underline group-hover:underline-offset-4">{question}</span>
          <span className="mt-0.5 block text-pretty text-sm text-fg-muted">{answer}</span>
        </span>
        {!action && <ChevronRight className="mt-1 size-4 shrink-0 text-fg-subtle max-sm:hidden" aria-hidden />}
      </Link>
      {action}
    </li>
  )
}

function Tool({ to, label, purpose }: { to: string; label: string; purpose: string }) {
  return (
    <li>
      <Link to={to} className="row group flex items-start gap-3 rounded-control px-1 py-2.5 sm:px-2">
        <span className="min-w-0 flex-1">
          <span className="block text-base font-medium group-hover:underline group-hover:underline-offset-4">{label}</span>
          <Meta className="block">{purpose}</Meta>
        </span>
        <ChevronRight className="mt-1 size-4 shrink-0 text-fg-subtle max-sm:hidden" aria-hidden />
      </Link>
    </li>
  )
}

export function HodReportsHub() {
  const brief = useBrief()
  const b = brief.data
  const t = b?.totals
  const silent = b ? b.push.filter((r) => r.kind === "slipped" || r.kind === "quiet" || r.kind === "never").length : null
  const year = b?.year

  return (
    <div className="page space-y-10">
      <PageHeader
        title="Reports"
        sub="The questions a head is asked, each with today's answer and the papers behind it one click away."
      />

      {brief.isError ? (
        <ErrorState
          what="the department's figures"
          onRetry={brief.error?.status === 400 || brief.error?.status === 403 ? false : () => void brief.refetch()}
          message={
            brief.error?.status === 400 || brief.error?.status === 403
              ? "This account is not set up as the head of a department. Ask the research office to set the department."
              : undefined
          }
        />
      ) : (
        <>
          <Answer
            items={[
              { value: t ? t.publications : null, label: `papers in ${year ?? "the year"}`, to: papersLink({ year }) },
              { value: t ? t.per_teacher : null, label: "papers per teacher", to: "/department" },
              {
                value: silent,
                label: `have no paper in ${year ?? "the year"}`,
                zero: "Everyone has a paper this year",
                to: "/department#push",
                tone: silent ? "caution" : "neutral",
              },
              {
                value: t ? t.missing_issn_or_doi : null,
                label: "papers missing a DOI or an ISSN",
                zero: "Every paper has a DOI and, for a journal, an ISSN",
                to: "/department?tab=records",
              },
            ]}
          />

          <Section title="Your questions">
            <Rows>
              <Question
                question="Are we on track?"
                to="/department"
                answer={b ? leadSentence(b) : "Loading the year."}
              />
              <Question
                question="Who needs a push?"
                to="/department#push"
                answer={
                  b
                    ? silent
                      ? `${n(silent)} ${silent === 1 ? "person has" : "people have"} no paper on record in ${b.year}. Each has a reason and a next step.`
                      : "Everyone has a paper on record this year."
                    : "Loading the people."
                }
              />
              <Question
                question="What do I tell the Principal?"
                to="/department"
                answer="A one-page note: the year against target or last year, who needs a push, and the records to fix."
                action={
                  <Button size="sm" asChild className="mt-0.5 shrink-0 max-sm:hidden">
                    <a href={`/api/hod/report?fmt=pdf${year ? `&year=${year}` : ""}`} download>
                      <Download />
                      Note for the Principal
                    </a>
                  </Button>
                }
              />
              <Question
                question="Is every paper ready for NBA and NAAC?"
                to="/department?tab=records"
                answer={
                  t
                    ? t.missing_issn_or_doi || t.without_scopus_id
                      ? `${n(t.missing_issn_or_doi)} papers of the last five years need a DOI or an ISSN, and ${n(t.without_scopus_id)} faculty have no Scopus ID on file.`
                      : "Every paper has its links and every teacher a Scopus ID."
                    : "Checking the records."
                }
                action={
                  <Button size="sm" asChild className="mt-0.5 shrink-0 max-sm:hidden">
                    <a href={`/api/hod/report?fmt=xlsx${year ? `&year=${year}` : ""}`} download>
                      <Download />
                      NBA and NAAC workbook
                    </a>
                  </Button>
                }
              />
              <Question
                question="Which papers make up a figure?"
                to="/publications"
                answer={
                  b
                    ? `${n(b.totals.publications)} papers of ${b.year}. Filter by year, journal quartile or author, then download.`
                    : "Loading the papers."
                }
              />
            </Rows>
          </Section>

          <Section title="Look something up" sub="A paper, a journal or a person.">
            <Rows>
              <Tool to="/search" label="Search" purpose="Papers, journals and colleagues, inside the college and outside it." />
              <Tool to="/journals" label="Journals" purpose="A journal's quartile, SNIP and standing, and the college's history with it." />
              <Tool to="/faculty" label="Faculty" purpose="Everyone in the department, with their Scopus ID, papers and record." />
            </Rows>
          </Section>
        </>
      )}
    </div>
  )
}
