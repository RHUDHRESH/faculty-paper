import { useEffect, useMemo, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Check, Pencil, Quote, RotateCcw, Trash2 } from "lucide-react"

import { api, ApiError } from "@/lib/api"
import { cn } from "@/lib/cn"
import { useApi } from "@/lib/query"
import { Button } from "@/ui/button"
import { Select as KitSelect, Textarea } from "@/ui/field"
import { toast } from "@/ui/toast"

/**
 * Review marks: what a reviewer marks on a claim's documents, shared by the
 * review workspace (which draws them on the PDF) and the applicant's fix view
 * (which lists them, read-only, after a send-back).
 *
 * Public surface, and nothing else is meant to be imported from here:
 *
 *   useMarks(claimId)                     the data and the writes
 *   <MarkList claimId />                  the marks as a list, grouped by document and page
 *   <MarkLayer claimId uploadId page scale />
 *                                         an overlay for one rendered PDF page
 *   composeSendBackReason(marks, list)    the send-back reason, as a numbered list
 *
 * What the server sends is already shaped for the reader (docs/ux/21 B): a
 * reviewer gets every mark with the author's name; the claimant gets only the
 * marks that went back to them, from "The college"; the Director and Finance
 * get none. Nothing here filters again, so a screen cannot leak by forgetting
 * to. `canMark` is false for anyone who may not add or change marks, and the
 * controls hide themselves rather than waiting for a refusal.
 *
 * Coordinates: a mark's `rect` is x, y, w, h as fractions (0 to 1) of the
 * page, origin top left. That is why the overlay needs no pixel size: it fills
 * the positioned box the viewer puts around one rendered page.
 */

/* ------------------------------------------------------------------------ */
/* Types                                                                     */
/* ------------------------------------------------------------------------ */

export type MarkKind = "ISSUE" | "OK" | "NOTE"
export type MarkAudience = "CLAIMANT" | "STAFF"
export type ChecklistKey =
  | "affiliation"
  | "author_position"
  | "sec_refs"
  | "indexing"
  | "quartile"
  | "duplicate"
  | "other"
/** open; fixed? (filed again, waiting for the reviewer to confirm); resolved. */
export type MarkState = "open" | "fixed?" | "resolved"

export type MarkRect = { x: number; y: number; w: number; h: number }

export type ReviewMark = {
  id: string
  claim_id: string
  /** Null for a checklist-only mark. */
  upload_id: string | null
  /** "SEC reference 14", "paper.pdf": what to call the document. */
  upload_label: string | null
  page: number | null
  rect: MarkRect | null
  quote: string
  kind: MarkKind
  audience: MarkAudience
  checklist_key: ChecklistKey | ""
  body: string
  /** The reviewer's name; "The college" for the claimant. */
  author_name: string | null
  created_at: string | null
  resolved_at: string | null
  sent_back_at: string | null
  resolved_in_resubmission: boolean
  state: MarkState
}

/** One row of the reviewer's checklist. Only issue and needs_info go back. */
export type ChecklistItem = {
  key: ChecklistKey
  status: "ok" | "issue" | "needs_info"
  note?: string
  /** Overrides the standard label for `key`. */
  label?: string
}

/** The workspace keeps its checklist as one entry per key. */
export type ChecklistState = Partial<
  Record<ChecklistKey, { status: ChecklistItem["status"]; note?: string }>
>

/** The checklist as the list `composeSendBackReason` reads. */
export function checklistItems(state: ChecklistState): ChecklistItem[] {
  return (Object.keys(state) as ChecklistKey[]).flatMap((key) => {
    const v = state[key]
    return v ? [{ key, status: v.status, note: v.note }] : []
  })
}

/** What went back to the claimant, as it stood when it was sent. */
export type SendBack = {
  id: string
  reason: string
  created_at: string
  marks: ReviewMark[]
  checklist: Required<Pick<ChecklistItem, "key" | "status" | "note" | "label">>[]
}

