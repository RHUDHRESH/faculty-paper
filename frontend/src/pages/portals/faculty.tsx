"use client"

import { useEffect, useMemo, useState } from "react"
import { Link, useNavigate, useSearchParams } from "react-router-dom"
import { FileText, Plus, Search } from "lucide-react"
import { toast } from "sonner"

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"

import {
  EmptyState,
  ErrorState,
  FilterBar,
  MasterDetail,
  PageHeader,
  StatStrip,
} from "@/components/layout/page"
import {
  ContestCallout,
  CopyTicketLink,
  formatMoney,
  Money,
  StatusBanner,
  StatusChip,
  StatusTimeline,
  statusLabel,
} from "@/components/ticket-ui"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Skeleton } from "@/components/ui/skeleton"
import { ClaimDetailFields } from "@/components/claim-detail-fields"
import { PublicationForm } from "@/components/publication-form"
import { api, type Claim, type Paginated } from "@/lib/api"
import { actionSentence } from "@/lib/claim-actions"
import { Pager } from "@/components/ui/pagination"
import { useApiQuery } from "@/lib/queries"
import { useIsDesktop } from "@/lib/use-media-query"
import { cn } from "@/lib/utils"

// ─── Shared claim detail ──────────────────────────────────────────────────────

function TicketDetail({ claim, onChanged }: { claim: Claim; onChanged?: (c: Claim) => void }) {
  const isTerminal = claim.status === "REJECTED" || claim.status === "PAID"
  const [confirmWithdraw, setConfirmWithdraw] = useState(false)
  const [withdrawing, setWithdrawing] = useState(false)

  async function withdraw() {
    setWithdrawing(true)
    try {
      const c = await api<Claim>(`/api/claims/${claim.id}/withdraw`, {
        method: "POST",
        json: {},
      })
      toast.success("Ticket withdrawn — it is a draft again, edit and resubmit when ready")
      setConfirmWithdraw(false)
      onChanged?.(c)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not withdraw the ticket")
    } finally {
      setWithdrawing(false)
    }
  }

  return (
    <div className="space-y-5">
      {isTerminal ? (
        <StatusBanner status={claim.status} note={claim.status_note} />
      ) : (
        <StatusTimeline status={claim.status} />
      )}

      {claim.contest_forward && <ContestCallout note={claim.contest_note} />}

      <ClaimDetailFields claim={claim} />

      {/* Who did what, when — the claimant could not see their own ticket's
          history at all before this. */}
      {(claim.actions || []).length > 0 ? (
        <div className="rounded-[var(--radius)] border border-border/80 bg-card p-4">
          <p className="mb-2 text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
            History
          </p>
          <ul className="space-y-1.5 text-sm">
            {(claim.actions || []).map((a) => (
              <li key={a.id} className="text-muted-foreground">
                <span className="font-medium text-foreground">{a.actor_name}</span>{" "}
                {actionSentence(a.action)}
                {a.note ? <span className="block pl-3 text-xs italic">“{a.note}”</span> : null}
                <span className="block pl-3 text-xs tabular-nums opacity-80">
                  {new Date(a.created_at).toLocaleString()}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {(claim.status === "DRAFT" || claim.status === "REJECTED") && (
        <Button asChild className="w-full">
          <Link to={`/faculty/new?edit=${claim.id}`}>Edit &amp; resubmit</Link>
        </Button>
      )}

      {claim.status === "SUBMITTED" && (
        <>
          <Button
            variant="outline"
            className="w-full"
            disabled={withdrawing}
            onClick={() => setConfirmWithdraw(true)}
          >
            Withdraw &amp; edit
          </Button>
          <AlertDialog open={confirmWithdraw} onOpenChange={setConfirmWithdraw}>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Withdraw this ticket?</AlertDialogTitle>
                <AlertDialogDescription>
                  It goes back to being a draft — out of the review queue — and keeps its
                  ticket number. Submit again when you have fixed it.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  disabled={withdrawing}
                  onClick={(e) => {
                    e.preventDefault()
                    withdraw()
                  }}
                >
                  Withdraw
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </>
      )}
    </div>
  )
}

// ─── Claims list ──────────────────────────────────────────────────────────────

// Includes the old-chain statuses: ERP-imported tickets still carry them, and
// without an option here those tickets were unreachable through the filter.
const STATUS_OPTIONS: { value: string; label: string }[] = [
  { value: "ALL", label: "All statuses" },
  { value: "DRAFT", label: statusLabel("DRAFT") },
  { value: "SUBMITTED", label: statusLabel("SUBMITTED") },
  { value: "CLEARED", label: statusLabel("CLEARED") },
  { value: "PAID", label: statusLabel("PAID") },
  { value: "REJECTED", label: statusLabel("REJECTED") },
  { value: "HOD_APPROVED", label: "Approved by HoD (old flow)" },
  { value: "PRINCIPAL_APPROVED", label: "Principal approved (old flow)" },
  { value: "FINANCE_APPROVED", label: "Finance approved (old flow)" },
  { value: "RESEARCH_APPROVED", label: "Research approved (old flow)" },
]

export function FacultyClaimsPage() {
  const [selected, setSelected] = useState<Claim | null>(null)
  const [params] = useSearchParams()
  // Stat cards and notification links arrive as /faculty?status=… — start the
  // filter where the link pointed.
  const [filter, setFilter] = useState(() => {
    const s = params.get("status")
    return s && STATUS_OPTIONS.some((o) => o.value === s) ? s : "ALL"
  })
  const [search, setSearch] = useState("")
  const [sheetOpen, setSheetOpen] = useState(false)
  // On desktop the detail shows inline, so the sheet must stay shut: an open
  // sheet up here renders an invisible overlay that freezes the whole page.
  const isDesktop = useIsDesktop()

  // A failed load renders ErrorState with a retry — it used to fall through
  // to the "No tickets yet" empty state.
  const [offset, setOffset] = useState(0)
  const [sort, setSort] = useState("recent")
  const PAGE = 50
  const {
    data: page,
    isLoading: loading,
    isError,
    refetch,
  } = useApiQuery<Paginated<Claim>>(
    ["claims", "mine", filter, offset, sort],
    `/api/claims?limit=${PAGE}&offset=${offset}&sort=${sort}` +
      (filter === "ALL" ? "" : `&status=${filter}`)
  )
  const claims = page?.results ?? []

  // Same scoped numbers the oversight portals get — for faculty they are the
  // person's own totals, which the portal never showed anywhere.
  const { data: dash } = useApiQuery<{
    by_status?: Record<string, number>
    total_paid?: number
  }>(["dashboard", "mine"], "/api/dashboard")
  const by = dash?.by_status || {}

  useEffect(() => {
    const id = params.get("claim")
    if (!id) return
    api<Claim>(`/api/claims/${id}`)
      .then((c) => {
        setSelected(c)
        setSheetOpen(!isDesktop)
      })
      .catch(() => {
        /* deep link to something no longer visible */
      })
  }, [params])

  // The stat cards navigate within this page (?status=…), so param changes
  // after mount drive the filter too.
  useEffect(() => {
    const s = params.get("status")
    if (s && STATUS_OPTIONS.some((o) => o.value === s) && s !== filter) {
      setFilter(s)
      setOffset(0)
      setSelected(null)
    }
  }, [params])

  // The status filter runs server-side now (it narrows the whole account, not
  // just the current page); only the text search stays client-side.
  const shown = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return claims
    return claims.filter(
      (c) =>
        (c.ticket_number || "").toLowerCase().includes(q) ||
        (c.paper_title || "").toLowerCase().includes(q) ||
        (c.journal_title || "").toLowerCase().includes(q)
    )
  }, [claims, search])

  // Growing past the breakpoint while the sheet is open would otherwise leave
  // its overlay covering a page that now shows the detail inline anyway.
  useEffect(() => {
    if (isDesktop) setSheetOpen(false)
  }, [isDesktop])

  // Desktop opened on a large "Select a ticket" placeholder beside a list the
  // user was going to click regardless. Show the first ticket instead.
  useEffect(() => {
    if (!isDesktop || selected || !shown.length) return
    api<Claim>(`/api/claims/${shown[0].id}`)
      .then(setSelected)
      .catch(() => {
        /* the placeholder is a fine fallback */
      })
  }, [isDesktop, selected, shown])

  async function openClaim(id: string) {
    const c = await api<Claim>(`/api/claims/${id}`)
    setSelected(c)
    setSheetOpen(!isDesktop)
  }

  const listPanel = (
    <div className="space-y-3">
      {/* The person's own numbers — the portal never summarised them before. */}
      {dash ? (
        <StatStrip
          items={[
            {
              label: "Received to date",
              value: formatMoney(dash.total_paid || 0),
            },
            {
              label: "In review",
              value: (by.SUBMITTED || 0) + (by.HOD_APPROVED || 0),
              to: "/faculty?status=SUBMITTED",
            },
            {
              label: "With Finance",
              value:
                (by.CLEARED || 0) +
                (by.PRINCIPAL_APPROVED || 0) +
                (by.FINANCE_APPROVED || 0) +
                (by.RESEARCH_APPROVED || 0),
              to: "/faculty?status=CLEARED",
            },
            {
              label: "Needs your action",
              value: (by.DRAFT || 0) + (by.REJECTED || 0),
              to: "/faculty?status=REJECTED",
            },
          ]}
        />
      ) : null}
      <FilterBar>
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="pl-9"
            placeholder="Search tickets…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <Select
          value={filter}
          onValueChange={(v) => {
            setFilter(v)
            setOffset(0)
            setSelected(null)
          }}
        >
          <SelectTrigger className="w-full sm:w-[200px]">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            {STATUS_OPTIONS.map((s) => (
              <SelectItem key={s.value} value={s.value}>
                {s.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={sort}
          onValueChange={(v) => {
            setSort(v)
            setOffset(0)
          }}
        >
          <SelectTrigger className="w-full sm:w-[180px]" aria-label="Sort tickets">
            <SelectValue placeholder="Sort" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="recent">Most recent</SelectItem>
            <SelectItem value="amount">Highest amount</SelectItem>
            <SelectItem value="title">Title</SelectItem>
          </SelectContent>
        </Select>
      </FilterBar>

      {loading ? (
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-16 w-full rounded-[var(--radius)]" />
          ))}
        </div>
      ) : isError ? (
        <ErrorState
          title="Could not load your tickets"
          description="The server did not respond. Your tickets are safe — try again."
          onRetry={() => refetch()}
        />
      ) : shown.length === 0 ? (
        <EmptyState
          title="No tickets yet"
          description="Submit a publication to get a ticket number."
          icon={<FileText className="size-5" />}
          action={
            <Button asChild>
              <Link to="/faculty/new">
                <Plus className="size-4" />
                New ticket
              </Link>
            </Button>
          }
        />
      ) : (
        // Stacked, not tabled. MasterDetail caps this panel at 380px, so the
        // old four-column grid — keyed off `md:`, a *viewport* breakpoint —
        // never had room: the fixed columns alone came to 320px and squeezed
        // the paper title down to 34px while the amount overflowed the card.
        <div className="overflow-hidden rounded-[var(--radius)] border border-border/80 bg-card">
          {shown.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => openClaim(c.id)}
              className={cn(
                "flex w-full flex-col gap-1.5 border-b border-border px-4 py-3 text-left transition-colors last:border-0 hover:bg-muted/50",
                selected?.id === c.id && "bg-muted/40"
              )}
            >
              <span className="flex items-center justify-between gap-2">
                <span className="font-mono text-xs text-muted-foreground">
                  {c.ticket_number || "—"}
                </span>
                <StatusChip status={c.status} contest={c.contest_forward} />
              </span>
              <span className="line-clamp-2 text-sm font-medium leading-snug text-foreground">
                {c.paper_title || "Untitled"}
              </span>
              <span className="flex items-baseline justify-between gap-2">
                <span className="line-clamp-1 min-w-0 text-xs text-muted-foreground">
                  {c.journal_title || "No journal"}
                </span>
                <span className="shrink-0 text-sm font-medium tabular-nums">
                  <Money value={c.remuneration} />
                </span>
              </span>
            </button>
          ))}
        </div>
      )}
      {page ? (
        <Pager
          total={page.total}
          limit={page.limit}
          offset={page.offset}
          onOffsetChange={(o) => {
            setSelected(null)
            setOffset(o)
          }}
        />
      ) : null}
    </div>
  )

  const detailPanel = selected ? (
    <div className="rounded-[var(--radius)] border border-border/80 bg-card p-6">
      <div className="mb-4 flex items-center justify-between gap-2">
        <span className="flex items-center gap-1 font-mono text-sm text-muted-foreground">
          {selected.ticket_number || "—"}
          <CopyTicketLink claimId={selected.id} />
        </span>
        <StatusChip status={selected.status} contest={selected.contest_forward} />
      </div>
      <TicketDetail
        claim={selected}
        onChanged={(c) => {
          setSelected(c)
          refetch()
        }}
      />
    </div>
  ) : (
    <div className="hidden lg:flex lg:flex-col lg:items-center lg:justify-center lg:rounded-[var(--radius)] lg:border lg:border-dashed lg:border-border/80 lg:bg-card/40 lg:p-12 lg:text-center">
      <p className="text-sm text-muted-foreground">Select a ticket to see details</p>
    </div>
  )

  return (
    <div>
      <PageHeader
        title="My tickets"
        subtitle="Track every ticket from clearing to payment"
        actions={
          <Button asChild>
            <Link to="/faculty/new">
              <Plus className="size-4" />
              New
            </Link>
          </Button>
        }
      />

      <MasterDetail list={listPanel} detail={detailPanel} />

      {/* Mobile bottom sheet */}
      <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
        <SheetContent
          side="bottom"
          className="max-h-[88vh] overflow-y-auto rounded-t-[1.25rem] lg:hidden"
        >
          <SheetHeader className="text-left">
            <SheetTitle className="font-mono text-base text-primary">
              {selected?.ticket_number || "Ticket"}
            </SheetTitle>
            <SheetDescription className="sr-only">Ticket details</SheetDescription>
          </SheetHeader>
          <div className="mt-4 pb-8">
            {selected ? (
              <TicketDetail
                claim={selected}
                onChanged={(c) => {
                  setSelected(c)
                  refetch()
                }}
              />
            ) : null}
          </div>
        </SheetContent>
      </Sheet>
    </div>
  )
}


// ─── New / edit claim ─────────────────────────────────────────────────────────

export function FacultyNewClaimPage() {
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const editId = params.get("edit")

  return (
    <div>
      <PageHeader
        title={editId ? "Edit ticket" : "New ticket"}
        subtitle="Complete all publication details aligned with the ERP form"
      />
      <PublicationForm
        // Remount when the target ticket changes. Without this, going from
        // "edit ticket A" to "New ticket" reused the same component instance:
        // the old ticket's answers stayed on screen under a New ticket
        // heading, the eligibility gate was skipped, and autosave wrote the
        // edits back onto ticket A.
        key={editId ?? "new"}
        mode="faculty"
        claimId={editId}
        onSuccess={(claim) => {
          if (claim.status === "DRAFT") {
            // SPA navigation — this was a window.location.href full reload,
            // which re-ran auth and threw away every cache.
            navigate(`/faculty?claim=${claim.id}`)
          }
        }}
      />
    </div>
  )
}
