import { useState } from "react"
import { Link } from "react-router-dom"
import { Check, LoaderCircle } from "lucide-react"
import { useQueryClient } from "@tanstack/react-query"

import { useAuth, type Role } from "@/app/auth"
import { api } from "@/lib/api"
import { cn } from "@/lib/cn"
import { useApi } from "@/lib/query"
import { ChooseDesk } from "@/pages/admin-desks"
import { JournalListsImport } from "@/pages/journal-lists-import"
import { MediaImport } from "@/pages/media-import"
import { Button } from "@/ui/button"
import { PageHeader } from "@/ui/page-header"
import { Details } from "@/ui/section"
import { ErrorState, InlineError, Skeleton } from "@/ui/state"
import { Meta, SectionTitle } from "@/ui/text"
import { toast } from "@/ui/toast"

/**
 * Get the college running: what is left before people can sign in, in the
 * order it is done on a fresh install or after a move of host (docs/ux/29).
 *
 * The server (`/api/admin/start`) answers every step from what already exists,
 * so the list cannot be ticked by hand and cannot be wrong about the college.
 * The next step is the one primary button; every step is one click from the
 * page where it is done.
 */

export type StartStep = {
  key: string
  title: string
  state: "done" | "todo" | "working"
  fact: string
  to: string
  action: string
  required: boolean
  /** Only on the desks step: each empty desk and the role that holds it. */
  desks?: { role: Role; label: string }[]
}

export type Start = {
  steps: StartStep[]
  done: number
  total: number
  next: string | null
  complete: boolean
}

export const START_KEY = ["admin", "start"] as const

export function useStart(enabled = true) {
  return useApi<Start>(START_KEY, "/api/admin/start", {
    enabled,
    // A restore is running by itself; keep the line honest while it does.
    refetchInterval: (q) => (q.state.data?.steps.some((s) => s.state === "working") ? 3000 : false),
  })
}

function Marker({ step, n, next }: { step: StartStep; n: number; next: boolean }) {
  if (step.state === "done") {
    return (
      <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-full bg-positive-wash text-positive">
        <Check className="size-4" aria-hidden />
        <span className="sr-only">Done</span>
      </span>
    )
  }
  if (step.state === "working") {
    return (
      <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-full bg-accent-wash text-accent">
        <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" aria-hidden />
        <span className="sr-only">Working</span>
      </span>
    )
  }
  return (
    <span
      className={cn(
        "mt-0.5 grid size-7 shrink-0 place-items-center rounded-full text-sm font-medium tabular",
        next ? "bg-accent text-action-fg" : "bg-hover text-fg-muted"
      )}
    >
      {n}
    </span>
  )
}

