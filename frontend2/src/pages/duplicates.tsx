import { useEffect, useState } from "react"
import { Link, useSearchParams } from "react-router-dom"
import { ChevronDown, CircleCheck, Copy, Users } from "lucide-react"

import { can, useAuth } from "@/app/auth"
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
import { Field, NumberInput, Textarea } from "@/ui/field"
import { money } from "@/ui/paper"
import { Pagination } from "@/ui/pagination"
import { Callout, EmptyState, ErrorState, SkeletonRows } from "@/ui/state"
import { ColumnLabel, Meta, PageTitle, Sub } from "@/ui/text"
import { toast } from "@/ui/toast"

/**
 * What the sweep over already-paid history found, and what somebody decided
 * about it.
 *
 * Duplicate detection had only ever run at submission time, so the ~3,000
 * payments imported from the ERP were never checked against each other at
 * all. This is the queue for that backlog — and it is a queue rather than a
 * report because every row is a judgement, not a fact.
 *
 * The two kinds are kept firmly apart, and the difference is the whole
 * screen:
 *
 * - **Same person paid twice** is nearly always wrong, and the sum at issue
 *   is every payment but the largest.
 * - **One paper, several people** is usually *right*. The scheme pays each
 *   co-author by author position, so a paper appearing against four names is
 *   the design working. These are recorded for visibility and are not, on
 *   their own, a finding against anybody — so this screen shows no "at
 *   issue" figure on that tab and does not offer Confirm as the obvious
 *   action. Put a money total beside a list of co-authors and somebody will
 *   work down it confirming legitimate payments as fraud.
 */

const PAGE_SIZE = 25

/* ------------------------------------------------------------------------ */
/* Data — read out of list_duplicate_findings() in backend/core/api.py      */
/* ------------------------------------------------------------------------ */

type Kind = "SAME_PERSON" | "CROSS_PERSON"
type FindingStatus = "OPEN" | "CONFIRMED" | "DISMISSED" | "RECOVERED"

/** One payment inside a group, as the sweep recorded it. */
type Member = {
  /** "claim" — a ticket in this system. "prior" — an imported ERP row. */
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
}

