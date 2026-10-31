import { useEffect, useMemo, useState } from "react"
import { Link, useSearchParams } from "react-router-dom"
import { CircleCheck } from "lucide-react"

import { useAuth } from "@/app/auth"
import { reviewsFlags } from "@/app/nav"
import { cn } from "@/lib/cn"
import { useApi } from "@/lib/query"
import { ClaimNo, staffStage } from "@/pages/cell/parts"
import { raisedByLine, ResolveDialog, type FlagGroup, type FlagWithClaim } from "@/pages/cell/flag-parts"
import { Button } from "@/ui/button"
import { Checkbox, Input, Select } from "@/ui/field"
import { filterBar } from "@/ui/filter-bar"
import { unshout } from "@/lib/names"
import { money } from "@/ui/paper"
import { Avatar, initialsOf } from "@/ui/person"
import { When } from "@/ui/when"
import { Table, type Column } from "@/ui/table"
import { Answer } from "@/ui/answer"
import { PageHeader } from "@/ui/page-header"
import { Pagination } from "@/ui/pagination"
import { ErrorState, NotOpen, SkeletonRows } from "@/ui/state"
import { Meta } from "@/ui/text"
import { useQueueKeys } from "@/ui/queue-keys"

/**
 * Flags: the doubts raised on claims, and how each was answered.
 *
 * The question is "which doubts are still open, and what did we answer
 * before?". The top gives the counts and what the open ones are about (one
 * line per question, with how many sit on claims already paid, because that is
 * money that went out with a question on it). The work is the list below,
 * with a reason-required Resolve on each row and one answer for a batch. The
 * history of answers is one click away and reads in place.
 *
 * A flag never holds a claim back: it is paid as normal.
 */

const PAGE_SIZE = 50

type FlagsPayload = {
  total: number
  limit: number
  offset: number
  results: FlagWithClaim[]
  summary: { open: number; resolved: number; open_on_paid: number; groups: FlagGroup[] }
}

const STATUS_FILTERS = [
  { value: "open", label: "Open" },
  { value: "resolved", label: "Answered" },
  { value: "all", label: "All" },
]

const PAID_FILTERS = [
  { value: "", label: "Paid or not" },
  { value: "yes", label: "Already paid" },
  { value: "no", label: "Not yet paid" },
]

