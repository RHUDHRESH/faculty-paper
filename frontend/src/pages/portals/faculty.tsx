"use client"

import { useEffect, useMemo, useState } from "react"
import { Link, useSearchParams } from "react-router-dom"
import { FileText, Plus, Search } from "lucide-react"

import {
  EmptyState,
  FilterBar,
  MasterDetail,
  PageHeader,
} from "@/components/layout/page"
import {
  ContestCallout,
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
import { api, type Claim } from "@/lib/api"
import { cn } from "@/lib/utils"

// â”€â”€â”€ Shared claim detail â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function TicketDetail({ claim }: { claim: Claim }) {
  const isTerminal = claim.status === "REJECTED" || claim.status === "PAID"
  return (
    <div className="space-y-5">
      {isTerminal ? (
        <StatusBanner status={claim.status} note={claim.status_note} />
      ) : (
        <StatusTimeline status={claim.status} />
      )}

      {claim.contest_forward && <ContestCallout note={claim.contest_note} />}

      <ClaimDetailFields claim={claim} />

      {(claim.status === "DRAFT" || claim.status === "REJECTED") && (
        <Button asChild className="w-full">
          <Link to={`/faculty/new?edit=${claim.id}`}>Edit &amp; resubmit</Link>
        </Button>
      )}
    </div>
  )
}

// â”€â”€â”€ Claims list â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const STATUS_OPTIONS = [
  "ALL",
  "DRAFT",
  "SUBMITTED",
  "HOD_APPROVED",
  "PRINCIPAL_APPROVED",
  "PAID",
  "REJECTED",
]

export function FacultyClaimsPage() {
  const [claims, setClaims] = useState<Claim[]>([])
  const [selected, setSelected] = useState<Claim | null>(null)
  const [filter, setFilter] = useState("ALL")
  const [search, setSearch] = useState("")
  const [loading, setLoading] = useState(true)
  const [sheetOpen, setSheetOpen] = useState(false)
  const [params] = useSearchParams()

  async function load() {
    setLoading(true)
    try {
      const list = await api<Claim[]>("/api/claims")
      setClaims(list)
      const id = params.get("claim")
      if (id) {
        const c = await api<Claim>(`/api/claims/${id}`)
        setSelected(c)
        setSheetOpen(true)
      }
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load().catch(console.error)
  }, [params])

  const shown = useMemo(() => {
    let list = filter === "ALL" ? claims : claims.filter((c) => c.status === filter)
    const q = search.trim().toLowerCase()
    if (q) {
      list = list.filter(
        (c) =>
          (c.ticket_number || "").toLowerCase().includes(q) ||
          (c.paper_title || "").toLowerCase().includes(q) ||
          (c.journal_title || "").toLowerCase().includes(q)
      )
    }
    return list
  }, [claims, filter, search])

  async function openClaim(id: string) {
    const c = await api<Claim>(`/api/claims/${id}`)
    setSelected(c)
    setSheetOpen(true)
  }

  const listPanel = (
    <div className="space-y-3">
      <FilterBar>
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="pl-9"
            placeholder="Search ticketsâ€¦"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <Select value={filter} onValueChange={setFilter}>
          <SelectTrigger className="w-full sm:w-[200px]">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            {STATUS_OPTIONS.map((s) => (
              <SelectItem key={s} value={s}>
                {s === "ALL" ? "All statuses" : statusLabel(s)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FilterBar>

      {loading ? (
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-16 w-full rounded-[var(--radius)]" />
          ))}
        </div>
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
        <div className="overflow-hidden rounded-[var(--radius)] border border-border/80 bg-card">
          <div className="hidden grid-cols-[7rem_1fr_8rem_5rem] gap-3 border-b border-border bg-muted/40 px-4 py-2 text-xs font-medium text-muted-foreground md:grid">
            <span>Ticket</span>
            <span>Paper</span>
            <span>Status</span>
            <span className="text-right">Amount</span>
          </div>
          {shown.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => openClaim(c.id)}
              className={cn(
                "grid w-full grid-cols-1 gap-1 border-b border-border px-4 py-3 text-left transition-colors hover:bg-muted/50 md:grid-cols-[7rem_1fr_8rem_5rem] md:items-center md:gap-3",
                selected?.id === c.id && "bg-muted/40"
              )}
            >
              <span className="font-mono text-xs text-muted-foreground">
                {c.ticket_number || "â€”"}
              </span>
              <span className="min-w-0">
                <span className="line-clamp-1 text-sm font-medium text-foreground">
                  {c.paper_title || "Untitled"}
                </span>
                <span className="line-clamp-1 text-xs text-muted-foreground">
                  {c.journal_title || "No journal"}
                </span>
              </span>
              <StatusChip status={c.status} contest={c.contest_forward} />
              <span className="text-left text-sm font-medium md:text-right">
                <Money value={c.remuneration} />
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )

  const detailPanel = selected ? (
    <div className="rounded-[var(--radius)] border border-border/80 bg-card p-6">
      <div className="mb-4 flex items-center justify-between">
        <span className="font-mono text-sm text-muted-foreground">
          {selected.ticket_number || "â€”"}
        </span>
        <StatusChip status={selected.status} contest={selected.contest_forward} />
      </div>
      <TicketDetail claim={selected} />
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
        subtitle="Track every approval from HoD to Finance"
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
            {selected ? <TicketDetail claim={selected} /> : null}
          </div>
        </SheetContent>
      </Sheet>
    </div>
  )
}


// ─── New / edit claim ─────────────────────────────────────────────────────────

export function FacultyNewClaimPage() {
  const [params] = useSearchParams()
  const editId = params.get("edit")

  return (
    <div>
      <PageHeader
        title={editId ? "Edit ticket" : "New ticket"}
        subtitle="Complete all publication details aligned with the ERP form"
      />
      <PublicationForm
        mode="faculty"
        claimId={editId}
        onSuccess={(claim) => {
          if (claim.status === "DRAFT") {
            window.location.href = `/faculty?claim=${claim.id}`
          }
        }}
      />
    </div>
  )
}
