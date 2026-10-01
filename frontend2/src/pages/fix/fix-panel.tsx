import { useState } from "react"
import { Upload } from "lucide-react"

import { ApiError } from "@/lib/api"
import { cn } from "@/lib/cn"
import { Button } from "@/ui/button"
import { Field, Input, Select } from "@/ui/field"
import type { Attachment } from "@/ui/attachments"
import { suggestField, type FixItem, type FixKind } from "./items"
import { saveClaim, uploadEvidence, type AttachmentBody } from "./upload"

/**
 * The three ways to put an item right, opened under the item itself: replace
 * a file, correct a field, add a reference. Each one saves to the claim at
 * once (the claim is still the claimant's, so nothing is filed or sent), then
 * tells the view the item has been dealt with. Sending the claim again is a
 * separate step, and it is the only one that asks for the three conditions.
 */
export type FixClaim = {
  id: string
  paper_title: string
  journal_title: string | null
  doi: string | null
  issn: string | null
  publication_year: number | null
  author_position: number | null
  total_authors: number | null
  attachments: Attachment[]
}

const MODES: { kind: FixKind; label: string }[] = [
  { kind: "FILE", label: "Replace a file" },
  { kind: "FIELD", label: "Correct a field" },
  { kind: "REFERENCE", label: "Add a reference" },
]

type FieldKey =
  | "paper_title"
  | "journal_title"
  | "doi"
  | "issn"
  | "publication_year"
  | "author_position"
  | "total_authors"
  | "ref_number"

const FIELDS: { key: FieldKey; label: string; numeric?: boolean; hint?: string }[] = [
  { key: "author_position", label: "Your author position", numeric: true, hint: "Count your name in the author list on the first page of the paper." },
  { key: "total_authors", label: "Number of authors", numeric: true },
  { key: "ref_number", label: "A reference's number", hint: "The number it has in your article's reference list." },
  { key: "paper_title", label: "Title" },
  { key: "journal_title", label: "Journal" },
  { key: "doi", label: "DOI" },
  { key: "issn", label: "ISSN" },
  { key: "publication_year", label: "Publication year", numeric: true },
]

function body(a: Attachment): AttachmentBody {
  return {
    kind: a.kind,
    url: a.url,
    filename: a.filename ?? null,
    size_bytes: a.size_bytes ?? 0,
    ref_number: a.ref_number ?? null,
    ref_title: a.ref_title ?? null,
    content_hash: (a as { content_hash?: string | null }).content_hash ?? null,
  }
}

function fileLabel(a: Attachment): string {
  if (a.kind === "PUBLISHED_PAPER") return `Published paper${a.filename ? ` (${a.filename})` : ""}`
  const n = (a.ref_number || "").trim()
  return `Reference ${n ? n : "without a number"}${a.filename ? ` (${a.filename})` : ""}`
}

export function FixPanel({
  claim,
  item,
  onSaved,
  onCancel,
}: {
  claim: FixClaim
  item: FixItem
  /** Said in the item once it is saved, e.g. "Replaced the published paper". */
  onSaved: (summary: string) => void
  onCancel: () => void
}) {
  const [mode, setMode] = useState<FixKind>(item.suggest)
  return (
    <div className="mt-3 space-y-4 rounded-xl bg-sunken p-4" data-testid="fix-panel">
      <div role="group" aria-label="How to fix this" className="flex flex-wrap gap-1">
        {MODES.map((m) => (
          <button
            key={m.kind}
            type="button"
            aria-pressed={mode === m.kind}
            onClick={() => setMode(m.kind)}
            className={cn(
              "rounded-md px-2.5 py-1.5 text-sm font-medium transition-colors duration-[var(--dur-1)]",
              mode === m.kind ? "bg-surface text-accent shadow-raise" : "text-fg-muted hover:bg-hover hover:text-fg"
            )}
          >
            {m.label}
          </button>
        ))}
      </div>
      {mode === "FILE" && <ReplaceFile claim={claim} item={item} onSaved={onSaved} onCancel={onCancel} />}
      {mode === "FIELD" && <CorrectField claim={claim} item={item} onSaved={onSaved} onCancel={onCancel} />}
      {mode === "REFERENCE" && <AddReference claim={claim} onSaved={onSaved} onCancel={onCancel} />}
    </div>
  )
}

