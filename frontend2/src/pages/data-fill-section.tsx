import { useState } from "react"
import { Wrench } from "lucide-react"

import { api } from "@/lib/api"
import { useApi, queryClient } from "@/lib/query"
import { Button } from "@/ui/button"
import { ConfirmDialog } from "@/ui/dialog"
import { Details, Rows, Section } from "@/ui/section"
import { Callout, SkeletonRows } from "@/ui/state"
import { Table, type Column } from "@/ui/table"
import { Meta } from "@/ui/text"
import { toast } from "@/ui/toast"

import { count, plural } from "./admin-b-parts"

/**
 * Fill the gaps in the record from the college's own files (Super admin).
 *
 * Backed by core/api/data_fill.py. Every fix only fills what is blank or says
 * "Not Found"; a value that is there is never changed, and where the college's
 * files disagree with it the row is listed as a conflict instead. Money is
 * never touched. "Check" is a dry run and writes nothing; an apply is queued
 * as one job and this section follows it.
 */

type Conflict = { row: string; id: string; field: string; current: string; incoming: string }
type Last = {
  gap_rows: number
  rows: number
  unresolved: number
  conflict_count: number
  conflicts: Conflict[]
  reasons: Record<string, number>
  applied: boolean
  checked_at: string
  detail?: Record<string, unknown>
}
export type FillFix = {
  key: string
  label: string
  help: string
  kind: "write" | "derived" | "review"
  safe: boolean
  last: Last | null
}
export type FillTable = {
  fixes: FillFix[]
  checked_at: string | null
  after_deploy: { run_id: string; state: string } | null
}
type Job = { status: string; success?: boolean | null; result?: { text?: string; errors?: Record<string, string> } }

export const FILL_KEY = ["admin", "data-fill"]