export type NewMark = {
  upload_id?: string | null
  page?: number | null
  rect?: MarkRect | null
  quote?: string
  kind: MarkKind
  /** Left out: the server picks by kind (Issue is for the claimant). */
  audience?: MarkAudience
  checklist_key?: ChecklistKey | ""
  body?: string
}

export type MarkPatch = Partial<Omit<NewMark, "upload_id">>

type MarksResponse = {
  results: ReviewMark[]
  viewer: "reviewer" | "claimant" | "blind"
  can_mark: boolean
  send_back: SendBack | null
}

const CHECKLIST_LABEL: Record<ChecklistKey, string> = {
  affiliation: "Affiliation",
  author_position: "Author position",
  sec_refs: "SEC references",
  indexing: "Indexing",
  quartile: "Quartile",
  duplicate: "Duplicate",
  other: "Other",
}

const KIND_LABEL: Record<MarkKind, string> = { ISSUE: "Issue", OK: "OK", NOTE: "Note" }
const AUDIENCE_LABEL: Record<MarkAudience, string> = {
  CLAIMANT: "For the claimant",
  STAFF: "Staff only",
}

/** Issue marks are for the claimant unless the reviewer says otherwise. */
function defaultAudience(kind: MarkKind): MarkAudience {
  return kind === "ISSUE" ? "CLAIMANT" : "STAFF"
}

/* ------------------------------------------------------------------------ */
/* Data                                                                      */
/* ------------------------------------------------------------------------ */

const marksKey = (claimId: string | undefined) => ["claim", claimId, "marks"] as const

/** Document order: by document, then page, then top to bottom. */
function byPlace(a: ReviewMark, b: ReviewMark): number {
  const doc = (a.upload_id ?? "").localeCompare(b.upload_id ?? "")
  if (doc) return doc
  const page = (a.page ?? 0) - (b.page ?? 0)
  if (page) return page
  const top = (a.rect?.y ?? 0) - (b.rect?.y ?? 0)
  if (top) return top
  return (a.created_at ?? "").localeCompare(b.created_at ?? "")
}

/**
 * The marks on one claim and the writes that change them.
 *
 * Without this each screen would fetch the list on its own, and the list
 * beside the PDF would go on showing a mark the overlay had just resolved.
 * Every screen that calls it with the same claim id shares one cache entry,
 * and every write refreshes it.
 *
 * `create`, `update`, `resolve`, `reopen` and `remove` are TanStack mutations:
 * call `.mutateAsync(...)` and catch, or read `.isPending` / `.error`.
 * `resolve` on a "fixed?" mark is the reviewer confirming the fix; `reopen`
 * is saying it was not fixed. `remove` works only on a mark that has not gone
 * to the claimant.
 */
export function useMarks(claimId: string | undefined) {
  const qc = useQueryClient()
  const query = useApi<MarksResponse>(marksKey(claimId), `/api/claims/${claimId}/marks`, {
    enabled: !!claimId,
  })
  const refresh = () => qc.invalidateQueries({ queryKey: marksKey(claimId) })

  const create = useMutation<ReviewMark, ApiError, NewMark>({
    mutationFn: (body) => api<ReviewMark>(`/api/claims/${claimId}/marks`, { method: "POST", json: body }),
    onSuccess: refresh,
  })
  const update = useMutation<ReviewMark, ApiError, { id: string } & MarkPatch>({
    mutationFn: ({ id, ...patch }) => api<ReviewMark>(`/api/marks/${id}`, { method: "PATCH", json: patch }),
    onSuccess: refresh,
  })
  const resolve = useMutation<ReviewMark, ApiError, string>({
    mutationFn: (id) => api<ReviewMark>(`/api/marks/${id}/resolve`, { method: "POST" }),
    onSuccess: refresh,
  })
  const reopen = useMutation<ReviewMark, ApiError, string>({
    mutationFn: (id) => api<ReviewMark>(`/api/marks/${id}/reopen`, { method: "POST" }),
    onSuccess: refresh,
  })
  const remove = useMutation<unknown, ApiError, string>({
    mutationFn: (id) => api(`/api/marks/${id}`, { method: "DELETE" }),
    onSuccess: refresh,
  })

  const marks = useMemo(() => [...(query.data?.results ?? [])].sort(byPlace), [query.data])
  return {
    marks,
    viewer: query.data?.viewer ?? null,
    canMark: !!query.data?.can_mark,
    sendBack: query.data?.send_back ?? null,
    isLoading: query.isLoading,
    error: query.error,
    refetch: query.refetch,
    create,
    update,
    resolve,
    reopen,
    remove,
  }
}

