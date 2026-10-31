import { paperTitle } from "@/lib/names"
import { useState } from "react"
import { Link, useParams, useSearchParams } from "react-router-dom"
import { Play, Upload } from "lucide-react"

import { useCrumbLabel } from "@/app/crumbs"
import { api } from "@/lib/api"
import { useApi, useApiMutation } from "@/lib/query"
import { Answer } from "@/ui/answer"
import { Button } from "@/ui/button"
import { Field, Input, Select } from "@/ui/field"
import { filterBar } from "@/ui/filter-bar"
import { MoreMenu } from "@/pages/more-menu"
import { PageHeader } from "@/ui/page-header"
import { Avatar, initialsOf } from "@/ui/person"
import { Details, Section } from "@/ui/section"
import { Callout, EmptyState, ErrorState, SkeletonText } from "@/ui/state"
import { Table, type Column } from "@/ui/table"
import { Meta } from "@/ui/text"
import { toast } from "@/ui/toast"

/**
 * The monthly Scopus run.
 *
 * A spreadsheet of author ids and titles arrives from the indexing service
 * every month; each row has to be looked up, matched to a journal, and given
 * a quartile and a SNIP before any of it can be priced. The pipeline is:
 * upload, start, poll, export.
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
  by?: { user_id: string; name: string; initials: string; photo_url: string | null }
  row_count: number
  created_at: string
  error_message: string | null
}

const STATUS_LABEL: Record<string, string> = {
  PENDING: "Not started",
  RUNNING: "In progress",
  DONE: "Finished",
  FAILED: "Failed",
}

function statusLabel(status: string) {
  return STATUS_LABEL[status] || "In progress"
}

const day = (iso: string) => new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })

export function Batches() {
  const { data, isLoading, error, refetch } = useApi<Batch[]>(["monthly"], "/api/monthly")
  const [uploading, setUploading] = useState(false)
  const [search, setSearch] = useState("")
  const [state, setState] = useState("")

  const columns: Column<Batch>[] = [
    {
      key: "name",
      header: "Run",
      exportValue: (b) => b.name,
      cell: (b) => (
        <Link to={`/batches/${b.id}`} className="block underline-offset-2 hover:underline">
          <span className="block truncate text-base">{b.name}</span>
          <span className="mt-0.5 flex items-center gap-1.5 text-fg-muted">
            <Avatar person={b.by ?? { name: b.created_by, initials: initialsOf(b.created_by), photo_url: null }} size="xs" />
            <Meta>
              {b.created_by}, {day(b.created_at)}
            </Meta>
          </span>
        </Link>
      ),
    },
    { key: "rows", header: "Rows", align: "right", exportValue: (b) => b.row_count, cell: (b) => b.row_count.toLocaleString("en-IN") },
    {
      key: "by",
      header: "Uploaded by",
      defaultHidden: true,
      exportValue: (b) => b.created_by,
      cell: (b) => b.created_by,
    },
    {
      key: "day",
      header: "Uploaded on",
      defaultHidden: true,
      exportValue: (b) => day(b.created_at),
      cell: (b) => day(b.created_at),
    },
    {
      key: "status",
      header: "Where it stands",
      exportValue: (b) => statusLabel(b.status) + (b.error_message ? `. ${b.error_message}` : ""),
      cell: (b) => (
        <span>
          <span className={b.status === "FAILED" ? "block text-sm text-critical" : "block text-sm"}>{statusLabel(b.status)}</span>
          {b.error_message ? <Meta className="block truncate text-critical">{b.error_message}</Meta> : null}
        </span>
      ),
    },
  ]

  const failed = (data ?? []).filter((b) => b.status === "FAILED").length
  const latest = data?.[0]
  const needle = search.trim().toLowerCase()
  const shownRuns = (data ?? []).filter(
    (b) => (!state || b.status === state) && (!needle || [b.name, b.created_by].some((v) => v.toLowerCase().includes(needle)))
  )

  return (
    <div className="page space-y-6">
      <PageHeader
        title="Monthly runs"
        sub="Each month's Scopus sheet, looked up and matched."
        action={
          <Button kind={uploading ? "default" : "primary"} size="md" onClick={() => setUploading(true)}>
            <Upload aria-hidden />
            Upload a sheet
          </Button>
        }
      />

      {uploading && <UploadBatch onClose={() => setUploading(false)} onDone={() => void refetch()} />}

      {isLoading ? (
        <SkeletonText lines={4} />
      ) : error ? (
        <ErrorState
          title="Could not load the monthly runs"
          message="Nothing has been changed. Try again."
          onRetry={() => void refetch()}
        />
      ) : !data || data.length === 0 ? (
        <EmptyState
          art="empty-queue"
          title="No monthly run yet"
          message="Upload the month's Scopus export, then start the run."
          action={
            <Button kind="default" onClick={() => setUploading(true)}>
              <Upload aria-hidden />
              Upload a sheet
            </Button>
          }
        />
      ) : (
        <>
          <div className="space-y-3">
            <Answer
              items={[
                { value: latest ? latest.name : null, label: latest ? `Latest run, ${day(latest.created_at)}` : "Latest run", to: latest ? `/batches/${latest.id}` : undefined },
                { value: latest ? statusLabel(latest.status) : null, label: "Where the latest run stands", tone: latest?.status === "FAILED" ? "critical" : "neutral" },
                { value: failed, label: "Failed runs", tone: "critical", zero: "None failed" },
              ]}
            />
          </div>
          <div className={filterBar} role="search">
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by run name or who uploaded it"
              aria-label="Search the runs"
              className="w-full min-w-0 sm:w-80"
            />
            <Select aria-label="Where it stands" value={state} onChange={(e) => setState(e.target.value)} className="w-auto max-sm:w-full">
              <option value="">Every run</option>
              {Object.entries(STATUS_LABEL).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </Select>
            {(search || state) && (
              <Button
                kind="quiet"
                onClick={() => {
                  setSearch("")
                  setState("")
                }}
              >
                Clear filters
              </Button>
            )}
          </div>
          <Table
            rows={shownRuns}
            columns={columns}
            getKey={(b) => b.id}
            caption="Monthly runs, newest first"
            maxHeight="none"
            tools={{ id: "monthly-runs", title: "Monthly runs" }}
            empty={{ title: "No run matches", message: "Nothing fits the search or the choice above." }}
          />
        </>
      )}
    </div>
  )
}

/**
 * Upload the month's sheet.
 *
 * A plain multipart POST rather than the JSON mutation helper, because the
 * endpoint takes a file and a name as form fields. The column names it will
 * accept are stated one step away: the export has been through several shapes
 * over the years and a row whose author id column is named something
 * unexpected is silently blank rather than rejected, which is the kind of
 * failure that is only noticed a month later when somebody is not paid.
 */
