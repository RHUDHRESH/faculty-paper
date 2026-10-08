import { Link } from "react-router-dom"
import { Download, FileText } from "lucide-react"

import { useAuth } from "@/app/auth"
import { hubSections } from "@/app/nav"
import { useApi } from "@/lib/query"
import { AnswerLine, AnswerWord } from "@/ui/answer"
import { Button } from "@/ui/button"
import { PageHeader } from "@/ui/page-header"
import { Details, Rows, Section } from "@/ui/section"
import { type Brief, change, n, rupees } from "@/pages/principal-parts"
import { packHref } from "@/pages/principal/year-column"

/**
 * Reports, as the Principal meets them (docs/jtbd/principal.md).
 *
 * The generic hub lists pages by name ("Analysis", "Build a report") and
 * leaves her to guess which one answers what she was asked. She is not asked
 * for a report; she is asked "are we better than last year?" So each row here
 * is the question in her words, with the answer as it stands today, and opens
 * the page that holds the proof. The pages that make a report from scratch sit
 * below, for the days she needs one no page has.
 */

/** What each unsettled check is called inside a sentence. */
const SETTLE: Record<string, string> = {
  partial: "the year is not over",
  budget: "no budget set",
  department: "papers with no department",
  quartile: "missing quartiles",
  ugc: "the UGC-CARE list",
}

function Question({
  question,
  answer,
  to,
  open,
  action,
}: {
  question: string
  answer: React.ReactNode
  to: string
  /** What the button says ("Open the brief"). */
  open: string
  action?: React.ReactNode
}) {
  return (
    <li className="flex items-start gap-4 px-1 py-3.5 sm:px-2">
      <div className="min-w-0 flex-1">
        <p className="text-base font-medium">{question}</p>
        <p className="mt-0.5 text-pretty text-sm text-fg-muted">{answer}</p>
      </div>
      <div className="flex shrink-0 items-center gap-2 max-sm:flex-col max-sm:items-stretch">
        {action}
        <Button kind="default" size="sm" asChild>
          <Link to={to}>{open}</Link>
        </Button>
      </div>
    </li>
  )
}

function Tool({ to, label, purpose }: { to: string; label: string; purpose: string }) {
  return (
    <li className="flex items-center gap-4 px-1 py-2.5 sm:px-2">
      <span className="min-w-0 flex-1">
        <span className="block text-base font-medium">{label}</span>
        <span className="block text-sm text-fg-muted max-sm:hidden">{purpose}</span>
      </span>
      <Button kind="default" size="sm" asChild>
        <Link to={to}>Open</Link>
      </Button>
    </li>
  )
}

type Budgets = {
  financial_year: string
  college: { allocated: number | null; spent: number; committed: number; remaining: number | null }
}

/**
 * Money, as the Principal meets it (docs/jtbd/principal.md, Q5).
 *
 * Her question is "how much of the year's money is gone, and is there room to
 * approve more?", so the answer leads: what the budget is, what has been paid,
 * what is committed and what is left, from the same figures the Budget page
 * shows. Below it the same pages the generic hub lists, with what each is for.
 */
export function PrincipalMoneyHub() {
  const { me } = useAuth()
  const q = useApi<Budgets>(["budgets", ""], "/api/budgets")
  const c = q.data?.college
  const fy = q.data?.financial_year
  const sections = hubSections("money", me?.role)

  return (
    <div className="page space-y-10">
      <PageHeader
        title="Money"
        action={
          <Button kind="primary" asChild>
            <Link to="/budget">Open the budget</Link>
          </Button>
        }
      />

      <div className="-mt-6 space-y-4">
        <AnswerLine>
          {!c ? (
            "Where the year's money stands."
          ) : (
            <>
              {rupees(c.spent)} paid
              {c.committed ? `, ${rupees(c.committed)} on its way` : ""}
              {fy ? ` in FY ${fy}.` : "."}{" "}
              {c.allocated == null ? (
                <AnswerWord tone="amber">No budget set</AnswerWord>
              ) : c.remaining != null && c.remaining < 0 ? (
                <AnswerWord tone="amber">{rupees(Math.abs(c.remaining))} over</AnswerWord>
              ) : (
                <AnswerWord tone="sage">{rupees(c.remaining ?? 0)} left</AnswerWord>
              )}
            </>
          )}
        </AnswerLine>
        {c && c.allocated == null && (
          <p className="max-w-[40rem] text-lead text-fg-muted">There is nothing to weigh spending against. Finance sets the budget.</p>
        )}
      </div>

      <div className="grid grid-cols-[minmax(0,1fr)] gap-x-12 gap-y-10 lg:grid-cols-2">
        {sections.map((s) => (
          <Section key={s.title} title={s.title}>
            <Rows>
              {s.items.map((item) => (
                <Tool key={item.to} to={item.to} label={item.label} purpose={item.purpose ?? ""} />
              ))}
            </Rows>
          </Section>
        ))}
      </div>
    </div>
  )
}

