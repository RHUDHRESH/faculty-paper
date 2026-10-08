import { useSearchParams } from "react-router-dom"

import { can, useAuth } from "@/app/auth"
import { useApi } from "@/lib/query"
import { MonthlyReport } from "@/pages/cell/monthly-report"
import {
  Ageing,
  Assign,
  ResearchPanel,
  Stuck,
  Summary,
  Throughput,
  Workload,
  type Overview,
} from "@/pages/coordination-parts"
import { PageHeader } from "@/ui/page-header"
import { Tabs } from "@/ui/tabs"
import { ErrorState, NotOpen, SkeletonRows } from "@/ui/state"

/**
 * Coordination: what the research coordinator, the research cell and the
 * super admin need to run the first desk of the chain (docs/ux/21 section D).
 *
 * Three tabs, three questions:
 *   Desk                  is the desk on time, and who holds what? The answer
 *                         first, then handing claims out, then the pace.
 *   Monthly report        what do I tell the Principal?
 *   Research coordination are the scheme rules being met? (research faculty,
 *                         final-year project teams, the journal watch-list)
 *
 * Counts and names only. No flags appear here.
 */

const TABS = [
  { id: "desk", label: "Desk" },
  { id: "report", label: "Monthly report" },
  { id: "research", label: "Research coordination" },
] as const
type Tab = (typeof TABS)[number]["id"]

const SUB: Record<Tab, string> = {
  desk: "Is the desk on time, and who holds what? Give claims out, and see how fast the research office is moving.",
  report: "What the desk decided in a month, and how fast. For the Principal and for NAAC.",
  research: "The rules the coordinator looks after: research faculty, final-year project teams and the journal watch-list.",
}

export function Coordination() {
  const { me } = useAuth()
  const allowed = can(me?.role).clear
  const [params, setParams] = useSearchParams()
  const raw = params.get("tab")
  const tab: Tab = TABS.some((t) => t.id === raw) ? (raw as Tab) : "desk"

  if (!allowed) {
    return (
      <div className="page py-8">
        <NotOpen message="Coordination is for the research coordinator, the research office and the super admin." />
      </div>
    )
  }

  return (
    <div className="page space-y-8">
      <PageHeader title="Coordination" sub={SUB[tab]} />

      <Tabs
        label="Coordination"
        idPrefix="coord"
        value={tab}
        onChange={(id) => setParams(id === "desk" ? {} : { tab: id }, { replace: true })}
        tabs={TABS.map((t) => ({ id: t.id, label: t.label }))}
      />

      <div role="tabpanel" id={`coord-${tab}`} aria-labelledby={`coord-tab-${tab}`}>
        {tab === "desk" && <DeskTab />}
        {tab === "report" && <MonthlyReport />}
        {tab === "research" && <ResearchPanel />}
      </div>
    </div>
  )
}

function DeskTab() {
  const q = useApi<Overview>(["coordination", "overview"], "/api/coordination/overview")
  if (q.isLoading) return <SkeletonRows rows={6} rowHeight={56} />
  if (q.isError || !q.data) {
    return (
      <ErrorState
        title="Could not load the desk"
        message="The server did not answer. Nothing has been changed."
        onRetry={() => q.refetch()}
      />
    )
  }
  const o = q.data
  return (
    <div className="space-y-10">
      <Summary o={o} />
      {/* The work first: handing claims out. The pace and the ageing follow. */}
      <Assign slaDays={o.sla_days} />
      <div className="grid grid-cols-[minmax(0,1fr)] gap-x-12 gap-y-10 lg:grid-cols-2">
        <Workload o={o} />
        <Ageing o={o} />
      </div>
      <div className="grid grid-cols-[minmax(0,1fr)] gap-x-12 gap-y-10 lg:grid-cols-2">
        <Throughput o={o} />
        <Stuck o={o} />
      </div>
    </div>
  )
}