function useSave(onSaved: (s: string) => void) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  async function run(fn: () => Promise<string>) {
    setBusy(true)
    setError(null)
    try {
      onSaved(await fn())
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "That did not save. Try again.")
    } finally {
      setBusy(false)
    }
  }
  return { busy, error, run }
}

function Buttons({ busy, label, onCancel, disabled }: { busy: boolean; label: string; onCancel: () => void; disabled?: boolean }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button kind="primary" size="sm" type="submit" disabled={busy || disabled}>
        {busy ? "Saving…" : label}
      </Button>
      <Button kind="quiet" size="sm" type="button" onClick={onCancel} disabled={busy}>
        Cancel
      </Button>
    </div>
  )
}

function ErrorLine({ message }: { message: string | null }) {
  return message ? (
    <p role="alert" className="text-sm text-critical">
      {message}
    </p>
  ) : null
}

/* ---------------------------- replace a file ----------------------------- */

function ReplaceFile({
  claim,
  item,
  onSaved,
  onCancel,
}: {
  claim: FixClaim
  item: FixItem
  onSaved: (s: string) => void
  onCancel: () => void
}) {
  const files = claim.attachments
  const initial =
    files.find((a) => item.fileUrl && a.url === item.fileUrl)?.url ??
    files.find((a) => a.kind === "PUBLISHED_PAPER")?.url ??
    files[0]?.url ??
    "new-paper"
  const [which, setWhich] = useState(initial)
  const [file, setFile] = useState<File | null>(null)
  const { busy, error, run } = useSave(onSaved)

  function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!file) return
    void run(async () => {
      const up = await uploadEvidence(file)
      const fresh = {
        url: up.url,
        filename: up.filename,
        size_bytes: up.size_bytes,
        content_hash: up.content_hash,
      }
      let next: AttachmentBody[]
      let what: string
      if (which === "new-paper") {
        next = [...files.map(body), { kind: "PUBLISHED_PAPER", ...fresh }]
        what = "Attached the published paper"
      } else {
        const old = files.find((a) => a.url === which)
        next = files.map((a) => (a.url === which ? { ...body(a), ...fresh } : body(a)))
        what = old ? `Replaced ${fileLabel(old).replace(/ \(.*\)$/, "").toLowerCase()}` : "Replaced the file"
      }
      await saveClaim(claim.id, { attachments: next })
      return what
    })
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <Field label="Which file">
        <Select value={which} onChange={(e) => setWhich(e.target.value)} disabled={busy}>
          {files.map((a) => (
            <option key={a.url} value={a.url}>
              {fileLabel(a)}
            </option>
          ))}
          {!files.some((a) => a.kind === "PUBLISHED_PAPER") && <option value="new-paper">Published paper (not attached yet)</option>}
        </Select>
      </Field>
      <Field label="The new file" hint="A PDF straight from the publisher is best, because the reviewer can search its text.">
        <Input
          type="file"
          accept=".pdf,image/png,image/jpeg"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          disabled={busy}
          className="h-auto py-1.5"
        />
      </Field>
      <ErrorLine message={error} />
      <Buttons busy={busy} label="Upload and replace" onCancel={onCancel} disabled={!file} />
    </form>
  )
}

/* ---------------------------- correct a field ---------------------------- */

function currentValue(claim: FixClaim, key: FieldKey, refUrl: string): string {
  if (key === "ref_number") return (claim.attachments.find((a) => a.url === refUrl)?.ref_number ?? "").toString()
  const v = claim[key]
  return v == null ? "" : String(v)
}

