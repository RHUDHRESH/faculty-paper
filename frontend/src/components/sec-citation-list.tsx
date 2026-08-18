import { AlertTriangle, Copy, Plus, Sparkles, Trash2, UploadCloud } from "lucide-react"

import { Field, formatBytes } from "@/components/form/fields"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { mediaUrl } from "@/lib/api"
import { cn } from "@/lib/utils"
import { emptyCitation, type SecCitation, type UploadedFileRef } from "@/lib/claim-fields"

const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "webp", "gif"])

/**
 * A file's own bytes say whether it has been seen before, so renaming it
 * changes nothing. Two cases are worth different words:
 *
 * - the same file attached twice on this form, which is nearly always a
 *   mis-drop and is fixed by removing one;
 * - the same file already on another ticket, which may be legitimate (one
 *   paper genuinely cited twice) and so is a warning, not a block.
 *
 * Neither stops the claimant. The research cell sees the same fingerprint on
 * its side, and a claimant who cannot submit simply telephones instead.
 */
function FileWarning({
  file,
  duplicateSlot,
}: {
  file: UploadedFileRef
  duplicateSlot: number | null
}) {
  const dup = file.duplicate_of
  if (duplicateSlot === null && !dup) return null
  return (
    <div className="mt-2 space-y-2">
      {duplicateSlot !== null ? (
        <p className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-foreground">
          <Copy className="mt-0.5 size-3.5 shrink-0 text-warning" aria-hidden />
          <span>
            This is the same file as <strong>reference {duplicateSlot + 1}</strong>. If
            they are different papers, attach the right one here.
          </span>
        </p>
      ) : null}
      {dup ? (
        <p className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-foreground">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-warning" aria-hidden />
          <span>
            This file was already uploaded{" "}
            {dup.ticket_number ? (
              <>
                on ticket <strong className="font-mono">{dup.ticket_number}</strong>
              </>
            ) : (
              // A draft has no ticket number until it is submitted.
              <>on {dup.same_owner ? "one of your drafts" : "an unsubmitted draft"}</>
            )}
            {dup.same_owner || !dup.ticket_number ? "" : ` by ${dup.owner_name}`}. That
            is fine if the same paper is cited again — the research cell sees it too.
          </span>
        </p>
      ) : null}
    </div>
  )
}

function isImage(f: UploadedFileRef): boolean {
  return IMAGE_EXT.has((f.filename || f.url).split(".").pop()?.toLowerCase() || "")
}

/**
 * The SEC-affiliated references, one card per citation.
 *
 * This replaces three parallel fields — a list of numbers, a textarea of
 * titles, and a heap of PDFs — where nothing recorded which file belonged to
 * which reference. The research cell had to infer it from filenames, and the
 * claimant typed the same set out three times in three formats. Grouping each
 * item's fields together is the "add another" pattern GOV.UK, HMRC and the
 * Scottish design system all land on for repeated information.
 */
