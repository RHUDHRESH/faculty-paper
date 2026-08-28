import { useState } from "react"
import { Link, useParams } from "react-router-dom"
import { ArrowLeft, Download, Play, Upload } from "lucide-react"

import { api } from "@/lib/api"
import { useApi, useApiMutation } from "@/lib/query"
import { Button } from "@/ui/button"
import { Field, Input } from "@/ui/field"
import { Table, type Column } from "@/ui/table"
import {
  Callout,
  EmptyState,
  ErrorState,
  SkeletonText,
} from "@/ui/state"
import { Meta, PageTitle, SectionTitle, Sub } from "@/ui/text"
import { toast } from "@/ui/toast"

/**
 * The monthly Scopus run.
 *
 * A spreadsheet of author ids and titles arrives from the indexing service
 * every month; each row has to be looked up, matched to a journal, and given
 * a quartile and a SNIP before any of it can be priced. The whole pipeline
 * existed on the server — upload, start, poll, export — and there was no
 * screen for any of it, so the only way to run the college's monthly
 * reconciliation was a Django shell.
 *
 * Deliberately not a live-updating table. A run takes minutes over thousands
 * of rows, and a page that re-fetches the entire row set on a timer costs more
 * than it tells anybody; the status line refreshes, the rows are read when
 * the run has finished.
 */

type Batch = {
  id: string
  name: string
  status: string
  created_by: string
  row_count: number
  created_at: string
  error_message: string | null
}

const STATUS_LABEL: Record<string, string> = {
  PENDING: "Not started",
  RUNNING: "Running",
  DONE: "Finished",
  FAILED: "Failed",
}

function statusLabel(status: string) {
  return STATUS_LABEL[status] || status
}

export function Batches() {
  const { data, isLoading, error, refetch } = useApi<Batch[]>(
    ["monthly"],
    "/api/monthly"
  )
  const [uploading, setUploading] = useState(false)

  const columns: Column<Batch>[] = [
    {
      key: "name",
      header: "Batch",
      cell: (b) => (
        <Link to={`/batches/${b.id}`} className="block">
          <span className="block truncate text-base">{b.name}</span>
          <Meta className="mt-0.5 block">
            {b.created_by} · {new Date(b.created_at).toLocaleDateString()}
          </Meta>
        </Link>
      ),
    },
    {
      key: "rows",
      header: "Rows",
      align: "right",
      cell: (b) => b.row_count.toLocaleString("en-IN"),
    },
    {
      key: "status",
      header: "Status",
      cell: (b) => (
        <span>
          <span className="block text-sm">{statusLabel(b.status)}</span>
          {b.error_message ? (
            <Meta className="block truncate text-critical">{b.error_message}</Meta>
          ) : null}
        </span>
      ),
    },
  ]

  return (
    <div className="page space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <PageTitle>Monthly runs</PageTitle>
          <Sub className="mt-1">
            The Scopus sheet for a month, looked up row by row and matched to
            journals before anything is priced.
          </Sub>
        </div>
        <Button kind="default" size="md" onClick={() => setUploading(true)}>
          <Upload />
          Upload a sheet
        </Button>
      </header>

      {uploading && (
        <UploadBatch
          onClose={() => setUploading(false)}
          onDone={() => void refetch()}
        />
      )}

      {isLoading ? (
        <SkeletonText lines={4} />
      ) : error ? (
        <ErrorState onRetry={() => void refetch()} />
      ) : !data || data.length === 0 ? (
        <EmptyState
          art="empty-queue"
          title="No runs yet"
          message="Upload the month's Scopus export to start one."
        />
      ) : (
        <Table rows={data} columns={columns} getKey={(b) => b.id} />
      )}
    </div>
  )
}

/**
 * Upload the month's sheet.
 *
 * A plain multipart POST rather than the JSON mutation helper, because the
 * endpoint takes a file and a name as form fields. The column names it will
 * accept are stated up front — the export has been through several shapes
 * over the years and a row whose author id column is named something
 * unexpected is silently blank rather than rejected, which is the kind of
 * failure that is only noticed a month later when somebody is not paid.
 */