function CorrectField({
  claim,
  item,
  onSaved,
  onCancel,
}: {
  claim: FixClaim
  item: FixItem
  onSaved: (s: string) => void
  onCancel: () => void
}) {
  const refs = claim.attachments.filter((a) => a.kind === "SEC_REFERENCE")
  const options = FIELDS.filter((f) => f.key !== "ref_number" || refs.length > 0)
  // Open on the field the item is about, when it says.
  const wanted = suggestField(item.body)
  const first = options.find((f) => f.key === wanted)?.key ?? options[0].key
  const [key, setKey] = useState<FieldKey>(first)
  const [refUrl, setRefUrl] = useState(refs.find((a) => !(a.ref_number || "").trim())?.url ?? refs[0]?.url ?? "")
  const spec = FIELDS.find((f) => f.key === key)!
  const [value, setValue] = useState(() => currentValue(claim, first, refUrl))
  const [problem, setProblem] = useState<string | null>(null)
  const { busy, error, run } = useSave(onSaved)

  function pick(next: FieldKey, ref = refUrl) {
    setKey(next)
    setValue(currentValue(claim, next, ref))
    setProblem(null)
  }

  function submit(e: React.FormEvent) {
    e.preventDefault()
    const text = value.trim()
    if (!text) return setProblem("Type the corrected value first.")
    if (spec.numeric && !/^\d{1,4}$/.test(text)) return setProblem("This needs a whole number.")
    setProblem(null)
    void run(async () => {
      if (key === "ref_number") {
        const next = claim.attachments.map((a) => (a.url === refUrl ? { ...body(a), ref_number: text } : body(a)))
        await saveClaim(claim.id, { attachments: next })
        return `Set the reference number to ${text}`
      }
      await saveClaim(claim.id, { [key]: spec.numeric ? Number(text) : text })
      return `Corrected ${spec.label.toLowerCase()}`
    })
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <Field label="Which field">
        <Select value={key} onChange={(e) => pick(e.target.value as FieldKey)} disabled={busy}>
          {options.map((f) => (
            <option key={f.key} value={f.key}>
              {f.label}
            </option>
          ))}
        </Select>
      </Field>
      {key === "ref_number" && (
        <Field label="Which reference">
          <Select
            value={refUrl}
            onChange={(e) => {
              setRefUrl(e.target.value)
              setValue(currentValue(claim, "ref_number", e.target.value))
            }}
            disabled={busy}
          >
            {refs.map((a) => (
              <option key={a.url} value={a.url}>
                {fileLabel(a)}
              </option>
            ))}
          </Select>
        </Field>
      )}
      <Field label={spec.label} hint={spec.hint} error={problem ?? undefined}>
        <Input value={value} onChange={(e) => setValue(e.target.value)} disabled={busy} inputMode={spec.numeric ? "numeric" : undefined} />
      </Field>
      <ErrorLine message={error} />
      <Buttons busy={busy} label="Save the correction" onCancel={onCancel} />
    </form>
  )
}

/* ---------------------------- add a reference ---------------------------- */

function AddReference({ claim, onSaved, onCancel }: { claim: FixClaim; onSaved: (s: string) => void; onCancel: () => void }) {
  const [number, setNumber] = useState("")
  const [title, setTitle] = useState("")
  const [file, setFile] = useState<File | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const { busy, error, run } = useSave(onSaved)

  function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!number.trim()) return setProblem("Give the number it has in your reference list.")
    if (!file) return setProblem("Choose the reference's PDF.")
    setProblem(null)
    void run(async () => {
      const up = await uploadEvidence(file)
      const next: AttachmentBody[] = [
        ...claim.attachments.map(body),
        {
          kind: "SEC_REFERENCE",
          url: up.url,
          filename: up.filename,
          size_bytes: up.size_bytes,
          content_hash: up.content_hash,
          ref_number: number.trim(),
          ref_title: title.trim() || null,
        },
      ]
      await saveClaim(claim.id, { attachments: next })
      return `Added reference ${number.trim()}`
    })
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <div className="grid grid-cols-[minmax(0,1fr)] gap-3 sm:grid-cols-[8rem_minmax(0,1fr)]">
        <Field label="Its number" hint="From your reference list.">
          <Input value={number} onChange={(e) => setNumber(e.target.value)} disabled={busy} inputMode="numeric" />
        </Field>
        <Field label="Its title (optional)">
          <Input value={title} onChange={(e) => setTitle(e.target.value)} disabled={busy} />
        </Field>
      </div>
      <Field label="The reference's PDF" hint="It should show a Saveetha Engineering College author.">
        <Input
          type="file"
          accept=".pdf,image/png,image/jpeg"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          disabled={busy}
          className="h-auto py-1.5"
        />
      </Field>
      {problem && (
        <p role="alert" className="text-sm text-critical">
          {problem}
        </p>
      )}
      <ErrorLine message={error} />
      <div className="flex flex-wrap items-center gap-2">
        <Button kind="primary" size="sm" type="submit" disabled={busy}>
          <Upload />
          {busy ? "Saving…" : "Upload and add"}
        </Button>
        <Button kind="quiet" size="sm" type="button" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
      </div>
    </form>
  )
}
