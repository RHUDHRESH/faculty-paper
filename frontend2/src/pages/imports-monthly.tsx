import { useId, useRef, useState } from "react"

import { api } from "@/lib/api"
import { Answer, type AnswerItem } from "@/ui/answer"
import { Button } from "@/ui/button"
import { Field } from "@/ui/field"
import { money } from "@/ui/paper"
import { Rows, Section } from "@/ui/section"
import { Callout, InlineError } from "@/ui/state"
import { Table, type Column } from "@/ui/table"
import { toast } from "@/ui/toast"

/**
 * The two files the office loads every month: the faculty list and the
 * settled claims. Each card is the same three steps. Choose the file, check
 * it (a dry run, nothing saved), then import it. The Import button stays off
 * until the file in hand has been checked, and choosing another file starts
 * the card again, so what is imported is always what was checked.
 *
 * The page that holds these cards is already behind the office's permission,
 * so the cards carry no second gate of their own.
 */

const nf = (n: number) => n.toLocaleString("en-IN")
const XLSX = ".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"

/** A count the server may send as a number or as the list itself. */
function countOf(v: unknown): number {
  if (typeof v === "number") return v
  if (Array.isArray(v)) return v.length
  return 0
}

/* ------------------------------------------------------------------------ */
/* The shared card                                                           */
/* ------------------------------------------------------------------------ */

type Phase = "idle" | "checking" | "checked" | "importing" | "imported"

/** What a card needs to say about one file and its result. */
type CardKind<R extends { dry_run: boolean }> = {
  title: string
  purpose: string
  fileLabel: string
  fileHint: string
  path: string
  /** Shown as a note under the card. */
  caution?: string
  /** The toast said once the import has gone through. */
  imported: string
  Result: (props: { result: R }) => React.ReactNode
}

function MonthlyCard<R extends { dry_run: boolean }>({ kind }: { kind: CardKind<R> }) {
  const [file, setFile] = useState<File | null>(null)
  const [phase, setPhase] = useState<Phase>("idle")
  const [result, setResult] = useState<R | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const titleId = useId()
  /** Counts the files chosen, so an answer for a file no longer in hand is dropped. */
  const generation = useRef(0)
  /** A second press while a request is out never starts a second request. */
  const inflight = useRef(false)

  const busy = phase === "checking" || phase === "importing"

  function pick(next: File | null) {
    generation.current += 1
    inflight.current = false
    setFile(next)
    setPhase("idle")
    setResult(null)
    setFailure(null)
  }

  async function run(dryRun: boolean) {
    if (!file || inflight.current) return
    inflight.current = true
    const mine = generation.current
    setPhase(dryRun ? "checking" : "importing")
    setFailure(null)
    try {
      const body = new FormData()
      body.append("file", file)
      body.append("dry_run", dryRun ? "true" : "false")
      // `api()`'s options type has no `body` (every other call is JSON), so
      // this widens it the way the other upload cards on this page do.
      const res = await api<R>(kind.path, { method: "POST", body } as unknown as Parameters<typeof api>[1])
      if (mine !== generation.current) return
      setResult(res)
      setPhase(dryRun ? "checked" : "imported")
      if (!dryRun) toast.ok(kind.imported)
    } catch (err) {
      if (mine !== generation.current) return
      // After a failed import the check still stands; after a failed check there is none.
      setPhase(dryRun ? "idle" : "checked")
      setFailure(err instanceof Error && err.message ? err.message : "The server did not answer.")
    } finally {
      if (mine === generation.current) inflight.current = false
    }
  }

  const reason =
    phase === "checking"
      ? "Checking."
      : phase === "importing"
        ? "Importing."
        : !file
          ? "Choose the file first."
          : phase === "imported"
            ? "Imported. Choose the next file to go again."
            : phase === "idle"
              ? "Check the file before importing it."
              : null

  return (
    <li className="py-5">
      <section aria-labelledby={titleId} className="space-y-4">
        <div>
          <h3 id={titleId} className="text-base font-medium">
            {kind.title}
          </h3>
          <p className="text-sm text-fg-muted">{kind.purpose}</p>
        </div>

        <div className="grid grid-cols-[minmax(0,1fr)] gap-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
          <Field label={kind.fileLabel} hint={kind.fileHint}>
            <input
              type="file"
              accept={XLSX}
              disabled={busy}
              onChange={(e) => pick(e.target.files?.[0] ?? null)}
              className="block w-full text-sm file:mr-3 file:rounded-md file:border file:border-line file:bg-surface file:px-3 file:py-1.5 file:text-sm disabled:opacity-50"
            />
          </Field>
          <div className="flex flex-wrap gap-2">
            <Button
              kind="default"
              disabled={!file || busy}
              loading={phase === "checking"}
              onClick={() => void run(true)}
            >
              Check the file
            </Button>
            <Button
              kind="primary"
              disabled={phase !== "checked"}
              loading={phase === "importing"}
              onClick={() => void run(false)}
            >
              Import
            </Button>
          </div>
        </div>
        {reason && <p className="text-sm text-fg-muted">{reason}</p>}

        {failure && <InlineError message={failure} />}

        {result && (
          <div className="space-y-5" role="status" aria-label={result.dry_run ? "Check result" : "Import result"}>
            <p className="font-medium">
              {result.dry_run ? "Checked. Nothing is saved yet." : "Imported. This is what was saved."}
            </p>
            <kind.Result result={result} />
          </div>
        )}

        {kind.caution && <Callout tone="caution">{kind.caution}</Callout>}
      </section>
    </li>
  )
}

