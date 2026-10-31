import { useEffect, useMemo, useState } from "react"
import { Link, useSearchParams } from "react-router-dom"
import { CircleCheck } from "lucide-react"

import { can, useAuth } from "@/app/auth"
import { reviewsFlags } from "@/app/nav"
import { cn } from "@/lib/cn"
import { useApi, useApiMutation } from "@/lib/query"
import { Button } from "@/ui/button"
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/ui/dialog"
import { Field, Input, NumberInput, Select, Textarea } from "@/ui/field"
import { filterBar } from "@/ui/filter-bar"
import { Table, type Column } from "@/ui/table"
import { PageHeader } from "@/ui/page-header"
import { Answer } from "@/ui/answer"
import { ChangeHistory } from "./admin-b-parts"
import { money } from "@/ui/paper"
import { Pagination } from "@/ui/pagination"
import { Avatar, initialsOf } from "@/ui/person"
import { useQueueKeys } from "@/ui/queue-keys"
import { Callout, ErrorState, NotOpen, SkeletonRows } from "@/ui/state"
import { ColumnLabel, Meta } from "@/ui/text"
import { toast } from "@/ui/toast"
import { unshout } from "@/lib/names"

/**
 * What the sweep over already-paid history found, and what somebody decided
 * about it.
 *
 * A queue, not a report: every group is a judgement. Open groups are worked
 * one at a time (j/k to move, a to confirm, r to rule out) against a
 * side-by-side of the payments with the differences marked; decided groups
 * drop into a quiet history.
 *
 * The two kinds are kept apart. Same person paid twice is nearly always
 * wrong, and the sum at issue is every payment but the largest. One paper,
 * several people is usually right (co-authors are each paid), so that tab
 * shows no "at issue" figure and does not lead with Confirm.
 *
 * Not shown to the Director or Finance (the college's rule; the server
 * refuses them too).
 */

const PAGE_SIZE = 25
const DECIDED = "CONFIRMED,DISMISSED,RECOVERED"

type Kind = "SAME_PERSON" | "CROSS_PERSON"
type FindingStatus = "OPEN" | "CONFIRMED" | "DISMISSED" | "RECOVERED"

/** One payment inside a group, as the sweep recorded it. */
type Member = {
  /** "claim" is a ticket in this system; "prior" an imported ERP row. */
  source: string
  id: string
  reference: string | null
  title: string | null
  doi: string | null
  amount: number
  /** "YYYY-MM", or null where the record carried no date. */
  when: string | null
  person: string | null
  department: string | null
  photo_url?: string | null
  /** False where the ledger row names no month (the import filled one in). */
  month_recorded?: boolean
}

type Finding = {
  id: string
  kind: Kind
  status: FindingStatus
  matched_on: string
  paper_title: string | null
  faculty_name: string | null
  faculty_photo_url?: string | null
  payment_count: number
  total_amount: number
  extra_amount: number
  rows: Member[]
  note: string | null
  recovered_amount: number | null
  reviewed_by_name: string | null
  reviewed_at: string | null
}

type FindingsPayload = {
  total: number
  limit: number
  offset: number
  results: Finding[]
  /** Counts across the whole kind, unaffected by the view. */
  summary: {
    open: number
    confirmed: number
    dismissed: number
    recovered: number
    at_issue: number
    recovered_amount: number
  }
}

type ReviewBody = { status: FindingStatus; note?: string; recovered_amount?: number }

/** The verb on the button that opens a decision is the verb that records it. */
const VERB: Record<FindingStatus, string> = {
  CONFIRMED: "Confirm duplicate",
  DISMISSED: "Not a duplicate",
  RECOVERED: "Record recovery",
  OPEN: "Reopen",
}

const STATUS_LABEL: Record<FindingStatus, string> = {
  OPEN: "Not yet reviewed",
  CONFIRMED: "Confirmed duplicate",
  DISMISSED: "Not a duplicate",
  RECOVERED: "Recovered",
}