/* ------------------------------------------------------------------------ */
/* The send-back reason                                                      */
/* ------------------------------------------------------------------------ */

function tidy(text: string | null | undefined): string {
  return (text ?? "").replace(/\s+/g, " ").trim()
}

function asSentence(text: string): string {
  const t = tidy(text)
  if (!t) return ""
  return /[.!?]$/.test(t) ? t : `${t}.`
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text
}

function whereIs(mark: ReviewMark): string {
  if (mark.upload_label) return mark.page ? `${mark.upload_label}, page ${mark.page}` : mark.upload_label
  if (mark.checklist_key) return CHECKLIST_LABEL[mark.checklist_key]
  return ""
}

/**
 * The reason a claim is sent back with, written for the person who has to
 * fix it: polite, plain, one numbered line per thing to do.
 *
 * It takes the open issues meant for the claimant and the checklist items
 * that did not pass, and nothing else: staff-only marks, OK marks, notes and
 * resolved marks never appear, so what the reviewer sees pre-filled is what
 * the claimant reads. It names no desk and no person (docs/ux/19). Returns an
 * empty string when there is nothing to fix, so the caller can leave the box
 * empty rather than send a greeting with no list.
 *
 * The reviewer edits the result before sending; it is a starting point.
 */
export function composeSendBackReason(
  marks: readonly ReviewMark[],
  checklist: readonly ChecklistItem[] = []
): string {
  const lines: string[] = []
  const seen = new Set<string>()
  const add = (text: string) => {
    const line = asSentence(text)
    if (!line || seen.has(line.toLowerCase())) return
    seen.add(line.toLowerCase())
    lines.push(line)
  }

  for (const item of checklist) {
    if (item.status === "ok") continue
    const label = tidy(item.label) || CHECKLIST_LABEL[item.key] || CHECKLIST_LABEL.other
    const note = tidy(item.note)
    if (item.status === "needs_info") {
      add(`${label}: please tell us more${note ? `. ${asSentence(note)}` : ""}`)
    } else {
      add(`${label}: ${note || "please check and correct this"}`)
    }
  }

  const open = marks
    .filter((m) => m.kind === "ISSUE" && m.audience === "CLAIMANT" && !m.resolved_at)
    .sort(byPlace)
  for (const m of open) {
    const where = whereIs(m)
    const said = tidy(m.body) || "please check this"
    const quote = tidy(m.quote)
    add(
      `${where ? `${where}: ` : ""}${said}${quote ? ` (“${clip(quote, 120)}”)` : ""}`
    )
  }

  if (lines.length === 0) return ""
  return [
    "Thank you for your claim. Please fix the following and send it again.",
    "",
    ...lines.map((line, i) => `${i + 1}. ${line}`),
  ].join("\n")
}

/* ------------------------------------------------------------------------ */
/* The small form, shared by the list (edit) and the layer (new mark)        */
/* ------------------------------------------------------------------------ */

type FormValues = {
  kind: MarkKind
  audience: MarkAudience
  checklist_key: ChecklistKey | ""
  body: string
}


function Select<T extends string>({
  label,
  value,
  onChange,
  options,
}: {
  label: string
  value: T
  onChange: (v: T) => void
  options: readonly { value: T; label: string }[]
}) {
  return (
    <label className="block min-w-0 space-y-1">
      <span className="text-xs font-medium text-fg-muted">{label}</span>
      <KitSelect value={value} onChange={(e) => onChange(e.target.value as T)}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </KitSelect>
    </label>
  )
}

