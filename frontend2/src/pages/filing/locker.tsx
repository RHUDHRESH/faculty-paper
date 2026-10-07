import { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { AlertTriangle, CircleCheck, CircleHelp, CircleX, FolderOpen } from "lucide-react"

import { api } from "@/lib/api"
import { cn } from "@/lib/cn"
import { Button } from "@/ui/button"
import { Meta } from "@/ui/text"

import { formatBytes } from "./bits"
import type { AttachmentRow } from "./types"

export type ProofCheck = {
  key: string
  status: "ok" | "warn" | "bad" | "unknown"
  title: string
  detail: string
}

export type Proof = {
  id: string
  kind: "ARTICLE" | "REFERENCE" | "OTHER"
  filename: string
  url: string
  size: number
  content_hash: string
  publication_id: string | null
  publication_title: string | null
  doi_found: string | null
  checks: ProofCheck[]
  worst: ProofCheck["status"]
  checked_at: string | null
  created_at: string
  used_on: string[]
}

export const KIND_LABEL: Record<Proof["kind"], string> = {
  ARTICLE: "Published article",
  REFERENCE: "SEC reference",
  OTHER: "Other",
}

export const LOCKER_KEY = ["me", "proofs"] as const

export function useLocker(enabled = true) {
  return useQuery({
    queryKey: LOCKER_KEY,
    queryFn: () => api<{ items: Proof[] }>("/api/me/proofs"),
    enabled,
    staleTime: 30 * 1000,
  })
}

const ICON = { ok: CircleCheck, warn: AlertTriangle, bad: CircleX, unknown: CircleHelp }
const TONE = { ok: "text-positive", warn: "text-caution", bad: "text-critical", unknown: "text-fg-muted" }
const WORD = { ok: "Passed", warn: "Worth a look", bad: "Problem", unknown: "Not checked" }

/** The automatic checks on one file, each with an icon and a plain reason. */
export function ProofChecks({ checks, compact = false }: { checks: ProofCheck[]; compact?: boolean }) {
  const shown = compact ? checks.filter((c) => c.status !== "ok") : checks
  if (shown.length === 0) {
    return compact && checks.length ? (
      <span className="mt-0.5 flex items-center gap-1.5 text-sm text-positive">
        <CircleCheck className="size-3.5 shrink-0" aria-hidden />
        Every proof locker check passed.
      </span>
    ) : null
  }
  return (
    <ul className="mt-1 space-y-1" aria-label="File checks">
      {shown.map((c) => {
        const Icon = ICON[c.status]
        return (
          <li key={c.key} className={cn("flex items-start gap-1.5 text-sm", TONE[c.status])}>
            <Icon className="mt-0.5 size-3.5 shrink-0" aria-label={WORD[c.status]} />
            <span>
              <span className="font-medium">{c.title}.</span>{" "}
              {c.detail && <span className="text-fg-muted">{c.detail}</span>}
            </span>
          </li>
        )
      })}
    </ul>
  )
}

/** Locker checks for a row already on the form, matched by the file's fingerprint. */
export function LockerChecksForRow({ row, proofs }: { row: AttachmentRow; proofs?: Proof[] }) {
  const proof = row.content_hash ? proofs?.find((p) => p.content_hash === row.content_hash) : undefined
  if (!proof) return null
  const bad = proof.checks.some((c) => c.status === "bad")
  return (
    <div>
      <ProofChecks checks={proof.checks} compact />
      {bad && (
        <p className="mt-1 text-sm text-caution">
          You can still file. The office decides, but claims with these problems are often sent back.
        </p>
      )}
    </div>
  )
}

/** "Choose from your locker": files already uploaded, with their checks, one tap to attach. */
export function LockerPicker({
  kind,
  attached,
  onPick,
}: {
  kind: AttachmentRow["kind"]
  attached: AttachmentRow[]
  onPick: (row: AttachmentRow) => void
}) {
  const [open, setOpen] = useState(false)
  const locker = useLocker(open)
  const want: Proof["kind"] = kind === "PUBLISHED_PAPER" ? "ARTICLE" : "REFERENCE"
  const onForm = new Set(attached.map((a) => a.content_hash).filter(Boolean))
  const items = (locker.data?.items ?? [])
    .filter((p) => !onForm.has(p.content_hash))
    .sort((a, b) => Number(b.kind === want) - Number(a.kind === want))

  return (
    <div className="w-full">
      <Button kind="default" size="md" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <FolderOpen />
        Choose from your locker
      </Button>
      {open && (
        <div className="mt-2 rounded-md bg-surface p-2 text-left ring-1 ring-inset ring-line">
          {locker.isLoading ? (
            <p className="p-2 text-sm text-fg-muted">Opening your locker…</p>
          ) : items.length === 0 ? (
            <p className="p-2 text-sm text-fg-muted">
              Nothing else in your locker yet. Files you upload here are saved to it for next time.
            </p>
          ) : (
            <ul className="divide-y divide-line">
              {items.map((p) => (
                <li key={p.id} className="flex flex-col gap-2 p-2 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <p className="break-all text-sm font-medium">{p.filename}</p>
                    <Meta className="block">
                      {KIND_LABEL[p.kind]} · {formatBytes(p.size)}
                      {p.publication_title ? ` · ${p.publication_title}` : ""}
                    </Meta>
                    <ProofChecks checks={p.checks} compact />
                  </div>
                  <Button
                    size="sm"
                    kind="primary"
                    aria-label={`Attach ${p.filename}`}
                    onClick={() => {
                      onPick({
                        kind,
                        url: p.url,
                        filename: p.filename,
                        size_bytes: p.size,
                        content_hash: p.content_hash,
                        ref_number: kind === "SEC_REFERENCE" ? "" : undefined,
                        ref_title: kind === "SEC_REFERENCE" ? "" : undefined,
                      })
                      if (kind === "PUBLISHED_PAPER") setOpen(false)
                    }}
                  >
                    Attach
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