export function Duplicates() {
  const { me } = useAuth()
  // Office desks and the Principal; never the Director or Finance.
  const allowed = reviewsFlags(me?.role)
  // The server records decisions from the office desks only.
  const mayReview = allowed && can(me?.role).manageMoney

  const [searchParams, setSearchParams] = useSearchParams()
  const kind: Kind = searchParams.get("kind") === "CROSS_PERSON" ? "CROSS_PERSON" : "SAME_PERSON"
  const history = searchParams.get("view") === "history"
  const page = Math.max(0, Number.parseInt(searchParams.get("page") ?? "0", 10) || 0)
  const [search, setSearch] = useState("")
  const [selected, setSelected] = useState(0)
  const [decision, setDecision] = useState<{ finding: Finding; status: FindingStatus } | null>(null)

  function setParam(name: string, value: string) {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev)
      if (value) next.set(name, value)
      else next.delete(name)
      if (name !== "page") next.delete("page")
      return next
    })
    setSelected(0)
  }

  const listQuery = new URLSearchParams({ kind, status: history ? DECIDED : "OPEN" })
  listQuery.set("limit", String(PAGE_SIZE))
  listQuery.set("offset", String(page * PAGE_SIZE))

  const { data, isLoading, isError, error, refetch } = useApi<FindingsPayload>(
    ["duplicates", kind, history ? "history" : "open", page],
    `/api/admin/duplicate-findings?${listQuery.toString()}`,
    { enabled: allowed, placeholderData: (prev) => prev }
  )

  const findings = useMemo(() => data?.results ?? [], [data])
  const current = findings[Math.min(selected, findings.length - 1)]

  useEffect(() => {
    if (!data) return
    const maxPage = Math.max(0, Math.ceil(data.total / PAGE_SIZE) - 1)
    if (page > maxPage) setParam("page", maxPage > 0 ? String(maxPage) : "")
    // A decided group leaves the queue; stay on the same place in it.
    if (selected > findings.length - 1) setSelected(Math.max(0, findings.length - 1))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data])

  const keys = useMemo(
    () => ({
      j: () => setSelected((i) => Math.min(i + 1, Math.max(0, findings.length - 1))),
      k: () => setSelected((i) => Math.max(0, i - 1)),
      a: () => {
        if (mayReview && !history && current) setDecision({ finding: current, status: "CONFIRMED" })
      },
      r: () => {
        if (mayReview && !history && current) setDecision({ finding: current, status: "DISMISSED" })
      },
    }),
    [findings.length, mayReview, history, current]
  )
  useQueueKeys(keys, allowed && findings.length > 0)

  if (!allowed) {
    return (
      <div className="page py-8">
        <NotOpen message="The research office and the Principal review these. They are not shown to the Director or Finance." />
      </div>
    )
  }

  const summary = data?.summary
  const decided = summary ? summary.confirmed + summary.dismissed + summary.recovered : 0
  const needle = search.trim().toLowerCase()
  const shown = needle
    ? findings.filter((f) =>
        [f.faculty_name, f.paper_title, ...f.rows.map((m) => m.person)].some((v) => String(v ?? "").toLowerCase().includes(needle))
      )
    : findings
  const shownCurrent = shown.find((f) => f.id === current?.id) ?? shown[0]

  const columns: Column<Finding>[] = [
    {
      key: "person",
      header: "Faculty",
      exportValue: (f) => f.faculty_name || f.rows[0]?.person || "Unknown",
      cell: (f) => {
        const p = personOf(f)
        return (
          <span className="flex min-w-0 items-center gap-3">
            <Avatar person={p} size="sm" />
            <span className="min-w-0 font-medium">{p.name}</span>
          </span>
        )
      },
    },
    {
      key: "paper",
      header: "Paper",
      exportValue: (f) => unshout(f.paper_title) || "Untitled paper",
      cell: (f) => <span className="line-clamp-2">{unshout(f.paper_title) || "Untitled paper"}</span>,
    },
    {
      key: "payments",
      header: "Payments",
      exportValue: (f) => `${f.payment_count} payments${paymentSpan(f) ? `, ${paymentSpan(f)}` : ""}`,
      cell: (f) => (
        <span className="block">
          {f.payment_count} payments
          {paymentSpan(f) && <Meta className="block">{paymentSpan(f)}</Meta>}
        </span>
      ),
    },
    {
      key: "extra",
      header: kind === "SAME_PERSON" ? "At issue" : "Paid in all",
      align: "right",
      exportKind: "money",
      exportValue: (f) => (kind === "SAME_PERSON" ? f.extra_amount : f.total_amount),
      cell: (f) =>
        kind === "SAME_PERSON" ? (
          <span className={f.extra_amount > 0 && !history ? "text-critical" : undefined}>{money(f.extra_amount)}</span>
        ) : (
          money(f.total_amount)
        ),
    },
    ...(kind === "SAME_PERSON"
      ? [
          {
            key: "total",
            header: "Paid in all",
            align: "right" as const,
            exportKind: "money" as const,
            exportValue: (f: Finding) => f.total_amount,
            cell: (f: Finding) => money(f.total_amount),
          },
        ]
      : []),
    ...(history
      ? [
          {
            key: "status",
            header: "Decision",
            exportValue: (f: Finding) => STATUS_LABEL[f.status],
            cell: (f: Finding) => STATUS_LABEL[f.status],
          },
        ]
      : []),
    {
      key: "open",
      header: <span className="sr-only">Compare</span>,
      label: "Compare",
      cell: (f) => (
        <Button
          kind={f.id === shownCurrent?.id ? "quiet" : "default"}
          size="sm"
          aria-pressed={f.id === shownCurrent?.id}
          onClick={() => setSelected(Math.max(0, findings.findIndex((x) => x.id === f.id)))}
        >
          {f.id === shownCurrent?.id ? "Comparing" : "Compare"}
        </Button>
      ),
    },
  ]

  return (
    <div className="page space-y-6">
      <PageHeader
        title="Duplicates"
        sub="Compare the payments side by side, then record your decision."
      />

      {summary && (
        <Answer
          items={[
            { value: summary.open, label: "To review", to: kind === "CROSS_PERSON" ? "?kind=CROSS_PERSON" : "?", tone: "caution", zero: "Nothing left to review" },
            ...(kind === "SAME_PERSON"
              ? [
                  {
                    value: summary.at_issue === 0 ? 0 : money(summary.at_issue),
                    label: "At issue, open or confirmed",
                    tone: "critical" as const,
                    zero: "No money at issue",
                  },
                  {
                    value: money(summary.recovered_amount),
                    label: "Recovered so far",
                    tone: "positive" as const,
                  },
                ]
              : []),
            { value: decided, label: "Decided", to: kind === "CROSS_PERSON" ? "?kind=CROSS_PERSON&view=history" : "?view=history", zero: "Nothing decided yet" },
          ]}
        />
      )}

      {kind === "CROSS_PERSON" && (
        <Callout tone="info" title="Usually correct">
          Each co-author is paid by author position. Check the names against the author list.
        </Callout>
      )}

      <div className={filterBar} role="search">
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search faculty or paper"
          aria-label="Search the groups on this page"
          className="w-full min-w-0 sm:w-80"
        />
        <Select aria-label="Kind" value={kind} onChange={(e) => setParam("kind", e.target.value === "CROSS_PERSON" ? "CROSS_PERSON" : "")} className="w-auto max-sm:w-full">
          <option value="SAME_PERSON">Same person paid twice</option>
          <option value="CROSS_PERSON">One paper, several people</option>
        </Select>
        <Select aria-label="View" value={history ? "history" : ""} onChange={(e) => setParam("view", e.target.value)} className="w-auto max-sm:w-full">
          <option value="">To review</option>
          <option value="history">History</option>
        </Select>
        {search && (
          <Button kind="quiet" onClick={() => setSearch("")}>
            Clear search
          </Button>
        )}
      </div>
      {findings.length > 0 && (
        <p className="hidden text-sm text-fg-muted sm:block">
          Keys: <Kbd>j</Kbd> <Kbd>k</Kbd> move
          {mayReview && !history && (
            <>
              , <Kbd>a</Kbd> confirm, <Kbd>r</Kbd> not a duplicate
            </>
          )}
          .
        </p>
      )}

      {isLoading && !data ? (
        <SkeletonRows rows={6} rowHeight={72} />
      ) : isError ? (
        <ErrorState
          title="Could not load the findings"
          message={
            error?.status === 403
              ? "Not allowed. The research office and the Principal review these."
              : "The server did not answer."
          }
          onRetry={error?.status === 403 ? false : () => refetch()}
        />
      ) : (
        <div className="space-y-6">
          <Table
            rows={shown}
            columns={columns}
            getKey={(f) => f.id}
            maxHeight="none"
            caption={history ? "Decided groups" : "Groups to review"}
            isCurrent={(f) => f.id === shownCurrent?.id}
            tools={{ id: `duplicates-${kind}-${history ? "history" : "open"}`, title: "Duplicates" }}
            empty={{
              art: history || needle ? "no-results" : "empty-queue",
              icon: CircleCheck,
              title: needle ? "No group matches" : history ? "Nothing decided yet" : "Nothing left to review",
              message: needle
                ? "Nothing on this page fits the search."
                : history
                  ? "Decisions you record move here."
                  : "The next sweep adds any new groups here.",
            }}
          />
          <Pagination
            page={page}
            pageSize={PAGE_SIZE}
            total={data?.total ?? 0}
            onChange={(next) => setParam("page", next > 0 ? String(next) : "")}
          />
          {shownCurrent && (
            <DecisionPanel
              key={shownCurrent.id}
              finding={shownCurrent}
              mayReview={mayReview}
              onDecide={(status) => setDecision({ finding: shownCurrent, status })}
            />
          )}
        </div>
      )}

      <ReviewDialog
        finding={decision?.finding ?? null}
        decision={decision?.status ?? null}
        onClose={() => setDecision(null)}
      />
    </div>
  )
}