const KIND_OPTIONS = (Object.keys(KIND_LABEL) as MarkKind[]).map((k) => ({ value: k, label: KIND_LABEL[k] }))
const AUDIENCE_OPTIONS = (Object.keys(AUDIENCE_LABEL) as MarkAudience[]).map((a) => ({
  value: a,
  label: AUDIENCE_LABEL[a],
}))
const CHECKLIST_OPTIONS: readonly { value: ChecklistKey | ""; label: string }[] = [
  { value: "", label: "None" },
  ...(Object.keys(CHECKLIST_LABEL) as ChecklistKey[]).map((k) => ({ value: k, label: CHECKLIST_LABEL[k] })),
]

function MarkForm({
  initial,
  saving,
  error,
  saveLabel,
  onSave,
  onCancel,
}: {
  initial: FormValues
  saving: boolean
  error?: string | null
  saveLabel: string
  onSave: (v: FormValues) => void
  onCancel: () => void
}) {
  const [values, setValues] = useState(initial)
  // Changing the kind moves the audience to its default, until the reviewer
  // has chosen an audience themselves.
  const audienceTouched = useRef(initial.audience !== defaultAudience(initial.kind))
  const forClaimant = values.audience === "CLAIMANT" && values.kind === "ISSUE"
  const tooShort = forClaimant && tidy(values.body).length < 3

  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault()
        if (!tooShort && !saving) onSave(values)
      }}
    >
      <div className="grid grid-cols-[minmax(0,1fr)] gap-2 sm:grid-cols-2">
        <Select
          label="Kind"
          value={values.kind}
          options={KIND_OPTIONS}
          onChange={(kind) =>
            setValues((v) => ({
              ...v,
              kind,
              audience: audienceTouched.current ? v.audience : defaultAudience(kind),
            }))
          }
        />
        <Select
          label="Who sees it"
          value={values.audience}
          options={AUDIENCE_OPTIONS}
          onChange={(audience) => {
            audienceTouched.current = true
            setValues((v) => ({ ...v, audience }))
          }}
        />
      </div>
      <Select
        label="Checklist item"
        value={values.checklist_key}
        options={CHECKLIST_OPTIONS}
        onChange={(checklist_key) => setValues((v) => ({ ...v, checklist_key }))}
      />
      <label className="block space-y-1">
        <span className="text-xs font-medium text-fg-muted">
          {forClaimant ? "What should the claimant fix?" : "Note"}
        </span>
        <Textarea
          autoFocus
          rows={3}
          value={values.body}
          onChange={(e) => setValues((v) => ({ ...v, body: e.target.value }))}
          aria-label={forClaimant ? "What should the claimant fix?" : "Note"}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !tooShort && !saving) onSave(values)
          }}
        />
      </label>
      {forClaimant && (
        <p className="text-xs text-fg-muted">The claimant reads this exactly as written.</p>
      )}
      {error && (
        <p role="alert" className="text-xs text-critical">
          {error}
        </p>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" kind="quiet" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" kind="primary" size="sm" disabled={tooShort || saving}>
          {saveLabel}
        </Button>
      </div>
    </form>
  )
}

/* ------------------------------------------------------------------------ */
/* Look of a mark                                                            */
/* ------------------------------------------------------------------------ */

const KIND_CHIP: Record<MarkKind, string> = {
  ISSUE: "bg-critical-wash text-critical",
  OK: "bg-positive-wash text-positive",
  NOTE: "bg-hover text-fg-muted",
}

const RECT_TONE: Record<MarkKind, string> = {
  ISSUE: "border-critical bg-critical-wash/40",
  OK: "border-positive bg-positive-wash/40",
  NOTE: "border-fg-muted bg-hover/60",
}

function KindChip({ mark }: { mark: ReviewMark }) {
  return (
    <span
      className={cn(
        "inline-flex h-5 items-center rounded-full px-2 text-xs font-medium",
        KIND_CHIP[mark.kind]
      )}
    >
      {KIND_LABEL[mark.kind]}
    </span>
  )
}

/* ------------------------------------------------------------------------ */
/* <MarkList>                                                                */
/* ------------------------------------------------------------------------ */

