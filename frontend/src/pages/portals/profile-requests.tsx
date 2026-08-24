"use client"

import { useState } from "react"
import { Check, ShieldAlert, X } from "lucide-react"
import { toast } from "sonner"

import { useAuth } from "@/components/auth-provider"
import { EmptyState, ErrorState, PageHeader, Section } from "@/components/layout/page"
import { LoadingPage } from "@/components/loading"
import { formatDateTime } from "@/components/ticket-ui"
import { Badge } from "@/components/ui/badge"
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
import { api } from "@/lib/api"
import { useApiQuery } from "@/lib/queries"
import { cn } from "@/lib/utils"

/**
 * Profile corrections, as a queue somebody can finish.
 *
 * A claimant cannot write their own name, staff id or biometric id: those
 * decide who gets paid and whose record a paper is checked against. That is
 * right, and it left them able only to ask — and asking used to produce a
 * notification and an audit entry, both write-only. An admin who missed the
 * notification lost the request, nothing listed what was outstanding, and the
 * person who asked never found out whether anything had happened.
 *
 * Approving writes the value onto the account from here, rather than sending
 * the admin to another screen to retype it, because that retyping is where a
 * correction becomes somebody else's staff id.
 */

type Request = {
  id: string
  field: string
  label: string
  current_value: string
  proposed_value: string
  value_now: string
  note: string
  status: "PENDING" | "APPROVED" | "DECLINED"
  identity: boolean
  requested_by: {
    id: string
    name: string
    email: string
    department: string
    staff_id: string
  }
  decided_by: string | null
  decided_at: string | null
  decision_note: string
  created_at: string | null
}

const TABS = [
  { key: "PENDING", label: "Waiting" },
  { key: "APPROVED", label: "Applied" },
  { key: "DECLINED", label: "Declined" },
  { key: "ALL", label: "Everything" },
] as const