/** A heading line and the table under it, left out when there is nothing to list. */
function Listing<T>({
  heading,
  id,
  rows,
  columns,
  getKey,
}: {
  heading: string
  id: string
  rows: T[]
  columns: Column<T>[]
  getKey: (row: T) => string
}) {
  if (rows.length === 0) return null
  return (
    <div className="space-y-2">
      <p className="text-sm font-medium">
        {heading} ({nf(rows.length)})
      </p>
      <Table
        rows={rows}
        columns={columns}
        getKey={getKey}
        caption={heading}
        tools={{ id: `imports-monthly-${id}`, title: heading }}
        maxHeight="20rem"
        minWidth="36rem"
      />
    </div>
  )
}

/* ------------------------------------------------------------------------ */
/* Faculty list                                                              */
/* ------------------------------------------------------------------------ */

export type FacultyListResult = {
  dry_run: boolean
  sheets: Record<string, { people: number }>
  counts: { created: number; updated: number; unchanged: number; conflicts: number; needs_email: number }
  created: { staff_id: string; name: string; email: string | null; faculty_type: string | null; department: string | null }[]
  updated_fields: Record<string, number>
  conflicts: { staff_id: string; name: string; field: string; current: string | null; incoming: string | null }[]
  needs_email: { staff_id: string; name: string }[]
  not_in_list?: number | unknown[]
  /**
   * One-time logins for the people a real import just created. Empty for a
   * check, and for any import that created nobody. Only ever held in memory:
   * it is never put on screen, and the card drops it when the file changes.
   */
  credentials?: NewLogin[]
}

export type NewLogin = { staff_id: string; name: string; email: string; password: string }

/** The guard the server puts on every export: a text cell starting with = + - @ (or a tab or return) runs as a formula in Excel. */
function safeCell(value: string): string {
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value
}

function csvField(value: string): string {
  const v = safeCell(value)
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v
}

export function loginsCsv(rows: NewLogin[]): string {
  const head = ["staff_id", "name", "email", "password"]
  const lines = [head, ...rows.map((r) => [r.staff_id, r.name, r.email, r.password])]
  return lines.map((line) => line.map(csvField).join(",")).join("\r\n") + "\r\n"
}

