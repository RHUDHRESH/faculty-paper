import { useMemo } from "react"
import { Link, useSearchParams } from "react-router-dom"
import { CheckCircle2, RotateCw, ShieldAlert } from "lucide-react"

import { can, useAuth } from "@/app/auth"
import { cn } from "@/lib/cn"
import { useApi } from "@/lib/query"
import { Answer } from "@/ui/answer"
import { Button } from "@/ui/button"
import { PageHeader } from "@/ui/page-header"
import { money, stageOf } from "@/ui/paper"
import { Avatar } from "@/ui/person"
import { Details, Rows, Section } from "@/ui/section"
import { EmptyState, ErrorState, SkeletonRows } from "@/ui/state"
import { Table, type Column } from "@/ui/table"
import { Ago } from "@/ui/when"

import { ClaimNo, count, FaceName, type Face, ImportedNote, isImported, plural } from "./admin-b-parts"

/**
 * Faults: what is stuck or wrong right now, and where to fix it.
 *
 * The top answers "is anything broken?" in three figures, each a link to the
 * list behind it. The work is the checks that found something, most urgent
 * first, each with the one button that goes to the fix and a way to see every
 * claim or person behind the count (not a sample). Checks that found nothing
 * are one line at the foot, so a clean page reads as clean.
 */

type Severity = "critical" | "warning" | "info"

type Fault = {
  key: string
  title: string
  detail: string
  count: number
  severity: Severity
  to: string | null
  sample: string[]
  people?: (Face & { email?: string })[]
}

type Group = { key: string; title: string; blurb: string; faults: Fault[] }

type Payload = { groups: Group[]; total: number; urgent: number; checked_at: string }

/** The person chips a fault shows: a face and a name that open the profile. */
export function FaultPeople({ people }: { people: (Face & { email?: string })[] }) {
  return (
    <>
      {people.map((p) => (
        <Link
          key={p.user_id}
          to={`/u/${p.user_id}`}
          title={p.email}
          className="inline-flex items-center gap-1.5 rounded-full py-0.5 pr-2 underline-offset-2 hover:underline"
        >
          <Avatar
            person={{ name: p.name, initials: p.initials ?? "", photo_url: p.photo_url ?? null }}
            size="xs"
          />
          <span className="text-fg">{p.name}</span>
        </Link>
      ))}
    </>
  )
}

const SEVERITY_WORD: Record<Severity, string> = {
  critical: "Urgent",
  warning: "Look at",
  info: "For information",
}
const SEVERITY_TEXT: Record<Severity, string> = {
  critical: "text-critical",
  warning: "text-caution",
  info: "text-fg-muted",
}
const SEVERITY_RANK: Record<Severity, number> = { critical: 0, warning: 1, info: 2 }

/** The one button on a fault, said as what it does. */
const ACTION: Record<string, (n: number) => string> = {
  paid_zero: (n) => `Fix ${plural(n, "amount")}`,
  no_quartile: (n) => `Set ${plural(n, "quartile")}`,
  stale_submitted: () => "Open the clearing desk",
  stale_cleared: () => "Open payments",
  legacy_status: () => "Open the clearing desk",
  unverified: () => "Open the clearing desk",
  no_snip: () => "Open the clearing desk",
  duplicate_override: () => "Review duplicates",
  no_ledger: () => "See them in the ledger",
  voided: () => "See them in the ledger",
  no_scopus: () => "Open Faculty",
  no_biometric: () => "Open Faculty",
  no_department: () => "Open Faculty",
  former_staff: () => "Open Faculty",
}

// Older servers named the screens by their old paths.
const LEGACY: Record<string, string> = {
  "/admin/users": "/people",
  "/admin/clearing": "/clearing",
  "/finance": "/payments",
}

function when(iso: string): string {
  return new Date(iso).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })
}

