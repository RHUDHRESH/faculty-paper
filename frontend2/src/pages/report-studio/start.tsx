import { useState } from "react"
import { Link, useNavigate } from "react-router-dom"
import { ArrowRight, Copy, FilePlus2, Sparkles, Trash2 } from "lucide-react"

import { ApiError } from "@/lib/api"
import { Button } from "@/ui/button"
import { ConfirmDialog } from "@/ui/dialog"
import { Field, Textarea } from "@/ui/field"
import { PageHeader } from "@/ui/page-header"
import { Avatar } from "@/ui/person"
import { Section } from "@/ui/section"
import { InlineError, SkeletonRows } from "@/ui/state"
import { Table, type Column } from "@/ui/table"
import { toast } from "@/ui/toast"
import { Ago } from "@/ui/when"
import { useAsk, useDatasets, useDelete, useDuplicate, useSavedReports, useTemplates } from "./data"
import { describeSchedule, type SavedReport } from "./model"

const AI_OFF_KEY = "report-studio:ai-off"

/** The server said plain-words reports are not set up: remember, so the box stays away. */
function readAiOff(): boolean {
  try {
    return window.sessionStorage.getItem(AI_OFF_KEY) === "1"
  } catch {
    return false
  }
}

/**
 * Where the Report studio begins: a template to start from, the reports you
 * and your colleagues have saved, and a box to describe a report in plain
 * words. Every way in leads to the same designer.
 */
export function StudioStart() {
  return (
    <div className="page space-y-10">
      <PageHeader
        title="Report studio"
        sub="Make a report any way you like. Save it, send it on a schedule or open it in Excel."
        action={
          <Button asChild kind="primary" size="lg">
            <Link to="/reports/studio?new=1">
              <FilePlus2 />
              Start a blank report
            </Link>
          </Button>
        }
      />
      <AskBox />
      <Templates />
      <MyReports />
    </div>
  )
}

/* ------------------------------------------------------------------------ */
/* Ask in plain words                                                        */
/* ------------------------------------------------------------------------ */

function AskBox() {
  const navigate = useNavigate()
  const ask = useAsk()
  const [off, setOff] = useState(readAiOff)
  const [question, setQuestion] = useState("")
  const [error, setError] = useState<string | null>(null)

  if (off) return null

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    const q = question.trim()
    if (!q) {
      setError("Type what you want to know, in your own words.")
      return
    }
    setError(null)
    try {
      const answer = await ask.mutateAsync(q)
      navigate("/reports/studio?new=1", { state: { seed: answer } })
    } catch (err) {
      if (err instanceof ApiError && err.status === 501) {
        // Not set up on this server: take the box away rather than leave a button that cannot work.
        try {
          window.sessionStorage.setItem(AI_OFF_KEY, "1")
        } catch {
          // Not remembered; it will be asked again next visit.
        }
        setOff(true)
        return
      }
      setError(err instanceof Error ? err.message : "That did not work. Please try again.")
    }
  }

  return (
    <Section title="Ask in plain words" sub="Describe the report you want. You will see how it was understood, and you can change anything.">
      <form onSubmit={submit} className="max-w-3xl space-y-3">
        <Field label="What would you like to know?">
          <Textarea
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="For example: papers in Scopus journals last year, by department, with the total incentive paid"
          />
        </Field>
        {error && <InlineError message={error} />}
        <Button type="submit" kind="primary" loading={ask.isPending}>
          <Sparkles />
          Make my report
        </Button>
      </form>
    </Section>
  )
}

/* ------------------------------------------------------------------------ */
/* Templates                                                                 */
/* ------------------------------------------------------------------------ */

