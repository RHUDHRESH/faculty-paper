import { Link } from "react-router-dom"
import { FileText } from "lucide-react"

import { useAuth } from "@/app/auth"
import { HOME_DATA, homeTrack } from "@/app/home-data"
import { deptLabel } from "@/lib/names"
import { useApi } from "@/lib/query"
import { Answer } from "@/ui/answer"
import { Button } from "@/ui/button"
import { PageHeader } from "@/ui/page-header"
import { money } from "@/ui/paper"
import { reviewLink, waitingLabel, waitTone } from "@/ui/queue"
import { Section } from "@/ui/section"
import { InlineError, SkeletonRows } from "@/ui/state"
import { Table, type Column } from "@/ui/table"
import type { QueueClaim, QueuePayload } from "@/pages/approvals-actions"
import { YourPapers } from "@/pages/home-staff"
import { deptUrl, headLabel, n, NoHeads, type Brief } from "@/pages/principal-parts"
import { isReady } from "@/pages/principal/ready"
import { useApprovals } from "@/pages/principal/use-approvals"
import { packHref } from "@/pages/principal/year-column"
import type { TrackPayload } from "@/pages/track-data"

/**
 * The Principal's Home.
 *
 * She opens it for two things. The desk: is there anything for me to approve,
 * and is any of it wrong? One table answers, and the primary button approves
 * what is ready, in place. And the year: are we better than last year, and
 * where? That is one number, and the departments to call about, under it.
 *
 * The pipeline below her is one line and a link to Track: it is not hers to
 * work. Her own papers stay last; another officer decides them.
 */

const SHOWN = 10

/** The year in one figure: the change on last year, or the count when a part year cannot be compared. */
function yearFigure(b: Brief) {
  const t = b.totals
  if (b.partial || t.change == null) return { value: n(t.papers), label: `papers ${b.partial ? "so far " : ""}in ${b.year}`, tone: "neutral" as const }
  const sign = t.change > 0 ? "+" : t.change < 0 ? "−" : ""
  return {
    value: `${sign}${Math.abs(t.change)}%`,
    label: `papers in ${b.year} against ${b.year - 1}: ${n(t.papers)} against ${n(t.papers_prev)}`,
    tone: t.change > 0 ? ("positive" as const) : t.change < 0 ? ("caution" as const) : ("neutral" as const),
  }
}

