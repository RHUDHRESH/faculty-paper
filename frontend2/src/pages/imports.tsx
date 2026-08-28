import { useEffect, useMemo, useRef, useState } from "react"
import { Link } from "react-router-dom"
import type { UseQueryResult } from "@tanstack/react-query"
import { FileSpreadsheet, RefreshCw, Search, Upload, Users } from "lucide-react"

import { can, useAuth } from "@/app/auth"
import { api, type ApiError } from "@/lib/api"
import { cn } from "@/lib/cn"
import { useApi, useApiMutation } from "@/lib/query"
import { Button } from "@/ui/button"
import { ConfirmDialog } from "@/ui/dialog"
import { Checkbox, Field, Input, NumberInput } from "@/ui/field"
import { Table, type Column } from "@/ui/table"
import {
  Callout,
  EmptyState,
  ErrorState,
  InlineError,
  SkeletonRows,
  SkeletonText,
} from "@/ui/state"
import { ColumnLabel, Figure, Meta, PageTitle, SectionTitle, Sub } from "@/ui/text"
import { toast } from "@/ui/toast"

/**
 * How the college's own records get into the system.
 *
 * Five real server capabilities had no screen at all: the ERP workbook, the
 * faculty master, prior payment history, the Scopus verification queue and
 * the job poller that reports on the two of those that run in the
 * background. The only way to run any of them was `manage.py shell` on a
 * production box, which means the faculty roster and roughly a decade of
 * payment history were loaded by whoever had a terminal open, with nothing
 * on screen afterwards to say what had landed.
 *
 * Two things this page is careful about, because both failures are silent:
 *
 * 1. **Which columns each importer actually reads.** A column the parser
 *    does not recognise is skipped without a word — no error, no count — so
 *    a payment history whose amount column is named something else imports
 *    as a list of papers worth nothing. Every heading listed below was read
 *    out of the parser, not guessed.
 * 2. **Replace versus append.** The faculty master and the workbook
 *    overwrite rows that are already held; the prior-payments CSV only ever
 *    adds. Those get very different treatment here, and the difference is
 *    stated before the upload runs rather than discovered afterwards.
 */

/* ------------------------------------------------------------------------ */
/* Shapes — read out of backend/core/api.py, not guessed                    */
/* ------------------------------------------------------------------------ */

/** `erp_stats` — counts only. It carries no timestamps; see the note below. */
type ErpStats = {
  faculty_master: number
  claims: number
  claims_paid: number
  prior_payments: number
  paid_ledger: number
  scimago: number
  snip: number
  users: number
}

/** `faculty_master_list` — the whole table, unpaginated. */
type FacultyRow = {
  id: string
  department: string | null
  biometric_id: string | null
  staff_id: string | null
  scopus_author_id: string | null
  name: string
  designation: string | null
  email: string | null
  phone: string | null
}

/** `faculty_options` — the master list and the user accounts, merged. */
type FacultyOption = {
  owner_id: string | null
  master_id: string | null
  name: string
  email: string | null
  department: string | null
  staff_id: string | null
  designation: string | null
  has_user_account: boolean
}

/** `claim_to_dict`, narrowed to what this queue shows. */
type QueueClaim = {
  id: string
  ticket_number: string | null
  paper_title: string | null
  owner_name: string
  owner_department: string | null
  status: string
  doi: string | null
  journal_title: string | null
  indexing_status: string | null
  verification_ok: boolean | null
  waiting_days: number | null
  updated_at: string | null
}

/** `job_status`. Note what "running_or_unknown" really means — see below. */
type Job = {
  status: string
  success?: boolean | null
  result?: unknown
  started?: string | null
  stopped?: string | null
}

const nf = (n: number) => n.toLocaleString("en-IN")

/* ------------------------------------------------------------------------ */
/* Page                                                                      */
/* ------------------------------------------------------------------------ */

export function Imports() {
  const { me } = useAuth()
  // `can(...).clear` mirrors `rbac.ADMIN_ROLES`, which is the set
  // `can_admin_portal` allows — and every GET on this page is behind that
  // one: erp-stats, faculty-master, faculty-options, process and the job
  // poller. `can_import_prior` is wider (it adds the Principal), but a
  // Principal would be refused every reading on the page and left with three
  // upload boxes and no way to see what they had done, so the screen stops
  // at the narrower of the two.
  const allowed = can(me?.role).clear

  const stats = useApi<ErpStats>(["admin", "erp-stats"], "/api/admin/erp-stats", {
    enabled: allowed,
  })

  if (!allowed) {
    return (
      <div className="page py-8">
        <ErrorState
          art="closed-gate"
          title="Not open to this account"
          message="Loading the roster and the payment history is the research office's job. Every reading on this screen is refused to other roles by the server as well, so there would be nothing here to show."
        />
      </div>
    )
  }

  const refreshStats = () => void stats.refetch()

  return (
    <div className="page space-y-10">
      <header>
        <PageTitle>Imports</PageTitle>
        <Sub className="mt-1">
          The roster, the payment history and the ERP workbook — the three
          files this system is built out of, and the queue that checks what
          they brought in against Scopus.
        </Sub>
      </header>

      <AlreadyLoaded query={stats} />
      <FacultyMasterSection onImported={refreshStats} />
      <PriorPaymentsSection stats={stats.data} onImported={refreshStats} />
      <WorkbookSection onImported={refreshStats} />
      <ProcessQueueSection />
    </div>
  )
}

/* ------------------------------------------------------------------------ */
/* 1. What is already loaded                                                 */
/* ------------------------------------------------------------------------ */

const STAT_ROWS: { key: keyof ErpStats; label: string; about: string }[] = [
  { key: "faculty_master", label: "Faculty master", about: "Rows off the roster" },
  { key: "users", label: "Accounts", about: "People who can sign in" },
  { key: "claims", label: "Papers", about: "Tickets of every status" },
  { key: "claims_paid", label: "Paid", about: "Tickets settled" },
  { key: "prior_payments", label: "Prior payments", about: "History, pre-system" },
  { key: "paid_ledger", label: "Ledger rows", about: "What has gone out" },
  { key: "scimago", label: "SCImago", about: "Journals with a quartile" },
  { key: "snip", label: "SNIP", about: "Sources with a SNIP" },
]

