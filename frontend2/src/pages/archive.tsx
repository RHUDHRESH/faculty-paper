import { paperTitle } from "@/lib/names"
import { useEffect, useState } from "react"
import { Link, useNavigate, useSearchParams } from "react-router-dom"
import { cn } from "@/lib/cn"
import { Download, FileSearch, Flag, Search, SearchX } from "lucide-react"

import { useAuth } from "@/app/auth"
import { reviewsFlags } from "@/app/nav"
import { api } from "@/lib/api"
import { useApi } from "@/lib/query"
import { ClaimNo, ClaimNoLegend, staffStage } from "@/pages/cell/parts"
import { Answer } from "@/ui/answer"
import { Button } from "@/ui/button"
import { Combobox, type ComboboxOption } from "@/ui/combobox"
import { Input, NumberInput } from "@/ui/field"
import { money } from "@/ui/paper"
import { PageHeader } from "@/ui/page-header"
import { ClaimNoJump } from "@/ui/claim-number"
import { Pagination } from "@/ui/pagination"
import { EmptyState, ErrorState, SkeletonRows } from "@/ui/state"
import { Meta } from "@/ui/text"
import { filterBar } from "@/ui/filter-bar"
import { Avatar, initialsOf } from "@/ui/person"
import { toast } from "@/ui/toast"
import { RaiseFlagDialog } from "@/pages/claim-review"

/**
 * Past claims: every claim filed with the college, paid and imported ones
 * included, for the desks that judge a paper.
 *
 * The question: "was this ever claimed or paid, and what happened to it?"
 * So the top says how much is on record (each figure a link that narrows the
 * list), the search finds a claim by number, title, DOI, ISSN or person, and
 * every row says how the claim ended in a word, with the reason when it was
 * sent back and a warning when the same DOI sits on another claim. A row opens
 * the claim; a flag can be raised from the row.
 */

const PAGE_SIZE = 25

type Row = {
  id: string
  ticket_number: string | null
  paper_title: string | null
  journal_title: string | null
  publication_year: number | null
  status: string
  status_note: string | null
  owner_id?: string
  owner_name: string
  owner_department: string | null
  owner_photo_url?: string | null
  /** "Imported from the ERP, <sheet>" for a ticket from the old records. */
  origin?: string | null
  remuneration: number | null
  paid_at: string | null
  file_count: number
  open_flags: number
  rejected_outright?: boolean
  doi?: string | null
  same_doi_others?: number
}

type Summary = { all: number; paid: number; moving: number; sent_back: number; not_accepted: number; with_open_flags: number }
type Payload = { total: number; limit: number; offset: number; results: Row[]; summary?: Summary }

const STATUS_OPTIONS: ComboboxOption[] = [
  { value: "", label: "Any status" },
  { value: "PAID", label: "Paid" },
  { value: "SUBMITTED", label: "Waiting to be cleared" },
  { value: "CLEARED", label: "Cleared" },
  { value: "PRINCIPAL_APPROVED", label: "Approved" },
  { value: "DIRECTOR_APPROVED", label: "Authorised" },
  { value: "REJECTED", label: "Sent back or not accepted" },
  { value: "HOD_APPROVED", label: "Filed (old chain)" },
  { value: "RESEARCH_APPROVED", label: "Cleared (old chain)" },
  { value: "FINANCE_APPROVED", label: "Approved (old chain)" },
]

const FLAGGED_FILTERS: ComboboxOption[] = [
  { value: "", label: "Any flags" },
  { value: "open", label: "With open flags" },
  { value: "none", label: "No open flags" },
]

/** How the claim ended (or where it stands), in the desks' words. */
export function outcomeOf(row: Pick<Row, "status" | "rejected_outright" | "paid_at" | "origin" | "status_note">): {
  label: string
  detail: string | null
  tone: "neutral" | "progress" | "done" | "attention"
} {
  if (row.status === "REJECTED") {
    return row.rejected_outright
      ? { label: "Not accepted", detail: row.status_note, tone: "attention" }
      : { label: "Sent back", detail: row.origin ? null : row.status_note, tone: "attention" }
  }
  if (row.status === "PAID") {
    // An imported claim's paid date is the day it was imported, not a payment.
    if (row.origin) return { label: "Paid before this system", detail: null, tone: "done" }
    return { label: row.paid_at ? `Paid on ${formatDate(row.paid_at)}` : "Paid", detail: null, tone: "done" }
  }
  const s = staffStage(row.status)
  return { label: s.label, detail: null, tone: s.tone }
}