type Finding = {
  id: string
  kind: Kind
  status: FindingStatus
  /** "doi" or "title". A title match is the weaker of the two. */
  matched_on: string
  paper_title: string | null
  faculty_name: string | null
  payment_count: number
  total_amount: number
  /** Everything but the largest payment — the sum at issue. */
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
  /** Counts across the whole *kind*, unaffected by the status filter. */
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

const STATUS_LABEL: Record<FindingStatus, string> = {
  OPEN: "Not yet reviewed",
  CONFIRMED: "A real duplicate",
  DISMISSED: "Not a duplicate",
  RECOVERED: "Recovered",
}

const STATUS_TONE: Record<FindingStatus, string> = {
  OPEN: "bg-sunken text-fg-muted",
  CONFIRMED: "bg-critical-wash text-critical",
  DISMISSED: "bg-sunken text-fg-muted",
  RECOVERED: "bg-positive-wash text-positive",
}

const STATUS_FILTERS: { value: string; label: string }[] = [
  { value: "", label: "All" },
  { value: "OPEN", label: "Not reviewed" },
  { value: "CONFIRMED", label: "Confirmed" },
  { value: "DISMISSED", label: "Dismissed" },
  { value: "RECOVERED", label: "Recovered" },
]

/* ------------------------------------------------------------------------ */
/* Page                                                                      */
/* ------------------------------------------------------------------------ */

export function Duplicates() {
  const { me } = useAuth()
  const allowed = can(me?.role).viewReports
  const mayReview = can(me?.role).manageMoney

  const [searchParams, setSearchParams] = useSearchParams()
  const kind: Kind = searchParams.get("kind") === "CROSS_PERSON" ? "CROSS_PERSON" : "SAME_PERSON"
  const status = searchParams.get("status") ?? ""
  const page = Math.max(0, Number.parseInt(searchParams.get("page") ?? "0", 10) || 0)

  function setParam(name: string, value: string) {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev)
      if (value) next.set(name, value)
      else next.delete(name)
      if (name !== "page") next.delete("page")
      return next
    })
  }

  const listQuery = new URLSearchParams({ kind })
  if (status) listQuery.set("status", status)
  listQuery.set("limit", String(PAGE_SIZE))
  listQuery.set("offset", String(page * PAGE_SIZE))

  const { data, isLoading, isError, error, refetch } = useApi<FindingsPayload>(
    ["duplicates", kind, status, page],
    `/api/admin/duplicate-findings?${listQuery.toString()}`,
    { enabled: allowed, placeholderData: (prev) => prev }
  )

  useEffect(() => {
    if (!data) return
    const maxPage = Math.max(0, Math.ceil(data.total / PAGE_SIZE) - 1)
    if (page > maxPage) setParam("page", maxPage > 0 ? String(maxPage) : "")
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data])

  if (!allowed) {
    return (
      <div className="page py-8">
        <ErrorState
          title="Not open to this account"
          message="These findings are about payments. Finance, the Principal and the research cell can read them."
        />
      </div>
    )
  }

  const findings = data?.results ?? []
  const summary = data?.summary

  return (
    <div className="page space-y-6">
      <header>
        <PageTitle>Duplicates</PageTitle>
        <Sub className="mt-1">
          A sweep over everything already paid, grouped by DOI where there is one and by title
          otherwise. Each group is a judgement for somebody to record, not a verdict.
        </Sub>
      </header>

      <div className="flex flex-wrap items-center gap-2">
        <Tab active={kind === "SAME_PERSON"} onClick={() => setParam("kind", "SAME_PERSON")}>
          <Copy className="size-4" aria-hidden />
          Same person paid twice
        </Tab>
        <Tab active={kind === "CROSS_PERSON"} onClick={() => setParam("kind", "CROSS_PERSON")}>
          <Users className="size-4" aria-hidden />
          One paper, several people
        </Tab>
      </div>

      {kind === "CROSS_PERSON" && (
        <Callout tone="info" title="These are usually correct">
          The scheme pays each co-author by author position, so one paper appearing against
          several names is the design working, not a fault. They are listed for visibility and
          are not a finding against anybody on their own — check the names against the author
          list before recording anything here.
        </Callout>
      )}

      {summary && <Summary summary={summary} kind={kind} />}

      <div className="flex flex-wrap items-center gap-1">
        {STATUS_FILTERS.map((f) => (
          <Chip key={f.value} active={status === f.value} onClick={() => setParam("status", f.value)}>
            {f.label}
            {f.value === "OPEN" && summary ? ` (${summary.open})` : ""}
          </Chip>
        ))}
      </div>

      {isLoading && !data ? (
        <SkeletonRows rows={6} rowHeight={96} />
      ) : isError ? (
        <ErrorState
          title="Could not load the findings"
          message={
            error?.status === 403
              ? "Not allowed. Finance, the Principal and the research cell can read these."
              : "The server did not answer. Nothing has been reviewed or changed."
          }
          onRetry={error?.status === 403 ? undefined : () => refetch()}
        />
      ) : findings.length === 0 ? (
        <EmptyState
          art="empty-queue"
          icon={CircleCheck}
          title={status ? "Nothing in this state" : "The sweep found nothing here"}
          message={
            status
              ? "No group in this kind is in that state. Try another filter."
              : "Either the sweep has not been run over this history yet, or it grouped nothing — both read the same from here, so check when it last ran before concluding the books are clean."
          }
        />
      ) : (
        <>
          <ul className="divide-y divide-line border-y border-line">
            {findings.map((f) => (
              <FindingRow key={f.id} finding={f} mayReview={mayReview} />
            ))}
          </ul>
          <Pagination
            page={page}
            pageSize={PAGE_SIZE}
            total={data?.total ?? 0}
            onChange={(next) => setParam("page", next > 0 ? String(next) : "")}
          />
        </>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------------ */
/* Summary                                                                   */
/* ------------------------------------------------------------------------ */

/**
 * The state of this kind of finding as a whole.
 *
 * The counts describe every group of this kind regardless of the status
 * filter on screen — that is what the server returns, and a summary that
 * silently followed the filter would read "0 open" the moment somebody
 * looked at the dismissed ones.
 */
function Summary({ summary, kind }: { summary: FindingsPayload["summary"]; kind: Kind }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-8 gap-y-3 border-y border-line py-3">
      <Stat label="Not reviewed" value={String(summary.open)} />
      <Stat label="Confirmed" value={String(summary.confirmed)} />
      <Stat label="Dismissed" value={String(summary.dismissed)} />
      <Stat label="Recovered" value={String(summary.recovered)} />

      {/* Deliberately absent on the co-author tab. The server computes
          `at_issue` the same way for both kinds — every payment but the
          largest — which for four co-authors of one paper is three correct
          payments added together and labelled as a loss. */}
      {kind === "SAME_PERSON" ? (
        <>
          <Stat label="At issue" value={money(summary.at_issue)} tone="critical" />
          <Stat label="Recovered so far" value={money(summary.recovered_amount)} tone="positive" />
        </>
      ) : (
        <Meta className="max-w-md">
          No sum is shown for co-authored papers: every payment but the largest would be counted
          as a loss, and on this tab those are the other authors being paid correctly.
        </Meta>
      )}
    </div>
  )
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string
  value: string
  tone?: "critical" | "positive"
}) {
  return (
    <div>
      <ColumnLabel className="block">{label}</ColumnLabel>
      <p
        className={cn(
          "mt-0.5 text-lg font-semibold tabular",
          tone === "critical" && "text-critical",
          tone === "positive" && "text-positive"
        )}
      >
        {value}
      </p>
    </div>
  )
}

/* ------------------------------------------------------------------------ */
/* One finding                                                               */
/* ------------------------------------------------------------------------ */

function FindingRow({ finding, mayReview }: { finding: Finding; mayReview: boolean }) {
  const [open, setOpen] = useState(false)
  const [reviewing, setReviewing] = useState<FindingStatus | null>(null)

  const samePerson = finding.kind === "SAME_PERSON"
  const weakMatch = finding.matched_on !== "doi"

  return (
    <li className="space-y-3 py-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-base">{finding.paper_title || "Untitled paper"}</p>
          <p className="mt-0.5 text-sm text-fg-muted">
            {[
              finding.faculty_name,
              `${finding.payment_count} payments`,
              `${money(finding.total_amount)} in total`,
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {samePerson && finding.extra_amount > 0 && (
            <span className="text-sm font-medium text-critical tabular">
              {money(finding.extra_amount)} at issue
            </span>
          )}
          <span
            className={cn(
              "rounded-sm px-1.5 py-0.5 text-xs font-medium",
              STATUS_TONE[finding.status]
            )}
          >
            {STATUS_LABEL[finding.status]}
          </span>
        </div>
      </div>

      {weakMatch && (
        // Said on every title-matched row, because it changes what the
        // reader is being asked. Two different papers can share a title;
        // two rows sharing a DOI are the same paper by definition.
        <Meta className="block">
          Grouped on the title, not a DOI — different papers can share a title, so check the
          journal and the year below before deciding.
        </Meta>
      )}

      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 text-sm text-fg-muted hover:text-fg"
        aria-expanded={open}
      >
        <ChevronDown className={cn("size-4 transition-transform duration-[var(--dur-1)]", open && "rotate-180")} aria-hidden />
        {open ? "Hide" : "Show"} the {finding.payment_count} payments
      </button>

      {open && <Members members={finding.rows} />}

      {finding.reviewed_by_name && (
        <div className="rounded-md bg-sunken px-3 py-2 text-sm">
          <p className="text-fg-muted">
            {STATUS_LABEL[finding.status]} by {finding.reviewed_by_name}
            {finding.reviewed_at ? ` · ${formatDateTime(finding.reviewed_at)}` : ""}
            {finding.recovered_amount != null
              ? ` · ${money(finding.recovered_amount)} recovered`
              : ""}
          </p>
          {finding.note && <p className="mt-1">“{finding.note}”</p>}
        </div>
      )}

      {mayReview && (
        <div className="flex flex-wrap gap-2">
          {finding.status !== "CONFIRMED" && (
            <Button
              kind={samePerson ? "default" : "quiet"}
              size="sm"
              onClick={() => setReviewing("CONFIRMED")}
            >
              This is a duplicate
            </Button>
          )}
          {finding.status !== "DISMISSED" && (
            <Button kind="quiet" size="sm" onClick={() => setReviewing("DISMISSED")}>
              Not a duplicate
            </Button>
          )}
          {finding.status !== "RECOVERED" && (
            <Button kind="quiet" size="sm" onClick={() => setReviewing("RECOVERED")}>
              Money recovered
            </Button>
          )}
        </div>
      )}

      <ReviewDialog
        finding={finding}
        decision={reviewing}
        onClose={() => setReviewing(null)}
      />
    </li>
  )
}

/**
 * The payments in the group, oldest first.
 *
 * `source` is on every row because the two mean different things to whoever
 * has to chase the money: a claim is a ticket in this system with a page to
 * open, an imported ERP row is a line in a spreadsheet from before this
 * system existed and there is nothing to click.
 */
function Members({ members }: { members: Member[] }) {
  const ordered = [...members].sort((a, b) => (a.when || "").localeCompare(b.when || ""))

  return (
    <ul className="space-y-1.5 rounded-md bg-sunken px-3 py-2.5">
      {ordered.map((m) => (
        <li key={`${m.source}-${m.id}`} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-sm">
          <span className="w-24 shrink-0 tabular text-fg-muted">{m.when || "no date"}</span>
          <span className="w-28 shrink-0 tabular font-medium">{money(m.amount)}</span>
          <span className="min-w-0 flex-1 truncate">
            {m.person || "unknown"}
            {m.department ? <Meta> · {m.department}</Meta> : null}
          </span>
          {m.source === "claim" ? (
            <Link
              to={`/papers/${m.id}`}
              className="shrink-0 text-accent underline-offset-2 hover:underline"
            >
              {m.reference || "open the ticket"}
            </Link>
          ) : (
            <Meta className="shrink-0">
              {m.reference ? `${m.reference} · ` : ""}imported from the ERP
            </Meta>
          )}
        </li>
      ))}
    </ul>
  )
}

/* ------------------------------------------------------------------------ */
/* Recording a decision                                                      */
/* ------------------------------------------------------------------------ */

/**
 * One dialog for all three decisions, because the server takes one endpoint
 * and one `status`. Dismissing demands a reason (the server refuses under
 * five characters) — the next sweep raises the same group again, and without
 * the reason the person who looks at it next has nothing to go on and does
 * the same work twice.
 */
function ReviewDialog({
  finding,
  decision,
  onClose,
}: {
  finding: Finding
  decision: FindingStatus | null
  onClose: () => void
}) {
  const [note, setNote] = useState("")
  const [recovered, setRecovered] = useState("")

  useEffect(() => {
    if (!decision) return
    setNote("")
    setRecovered(decision === "RECOVERED" ? String(finding.extra_amount || "") : "")
  }, [decision, finding.extra_amount])

  const review = useApiMutation<ReviewBody, { ok: boolean; status: string }>(
    `/api/admin/duplicate-findings/${finding.id}`,
    { invalidates: [["duplicates"]] }
  )

  const trimmed = note.trim()
  const needsNote = decision === "DISMISSED"
  const noteTooShort = needsNote && trimmed.length > 0 && trimmed.length < 5
  const parsedRecovered = Number.parseFloat(recovered)
  const recoveredValid =
    decision !== "RECOVERED" ||
    (recovered.trim() !== "" && Number.isFinite(parsedRecovered) && parsedRecovered >= 0)
  const canSubmit = (!needsNote || trimmed.length >= 5) && recoveredValid && !review.isPending

  async function submit() {
    if (!decision) return
    try {
      await review.mutateAsync({
        status: decision,
        note: trimmed || undefined,
        recovered_amount: decision === "RECOVERED" ? parsedRecovered : undefined,
      })
      toast.ok(
        decision === "CONFIRMED"
          ? `Recorded as a duplicate — ${money(finding.extra_amount)} at issue on “${short(finding.paper_title)}”`
          : decision === "DISMISSED"
            ? `Dismissed — “${short(finding.paper_title)}” will not be raised as a fault again`
            : `Recorded as recovered — ${money(parsedRecovered)} on “${short(finding.paper_title)}”`
      )
      onClose()
    } catch (err) {
      toast.fail(err)
    }
  }

  const title =
    decision === "CONFIRMED"
      ? "Record this as a duplicate"
      : decision === "DISMISSED"
        ? "Record that this is not a duplicate"
        : "Record money recovered"

  return (
    <Dialog open={decision !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {finding.payment_count} payments totalling {money(finding.total_amount)} on “
            {short(finding.paper_title)}”.
            {decision === "CONFIRMED" &&
              " This records a judgement; it moves no money and reverses no payment on its own."}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          {decision === "RECOVERED" && (
            <Field label="Amount recovered" hint="What actually came back, not what was at issue.">
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
            label={needsNote ? "Why is this not a duplicate?" : "Note"}
            hint={
              needsNote
                ? "The next sweep raises this group again — this is what the next reader has to go on."
                : "Optional. What was decided and on what evidence."
            }
            error={noteTooShort ? "At least 5 characters." : undefined}
          >
            <Textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={3}
              placeholder={
                needsNote
                  ? "Different papers that happen to share a title — different journals and years"
                  : "Checked against the ERP sheet"
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
            {review.isPending ? "Recording…" : "Record it"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/* ------------------------------------------------------------------------ */
/* Small parts                                                               */
/* ------------------------------------------------------------------------ */

function Tab({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-sm font-medium",
        "transition-colors duration-[var(--dur-1)] ease-out",
        active ? "bg-selected text-fg" : "text-fg-muted hover:bg-hover hover:text-fg"
      )}
    >
      {children}
    </button>
  )
}

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "h-7 rounded-sm px-2 text-sm transition-colors duration-[var(--dur-1)] ease-out",
        active ? "bg-selected font-medium text-fg" : "text-fg-muted hover:bg-hover hover:text-fg"
      )}
    >
      {children}
    </button>
  )
}

function short(title: string | null): string {
  const t = (title || "Untitled paper").trim()
  return t.length > 60 ? `${t.slice(0, 57)}…` : t
}

function formatDateTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ""
  return d.toLocaleString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  })
}
