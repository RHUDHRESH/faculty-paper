"use client"

import { useEffect, useMemo, useState } from "react"
import { Link, useSearchParams } from "react-router-dom"
import { motion } from "framer-motion"
import { FileText, Plus, Search } from "lucide-react"
import { toast } from "sonner"

import { useAuth } from "@/components/auth-provider"
import {
  EmptyState,
  FilterBar,
  InsetList,
  InsetRow,
  MasterDetail,
  PageHeader,
  Section,
  StickyActions,
  Stepper,
} from "@/components/layout/page"
import {
  ContestCallout,
  Money,
  StatusBanner,
  StatusChip,
  StatusTimeline,
  statusLabel,
} from "@/components/ticket-ui"
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
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
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
import { Textarea } from "@/components/ui/textarea"
import { api, type Claim } from "@/lib/api"
import { cn } from "@/lib/utils"

// ─── Shared claim detail ──────────────────────────────────────────────────────

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

      <div>
        <h2 className="font-[family-name:var(--font-display)] text-xl font-semibold leading-snug">
          {claim.paper_title || "Untitled"}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {claim.journal_title || "Journal not set"}
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3 text-sm">
        <div>
          <div className="text-xs text-muted-foreground">Year</div>
          <div className="mt-0.5">{claim.publication_year || "—"}</div>
        </div>
        <div>
          <div className="text-xs text-muted-foreground">Estimated amount</div>
          <div className="mt-0.5 text-lg font-semibold text-primary">
            <Money value={claim.remuneration} />
          </div>
        </div>
        {claim.quartile ? (
          <div>
            <div className="text-xs text-muted-foreground">Quartile</div>
            <div className="mt-0.5">{claim.quartile}</div>
          </div>
        ) : null}
        {claim.snip != null ? (
          <div>
            <div className="text-xs text-muted-foreground">SNIP</div>
            <div className="mt-0.5">{claim.snip}</div>
          </div>
        ) : null}
      </div>

      {(claim.status === "DRAFT" || claim.status === "REJECTED") && (
        <Button asChild className="w-full">
          <Link to={`/faculty/new?edit=${claim.id}`}>Edit &amp; resubmit</Link>
        </Button>
      )}
    </div>
  )
}