function UploadBatch({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
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
      // `api()`'s options type has no `body` (every other call it makes is
      // JSON), so this widens it the same way the attachment upload in
      // `file-paper.tsx` does, rather than going around it and losing CSRF.
      const res = await api<{ id: string; row_count: number }>(
        "/api/monthly/upload",
        { method: "POST", body } as unknown as Parameters<typeof api>[1]
      )
      toast.ok(`Uploaded. ${res.row_count.toLocaleString("en-IN")} rows read. Start the run when ready.`)
      onDone()
      onClose()
    } catch (err) {
      toast.fail(err)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Section title="Upload a sheet" className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Name of this run" hint="For example: March 2026.">
          <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </Field>
        <Field label="Scopus export (CSV)">
          <input
            type="file"
            accept=".csv,text/csv"
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setFile(e.target.files?.[0] || null)}
            className="block w-full text-sm file:mr-3 file:rounded-control file:border file:border-line file:bg-surface file:px-3 file:py-1.5 file:text-sm"
          />
        </Field>
      </div>
      <Details label="which columns are read">
        <p className="text-sm text-fg-muted">
          Author ID: <code>author_id</code>, <code>authorId</code>, <code>Author ID</code> or <code>F</code>. Title:{" "}
          <code>title</code>, <code>paper_title</code>, <code>Title</code> or <code>G</code>. Other columns are
          ignored, and a row with the author ID under another name reads as blank without an error.
        </p>
      </Details>
      <div className="flex gap-2">
        <Button kind="primary" disabled={!file || !name.trim() || busy} onClick={() => void submit()}>
          {busy ? "Reading" : "Upload the sheet"}
        </Button>
        <Button kind="quiet" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
      </div>
    </Section>
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
  const [params] = useSearchParams()
  const unmatchedOnly = params.get("show") === "unmatched"
  const [, setParams] = useSearchParams()
  const [find, setFind] = useState("")
  const { data, isLoading, error, refetch } = useApi<BatchDetail>(["monthly", id], `/api/monthly/${id}`, {
    enabled: !!id,
  })
  useCrumbLabel(data?.name)

  const start = useApiMutation<Record<string, never>, { ok: boolean }>(`/api/monthly/${id}/start`, {
    invalidates: [["monthly"], ["monthly", id]],
  })

  if (isLoading)
    return (
      <div className="page py-8">
        <SkeletonText lines={5} />
      </div>
    )
  if (error)
    return (
      <div className="page py-8">
        <ErrorState
          title="Could not load this run"
          message="Nothing has been changed. Try again."
          onRetry={() => void refetch()}
        />
      </div>
    )
  if (!data)
    return (
      <div className="page py-8">
        <EmptyState title="No such run" message="It may have been removed." />
      </div>
    )

  const matched = data.rows.filter((r) => r.linkage === "MATCHED").length
  const unmatched = data.rows.length - matched
  const running = data.status === "RUNNING"
  const findNeedle = find.trim().toLowerCase()
  const shown = (unmatchedOnly ? data.rows.filter((r) => r.linkage !== "MATCHED") : data.rows).filter(
    (r) => !findNeedle || [r.paper_title, r.matched_title, r.journal, r.author_id_raw].some((v) => String(v ?? "").toLowerCase().includes(findNeedle))
  )

  const columns: Column<BatchRow>[] = [
    { key: "n", header: "Row", align: "right", exportValue: (r) => r.row_number, cell: (r) => r.row_number },
    {
      key: "paper",
      header: "Paper",
      className: "max-w-[20rem]",
      exportValue: (r) => r.matched_title || paperTitle(r.paper_title),
      cell: (r) => (
        <span className="block">
          <span className="block truncate text-sm">{r.matched_title || paperTitle(r.paper_title)}</span>
          <Meta className="mt-0.5 block truncate">{r.author_id_raw || "No author ID in the sheet"}</Meta>
        </span>
      ),
    },
    {
      key: "journal",
      header: "Journal",
      className: "max-w-[14rem]",
      exportValue: (r) => r.journal,
      cell: (r) =>
        r.journal ? (
          <span className="block">
            <span className="line-clamp-2 text-sm text-fg-muted">{r.journal}</span>
            {r.issn ? <Meta className="block">{r.issn}</Meta> : null}
          </span>
        ) : null,
    },
    { key: "q", header: "Quartile", exportValue: (r) => r.sjr_quartile, cell: (r) => r.sjr_quartile },
    { key: "snip", header: "SNIP", align: "right", exportValue: (r) => (r.snip == null ? null : Number(r.snip)), cell: (r) => (r.snip == null || Number.isNaN(Number(r.snip)) ? null : Number(r.snip).toFixed(3)) },
    {
      key: "linkage",
      header: "Matched to a journal",
      exportValue: (r) => (r.linkage === "MATCHED" ? "Yes" : r.linkage ? "No" : "Not yet"),
      cell: (r) =>
        r.linkage === "MATCHED" ? "Yes" : <span className="text-fg-muted">{r.linkage ? "No" : "Not yet"}</span>,
    },
  ]

  return (
    <div className="page space-y-6">
      <PageHeader
        title={data.name}
        sub="Each row of the sheet, looked up and matched to a journal."
        action={
          <>
          <MoreMenu items={[{ label: "Export this run as a spreadsheet", onSelect: () => { window.location.href = `/api/monthly/${data.id}/export` } }]} />
          <Button
            kind="primary"
            size="md"
            disabled={running || start.isPending}
            onClick={() =>
              start.mutate(
                {},
                {
                  onSuccess: () => toast.ok("Started. Reload this page for the result."),
                  onError: (err: unknown) => toast.fail(err),
                }
              )
            }
          >
            <Play aria-hidden />
            {running ? "In progress" : data.status === "DONE" ? "Run again" : "Start the run"}
          </Button>
          </>
        }
      />

      <div className="space-y-3">
        <Answer
          items={[
            { value: data.rows.length, label: "Rows in the sheet", to: "?", zero: "The sheet had no rows" },
            { value: matched, label: "Matched to a journal", zero: "None matched yet" },
            { value: unmatched, label: "Not matched", to: "?show=unmatched", tone: "caution", zero: "Every row matched" },
            { value: statusLabel(data.status), label: "Where the run stands", tone: data.status === "FAILED" ? "critical" : "neutral" },
          ]}
        />
      </div>

      {data.error_message ? (
        <Callout tone="critical" title="This run stopped">
          {data.error_message}
        </Callout>
      ) : null}

      {running ? (
        <Callout tone="info" title="Looking rows up">
          Each row is checked against Scopus and matched to a journal. This takes a few minutes. Nothing is lost if
          you leave; reload to see progress.
        </Callout>
      ) : null}

      <div className="space-y-4">
        {data.rows.length > 0 && (
          <div className={filterBar} role="search">
            <Input
              value={find}
              onChange={(e) => setFind(e.target.value)}
              placeholder="Search paper, journal or author ID"
              aria-label="Search the rows"
              className="w-full min-w-0 sm:w-80"
            />
            <Select
              aria-label="Which rows"
              value={unmatchedOnly ? "unmatched" : ""}
              onChange={(e) => setParams(e.target.value ? { show: e.target.value } : {}, { replace: true })}
              className="w-auto max-sm:w-full"
            >
              <option value="">All {data.rows.length.toLocaleString("en-IN")} rows</option>
              <option value="unmatched">Not matched ({unmatched.toLocaleString("en-IN")})</option>
            </Select>
            {(find || unmatchedOnly) && (
              <Button
                kind="quiet"
                onClick={() => {
                  setFind("")
                  setParams({}, { replace: true })
                }}
              >
                Clear filters
              </Button>
            )}
          </div>
        )}
        {data.rows.length === 0 ? (
          <EmptyState art="empty-queue" title="No rows" message="Nothing was read from the file. Check the column names and upload it again." />
        ) : (
          <Table
            rows={shown}
            columns={columns}
            getKey={(r) => r.id}
            caption="Rows of this run"
            maxHeight="none"
            tools={{ id: "monthly-run-rows", title: data.name }}
            empty={{ title: unmatchedOnly && !find ? "Every row matched" : "No row matches", message: unmatchedOnly && !find ? "Nothing to look at." : "Nothing fits the search or the choice above." }}
          />
        )}
      </div>
    </div>
  )
}
