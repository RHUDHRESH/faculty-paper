import { useEffect, useMemo, useRef, useState } from "react"
import { Link, useSearchParams } from "react-router-dom"
import { ArrowLeft, CalendarClock, ChevronDown, Download, Link2, Play, Save, Sparkles } from "lucide-react"

import { ApiError } from "@/lib/api"
import { exportTable, type ExportFormat } from "@/lib/table-export"
import { Button } from "@/ui/button"
import { Field, Select } from "@/ui/field"
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/ui/menu"
import { PageHeader } from "@/ui/page-header"
import { Callout, ErrorState, SkeletonRows } from "@/ui/state"
import { toast } from "@/ui/toast"
import { downloadReport, useDatasets, useRun, useRunSaved, useSave, useSavedReport, useTemplates } from "./data"
import { LiveLinkDialog, SaveDialog, ScheduleDialog, type SaveFields } from "./dialogs"
import {
  buildRunBody,
  describeResult,
  emptyDefinition,
  FILE_FORMATS,
  problemsWith,
  rowObjects,
  type Dataset,
  type Definition,
  type RunResult,
  type SavedReport,
} from "./model"
import { Block, StepHeading } from "./parts"
import { ColumnsPicker } from "./shape-columns"
import { FiltersEditor } from "./shape-filters"
import { GroupEditor, OrderEditor, PivotEditor, TotalsEditor } from "./shape-group"
import { StepResult } from "./step-result"

export type Seed = { definition: Definition; explanation: string }

type Which = "save" | "saveAs" | "schedule" | "link" | null

/**
 * The designer: three steps on one page. What the report is about, how it is
 * shaped, and the result, left to right on a desk and one under another on a
 * phone.
 *
 * A report is only made when the person presses Run report (and once, by
 * itself, when a saved report, a template or a plain-words answer is opened,
 * because they asked for that report by name). Editing never re-runs it: the
 * result says so when it is out of date.
 */