// ─── Claims list ──────────────────────────────────────────────────────────────

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
            placeholder="Search tickets…"
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
          <div className="hidden grid-cols-[7rem_1fr_8rem_5rem] gap-3 border-b border-border/80 bg-muted/40 px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground md:grid">
            <span>Ticket</span>
            <span>Paper</span>
            <span>Status</span>
            <span className="text-right">Amount</span>
          </div>
          {shown.map((c, i) => (
            <motion.button
              key={c.id}
              type="button"
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: Math.min(i * 0.03, 0.2), duration: 0.2 }}
              onClick={() => openClaim(c.id)}
              className={cn(
                "grid w-full grid-cols-1 gap-1 border-b border-border/60 px-4 py-3.5 text-left transition-colors hover:bg-accent/40 active:bg-accent/70 md:grid-cols-[7rem_1fr_8rem_5rem] md:items-center md:gap-3",
                selected?.id === c.id && "bg-accent/30"
              )}
            >
              <span className="font-mono text-xs text-muted-foreground">
                {c.ticket_number || "—"}
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
            </motion.button>
          ))}
        </div>
      )}
    </div>
  )

  const detailPanel = selected ? (
    <div className="rounded-[var(--radius)] border border-border/80 bg-card p-6">
      <div className="mb-4 flex items-center justify-between">
        <span className="font-mono text-sm text-muted-foreground">
          {selected.ticket_number || "—"}
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

const STEPS = ["Publication", "Authors", "Review"] as const

export function FacultyNewClaimPage() {
  const { user } = useAuth()
  const [params] = useSearchParams()
  const editId = params.get("edit")

  // Step state
  const [step, setStep] = useState(0)

  // Publication fields
  const [title, setTitle] = useState("")
  const [journal, setJournal] = useState("")
  const [issn, setIssn] = useState("")
  const [year, setYear] = useState("")
  const [doi, setDoi] = useState("")
  const [aggType, setAggType] = useState("Journal")
  const [subject, setSubject] = useState("")

  // Enrichment fields (filled by quietFill)
  const [eid, setEid] = useState("")
  const [coverDate, setCoverDate] = useState("")
  const [scopusUrl, setScopusUrl] = useState("")

  // Authors & ranking fields
  const [quartile, setQuartile] = useState("")
  const [snip, setSnip] = useState("")
  const [totalAuthors, setTotalAuthors] = useState(1)
  const [authorPosition, setAuthorPosition] = useState(1)

  // Calculation + dialogs
  const [calc, setCalc] = useState<{ remuneration?: number | null; error?: string | null } | null>(null)
  const [sendAnywayOpen, setSendAnywayOpen] = useState(false)
  const [sendNote, setSendNote] = useState("")
  const [blockReason, setBlockReason] = useState("")
  const [successOpen, setSuccessOpen] = useState(false)
  const [issuedTicket, setIssuedTicket] = useState<string | null>(null)
  const [issuedId, setIssuedId] = useState<string | null>(null)
  const [issuedAmount, setIssuedAmount] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)

  // Load existing claim when editing
  useEffect(() => {
    if (!editId) return
    api<Claim>(`/api/claims/${editId}`)
      .then((c) => {
        setTitle(c.paper_title || "")
        setJournal(c.journal_title || "")
        setIssn(c.issn || "")
        setYear(c.publication_year ? String(c.publication_year) : "")
        setSnip(c.snip != null ? String(c.snip) : "")
        setQuartile(c.quartile || "")
        setDoi(c.doi || "")
        setEid(c.eid || "")
        setScopusUrl(c.scopus_url || "")
        setCoverDate(c.cover_date || "")
        setAggType(c.aggregation_type || "Journal")
        setTotalAuthors(c.total_authors || 1)
        setAuthorPosition(c.author_position || 1)
        setCalc({ remuneration: c.remuneration })
      })
      .catch(() => toast.error("Could not load ticket"))
  }, [editId])

  async function recalc(snipVal?: number | null, q?: string | null) {
    const c = await api<{ remuneration?: number | null; error?: string | null }>("/api/calculate", {
      method: "POST",
      json: {
        snip: snipVal !== undefined ? snipVal : snip === "" ? null : Number(snip),
        quartile: q !== undefined ? q : quartile || null,
        total_authors: totalAuthors,
        author_position: authorPosition,
        publication_type: aggType,
      },
    })
    setCalc(c)
  }

  /** Quietly fill missing fields from the title — no vendor names shown. */
  async function quietFill(): Promise<{
    title?: string
    doi?: string
    issn?: string
    journal?: string
    eid?: string
    cover_date?: string
    scopus_url?: string
    aggregation_type?: string
    year?: string
    snip?: string
    quartile?: string
  }> {
    if (!title.trim()) return {}
    try {
      const res = await api<{
        ok: boolean
        matched_title?: string
        doi?: string
        issn?: string
        eid?: string
        journal?: string
        cover_date?: string
        snip?: number | null
        quartile?: string | null
        paper?: { scopus_url?: string; aggregation_type?: string; publication_year?: number }
      }>("/api/lookup/enrich", {
        method: "POST",
        json: { doi: doi || null, title: title.trim() },
      })
      if (!res.ok) return {}
      const filled: {
        title?: string
        doi?: string
        issn?: string
        journal?: string
        eid?: string
        cover_date?: string
        scopus_url?: string
        aggregation_type?: string
        year?: string
        snip?: string
        quartile?: string
      } = {}
      if (res.matched_title) {
        filled.title = res.matched_title
        setTitle(res.matched_title)
      }
      if (res.doi && !doi) {
        filled.doi = res.doi
        setDoi(res.doi)
      }
      if (res.issn && !issn) {
        filled.issn = res.issn
        setIssn(res.issn)
      }
      if (res.journal && !journal) {
        filled.journal = res.journal
        setJournal(res.journal)
      }
      if (res.eid) {
        filled.eid = res.eid
        setEid(res.eid)
      }
      if (res.cover_date) {
        filled.cover_date = res.cover_date
        setCoverDate(res.cover_date)
      }
      if (res.paper?.scopus_url) {
        filled.scopus_url = res.paper.scopus_url
        setScopusUrl(res.paper.scopus_url)
      }
      if (res.paper?.aggregation_type) {
        filled.aggregation_type = res.paper.aggregation_type
        setAggType(res.paper.aggregation_type)
      }
      if (res.paper?.publication_year && !year) {
        filled.year = String(res.paper.publication_year)
        setYear(filled.year)
      }
      if (res.snip != null && snip === "") {
        filled.snip = String(res.snip)
        setSnip(filled.snip)
      }
      if (res.quartile && !quartile) {
        filled.quartile = res.quartile
        setQuartile(res.quartile)
      }
      await recalc(
        res.snip != null ? Number(res.snip) : undefined,
        res.quartile || quartile || null
      )
      return filled
    } catch {
      return {}
    }
  }

  function buildPayload(
    submit: boolean,
    sendAnyway = false,
    filled: Awaited<ReturnType<typeof quietFill>> = {}
  ) {
    const nextTitle = filled.title || title
    const nextDoi = filled.doi || doi
    const nextIssn = filled.issn || issn
    const nextJournal = filled.journal || journal
    const nextEid = filled.eid || eid
    const nextCover = filled.cover_date || coverDate
    const nextScopusUrl = filled.scopus_url || scopusUrl
    const nextAgg = filled.aggregation_type || aggType
    const nextYear = filled.year || year
    const nextSnip = filled.snip ?? snip
    const nextQuartile = filled.quartile || quartile
    return {
      doi: nextDoi.trim() || null,
      issn: nextIssn || null,
      journal_title: nextJournal || null,
      paper_title: nextTitle || null,
      publication_year: nextYear ? Number(nextYear) : null,
      subject_category: subject || null,
      snip: nextSnip === "" ? null : Number(nextSnip),
      quartile: nextQuartile || null,
      scimago_verified: false,
      manual_quartile_reason: "Faculty-provided journal details",
      total_authors: totalAuthors,
      author_position: authorPosition,
      eid: nextEid || null,
      scopus_url: nextScopusUrl || null,
      scopus_author_url: user?.scopus_author_url || null,
      scopus_author_id: user?.scopus_author_id || null,
      staff_id: user?.staff_id || null,
      biometric_id: user?.biometric_id || null,
      designation: user?.designation || null,
      cover_date: nextCover || null,
      aggregation_type: nextAgg || null,
      contest_forward: sendAnyway,
      contest_note: sendAnyway ? sendNote : null,
      submit,
    }
  }

  async function save(submit: boolean, sendAnyway = false) {
    if (!title.trim()) {
      toast.error("Enter the paper title")
      return
    }
    setBusy(true)
    try {
      const filled = submit && !sendAnyway ? await quietFill() : {}
      const payload = buildPayload(submit, sendAnyway, filled)
      const claim = editId
        ? await api<Claim>(`/api/claims/${editId}`, { method: "PATCH", json: payload })
        : await api<Claim>("/api/claims", { method: "POST", json: payload })
      if (submit && claim.ticket_number) {
        setIssuedTicket(claim.ticket_number)
        setIssuedId(claim.id)
        setIssuedAmount(claim.remuneration ?? calc?.remuneration ?? null)
        setSuccessOpen(true)
        setSendAnywayOpen(false)
        toast.success("Submitted")
      } else if (!submit) {
        toast.success("Draft saved")
        window.location.href = `/faculty?claim=${claim.id}`
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : "Submit failed"
      if (submit && !sendAnyway && /auto-confirm|send with a short note|Could not/i.test(message)) {
        setBlockReason(message)
        setSendAnywayOpen(true)
      } else {
        toast.error(message)
      }
    } finally {
      setBusy(false)
    }
  }

  // ── Step panels ──────────────────────────────────────────────────────────────

  const publicationStep = (
    <Section title="Publication details">
      <InsetList>
        <div className="space-y-2 p-4">
          <Label htmlFor="title">Paper title</Label>
          <Textarea
            id="title"
            required
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={() => {
              if (title.trim()) quietFill()
            }}
            rows={3}
            placeholder="Full paper title"
            className="resize-none"
          />
        </div>
        <InsetRow label="Where published">
          <Input
            className="border-0 bg-transparent shadow-none focus-visible:ring-0"
            value={journal}
            onChange={(e) => setJournal(e.target.value)}
            placeholder="Journal or conference name"
          />
        </InsetRow>
        <InsetRow label="Year">
          <Input
            className="border-0 bg-transparent text-right shadow-none focus-visible:ring-0"
            type="number"
            value={year}
            onChange={(e) => setYear(e.target.value)}
            placeholder="YYYY"
          />
        </InsetRow>
        <InsetRow label="ISSN">
          <Input
            className="border-0 bg-transparent text-right shadow-none focus-visible:ring-0"
            value={issn}
            onChange={(e) => setIssn(e.target.value)}
            placeholder="Optional"
          />
        </InsetRow>
        <InsetRow label="DOI">
          <Input
            className="border-0 bg-transparent text-right shadow-none focus-visible:ring-0"
            value={doi}
            onChange={(e) => setDoi(e.target.value)}
            placeholder="Optional"
          />
        </InsetRow>
        <InsetRow label="Type">
          <Select value={aggType} onValueChange={setAggType}>
            <SelectTrigger className="border-0 bg-transparent shadow-none focus:ring-0">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {["Journal", "Conference Proceeding", "Book Series", "Other"].map((t) => (
                <SelectItem key={t} value={t}>
                  {t}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </InsetRow>
        <InsetRow label="Subject">
          <Input
            className="border-0 bg-transparent text-right shadow-none focus-visible:ring-0"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            placeholder="Optional"
          />
        </InsetRow>
      </InsetList>
    </Section>
  )

  const authorsStep = (
    <Section title="Authors &amp; ranking">
      <InsetList>
        <InsetRow label="Journal ranking">
          <Select
            value={quartile}
            onValueChange={(v) => {
              setQuartile(v)
              setTimeout(() => recalc(undefined, v), 0)
            }}
          >
            <SelectTrigger className="border-0 bg-transparent shadow-none focus:ring-0">
              <SelectValue placeholder="Q1–Q4" />
            </SelectTrigger>
            <SelectContent>
              {["Q1", "Q2", "Q3", "Q4", "Others"].map((q) => (
                <SelectItem key={q} value={q}>
                  {q}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </InsetRow>
        <InsetRow label="SNIP (if known)">
          <Input
            className="border-0 bg-transparent text-right shadow-none focus-visible:ring-0"
            value={snip}
            onChange={(e) => setSnip(e.target.value)}
            onBlur={() => recalc()}
            placeholder="Optional"
          />
        </InsetRow>
        <InsetRow label="Total authors">
          <Input
            className="border-0 bg-transparent text-right shadow-none focus-visible:ring-0"
            type="number"
            min={1}
            value={totalAuthors}
            onChange={(e) => setTotalAuthors(Number(e.target.value) || 1)}
            onBlur={() => recalc()}
          />
        </InsetRow>
        <InsetRow label="Your author position">
          <Input
            className="border-0 bg-transparent text-right shadow-none focus-visible:ring-0"
            type="number"
            min={1}
            value={authorPosition}
            onChange={(e) => setAuthorPosition(Number(e.target.value) || 1)}
            onBlur={() => recalc()}
          />
        </InsetRow>
      </InsetList>
    </Section>
  )

  const reviewStep = (
    <div className="space-y-4">
      <Section title="Review your submission">
        <InsetList>
          <div className="space-y-1 p-4">
            <p className="text-xs text-muted-foreground">Paper title</p>
            <p className="text-sm font-medium leading-snug">{title || "—"}</p>
          </div>
          <InsetRow label="Journal">
            <span className="text-sm">{journal || "—"}</span>
          </InsetRow>
          <InsetRow label="Year">
            <span className="text-sm">{year || "—"}</span>
          </InsetRow>
          {issn ? (
            <InsetRow label="ISSN">
              <span className="text-sm">{issn}</span>
            </InsetRow>
          ) : null}
          {doi ? (
            <InsetRow label="DOI">
              <span className="truncate text-sm">{doi}</span>
            </InsetRow>
          ) : null}
          <InsetRow label="Type">
            <span className="text-sm">{aggType}</span>
          </InsetRow>
          <InsetRow label="Quartile">
            <span className="text-sm">{quartile || "—"}</span>
          </InsetRow>
          {snip ? (
            <InsetRow label="SNIP">
              <span className="text-sm">{snip}</span>
            </InsetRow>
          ) : null}
          <InsetRow label="Total authors">
            <span className="text-sm">{totalAuthors}</span>
          </InsetRow>
          <InsetRow label="Your position">
            <span className="text-sm">{authorPosition}</span>
          </InsetRow>
        </InsetList>
      </Section>

      {calc?.remuneration != null && (
        <div className="rounded-[var(--radius)] border border-border/80 bg-card px-4 py-4">
          <div className="text-xs text-muted-foreground">Estimated amount</div>
          <div className="mt-1 font-[family-name:var(--font-display)] text-3xl font-semibold text-primary">
            <Money value={calc.remuneration} size="lg" />
          </div>
          {calc.error ? (
            <p className="mt-2 text-xs text-rose-600">{calc.error}</p>
          ) : null}
        </div>
      )}
    </div>
  )

  const stepContent = [publicationStep, authorsStep, reviewStep][step]

  const isFirst = step === 0
  const isLast = step === STEPS.length - 1

  return (
    <div className="pb-24">
      <PageHeader
        title={editId ? "Edit ticket" : "New ticket"}
        subtitle="Enter your paper details and submit — we handle the checks"
      />

      <div className="mb-6">
        <Stepper steps={[...STEPS]} current={step} />
      </div>

      <div className="space-y-4">{stepContent}</div>

      <StickyActions>
        {!isFirst && (
          <Button
            type="button"
            variant="ghost"
            disabled={busy}
            onClick={() => setStep((s) => s - 1)}
          >
            ← Back
          </Button>
        )}
        <Button
          type="button"
          variant="secondary"
          disabled={busy || !title.trim()}
          onClick={() => save(false)}
        >
          Save draft
        </Button>
        {isLast ? (
          <Button
            type="button"
            disabled={busy || !title.trim()}
            onClick={() => save(true, false)}
          >
            {busy ? "Submitting…" : "Submit"}
          </Button>
        ) : (
          <Button
            type="button"
            disabled={busy || !title.trim()}
            onClick={() => setStep((s) => s + 1)}
          >
            Continue →
          </Button>
        )}
      </StickyActions>

      {/* Send-anyway alert */}
      <AlertDialog open={sendAnywayOpen} onOpenChange={setSendAnywayOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Send for approval anyway?</AlertDialogTitle>
            <AlertDialogDescription>
              {blockReason ||
                "We could not auto-confirm every detail. Add a short note and your HoD will review."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-2">
            <Label htmlFor="send-note">Note (10+ characters)</Label>
            <Textarea
              id="send-note"
              value={sendNote}
              onChange={(e) => setSendNote(e.target.value)}
              rows={3}
              className="resize-none"
              placeholder="Briefly explain why this should go ahead"
            />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>Edit details</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy || sendNote.trim().length < 10}
              onClick={(e) => {
                e.preventDefault()
                save(true, true)
              }}
            >
              Send anyway
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Success dialog */}
      <Dialog open={successOpen} onOpenChange={setSuccessOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Submitted</DialogTitle>
            <DialogDescription>Your ticket is with HoD for approval.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2 text-center">
            <motion.p
              initial={{ scale: 0.96, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              className="font-mono text-3xl font-semibold tracking-tight text-primary"
            >
              {issuedTicket}
            </motion.p>
            {issuedAmount != null ? (
              <p className="text-sm text-muted-foreground">
                Estimated amount:{" "}
                <span className="font-semibold text-foreground">
                  <Money value={issuedAmount} />
                </span>
              </p>
            ) : null}
          </div>
          <DialogFooter>
            <Button asChild className="w-full">
              <Link to={`/faculty?claim=${issuedId}`}>View ticket</Link>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