/** The steps, one row each. The next required step carries the one primary button. */
export function StartList({ data, className }: { data: Start; className?: string }) {
  const required = data.steps.filter((s) => s.required)
  const optional = data.steps.filter((s) => !s.required)
  return (
    <div className={cn("space-y-8", className)}>
      <ol className="divide-y divide-line border-y border-line" aria-label="Steps, in order">
        {required.map((s, i) => (
          <StepRow key={s.key} step={s} n={i + 1} next={s.key === data.next} />
        ))}
      </ol>
      {optional.length > 0 && (
        <section aria-labelledby="start-also" className="space-y-1">
          <SectionTitle>
            <span id="start-also">Also</span>
          </SectionTitle>
          <ul className="divide-y divide-line border-y border-line">
            {optional.map((s) => (
              <StepRow key={s.key} step={s} n={0} next={false} />
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}

function StepRow({ step, n, next }: { step: StartStep; n: number; next: boolean }) {
  const done = step.state === "done"
  return (
    <li className="flex flex-wrap items-start gap-x-4 gap-y-3 py-4 sm:px-2" data-testid={`start-${step.key}`} data-state={step.state}>
      {n > 0 ? (
        <Marker step={step} n={n} next={next} />
      ) : (
        <span
          className={cn(
            "mt-0.5 grid size-7 shrink-0 place-items-center rounded-full",
            done ? "bg-positive-wash text-positive" : "bg-hover text-fg-subtle"
          )}
        >
          {done ? <Check className="size-4" aria-hidden /> : <span className="size-1.5 rounded-full bg-current" />}
          <span className="sr-only">{done ? "Done" : "Not done"}</span>
        </span>
      )}
      <div className="min-w-0 flex-1 basis-52">
        <p className={cn("text-base", next || !done ? "font-medium" : "text-fg-muted")}>{step.title}</p>
        <Meta className="mt-0.5 block text-pretty">{step.fact}</Meta>
      </div>
      {step.key === "desks" && !done && step.desks && step.desks.length > 0 ? (
        // One button per empty desk: search, press, done. Not a filtered list with nobody in it.
        <div className="flex flex-wrap gap-2 max-sm:ml-11">
          {step.desks.map((d, i) => (
            <ChooseDesk key={d.role} role={d.role} label={d.label} kind={next && i === 0 ? "primary" : "default"} />
          ))}
        </div>
      ) : step.key === "backup" && !done ? (
        <BackupButton primary={next} className="max-sm:ml-11" />
      ) : step.key === "files" ? (
        <FilesAction step={step} />
      ) : (
        <Button asChild size="sm" kind={next ? "primary" : done ? "quiet" : "default"} className="max-sm:ml-11">
          <Link to={step.to} aria-label={`${step.action}: ${step.title}`}>
            {step.action}
          </Link>
        </Button>
      )}
    </li>
  )
}

export function startSentence(d: Start): string {
  const left = d.total - d.done
  if (left <= 0) return "The college is running."
  return `${left === 1 ? "One step is" : `${left} steps are`} left before people can sign in.`
}

/** Takes the backup where the step is, and says when it is done, so the admin never leaves the list. */
function BackupButton({ primary, className }: { primary: boolean; className?: string }) {
  const qc = useQueryClient()
  const [busy, setBusy] = useState(false)
  async function run() {
    setBusy(true)
    try {
      const { job_id } = await api<{ job_id: string }>("/api/admin/backups", { method: "POST" })
      for (let i = 0; i < 100; i++) {
        await new Promise((r) => setTimeout(r, 2000))
        const job = await api<{ status: string }>(`/api/admin/jobs/${job_id}`)
        if (job.status === "done") break
        if (job.status === "failed") throw new Error("The backup failed. See the job log under Jobs.")
      }
      await qc.invalidateQueries({ queryKey: ["admin"] })
      toast.ok("Backup taken")
    } catch (err) {
      toast.fail(err, "The backup could not be taken")
    } finally {
      setBusy(false)
    }
  }
  return (
    <Button size="sm" kind={primary ? "primary" : "default"} disabled={busy} onClick={() => void run()} className={className}>
      {busy ? "Taking a backup" : "Take a backup"}
    </Button>
  )
}

/**
 * The photos and files step. The zip picker sits in the row while files are
 * missing, and behind "Add more" once they are here.
 *
 * It starts open when the files are missing and stays as it was when the upload
 * turns the step done: closing it then would take the result of the upload off
 * the page the moment it appeared.
 */
function FilesAction({ step }: { step: StartStep }) {
  const qc = useQueryClient()
  const done = step.state === "done"
  const [open, setOpen] = useState(!done)
  return (
    <>
      {done ? (
        <Button size="sm" kind="quiet" aria-expanded={open} onClick={() => setOpen((o) => !o)} className="max-sm:ml-11">
          {open ? "Hide" : step.action}
        </Button>
      ) : null}
      {open ? (
        <div className="w-full max-w-xl pl-11">
          <MediaImport onDone={() => void qc.invalidateQueries({ queryKey: ["admin"] })} />
        </div>
      ) : null}
    </>
  )
}

export function AdminStart() {
  const { me } = useAuth()
  const q = useStart(me?.role === "SUPER_ADMIN")
  if (me && me.role !== "SUPER_ADMIN") {
    return (
      <div className="page py-8">
        <ErrorState art="closed-gate" title="Not open to this account" message="Ask the super admin." />
      </div>
    )
  }
  const d = q.data
  return (
    <div className="page space-y-10">
      <PageHeader
        title="Get the college running"
        sub={d ? (d.complete ? "Every step is done." : `${d.done} of ${d.total} steps done.`) : undefined}
      />
      {q.isError ? (
        <InlineError message="Could not check what is left." onRetry={() => void q.refetch()} />
      ) : !d ? (
        <Skeleton className="h-72 w-full" />
      ) : (
        <StartList data={d} />
      )}
      {me?.role === "SUPER_ADMIN" ? (
        <section className="space-y-3" aria-labelledby="journal-lists-title">
          <SectionTitle id="journal-lists-title">Journal safety lists</SectionTitle>
          <p className="max-w-xl text-sm text-fg-muted">
            "Check a journal" can warn about journals Scopus has dropped and journals that fake websites copy. It needs
            these two lists to say so; until they are loaded it says unknown.
          </p>
          <div className="max-w-xl">
            <JournalListsImport />
          </div>
        </section>
      ) : null}
      <Details label="the steps for a new host">
        <ol className="list-decimal space-y-1.5 pl-5 text-sm text-fg-muted">
          <li>Deploy. The tables are built when it starts.</li>
          <li>Open the site and make the first administrator (Set up). Use an email that is not in the export.</li>
          <li>Imports, then Restore a previous installation. Choose the file and type RESTORE.</li>
          <li>Come back here and add the photos and files from the media zip, so faces and claim files appear.</li>
          <li>Each step turns done as the system sees it.</li>
        </ol>
      </Details>
    </div>
  )
}
