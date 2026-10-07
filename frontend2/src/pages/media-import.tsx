import { useState } from "react"
import { LoaderCircle, Upload } from "lucide-react"

import { api } from "@/lib/api"
import { formatCount } from "@/lib/count"
import { Button } from "@/ui/button"
import { Checkbox, Field } from "@/ui/field"
import { Details } from "@/ui/section"
import { InlineError } from "@/ui/state"
import { Meta } from "@/ui/text"
import { toast } from "@/ui/toast"

/**
 * What `POST /api/admin/media-import` answers (core/services/media_import.py).
 * `rejected` is capped by the server; `rejected_count` is the true number.
 */
export type MediaImportReport = {
  added: number
  replaced: number
  skipped: number
  rejected: { name: string; why: string }[]
  rejected_count: number
  bytes: number
}

const megabytes = (bytes: number) => `${(bytes / 1048576).toFixed(1)} MB`

/**
 * Puts the college's photos and claim files back from a zip of the media folders.
 *
 * A restore brings every row but none of the files those rows name, so the
 * live site shows initials where faces should be and broken links where claim
 * PDFs should be. Without this the only way to fix it is a database connection
 * from the owner's laptop, which some networks block.
 *
 * The result stays on the page, with the reason for every file that was not
 * added: a toast is gone in four seconds, and "6 problems" with no names is
 * not something anyone can act on.
 */
export function MediaImport({ onDone }: { onDone?: () => void }) {
  const [file, setFile] = useState<File | null>(null)
  const [overwrite, setOverwrite] = useState(false)
  const [busy, setBusy] = useState(false)
  const [report, setReport] = useState<MediaImportReport | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  // A native file input keeps showing the name it was given. A new key is what
  // empties it once the zip has been used.
  const [pick, setPick] = useState(0)

  async function run() {
    if (!file) return
    setBusy(true)
    setFailure(null)
    setReport(null)
    try {
      const body = new FormData()
      body.append("file", file)
      body.append("overwrite", overwrite ? "true" : "false")
      // `api()` types its options for JSON only; the same widening imports.tsx uses,
      // so the upload still goes through it and keeps the CSRF header.
      const res = await api<MediaImportReport>("/api/admin/media-import", {
        method: "POST",
        body,
      } as unknown as Parameters<typeof api>[1])
      setReport(res)
      setFile(null)
      setPick((n) => n + 1)
      // A zip of files already here has nothing to celebrate; the result below says so.
      if (res.added > 0) toast.ok(`${formatCount(res.added)} ${res.added === 1 ? "file" : "files"} added`)
      onDone?.()
    } catch (err) {
      setFailure(err instanceof Error ? err.message : "The server did not answer.")
      toast.fail(err, "The files could not be added")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-fg-muted">
        Upload the media zip from the project folder so faces and claim files appear.
      </p>
      <Field label="Media zip" hint="A .zip file, up to 150 MB.">
        <input
          key={pick}
          type="file"
          accept=".zip,application/zip"
          disabled={busy}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setFile(e.target.files?.[0] ?? null)}
          className="block w-full text-sm file:mr-3 file:rounded-md file:border file:border-line file:bg-surface file:px-3 file:py-1.5 file:text-sm disabled:opacity-50"
        />
      </Field>
      <Checkbox
        checked={overwrite}
        disabled={busy}
        onCheckedChange={(v) => setOverwrite(v === true)}
        label="Overwrite files that already exist"
        hint="Leave this off to keep what is already on the server."
      />
      <div className="flex flex-wrap items-center gap-3">
        <Button kind="default" size="sm" disabled={!file || busy} onClick={() => void run()}>
          <Upload aria-hidden />
          {busy ? "Adding the files…" : "Add the files"}
        </Button>
        {!file && !busy ? <Meta>Choose the zip first.</Meta> : null}
      </div>
      {busy ? (
        <p role="status" className="flex items-center gap-2 text-sm text-fg-muted">
          <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" aria-hidden />
          Adding the files. This can take a minute, so keep this page open.
        </p>
      ) : null}
      {failure ? <InlineError message={failure} /> : null}
      {report ? <Result report={report} /> : null}
    </div>
  )
}

function Result({ report }: { report: MediaImportReport }) {
  const problems = report.rejected_count
  const nothingNew = report.added === 0 && problems === 0 && report.skipped > 0
  return (
    <div className="well space-y-1.5 px-3 py-2.5 text-sm" role="status" data-testid="media-result">
      {nothingNew ? (
        <p>Nothing new: all {formatCount(report.skipped)} files were already here.</p>
      ) : (
        <>
          <p>
            Added {formatCount(report.added)} {report.added === 1 ? "file" : "files"} ({megabytes(report.bytes)}).
            {report.replaced > 0 ? ` ${formatCount(report.replaced)} of them replaced a file that was already here.` : ""}
          </p>
          {report.skipped > 0 ? <p>{formatCount(report.skipped)} already here, left alone.</p> : null}
          {problems > 0 ? (
            <p>
              {formatCount(problems)} {problems === 1 ? "file had a problem and was" : "files had a problem and were"} not
              added.
            </p>
          ) : null}
        </>
      )}
      {problems > 0 ? (
        <Details label="problems" count={problems}>
          <ul className="list-disc space-y-1 pl-5 text-fg-muted">
            {report.rejected.map((r, i) => (
              <li key={`${r.name}-${i}`}>
                <code className="break-all text-fg">{r.name}</code> {r.why}
              </li>
            ))}
          </ul>
          {problems > report.rejected.length ? (
            <Meta className="mt-1 block">and {formatCount(problems - report.rejected.length)} more.</Meta>
          ) : null}
        </Details>
      ) : null}
    </div>
  )
}
