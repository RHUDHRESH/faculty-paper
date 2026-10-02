import { Link } from "react-router-dom"
import { FileText } from "lucide-react"

import { cn } from "@/lib/cn"
import { Button } from "@/ui/button"
import { Avatar, initialsOf } from "@/ui/person"
import { Rows } from "@/ui/section"
import { InlineError, Skeleton } from "@/ui/state"
import { SectionTitle } from "@/ui/text"
import { FiveYears } from "@/pages/principal/five-years"
import { type Brief, change, columnsFor, deptUrl, headLabel, n, NoHeads } from "@/pages/principal-parts"

/** "1 October", from the date the server counted to. */
export function asOf(iso: string | undefined): string {
  if (!iso) return ""
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString("en-IN", { day: "numeric", month: "long" })
}

/** What each unsettled check is, in a few words, for a line that has no room for its sentence. */
const SHORT: Record<string, string> = {
  partial: "a part year",
  budget: "no budget set",
  department: "papers with no department",
  quartile: "missing quartiles",
  ugc: "the UGC-CARE list not loaded",
}

/** The council pack: one PDF holding the year, the departments and the money. */
export const packHref = (year?: number) => `/api/reports/brief/export?fmt=pdf${year ? `&year=${year}` : ""}`

/**
 * The year, in the margin of the Principal's Home: one finding, five honest
 * columns, the departments to call and what is left before the council pack
 * goes. It is the answer to "are we better than last year, and where?" with
 * no click (docs/ux/27, T4), and each part opens the page that holds the proof.
 *
 * A running year is the hollow column and is never compared: the finding is
 * always about the last full year, and a note says where the running one is.
 */
export function YearColumn({
  b,
  isError,
  onRetry,
  className,
}: {
  b: Brief | undefined
  isError?: boolean
  onRetry?: () => void
  className?: string
}) {
  if (isError) return <InlineError message="Could not load the year. Nothing has changed." onRetry={onRetry} />
  if (!b) {
    return (
      <div className={cn("space-y-4", className)} aria-busy>
        <Skeleton className="h-6 w-32" />
        <Skeleton className="h-12 w-28" />
        <Skeleton className="h-28 w-full" />
      </div>
    )
  }
  const t = b.totals
  const toSettle = b.pack.filter((c) => !c.ok).length
  const verdict =
    b.partial || t.change == null
      ? { value: n(t.papers), note: b.partial ? `papers so far in ${b.year}. A part year is not compared with a whole one.` : `papers in ${b.year}.`, tone: "text-fg" }
      : {
          value: `${t.change > 0 ? "+" : t.change < 0 ? "−" : ""}${Math.abs(t.change)}%`,
          note: `papers in ${b.year} against ${b.year - 1}: ${n(t.papers)} against ${n(t.papers_prev)}.`,
          tone: t.change > 0 ? "text-positive" : t.change < 0 ? "text-caution" : "text-fg",
        }
  const running = b.running

  return (
    <div className={cn("flex flex-col gap-7", className)}>
      <section aria-labelledby="year-h" className="space-y-3">
        <div className="flex items-baseline justify-between gap-3">
          <SectionTitle>
            <span id="year-h">The year, {b.year}</span>
          </SectionTitle>
          <Button kind="default" size="sm" asChild>
            <Link to="/reports/brief">Open the brief</Link>
          </Button>
        </div>
        <Link to={`/reports/papers?year=${b.year}`} className="block rounded-control hover:[&_.figure]:underline hover:[&_.figure]:underline-offset-4">
          <span className={cn("figure block text-figure", verdict.tone)}>{verdict.value}</span>
          <span className="mt-1.5 block text-sm text-fg-muted">{verdict.note}</span>
        </Link>
        {t.per_teacher != null && (
          <p className="text-sm text-fg-muted">
            {n(t.per_teacher)} papers per teacher
            {!b.partial && t.per_teacher_prev != null ? `, ${change(t.per_teacher, t.per_teacher_prev, "", String(b.year - 1))}` : ""}.
          </p>
        )}
      </section>

      <FiveYears
        title="Papers published, five years"
        columns={columnsFor(b, "papers")}
        current={b.year}
        height={92}
        caption={
          running ? (
            <>
              {running.year} is to date: {n(running.papers)} papers by {asOf(running.as_of)}. It is not compared with a whole year.
            </>
          ) : undefined
        }
      />

      <section aria-labelledby="call-h" className="space-y-1">
        <div className="flex items-baseline justify-between gap-3">
          <SectionTitle>
            <span id="call-h">Call about</span>
          </SectionTitle>
          <Button kind="default" size="sm" asChild>
            <Link to="/reports/departments">All departments</Link>
          </Button>
        </div>
        {b.push.length === 0 ? (
          <p className="text-sm text-fg-muted">No department stands out as behind in {b.year}.</p>
        ) : (
          <Rows>
            {b.push.slice(0, 3).map((d) => (
              <li key={d.department} className="relative flex items-start gap-3 py-2.5">
                {d.head ? (
                  <Avatar
                    size="sm"
                    person={{ name: d.head.name, initials: d.head.initials ?? initialsOf(d.head.name), photo_url: d.head.photo_url ?? null }}
                  />
                ) : (
                  <span aria-hidden className="size-8 shrink-0" />
                )}
                <div className="min-w-0 flex-1">
                  <Link
                    to={deptUrl(d.department, b.year)}
                    className="block truncate text-base font-medium after:absolute after:inset-0 after:content-['']"
                  >
                    {d.department}
                  </Link>
                  <p className="text-sm text-fg-muted">{d.reasons[0]}.</p>
                  {d.head && <p className="text-sm text-fg-subtle">{headLabel(d.head)}</p>}
                </div>
              </li>
            ))}
          </Rows>
        )}
        <NoHeads depts={b.push.slice(0, 3)} />
      </section>

      <section aria-labelledby="pack-h" className="space-y-3">
        <SectionTitle>
          <span id="pack-h">Council pack</span>
        </SectionTitle>
        <p className="text-sm text-fg-muted" role="status">
          {toSettle === 0 ? (
            "Nothing to settle. It is ready."
          ) : (
            <>
              <Link to="/reports/brief#pack" className="font-medium text-fg underline underline-offset-4">
                {toSettle} {toSettle === 1 ? "thing" : "things"} to settle
              </Link>{" "}
              before it goes: {b.pack.filter((c) => !c.ok).map((c) => SHORT[c.key] ?? c.label).slice(0, 2).join(", ")}
              {toSettle > 2 ? " and more" : ""}.
            </>
          )}
        </p>
        <Button kind="default" asChild>
          <a href={packHref(b.year)} download>
            <FileText />
            Download the council pack
          </a>
        </Button>
      </section>
    </div>
  )
}