/* ------------------------------------------------------------------------ */
/* The group being compared                                                  */
/* ------------------------------------------------------------------------ */

function personOf(finding: Finding) {
  const first = [...finding.rows].sort((a, b) => (a.when || "").localeCompare(b.when || ""))[0]
  const name = finding.faculty_name || first?.person || "Unknown"
  return {
    name,
    initials: initialsOf((finding.faculty_name || first?.person || "").replace(/[(][^)]*[)]/g, "")),
    photo_url: finding.faculty_photo_url ?? finding.rows.find((m) => m.photo_url)?.photo_url ?? null,
  }
}

/** "Apr 2019 and Jun 2020, last paid 2 years ago": when the payments went out. */
function paymentSpan(finding: Finding): string {
  const ordered = [...finding.rows].sort((a, b) => (a.when || "").localeCompare(b.when || ""))
  const latest = [...ordered].reverse().map(monthOf).find(Boolean) ?? null
  const first = ordered.map(monthOf).find(Boolean) ?? null
  const span = first && latest && first !== latest ? `${monthLabel(first)} and ${monthLabel(latest)}` : first ? monthLabel(first) : ""
  return [span, latest ? `last paid ${ageLabel(latest)}` : ""].filter(Boolean).join(", ")
}

function DecisionPanel({
  finding,
  mayReview,
  onDecide,
}: {
  finding: Finding
  mayReview: boolean
  onDecide: (status: FindingStatus) => void
}) {
  const samePerson = finding.kind === "SAME_PERSON"
  const ordered = useMemo(
    () => [...finding.rows].sort((a, b) => (a.when || "").localeCompare(b.when || "")),
    [finding.rows]
  )
  const person = personOf(finding)

  return (
    <section aria-label="The payments in this group" className="space-y-4">
      <h2 className="text-base font-semibold">
        {person.name}: {short(finding.paper_title)}
      </h2>
      {finding.matched_on !== "doi" && (
        <Meta className="block">Grouped on the title, not a DOI. Check the paper row before deciding.</Meta>
      )}

      <Comparison members={ordered} />

      {finding.reviewed_by_name && (
        <div className="rounded-control bg-sunken px-3 py-2 text-sm">
          <p className="text-fg-muted">
            {STATUS_LABEL[finding.status]} by {finding.reviewed_by_name}
            {finding.reviewed_at ? ` on ${formatDate(finding.reviewed_at)}` : ""}
            {finding.recovered_amount != null ? `. ${money(finding.recovered_amount)} recovered` : ""}
          </p>
          {finding.note && <p className="mt-1">&ldquo;{finding.note}&rdquo;</p>}
        </div>
      )}

      <ChangeHistory entity="DuplicateFinding" id={finding.id} />

      {mayReview && (
        <div className="flex flex-wrap gap-2">
          {finding.status === "OPEN" ? (
            <>
              <Button kind={samePerson ? "primary" : "default"} onClick={() => onDecide("CONFIRMED")}>
                {VERB.CONFIRMED}
              </Button>
              <Button kind="default" onClick={() => onDecide("DISMISSED")}>
                {VERB.DISMISSED}
              </Button>
            </>
          ) : (
            <>
              {finding.status === "CONFIRMED" && (
                <Button kind="primary" onClick={() => onDecide("RECOVERED")}>
                  {VERB.RECOVERED}
                </Button>
              )}
              <Button kind="quiet" onClick={() => onDecide("OPEN")}>
                {VERB.OPEN}
              </Button>
            </>
          )}
        </div>
      )}
    </section>
  )
}