export function Faults() {
  const { me } = useAuth()
  const isOffice = can(me?.role).manageUsers
  const [params] = useSearchParams()
  const show = params.get("show") === "urgent" ? "urgent" : params.get("show") === "other" ? "other" : "all"
  const { data, isLoading, isError, error, refetch, isFetching } = useApi<Payload>(
    ["admin-faults"],
    "/api/admin/faults"
  )

  const { active, clear, other } = useMemo(() => {
    const all = (data?.groups ?? []).flatMap((g) => g.faults)
    const found = all
      .filter((f) => f.count > 0)
      .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || b.count - a.count)
    return {
      active: found,
      clear: all.filter((f) => f.count === 0),
      other: found.filter((f) => f.severity !== "critical").reduce((s, f) => s + f.count, 0),
    }
  }, [data])

  const listed = active.filter((f) =>
    show === "urgent" ? f.severity === "critical" : show === "other" ? f.severity !== "critical" : true
  )
  const anyImported = active.some((f) => f.sample.some(isImported))

  return (
    <div className="page space-y-10">
      <PageHeader
        title="Faults"
        sub="What is stuck or wrong right now."
        spot="spot-audit"
        action={
          <Button kind="primary" onClick={() => refetch()} disabled={isFetching}>
            <RotateCw aria-hidden className={cn(isFetching && "animate-spin")} />
            Check again
          </Button>
        }
      />

      {isLoading ? (
        <SkeletonRows rows={6} rowHeight={64} />
      ) : isError ? (
        error?.status === 403 ? (
          <ErrorState
            art="closed-gate"
            title="Not open to this account"
            message="Open to the research office, system admins and the Principal."
          />
        ) : (
          <ErrorState
            title="Could not run the checks"
            message="The server did not answer."
            onRetry={() => refetch()}
          />
        )
      ) : !data ? null : data.total === 0 ? (
        <EmptyState
          art="empty-queue"
          icon={CheckCircle2}
          title="Nothing is stuck or wrong"
          message={`All ${clear.length} checks came back clean at ${when(data.checked_at)}.`}
        />
      ) : (
        <>
          <section aria-label="The answer" className="space-y-3">
            <Answer
              items={[
                {
                  value: data.urgent,
                  label: "Need action now",
                  to: "?show=urgent",
                  tone: "critical",
                  zero: "Nothing urgent",
                },
                {
                  value: other,
                  label: "To look at",
                  to: "?show=other",
                  tone: "caution",
                  zero: "Nothing else to look at",
                },
                { value: clear.length, label: "Checks that found nothing", to: "#clear", tone: "positive" },
              ]}
            />
            <p className="text-sm text-fg-muted">
              Checked <Ago iso={data.checked_at} />.
            </p>
          </section>

          <Section
            title={show === "urgent" ? "Needs action now" : show === "other" ? "To look at" : "What needs fixing"}
            action={
              show !== "all" ? (
                <Button kind="default" size="sm" asChild>
                  <Link to="/faults">Show all {count(active.length)} checks</Link>
                </Button>
              ) : undefined
            }
            className="space-y-3"
          >
            <ImportedNote show={anyImported} />
            {listed.length === 0 ? (
              <p className="flex flex-wrap items-center justify-center gap-3 rounded-panel bg-sunken px-4 py-6 text-sm text-fg-muted">
                Nothing in this list.
                <Button kind="default" size="sm" asChild>
                  <Link to="/faults">Show all {count(active.length)} checks</Link>
                </Button>
              </p>
            ) : (
              <Rows>
                {listed.map((f) => (
                  <FaultRow key={f.key} fault={f} isOffice={isOffice} />
                ))}
              </Rows>
            )}
          </Section>

          <div id="clear">
            <Details label="the checks that found nothing" count={clear.length}>
              <Rows>
                {clear.map((f) => (
                  <li key={f.key} className="flex flex-wrap items-baseline justify-between gap-x-4 py-2.5 text-sm">
                    <span>{f.title}</span>
                  </li>
                ))}
              </Rows>
            </Details>
          </div>
        </>
      )}
    </div>
  )
}