function Templates() {
  const q = useTemplates()
  return (
    <Section title="Start from a template" sub="A ready-made report. Open it, then change whatever you like.">
      {q.isLoading ? (
        <SkeletonRows rows={3} rowHeight={72} />
      ) : q.isError ? (
        <InlineError message={q.error instanceof Error ? q.error.message : "The templates could not be loaded."} onRetry={() => void q.refetch()} />
      ) : (q.data ?? []).length === 0 ? (
        <p className="text-base text-fg-muted">There are no templates yet. Start a blank report instead.</p>
      ) : (
        <ul className="grid grid-cols-[minmax(0,1fr)] gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {(q.data ?? []).map((t) => (
            <li key={t.key}>
              <Link
                to={`/reports/studio?t=${encodeURIComponent(t.key)}`}
                className="group flex h-full min-h-28 flex-col gap-1.5 rounded-xl border border-edge bg-surface p-4 hover:border-accent hover:bg-accent-wash"
              >
                <span className="text-lg font-semibold text-fg">{t.name}</span>
                {t.description && <span className="text-base text-fg-muted">{t.description}</span>}
                <span className="mt-auto inline-flex items-center gap-1.5 pt-2 text-base font-medium text-accent">
                  Open this report
                  <ArrowRight aria-hidden className="size-4" />
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Section>
  )
}

/* ------------------------------------------------------------------------ */
/* Saved reports                                                             */
/* ------------------------------------------------------------------------ */

function MyReports() {
  const saved = useSavedReports()
  const datasets = useDatasets()
  const duplicate = useDuplicate()
  const del = useDelete()
  const [deleting, setDeleting] = useState<SavedReport | null>(null)

  const aboutOf = (key: string) => datasets.data?.find((d) => d.key === key)?.label ?? key

  function columns(mine: boolean): Column<SavedReport>[] {
    return [
      {
        key: "name",
        header: "Name",
        label: "Name",
        cell: (r) => (
          <span className="block">
            <span className="block text-base font-medium">{r.name}</span>
            {r.description && <span className="block text-sm text-fg-muted">{r.description}</span>}
          </span>
        ),
      },
      { key: "dataset", header: "About", label: "About", cell: (r) => aboutOf(r.dataset) },
      {
        key: "last_run",
        header: "Last run",
        label: "Last run",
        empty: "Never run",
        cell: (r) => (r.last_run_at ? <Ago iso={r.last_run_at} /> : null),
      },
      {
        key: "owner",
        header: "Made by",
        label: "Made by",
        cell: (r) =>
          r.owner ? (
            <span className="inline-flex items-center gap-2">
              <Avatar person={{ name: r.owner, initials: "", photo_url: null }} size="xs" />
              {r.owner}
            </span>
          ) : null,
      },
      {
        key: "schedule",
        header: "Sent",
        label: "Sent",
        cell: (r) => describeSchedule(r.schedule),
      },
      {
        key: "actions",
        header: "Actions",
        label: "Actions",
        cell: (r) => (
          <span className="flex flex-wrap items-center gap-2">
            <Button asChild kind="default" size="sm">
              <Link to={`/reports/studio?r=${encodeURIComponent(r.id)}`} aria-label={`Open ${r.name}`}>
                Open
              </Link>
            </Button>
            <Button
              kind="default"
              size="sm"
              aria-label={`Duplicate ${r.name}`}
              loading={duplicate.isPending && duplicate.variables === r.id}
              onClick={() =>
                duplicate.mutate(r.id, {
                  onSuccess: () => toast.ok("Copy made. You will find it under My reports."),
                  onError: (e) => toast.fail(e, "The copy could not be made."),
                })
              }
            >
              <Copy />
              Duplicate
            </Button>
            {mine && (
              <Button kind="quiet" size="sm" aria-label={`Delete ${r.name}`} onClick={() => setDeleting(r)}>
                <Trash2 />
                Delete
              </Button>
            )}
          </span>
        ),
      },
    ]
  }

  if (saved.isLoading) {
    return (
      <Section title="My reports">
        <SkeletonRows rows={3} />
      </Section>
    )
  }
  if (saved.isError) {
    return (
      <Section title="My reports">
        <InlineError message={saved.error instanceof Error ? saved.error.message : "Your reports could not be loaded."} onRetry={() => void saved.refetch()} />
      </Section>
    )
  }

  const { mine, shared } = saved.data ?? { mine: [], shared: [] }

  return (
    <>
      <Section title="My reports">
        <Table<SavedReport>
          rows={mine}
          columns={columns(true)}
          getKey={(r) => r.id}
          rowLink={(r) => `/reports/studio?r=${encodeURIComponent(r.id)}`}
          caption="My reports"
          empty={{
            title: "You have not saved a report yet",
            message: "Start from a template above, or start a blank report. Press Save and it will be listed here.",
            size: "compact",
          }}
        />
      </Section>
      <Section title="Shared with me">
        <Table<SavedReport>
          rows={shared}
          columns={columns(false)}
          getKey={(r) => r.id}
          rowLink={(r) => `/reports/studio?r=${encodeURIComponent(r.id)}`}
          caption="Reports shared with me"
          empty={{
            title: "Nobody has shared a report with you yet",
            message: "When a colleague shares one, it will be listed here.",
            size: "compact",
          }}
        />
      </Section>

      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        title="Delete this report?"
        description={deleting ? `“${deleting.name}” will be deleted for good, and so will its schedule and its live link.` : ""}
        confirmLabel="Delete report"
        danger
        onConfirm={async () => {
          if (!deleting) return
          try {
            await del.mutateAsync(deleting.id)
            toast.ok(`Deleted “${deleting.name}”`)
          } catch (e) {
            toast.fail(e, "The report could not be deleted.")
          }
        }}
      />
    </>
  )
}

