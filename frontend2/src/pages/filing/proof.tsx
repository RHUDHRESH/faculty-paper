import { useEffect, useRef, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import {
  AlertTriangle,
  CircleCheck,
  Copy,
  FileSearch,
  LoaderCircle,
  Paperclip,
  Trash2,
  Upload,
} from "lucide-react"

import { api } from "@/lib/api"
import { cn } from "@/lib/cn"
import { Button } from "@/ui/button"
import { Input } from "@/ui/field"
import { Callout } from "@/ui/state"
import { Meta } from "@/ui/text"

import { formatBytes } from "./bits"
import { normaliseDoi } from "./identifiers"
import type { AttachmentRow, CarriedEvidence, FileCheck, FormState } from "./types"

export const ACCEPT = ".pdf,.png,.jpg,.jpeg,.webp,.gif,.tif,.tiff,.doc,.docx"

function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setSettled(value), ms)
    return () => clearTimeout(t)
  }, [value, ms])
  return settled
}

/**
 * What the attached file was found to say, beside the file.
 *
 * Read on the server from the stored bytes (`/api/lookup/file-check`) and
 * compared with what this form says now -- so attaching last year's paper,
 * or the accepted manuscript instead of the published version, is caught
 * while it can still be swapped rather than by the research cell a week
 * later. It is a courtesy and never a verdict: a scan has no text, and a
 * publisher can print a DOI as an image, so nothing here blocks filing.
 */
function FileCheckLine({
  row,
  form,
  ownerId,
}: {
  row: AttachmentRow
  form: FormState
  ownerId?: string | null
}) {
  const refTitle = useDebounced((row.ref_title || "").trim(), 700)
  const title = form.paperTitle.trim()
  const doi = normaliseDoi(form.doi)
  const { data, isLoading } = useQuery({
    queryKey: ["file-check", row.url, row.kind, title, doi, form.journalTitle.trim(), refTitle],
    queryFn: () =>
      api<FileCheck>("/api/lookup/file-check", {
        method: "POST",
        json: {
          url: row.url,
          kind: row.kind,
          title: title || undefined,
          doi: doi || undefined,
          journal: form.journalTitle.trim() || undefined,
          issn: form.issn.trim() || undefined,
          ref_title: refTitle || undefined,
          owner_id: ownerId || undefined,
        },
      }),
    staleTime: 5 * 60 * 1000,
    retry: false,
  })

  if (isLoading) {
    return (
      <span className="mt-0.5 flex items-center gap-1.5 text-sm text-fg-muted">
        <LoaderCircle className="size-3.5 shrink-0 animate-spin" aria-hidden />
        Reading the file…
      </span>
    )
  }
  if (!data) return null
  const good = data.outcome === "MATCHED"
  const bad = data.outcome === "MISMATCH" || data.outcome === "UNREADABLE"
  const Icon = good ? CircleCheck : bad ? AlertTriangle : FileSearch
  return (
    <span
      className={cn(
        "mt-0.5 flex items-start gap-1.5 text-sm",
        good ? "text-positive" : bad ? "text-caution" : "text-fg-muted"
      )}
    >
      <Icon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
      <span>{data.summary}</span>
    </span>
  )
}

/**
 * One kind of evidence: its files, a drop zone, and what each file says.
 *
 * The whole group is a drop target, and a reference list takes several files
 * in one drop -- people cite five SEC papers and used to add them one dialog
 * at a time. Each file still goes up on its own, so each gets its own
 * fingerprint check.
 */