export function DataFillSection() {
  const { data, isLoading, error, refetch } = useApi<FillTable>(FILL_KEY, "/api/admin/data-fill")
  const [checking, setChecking] = useState(false)
  const [working, setWorking] = useState<string | null>(null)
  const [asking, setAsking] = useState<{ key: string | null; label: string; n: number } | null>(null)

  const fixes = data?.fixes ?? []
  const writes = fixes.filter((f) => f.kind === "write" && f.safe)
  const waiting = writes.reduce((n, f) => n + (f.last?.rows ?? 0), 0)

  async function check() {
    setChecking(true)
    try {
      const fresh = await api<FillTable>("/api/admin/data-fill/check", { method: "POST" })
      queryClient.setQueryData(FILL_KEY, fresh)
      toast.ok("Checked. Nothing was changed")
    } catch (e) {
      toast.fail(e, "The check did not run")
    } finally {
      setChecking(false)
    }
  }

  async function apply(key: string | null) {
    setWorking(key ?? "all")
    try {
      const { job_id } = await api<{ job_id: string }>(
        `/api/admin/data-fill/apply${key ? `?key=${encodeURIComponent(key)}` : ""}`,
        { method: "POST" }
      )
      toast.ok("Filling. This page updates when it is done.")
      let last: Job | null = null
      for (let i = 0; i < 400; i++) {
        await new Promise((r) => setTimeout(r, 3000))
        last = await api<Job>(`/api/admin/jobs/${job_id}`)
        if (last.status === "done" || last.status === "failed") break
      }
      if (last?.status === "failed") toast.fail(null, "The fill failed. See the job log under Jobs.")
      else if (last?.status === "done") toast.ok(last.result?.text ?? "Filled")
      await check()
    } catch (e) {
      toast.fail(e, "The fill could not be queued")
    } finally {
      setWorking(null)
    }
  }

  const columns: Column<FillFix>[] = [
    {
      key: "fix",
      header: "Fix",
      exportValue: (f) => f.label,
      cell: (f) => (
        <span className="block">
          <span className="font-medium">{f.label}</span>
          <Meta className="block max-w-prose">{f.help}</Meta>
        </span>
      ),
    },
    {
      key: "rows",
      header: "Rows it would fill",
      align: "right",
      exportKind: "number",
      exportValue: (f) => f.last?.rows ?? "",
      cell: (f) => (f.last ? <span className="tabular">{count(f.last.rows)}</span> : <Meta>Not checked</Meta>),
    },
    {
      key: "left",
      header: "Left open",
      align: "right",
      exportKind: "number",
      exportValue: (f) => f.last?.unresolved ?? "",
      cell: (f) => (f.last ? <span className="tabular text-fg-muted">{count(f.last.unresolved)}</span> : null),
    },
    {
      key: "conflicts",
      header: "Differ from the files",
      align: "right",
      exportKind: "number",
      exportValue: (f) => f.last?.conflict_count ?? "",
      cell: (f) =>
        f.last ? (
          <span className={f.last.conflict_count ? "tabular text-caution" : "tabular text-fg-muted"}>
            {count(f.last.conflict_count)}
          </span>
        ) : null,
    },
    {
      key: "act",
      header: <span className="sr-only">Apply</span>,
      label: "Apply",
      cell: (f) =>
        f.kind === "write" ? (
          <Button
            kind="default"
            size="sm"
            disabled={working !== null || !f.last || f.last.rows === 0}
            onClick={() => setAsking({ key: f.key, label: f.label, n: f.last?.rows ?? 0 })}
          >
            <Wrench aria-hidden />
            {working === f.key ? "Working" : "Apply"}
          </Button>
        ) : (
          <Meta>{f.kind === "derived" ? "Used in reports as they are made" : "A person decides"}</Meta>
        ),
    },
  ]

  const conflicts = fixes.filter((f) => (f.last?.conflicts.length ?? 0) > 0)

  return (
    <Section
      id="data-fill"
      title="Fill the gaps"
      sub="Departments, designations, journals, quartiles and author matches the college's own files already answer. Only blank values are filled."
      className="space-y-4"
      action={
        <span className="flex flex-wrap gap-2">
          <Button kind="default" onClick={() => void check()} disabled={checking || working !== null}>
            {checking ? "Checking" : "Check what would be filled"}
          </Button>
          <Button
            kind="primary"
            disabled={working !== null || waiting === 0}
            onClick={() => setAsking({ key: null, label: "Apply all safe fixes", n: waiting })}
          >
            {working === "all" ? "Working" : "Apply all safe fixes"}
          </Button>
        </span>
      }
    >
      <ConfirmDialog
        open={asking !== null}
        onOpenChange={(o) => !o && setAsking(null)}
        title={asking ? `${asking.label}?` : ""}
        description={
          asking
            ? `This fills ${plural(asking.n, "record")} that are blank today. Nothing that is filled in is changed and no amount is touched. Each fix is written to the audit log with your name.`
            : ""
        }
        confirmLabel={asking?.key ? "Apply" : "Apply all"}
        onConfirm={async () => {
          if (asking) await apply(asking.key)
        }}
      />

      {isLoading ? (
        <SkeletonRows rows={5} />
      ) : error ? (
        <Callout tone="caution" title="The fixes could not be loaded">
          <Button kind="default" size="sm" onClick={() => void refetch()}>
            Try again
          </Button>
        </Callout>
      ) : (
        <>
          <p className="text-sm text-fg-muted">
            {data?.checked_at
              ? `Checked ${new Date(data.checked_at).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}. `
              : "Not checked yet. "}
            {data?.after_deploy
              ? data.after_deploy.state === "done"
                ? "The fills ran once after the last update. "
                : "The fills are queued to run once after the last update. "
              : ""}
            The college's imports run these fixes by themselves; this table is for what is left.
          </p>
          <Table
            rows={fixes}
            columns={columns}
            getKey={(f) => f.key}
            caption="Fixes that fill what the college's files already answer"
            maxHeight="none"
            tools={{ id: "data-fill", title: "Fill the gaps" }}
            empty={{ title: "No fixes", message: "There is nothing to fill." }}
          />
          {conflicts.length > 0 && (
            <Details label="where the files differ from the record (left as they are)" count={conflicts.length}>
              <div className="space-y-4">
                {conflicts.map((f) => (
                  <div key={f.key}>
                    <p className="text-sm font-medium">
                      {f.label} ({count(f.last?.conflict_count ?? 0)})
                    </p>
                    <Rows>
                      {f.last?.conflicts.slice(0, 10).map((c, i) => (
                        <li key={`${c.id}-${i}`} className="py-1.5 text-sm text-fg-muted">
                          {c.row}: {c.field} is {c.current || "blank"}, the files say {c.incoming}
                        </li>
                      ))}
                    </Rows>
                  </div>
                ))}
              </div>
            </Details>
          )}
        </>
      )}
    </Section>
  )
}