/**
 * The marks on a claim as a list, grouped by document and then page, each
 * numbered as its box on the page is.
 *
 * `onJump(mark)` is called when a row is pressed; the workspace uses it to
 * open that document and scroll to that page. `activeId` highlights one row
 * (the one selected on the page). Reviewers who may mark at this stage get
 * Edit, Resolve and Reopen; the claimant gets the same list read-only, the
 * author shown as "The college", and no staff-only marks because the server
 * never sent them. A failed load is said to be a failed load, never an empty
 * list, so a reviewer cannot mistake an outage for "nothing to fix".
 */
export function MarkList({
  claimId,
  onJump,
  activeId,
  className,
}: {
  claimId: string
  onJump?: (mark: ReviewMark) => void
  activeId?: string | null
  className?: string
}) {
  const { marks, viewer, canMark, isLoading, error, update, resolve, reopen, remove } = useMarks(claimId)
  const [editing, setEditing] = useState<string | null>(null)

  const numbered = useMemo(() => marks.map((m, i) => ({ mark: m, n: i + 1 })), [marks])
  const groups = useMemo(() => {
    const out: { key: string; label: string; items: typeof numbered }[] = []
    for (const item of numbered) {
      const key = item.mark.upload_id ?? "checklist"
      let g = out.find((x) => x.key === key)
      if (!g) {
        g = { key, label: item.mark.upload_label ?? "Checklist", items: [] }
        out.push(g)
      }
      g.items.push(item)
    }
    return out
  }, [numbered])

  if (isLoading) {
    return (
      <div className={cn("space-y-2", className)} aria-busy="true">
        <div className="skeleton h-14 rounded-md" />
        <div className="skeleton h-14 rounded-md" />
      </div>
    )
  }
  if (error) {
    return (
      <p role="alert" className={cn("text-sm text-critical", className)}>
        Could not load the marks. Please try again.
      </p>
    )
  }
  if (viewer === "blind") return null
  if (marks.length === 0) {
    return (
      <p className={cn("text-sm text-fg-muted", className)}>
        {viewer === "claimant"
          ? "Nothing is marked on your documents."
          : canMark
            ? "No marks yet. Choose Mark, then drag over the document to add one."
            : "No marks yet."}
      </p>
    )
  }

  async function run(action: Promise<unknown>) {
    try {
      await action
    } catch (err) {
      toast.fail(err)
    }
  }

  return (
    <div className={cn("space-y-4", className)}>
      {groups.map((g) => (
        <section key={g.key} aria-label={g.label} className="space-y-1">
          <h3 className="text-sm font-semibold text-fg">{g.label}</h3>
          <ul className="divide-y divide-line">
            {g.items.map(({ mark: m, n }) => {
              const isEditing = editing === m.id
              const closed = m.state === "resolved"
              return (
                <li
                  key={m.id}
                  data-mark-id={m.id}
                  data-state={m.state}
                  className={cn("py-2", activeId === m.id && "bg-selected", closed && "opacity-60")}
                >
                  {isEditing ? (
                    <MarkForm
                      initial={{
                        kind: m.kind,
                        audience: m.audience,
                        checklist_key: m.checklist_key,
                        body: m.body,
                      }}
                      saving={update.isPending}
                      error={update.error?.message}
                      saveLabel="Save"
                      onCancel={() => setEditing(null)}
                      onSave={(v) =>
                        void run(update.mutateAsync({ id: m.id, ...v }).then(() => setEditing(null)))
                      }
                    />
                  ) : (
                    <>
                      <button
                        type="button"
                        onClick={() => onJump?.(m)}
                        className="flex w-full min-w-0 items-start gap-2 rounded-md px-1 text-left hover:bg-hover"
                        aria-label={`Mark ${n}: ${m.body || KIND_LABEL[m.kind]}`}
                      >
                        <span className="mt-0.5 inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-sunken text-xs tabular font-medium">
                          {n}
                        </span>
                        <span className="min-w-0 flex-1 space-y-1">
                          <span className="flex flex-wrap items-center gap-1.5">
                            <KindChip mark={m} />
                            {viewer === "reviewer" && (
                              <span className="text-xs text-fg-muted">{AUDIENCE_LABEL[m.audience]}</span>
                            )}
                            {m.page ? <span className="text-xs text-fg-muted">Page {m.page}</span> : null}
                            {m.checklist_key && (
                              <span className="text-xs text-fg-muted">{CHECKLIST_LABEL[m.checklist_key]}</span>
                            )}
                            {m.state === "fixed?" && (
                              <span className="rounded-full bg-caution-wash px-2 text-xs font-medium text-caution">
                                Fixed?
                              </span>
                            )}
                            {closed && <span className="text-xs text-fg-muted">Resolved</span>}
                          </span>
                          {m.quote && (
                            <span className="flex gap-1 text-sm text-fg-muted">
                              <Quote aria-hidden className="mt-0.5 size-3.5 shrink-0" />
                              <span className="min-w-0 break-words italic">{m.quote}</span>
                            </span>
                          )}
                          {m.body && <span className="block break-words text-sm">{m.body}</span>}
                          {m.author_name && (
                            <span className="block text-xs text-fg-subtle">{m.author_name}</span>
                          )}
                        </span>
                      </button>
                      {canMark && (
                        <div className="mt-1 flex flex-wrap gap-1 pl-8">
                          {m.state === "resolved" ? (
                            <Button kind="quiet" size="sm" onClick={() => void run(reopen.mutateAsync(m.id))}>
                              <RotateCcw aria-hidden /> Reopen
                            </Button>
                          ) : m.state === "fixed?" ? (
                            <>
                              <Button kind="default" size="sm" onClick={() => void run(resolve.mutateAsync(m.id))}>
                                <Check aria-hidden /> Confirm fixed
                              </Button>
                              <Button kind="quiet" size="sm" onClick={() => void run(reopen.mutateAsync(m.id))}>
                                <RotateCcw aria-hidden /> Not fixed
                              </Button>
                            </>
                          ) : (
                            <Button kind="quiet" size="sm" onClick={() => void run(resolve.mutateAsync(m.id))}>
                              <Check aria-hidden /> Resolve
                            </Button>
                          )}
                          <Button kind="quiet" size="sm" onClick={() => setEditing(m.id)}>
                            <Pencil aria-hidden /> Edit
                          </Button>
                          {!m.sent_back_at && (
                            <Button kind="quiet" size="sm" onClick={() => void run(remove.mutateAsync(m.id))}>
                              <Trash2 aria-hidden /> Delete
                            </Button>
                          )}
                        </div>
                      )}
                    </>
                  )}
                </li>
              )
            })}
          </ul>
        </section>
      ))}
    </div>
  )
}

