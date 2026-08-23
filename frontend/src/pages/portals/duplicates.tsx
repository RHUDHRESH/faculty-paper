"use client"

import { useState } from "react"
import { toast } from "sonner"
import { AlertOctagon, Check, Users, X } from "lucide-react"

import { Callout } from "@/components/form/fields"
import { EmptyState, ErrorState, PageHeader, Section } from "@/components/layout/page"
import { Money, formatDateTime, formatMoney } from "@/components/ticket-ui"
import { LoadingTable } from "@/components/loading"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Pager } from "@/components/ui/pagination"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { api } from "@/lib/api"
import { useApiQuery } from "@/lib/queries"
import { cn } from "@/lib/utils"

/**
 * Payments that look like they were made twice.
 *
 * Duplicate detection only ever ran when a claim was submitted, so the three
 * thousand payments imported from the old ERP were never checked against each
 * other at all. A sweep groups them by paper; this is where somebody decides
 * what each group actually is.
 *
 * The two kinds are kept apart on purpose. One person paid twice for one paper
 * is nearly always wrong. One paper paid to several people is nearly always
 * right — they are co-authors, and the scheme pays each by author position —
 * so those are here to be seen, not to be answered.
 */

const PAGE = 25

type Row = {
  reference: string | null
  amount: number
  when: string | null
  person: string | null
  department: string | null
  source: string
}

type Finding = {
  id: string
  kind: string
  status: string
  matched_on: string
  paper_title: string | null
  faculty_name: string | null
  payment_count: number
  total_amount: number
  extra_amount: number
  rows: Row[]
  note: string | null
  recovered_amount: number | null
  reviewed_by_name: string | null
  reviewed_at: string | null
}

type Response = {
  total: number
  results: Finding[]
  summary: {
    open: number
    confirmed: number
    dismissed: number
    recovered: number
    at_issue: number
    recovered_amount: number
  }
}

const STATUS_LABEL: Record<string, string> = {
  OPEN: "Not yet reviewed",
  CONFIRMED: "A real duplicate",
  DISMISSED: "Not a duplicate",
  RECOVERED: "Recovered",
}

