import { Link } from "react-router-dom"
import { ChevronRight, Download } from "lucide-react"

import { useAuth } from "@/app/auth"
import { hubSections } from "@/app/nav"
import { useApi } from "@/lib/query"
import { Answer } from "@/ui/answer"
import { Button } from "@/ui/button"
import { PageHeader } from "@/ui/page-header"
import { Rows, Section } from "@/ui/section"
import { Meta } from "@/ui/text"
import { type Brief, change, n, papersUrl, rupees } from "@/pages/principal-parts"

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
        sub="What the incentive scheme has spent against the budget, the rules behind an amount, and the monthly statements."
      />

      <Answer
        items={[
          {
            value: c ? (c.allocated == null ? "Not set" : rupees(c.allocated)) : null,
            label: fy ? (c?.allocated == null ? `budget for FY ${fy}: nothing to weigh spending against` : `budget for FY ${fy}`) : "budget",
            to: "/budget",
            tone: c && c.allocated == null ? "caution" : "neutral",
          },
          { value: c ? (c.spent ? rupees(c.spent) : "None") : null, label: c?.spent ? "paid so far this year" : "paid yet this year", to: "/budget" },
          {
            value: c ? (c.committed ? rupees(c.committed) : "None") : null,
            label: c?.committed ? "approved or authorised, not yet paid" : "approved and waiting to be paid",
            to: "/budget",
          },
          ...(c && c.remaining != null
            ? [
                {
                  value: rupees(Math.abs(c.remaining)),
                  label: c.remaining < 0 ? "over the budget" : "left this year",
                  to: "/budget",
                  tone: (c.remaining < 0 ? "critical" : "positive") as "critical" | "positive",
                },
              ]
            : []),
        ]}
      />

      <div className="grid grid-cols-[minmax(0,1fr)] gap-x-12 gap-y-10 lg:grid-cols-2">
        {sections.map((s) => (
          <Section key={s.title} title={s.title} sub={s.blurb}>
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
        sub="The questions the council, NAAC and NIRF ask, each with today's answer and the proof one click away."
      />

      <Answer
        items={[
          {
            value: t ? n(t.papers) : null,
            label: b ? `papers in ${b.year}` : "papers",
            to: papersUrl({ year: b?.year }),
          },
          { value: t ? n(t.per_teacher) : null, label: "papers per teacher", to: "/reports/brief#departments" },
          {
            value: b ? b.push.length : null,
            label: "departments need a push",
            zero: "No department needs a push",
            to: "/reports/departments",
            tone: b && b.push.length > 0 ? "caution" : "neutral",
          },
          {
            value: toSettle,
            label: "things to settle before the council pack goes",
            zero: "The council pack is ready",
            to: "/reports/brief#pack",
            tone: toSettle ? "caution" : "neutral",
          },
        ]}
      />

      <Section title="Your questions">
        <Rows>
          <Question
            question="Are we better than last year, and where?"
            to="/reports/brief"
            answer={
              t && b
                ? `${n(t.papers)} papers in ${b.year}, ${change(t.papers, t.papers_prev)}; ${n(t.per_teacher)} per teacher, ${change(t.per_teacher, t.per_teacher_prev)}.`
                : "Loading the year."
            }
          />
          <Question
            question="Which departments need a push?"
            to="/reports/departments"
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
            to="/reports/brief"
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
            action={
              <Button size="sm" asChild className="mt-0.5 shrink-0 max-sm:hidden">
                <a href={`/api/reports/brief/export?fmt=pdf${b ? `&year=${b.year}` : ""}`} download>
                  <Download />
                  Council PDF
                </a>
              </Button>
            }
          />
          <Question
            question="Where do we stand for NAAC and NIRF?"
            to="/accreditation"
            answer={
              b
                ? `${n(b.naac_331.per_teacher)} papers per teacher over five years, band ${b.naac_331.band} of 4 on NAAC 3.3.1 (the ceiling until UGC-CARE is checked).`
                : "Loading the figures."
            }
          />
          <Question
            question="What did the scheme cost, against the budget?"
            to="/budget"
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
            answer={
              all.data
                ? `${n(all.data.total)} papers on record. Filter by year, department or journal quartile, then download.`
                : "Loading the papers."
            }
          />
        </Rows>
      </Section>

      <div className="grid grid-cols-[minmax(0,1fr)] gap-x-12 gap-y-10 lg:grid-cols-2">
        <Section title="Look something up" sub="A paper, a journal, a person or a past claim.">
          <Rows>
            <Tool to="/search" label="Search" purpose="Papers, journals and colleagues, inside the college and outside it." />
            <Tool to="/journals" label="Journals" purpose="A journal's quartile, SNIP and standing, and the college's history with it." />
            <Tool to="/archive" label="Past claims" purpose="Every claim ever filed, imported ones included." />
            <Tool to="/publications" label="Claims by stage" purpose="Every claim the scheme has handled, filtered by department, journal and stage." />
          </Rows>
        </Section>
        <Section title="Make your own" sub="When no page above answers what you were asked.">
          <Rows>
            <Tool to="/reports" label="Analysis" purpose="Output by department, journal, quartile and year." />
            <Tool to="/reports/build" label="Build a report" purpose="Choose what to count and how to group it, then download Excel or PDF." />
          </Rows>
        </Section>
      </div>
    </div>
  )
}