/* ------------------------------------------------------------------------ */
/* <MarkLayer>                                                               */
/* ------------------------------------------------------------------------ */

/** Smaller than this (as a fraction of the page) is a click, not a region. */
const MIN_DRAG = 0.01

type Point = { x: number; y: number }
type Draft = { rect: MarkRect; clientX: number; clientY: number; quote: string }

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n))
}

function rectOf(a: Point, b: Point): MarkRect {
  const x = Math.min(a.x, b.x)
  const y = Math.min(a.y, b.y)
  return { x, y, w: Math.max(a.x, b.x) - x, h: Math.max(a.y, b.y) - y }
}

/**
 * An overlay for one rendered PDF page: the marks that sit on it, and a way
 * to add another by dragging over a region.
 *
 * Put it inside the box that wraps the rendered page (that box must be
 * `position: relative` and exactly the page's size); it fills the box. It
 * takes no pointer events except on the marks themselves, so text selection,
 * scrolling and the PDF's own controls keep working, until `drawMode` is on.
 *
 * With `drawMode`, dragging selects a region and opens a small form for the
 * kind, who sees it, the checklist item and the note. Saving adds the mark
 * and calls `onDrawModeChange(false)`; Cancel and Escape do the same without
 * adding. Drawing is ignored unless the reader may mark at this stage
 * (`canMark`), and never happens for the claimant.
 *
 * `scale` is the viewer's zoom (1 is 100%). Mark boxes are fractions of the
 * page so they stay put at any zoom; `scale` only keeps their number badges
 * readable, neither huge on a zoomed page nor unreadably small on a thumbnail.
 *
 * A mark that has a quote but no region is listed along the top edge of the
 * page instead, since there is no region to draw. `activeId` highlights one
 * mark (the row chosen in `MarkList`) and `onSelect` reports a press on one.
 */