export function SecCitationList({
  citations,
  onChange,
  onUpload,
  uploading,
  invalid,
  expected = 2,
  max = 50,
  id,
}: {
  citations: SecCitation[]
  onChange: (next: SecCitation[]) => void
  /** Resolves to the stored file ref, or null if the upload was refused. */
  onUpload: (file: File) => Promise<UploadedFileRef | null>
  uploading?: boolean
  invalid?: boolean
  expected?: number
  max?: number
  id?: string
}) {
  const update = (i: number, patch: Partial<SecCitation>) =>
    onChange(citations.map((c, n) => (n === i ? { ...c, ...patch } : c)))

  /** Only worth offering while the box is empty. */
  const suggestion = (c: SecCitation): string | null => {
    const guess = c.file?.suggested_title?.trim()
    if (!guess || c.title.trim()) return null
    return guess
  }

  const complete = citations.filter((c) => c.number.trim() && c.title.trim() && c.file).length

  // For each row, the earlier row holding the identical file, if any.
  const firstSeen = new Map<string, number>()
  const sameAs = citations.map((c) => {
    const h = c.file?.content_hash
    if (!h) return null
    const at = firstSeen.get(h)
    if (at === undefined) {
      firstSeen.set(h, citations.findIndex((x) => x.file?.content_hash === h))
      return null
    }
    return at
  })

  return (
    // tabIndex so the error summary's link can actually move focus here — a
    // plain div is not focusable, so that link did nothing.
    <div id={id} tabIndex={-1} className="space-y-3 outline-none">
      <ol className="space-y-3">
        {citations.map((c, i) => {
          const file = c.file
          return (
            <li
              key={i}
              className={cn(
                "rounded-2xl border bg-card p-4",
                invalid && !(c.number.trim() && c.title.trim() && file)
                  ? "border-destructive/50"
                  : "border-border"
              )}
            >
              <div className="mb-3 flex items-center justify-between gap-3">
                <p className="text-sm font-semibold text-foreground">Reference {i + 1}</p>
                {citations.length > 1 ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    onClick={() => onChange(citations.filter((_, n) => n !== i))}
                  >
                    <Trash2 className="size-3.5" />
                    Remove
                  </Button>
                ) : null}
              </div>

              <div className="grid gap-3 sm:grid-cols-[7rem_1fr]">
                <Field label="Ref no." htmlFor={`cite-${i}-number`}>
                  <Input
                    id={`cite-${i}-number`}
                    className="h-9 tabular-nums"
                    inputMode="numeric"
                    placeholder="14"
                    value={c.number}
                    onChange={(e) => update(i, { number: e.target.value })}
                  />
                </Field>

                <Field
                  label="Cited article"
                  htmlFor={`cite-${i}-title`}
                  hint={i === 0 ? "The title as it appears in your reference list." : undefined}
                >
                  <Textarea
                    id={`cite-${i}-title`}
                    rows={2}
                    className="resize-none"
                    placeholder="Title of the cited paper authored by SEC faculty"
                    value={c.title}
                    onChange={(e) => update(i, { title: e.target.value })}
                  />
                  {/* Offered, never applied on its own: a PDF's embedded title
                      is often the template's ("Microsoft Word - paper.doc"),
                      and a wrong one filled in silently is worse than a blank
                      box, because nobody re-reads a field they did not type. */}
                  {suggestion(c) ? (
                    <p className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                      <Sparkles className="size-3.5 shrink-0 text-primary" aria-hidden />
                      <span>From the file:</span>
                      <button
                        type="button"
                        onClick={() => update(i, { title: suggestion(c) as string })}
                        className="interactive max-w-full truncate rounded-md border border-border bg-muted/40 px-2 py-0.5 text-left font-medium text-foreground hover:border-primary/50 hover:text-primary"
                        title={suggestion(c) as string}
                      >
                        {suggestion(c)}
                      </button>
                      <span>— use it?</span>
                    </p>
                  ) : null}
                </Field>
              </div>

              <div className="mt-3">
                {file ? (
                  <div className="flex items-center gap-3 rounded-xl border border-border bg-muted/30 p-2">
                    {isImage(file) ? (
                      <img
                        src={mediaUrl(file.url)}
                        alt=""
                        className="size-9 shrink-0 rounded-lg border border-border object-cover"
                      />
                    ) : (
                      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-surface-brand text-xs font-semibold text-primary">
                        {(file.filename || "").split(".").pop()?.toUpperCase().slice(0, 4) || "FILE"}
                      </span>
                    )}
                    <a
                      href={mediaUrl(file.url)}
                      target="_blank"
                      rel="noreferrer"
                      className="min-w-0 flex-1 truncate text-sm font-medium text-foreground hover:text-primary hover:underline"
                    >
                      {file.filename}
                    </a>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {formatBytes(file.size_bytes)}
                    </span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      onClick={() => update(i, { file: null })}
                    >
                      Replace
                    </Button>
                  </div>
                ) : (
                  <label
                    className={cn(
                      "flex cursor-pointer items-center justify-center gap-2 rounded-xl border border-dashed border-border bg-muted/30 px-4 py-3 text-sm transition-colors hover:border-primary/40",
                      uploading && "pointer-events-none opacity-60"
                    )}
                  >
                    <UploadCloud className="size-4 text-muted-foreground" aria-hidden />
                    <span className="text-foreground">Attach this reference's full text</span>
                    <input
                      type="file"
                      className="sr-only"
                      accept=".pdf,.png,.jpg,.jpeg,.webp,.gif,.tif,.tiff,.doc,.docx"
                      onChange={async (e) => {
                        const picked = e.target.files?.[0]
                        e.target.value = ""
                        if (!picked) return
                        const ref = await onUpload(picked)
                        if (ref) update(i, { file: ref })
                      }}
                    />
                  </label>
                )}
                {file ? <FileWarning file={file} duplicateSlot={sameAs[i]} /> : null}
              </div>
            </li>
          )
        })}
      </ol>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={citations.length >= max}
          onClick={() => onChange([...citations, emptyCitation()])}
        >
          <Plus className="size-3.5" />
          Add another reference
        </Button>
        <p
          aria-live="polite"
          className={cn(
            "text-xs",
            complete >= expected ? "text-success" : "text-muted-foreground"
          )}
        >
          {complete} complete
          {complete < expected ? ` · ${expected} expected` : ""}
        </p>
      </div>
    </div>
  )
}