export function Designer({ savedId, templateKey, seed }: { savedId: string | null; templateKey: string | null; seed: Seed | null }) {
  const [, setParams] = useSearchParams()
  const datasetsQ = useDatasets()
  const [saved, setSaved] = useState<SavedReport | null>(null)
  // A report saved from this page is already here: do not ask for it again.
  const savedQ = useSavedReport(saved && saved.id === savedId ? null : savedId)
  const templatesQ = useTemplates(!!templateKey)
  const run = useRun()
  const runSaved = useRunSaved()
  const save = useSave()

  const [def, setDef] = useState<Definition>(() => seed?.definition ?? emptyDefinition())
  const [suggested, setSuggested] = useState("")
  const [result, setResult] = useState<RunResult | null>(null)
  const [ran, setRan] = useState<{ def: Definition; key: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [explanation] = useState(seed?.explanation ?? "")
  const [dialog, setDialog] = useState<Which>(null)
  const started = useRef<string | null>(null)
  const after = useRef<"schedule" | "link" | null>(null)
  const justSaved = useRef(false)
  const running = useRef(false)

  const datasets = datasetsQ.data
  const dataset: Dataset | undefined = datasets?.find((d) => d.key === def.dataset)
  const body = useMemo(() => buildRunBody(def, dataset), [def, dataset])
  const problems = problemsWith(def)

  async function runDef(d: Definition, viaSavedId?: string) {
    // One run per press: a second click while the first is still on its way
    // is the same question, and used to be asked of the server twice.
    if (running.current) return
    const list = problemsWith(d)
    if (list.length > 0) {
      setError(list[0])
      return
    }
    const ds = datasets?.find((x) => x.key === d.dataset)
    const sent = buildRunBody(d, ds)
    running.current = true
    setPending(true)
    setError(null)
    try {
      const r = viaSavedId ? await runSaved.mutateAsync(viaSavedId) : await run.mutateAsync(sent)
      setResult(r)
      setRan({ def: d, key: JSON.stringify(sent) })
    } catch (e) {
      // The server's own words ("Money columns are not open to heads of
      // department"), never a code.
      setError(e instanceof ApiError || e instanceof Error ? e.message : "The report could not be made. Please try again.")
    } finally {
      running.current = false
      setPending(false)
    }
  }

  // Open what was asked for, once: a saved report, a template or a plain-words answer.
  useEffect(() => {
    if (!datasets) return
    const mode = savedId ? `r:${savedId}` : templateKey ? `t:${templateKey}` : seed ? "seed" : "new"
    if (started.current === mode) return
    if (savedId) {
      if (saved?.id === savedId) {
        // Saved from this page: it is already here.
        started.current = mode
        return
      }
      if (!savedQ.data) return
      started.current = mode
      setSaved(savedQ.data)
      setDef(savedQ.data.definition)
      void runDef(savedQ.data.definition, savedQ.data.id)
    } else if (templateKey) {
      if (!templatesQ.data) return
      started.current = mode
      const t = templatesQ.data.find((x) => x.key === templateKey)
      if (!t) {
        setError("That template is not available any more. Start from another one, or from a blank report.")
        return
      }
      setSuggested(t.name)
      setDef(t.definition)
      void runDef(t.definition)
    } else if (seed) {
      started.current = mode
      void runDef(seed.definition)
    } else {
      started.current = mode
    }
    // `runDef` closes over the datasets, which are loaded by now.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [datasets, savedId, templateKey, savedQ.data, templatesQ.data])

  const change = (patch: Partial<Definition>) => setDef((d) => ({ ...d, ...patch }))

  function pickDataset(key: string) {
    const ds = datasets?.find((d) => d.key === key)
    if (!ds) return
    setDef({ ...emptyDefinition(key), columns: ds.fields.slice(0, 5).map((f) => f.key) })
    setResult(null)
    setRan(null)
    setError(null)
  }

  const title = saved?.name ?? (suggested || dataset?.label || "Report")
  const stale = !!ran && ran.key !== JSON.stringify(body)

  /* ---- file ---- */

  async function exportFile(format: ExportFormat | "print") {
    if (format === "print") {
      window.print()
      return
    }
    if (problems.length > 0) {
      toast.fail(null, problems[0])
      return
    }
    // The report on screen is the report asked for: when it is whole and the
    // report has not been changed since, the file is made from it, not from a
    // second run of the same query (the first export used to take as long as
    // running the report again).
    if (result && ran && !stale && !result.truncated) {
      const name = await exportTable({
        title,
        format,
        filename: title.replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "-") || "report",
        columns: result.columns.map((c) => ({
          key: c.key,
          label: c.label,
          kind: c.type === "money" ? "money" : c.type === "number" ? "number" : c.type === "date" ? "date" : "text",
        })),
        rows: rowObjects(result).map((r) =>
          result.columns.map((c) => {
            const v = r[c.key]
            return v == null || typeof v === "string" || typeof v === "number" || typeof v === "boolean" ? (v ?? null) : String(v)
          })
        ),
      })
      toast.ok(`Downloaded ${name}`)
      return
    }
    const name = await downloadReport(body, format, title)
    toast.ok(`Downloaded ${name}`)
  }

  /* ---- save ---- */

  async function doSave(fields: SaveFields, asCopy: boolean) {
    if (!def.dataset) throw new Error("Choose what the report is about first.")
    const one = await save.mutateAsync({
      id: !asCopy && saved?.mine ? saved.id : undefined,
      ...fields,
      definition: body,
    })
    setSaved(one)
    setParams({ r: one.id }, { replace: true })
    justSaved.current = true
    toast.ok(`Saved “${one.name}”`)
  }

  async function quickSave() {
    if (!saved) return
    try {
      await doSave({ name: saved.name, description: saved.description, visibility: saved.visibility }, false)
      justSaved.current = false
    } catch (e) {
      toast.fail(e, "The report could not be saved.")
    }
  }

  function closeSave(open: boolean) {
    if (open) return
    const next = justSaved.current ? after.current : null
    justSaved.current = false
    after.current = null
    setDialog(next)
  }

  /** Scheduling and live links belong to a saved report of your own. */
  function needSaved(next: "schedule" | "link") {
    if (saved?.mine) {
      setDialog(next)
      return
    }
    after.current = next
    setDialog(saved ? "saveAs" : "save")
  }

  const savingFirst = after.current !== null

  /* ---- what shows ---- */

  if (datasetsQ.isError) {
    return (
      <div className="page space-y-6">
        <PageHeader title="Report studio" />
        <ErrorState
          what="the report studio"
          message={datasetsQ.error instanceof Error ? datasetsQ.error.message : undefined}
          onRetry={() => void datasetsQ.refetch()}
        />
      </div>
    )
  }
  if (savedId && savedQ.isError) {
    return (
      <div className="page space-y-6">
        <PageHeader title="Report studio" />
        <ErrorState
          title="Could not open that report"
          message={savedQ.error instanceof Error ? savedQ.error.message : undefined}
          onRetry={false}
        />
        <Button asChild kind="default">
          <Link to="/reports/studio">Back to all reports</Link>
        </Button>
      </div>
    )
  }

  const summary = ran && result ? describeResult(ran.def, datasets?.find((d) => d.key === ran.def.dataset), result) : ""

  return (
    <div className="page space-y-6">
      <Link to="/reports/studio" className="inline-flex min-h-10 items-center gap-1.5 text-base text-fg-muted hover:text-fg">
        <ArrowLeft className="size-4" aria-hidden />
        All reports
      </Link>
      <PageHeader
        title={title}
        sub="Choose what it is about, shape it, then press Run report."
        action={
          <>
            <Button kind="default" onClick={() => (saved?.mine ? void quickSave() : setDialog("save"))} loading={save.isPending}>
              <Save />
              Save
            </Button>
            {saved && (
              <Button kind="default" onClick={() => setDialog("saveAs")}>
                Save as
              </Button>
            )}
            <Button kind="default" onClick={() => needSaved("schedule")}>
              <CalendarClock />
              Schedule
            </Button>
            <Menu>
              <MenuTrigger asChild>
                <Button kind="default">
                  <Download />
                  Download
                  <ChevronDown />
                </Button>
              </MenuTrigger>
              <MenuContent align="end">
                {FILE_FORMATS.map((f) => (
                  <MenuItem
                    key={f.key}
                    className="h-11 text-base"
                    onSelect={() => void exportFile(f.key).catch((e) => toast.fail(e, "Could not make the file. Try again."))}
                  >
                    {f.label}
                  </MenuItem>
                ))}
              </MenuContent>
            </Menu>
            <Button kind="default" onClick={() => needSaved("link")}>
              <Link2 />
              Get a live link
            </Button>
          </>
        }
      />

      {explanation && (
        <Callout tone="info" title="Here is how your question was understood">
          <span className="flex items-start gap-2">
            <Sparkles aria-hidden className="mt-0.5 size-4 shrink-0 text-accent" />
            <span>{explanation} Change anything you like in the steps below.</span>
          </span>
        </Callout>
      )}
      {saved && !saved.mine && (
        <Callout tone="info">
          {saved.owner ? `${saved.owner} shared this report with you.` : "This report was shared with you."} To change it, use Save as to make
          your own copy.
        </Callout>
      )}

      {datasetsQ.isLoading || (savedId && savedQ.isLoading) ? (
        <SkeletonRows rows={6} />
      ) : (
        <div className="grid grid-cols-[minmax(0,1fr)] gap-x-8 gap-y-10 lg:grid-cols-[minmax(0,21rem)_minmax(0,1fr)] min-[1700px]:grid-cols-[minmax(0,17rem)_minmax(0,23rem)_minmax(0,1fr)]">
          <section
            aria-labelledby="step-what"
            className="min-w-0 space-y-4 lg:col-start-1 lg:row-start-1 min-[1700px]:col-start-1"
          >
            <StepHeading n={1} id="step-what" title="What" sub="What is the report about?" />
            <Field label="The report is about">
              <Select value={def.dataset} onChange={(e) => pickDataset(e.target.value)}>
                {!def.dataset && <option value="">Choose one</option>}
                {(datasets ?? []).map((d) => (
                  <option key={d.key} value={d.key}>
                    {d.label}
                  </option>
                ))}
              </Select>
            </Field>
            {dataset?.description && <p className="text-base text-fg-muted">{dataset.description}</p>}
            {dataset && <p className="text-sm text-fg-muted">Choosing a different subject starts the report again.</p>}
          </section>

          <section
            aria-labelledby="step-shape"
            className="min-w-0 space-y-5 lg:col-start-1 lg:row-start-2 min-[1700px]:col-start-2 min-[1700px]:row-start-1"
          >
            <StepHeading n={2} id="step-shape" title="Shape" sub="Choose what to show and how to organise it." />
            {dataset ? (
              <>
                <Block title="Show me" hint="Tick the columns you want. Use the arrows to put them in order.">
                  <ColumnsPicker dataset={dataset} value={def.columns} onChange={(columns) => change({ columns })} />
                </Block>
                <Block title="Only where" hint="Leave rows out unless they meet your conditions.">
                  <FiltersEditor dataset={dataset} value={def.filters} onChange={(filters) => change({ filters })} />
                </Block>
                <Block title="Group by" hint="One row for each department, year or whatever you choose. Up to three.">
                  <GroupEditor dataset={dataset} def={def} change={change} off={!!def.pivot} />
                </Block>
                <Block title="Add up" hint="Work out a total, an average or a count for each group.">
                  <TotalsEditor dataset={dataset} def={def} change={change} off={!!def.pivot} />
                </Block>
                <Block title="Grid" hint="Put one thing down the side and another across the top.">
                  <PivotEditor dataset={dataset} def={def} change={change} />
                </Block>
                <Block title="Put in order" hint="Which rows come first, and how many to keep.">
                  <OrderEditor dataset={dataset} def={def} change={change} resultColumns={result?.columns ?? []} />
                </Block>
              </>
            ) : (
              <p className="text-base text-fg-muted">Choose what the report is about in step 1 and the choices appear here.</p>
            )}
            <div className="sticky bottom-0 z-10 -mx-2 border-t border-line bg-bg px-2 py-3">
              {problems.length > 0 && <p className="mb-2 text-sm text-fg-muted">{problems[0]}</p>}
              <Button kind="primary" size="lg" className="w-full" loading={pending} onClick={() => void runDef(def)}>
                <Play />
                Run report
              </Button>
            </div>
          </section>

          <section
            aria-labelledby="step-result"
            className="min-w-0 space-y-4 lg:col-start-2 lg:row-span-2 lg:row-start-1 min-[1700px]:col-start-3 min-[1700px]:row-span-1"
          >
            <StepHeading n={3} id="step-result" title="Result" sub="Your report, as a table you can read, change and download." />
            <StepResult
              result={result}
              summary={summary}
              pending={pending}
              error={error}
              stale={stale}
              title={title}
              onExport={exportFile}
            />
          </section>
        </div>
      )}

      <SaveDialog
        open={dialog === "save" || dialog === "saveAs"}
        onOpenChange={closeSave}
        title={dialog === "saveAs" ? "Save a copy of this report" : "Save this report"}
        note={savingFirst ? "Save the report first. Then you can go on." : undefined}
        initial={{
          name: dialog === "saveAs" && saved ? `${saved.name} (copy)` : (saved?.name ?? suggested),
          description: saved?.description ?? "",
          visibility: dialog === "saveAs" ? "private" : (saved?.visibility ?? "private"),
        }}
        onSave={(fields) => doSave(fields, dialog === "saveAs")}
      />
      {saved && <ScheduleDialog open={dialog === "schedule"} onOpenChange={(o) => !o && setDialog(null)} report={saved} />}
      {saved && <LiveLinkDialog open={dialog === "link"} onOpenChange={(o) => !o && setDialog(null)} report={saved} />}
    </div>
  )
}