function todayStamp(): string {
  const d = new Date()
  const two = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`
}

/** Hands the file to the browser. The BOM is written in front so Excel reads names correctly. */
function downloadLogins(rows: NewLogin[]) {
  const blob = new Blob(["﻿", loginsCsv(rows)], { type: "text/csv;charset=utf-8" })
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = `faculty-new-logins-${todayStamp()}.csv`
  document.body.appendChild(a)
  a.click()
  a.remove()
  // Later, not now: some browsers start the download after the click returns.
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

/** The passwords are only ever written into the file, never into the page. */
function NewLogins({ logins }: { logins: NewLogin[] }) {
  const titleId = useId()
  return (
    <section aria-labelledby={titleId} className="space-y-2 rounded-md border border-line p-4">
      <h4 id={titleId} className="text-base font-medium">
        Logins for the {nf(logins.length)} new {logins.length === 1 ? "person" : "people"}
      </h4>
      <p className="text-sm text-fg-muted">These passwords are shown once. Save the file now.</p>
      <Button kind="primary" onClick={() => downloadLogins(logins)}>
        Download logins (CSV)
      </Button>
    </section>
  )
}

const FIELD_NAME: Record<string, string> = {
  designation: "designation",
  phone: "phone",
  scopus_author_id: "Scopus author ID",
  email: "email",
}

function FacultyListResultView({ result }: { result: FacultyListResult }) {
  const { counts } = result
  const done = !result.dry_run
  const figures: AnswerItem[] = [
    { value: counts.created, label: done ? "People added" : "People to add", zero: "No one new" },
    { value: counts.updated, label: done ? "People updated" : "People to update", zero: "No one to update" },
    {
      value: counts.conflicts,
      label: "Conflicts",
      zero: "No conflicts",
      tone: counts.conflicts > 0 ? "caution" : "neutral",
    },
    {
      value: counts.needs_email,
      label: "With no email",
      zero: "Everyone has an email",
      tone: counts.needs_email > 0 ? "caution" : "neutral",
    },
  ]
  const filled = Object.entries(result.updated_fields ?? {})
    .filter(([, n]) => countOf(n) > 0)
    .map(([k, n]) => `${FIELD_NAME[k] ?? k} ${nf(countOf(n))}`)
  const people = Object.entries(result.sheets ?? {}).map(([name, s]) => `${name} ${nf(s.people)}`)
  const notInList = countOf(result.not_in_list)
  const logins = result.credentials ?? []

  return (
    <>
      <Answer items={figures} />
      {done && logins.length > 0 && <NewLogins logins={logins} />}
      <div className="space-y-1 text-sm text-fg-muted">
        <p>{nf(counts.unchanged)} already up to date.</p>
        {filled.length > 0 && <p>Fields {done ? "filled" : "to fill"}: {filled.join(", ")}.</p>}
        {people.length > 0 && <p>People read, by sheet: {people.join(", ")}.</p>}
        {notInList > 0 && <p>{nf(notInList)} on the roster are not in this file. They are left as they are.</p>}
      </div>

      <Listing
        heading={done ? "People added" : "People to add"}
        id="faculty-add"
        rows={result.created}
        getKey={(p) => p.staff_id}
        columns={[
          { key: "staff", header: "Staff ID", cell: (p) => p.staff_id },
          { key: "name", header: "Name", cell: (p) => p.name },
          { key: "email", header: "Email", cell: (p) => p.email || null },
          { key: "type", header: "Type", cell: (p) => p.faculty_type || null },
          { key: "dept", header: "Department", cell: (p) => p.department || null },
        ]}
      />
      <Listing
        heading="Conflicts to look at"
        id="faculty-conflicts"
        rows={result.conflicts}
        getKey={(c) => `${c.staff_id}-${c.field}`}
        columns={[
          { key: "staff", header: "Staff ID", cell: (c) => c.staff_id },
          { key: "name", header: "Name", cell: (c) => c.name },
          { key: "field", header: "Field", cell: (c) => FIELD_NAME[c.field] ?? c.field },
          { key: "current", header: "Current", cell: (c) => c.current || null },
          { key: "incoming", header: "In the file", cell: (c) => c.incoming || null },
        ]}
      />
      <Listing
        heading="People with no email"
        id="faculty-no-email"
        rows={result.needs_email}
        getKey={(p) => p.staff_id}
        columns={[
          { key: "staff", header: "Staff ID", cell: (p) => p.staff_id },
          { key: "name", header: "Name", cell: (p) => p.name },
        ]}
      />
    </>
  )
}

const FACULTY_CARD: CardKind<FacultyListResult> = {
  title: "Faculty list",
  purpose: "Adds new people and fills what the roster is missing. A value that differs is listed, not changed.",
  fileLabel: "Faculty list workbook",
  fileHint: "The .xlsx, one sheet for each kind of staff.",
  path: "/api/admin/faculty-list/import",
  imported: "Imported",
  Result: FacultyListResultView,
}

/* ------------------------------------------------------------------------ */
/* Settled claims                                                            */
/* ------------------------------------------------------------------------ */

export type SettledClaimsResult = {
  dry_run: boolean
  rows: number
  counts: {
    already_recorded: number
    new: number
    amount_differs: number
    zero_amount: number
    unmatched_staff: number
    unparseable_amount: number
    doi_filled: number
  }
  new_total_amount: number
  by_month: { month: string; new: number; amount: number }[]
  amount_differs: {
    staff_id: string
    name: string
    title: string
    ledger_amount: number | null
    file_amount: number | null
    month: string
  }[]
  unmatched_staff: { staff_id: string; name: string }[]
}

function SettledClaimsResultView({ result }: { result: SettledClaimsResult }) {
  const { counts } = result
  const done = !result.dry_run
  const figures: AnswerItem[] = [
    { value: counts.new, label: done ? "Payments added" : "New payments", zero: "Nothing new" },
    { value: money(result.new_total_amount), label: done ? "Amount added" : "New amount" },
    { value: counts.already_recorded, label: "Already recorded" },
    {
      value: counts.amount_differs,
      label: "Amount differs",
      zero: "No amounts differ",
      tone: counts.amount_differs > 0 ? "caution" : "neutral",
    },
  ]
  const others = [
    counts.unmatched_staff > 0 && `${nf(counts.unmatched_staff)} staff not found`,
    counts.zero_amount > 0 && `${nf(counts.zero_amount)} with a zero amount`,
    counts.unparseable_amount > 0 && `${nf(counts.unparseable_amount)} with an amount that could not be read`,
    counts.doi_filled > 0 && `${nf(counts.doi_filled)} DOIs ${done ? "filled" : "to fill"}`,
  ].filter(Boolean)

  return (
    <>
      <Answer items={figures} />
      <div className="space-y-1 text-sm text-fg-muted">
        <p>{nf(result.rows)} rows read.</p>
        {others.length > 0 && <p>Also: {others.join(", ")}.</p>}
      </div>

      <Listing
        heading={done ? "Payments added by month" : "New payments by month"}
        id="claims-month"
        rows={result.by_month}
        getKey={(m) => m.month}
        columns={[
          { key: "month", header: "Month", cell: (m) => m.month },
          { key: "n", header: "Payments", align: "right", cell: (m) => nf(m.new) },
          {
            key: "amount",
            header: "Amount",
            align: "right",
            cell: (m) => money(m.amount),
            exportValue: (m) => m.amount,
            exportKind: "money",
          },
        ]}
      />
      <Listing
        heading="Amounts that differ"
        id="claims-differ"
        rows={result.amount_differs}
        getKey={(r) => `${r.staff_id}-${r.title}-${r.month}`}
        columns={[
          { key: "staff", header: "Staff", cell: (r) => `${r.name} (${r.staff_id})` },
          { key: "title", header: "Paper", truncate: true, className: "max-w-[18rem]", cell: (r) => r.title },
          {
            key: "ledger",
            header: "In the ledger",
            align: "right",
            cell: (r) => money(r.ledger_amount),
            exportValue: (r) => r.ledger_amount,
            exportKind: "money",
          },
          {
            key: "file",
            header: "In the file",
            align: "right",
            cell: (r) => money(r.file_amount),
            exportValue: (r) => r.file_amount,
            exportKind: "money",
          },
          { key: "month", header: "Month", cell: (r) => r.month },
        ]}
      />
      <Listing
        heading="Staff not found"
        id="claims-unmatched"
        rows={result.unmatched_staff}
        getKey={(p) => p.staff_id}
        columns={[
          { key: "staff", header: "Staff ID", cell: (p) => p.staff_id },
          { key: "name", header: "Name", cell: (p) => p.name },
        ]}
      />
    </>
  )
}

const CLAIMS_CARD: CardKind<SettledClaimsResult> = {
  title: "Settled claims",
  purpose: "Records payments already made, so the same paper is not paid twice.",
  fileLabel: "Settled claims workbook",
  fileHint: "The .xlsx, one row for each payment made.",
  path: "/api/admin/settled-claims/import",
  caution: "Amounts that differ are reported only; nothing already recorded is changed.",
  imported: "Imported",
  Result: SettledClaimsResultView,
}

/* ------------------------------------------------------------------------ */
/* The section                                                               */
/* ------------------------------------------------------------------------ */

export function MonthlyFiles() {
  return (
    <Section title="Monthly files">
      <Rows>
        <MonthlyCard kind={FACULTY_CARD} />
        <MonthlyCard kind={CLAIMS_CARD} />
      </Rows>
    </Section>
  )
}