export function PastClaims() {
  const { me } = useAuth()
  const allowed = reviewsFlags(me?.role)
  const [searchParams, setSearchParams] = useSearchParams()
  const q = searchParams.get("q") ?? ""
  const status = searchParams.get("status") ?? ""
  const year = searchParams.get("year") ?? ""
  const department = searchParams.get("department") ?? ""
  const flagged = searchParams.get("flagged") ?? ""
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

  // Typed boxes settle before they ask the server, so a search is one
  // request rather than one per keystroke.
  const [searchDraft, setSearchDraft] = useState(q)
  const [yearDraft, setYearDraft] = useState(year)
  const [exporting, setExporting] = useState(false)
  useEffect(() => setSearchDraft(q), [q])
  useEffect(() => setYearDraft(year), [year])
  useEffect(() => {
    if (searchDraft === q && yearDraft === year) return
    const t = setTimeout(() => {
      // One update for both boxes. Two in the same tick each start from the
      // URL as this render saw it, so the second silently undid the first
      // and a search typed just before a year was dropped.
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev)
          const term = searchDraft.trim()
          if (term) next.set("q", term)
          else next.delete("q")
          if (yearDraft === "") next.delete("year")
          else if (/^\d{4}$/.test(yearDraft)) next.set("year", yearDraft)
          next.delete("page")
          return next
        },
        { replace: true }
      )
    }, 300)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchDraft, yearDraft])

  const query = new URLSearchParams()
  if (q) query.set("q", q)
  if (status) query.set("status", status)
  if (year) query.set("year", year)
  if (department) query.set("department", department)
  if (flagged) query.set("flagged", flagged)
  query.set("limit", String(PAGE_SIZE))
  query.set("offset", String(page * PAGE_SIZE))

  const { data, isLoading, isError, error, refetch } = useApi<Payload>(
    ["archive", query.toString()],
    `/api/archive/claims?${query.toString()}`,
    { enabled: allowed, placeholderData: (prev) => prev }
  )
  const departments = useApi<string[]>(["meta", "departments"], "/api/meta/departments", {
    enabled: allowed,
  })

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
          art="closed-gate"
          title="Not open to this account"
          message="Past claims are for the research office, the coordinator, the Principal and the super admin, who can reopen any claim and flag it."
        />
      </div>
    )
  }

  const rows = data?.results ?? []
  const total = data?.total ?? 0
  const summary = data?.summary
  const filtered = Boolean(q || status || year || department || flagged)
  const departmentOptions: ComboboxOption[] = [
    { value: "", label: "Any department" },
    ...(departments.data ?? []).map((d) => ({ value: d, label: d })),
  ]

  // Every row the filters match, not just this page: asked for in pages of
  // 200, the server's cap, and written out in the order shown.
  async function downloadCsv() {
    setExporting(true)
    try {
      const all: Row[] = []
      for (let offset = 0; ; offset += 200) {
        const qs = new URLSearchParams(query)
        qs.set("limit", "200")
        qs.set("offset", String(offset))
        const p = await api<Payload>(`/api/archive/claims?${qs.toString()}`)
        all.push(...p.results)
        if (p.results.length === 0 || all.length >= p.total) break
      }
      saveCsv(all)
      toast.ok(all.length === 1 ? "Downloaded 1 claim as CSV" : `Downloaded ${all.length} claims as CSV`)
    } catch (e) {
      toast.fail(e, "Could not download the CSV. Try again.")
    } finally {
      setExporting(false)
    }
  }

  function clearAll() {
    setSearchDraft("")
    setYearDraft("")
    setSearchParams(new URLSearchParams())
  }

  const link = (over: Record<string, string>) => {
    const p = new URLSearchParams()
    if (q) p.set("q", q)
    if (year) p.set("year", year)
    if (department) p.set("department", department)
    for (const [k, v] of Object.entries(over)) p.set(k, v)
    const s = p.toString()
    return s ? `/archive?${s}` : "/archive"
  }


  return (
    <div className="page space-y-8">
      <PageHeader
        title="Past claims"
        sub="Every claim ever filed, paid ones and imported ones included. Find one by its number."
      />

      <Answer
        items={[
          { label: filtered ? "Claims matching the search" : "Claims on record", value: summary?.all, to: link({}), zero: "No claims on record" },
          { label: "Paid", value: summary?.paid, to: link({ status: "PAID" }), zero: "None paid" },
          { label: "Sent back or not accepted", value: (summary?.sent_back ?? 0) + (summary?.not_accepted ?? 0) || (summary ? 0 : undefined), to: link({ status: "REJECTED" }), zero: "None sent back" },
          { label: "With open flags", value: summary?.with_open_flags, to: link({ flagged: "open" }), zero: "No open flags", tone: "caution" },
        ]}
      />

      <div className={filterBar} role="search" aria-label="Filter past claims">
        <div className="relative min-w-0 flex-1 sm:min-w-[16rem]">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-fg-subtle" aria-hidden />
          <Input
            value={searchDraft}
            onChange={(e) => setSearchDraft(e.target.value)}
            placeholder="Claim number, title, DOI, ISSN or faculty"
            aria-label="Search past claims"
            className="pl-8"
          />
        </div>
        <Combobox value={status} onChange={(v) => setParam("status", v)} options={STATUS_OPTIONS} aria-label="Status" className="sm:w-52" />
        <NumberInput
          value={yearDraft}
          onChange={(e) => setYearDraft(e.target.value)}
          placeholder="Year"
          aria-label="Publication year"
          min={1990}
          max={2100}
          className="sm:w-24"
        />
        <Combobox
          value={department}
          onChange={(v) => setParam("department", v)}
          options={departmentOptions}
          aria-label="Department"
          className="sm:w-52"
        />
        <Combobox value={flagged} onChange={(v) => setParam("flagged", v)} options={FLAGGED_FILTERS} aria-label="Flags" className="sm:w-40" />
      </div>

      {/* A claim number typed here jumps to that claim, wherever it now sits. */}
      <ClaimNoJump term={searchDraft} skip={new Set(rows.map((r) => r.id))} />

      <div className="-mt-4 flex min-h-8 flex-wrap items-center gap-2" role="status" aria-live="polite">
        {!isLoading && !isError && (
          <Meta className="tabular">
            {total === 1 ? "1 claim" : `${total.toLocaleString("en-IN")} claims`}
            {filtered ? " matching these filters" : ""}
          </Meta>
        )}
        {filtered && (
          <Button kind="quiet" size="sm" onClick={clearAll}>
            Clear all
          </Button>
        )}
        {total > 0 && !isError && (
          <Button kind="quiet" size="sm" className="ml-auto" onClick={downloadCsv} disabled={exporting}>
            <Download className="size-4" aria-hidden />
            {exporting ? "Preparing CSV…" : filtered ? "Download these as CSV" : "Download all as CSV"}
          </Button>
        )}
      </div>

      {isLoading && !data ? (
        <SkeletonRows rows={8} rowHeight={72} />
      ) : isError ? (
        <ErrorState
          title="Could not load past claims"
          message={
            error?.status === 403
              ? "Not allowed for this account."
              : "The server did not answer. Nothing has been changed."
          }
          onRetry={error?.status === 403 ? false : () => refetch()}
        />
      ) : rows.length === 0 ? (
        <EmptyState
          art="no-results"
          icon={filtered ? SearchX : FileSearch}
          title={filtered ? "No claim matches these filters" : "Nothing has been filed yet"}
          message={
            filtered
              ? "Try a shorter search, or clear the filters to see every claim."
              : "Once claims are filed or imported, every one of them is listed here."
          }
          action={
            filtered ? (
              <Button kind="default" size="sm" onClick={clearAll}>
                Clear filters
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div className="space-y-3">
          <ul aria-label="Past claims" className="divide-y divide-line">
            {rows.map((r) => (
              <ArchiveRow key={r.id} row={r} sameDoi={(doi) => link({ q: doi })} />
            ))}
          </ul>
          <ClaimNoLegend show={rows.some((r) => !!r.origin)} />
          <Pagination page={page} pageSize={PAGE_SIZE} total={total} onChange={(n) => setParam("page", n > 0 ? String(n) : "")} />
        </div>
      )}
    </div>
  )
}

/**
 * One past claim: the person leads, then the paper, then a quiet line of
 * claim number, journal and year; how it ended in a word on the right with the
 * amount under it. Wraps on a narrow screen instead of scrolling sideways.
 */
function ArchiveRow({ row: r, sameDoi }: { row: Row; sameDoi: (doi: string) => string }) {
  const navigate = useNavigate()
  const o = outcomeOf(r)
  const amount = r.remuneration == null || (r.origin && !r.remuneration) ? null : money(r.remuneration)
  const tone = o.tone === "done" ? "text-positive" : o.tone === "attention" ? "text-critical" : "text-fg"
  return (
    <li
      className="flex cursor-pointer flex-wrap items-start gap-x-3 gap-y-2 px-1 py-3 hover:bg-hover sm:flex-nowrap sm:px-2"
      onClick={(e) => {
        if ((e.target as HTMLElement).closest("button, a, input, [role=dialog]")) return
        navigate(`/papers/${r.id}`)
      }}
    >
      <Avatar size="md" person={{ name: r.owner_name, initials: initialsOf(r.owner_name), photo_url: r.owner_photo_url ?? null }} />
      <div className="min-w-0 flex-1 basis-[calc(100%-3.5rem)] sm:basis-auto">
        <p className="truncate text-sm">
          <span className="font-medium">{r.owner_name}</span>
          <span className="text-fg-muted"> · {r.owner_department || "No department"}</span>
        </p>
        <Link to={`/papers/${r.id}`} className="line-clamp-2 block text-base text-fg underline-offset-4 hover:underline sm:line-clamp-1">
          {paperTitle(r.paper_title)}
        </Link>
        <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-fg-muted">
          <ClaimNo ticket={r.ticket_number} origin={r.origin} />
          {real(r.journal_title) && <span className="max-w-[18rem] truncate">{real(r.journal_title)}</span>}
          {r.publication_year && <span className="tabular">{r.publication_year}</span>}
          <span>{r.file_count === 0 ? "No files" : r.file_count === 1 ? "1 file" : `${r.file_count} files`}</span>
        </p>
        {(r.same_doi_others ?? 0) > 0 && r.doi && (
          <Link to={sameDoi(r.doi)} className="mt-0.5 block text-xs text-caution underline-offset-4 hover:underline">
            Same DOI on {r.same_doi_others} other {r.same_doi_others === 1 ? "claim" : "claims"}
          </Link>
        )}
      </div>
      <div className="min-w-0 basis-full pl-[3.25rem] sm:w-56 sm:shrink-0 sm:basis-auto sm:pl-0">
        <p className={cn("text-sm font-medium", tone)}>{o.label}</p>
        {o.detail && <p className="line-clamp-2 text-xs text-fg-muted">{o.detail}</p>}
        {r.origin && <p className="line-clamp-1 text-xs text-fg-subtle">{r.origin}</p>}
      </div>
      <div className="flex shrink-0 items-center gap-2 max-sm:pl-[3.25rem] sm:w-36 sm:flex-col sm:items-end sm:gap-0.5">
        <p className="tabular text-base">{amount ?? <span className="text-sm text-fg-subtle">Not recorded</span>}</p>
        {r.open_flags > 0 ? (
          <Link
            to={`/flags?claim=${r.id}&status=all`}
            className="whitespace-nowrap rounded-control bg-caution-wash px-1.5 py-0.5 text-xs font-medium text-caution"
          >
            {r.open_flags === 1 ? "1 open flag" : `${r.open_flags} open flags`}
          </Link>
        ) : null}
      </div>
      <div className="shrink-0 max-sm:ml-auto">
        <FlagButton row={r} />
      </div>
    </li>
  )
}

/** The flag beside a claim: opens the reason form without leaving the list. */
function FlagButton({ row }: { row: Row }) {
  const [flagging, setFlagging] = useState(false)
  return (
    <>
      <Button
        kind="quiet"
        size="sm"
        onClick={() => setFlagging(true)}
        aria-label={`Raise a flag on ${row.paper_title || "this claim"}`}
      >
        <Flag className="size-4" aria-hidden />
        Flag
      </Button>
      <RaiseFlagDialog claimId={row.id} open={flagging} onClose={() => setFlagging(false)} />
    </>
  )
}

const CSV_HEAD = [
  "Claim no.", "Title", "Journal", "Year", "Faculty", "Department", "Status",
  "Origin", "Amount", "Paid on", "Files", "Open flags",
]

function csvCell(v: unknown): string {
  const t = v == null ? "" : String(v)
  return /[",\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t
}

/** The filtered claims as CSV, one row each, in the order shown. */
export function archiveCsv(rows: Row[]): string {
  const label = new Map(STATUS_OPTIONS.map((o) => [o.value, o.label]))
  const lines = rows.map((r) =>
    [
      r.ticket_number, r.paper_title, r.journal_title, r.publication_year, r.owner_name,
      r.owner_department, r.status === "REJECTED" ? (r.rejected_outright ? "Not accepted" : "Sent back") : (label.get(r.status) ?? r.status), r.origin ?? "Filed here",
      r.remuneration, r.paid_at ? r.paid_at.slice(0, 10) : "", r.file_count, r.open_flags,
    ]
      .map(csvCell)
      .join(",")
  )
  return [CSV_HEAD.join(","), ...lines].join("\r\n") + "\r\n"
}

function saveCsv(rows: Row[]) {
  const blob = new Blob(["﻿" + archiveCsv(rows)], { type: "text/csv;charset=utf-8" })
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = `past-claims-${new Date().toISOString().slice(0, 10)}.csv`
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

/** An imported row sometimes holds a lone dash where a name should be. */
function real(v: string | null | undefined): string | null {
  const t = (v ?? "").trim()
  return t === "" || /^[-\u2013\u2014]+$/.test(t) ? null : t
}

function formatDate(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ""
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })
}