export function ProfileRequestsPage() {
  const { user } = useAuth()
  const [tab, setTab] = useState<string>("PENDING")
  const [deciding, setDeciding] = useState<{ row: Request; approve: boolean } | null>(null)

  const { data, isLoading, isError, refetch } = useApiQuery<{
    results: Request[]
    pending: number
  }>(["profile-requests", tab], `/api/admin/profile-requests?status=${tab}`)

  if (isError) return <ErrorState onRetry={() => refetch()} />
  if (isLoading || !data) return <LoadingPage />

  const isSuperAdmin = user?.role === "SUPER_ADMIN"

  return (
    <div className="space-y-6">
      <PageHeader
        title="Profile corrections"
        subtitle="Details a claimant cannot change themselves, waiting on somebody here"
      />

      <div className="flex flex-wrap gap-2">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={cn(
              "interactive rounded-full border px-3 py-1 text-xs",
              tab === t.key
                ? "border-primary bg-primary text-primary-foreground"
                : "border-border hover:border-primary/40"
            )}
          >
            {t.label}
            {t.key === "PENDING" && data.pending ? ` · ${data.pending}` : ""}
          </button>
        ))}
      </div>

      <Section
        title={TABS.find((t) => t.key === tab)?.label || "Requests"}
        description={`${data.results.length} request${data.results.length === 1 ? "" : "s"}`}
      >
        {data.results.length === 0 ? (
          <EmptyState
            title={tab === "PENDING" ? "Nothing waiting" : "Nothing here"}
            description={
              tab === "PENDING"
                ? "Every correction that has been asked for has been dealt with."
                : undefined
            }
          />
        ) : (
          <ul className="space-y-3">
            {data.results.map((r) => (
              <li key={r.id} className="surface-card p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium">
                      {r.requested_by.name}
                      <span className="ml-2 font-normal text-muted-foreground">
                        {r.requested_by.department || "—"}
                        {r.requested_by.staff_id ? ` · ${r.requested_by.staff_id}` : ""}
                      </span>
                    </p>
                    <p className="text-xs text-muted-foreground">{r.requested_by.email}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    {r.identity ? (
                      <Badge
                        variant="outline"
                        className="border-warning/30 bg-warning/10 text-warning-foreground"
                      >
                        <ShieldAlert className="mr-1 size-3" aria-hidden />
                        Identity — super admin only
                      </Badge>
                    ) : null}
                    <Badge
                      variant="outline"
                      className={cn(
                        r.status === "APPROVED" && "border-success/30 bg-success/10 text-success",
                        r.status === "DECLINED" && "border-destructive/30 bg-destructive/10 text-destructive"
                      )}
                    >
                      {r.status === "PENDING" ? "Waiting" : r.status === "APPROVED" ? "Applied" : "Declined"}
                    </Badge>
                  </div>
                </div>

                <div className="mt-3 rounded-[var(--radius)] border border-border bg-muted/40 px-3 py-2">
                  <p className="text-xs text-muted-foreground">{r.label}</p>
                  <p className="mt-0.5 text-sm">
                    <span className="text-muted-foreground line-through">
                      {r.current_value || "not set"}
                    </span>
                    <span className="mx-2 text-muted-foreground">→</span>
                    <span className="font-medium">{r.proposed_value}</span>
                  </p>
                  {/* The record can move under a pending request, and an
                      approver overwriting something other than what was asked
                      about should be told rather than left to compare two
                      screens. */}
                  {r.status === "PENDING" && r.value_now !== r.current_value ? (
                    <p className="mt-1.5 text-xs text-warning-foreground">
                      It now reads “{r.value_now || "not set"}” — it changed after this was
                      asked for.
                    </p>
                  ) : null}
                </div>

                {r.note ? (
                  <p className="mt-2 text-sm italic text-muted-foreground">“{r.note}”</p>
                ) : null}

                <p className="mt-2 text-xs text-muted-foreground">
                  Asked {formatDateTime(r.created_at)}
                  {r.decided_at
                    ? ` · ${r.status === "APPROVED" ? "applied" : "declined"} by ${
                        r.decided_by || "somebody"
                      } ${formatDateTime(r.decided_at)}`
                    : ""}
                </p>
                {r.decision_note ? (
                  <p className="mt-1 text-xs italic text-muted-foreground">
                    “{r.decision_note}”
                  </p>
                ) : null}

                {r.status === "PENDING" ? (
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      onClick={() => setDeciding({ row: r, approve: true })}
                      disabled={r.identity && !isSuperAdmin}
                      title={
                        r.identity && !isSuperAdmin
                          ? "Only a super admin can apply an identity change"
                          : undefined
                      }
                    >
                      <Check className="size-4" />
                      Apply it
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setDeciding({ row: r, approve: false })}
                    >
                      <X className="size-4" />
                      Decline
                    </Button>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <DecideDialog
        deciding={deciding}
        onClose={() => setDeciding(null)}
        onDone={() => {
          setDeciding(null)
          refetch()
        }}
      />
    </div>
  )
}

function DecideDialog({
  deciding,
  onClose,
  onDone,
}: {
  deciding: { row: Request; approve: boolean } | null
  onClose: () => void
  onDone: () => void
}) {
  const [note, setNote] = useState("")
  const [busy, setBusy] = useState(false)

  if (!deciding) return null
  const { row, approve } = deciding

  async function save() {
    setBusy(true)
    try {
      await api(`/api/admin/profile-requests/${row.id}`, {
        method: "POST",
        json: { approve, note },
      })
      toast.success(approve ? "Applied — they have been told" : "Declined — they have been told")
      setNote("")
      onDone()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save that")
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={(v) => (v ? null : onClose())}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-left">
            {approve ? `Apply this ${row.label.toLowerCase()}?` : "Decline this request?"}
          </DialogTitle>
          <DialogDescription className="text-left">
            {approve ? (
              <>
                {row.requested_by.name}’s {row.label.toLowerCase()} becomes{" "}
                <span className="font-medium text-foreground">{row.proposed_value}</span>.
                They are told either way.
              </>
            ) : (
              <>
                {row.requested_by.name} is shown the reason you give, so write it for them
                rather than for the log.
              </>
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-1.5">
          <Label htmlFor="decision-note">
            {approve ? "Note (optional)" : "Why is it being declined?"}
          </Label>
          <Input
            id="decision-note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={
              approve
                ? "e.g. checked against the ERP sheet"
                : "e.g. the staff id on the ERP roster is the one payroll uses"
            }
          />
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant={approve ? "default" : "destructive"}
            onClick={save}
            disabled={busy || (!approve && note.trim().length < 5)}
          >
            {busy ? "Saving…" : approve ? "Apply it" : "Decline"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