/**
 * The payments side by side, oldest first. A cell that differs from the
 * first payment is marked, because the differences are what the decision
 * turns on: same voucher twice is a double entry, a different paper is a
 * false match.
 */
function Comparison({ members }: { members: Member[] }) {
  const rows: { label: string; value: (m: Member) => string; render?: (m: Member) => React.ReactNode }[] = [
    {
      label: "Person",
      value: (m) => (m.person || "").trim().toLowerCase(),
      render: (m) => (
        <span className="flex min-w-0 items-center gap-2">
          <Avatar person={{ name: m.person || "Unknown", initials: initialsOf((m.person || "").replace(/[(][^)]*[)]/g, "")), photo_url: m.photo_url ?? null }} size="xs" />
          <span className="min-w-0">
            <span className="block">{m.person || "Unknown"}</span>
            {m.department && <Meta className="block">{m.department}</Meta>}
          </span>
        </span>
      ),
    },
    {
      label: "Paper",
      value: (m) => (m.title || "").trim().toLowerCase(),
      render: (m) => (
        <span className="block">
          {m.title || "No title"}
          {m.doi && m.doi.trim() !== "-" && <Meta className="block break-all">{m.doi}</Meta>}
        </span>
      ),
    },
    {
      label: "Month",
      value: (m) => monthOf(m) || "",
      render: (m) => (monthOf(m) ? monthLabel(monthOf(m)) : "Not recorded"),
    },
    {
      label: "Voucher",
      // The ERP import stored voucher numbers as floats ("1802.0").
      value: (m) => voucher(m.reference),
      render: (m) =>
        m.source === "claim" ? (
          <Link to={`/papers/${m.id}`} className="text-accent underline-offset-2 hover:underline">
            {voucher(m.reference) || "Open the claim"}
          </Link>
        ) : (
          <span>
            {voucher(m.reference) || "None"}
            <Meta className="block">Imported from the ERP</Meta>
          </span>
        ),
    },
    {
      label: "Amount",
      value: (m) => String(m.amount),
      render: (m) => <span className="font-medium tabular">{money(m.amount)}</span>,
    },
  ]

  return (
    <>
      {/* On a phone each payment is its own block, so nothing scrolls sideways. */}
      <div className="space-y-4 md:hidden">
        {members.map((m, i) => (
          <dl key={`${m.source}-${m.id}`} className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-sm">
            <dt className="col-span-2 font-medium">Payment {i + 1}</dt>
            {rows.map((row) => {
              const differs = i > 0 && members[0] && row.value(m) !== row.value(members[0])
              return (
                <div key={row.label} className={cn("contents", differs && "[&>*]:bg-caution-wash")}>
                  <dt className="text-fg-muted">{row.label}</dt>
                  <dd className="min-w-0 break-words">
                    {row.render ? row.render(m) : row.value(m)}
                    {differs && <span className="block text-xs text-fg-muted">Differs from payment 1</span>}
                  </dd>
                </div>
              )
            })}
          </dl>
        ))}
      </div>
    <div className="relative hidden overflow-x-auto rounded-control border border-line md:block">
      <table className="w-full min-w-[32rem] table-fixed text-sm">
        <caption className="sr-only">The payments in this group, side by side</caption>
        <thead>
          <tr className="border-b border-line">
            <th className="w-24 px-3 py-2 text-left font-normal">
              <span className="sr-only">Field</span>
            </th>
            {members.map((m, i) => (
              <th key={`${m.source}-${m.id}`} scope="col" className="px-3 py-2 text-left font-normal">
                <ColumnLabel>Payment {i + 1}</ColumnLabel>
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {rows.map((row) => {
            const base = members[0] ? row.value(members[0]) : ""
            return (
              <tr key={row.label}>
                <th scope="row" className="px-3 py-2 text-left align-top font-normal text-fg-muted">
                  {row.label}
                </th>
                {members.map((m, i) => {
                  const differs = i > 0 && row.value(m) !== base
                  return (
                    <td
                      key={`${m.source}-${m.id}`}
                      className={cn("px-3 py-2 align-top break-words", differs && "bg-caution-wash")}
                    >
                      {row.render ? row.render(m) : row.value(m)}
                      {differs && <span className="sr-only"> (differs from payment 1)</span>}
                    </td>
                  )
                })}
              </tr>
            )
          })}
        </tbody>
      </table>
      <p className="border-t border-line px-3 py-1.5 text-xs text-fg-muted">
        <span className="mr-1 inline-block size-2.5 rounded-sm bg-caution-wash align-middle ring-1 ring-caution/40" />
        Differs from payment 1
      </p>
    </div>
    </>
  )
}

/* ------------------------------------------------------------------------ */
/* Recording a decision                                                      */
/* ------------------------------------------------------------------------ */

/**
 * One dialog for every decision; its confirm button says the same verb as
 * the button that opened it. Ruling out needs a reason (the server refuses
 * under five characters): the next sweep raises the same group again, and the
 * reason is all the next reader has to go on.
 */
function ReviewDialog({
  finding,
  decision,
  onClose,
}: {
  finding: Finding | null
  decision: FindingStatus | null
  onClose: () => void
}) {
  const [note, setNote] = useState("")
  const [recovered, setRecovered] = useState("")

  useEffect(() => {
    if (!decision) return
    setNote("")
    setRecovered(decision === "RECOVERED" ? String(finding?.extra_amount || "") : "")
  }, [decision, finding?.extra_amount])

  const review = useApiMutation<ReviewBody, { ok: boolean; status: string }>(
    () => `/api/admin/duplicate-findings/${finding?.id}`,
    { invalidates: [["duplicates"]] }
  )

  const trimmed = note.trim()
  const needsNote = decision === "DISMISSED" || decision === "CONFIRMED"
  const minNote = decision === "DISMISSED" ? 5 : 0
  const noteTooShort = minNote > 0 && trimmed.length > 0 && trimmed.length < minNote
  const parsedRecovered = Number.parseFloat(recovered)
  const recoveredValid =
    decision !== "RECOVERED" ||
    (recovered.trim() !== "" && Number.isFinite(parsedRecovered) && parsedRecovered >= 0)
  const canSubmit = trimmed.length >= minNote && recoveredValid && !review.isPending

  if (!finding) return null

  async function submit() {
    if (!decision || !finding) return
    try {
      await review.mutateAsync({
        status: decision,
        note: trimmed || undefined,
        recovered_amount: decision === "RECOVERED" ? parsedRecovered : undefined,
      })
      const paper = short(finding.paper_title)
      toast.ok(
        decision === "CONFIRMED"
          ? `Confirmed as a duplicate: ${money(finding.extra_amount)} to recover on “${paper}”`
          : decision === "DISMISSED"
            ? `Recorded as not a duplicate: “${paper}”`
            : decision === "RECOVERED"
              ? `Recorded ${money(parsedRecovered)} recovered on “${paper}”`
              : `Reopened “${paper}” for review`
      )
      onClose()
    } catch (err) {
      toast.fail(err)
    }
  }

  const title =
    decision === "CONFIRMED"
      ? "Confirm this is a duplicate?"
      : decision === "DISMISSED"
        ? "Record that this is not a duplicate?"
        : decision === "RECOVERED"
          ? "Record money recovered?"
          : "Reopen for review?"

  return (
    <Dialog open={decision !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {finding.faculty_name ? `${finding.faculty_name}, ` : ""}
            {finding.payment_count} payments totalling {money(finding.total_amount)} on “
            {short(finding.paper_title)}”.
            {decision === "CONFIRMED" &&
              ` ${money(finding.extra_amount)} becomes money to recover. This records a judgement; it reverses no payment on its own.`}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          {decision === "RECOVERED" && (
            <Field label="Amount recovered" hint="What came back, not what was at issue.">
              <NumberInput
                value={recovered}
                onChange={(e) => setRecovered(e.target.value)}
                min={0}
                step="1"
                unit="₹"
                autoFocus
              />
            </Field>
          )}

          <Field
            label={
              decision === "DISMISSED"
                ? "Why is this not a duplicate?"
                : needsNote
                  ? "What shows it is a duplicate?"
                  : "Note"
            }
            hint={
              decision === "DISMISSED"
                ? "The next sweep raises this group again. Your reason is all the next reader sees."
                : "Optional."
            }
            error={noteTooShort ? `At least ${minNote} characters.` : undefined}
          >
            <Textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={3}
              placeholder={
                decision === "DISMISSED"
                  ? "Different papers that share a title: different journals and years"
                  : "Same voucher entered twice in the ERP sheet"
              }
              autoFocus={decision !== "RECOVERED"}
            />
          </Field>
        </DialogBody>
        <DialogFooter>
          <Button kind="quiet" onClick={onClose} disabled={review.isPending}>
            Cancel
          </Button>
          <Button
            kind={decision === "CONFIRMED" ? "danger" : "primary"}
            disabled={!canSubmit}
            onClick={() => void submit()}
          >
            {review.isPending ? "Recording…" : decision ? VERB[decision] : ""}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/* ------------------------------------------------------------------------ */
/* Small parts                                                               */
/* ------------------------------------------------------------------------ */

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="rounded-sm border border-line bg-sunken px-1 font-mono text-xs text-fg">{children}</kbd>
  )
}

/** The payment's month, or null where the ledger row recorded none. */
function monthOf(m: Member): string | null {
  return m.month_recorded === false ? null : m.when
}

/** "2019-04" as "Apr 2019". */
function monthLabel(value: string | null): string {
  if (!value) return "No month recorded"
  const [year, month] = value.split("-")
  const index = Number.parseInt(month ?? "", 10)
  if (!year || Number.isNaN(index) || index < 1 || index > 12) return value
  const d = new Date(Date.UTC(Number.parseInt(year, 10), index - 1, 1))
  return d.toLocaleDateString("en-IN", { month: "short", year: "numeric", timeZone: "UTC" })
}

/** How long ago a "YYYY-MM" month was, in words. */
function ageLabel(value: string, now = new Date()): string {
  const [y, m] = value.split("-").map((n) => Number.parseInt(n, 10))
  if (!y || !m) return ""
  const months = (now.getFullYear() - y) * 12 + (now.getMonth() + 1 - m)
  if (months < 1) return "this month"
  if (months < 12) return `${months} ${months === 1 ? "month" : "months"} ago`
  const years = Math.floor(months / 12)
  return `${years} ${years === 1 ? "year" : "years"} ago`
}

function short(title: string | null): string {
  const t = (title || "Untitled paper").trim()
  return t.length > 60 ? `${t.slice(0, 57)}…` : t
}

function formatDate(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ""
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })
}

/** An ERP voucher number, without the ".0" the spreadsheet import left on it. */
function voucher(ref: string | null): string {
  return (ref || "").replace(/^(\d+)\.0+$/, "$1")
}