function FaultRow({ fault, isOffice }: { fault: Fault; isOffice: boolean }) {
  const to = fault.to ? (LEGACY[fault.to] ?? fault.to) : null
  const action = ACTION[fault.key]?.(fault.count)
  return (
    <li className="py-4">
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <div className="min-w-0 flex-1 basis-72">
          <p className="flex flex-wrap items-baseline gap-x-2">
            <span className="font-medium">{fault.title}</span>
            <span className={cn("inline-flex items-center gap-1 text-xs font-medium", SEVERITY_TEXT[fault.severity])}>
              {fault.severity === "critical" && <ShieldAlert aria-hidden className="size-3.5" />}
              {SEVERITY_WORD[fault.severity]}
            </span>
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-3">
          <span className={cn("figure text-figure tabular", SEVERITY_TEXT[fault.severity])}>{count(fault.count)}</span>
          {isOffice && to && action && (
            <Button kind="default" size="sm" asChild>
              <Link to={to}>{action}</Link>
            </Button>
          )}
        </div>
      </div>
      <Details label="the whole list" count={fault.count} className="mt-1">
        <p className="mb-2 max-w-prose text-sm text-fg-muted">{fault.detail}</p>
        <FaultItems faultKey={fault.key} />
      </Details>
    </li>
  )
}

type ClaimItem = {
  id: string
  ticket_number: string | null
  title: string | null
  journal: string | null
  owner: Face
  status: string
  amount: number | null
  waiting_days: number | null
  month_paid: string | null
}
type PersonItem = { user_id: string; name: string; email: string; department: string | null; initials?: string; photo_url?: string | null }
type Items =
  | { key: string; kind: "claims"; total: number; items: ClaimItem[] }
  | { key: string; kind: "people"; total: number; items: PersonItem[] }

function FaultItems({ faultKey }: { faultKey: string }) {
  const { data, isLoading, isError, refetch } = useApi<Items>(
    ["admin-faults", faultKey],
    `/api/admin/faults/${faultKey}`
  )
  if (isLoading) return <SkeletonRows rows={3} rowHeight={40} />
  if (isError || !data)
    return (
      <p className="text-sm text-fg-muted">
        The list could not be loaded.{" "}
        <Button kind="default" size="sm" onClick={() => refetch()}>
          Try again
        </Button>
      </p>
    )
  return (
    <div className="space-y-2">
      {data.kind === "claims" ? <ClaimList items={data.items} /> : <PeopleList items={data.items} />}
      {data.total > data.items.length && (
        <p className="text-sm text-fg-muted">
          Showing the first {count(data.items.length)} of {count(data.total)}.
        </p>
      )}
    </div>
  )
}

function ClaimList({ items }: { items: ClaimItem[] }) {
  const cols: Column<ClaimItem>[] = [
    {
      key: "no",
      header: "Claim no.",
      cell: (c) => (
        <Link to={`/papers/${c.id}`} className="underline-offset-2 hover:underline">
          <ClaimNo no={c.ticket_number} />
        </Link>
      ),
    },
    { key: "paper", header: "Paper", empty: "No title recorded", cell: (c) => (c.title && c.title.trim() !== "-" ? <span className="line-clamp-2">{c.title}</span> : null) },
    { key: "who", header: "Faculty", cell: (c) => <FaceName person={c.owner} /> },
    {
      key: "stage",
      header: "Where it stands",
      cell: (c) => (
        <span>
          {stageOf(c.status).label}
          {c.waiting_days != null && <span className="text-fg-muted"> · {plural(c.waiting_days, "day")}</span>}
        </span>
      ),
    },
    { key: "amount", header: "Amount", align: "right", cell: (c) => (c.amount == null ? null : money(c.amount)) },
  ]
  return <Table rows={items} columns={cols} getKey={(c) => c.id} caption="Claims behind this check" maxHeight="26rem" />
}

function PeopleList({ items }: { items: PersonItem[] }) {
  const cols: Column<PersonItem>[] = [
    {
      key: "who",
      header: "Person",
      cell: (p) => <FaceName person={{ user_id: p.user_id, name: p.name, initials: p.initials, photo_url: p.photo_url }} />,
    },
    { key: "dept", header: "Department", cell: (p) => p.department },
    { key: "email", header: "Email", cell: (p) => <span className="break-all">{p.email}</span> },
  ]
  return <Table rows={items} columns={cols} getKey={(p) => p.user_id} caption="People behind this check" maxHeight="26rem" />
}
