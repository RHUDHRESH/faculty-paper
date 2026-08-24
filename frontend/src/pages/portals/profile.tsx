"use client"

import { useState } from "react"
import { Link } from "react-router-dom"
import { toast } from "sonner"
import { ExternalLink, Plus, ShieldCheck } from "lucide-react"

import { useAuth } from "@/components/auth-provider"
import { SCOPUS_FEEDBACK_WIZARD } from "@/components/claim-eligibility-notice"
import { Callout, ReadOnlyField } from "@/components/form/fields"
import { InsetList, PageHeader, Section } from "@/components/layout/page"
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
import { Badge } from "@/components/ui/badge"
import { formatDateTime } from "@/components/ticket-ui"
import { useApiQuery } from "@/lib/queries"
import { cn } from "@/lib/utils"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { api } from "@/lib/api"

/**
 * Your details, as the research cell holds them.
 *
 * Nothing here is editable any more. Every field is identity: the name on the
 * payment, the department the ticket is filed under, the biometric ID that
 * picks the account, and the Scopus link deciding whose record a paper is
 * checked against. A claimant editing their own is how a claim gets attributed
 * — or paid — to the wrong person.
 *
 * Locking it without a way to fix a mistake would just mean chasing somebody by
 * email while the claim stays blocked, so a correction is requested from here
 * and reaches the research cell as a notification and an audit entry.
 */

/** Field key → what the claimant sees. Must match CORRECTABLE on the server. */
const FIELDS: { key: string; label: string; hint?: string }[] = [
  { key: "name", label: "Full name", hint: "As it should appear on the payment." },
  {
    key: "department",
    label: "Department",
    hint: "Decides which department your tickets are filed under.",
  },
  { key: "designation", label: "Designation" },
  { key: "staff_id", label: "Staff ID" },
  {
    key: "biometric_id",
    label: "Biometric ID",
    hint: "Linked to the account that is paid. A claim cannot be submitted without it.",
  },
  {
    key: "scopus_author_url",
    label: "Scopus author link",
    hint: "Your own author profile. A paper is only counted when it appears on it.",
  },
  { key: "scopus_author_id", label: "Scopus author ID" },
]

