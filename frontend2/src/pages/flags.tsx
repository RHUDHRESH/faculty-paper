import { useEffect, useMemo, useState } from "react"
import { useSearchParams } from "react-router-dom"
import { CircleCheck } from "lucide-react"

import { useAuth } from "@/app/auth"
import { reviewsFlags } from "@/app/nav"
import { cn } from "@/lib/cn"
import { useApi } from "@/lib/query"
import { Combobox, type ComboboxOption } from "@/ui/combobox"
import { money, Stage, stageOf } from "@/ui/paper"
import { Pagination } from "@/ui/pagination"
import { EmptyState, ErrorState, SkeletonRows } from "@/ui/state"
import { ColumnLabel, Meta, PageTitle, Sub } from "@/ui/text"
import {
  ClaimLine,
  FLAG_KINDS,
  FlagRow,
  ResolveFlagDialog,
  type ClaimFlag,
} from "@/pages/claim-review"
import { HeaderSpot } from "@/ui/page-header"
import { Avatar, initialsOf } from "@/ui/person"
import { useQueueKeys } from "@/ui/queue-keys"

/**
 * Every discrepancy flag in one queue -- the super admin's list of questions
 * about claims, raised by a reviewer or by the checks that read each claim's
 * files and the imported history.
 *
 * A queue of questions, not of blocked work: a flagged claim is paid as
 * normal. So the figure this page leads with is how many flags are open on
 * claims already paid -- money that went out with a question still on it,
 * which is the case the super admin is notified about.
 */

const PAGE_SIZE = 25

type FlagWithClaim = ClaimFlag & {
  claim: {
    id: string
    ticket_number: string | null
    paper_title: string | null
    owner_name: string
    owner_photo_url?: string | null
    owner_department: string | null
    status: string
    remuneration: number | null
    paid_at: string | null
  }
}

type FlagsPayload = {
  total: number
  limit: number
  offset: number
  results: FlagWithClaim[]
  summary: { open: number; resolved: number; open_on_paid: number }
}

const STATUS_FILTERS = [
  { value: "open", label: "Open" },
  { value: "resolved", label: "History" },
  { value: "all", label: "All" },
]

const PAID_FILTERS = [
  { value: "", label: "Paid or not" },
  { value: "yes", label: "Paid" },
  { value: "no", label: "Not yet paid" },
]

const KIND_OPTIONS: ComboboxOption[] = [
  { value: "", label: "Any kind" },
  ...FLAG_KINDS.map((k) => ({ value: k.value, label: k.label })),
]