export function Flags() {
  const { me } = useAuth()
  const allowed = reviewsFlags(me?.role)
  const [searchParams, setSearchParams] = useSearchParams()
  const status = searchParams.get("status") || "open"
  const paid = searchParams.get("paid") ?? ""
  const rule = searchParams.get("rule") ?? ""
  // A notification links here with the claim it was about.
  const claim = searchParams.get("claim") ?? ""
  const page = Math.max(0, Number.parseInt(searchParams.get("page") ?? "0", 10) || 0)
  const [resolving, setResolving] = useState<FlagWithClaim[]>([])
  const [search, setSearch] = useState("")
  const [selected, setSelected] = useState(0)
  const [chosen, setChosen] = useState<Set<string>>(new Set())

  function setParam(name: string, value: string) {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev)
      if (value) next.set(name, value)
      else next.delete(name)
      if (name !== "page") next.delete("page")
      return next
    })
    setSelected(0)
    if (name !== "page") setChosen(new Set())
  }

  const query = new URLSearchParams({ status })
  if (paid) query.set("paid", paid)
  if (rule) query.set("rule", rule)
  if (claim) query.set("claim", claim)
  query.set("limit", String(PAGE_SIZE))
  query.set("offset", String(page * PAGE_SIZE))

  const { data, isLoading, isError, error, refetch } = useApi<FlagsPayload>(
    ["flags", query.toString()],
    `/api/flags?${query.toString()}`,
    { enabled: allowed, placeholderData: (prev) => prev }
  )

  useEffect(() => {
    if (!data) return
    const maxPage = Math.max(0, Math.ceil(data.total / PAGE_SIZE) - 1)
    if (page > maxPage) setParam("page", maxPage > 0 ? String(maxPage) : "")
    if (selected > data.results.length - 1) setSelected(Math.max(0, data.results.length - 1))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data])

  const list = useMemo(() => data?.results ?? [], [data])
  const current = list[Math.min(selected, list.length - 1)]
  const openHere = list.filter((f) => f.open)
  const chosenFlags = openHere.filter((f) => chosen.has(f.id))
  const toggle = (id: string) =>
    setChosen((s) => {
      const n = new Set(s)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })
  const allChosen = openHere.length > 0 && chosenFlags.length === openHere.length

  const keys = useMemo(
    () => ({
      j: () => setSelected((i) => Math.min(i + 1, Math.max(0, list.length - 1))),
      k: () => setSelected((i) => Math.max(0, i - 1)),
      x: () => current?.open && toggle(current.id),
      r: () => {
        if (current?.open) setResolving([current])
      },
    }),
    [list.length, current]
  )
  useQueueKeys(keys, allowed && list.length > 0)

  if (!allowed) {
    return (
      <div className="page py-8">
        <NotOpen message="Flags are raised and reviewed by the research office, the coordinator, the Principal and the super admin. By the college's rule they are not shown to the Director, Finance or the claimant." />
      </div>
    )
  }

  const summary = data?.summary
  const groups = summary?.groups ?? []
  const filtered = Boolean(paid || rule || claim) || status !== "open"
  const ruleName = groups.find((g) => g.rule === rule)?.headline ?? data?.results[0]?.headline
  const needle = search.trim().toLowerCase()
  const shown = needle
    ? list.filter((f) =>
        [f.claim.paper_title, f.claim.owner_name, f.claim.ticket_number, f.headline, f.note].some((v) =>
          String(v ?? "").toLowerCase().includes(needle)
        )
      )
    : list
  function clearAll() {
    setSearch("")
    setSearchParams(new URLSearchParams())
    setSelected(0)
    setChosen(new Set())
  }

  const columns: Column<FlagWithClaim>[] = [
    {
      key: "choose",
      header: (
        <Checkbox
          checked={allChosen}
          disabled={openHere.length === 0}
          onCheckedChange={() => setChosen(allChosen ? new Set() : new Set(openHere.map((f) => f.id)))}
          aria-label={chosenFlags.length > 0 ? `${chosenFlags.length} chosen` : `Choose all ${openHere.length} shown`}
        />
      ),
      label: "Choose",
      className: "w-10",
      cell: (f) =>
        f.open ? (
          <Checkbox
            checked={chosen.has(f.id)}
            onCheckedChange={() => toggle(f.id)}
            aria-label={`Choose the flag on ${f.claim.ticket_number ?? "this claim"}`}
          />
        ) : null,
    },
    {
      key: "claim",
      header: "Paper and claimant",
      exportValue: (f) =>
        [unshout(f.claim.paper_title) || "Untitled paper", f.claim.owner_name, f.claim.ticket_number].filter(Boolean).join(", "),
      cell: (f) => {
        const c = f.claim
        return (
          <div className="flex min-w-0 items-start gap-2.5">
            <Avatar size="sm" person={{ name: c.owner_name, initials: initialsOf(c.owner_name), photo_url: c.owner_photo_url ?? null }} />
            <span className="min-w-0">
              <Link
                to={`/papers/${c.id}`}
                className="line-clamp-2 break-words [overflow-wrap:anywhere] font-medium text-fg underline-offset-4 hover:underline"
              >
                {unshout(c.paper_title) || "Untitled paper"}
              </Link>
              <Meta className="block truncate">{[c.owner_name, c.owner_department].filter(Boolean).join(" · ") || "No department"}</Meta>
              <Meta className="block truncate">
                <ClaimNo ticket={c.ticket_number} origin={c.origin} />
              </Meta>
            </span>
          </div>
        )
      },
    },
    {
      key: "question",
      header: "The question",
      exportValue: (f) =>
        [f.headline, f.note, raisedByLine(f), f.open ? "" : `Resolved: ${f.resolution_note || "No reason was recorded."}`]
          .filter(Boolean)
          .join(". "),
      cell: (f, i) => {
        const same = i > 0 && shown[i - 1].open === f.open && shown[i - 1].headline === f.headline && shown[i - 1].note === f.note
        return <FlagQuestion flag={f} same={same} />
      },
    },
    {
      key: "stands",
      header: "Where it stands",
      exportValue: (f) => {
        const c = f.claim
        const where = c.status === "PAID" && c.paid_at ? "Paid" : staffStage(c.status).label
        return `${where}, ${c.remuneration != null ? money(c.remuneration) : "no amount recorded"}`
      },
      cell: (f) => {
        const c = f.claim
        const stage = staffStage(c.status)
        const isPaid = c.status === "PAID"
        return (
          <div className="min-w-0">
            <span className={cn("block", stage.tone === "done" ? "text-positive" : stage.tone === "attention" ? "text-critical" : "text-fg")}>
              {isPaid && c.paid_at ? `Paid on ${paidDate(c.paid_at)}` : stage.label}
            </span>
            {c.remuneration != null ? (
              <span className={cn("block tabular", f.open && isPaid && (c.remuneration ?? 0) > 0 ? "font-medium text-critical" : "text-fg-muted")}>
                {money(c.remuneration)}
                {isPaid ? " paid" : " at stake"}
              </span>
            ) : (
              <span className="block text-fg-muted">No amount recorded</span>
            )}
          </div>
        )
      },
    },
    {
      key: "act",
      header: <span className="sr-only">Resolve</span>,
      label: "Resolve",
      cell: (f) =>
        f.open ? (
          <Button
            kind="default"
            size="sm"
            onClick={() => setResolving([f])}
            aria-label={`Resolve the flag on ${f.claim.ticket_number ?? "this claim"}`}
          >
            Resolve
          </Button>
        ) : null,
    },
  ]

  return (
    <div className="page space-y-6">
      <PageHeader
        title="Flags"
        sub="Doubts raised on claims, and how each was answered. A flag never holds a claim back."
      />

      <Answer
        items={[
          { label: "Open, not yet answered", value: summary?.open, to: "/flags", zero: "Nothing waiting" },
          { label: "Open on claims already paid", value: summary?.open_on_paid, to: "/flags?paid=yes", zero: "None on paid claims", tone: "critical" },
          { label: "Answered, with the reason kept", value: summary?.resolved, to: "/flags?status=resolved", zero: "None answered yet" },
        ]}
      />

      <div className={filterBar} role="search">
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search paper, claimant or claim no."
          aria-label="Search the flags on this page"
          className="w-full min-w-0 sm:w-80"
        />
        <Select aria-label="Status" value={status} onChange={(e) => setParam("status", e.target.value === "open" ? "" : e.target.value)} className="w-auto max-sm:w-full">
          {STATUS_FILTERS.map((f) => (
            <option key={f.value} value={f.value}>
              {f.label}
            </option>
          ))}
        </Select>
        <Select aria-label="Paid" value={paid} onChange={(e) => setParam("paid", e.target.value)} className="w-auto max-sm:w-full">
          {PAID_FILTERS.map((f) => (
            <option key={f.value || "any"} value={f.value}>
              {f.label}
            </option>
          ))}
        </Select>
        {groups.length > 0 && status !== "resolved" && !claim && (
          <Select
            aria-label="What the open flags are about"
            value={rule}
            onChange={(e) => setParam("rule", e.target.value)}
            className="w-auto max-w-full max-sm:w-full"
          >
            <option value="">Every question</option>
            {groups.map((g) => (
              <option key={g.rule} value={g.rule}>
                {g.headline} ({g.open.toLocaleString("en-IN")} open
                {g.open_on_paid > 0 ? `, ${g.open_on_paid.toLocaleString("en-IN")} on paid claims` : ""})
              </option>
            ))}
          </Select>
        )}
        {(filtered || needle) && (
          <Button kind="quiet" onClick={clearAll}>
            {claim ? "One claim only. Show all" : "Clear filters"}
          </Button>
        )}
      </div>
      <p className="hidden text-sm text-fg-muted sm:block">
        Keys: <Kbd>j</Kbd> <Kbd>k</Kbd> move, <Kbd>x</Kbd> choose, <Kbd>r</Kbd> resolve.
        {claim ? " Showing every flag on one claim." : ruleName ? ` Showing: ${ruleName}.` : ""}
      </p>

      {chosenFlags.length > 0 && (
        <div
          role="region"
          aria-label="Chosen flags"
          className="sticky top-14 z-20 flex flex-wrap items-center justify-between gap-3 rounded-panel bg-surface px-4 py-3 shadow-pop ring-1 ring-edge md:top-2"
        >
          <p className="text-sm">
            <span className="font-semibold">{chosenFlags.length}</span> chosen
          </p>
          <div className="flex items-center gap-2">
            <Button kind="default" onClick={() => setChosen(new Set())}>
              Clear selection
            </Button>
            <Button kind="primary" onClick={() => setResolving(chosenFlags)}>
              Resolve {chosenFlags.length} {chosenFlags.length === 1 ? "flag" : "flags"}
            </Button>
          </div>
        </div>
      )}

      {isLoading && !data ? (
        <SkeletonRows rows={5} rowHeight={88} />
      ) : isError ? (
        <ErrorState
          title="Could not load the flags"
          message={
            error?.status === 403
              ? "Not allowed. Flags are for the research office, the coordinator, the Principal and the super admin."
              : "The server did not answer. Nothing has been resolved or changed."
          }
          onRetry={error?.status === 403 ? false : () => refetch()}
        />
      ) : (
        <div className="space-y-3">
          <Table
            rows={shown}
            columns={columns}
            getKey={(f) => f.id}
            maxHeight="none"
            caption={claim ? "Every flag on this claim" : status === "resolved" ? "Answered flags" : status === "all" ? "All flags" : "Open flags"}
            isCurrent={(f) => f.id === current?.id}
            tools={{ id: "flags", title: "Flags" }}
            empty={{
              art: filtered || needle ? "no-results" : "empty-queue",
              icon: CircleCheck,
              title: filtered || needle ? "Nothing matches these filters" : "No open flags",
              message:
                filtered || needle
                  ? "No flag is in that state. Show every flag, or try another filter."
                  : "Nobody has raised a question that is still unanswered, and the file and import checks have found nothing open. To raise one, open a claim and choose Flag.",
              action:
                filtered || needle ? (
                  <Button kind="default" asChild>
                    <Link to="/flags?status=all">Show every flag</Link>
                  </Button>
                ) : (
                  <Button kind="default" asChild>
                    <Link to="/archive">Look through past claims</Link>
                  </Button>
                ),
            }}
          />
          {list.some((f) => !!f.claim.origin) && (
            <p className="text-sm text-fg-muted">
              Numbers that start with ERP were brought across from the old ERP workbook. Hover one to see which sheet.
            </p>
          )}
          <Pagination
            page={page}
            pageSize={PAGE_SIZE}
            total={data?.total ?? 0}
            onChange={(next) => setParam("page", next > 0 ? String(next) : "")}
          />
        </div>
      )}

      <ResolveDialog
        flags={resolving}
        onClose={() => {
          setResolving([])
          setChosen(new Set())
        }}
      />
    </div>
  )
}

