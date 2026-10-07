import { useEffect, useMemo, useState } from "react"
import { Link, useSearchParams } from "react-router-dom"
import { CircleCheck } from "lucide-react"

import { useAuth } from "@/app/auth"
import { reviewsFlags } from "@/app/nav"
import { cn } from "@/lib/cn"
import { useApi } from "@/lib/query"
import { FlagLine, ResolveDialog, type FlagGroup, type FlagWithClaim } from "@/pages/cell/flag-parts"
import { Button } from "@/ui/button"
import { Checkbox } from "@/ui/field"
import { Answer } from "@/ui/answer"
import { PageHeader } from "@/ui/page-header"
import { Section } from "@/ui/section"
import { Pagination } from "@/ui/pagination"
import { EmptyState, ErrorState, SkeletonRows } from "@/ui/state"
import { ColumnLabel, Meta, SectionTitle } from "@/ui/text"
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
        <ErrorState
          art="closed-gate"
          title="Not open to this account"
          message="Flags are raised and reviewed by the research office, the coordinator, the Principal and the super admin. By the college's rule they are not shown to the Director, Finance or the claimant."
        />
      </div>
    )
  }

  const summary = data?.summary
  const groups = summary?.groups ?? []
  const filtered = Boolean(paid || rule || claim) || status !== "open"
  const showGroups = status !== "resolved" && !claim && groups.length > 0
  const ruleName = groups.find((g) => g.rule === rule)?.headline ?? data?.results[0]?.headline

  return (
    <div className="page space-y-8">
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

      {showGroups && (
        <Section title="What the open flags are about" id="flag-groups">
          <div className="hidden grid-cols-[minmax(0,1fr)_6rem_8rem_5rem] gap-x-4 px-2 pt-2 sm:grid">
            <ColumnLabel className="block">Question</ColumnLabel>
            <ColumnLabel className="block text-right">Open</ColumnLabel>
            <ColumnLabel className="block text-right">On paid claims</ColumnLabel>
            <span />
          </div>
          <ul className="divide-y divide-line">
            {groups.map((g) => {
              const on = rule === g.rule
              return (
                <li
                  key={g.rule}
                  className={cn(
                    "row grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 py-2.5 sm:grid-cols-[minmax(0,1fr)_6rem_8rem_5rem] sm:px-2",
                    on && "bg-accent-wash"
                  )}
                >
                  <span className="text-base">{g.headline}</span>
                  <span className="text-sm tabular text-fg-muted sm:text-right sm:text-base sm:text-fg">
                    <span className="sm:hidden">Open </span>
                    <span className="font-semibold">{g.open.toLocaleString("en-IN")}</span>
                  </span>
                  <span className={cn("text-sm tabular sm:text-right sm:text-base", g.open_on_paid > 0 ? "text-critical" : "text-fg-muted")}>
                    <span className="sm:hidden">On paid claims </span>
                    <span className={cn(g.open_on_paid > 0 && "font-semibold")}>{g.open_on_paid.toLocaleString("en-IN")}</span>
                  </span>
                  <span className="sm:text-right">
                    <Button kind={on ? "quiet" : "default"} size="sm" onClick={() => setParam("rule", on ? "" : g.rule)} aria-pressed={on}>
                      {on ? "Show all" : "Show"}
                    </Button>
                  </span>
                </li>
              )
            })}
          </ul>
        </Section>
      )}

      <section aria-labelledby="flag-list" className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <SectionTitle>
            <span id="flag-list">
              {claim ? "Every flag on this claim" : rule && ruleName ? ruleName : status === "resolved" ? "Answered flags" : status === "all" ? "All flags" : "Open flags"}
            </span>
          </SectionTitle>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Status">
              {STATUS_FILTERS.map((f) => (
                <Chip key={f.value} active={status === f.value} onClick={() => setParam("status", f.value === "open" ? "" : f.value)}>
                  {f.label}
                </Chip>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Paid">
              {PAID_FILTERS.map((f) => (
                <Chip key={f.value || "any"} active={paid === f.value} onClick={() => setParam("paid", f.value)}>
                  {f.label}
                </Chip>
              ))}
            </div>
            {(claim || rule) && (
              <Chip
                active
                onClick={() => {
                  setSearchParams((prev) => {
                    const next = new URLSearchParams(prev)
                    next.delete("claim")
                    next.delete("rule")
                    next.delete("page")
                    return next
                  })
                }}
              >
                {claim ? "One claim only · show all" : "One question only · show all"}
              </Chip>
            )}
          </div>
        </div>

        {openHere.length > 0 && (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg bg-sunken px-3 py-2">
            <Checkbox
              checked={allChosen}
              onCheckedChange={() => setChosen(allChosen ? new Set() : new Set(openHere.map((f) => f.id)))}
              label={chosenFlags.length > 0 ? `${chosenFlags.length} chosen` : `Choose all ${openHere.length} shown`}
            />
            <span className="flex-1" />
            <Meta className="hidden sm:inline">
              <Kbd>j</Kbd> <Kbd>k</Kbd> move · <Kbd>x</Kbd> choose · <Kbd>r</Kbd> resolve
            </Meta>
            <Button kind="primary" size="sm" disabled={chosenFlags.length === 0} onClick={() => setResolving(chosenFlags)}>
              {chosenFlags.length > 0 ? `Resolve ${chosenFlags.length} ${chosenFlags.length === 1 ? "flag" : "flags"}` : "Resolve chosen flags"}
            </Button>
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
        ) : list.length === 0 ? (
          <EmptyState
            art={filtered ? "no-results" : "empty-queue"}
            icon={CircleCheck}
            title={filtered ? "Nothing matches these filters" : "No open flags"}
            message={
              filtered
                ? "No flag is in that state. Show every flag, or try another filter."
                : "Nobody has raised a question that is still unanswered, and the file and import checks have found nothing open. To raise one, open a claim and choose Flag."
            }
            action={
              filtered ? (
                <Button kind="default" asChild>
                  <Link to="/flags?status=all">Show every flag</Link>
                </Button>
              ) : (
                <Button kind="default" asChild>
                  <Link to="/archive">Look through past claims</Link>
                </Button>
              )
            }
          />
        ) : (
          <>
            <ul className="divide-y divide-line">
              {list.map((f, i) => (
                <FlagLine
                  key={f.id}
                  flag={f}
                  selected={current?.id === f.id}
                  chosen={chosen.has(f.id)}
                  onChoose={() => toggle(f.id)}
                  onSelect={() => setSelected(i)}
                  onResolve={() => setResolving([f])}
                  same={i > 0 && list[i - 1].open === f.open && list[i - 1].headline === f.headline && list[i - 1].note === f.note}
                />
              ))}
            </ul>
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
          </>
        )}
      </section>

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

function Kbd({ children }: { children: React.ReactNode }) {
  return <kbd className="rounded-sm border border-line bg-sunken px-1 font-mono text-xs text-fg">{children}</kbd>
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "h-7 rounded-sm px-2 text-sm transition-colors duration-[var(--dur-1)] ease-out max-sm:h-10 max-sm:px-3",
        active ? "bg-selected font-medium text-fg" : "text-fg-muted hover:bg-hover hover:text-fg"
      )}
    >
      {children}
    </button>
  )
}