export function MarkLayer({
  claimId,
  uploadId,
  page,
  scale = 1,
  drawMode = false,
  onDrawModeChange,
  activeId,
  onSelect,
}: {
  claimId: string
  uploadId: string
  page: number
  scale?: number
  drawMode?: boolean
  onDrawModeChange?: (on: boolean) => void
  activeId?: string | null
  onSelect?: (mark: ReviewMark) => void
}) {
  const { marks, canMark, create } = useMarks(claimId)
  const box = useRef<HTMLDivElement>(null)
  const [drag, setDrag] = useState<{ from: Point; to: Point } | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const drawing = drawMode && canMark

  // Numbers are the ones MarkList shows: position in the claim's whole list.
  const numberOf = useMemo(() => new Map(marks.map((m, i) => [m.id, i + 1])), [marks])
  const here = useMemo(
    () => marks.filter((m) => m.upload_id === uploadId && m.page === page),
    [marks, uploadId, page]
  )
  const boxes = here.filter((m) => m.rect)
  const quotes = here.filter((m) => !m.rect && m.quote)

  useEffect(() => {
    if (!drawing) {
      setDrag(null)
      setDraft(null)
    }
  }, [drawing])

  function at(e: React.PointerEvent): Point {
    const r = box.current!.getBoundingClientRect()
    return {
      x: r.width ? clamp01((e.clientX - r.left) / r.width) : 0,
      y: r.height ? clamp01((e.clientY - r.top) / r.height) : 0,
    }
  }

  function finish(e: React.PointerEvent) {
    if (!drag) return
    const rect = rectOf(drag.from, at(e))
    setDrag(null)
    if (rect.w < MIN_DRAG || rect.h < MIN_DRAG) return
    const quote = tidy(window.getSelection?.()?.toString())
    setDraft({ rect, clientX: e.clientX, clientY: e.clientY, quote: clip(quote, 500) })
  }

  async function save(v: FormValues) {
    if (!draft) return
    try {
      await create.mutateAsync({
        upload_id: uploadId,
        page,
        rect: draft.rect,
        quote: draft.quote,
        kind: v.kind,
        audience: v.audience,
        checklist_key: v.checklist_key,
        body: v.body,
      })
      setDraft(null)
      onDrawModeChange?.(false)
    } catch (err) {
      // The form stays open with the server's reason under it.
      if (!(err instanceof ApiError)) toast.fail(err)
    }
  }

  function cancel() {
    setDraft(null)
    create.reset()
    onDrawModeChange?.(false)
  }

  const live = drag ? rectOf(drag.from, drag.to) : null
  const badge = Math.round(Math.min(14, Math.max(10, 11 * scale)))

  return (
    <div
      ref={box}
      data-testid="mark-layer"
      data-drawing={drawing || undefined}
      className={cn(
        "absolute inset-0 z-10",
        drawing ? "cursor-crosshair touch-none" : "pointer-events-none"
      )}
      onPointerDown={(e) => {
        if (!drawing || draft || e.button > 0) return
        e.currentTarget.setPointerCapture?.(e.pointerId)
        const p = at(e)
        setDrag({ from: p, to: p })
      }}
      onPointerMove={(e) => {
        if (drag) setDrag({ from: drag.from, to: at(e) })
      }}
      onPointerUp={finish}
      onPointerCancel={() => setDrag(null)}
    >
      {quotes.length > 0 && (
        <div className="pointer-events-auto absolute left-1 top-1 flex max-w-[80%] flex-col gap-1">
          {quotes.map((m) => (
            <button
              key={m.id}
              type="button"
              title={m.body ? `${m.body}: “${m.quote}”` : m.quote}
              onClick={() => onSelect?.(m)}
              className={cn(
                "flex items-center gap-1 rounded-md border bg-surface px-1.5 py-0.5 text-left text-xs",
                RECT_TONE[m.kind].split(" ")[0],
                activeId === m.id && "ring-2 ring-accent"
              )}
            >
              <Quote aria-hidden className="size-3 shrink-0" />
              <span className="truncate">{clip(m.quote, 60)}</span>
            </button>
          ))}
        </div>
      )}

      {boxes.map((m) => {
        const r = m.rect!
        return (
          <button
            key={m.id}
            type="button"
            data-mark-id={m.id}
            aria-label={`Mark ${numberOf.get(m.id)}: ${m.body || KIND_LABEL[m.kind]}`}
            title={m.body || KIND_LABEL[m.kind]}
            onClick={(e) => {
              e.stopPropagation()
              onSelect?.(m)
            }}
            className={cn(
              "group pointer-events-auto absolute rounded-sm border-2 outline-none",
              "focus-visible:ring-2 focus-visible:ring-accent",
              RECT_TONE[m.kind],
              m.state === "resolved" && "border-dashed opacity-40",
              activeId === m.id && "ring-2 ring-accent"
            )}
            style={{
              left: `${r.x * 100}%`,
              top: `${r.y * 100}%`,
              width: `${r.w * 100}%`,
              height: `${r.h * 100}%`,
            }}
          >
            <span
              className="absolute -left-0.5 -top-2.5 inline-flex min-w-4 items-center justify-center rounded-full bg-fg px-1 font-medium text-bg tabular"
              style={{ fontSize: badge, lineHeight: 1.3 }}
            >
              {numberOf.get(m.id)}
            </span>
          </button>
        )
      })}

      {live && (
        <div
          data-testid="mark-drag"
          className="absolute rounded-sm border-2 border-dashed border-accent bg-accent-wash/40"
          style={{
            left: `${live.x * 100}%`,
            top: `${live.y * 100}%`,
            width: `${live.w * 100}%`,
            height: `${live.h * 100}%`,
          }}
        />
      )}
      {draft && !live && (
        <div
          className="absolute rounded-sm border-2 border-dashed border-accent bg-accent-wash/40"
          style={{
            left: `${draft.rect.x * 100}%`,
            top: `${draft.rect.y * 100}%`,
            width: `${draft.rect.w * 100}%`,
            height: `${draft.rect.h * 100}%`,
          }}
        />
      )}

      {draft &&
        createPortal(
          <DraftPopover draft={draft} onCancel={cancel}>
            <MarkForm
              initial={{ kind: "ISSUE", audience: "CLAIMANT", checklist_key: "", body: "" }}
              saving={create.isPending}
              error={create.error?.message}
              saveLabel="Add mark"
              onSave={(v) => void save(v)}
              onCancel={cancel}
            />
          </DraftPopover>,
          document.body
        )}
    </div>
  )
}

const POPOVER_W = 320
const POPOVER_H = 380

/** Beside the pointer, kept on screen; a bottom sheet on a phone. */
function DraftPopover({
  draft,
  onCancel,
  children,
}: {
  draft: Draft
  onCancel: () => void
  children: React.ReactNode
}) {
  const vw = typeof window === "undefined" ? 1280 : window.innerWidth
  const vh = typeof window === "undefined" ? 800 : window.innerHeight
  const narrow = vw < 640
  const width = Math.min(POPOVER_W, vw - 16)
  const style: React.CSSProperties = narrow
    ? { left: 8, right: 8, bottom: 8 }
    : {
        width,
        left: Math.max(8, Math.min(draft.clientX + 12, vw - width - 8)),
        top: Math.max(8, Math.min(draft.clientY + 12, vh - POPOVER_H - 8)),
      }
  return (
    <div
      role="dialog"
      aria-label="Add a mark"
      className="fixed z-50 max-h-[90vh] overflow-y-auto rounded-lg bg-surface p-3 shadow-pop ring-1 ring-inset ring-edge"
      style={style}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation()
          onCancel()
        }
      }}
    >
      {children}
    </div>
  )
}