export function PrincipalReportsHub() {
  const brief = useApi<Brief>(["reports-brief", ""], "/api/reports/brief")
  const all = useApi<{ total: number }>(["reports-papers-total"], "/api/reports/papers?limit=1")
  const b = brief.data
  const t = b?.totals
  const toSettle = b ? b.pack.filter((c) => !c.ok).length : null
  const names = (b?.push ?? []).slice(0, 3).map((d) => d.department)

  return (
    <div className="page space-y-10">
      <PageHeader
        title="Reports"
        action={
          <Button kind={toSettle === 0 ? "primary" : "default"} asChild>
            <a href={packHref(b?.year)} download>
              <FileText />
              Download the council pack
            </a>
          </Button>
        }
      />

      <div className="-mt-6">
        <AnswerLine>
          {toSettle == null ? (
            "What the council will ask."
          ) : toSettle === 0 ? (
            <>
              The council pack is <AnswerWord tone="sage">ready</AnswerWord>.
            </>
          ) : (
            <>
              {toSettle} {toSettle === 1 ? "thing" : "things"} to settle before the pack goes.
            </>
          )}
        </AnswerLine>
      </div>

      <Section title="Your questions">
        <Rows>
          <Question
            question="Are we better than last year, and where?"
            to="/reports/brief"
            open="Open the brief"
            answer={
              t && b
                ? `${n(t.papers)} papers in ${b.year}, ${change(t.papers, t.papers_prev)}; ${n(t.per_teacher)} per teacher, ${change(t.per_teacher, t.per_teacher_prev)}.`
                : "Loading the year."
            }
          />
          <Question
            question="Which departments need a push?"
            to="/reports/departments"
            open="Open departments"
            answer={
              b
                ? names.length
                  ? `${b.push.length} to call about, starting with ${names.join(", ")}.`
                  : "None stands out as behind."
                : "Loading the departments."
            }
          />
          <Question
            question="What goes in the council pack?"
            to="/reports/brief#pack"
            open="See what to settle"
            answer={
              b
                ? toSettle
                  ? `${toSettle} to settle first: ${b.pack
                      .filter((c) => !c.ok)
                      .map((c) => SETTLE[c.key] ?? c.label)
                      .join(", ")}.`
                  : "Nothing to settle. The PDF and the Excel are ready."
                : "Checking the pack."
            }
          />
          <Question
            question="Where do we stand for NAAC and NIRF?"
            to="/accreditation"
            open="Open accreditation"
            answer={
              b
                ? `${n(b.naac_331.per_teacher)} papers per teacher over five years, band ${b.naac_331.band} of 4 on NAAC 3.3.1.`
                : "Loading the figures."
            }
            action={
              <Button kind="default" size="sm" asChild className="max-sm:hidden">
                <a href="/api/reports/pack?fmt=xlsx" download>
                  <Download />
                  Workbook
                </a>
              </Button>
            }
          />
          <Question
            question="What did the scheme cost, against the budget?"
            to="/budget"
            open="Open the budget"
            answer={
              t && b
                ? `${rupees(t.paid)} paid in FY ${b.financial_year}${
                    t.budget ? `, ${t.budget_used}% of the ${rupees(t.budget)} budget` : "; no budget is set for it"
                  }.`
                : "Loading the spend."
            }
          />
          <Question
            question="Which papers make up a figure?"
            to="/reports/papers"
            open="Open the papers"
            answer={all.data ? `${n(all.data.total)} papers on record.` : "Loading the papers."}
          />
        </Rows>
      </Section>

      <Details label="more reports and look-ups">
        <div className="grid grid-cols-[minmax(0,1fr)] gap-x-12 gap-y-8 pt-3 lg:grid-cols-2">
          <Section title="Look something up">
            <Rows>
              <Tool to="/search" label="Search" purpose="Papers, journals and colleagues." />
              <Tool to="/journals" label="Journals" purpose="A journal's quartile and standing." />
              <Tool to="/archive" label="Past claims" purpose="Every claim ever filed." />
              <Tool to="/publications" label="Claims by stage" purpose="Every claim the scheme has handled." />
            </Rows>
          </Section>
          <Section title="Make your own">
            <Rows>
              <Tool to="/reports" label="Analysis" purpose="Output by department, journal, quartile and year." />
              <Tool to="/reports/build" label="Build a report" purpose="Choose what to count, then download." />
            </Rows>
          </Section>
        </div>
      </Details>
    </div>
  )
}