export function AttachmentGroup({
  title,
  hint,
  kind,
  rows,
  busy,
  empty,
  sameAs,
  onAdd,
  onRemove,
  renderExtra,
  form,
  ownerId,
  error,
  anchorId,
}: {
  title: string
  hint: string
  kind: AttachmentRow["kind"]
  rows: AttachmentRow[]
  busy: boolean
  /** Said in place of the list when nothing is attached. An unexplained gap
   *  above an upload button reads as "this is optional", which for the
   *  published paper is the opposite of true. */
  empty: string
  /** From `sameFileOnThisForm`, over *every* attachment rather than this
   *  group's — the published paper dropped a second time into the reference
   *  list is the same mistake and has to be caught across the two. */
  sameAs: Map<string, string>
  onAdd: (kind: AttachmentRow["kind"], file: File) => Promise<void>
  onRemove: (url: string) => void
  renderExtra?: (row: AttachmentRow) => React.ReactNode
  form: FormState
  ownerId?: string | null
  /** The reason this step cannot be left, when this group is the reason. */
  error?: string
  anchorId?: string
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [over, setOver] = useState(false)
  const many = kind === "SEC_REFERENCE"

  async function addAll(files: FileList | File[] | null | undefined) {
    const list = Array.from(files || [])
    for (const file of many ? list : list.slice(0, 1)) await onAdd(kind, file)
  }

  return (
    <div
      id={anchorId}
      tabIndex={-1}
      className="space-y-2 outline-none"
      onDragOver={(e) => {
        if (busy || !e.dataTransfer.types.includes("Files")) return
        e.preventDefault()
        setOver(true)
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        setOver(false)
        if (busy) return
        e.preventDefault()
        void addAll(e.dataTransfer.files)
      }}
    >
      <div>
        <p className="text-base font-medium">{title}</p>
        <p className="text-sm text-fg-muted">{hint}</p>
      </div>

      {rows.length > 0 && (
        <ul className="divide-y divide-line overflow-hidden rounded-md bg-surface ring-1 ring-inset ring-line">
          {rows.map((row) => (
            <li key={row.url} className="px-3 py-2.5">
              <div className="flex items-start justify-between gap-3">
                <span className="flex min-w-0 items-start gap-2">
                  <Paperclip className="mt-0.5 size-4 shrink-0 text-fg-subtle" aria-hidden />
                  <span className="min-w-0">
                    {/* Wraps on a phone rather than truncating: two scans
                        named alike are told apart by their last characters. */}
                    <span className="block break-all text-sm sm:truncate">{row.filename}</span>
                    <Meta className="block">{formatBytes(row.size_bytes)}</Meta>
                    <FileCheckLine row={row} form={form} ownerId={ownerId} />
                    {sameAs.has(row.url) && (
                      <span className="mt-0.5 flex items-start gap-1.5 text-sm text-caution">
                        <Copy className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                        <span>
                          The same file as {sameAs.get(row.url)}, attached twice. If they are
                          different papers, attach the right one here.
                        </span>
                      </span>
                    )}
                    {row.duplicateOf && (
                      <span className="mt-0.5 flex items-start gap-1.5 text-sm text-caution">
                        <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                        <span>
                          {row.duplicateOf.same_owner
                            ? `Already attached to ${row.duplicateOf.ticket_number || "another of your papers"}`
                            : `Already on ${row.duplicateOf.ticket_number || "a claim"} filed by ${row.duplicateOf.owner_name}`}
                          . That is fine if the same paper really is cited again — the research
                          cell sees the same fingerprint from its side.
                        </span>
                      </span>
                    )}
                  </span>
                </span>
                <Button
                  kind="quiet"
                  size="icon"
                  aria-label={`Remove ${row.filename}`}
                  onClick={() => onRemove(row.url)}
                >
                  <Trash2 className="text-critical" />
                </Button>
              </div>
              {renderExtra?.(row)}
            </li>
          ))}
        </ul>
      )}

      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT}
        multiple={many}
        className="sr-only"
        tabIndex={-1}
        aria-hidden
        onChange={(e) => {
          const files = e.target.files ? Array.from(e.target.files) : []
          e.target.value = ""
          void addAll(files)
        }}
      />
      <div
        className={cn(
          "flex flex-col items-center justify-center gap-2 rounded-md border border-dashed px-4 text-center",
          "transition-colors duration-[var(--dur-1)]",
          rows.length ? "min-h-16 py-3" : "min-h-28 py-5",
          over ? "border-accent bg-accent-wash" : error ? "border-critical bg-critical-wash" : "border-edge bg-sunken"
        )}
      >
        {rows.length === 0 && !busy && <p className="text-sm text-fg-muted">{empty}</p>}
        <div className="flex flex-wrap items-center justify-center gap-2">
          <Button kind="default" size="md" onClick={() => inputRef.current?.click()} disabled={busy}>
            {busy ? <LoaderCircle className="animate-spin" /> : <Upload />}
            {busy
              ? "Uploading — wait for this one"
              : rows.length
                ? many
                  ? "Add more files"
                  : "Replace or add a file"
                : many
                  ? "Choose files"
                  : "Choose a file"}
          </Button>
          {!busy && (
            <span className="text-sm text-fg-subtle">
              or drop {many ? "them" : "it"} here
            </span>
          )}
        </div>
      </div>
      {error && (
        <p role="alert" className="text-sm text-critical">
          {error}
        </p>
      )}
    </div>
  )
}