export function Flags() {
  const { me } = useAuth()
  const allowed = reviewsFlags(me?.role)
  const [searchParams, setSearchParams] = useSearchParams()
  const status = searchParams.get("status") || "open"
  const kind = searchParams.get("kind") ?? ""
  const paid = searchParams.get("paid") ?? ""
  // A notification links here with the claim it was about.
  const claim = searchParams.get("claim") ?? ""
  const page = Math.max(0, Number.parseInt(searchParams.get("page") ?? "0", 10) || 0)
  const [resolving, setResolving] = useState<ClaimFlag | null>(null)
  const [selected, setSelected] = useState(0)

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

  const query = new URLSearchParams({ status })
  if (kind) query.set("kind", kind)
  if (paid) query.set("paid", paid)
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
  const keys = useMemo(
    () => ({
      j: () => setSelected((i) => Math.min(i + 1, Math.max(0, list.length - 1))),
      k: () => setSelected((i) => Math.max(0, i - 1)),
      r: () => {
        if (current?.open) setResolving(current)
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
          message="Flags are raised and reviewed by the research cell, the coordinator, the Principal and the super admin. By the college's rule they are not shown to the Director, Finance or the claimant."
        />
      </div>
    )
  }

  const flags = data?.results ?? []
  const summary = data?.summary
  const filtered = Boolean(kind || paid || claim) || status !== "open"

  return (
    <div className="page space-y-6">
      <header className="page-head">
        <div>
        <PageTitle>Flags</PageTitle>
        <Sub className="mt-1">
          Questions about claims, raised by a reviewer or by the checks that read each claim&rsquo;s
          files. A flag never holds a claim back: it is paid as normal, and the super admin is told
          when money goes out with one still open.
        </Sub>
        </div>
        <HeaderSpot name="spot-flags" />
      </header>

      {summary && (
        <div className="flex flex-wrap items-baseline gap-x-8 gap-y-3 border-y border-line py-3">
          <Stat label="Open" value={summary.open} />
          <Stat label="Open on paid claims" value={summary.open_on_paid} tone={summary.open_on_paid > 0 ? "critical" : undefined} />
          <Stat label="Resolved" value={summary.resolved} />
        </div>
      )}

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
        <Combobox
          value={kind}
          onChange={(v) => setParam("kind", v)}
          options={KIND_OPTIONS}
          aria-label="Kind of flag"
          className="w-full sm:w-60"
        />
        {claim && (
          <Chip active onClick={() => setParam("claim", "")}>
            One claim only · show all
          </Chip>
        )}
      </div>

      {flags.length > 0 && (
        <Meta className="hidden sm:block">
          <Kbd>j</Kbd> <Kbd>k</Kbd> to move · <Kbd>r</Kbd> to resolve the selected flag
        </Meta>
      )}

      {isLoading && !data ? (
        <SkeletonRows rows={5} rowHeight={112} />
      ) : isError ? (
        <ErrorState
          title="Could not load the flags"
          message={
            error?.status === 403
              ? "Not allowed. Flags are for the research cell, the coordinator, the Principal and the super admin."
              : "The server did not answer. Nothing has been resolved or changed."
          }
          onRetry={error?.status === 403 ? undefined : () => refetch()}
        />
      ) : flags.length === 0 ? (
        <EmptyState
          art={filtered ? "no-results" : "empty-queue"}
          icon={CircleCheck}
          title={filtered ? "Nothing matches these filters" : "No open flags"}
          message={
            filtered
              ? "No flag is in that state. Try another filter."
              : "Nobody has raised a question that is still unanswered, and the file and import checks have found nothing open."
          }
        />
      ) : (
        <>
          <ul className="divide-y divide-line border-y border-line">
            {flags.map((f, i) => (
              <FlagRow
                key={f.id}
                selected={current?.id === f.id}
                onSelect={() => setSelected(i)}
                flag={f}
                onResolve={() => setResolving(f)}
                claimLink={
                  <div className="space-y-1">
                    <div className="flex min-w-0 items-start gap-2">
                      <Avatar
                        person={{ name: f.claim.owner_name, initials: initialsOf(f.claim.owner_name), photo_url: f.claim.owner_photo_url ?? null }}
                        size="sm"
                      />
                      <ClaimLine claim={f.claim} />
                    </div>
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      <Stage stage={stageOf(f.claim.status)} className="w-[8rem]" />
                      {f.claim.remuneration != null && (
                        <span
                          className={cn(
                            "text-sm font-medium tabular",
                            f.open && f.claim.status === "PAID" && "text-critical"
                          )}
                        >
                          {money(f.claim.remuneration)}
                          {f.claim.status === "PAID" ? " paid" : " at stake"}
                        </span>
                      )}
                      {f.claim.status === "PAID" && f.claim.paid_at && (
                        <Meta>on {formatDate(f.claim.paid_at)}</Meta>
                      )}
                    </div>
                  </div>
                }
              />
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

      <ResolveFlagDialog flag={resolving} onClose={() => setResolving(null)} />
    </div>
  )
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="rounded-sm border border-line bg-sunken px-1 font-mono text-xs text-fg">{children}</kbd>
  )
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: "critical" }) {
  return (
    <div>
      <ColumnLabel className="block">{label}</ColumnLabel>
      <p className={cn("mt-0.5 text-lg font-semibold tabular", tone === "critical" && "text-critical")}>
        {value}
      </p>
    </div>
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

function formatDate(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ""
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })
}