export function DuplicateFindingsPage() {
  const [kind, setKind] = useState("SAME_PERSON")
  const [status, setStatus] = useState("OPEN")
  const [offset, setOffset] = useState(0)
  const [review, setReview] = useState<{ finding: Finding; to: string } | null>(null)
  const [note, setNote] = useState("")
  const [recovered, setRecovered] = useState("")
  const [busy, setBusy] = useState(false)

  const query = `kind=${kind}${status ? `&status=${status}` : ""}&limit=${PAGE}&offset=${offset}`
  const { data, isLoading, isError, refetch } = useApiQuery<Response>(
    ["duplicate-findings", query],
    `/api/admin/duplicate-findings?${query}`
  )

  const rows = data?.results || []
  const samePerson = kind === "SAME_PERSON"

  async function decide() {
    if (!review) return
    if (review.to === "DISMISSED" && note.trim().length < 5) {
      toast.error("Say why this is not a duplicate")
      return
    }
    setBusy(true)
    try {
      await api(`/api/admin/duplicate-findings/${review.finding.id}`, {
        method: "POST",
        json: {
          status: review.to,
          note: note.trim() || undefined,
          recovered_amount: recovered ? Number(recovered) : undefined,
        },
      })
      toast.success(STATUS_LABEL[review.to] || "Recorded")
      setReview(null)
      setNote("")
      setRecovered("")
      await refetch()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not record that")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Possible duplicate payments"
        subtitle="A sweep of everything already paid, grouped by paper"
      />

      {data?.summary ? (
        <Section title={samePerson ? "Same person, same paper" : "One paper, several people"}>
          <div className="grid gap-3 sm:grid-cols-4">
            {[
              { label: "Not yet reviewed", value: String(data.summary.open) },
              { label: "Confirmed", value: String(data.summary.confirmed) },
              {
                label: samePerson ? "Sum at issue" : "Paid in total",
                value: formatMoney(data.summary.at_issue),
              },
              { label: "Recovered", value: formatMoney(data.summary.recovered_amount) },
            ].map((s) => (
              <div
                key={s.label}
                className="rounded-[var(--radius)] border border-border bg-card px-5 py-4"
              >
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {s.label}
                </p>
                <p className="mt-1 text-2xl font-semibold tabular-nums text-foreground">
                  {s.value}
                </p>
              </div>
            ))}
          </div>
        </Section>
      ) : null}

      {samePerson ? (
        <Callout tone="warning" title="Two kinds of evidence, and they are not equal">
          A group matched on <strong>DOI</strong> is the same article by definition —
          one person paid twice for one paper. A group matched on <strong>title
          only</strong> can be two different papers, and an ERP row sometimes holds a
          description rather than a title. Open the payments before deciding either
          way: this is a queue of things to check, not a list of findings against
          anybody.
        </Callout>
      ) : (
        <Callout tone="info" title="Co-authors are expected, not suspect">
          The scheme pays each SEC author of a paper by their position on it, so one
          paper reaching several people is normally correct. These are here so the
          total paid against a single paper can be seen in one place.
        </Callout>
      )}

      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="dup-kind" className="text-xs">
            Kind
          </Label>
          <Select
            value={kind}
            onValueChange={(v) => {
              setKind(v)
              setOffset(0)
            }}
          >
            <SelectTrigger id="dup-kind" className="w-64">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="SAME_PERSON">Same person paid more than once</SelectItem>
              <SelectItem value="CROSS_PERSON">One paper paid to several people</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="dup-status" className="text-xs">
            Status
          </Label>
          <Select
            value={status}
            onValueChange={(v) => {
              setStatus(v === "ALL" ? "" : v)
              setOffset(0)
            }}
          >
            <SelectTrigger id="dup-status" className="w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="OPEN">Not yet reviewed</SelectItem>
              <SelectItem value="CONFIRMED">Confirmed</SelectItem>
              <SelectItem value="DISMISSED">Dismissed</SelectItem>
              <SelectItem value="RECOVERED">Recovered</SelectItem>
              <SelectItem value="ALL">All</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {isError ? (
        <ErrorState onRetry={() => refetch()} />
      ) : isLoading ? (
        <LoadingTable rows={4} columns={4} caption="Loading the findings…" />
      ) : rows.length === 0 ? (
        <EmptyState
          title="Nothing here"
          description="No group matches those filters."
        />
      ) : (
        <>
          <ul className="space-y-3">
            {rows.map((f) => (
              <li
                key={f.id}
                className={cn(
                  "rounded-[var(--radius)] border p-4",
                  f.status === "OPEN"
                    ? "border-warning/40 bg-warning/5"
                    : "border-border bg-card"
                )}
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="flex items-center gap-2 text-sm font-semibold text-foreground">
                      {f.kind === "SAME_PERSON" ? (
                        <AlertOctagon className="size-4 shrink-0 text-warning" aria-hidden />
                      ) : (
                        <Users className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                      )}
                      {f.faculty_name || "Unknown"}
                    </p>
                    <p className="mt-0.5 line-clamp-2 text-sm text-muted-foreground">
                      {f.paper_title || "—"}
                    </p>
                    <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                      <span>{f.payment_count} payments</span>
                      {/* A DOI is the same article by definition; a shared
                          title can be two different papers. The reader should
                          not have to know which word means which. */}
                      {f.matched_on === "doi" ? (
                        <span className="rounded-full bg-destructive/15 px-2 py-0.5 font-medium text-destructive">
                          Same DOI — the same article
                        </span>
                      ) : (
                        <span className="rounded-full bg-muted px-2 py-0.5">
                          Matched on title only
                        </span>
                      )}
                      {f.status !== "OPEN" ? ` · ${STATUS_LABEL[f.status] || f.status}` : ""}
                      {f.reviewed_by_name
                        ? ` by ${f.reviewed_by_name}${
                            f.reviewed_at ? ` · ${formatDateTime(f.reviewed_at)}` : ""
                          }`
                        : ""}
                    </p>
                  </div>
                  <div className="shrink-0 text-right">
                    <p className="text-xs uppercase tracking-wide text-muted-foreground">
                      {f.kind === "SAME_PERSON" ? "At issue" : "Paid in total"}
                    </p>
                    <p className="text-xl font-semibold tabular-nums text-foreground">
                      <Money value={f.kind === "SAME_PERSON" ? f.extra_amount : f.total_amount} />
                    </p>
                  </div>
                </div>

                <div className="mt-3 overflow-x-auto rounded-xl border border-border bg-background">
                  <table className="w-full min-w-[34rem] text-left text-sm">
                    <thead className="border-b border-border text-xs uppercase text-muted-foreground">
                      <tr>
                        {["Reference", "Paid to", "Month", "Amount"].map((h) => (
                          <th key={h} className="px-3 py-2 font-medium">
                            {h}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {f.rows.map((r, i) => (
                        <tr key={`${r.reference}-${i}`} className="border-b border-border/50 last:border-0">
                          <td className="px-3 py-2 font-mono text-xs">{r.reference || "—"}</td>
                          <td className="px-3 py-2">{r.person || "—"}</td>
                          <td className="px-3 py-2 tabular-nums">{r.when || "—"}</td>
                          <td className="px-3 py-2 font-medium tabular-nums">
                            <Money value={r.amount} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {f.note ? (
                  <p className="mt-2 rounded-lg border border-border bg-muted/30 px-3 py-2 text-sm">
                    {f.note}
                  </p>
                ) : null}

                {f.kind === "SAME_PERSON" ? (
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      variant="destructive"
                      onClick={() => setReview({ finding: f, to: "CONFIRMED" })}
                    >
                      <Check className="size-3.5" />
                      It is a duplicate
                    </Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => setReview({ finding: f, to: "DISMISSED" })}
                    >
                      <X className="size-3.5" />
                      Not a duplicate
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setReview({ finding: f, to: "RECOVERED" })}
                    >
                      Recovered
                    </Button>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>

          <Pager
            total={data?.total || 0}
            limit={PAGE}
            offset={offset}
            onOffsetChange={setOffset}
          />
        </>
      )}

      <Dialog open={!!review} onOpenChange={(o) => !o && setReview(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{STATUS_LABEL[review?.to || ""] || "Record a decision"}</DialogTitle>
            <DialogDescription>
              {review?.finding.faculty_name} — {review?.finding.paper_title?.slice(0, 90)}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="dup-note">
                {review?.to === "DISMISSED" ? "Why is it not a duplicate?" : "Note"}
              </Label>
              <Textarea
                id="dup-note"
                rows={3}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder={
                  review?.to === "DISMISSED"
                    ? "e.g. two different papers with the same title in the sheet"
                    : "Anything the next reader needs"
                }
              />
            </div>
            {review?.to === "RECOVERED" ? (
              <div className="space-y-1.5">
                <Label htmlFor="dup-recovered">Amount recovered</Label>
                <Input
                  id="dup-recovered"
                  inputMode="decimal"
                  value={recovered}
                  onChange={(e) => setRecovered(e.target.value)}
                  placeholder={String(review?.finding.extra_amount ?? "")}
                />
              </div>
            ) : null}
          </div>

          <DialogFooter>
            <Button variant="ghost" onClick={() => setReview(null)}>
              Cancel
            </Button>
            <Button disabled={busy} onClick={decide}>
              {busy ? "Saving…" : "Record"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