/**
 * How many of the attached references the payout will actually count, said
 * as a number, on the step where the files are.
 *
 * The server refuses a paid claim short of the policy's numbered references
 * rather than ticketing it at ₹0, so this says what will be refused rather
 * than what will pay nothing -- the two are not interchangeable.
 */
export function ReferenceTally({
  attached,
  numbered,
  needed,
  why,
  carried,
  paid,
}: {
  attached: number
  numbered: number
  needed: number
  why: string
  carried: CarriedEvidence
  paid: boolean
}) {
  if (attached > 0 && numbered >= needed) {
    return (
      <p className="text-sm text-fg-muted">
        {numbered} of {attached} attached reference{attached === 1 ? "" : "s"} carry a reference
        number, which is what the amount is counted from. The policy needs {needed}.
      </p>
    )
  }

  const passesEvidenceGate = attached > 0 || Boolean(carried.secProofUrl)
  const passesNumberGate = numbered > 0 || Boolean(carried.secRefs)
  // Filing is blocked outright, so this is not yet a story about money.
  if (!passesEvidenceGate || !passesNumberGate) return null

  return (
    <Callout
      tone={paid ? "critical" : "caution"}
      title={
        paid
          ? `This will be refused: ${numbered} of the ${needed} references the policy counts ${numbered === 1 ? "is" : "are"} numbered`
          : `${numbered} of the ${needed} references the policy counts are numbered`
      }
    >
      <p>
        The amount is worked out from attached reference files that carry a reference number, and{" "}
        {numbered === 0 ? "none of them do" : `only ${numbered} of them ${numbered === 1 ? "does" : "do"}`}
        . {why}
      </p>
      {attached === 0 && Boolean(carried.secProofUrl) && (
        <p className="mt-2">
          This claim evidences its references with a link rather than files. The amount does not
          count a link, so attach the cited papers themselves.
        </p>
      )}
      {attached > 0 && numbered === 0 && Boolean(carried.secRefs) && (
        <p className="mt-2">
          Reference numbers left on the claim from an earlier version ({carried.secRefs}) are not
          attached to any of the files above, so the amount counts none of them.
        </p>
      )}
      <p className="mt-2">
        Attach each cited SEC reference and put its number from your reference list beside it.
      </p>
    </Callout>
  )
}

/** The reference number and title boxes under one cited reference. */
export function ReferenceFields({
  row,
  onUpdate,
}: {
  row: AttachmentRow
  onUpdate: (url: string, patch: Partial<AttachmentRow>) => void
}) {
  const missingNumber = !(row.ref_number || "").trim()
  return (
    <div className="mt-2 space-y-1.5">
      <div className="grid gap-2 sm:grid-cols-[10rem_minmax(0,1fr)]">
        <Input
          value={row.ref_number || ""}
          onChange={(e) => onUpdate(row.url, { ref_number: e.target.value })}
          placeholder="Number, e.g. 12"
          inputMode="numeric"
          aria-label={`Reference number for ${row.filename}`}
          aria-invalid={missingNumber || undefined}
        />
        <Input
          value={row.ref_title || ""}
          onChange={(e) => onUpdate(row.url, { ref_title: e.target.value })}
          placeholder="Reference title (optional)"
          aria-label={`Reference title for ${row.filename}`}
        />
      </div>
      {/* The number is not a label on the file. It is the only thing that
          makes the file count towards the money. */}
      {missingNumber && (
        <p className="text-sm text-caution">
          No reference number — this file is attached but counts for nothing in the amount.
        </p>
      )}
    </div>
  )
}