/**
 * The state of the database before anybody changes it.
 *
 * The one region on this page carrying an answer, because every question
 * below it ("do I need to load the roster again?") is answered by a number
 * here. Without it the page would be four upload boxes with no way to tell
 * whether the last upload worked.
 */
function AlreadyLoaded({ query }: { query: UseQueryResult<ErpStats, ApiError> }) {
  const { data, isLoading, error, refetch, isFetching } = query

  return (
    <section className="space-y-3" aria-labelledby="already-loaded">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <SectionTitle>
            <span id="already-loaded">What is already loaded</span>
          </SectionTitle>
          <Sub className="mt-1">
            Read this before you upload anything. It is the only place that
            says whether an import landed.
          </Sub>
        </div>
        <Button
          kind="quiet"
          size="sm"
          onClick={() => void refetch()}
          disabled={isFetching}
        >
          <RefreshCw />
          {isFetching ? "Counting…" : "Recount"}
        </Button>
      </div>

      {isLoading ? (
        <div className="panel p-5">
          <SkeletonText lines={4} />
        </div>
      ) : error ? (
        <ErrorState
          title="Could not count what is loaded"
          message="The counts did not come back, so nothing on this page can tell you whether an earlier import worked. Nothing has been changed."
          onRetry={() => void refetch()}
        />
      ) : data ? (
        <div className="panel-lead p-5 sm:p-6">
          <dl className="grid grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-4">
            {STAT_ROWS.map((s) => (
              <div key={s.key}>
                <dt>
                  <ColumnLabel>{s.label}</ColumnLabel>
                </dt>
                <dd className="mt-1">
                  <Figure
                    className="text-xl sm:text-2xl"
                    tone={data[s.key] === 0 ? "caution" : "neutral"}
                  >
                    {nf(data[s.key])}
                  </Figure>
                  <Meta className="mt-0.5 block">
                    {data[s.key] === 0 ? `None — ${s.about.toLowerCase()}` : s.about}
                  </Meta>
                </dd>
              </div>
            ))}
          </dl>

          <hr className="hairline my-5" />

          <Meta className="block">
            These are counts and nothing else — <code>/api/admin/erp-stats</code>{" "}
            returns no timestamps, so this screen cannot honestly tell you when
            each import last ran. The{" "}
            <Link to="/audit" className="underline underline-offset-2">
              audit log
            </Link>{" "}
            does: every import writes a row there
            (<code>FACULTY_MASTER_IMPORT</code>,{" "}
            <code>PRIOR_PAYMENT_IMPORT</code>, <code>ERP_XLSX_IMPORT</code>)
            with who ran it and when.
          </Meta>
        </div>
      ) : null}
    </section>
  )
}

/* ------------------------------------------------------------------------ */
/* Shared upload pieces                                                      */
/* ------------------------------------------------------------------------ */

/** The file picker every section on this page uses, styled the same way as
 *  the one on the reference-data screen so two import boxes in the same app
 *  do not look like two different apps. */
function FileInput({
  file,
  onPick,
  ...rest
}: Omit<React.ComponentProps<"input">, "type" | "value" | "onChange"> & {
  file: File | null
  onPick: (f: File | null) => void
}) {
  // A picked-then-cleared input keeps its old filename in the native control
  // unless the element itself is replaced, which reads as a file still being
  // attached after an import has consumed it. Changing the key is what
  // replaces it; the ref keeps that from happening on the first paint, when
  // there was never a filename to clear.
  const [nonce, setNonce] = useState(0)
  const held = useRef(false)
  useEffect(() => {
    if (file) {
      held.current = true
      return
    }
    if (!held.current) return
    held.current = false
    setNonce((n) => n + 1)
  }, [file])

  return (
    <input
      key={nonce}
      type="file"
      onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
        onPick(e.target.files?.[0] || null)
      }
      {...rest}
      className={cn(
        "block w-full text-sm file:mr-3 file:rounded-md file:border file:border-line",
        "file:bg-surface file:px-3 file:py-1.5 file:text-sm",
        rest.disabled && "opacity-50",
        rest.className
      )}
    />
  )
}

/**
 * What an import did, in numbers, kept on the page.
 *
 * A toast is gone in four seconds and takes the only record of the result
 * with it. Somebody importing eleven years of payment history needs to be
 * able to look back at "1,284 rows" ten minutes later without re-running the
 * import to find out.
 */
function ImportResult({ children }: { children: React.ReactNode }) {
  return (
    <div className="well px-3 py-2.5 text-sm" role="status">
      {children}
    </div>
  )
}

/** The reason a submit button is disabled, said out loud. A greyed button
 *  with no explanation is a screen that has stopped talking to you. */
function WhyDisabled({ reason }: { reason: string | null }) {
  if (!reason) return null
  return <Meta className="block">{reason}</Meta>
}

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message
  return "The server did not answer."
}

/* ------------------------------------------------------------------------ */
/* 2. Faculty master                                                         */
/* ------------------------------------------------------------------------ */

/**
 * The roster.
 *
 * `faculty_master_import` keys on `staff_id` and calls `update_or_create`,
 * so a staff id already held is **overwritten in every column** — and by
 * the value in the file, which for a column your CSV does not carry is
 * nothing at all. A roster export missing its phone column therefore blanks
 * every phone number in the table. That is why this one is behind a
 * confirmation and the reference-data imports are not.
 */