function UploadBatch({
  onClose,
  onDone,
}: {
  onClose: () => void
  onDone: () => void
}) {
  const [name, setName] = useState("")
  const [file, setFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit() {
    if (!file || !name.trim()) return
    setBusy(true)
    try {
      const body = new FormData()
      body.append("name", name.trim())
      body.append("file", file)
      // `api()`'s options type has no `body` -- every other call it makes
      // is JSON -- so this widens it the same way the attachment upload in
      // `file-paper.tsx` does, rather than going around it and losing CSRF.
      const res = await api<{ id: string; row_count: number }>(
        "/api/monthly/upload",
        { method: "POST", body } as unknown as Parameters<typeof api>[1]
      )
      toast.ok(
        `${res.row_count.toLocaleString("en-IN")} rows read. Nothing has been looked up yet — start the run when you are ready.`
      )
      onDone()
      onClose()
    } catch (err) {
      toast.fail(err)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4 rounded-md border border-line p-4">
      <SectionTitle>Upload a sheet</SectionTitle>

      <Callout tone="info" title="Which columns are read">
        The author id is taken from <code>author_id</code>, <code>authorId</code>,{" "}
        <code>Author ID</code> or <code>F</code>; the title from{" "}
        <code>title</code>, <code>paper_title</code>, <code>Title</code> or{" "}
        <code>G</code>. Anything else in the file is ignored.
      </Callout>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="What to call this run" hint="For example: March 2026.">
          <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </Field>
        <Field label="The CSV" hint="The Scopus export for the month.">
          <input
            type="file"
            accept=".csv,text/csv"
            onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
              setFile(e.target.files?.[0] || null)
            }
            className="block w-full text-sm file:mr-3 file:rounded-md file:border file:border-line file:bg-surface file:px-3 file:py-1.5 file:text-sm"
          />
        </Field>
      </div>

      <div className="flex gap-2">
        <Button
          kind="primary"
          disabled={!file || !name.trim() || busy}
          onClick={() => void submit()}
        >
          {busy ? "Reading…" : "Upload"}
        </Button>
        <Button kind="quiet" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------------ */
/* One run                                                                  */
/* ------------------------------------------------------------------------ */

type BatchRow = {
  id: string
  row_number: number
  author_id_raw: string | null
  paper_title: string | null
  linkage: string | null
  matched_title: string | null
  journal: string | null
  issn: string | null
  sjr_quartile: string | null
  snip: number | null
  engineering_class: string | null
}

type BatchDetail = {
  id: string
  name: string
  status: string
  error_message: string | null
  rows: BatchRow[]
}

export function Batch() {
  const { id } = useParams<{ id: string }>()
  const { data, isLoading, error, refetch } = useApi<BatchDetail>(
    ["monthly", id],
    `/api/monthly/${id}`,
    { enabled: !!id }
  )

  const start = useApiMutation<Record<string, never>, { ok: boolean }>(
    `/api/monthly/${id}/start`,
    { invalidates: [["monthly"], ["monthly", id]] }
  )

  if (isLoading) return <div className="page py-8"><SkeletonText lines={5} /></div>
  if (error)
    return (
      <div className="page py-8">
        <ErrorState onRetry={() => void refetch()} />
      </div>
    )
  if (!data)
    return (
      <div className="page py-8">
        <EmptyState title="No such run" message="This batch may have been removed." />
      </div>
    )

  const matched = data.rows.filter((r) => r.linkage === "MATCHED").length
  const running = data.status === "RUNNING"

  const columns: Column<BatchRow>[] = [
    { key: "n", header: "#", align: "right", cell: (r) => r.row_number },
    {
      key: "paper",
      header: "Paper",
      className: "max-w-[20rem]",
      cell: (r) => (
        <span className="block">
          <span className="block truncate text-sm">
            {r.matched_title || r.paper_title || "Untitled"}
          </span>
          <Meta className="mt-0.5 block truncate">{r.author_id_raw || "—"}</Meta>
        </span>
      ),
    },
    {
      key: "journal",
      header: "Journal",
      className: "max-w-[14rem]",
      cell: (r) => (
        <span className="block">
          <span className="line-clamp-2 text-sm text-fg-muted">
            {r.journal || "—"}
          </span>
          {r.issn ? <Meta className="block">{r.issn}</Meta> : null}
        </span>
      ),
    },
    { key: "q", header: "Quartile", cell: (r) => r.sjr_quartile || "—" },
    {
      key: "snip",
      header: "SNIP",
      align: "right",
      cell: (r) => (r.snip == null ? "—" : r.snip.toFixed(3)),
    },
    {
      key: "linkage",
      header: "Matched",
      cell: (r) =>
        r.linkage === "MATCHED" ? (
          "Yes"
        ) : (
          <span className="text-fg-muted">{r.linkage || "Not yet"}</span>
        ),
    },
  ]

  return (
    <div className="page space-y-6">
      <Link
        to="/batches"
        className="inline-flex items-center gap-1 text-sm text-fg-muted hover:text-fg"
      >
        <ArrowLeft className="size-3.5" aria-hidden />
        Monthly runs
      </Link>

      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <PageTitle>{data.name}</PageTitle>
          <Sub className="mt-1">
            {data.rows.length.toLocaleString("en-IN")} rows ·{" "}
            {matched.toLocaleString("en-IN")} matched to a journal ·{" "}
            {statusLabel(data.status)}
          </Sub>
        </div>
        <div className="flex shrink-0 gap-2">
          <Button
            kind="default"
            size="md"
            disabled={running || start.isPending}
            onClick={() =>
              start.mutate(
                {},
                {
                  onSuccess: () =>
                    toast.ok(
                      "Started. It runs in the background — come back to this page for the result."
                    ),
                  onError: (err: unknown) => toast.fail(err),
                }
              )
            }
          >
            <Play />
            {running ? "Running…" : data.status === "DONE" ? "Run again" : "Start the run"}
          </Button>
          <Button kind="quiet" size="md" asChild>
            <a href={`/api/monthly/${data.id}/export`}>
              <Download />
              Export
            </a>
          </Button>
        </div>
      </header>

      {data.error_message ? (
        <Callout tone="critical" title="This run stopped">
          {data.error_message}
        </Callout>
      ) : null}

      {running ? (
        <Callout tone="info" title="Looking rows up">
          Each row is queried against Scopus and matched to a journal, which
          takes a few minutes over a full month. Nothing is lost if you leave
          this page — reload it to see where the run has got to.
        </Callout>
      ) : null}

      {data.rows.length === 0 ? (
        <EmptyState
          art="empty-queue"
          title="No rows"
          message="Nothing was read out of the uploaded file."
        />
      ) : (
        <Table rows={data.rows} columns={columns} getKey={(r) => r.id} />
      )}
    </div>
  )
}