export function PrincipalHome() {
  const { me } = useAuth()
  const queue = useApi<QueuePayload>(HOME_DATA.principalQueue.key, HOME_DATA.principalQueue.path)
  const brief = useApi<Brief>(HOME_DATA.principalBrief.key, HOME_DATA.principalBrief.path)
  const mine = homeTrack(me?.role)
  const track = useApi<TrackPayload>(mine.key, mine.path)

  const rows = queue.data?.results ?? []
  const ready = rows.filter(isReady)
  const ap = useApprovals({ rows })

  const waiting = queue.data ? (queue.data.totals?.count ?? rows.length) : null
  const amount = queue.data?.totals?.amount ?? 0
  const longest = queue.data?.totals?.longest_wait_days ?? null
  const b = brief.data
  const late = track.data ? track.data.stages.reduce((sum, s) => sum + (s.ageing?.older ?? 0), 0) : null
  const year = b ? yearFigure(b) : null

  const action =
    waiting != null && waiting > 0 ? (
      ready.length > 0 ? (
        <Button kind="primary" onClick={() => ap.approveBatch(ready)} disabled={ap.busy}>
          Approve the {ready.length} ready
        </Button>
      ) : (
        <Button kind="primary" asChild>
          <Link to="/approvals">Open Approvals</Link>
        </Button>
      )
    ) : undefined

  const columns: Column<QueueClaim>[] = [
    {
      key: "owner",
      header: "Claimant",
      exportValue: (c) => [c.owner_name, c.owner_department].filter(Boolean).join(", "),
      cell: (c) => (
        <>
          <span className="font-medium">{c.owner_name}</span>
          {c.owner_department && <span className="block text-sm text-fg-muted">{deptLabel(c.owner_department)}</span>}
        </>
      ),
    },
    {
      key: "paper",
      header: "Paper",
      truncate: true,
      exportValue: (c) => c.paper_title,
      cell: (c) => c.paper_title,
    },
    {
      key: "amount",
      header: "Amount",
      align: "right",
      exportKind: "money",
      exportValue: (c) => c.remuneration,
      cell: (c) => (c.remuneration != null && !c.calc_error ? money(c.remuneration) : <span className="text-caution">No amount</span>),
    },
    {
      key: "wait",
      header: "Waiting",
      exportValue: (c) => waitingLabel(c.waiting_days),
      cell: (c) => {
        const tone = (c.waiting_days ?? 0) > 14 ? waitTone(c.waiting_days) : ""
        return <span className={tone ? `font-medium ${tone}` : "text-fg-muted"}>{waitingLabel(c.waiting_days)}</span>
      },
    },
    {
      key: "act",
      header: "Action",
      label: "Approve or review",
      cell: (c) => {
        if (me?.id && c.owner_id === me.id) return null
        const href = reviewLink(c.id, "approvals")
        return isReady(c) && c.remuneration != null && !c.calc_error ? (
          <Button onClick={() => ap.approveOne(c)} aria-label={`Approve: ${c.paper_title}`}>
            Approve
          </Button>
        ) : (
          <Button asChild>
            <Link to={href}>Review</Link>
          </Button>
        )
      },
    },
  ]

  const toSettle = b ? b.pack.filter((c) => !c.ok).length : 0

  return (
    <div className="page space-y-8">
      <PageHeader title="Home" sub="Claims waiting for your approval and how the year is going." action={action} />

      <Answer
        items={[
          {
            value: waiting,
            label: "claims waiting for you",
            zero: "Nothing is waiting for you",
            to: "/approvals",
            tone: waiting ? "caution" : "neutral",
          },
          {
            value: waiting == null ? null : money(amount),
            label: "to approve",
            to: "/approvals",
          },
          {
            value: waiting == null ? null : longest == null ? "None" : waitingLabel(longest),
            label: "longest wait",
            to: "/approvals",
            tone: longest != null && longest > 30 ? "critical" : longest != null && longest > 14 ? "caution" : "neutral",
          },
          {
            value: year ? year.value : brief.isError ? "Not available" : null,
            label: year ? year.label : "the year",
            to: b ? `/reports/papers?year=${b.year}` : "/reports/brief",
            tone: year ? year.tone : "neutral",
          },
        ]}
      />

      <Section title="Waiting for you">
        {queue.isError ? (
          <InlineError message="Could not load the approval queue. Nothing has changed." onRetry={() => queue.refetch()} />
        ) : queue.isLoading ? (
          <SkeletonRows rows={4} rowHeight={56} />
        ) : (
          <>
            <Table
              rows={rows.slice(0, SHOWN)}
              columns={columns}
              getKey={(c) => c.id}
              rowLink={(c) => reviewLink(c.id, "approvals")}
              tools={{ id: "principal-home-approvals", title: "Claims waiting for the Principal" }}
              empty={{ title: "Nothing is waiting for you", message: "New claims appear here as soon as the research office clears them." }}
            />
            <p className="mt-2 text-sm">
              <Link to="/approvals" className="text-accent underline-offset-4 hover:underline">
                {(waiting ?? rows.length) > Math.min(rows.length, SHOWN)
                  ? `View all ${n(waiting ?? rows.length)} in Approvals`
                  : "View in Approvals"}
              </Link>
            </p>
          </>
        )}
        {late != null && (
          <p className="mt-3 text-sm text-fg-muted" role="status">
            {late > 0
              ? `${n(late)} ${late === 1 ? "claim has" : "claims have"} been in one place for over a month. `
              : "Nothing has been in one place for over a month. "}
            <Link to="/track" className="text-accent underline-offset-4 hover:underline">
              Open Track
            </Link>
          </p>
        )}
      </Section>

      <Section title="Departments to call about">
        {brief.isError ? (
          <InlineError message="Could not load the year. Nothing has changed." onRetry={() => brief.refetch()} />
        ) : !b ? (
          <SkeletonRows rows={2} rowHeight={48} />
        ) : (
          <>
            <Table
              rows={b.push.slice(0, 3)}
              columns={
                [
                  {
                    key: "dept",
                    header: "Department",
                    exportValue: (d) => deptLabel(d.department),
                    cell: (d) => (
                      <Link to={deptUrl(d.department, b.year)} className="font-medium text-accent underline-offset-4 hover:underline">
                        {deptLabel(d.department)}
                      </Link>
                    ),
                  },
                  { key: "why", header: "Why", exportValue: (d) => d.reasons[0], cell: (d) => `${d.reasons[0]}.` },
                  {
                    key: "head",
                    header: "Head",
                    empty: "No head set",
                    exportValue: (d) => (d.head ? headLabel(d.head) : null),
                    cell: (d) => (d.head ? headLabel(d.head) : null),
                  },
                ] as Column<Brief["push"][number]>[]
              }
              getKey={(d) => d.department}
              tools={{ id: "principal-home-departments", title: `Departments to call about, ${b.year}` }}
              empty={{ title: `No department stands out as behind in ${b.year}`, message: "Nothing to call about." }}
            />
            <NoHeads depts={b.push.slice(0, 3)} />
            <p className="mt-2 text-sm">
              <Link to="/reports/departments" className="text-accent underline-offset-4 hover:underline">
                View all departments
              </Link>
              {" · "}
              <Link to="/reports/brief" className="text-accent underline-offset-4 hover:underline">
                Open the brief
              </Link>
            </p>
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <Button kind="quiet" asChild>
                <a href={packHref(b.year)} download>
                  <FileText />
                  Download the council pack
                </a>
              </Button>
              <span className="text-sm text-fg-muted" role="status">
                {toSettle === 0 ? (
                  "Nothing to settle. It is ready."
                ) : (
                  <Link to="/reports/brief#pack" className="text-accent underline-offset-4 hover:underline">
                    {toSettle} {toSettle === 1 ? "thing" : "things"} to settle before it goes
                  </Link>
                )}
              </span>
            </div>
          </>
        )}
      </Section>

      <YourPapers />

      {ap.node}
    </div>
  )
}