function paidDate(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ""
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })
}

const LONG_NOTE = 200

/** The question a flag asks, its note, who raised it and, once answered, the answer. */
function FlagQuestion({ flag, same }: { flag: FlagWithClaim; same: boolean }) {
  const [more, setMore] = useState(false)
  const long = flag.note.length > LONG_NOTE
  return (
    <div className={cn("min-w-0", !flag.open && "text-fg-muted")}>
      {same && flag.open ? (
        <p className="text-sm text-fg-muted">Same question and answer as the row above.</p>
      ) : (
        <>
          <p className="break-words text-base font-medium text-fg [overflow-wrap:anywhere]">{flag.headline}</p>
          <p
            className={cn(
              "mt-0.5 text-sm text-pretty break-words [overflow-wrap:anywhere]",
              !more && long && "line-clamp-2",
              flag.open ? "text-fg" : "text-fg-muted"
            )}
          >
            {flag.note}
          </p>
        </>
      )}
      {long && !(same && flag.open) && (
        <button
          type="button"
          aria-expanded={more}
          onClick={() => setMore((m) => !m)}
          className="mt-0.5 text-sm text-accent underline-offset-4 hover:underline"
        >
          {more ? "Show less" : "Show all"}
        </button>
      )}
      <Meta className="mt-1 block">
        {raisedByLine(flag)}
        {flag.raised_at && (
          <>
            {" · "}
            <When iso={flag.raised_at} />
          </>
        )}
        {" · "}
        <Link to={`/flags?claim=${flag.claim.id}&status=all`} className="underline-offset-4 hover:underline">
          All flags on this claim
        </Link>
      </Meta>
      {!flag.open && (
        <div className="mt-2 rounded-control bg-sunken px-3 py-2 text-sm">
          <p className="text-fg-muted">
            Resolved{flag.resolved_by_name ? ` by ${flag.resolved_by_name}` : " by a check"}
            {flag.resolved_at ? (
              <>
                {" · "}
                <When iso={flag.resolved_at} />
              </>
            ) : null}
          </p>
          <p className="mt-0.5 text-fg">{flag.resolution_note || "No reason was recorded."}</p>
        </div>
      )}
    </div>
  )
}

function Kbd({ children }: { children: React.ReactNode }) {
  return <kbd className="rounded-sm border border-line bg-sunken px-1 font-mono text-xs text-fg">{children}</kbd>
}