function CorrectionDialog({
  open,
  onClose,
  initialField,
  current,
}: {
  open: boolean
  onClose: () => void
  initialField: string
  current: Record<string, unknown>
}) {
  const [field, setField] = useState(initialField)
  const [proposed, setProposed] = useState("")
  const [note, setNote] = useState("")
  const [busy, setBusy] = useState(false)

  const meta = FIELDS.find((f) => f.key === field)

  async function send() {
    if (!proposed.trim()) {
      toast.error("Say what it should be")
      return
    }
    setBusy(true)
    try {
      await api("/api/auth/profile/correction", {
        method: "POST",
        json: { field, proposed: proposed.trim(), note: note.trim() },
      })
      toast.success("Sent to the research cell")
      setProposed("")
      setNote("")
      onClose()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not send the request")
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Request a correction</DialogTitle>
          <DialogDescription>
            The research cell holds these details. Tell them what is wrong and they
            will change it — you will see the update here once they have.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="corr-field">Which detail</Label>
            <Select value={field} onValueChange={(v) => setField(v)}>
              <SelectTrigger id="corr-field">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {FIELDS.map((f) => (
                  <SelectItem key={f.key} value={f.key}>
                    {f.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label>Currently</Label>
            <p className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
              {String(current[field] || "Not set")}
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="corr-proposed">Should be</Label>
            <Input
              id="corr-proposed"
              value={proposed}
              onChange={(e) => setProposed(e.target.value)}
              placeholder={meta?.label}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="corr-note">Anything that helps (optional)</Label>
            <Textarea
              id="corr-note"
              rows={2}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="e.g. this link points at a different S. Kumar"
            />
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="button" disabled={busy} onClick={send}>
            {busy ? "Sending…" : "Send request"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function FacultyProfilePage() {
  const { user } = useAuth()
  const [open, setOpen] = useState(false)
  const [field, setField] = useState("name")

  const current = (user || {}) as unknown as Record<string, unknown>
  const scopusUrl = String(current.scopus_author_url || "")

  function request(key: string) {
    setField(key)
    setOpen(true)
  }

  return (
    <div>
      <PageHeader
        title="Profile"
        subtitle="Your details as the research cell holds them — they autofill every new ticket"
        actions={
          <Button asChild variant="secondary">
            <Link to="/faculty/new">
              <Plus className="size-4" />
              New ticket
            </Link>
          </Button>
        }
      />

      <div className="mx-auto max-w-2xl space-y-6">
        <Callout tone="info" title="These are held for you, not by you">
          <span className="flex items-start gap-2">
            <ShieldCheck className="mt-0.5 size-4 shrink-0" aria-hidden />
            <span>
              Every detail here decides something: which department your ticket is
              filed under, which account is paid, and whose Scopus record a paper is
              checked against. The research cell keeps them so a typo cannot send a
              payment to the wrong person. If any of it is wrong, ask them to fix it
              and they will.
            </span>
          </span>
        </Callout>

        {/* What you asked for, and what came of it. Submitting used to be the
            end of the story from this side: no list, no outcome, no way to
            tell whether anybody had seen it. */}
        <MyCorrections />

        <Section
          title="Your details"
          actions={
            <Button type="button" size="sm" variant="secondary" onClick={() => request("name")}>
              Request a correction
            </Button>
          }
        >
          <InsetList>
            {FIELDS.map((f) => (
              <div
                key={f.key}
                className="flex min-h-11 items-start justify-between gap-4 px-4 py-3"
              >
                <span className="min-w-0">
                  <span className="block text-sm text-foreground">{f.label}</span>
                  {f.hint ? (
                    <span className="mt-0.5 block text-xs text-muted-foreground">
                      {f.hint}
                    </span>
                  ) : null}
                </span>
                <span className="flex shrink-0 items-center gap-3">
                  <span
                    className={
                      current[f.key]
                        ? "max-w-[16rem] truncate text-sm text-foreground"
                        : "text-sm text-muted-foreground"
                    }
                  >
                    {String(current[f.key] || "Not set")}
                  </span>
                  <button
                    type="button"
                    onClick={() => request(f.key)}
                    className="interactive text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                  >
                    Fix
                  </button>
                </span>
              </div>
            ))}
          </InsetList>
        </Section>

        <Section title="Email">
          <ReadOnlyField label="Sign-in email" value={String(current.email || "")} />
        </Section>

        {scopusUrl ? (
          <Section
            title="Your Scopus profile"
            description="A paper is only counted once it appears on this profile"
          >
            <InsetList>
              <div className="flex items-center justify-between gap-4 px-4 py-3">
                <a
                  href={scopusUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="interactive min-w-0 truncate text-sm text-primary underline-offset-4 hover:underline"
                >
                  {scopusUrl}
                </a>
                <ExternalLink className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              </div>
              <div className="px-4 py-3 text-xs text-muted-foreground">
                An article linked to the wrong Scopus ID is merged or relinked through
                the{" "}
                <a
                  href={SCOPUS_FEEDBACK_WIZARD}
                  target="_blank"
                  rel="noreferrer"
                  className="underline underline-offset-2"
                >
                  Scopus Author Feedback Wizard
                </a>
                , not here.
              </div>
            </InsetList>
          </Section>
        ) : null}
      </div>

      <CorrectionDialog
        open={open}
        onClose={() => setOpen(false)}
        initialField={field}
        current={current}
      />
    </div>
  )
}

type MyRequest = {
  id: string
  label: string
  current_value: string
  proposed_value: string
  status: "PENDING" | "APPROVED" | "DECLINED"
  decision_note: string
  decided_at: string | null
  created_at: string | null
}

function MyCorrections() {
  const { data } = useApiQuery<{ results: MyRequest[] }>(
    ["my-corrections"],
    "/api/auth/profile/corrections"
  )
  const rows = data?.results || []
  if (!rows.length) return null

  return (
    <Section title="Corrections you have asked for" description="Newest first">
      <ul className="space-y-2">
        {rows.map((r) => (
          <li
            key={r.id}
            className="flex flex-wrap items-start justify-between gap-3 rounded-[var(--radius)] border border-border bg-card px-4 py-3"
          >
            <span className="min-w-0">
              <span className="block text-sm">
                <span className="text-muted-foreground">{r.label}:</span>{" "}
                <span className="text-muted-foreground line-through">
                  {r.current_value || "not set"}
                </span>
                <span className="mx-1.5 text-muted-foreground">→</span>
                <span className="font-medium">{r.proposed_value}</span>
              </span>
              <span className="mt-0.5 block text-xs text-muted-foreground">
                Asked {formatDateTime(r.created_at)}
                {r.decided_at ? ` · answered ${formatDateTime(r.decided_at)}` : ""}
              </span>
              {r.decision_note ? (
                <span className="mt-1 block text-xs italic text-muted-foreground">
                  “{r.decision_note}”
                </span>
              ) : null}
            </span>
            <Badge
              variant="outline"
              className={cn(
                r.status === "APPROVED" && "border-success/30 bg-success/10 text-success",
                r.status === "DECLINED" &&
                  "border-destructive/30 bg-destructive/10 text-destructive"
              )}
            >
              {r.status === "PENDING"
                ? "With the research cell"
                : r.status === "APPROVED"
                  ? "Applied"
                  : "Declined"}
            </Badge>
          </li>
        ))}
      </ul>
    </Section>
  )
}