function FacultyMasterSection({ onImported }: { onImported: () => void }) {
  const list = useApi<FacultyRow[]>(["admin", "faculty-master"], "/api/admin/faculty-master")
  const [file, setFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)

  const departments = useMemo(() => {
    const set = new Set<string>()
    for (const f of list.data ?? []) if (f.department) set.add(f.department)
    return set.size
  }, [list.data])

  async function run() {
    if (!file) return
    setBusy(true)
    setResult(null)
    try {
      const body = new FormData()
      body.append("file", file)
      // `api()`'s options type has no `body` — every other call it makes is
      // JSON — so this widens it exactly the way `batches.tsx` and
      // `reference.tsx` do, rather than going around `api()` and losing the
      // CSRF header with it.
      const res = await api<{ imported: number }>("/api/admin/faculty-master/import", {
        method: "POST",
        body,
      } as unknown as Parameters<typeof api>[1])
      setResult(
        `${nf(res.imported)} rows imported. Any row with no staff id or no name was skipped, and the server does not count those — if this figure is short of the rows in your file, that is where the difference is.`
      )
      toast.ok(`${nf(res.imported)} faculty rows imported.`)
      setFile(null)
      void list.refetch()
      onImported()
    } catch (err) {
      setResult(null)
      toast.fail(err)
    } finally {
      setBusy(false)
    }
  }

  const columns: Column<FacultyRow>[] = [
    {
      key: "name",
      header: "Name",
      className: "max-w-[16rem]",
      cell: (f) => (
        <span className="block">
          <span className="block truncate text-sm">{f.name}</span>
          <Meta className="block truncate">{f.designation || "No designation"}</Meta>
        </span>
      ),
    },
    { key: "staff", header: "Staff ID", cell: (f) => f.staff_id || "—" },
    {
      key: "dept",
      header: "Department",
      className: "max-w-[12rem]",
      cell: (f) => (
        <span className="block truncate text-fg-muted">{f.department || "—"}</span>
      ),
    },
    {
      key: "email",
      header: "Email",
      className: "max-w-[14rem]",
      cell: (f) => (
        <span className="block truncate text-fg-muted">{f.email || "—"}</span>
      ),
    },
    { key: "scopus", header: "Scopus ID", cell: (f) => f.scopus_author_id || "—" },
  ]

  const rows = list.data ?? []
  const preview = rows.slice(0, 25)
  const reason = busy ? "Importing." : !file ? "Choose a CSV first." : null

  return (
    <section className="space-y-4" aria-labelledby="faculty-master">
      <div>
        <SectionTitle>
          <span id="faculty-master">Faculty master</span>
        </SectionTitle>
        <Sub className="mt-1">
          The roster the whole system matches names against. A paper filed by
          somebody who is not in here has no department, and so appears in
          nobody's figures.
        </Sub>
      </div>

      {list.isLoading ? (
        <SkeletonText lines={2} />
      ) : list.error ? (
        <InlineError
          message="Could not read the faculty master. The importer below still works, but you will not see the result of it here."
          onRetry={() => void list.refetch()}
        />
      ) : (
        <p className="text-sm">
          <span className="text-lg font-medium tabular">{nf(rows.length)}</span> faculty
          held, across {nf(departments)}{" "}
          {departments === 1 ? "department" : "departments"}.
        </p>
      )}

      <Callout tone="caution" title="This one replaces rows it already has">
        Every row is matched on its staff id. A staff id already in the table
        is <strong>overwritten in every column</strong> — department,
        biometric id, Scopus id, designation, email and phone — with whatever
        the file says, including nothing at all. A partial export blanks the
        columns it leaves out. Rows whose staff id is new are added.
      </Callout>

      <Callout tone="info" title="Which columns are read">
        <strong>Required:</strong> <code>staff_id</code> / <code>Staff ID</code>{" "}
        / <code>Staff_ID</code>, and <code>name</code> / <code>Name</code> /{" "}
        <code>Faculty Name</code> — a row missing either is skipped in
        silence.
        <br />
        <strong>Also read:</strong> <code>department</code> /{" "}
        <code>Department</code>, <code>biometric_id</code> /{" "}
        <code>Biometric ID</code>, <code>scopus_author_id</code> /{" "}
        <code>Scopus Author ID</code>, <code>designation</code> /{" "}
        <code>Designation</code>, <code>email</code> / <code>Email</code>,{" "}
        <code>phone</code> / <code>Phone</code>. Every other column in the file
        is kept verbatim on the row but is never read back.
      </Callout>

      <div className="grid gap-4 sm:grid-cols-[1fr_auto] sm:items-end">
        <Field label="Roster CSV" hint="A comma-separated export, not the ERP workbook.">
          <FileInput accept=".csv,text/csv" file={file} onPick={setFile} disabled={busy} />
        </Field>
        <div className="space-y-1.5">
          <Button
            kind="default"
            disabled={reason !== null}
            onClick={() => setConfirming(true)}
          >
            <Users />
            {busy ? "Importing…" : "Import the roster"}
          </Button>
          <WhyDisabled reason={reason} />
        </div>
      </div>

      {result ? <ImportResult>{result}</ImportResult> : null}

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        danger
        title="Replace the rows this file matches?"
        description={`Every row in ${
          file?.name || "the file"
        } whose staff id is already held will have all of its columns replaced by what the file says — including columns the file leaves out, which are set to nothing. Faculty not named in the file are untouched. There is no undo.`}
        confirmLabel="Replace and import"
        onConfirm={() => run()}
      />

      <FacultyLookup />

      {list.isLoading ? (
        <SkeletonRows rows={5} rowHeight={48} />
      ) : rows.length === 0 && !list.error ? (
        <EmptyState
          art="nothing-filed"
          title="No faculty loaded yet"
          message="The roster is empty. Import a CSV above, or load the whole ERP workbook further down — until then, no paper can be matched to a department."
        />
      ) : preview.length > 0 ? (
        <div className="space-y-2">
          <Table
            rows={preview}
            columns={columns}
            getKey={(f) => f.id}
            caption="Faculty master, first 25 rows"
            maxHeight="24rem"
            minWidth="46rem"
          />
          {rows.length > preview.length ? (
            <Meta className="block">
              The first 25 of {nf(rows.length)}. The endpoint returns the whole
              table at once; the rest is on the{" "}
              <Link to="/data?table=facultymaster" className="underline underline-offset-2">
                Data screen
              </Link>
              , which pages it.
            </Meta>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}

/**
 * Did the person you just imported end up with a way to sign in?
 *
 * `/api/admin/faculty-options` is the only endpoint that answers that: it
 * merges the faculty master with the live user accounts and says, per
 * person, whether one exists. After a roster import that is the question —
 * a master row with no account is somebody who is on the roster and cannot
 * file a paper.
 */
function FacultyLookup() {
  const [typed, setTyped] = useState("")
  const [q, setQ] = useState("")

  // A keystroke is a query here, and the endpoint is deliberately not cheap.
  useEffect(() => {
    const t = setTimeout(() => setQ(typed.trim()), 300)
    return () => clearTimeout(t)
  }, [typed])

  const enabled = q.length >= 2
  const { data, isLoading, error, refetch, isFetching } = useApi<FacultyOption[]>(
    ["admin", "faculty-options", q],
    `/api/admin/faculty-options?q=${encodeURIComponent(q)}`,
    { enabled }
  )

  return (
    <div className="well space-y-3 p-3 sm:p-4">
      <Field
        label="Find somebody on the roster"
        hint="Name, staff id, email or department. Says whether they also have an account to sign in with."
      >
        <Input
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          placeholder="Two letters or more"
        />
      </Field>

      {!enabled ? (
        <Meta className="block">
          <Search className="mr-1 inline size-3.5 align-[-2px]" aria-hidden />
          Nothing is searched until you have typed two characters.
        </Meta>
      ) : error ? (
        <InlineError message={messageOf(error)} onRetry={() => void refetch()} />
      ) : isLoading || isFetching ? (
        <SkeletonText lines={2} />
      ) : !data || data.length === 0 ? (
        <p className="text-sm text-fg-muted">
          Nobody on the roster or in the accounts matches “{q}”. That is an
          answer, not a failure — the search reached the server and came back
          with none.
        </p>
      ) : (
        <ul className="divide-y divide-line text-sm">
          {data.slice(0, 12).map((f) => (
            <li
              key={f.owner_id || f.master_id || f.name}
              className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 py-2"
            >
              <span className="min-w-0">
                <span className="block truncate">{f.name}</span>
                <Meta className="block truncate">
                  {[f.staff_id, f.department, f.email].filter(Boolean).join(" · ") ||
                    "No staff id, department or email held"}
                </Meta>
              </span>
              <span
                className={cn(
                  "shrink-0 text-sm",
                  f.has_user_account ? "text-fg-muted" : "text-caution"
                )}
              >
                {f.has_user_account ? "Has an account" : "No account — cannot sign in"}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------------ */
/* 3. Prior payment history                                                  */
/* ------------------------------------------------------------------------ */

/**
 * What was paid before this system existed.
 *
 * These rows are what the duplicate check runs against, so they are the
 * reason a paper somebody was already paid for in 2019 cannot be claimed
 * again. `prior_import` only ever calls `PriorPayment.objects.create` — it
 * appends, it does not match, and it does not de-duplicate. Loading the same
 * file twice therefore doubles the history rather than replacing it, which
 * is worth saying but is not the kind of thing that needs a confirmation
 * dialog in front of it.
 */
function PriorPaymentsSection({
  stats,
  onImported,
}: {
  stats: ErpStats | undefined
  onImported: () => void
}) {
  const [file, setFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<string | null>(null)
  const [failure, setFailure] = useState<string | null>(null)

  async function run() {
    if (!file) return
    setBusy(true)
    setResult(null)
    setFailure(null)
    try {
      const body = new FormData()
      body.append("file", file)
      const res = await api<{ imported: number; batch_id: string }>(
        "/api/admin/prior/import",
        { method: "POST", body } as unknown as Parameters<typeof api>[1]
      )
      setResult(
        `${nf(res.imported)} rows imported, 0 skipped — this importer keeps every row it reads. Batch ${res.batch_id}.`
      )
      toast.ok(`${nf(res.imported)} prior payments added.`)
      setFile(null)
      onImported()
    } catch (err) {
      // The whole import is one transaction and the server names the line it
      // choked on. Losing that in a four-second toast means re-uploading to
      // find out which row to fix.
      setFailure(messageOf(err))
      toast.fail(err)
    } finally {
      setBusy(false)
    }
  }

  const reason = busy ? "Importing." : !file ? "Choose a CSV first." : null

  return (
    <section className="space-y-4" aria-labelledby="prior">
      <div>
        <SectionTitle>
          <span id="prior">Prior payment history</span>
        </SectionTitle>
        <Sub className="mt-1">
          What the college paid before this system. Every row here blocks a
          future claim for the same paper as a duplicate, which is the whole
          point of loading it.
        </Sub>
      </div>

      {stats ? (
        <p className="text-sm">
          <span className="text-lg font-medium tabular">{nf(stats.prior_payments)}</span>{" "}
          prior payments held.
        </p>
      ) : null}

      <Callout tone="info" title="This one adds, it never replaces">
        Every row in the file becomes a new record under a fresh batch.
        Nothing already held is matched, changed or removed — so importing
        the same file twice leaves two copies of that history, and papers
        matching it will be flagged as duplicates twice over. Check the count
        above before and after.
      </Callout>

      <Callout tone="info" title="Which columns are read">
        <strong>Title</strong> from <code>paper_title</code>,{" "}
        <code>title</code> or <code>Paper Title</code>;{" "}
        <strong>DOI</strong> from <code>doi</code> or <code>DOI</code>;{" "}
        <strong>amount</strong> from <code>amount</code> only;{" "}
        <strong>who</strong> from <code>faculty_name</code> or{" "}
        <code>name</code>, plus <code>employee_id</code>; and the journal from{" "}
        <code>issn</code> and <code>journal</code>. Note the amount column has
        no alternative spelling — a file whose amount is under{" "}
        <code>Amount</code> or <code>amount_paid</code> imports as history
        with no money on it, and nothing says so.
      </Callout>

      <Callout tone="caution" title="A bad amount stops the whole file">
        Amounts are read with commas stripped. If any one of them is not a
        number the import is rolled back entirely and the server names the
        line — nothing is half-loaded.
      </Callout>

      <div className="grid gap-4 sm:grid-cols-[1fr_auto] sm:items-end">
        <Field label="History CSV" hint="One row per payment already made.">
          <FileInput accept=".csv,text/csv" file={file} onPick={setFile} disabled={busy} />
        </Field>
        <div className="space-y-1.5">
          <Button kind="default" disabled={reason !== null} onClick={() => void run()}>
            <Upload />
            {busy ? "Importing…" : "Add to the history"}
          </Button>
          <WhyDisabled reason={reason} />
        </div>
      </div>

      {failure ? (
        <InlineError message={failure} />
      ) : result ? (
        <ImportResult>{result}</ImportResult>
      ) : null}
    </section>
  )
}

/* ------------------------------------------------------------------------ */
/* 4. The ERP workbook                                                       */
/* ------------------------------------------------------------------------ */

type WorkbookOptions = {
  year: string
  claimsOnly: boolean
  faculty: boolean
  accounts: boolean
  sjr: boolean
  snip: boolean
  claims: boolean
  syncUsers: boolean
}

const DEFAULT_OPTIONS: WorkbookOptions = {
  year: "2025",
  claimsOnly: false,
  faculty: true,
  accounts: true,
  // Off by default on the server too, and for a good reason — see the
  // warning these two produce below.
  sjr: false,
  snip: false,
  claims: true,
  syncUsers: true,
}

const MAX_BYTES = 40 * 1024 * 1024

/**
 * `Publication_Processing_ERP.xlsx` — the whole college in one workbook.
 *
 * Seven sheets, each landing in a different table, and only some of them
 * append. This is the single most destructive thing in the application: with
 * the two reference sheets switched on it **deletes every SCImago and SNIP
 * row for the chosen year** before reloading them, which re-prices every
 * paper that has not been paid yet. So those two carry a typed confirmation
 * and the rest carry a plain one.
 *
 * It runs on the job queue rather than in the request, because the import is
 * 754 lines of workbook and used to be raced against the gunicorn timeout.
 */
function WorkbookSection({ onImported }: { onImported: () => void }) {
  const [file, setFile] = useState<File | null>(null)
  const [opts, setOpts] = useState<WorkbookOptions>(DEFAULT_OPTIONS)
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [jobId, setJobId] = useState<string | null>(null)

  const set = <K extends keyof WorkbookOptions>(k: K, v: WorkbookOptions[K]) =>
    setOpts((prev) => ({ ...prev, [k]: v }))

  const yearOk = /^\d{4}$/.test(opts.year.trim())
  const wrongType =
    !!file && !/\.(xlsx|xlsm)$/i.test(file.name)
  const tooBig = !!file && file.size > MAX_BYTES
  // "Papers only" switches the master sheets off wholesale, so it has to be
  // part of this: claims_only with skip_claims is a 40 MB upload that reads
  // nothing at all, and the server would accept it without a word.
  const readsMasters =
    !opts.claimsOnly && (opts.faculty || opts.accounts || opts.sjr || opts.snip)
  const readsNothing = !readsMasters && !opts.claims

  const reason = busy
    ? "Uploading."
    : !file
      ? "Choose an .xlsx workbook first."
      : wrongType
        ? "The server accepts .xlsx and .xlsm only, and refuses anything else outright."
        : tooBig
          ? `That file is ${(file.size / 1024 / 1024).toFixed(1)} MB. The limit is 40 MB.`
          : !yearOk
            ? "The dataset year has to be four digits."
            : readsNothing
              ? "No sheet is selected, so the workbook would be uploaded and read for nothing."
              : null

  // What this run will actually do, in the order the command does it. Built
  // once and used twice: shown on the page, and read out in the dialog.
  const effects = useMemo(() => {
    const out: string[] = []
    if (!opts.claimsOnly) {
      if (opts.faculty)
        out.push(
          "Faculty_Data → the faculty master, matched on Staff-ID. Rows already held are replaced column for column."
        )
      if (opts.accounts)
        out.push(
          "Master_List_Accounts → prior payments and the paid ledger. Added, not replaced, though a row identical in title, DOI and amount is skipped."
        )
      if (opts.sjr)
        out.push(
          `SJR_Data → SCImago. Every SCImago row for ${opts.year} is DELETED first, then reloaded from the sheet.`
        )
      if (opts.snip)
        out.push(
          `SNIP_2025 → SNIP. Every SNIP row for ${opts.year} is DELETED first, then reloaded from the sheet.`
        )
    }
    if (opts.claims)
      out.push(
        "Processed, Raw_Data and Accounts → papers, matched on DOI, staff id or title. A match has its fields overwritten by any non-empty cell; a paid paper keeps its paid status."
      )
    if (opts.syncUsers)
      out.push("Afterwards, sign-in accounts are created for roster rows that have none.")
    return out
  }, [opts])

  const wipesReference = opts.sjr || opts.snip

  async function run() {
    if (!file) return
    setBusy(true)
    setJobId(null)
    try {
      const body = new FormData()
      body.append("file", file)
      body.append("year", opts.year.trim())
      body.append("claims_only", String(opts.claimsOnly))
      // The server speaks in skips; the screen speaks in what to include,
      // because "skip_faculty: false" is a double negative on a checkbox.
      body.append("skip_faculty", String(!opts.faculty))
      body.append("skip_accounts", String(!opts.accounts))
      body.append("skip_sjr", String(!opts.sjr))
      body.append("skip_snip", String(!opts.snip))
      body.append("skip_claims", String(!opts.claims))
      body.append("sync_users", String(opts.syncUsers))
      const res = await api<{ ok: boolean; queued: boolean; job_id: string }>(
        "/api/admin/erp-import",
        { method: "POST", body } as unknown as Parameters<typeof api>[1]
      )
      setJobId(res.job_id)
      setFile(null)
      toast.ok("Workbook accepted. It runs in the background — watch the job below.")
    } catch (err) {
      toast.fail(err)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="space-y-4" aria-labelledby="workbook">
      <div>
        <SectionTitle>
          <span id="workbook">The ERP workbook</span>
        </SectionTitle>
        <Sub className="mt-1">
          <code>Publication_Processing_ERP.xlsx</code> — the roster, the
          accounts history, the journal tables and every paper, in one file.
          It is the way a whole year gets loaded at once.
        </Sub>
      </div>

      <Callout tone="critical" title="This overwrites records that are already here">
        The workbook is not an addition to the database, it is a statement
        about what the database should say. The roster is replaced row for
        row, papers already filed are overwritten by any cell the sheet
        fills, and if the two journal sheets are switched on the entire
        SCImago and SNIP tables <strong>for the chosen year are deleted</strong>{" "}
        before being rebuilt. Both of those are off by default here for the
        same reason they are off by default on the server.
      </Callout>

      <div className="grid gap-4 sm:grid-cols-[1fr_auto] sm:items-end">
        <Field
          label="The workbook"
          hint="Excel only — .xlsx or .xlsm, up to 40 MB."
        >
          <FileInput
            accept=".xlsx,.xlsm"
            file={file}
            onPick={setFile}
            disabled={busy}
          />
        </Field>
        <Field label="Dataset year" className="sm:w-32">
          <NumberInput
            value={opts.year}
            onChange={(e) => set("year", e.target.value)}
            min={1999}
            step="1"
          />
        </Field>
      </div>

      <fieldset className="well space-y-3 p-3 sm:p-4">
        <legend className="px-1 text-sm font-medium">Which sheets to read</legend>

        <Checkbox
          checked={opts.claimsOnly}
          onCheckedChange={(v) => set("claimsOnly", v === true)}
          label="Papers only"
          hint="Ignore every master-data sheet and read only Processed, Raw_Data and Accounts."
        />

        <hr className="hairline" />

        <div className="grid gap-3 sm:grid-cols-2">
          <Checkbox
            checked={opts.faculty}
            disabled={opts.claimsOnly}
            onCheckedChange={(v) => set("faculty", v === true)}
            label="Faculty_Data → the roster"
            hint="Replaces any staff id it already holds."
          />
          <Checkbox
            checked={opts.accounts}
            disabled={opts.claimsOnly}
            onCheckedChange={(v) => set("accounts", v === true)}
            label="Master_List_Accounts → payment history"
            hint="Adds. Skips a row identical in title, DOI and amount."
          />
          <Checkbox
            checked={opts.sjr}
            disabled={opts.claimsOnly}
            onCheckedChange={(v) => set("sjr", v === true)}
            label="SJR_Data → SCImago quartiles"
            hint={`Deletes every SCImago row for ${opts.year} first.`}
          />
          <Checkbox
            checked={opts.snip}
            disabled={opts.claimsOnly}
            onCheckedChange={(v) => set("snip", v === true)}
            label="SNIP_2025 → SNIP figures"
            hint={`Deletes every SNIP row for ${opts.year} first.`}
          />
          <Checkbox
            checked={opts.claims}
            onCheckedChange={(v) => set("claims", v === true)}
            label="Processed, Raw_Data, Accounts → papers"
            hint="Matched on DOI, staff id or title, then overwritten."
          />
          <Checkbox
            checked={opts.syncUsers}
            onCheckedChange={(v) => set("syncUsers", v === true)}
            label="Create sign-in accounts afterwards"
            hint="For roster rows that do not have one yet."
          />
        </div>
      </fieldset>

      {effects.length > 0 ? (
        <div className="space-y-1.5">
          <ColumnLabel>What this run would do</ColumnLabel>
          <ul className="list-disc space-y-1 pl-5 text-sm text-fg-muted">
            {effects.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="space-y-1.5">
        <Button
          kind="danger"
          disabled={reason !== null}
          onClick={() => setConfirming(true)}
        >
          <FileSpreadsheet />
          {busy ? "Uploading…" : "Import the workbook"}
        </Button>
        <WhyDisabled reason={reason} />
      </div>

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        danger
        title={
          wipesReference
            ? `Delete the ${opts.year} journal tables and rebuild them?`
            : "Overwrite what the workbook covers?"
        }
        description={`${effects.join(" ")}${
          wipesReference
            ? ` Deleting a year of journal data re-prices every paper not yet paid, because a journal missing from those tables is worth a flat rate. There is no undo.`
            : " There is no undo."
        }`}
        confirmLabel={wipesReference ? "Delete and rebuild" : "Overwrite and import"}
        // Only where the file genuinely removes rows. A typing test in front
        // of an ordinary import trains people to type it without reading.
        requirePhrase={wipesReference ? "REPLACE" : undefined}
        onConfirm={() => run()}
      />

      {jobId ? (
        <JobProgress
          key={jobId}
          jobId={jobId}
          what="the workbook import"
          onSettled={onImported}
        />
      ) : null}
    </section>
  )
}

/* ------------------------------------------------------------------------ */
/* 5. The verification queue                                                 */
/* ------------------------------------------------------------------------ */

const STATUS_FILTERS: { value: string; label: string }[] = [
  { value: "", label: "Not yet through the office (draft and submitted)" },
  { value: "DRAFT", label: "Draft" },
  { value: "SUBMITTED", label: "Submitted" },
  { value: "CLEARED", label: "Cleared" },
  { value: "PRINCIPAL_APPROVED", label: "Principal approved" },
  { value: "DIRECTOR_APPROVED", label: "Director authorised" },
  { value: "PAID", label: "Paid" },
  { value: "REJECTED", label: "Rejected" },
]

const STATUS_LABEL: Record<string, string> = {
  DRAFT: "Draft",
  SUBMITTED: "Submitted",
  CLEARED: "Cleared",
  PRINCIPAL_APPROVED: "Principal approved",
  DIRECTOR_APPROVED: "Director authorised",
  PAID: "Paid",
  REJECTED: "Rejected",
}

/** The most a single batch may carry, from `admin_process_batch`. */
const BATCH_CAP = 500

/**
 * The papers still waiting to be checked against Scopus.
 *
 * `/api/admin/process` is not simply "claims by status": whatever status you
 * ask for, it only ever returns papers whose indexing is not yet `Indexed`.
 * That is the point of it — this is the list of things the monthly run has
 * not managed to confirm — and a screen that presented it as a plain status
 * filter would have people wondering where the rest of their papers went.
 */
function ProcessQueueSection() {
  const [status, setStatus] = useState("")
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [jobId, setJobId] = useState<string | null>(null)

  const path = status
    ? `/api/admin/process?status=${encodeURIComponent(status)}`
    : "/api/admin/process"
  const { data, isLoading, error, refetch, isFetching } = useApi<QueueClaim[]>(
    ["admin", "process", status],
    path
  )

  // A tick selected under one filter and queued under another is a batch
  // whose contents nobody on the page can see.
  useEffect(() => setSelected(new Set()), [status])

  const rows = useMemo(() => data ?? [], [data])
  const allSelected = rows.length > 0 && rows.every((r) => selected.has(r.id))
  const someSelected = rows.some((r) => selected.has(r.id))

  const queue = useApiMutation<{ claim_ids: string[] }, { queued: boolean; job_id: string; count: number }>(
    "/api/admin/process/batch"
  )

  function toggle(id: string, on: boolean) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (on) next.add(id)
      else next.delete(id)
      return next
    })
  }

  function toggleAll(on: boolean) {
    setSelected(on ? new Set(rows.map((r) => r.id)) : new Set())
  }

  const count = selected.size
  const overCap = count > BATCH_CAP
  const reason = queue.isPending
    ? "Queueing."
    : count === 0
      ? "Tick at least one paper."
      : overCap
        ? `A batch carries ${nf(BATCH_CAP)} papers at most; ${nf(count)} are ticked.`
        : null

  const columns: Column<QueueClaim>[] = [
    {
      key: "pick",
      header: (
        <Checkbox
          checked={allSelected ? true : someSelected ? "indeterminate" : false}
          onCheckedChange={(v) => toggleAll(v === true)}
          aria-label="Select every paper listed"
        />
      ),
      className: "w-10",
      headerClassName: "w-10",
      cell: (c) => (
        <Checkbox
          checked={selected.has(c.id)}
          onCheckedChange={(v) => toggle(c.id, v === true)}
          aria-label={`Select ${c.paper_title || c.ticket_number || "this paper"}`}
        />
      ),
    },
    {
      key: "paper",
      header: "Paper",
      className: "max-w-[22rem]",
      cell: (c) => (
        <span className="block">
          <span className="block truncate text-sm">{c.paper_title || "Untitled"}</span>
          <Meta className="block truncate">
            {[c.ticket_number, c.owner_name, c.owner_department]
              .filter(Boolean)
              .join(" · ")}
          </Meta>
        </span>
      ),
    },
    {
      key: "journal",
      header: "Journal",
      className: "max-w-[14rem]",
      cell: (c) => (
        <span className="block">
          <span className="line-clamp-2 text-sm text-fg-muted">
            {c.journal_title || "—"}
          </span>
          {c.doi ? <Meta className="block truncate">{c.doi}</Meta> : null}
        </span>
      ),
    },
    {
      key: "status",
      header: "Status",
      cell: (c) => STATUS_LABEL[c.status] || c.status,
    },
    {
      key: "indexing",
      header: "Indexing",
      cell: (c) => (
        <span className={cn(!c.indexing_status && "text-fg-muted")}>
          {c.indexing_status || "Not checked"}
        </span>
      ),
    },
    {
      key: "waiting",
      header: "Waiting",
      align: "right",
      cell: (c) => (c.waiting_days == null ? "—" : `${nf(c.waiting_days)} d`),
    },
  ]

  return (
    <section className="space-y-4" aria-labelledby="queue">
      <div>
        <SectionTitle>
          <span id="queue">The verification queue</span>
        </SectionTitle>
        <Sub className="mt-1">
          Papers whose indexing has not been confirmed. Queueing one sends it
          to Scopus, which is where its quartile and SNIP — and therefore what
          it is worth — come from.
        </Sub>
      </div>

      <Callout tone="caution" title="Verifying rewrites what a paper is worth">
        A check pulls the paper's indexing, quartile and SNIP from Scopus and
        recalculates the amount from them, replacing what is on the ticket
        now. A paper that has already been paid is refused outright by the
        server, so ticking one only puts a line in the failures list.
      </Callout>

      <div className="well flex flex-wrap items-end gap-3 p-3">
        <Field
          label="Status"
          hint="Whatever you pick, papers already marked Indexed are left out — that is what this queue is."
          className="min-w-0 flex-1 sm:max-w-md"
        >
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            className={cn(
              "h-8 w-full rounded-md bg-surface px-2.5 text-sm text-fg outline-none",
              "ring-1 ring-inset ring-field focus-visible:ring-2 focus-visible:ring-accent"
            )}
          >
            {STATUS_FILTERS.map((f) => (
              <option key={f.value || "default"} value={f.value}>
                {f.label}
              </option>
            ))}
          </select>
        </Field>
        <Button
          kind="quiet"
          size="md"
          onClick={() => void refetch()}
          disabled={isFetching}
        >
          <RefreshCw />
          {isFetching ? "Reading…" : "Refresh"}
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <Button
          kind="default"
          disabled={reason !== null}
          onClick={() =>
            queue.mutate(
              { claim_ids: [...selected] },
              {
                onSuccess: (res) => {
                  setJobId(res.job_id)
                  setSelected(new Set())
                  toast.ok(`${nf(res.count)} papers queued for checking.`)
                },
                onError: (err: ApiError) => toast.fail(err),
              }
            )
          }
        >
          <Search />
          {queue.isPending
            ? "Queueing…"
            : count === 0
              ? "Queue for checking"
              : `Queue ${nf(count)} for checking`}
        </Button>
        <WhyDisabled reason={reason} />
      </div>

      {jobId ? (
        <JobProgress
          key={jobId}
          jobId={jobId}
          what="the batch of checks"
          onSettled={() => void refetch()}
        />
      ) : null}

      {isLoading ? (
        <SkeletonRows rows={6} rowHeight={56} />
      ) : error ? (
        <ErrorState
          title="Could not read the queue"
          message="The list of papers waiting to be checked did not come back. Nothing has been queued and no paper has changed."
          onRetry={() => void refetch()}
        />
      ) : rows.length === 0 ? (
        <EmptyState
          art="empty-queue"
          title="Nothing waiting to be checked"
          message={
            status
              ? "No paper at that status is still unconfirmed. Try another status, or the default, which covers drafts and submitted tickets."
              : "Every draft and submitted paper has had its indexing confirmed. This is the queue being empty, not the request failing."
          }
        />
      ) : (
        <div className="space-y-2">
          <Table
            rows={rows}
            columns={columns}
            getKey={(c) => c.id}
            caption="Papers awaiting Scopus verification"
            maxHeight="32rem"
            minWidth="52rem"
          />
          <Meta className="block">
            {nf(rows.length)} shown
            {rows.length === 200
              ? " — which is the server's limit, so there may be more behind it. Narrow by status to see the rest."
              : "."}
          </Meta>
        </div>
      )}
    </section>
  )
}

/* ------------------------------------------------------------------------ */
/* Job progress                                                              */
/* ------------------------------------------------------------------------ */

const TERMINAL = new Set(["done", "failed"])

/**
 * How a queued job is going, said as honestly as the server can say it.
 *
 * `/api/admin/jobs/{id}` has no notion of percentage and never will — it
 * looks the id up in the finished-task table, and failing that walks the
 * pending queue. So there are three answers and this component does not
 * dress any of them up as a progress bar: queued (waiting for a worker),
 * `running_or_unknown` (in a worker's hands *or* an id nothing recognises —
 * the endpoint genuinely cannot tell those apart), and done or failed with
 * the result attached. An invented progress bar over that would be a lie
 * that gets believed, on an import that takes twenty minutes.
 */
function JobProgress({
  jobId,
  what,
  onSettled,
}: {
  jobId: string
  what: string
  onSettled?: () => void
}) {
  const [settled, setSettled] = useState(false)
  const { data, error, refetch } = useApi<Job>(
    ["admin", "job", jobId],
    `/api/admin/jobs/${jobId}`,
    // Three seconds while it is live, and nothing at all once there is a
    // final answer: an import nobody is watching must not leave a timer
    // running for the rest of the working day.
    { staleTime: 0, refetchInterval: settled ? false : 3000 }
  )

  const [elapsed, setElapsed] = useState(0)
  const notified = useRef(false)

  useEffect(() => {
    if (settled) return
    const t = setInterval(() => setElapsed((s) => s + 1), 1000)
    return () => clearInterval(t)
  }, [settled])

  useEffect(() => {
    if (!data || !TERMINAL.has(data.status)) return
    setSettled(true)
    if (notified.current) return
    notified.current = true
    onSettled?.()
  }, [data, onSettled])

  if (error) {
    return (
      <InlineError
        message={`Lost track of ${what}: ${messageOf(error)} The job itself is unaffected — it runs on the server whether or not this page can see it.`}
        onRetry={() => void refetch()}
      />
    )
  }

  const tone =
    data?.status === "failed" ? "critical" : data?.status === "done" ? "positive" : "info"

  return (
    <Callout tone={tone} title={jobTitle(data, what)}>
      <p>{jobExplanation(data, what)}</p>
      {!settled ? (
        <p className="mt-1 tabular">
          Watching for {formatElapsed(elapsed)}. Checked every three seconds.
          Nothing is lost if you leave — it runs on the server.
        </p>
      ) : null}
      {settled && data ? <p className="mt-1">{describeResult(data)}</p> : null}
      <Meta className="mt-1 block">Job {jobId}</Meta>
    </Callout>
  )
}

function jobTitle(job: Job | undefined, what: string): string {
  switch (job?.status) {
    case "done":
      return `Finished ${what}`
    case "failed":
      return `${what[0].toUpperCase()}${what.slice(1)} failed`
    case "queued":
      return "Waiting for a worker"
    case "running_or_unknown":
      return "Running, probably"
    default:
      return `Asking about ${what}`
  }
}

function jobExplanation(job: Job | undefined, what: string): string {
  switch (job?.status) {
    case "done":
      return `The server finished ${what}${
        job.stopped ? ` at ${new Date(job.stopped).toLocaleTimeString()}` : ""
      }.`
    case "failed":
      return "The worker picked it up and it did not complete. Nothing further will happen on its own."
    case "queued":
      return "It is on the queue and no worker has taken it yet. That is normal for the first few seconds; if it stays here, no worker is running."
    case "running_or_unknown":
      return "A worker most likely has it. The server cannot be more precise than that — this same answer is what it gives for a job id it does not recognise, so it is not proof of progress."
    default:
      return "Asking the server where this got to."
  }
}

/** The two jobs this page starts return different shapes, and both are worth
 *  reading as numbers rather than as "done". */
function describeResult(job: Job): string {
  const r = job.result
  if (job.status === "failed") {
    return typeof r === "string" && r ? r : "The server recorded no reason."
  }
  if (r && typeof r === "object") {
    const rec = r as Record<string, unknown>
    // run_bulk_verify
    if (Array.isArray(rec.verified) || Array.isArray(rec.failed)) {
      const ok: number = Array.isArray(rec.verified) ? rec.verified.length : 0
      const bad: unknown[] = Array.isArray(rec.failed) ? (rec.failed as unknown[]) : []
      const reasons = bad
        .map((f) =>
          f && typeof f === "object" && "reason" in f
            ? String((f as { reason: unknown }).reason)
            : null
        )
        .filter((x): x is string => !!x)
      const head = `${nf(ok)} checked, ${nf(bad.length)} failed.`
      return reasons.length > 0 ? `${head} ${reasons.slice(0, 3).join(" ")}` : head
    }
    // run_erp_import
    if (rec.stats && typeof rec.stats === "object") {
      const s = rec.stats as Record<string, unknown>
      const parts = STAT_ROWS.map((row) => {
        const v = s[row.key]
        return typeof v === "number" ? `${row.label} ${nf(v)}` : null
      }).filter((x): x is string => !!x)
      return `The database now holds — ${parts.join(", ")}.`
    }
  }
  if (typeof r === "string" && r) return r
  return "The server returned no detail beyond finishing."
}

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  if (m < 60) return `${m}m ${String(s).padStart(2, "0")}s`
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`
}
