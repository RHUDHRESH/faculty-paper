import { useEffect, useMemo, useRef, useState } from "react"
import { Link } from "react-router-dom"
import { toast } from "sonner"
import {
  BadgeCheck,
  BookOpen,
  CircleAlert,
  FileCheck2,
  IdCard,
  Search,
  Sparkles,
  Users,
} from "lucide-react"

import { useAuth } from "@/components/auth-provider"
import { Money } from "@/components/ticket-ui"
import { StickyActions } from "@/components/layout/page"
import {
  Callout,
  ChoiceCards,
  DateField,
  Field,
  FieldGrid,
  FieldSpan,
  FileDropzone,
  NumberStepper,
  ReadOnlyField,
  SegmentedControl,
  TagInput,
} from "@/components/form/fields"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { API_BASE, api, ensureCsrf, type Claim } from "@/lib/api"
import { cn } from "@/lib/utils"
import {
  ANNEXURE_LEVELS,
  applyEnrichment,
  buildClaimPayload,
  CLAIM_REASONS,
  claimToFormState,
  DESIGNATIONS,
  formatIssn,
  formStateFromFacultyOption,
  formStateFromUser,
  INDEXING_LEVELS,
  isIssnComplete,
  isLikelyDoi,
  joinRefNumbers,
  normalizeDoiInput,
  parseRefNumbers,
  PUBLICATION_TYPES,
  QUARTILE_OPTIONS,
  validateStep,
  type ClaimReason,
  type EnrichResult,
  type FieldErrors,
  type PublicationFormState,
  type UploadedFileRef,
} from "@/lib/claim-fields"

type FacultyOption = {
  owner_id?: string | null
  master_id?: string | null
  name: string
  email?: string | null
  department?: string | null
  staff_id?: string | null
  biometric_id?: string | null
  designation?: string | null
  scopus_author_url?: string | null
  has_user_account?: boolean
}

const STEPS = [
  { title: "Identity", blurb: "Who is claiming", Icon: IdCard },
  { title: "Publication", blurb: "Article and journal", Icon: BookOpen },
  { title: "Claim", blurb: "Authors and metrics", Icon: Users },
  { title: "Evidence", blurb: "Proof documents", Icon: FileCheck2 },
  { title: "Review", blurb: "Confirm and submit", Icon: BadgeCheck },
]

async function uploadPdf(file: File): Promise<UploadedFileRef> {
  const fd = new FormData()
  fd.append("file", file)
  const csrf = await ensureCsrf()
  const res = await fetch(`${API_BASE}/api/claims/upload`, {
    method: "POST",
    credentials: "include",
    headers: { "X-CSRFToken": csrf },
    body: fd,
  })
  if (!res.ok) {
    let msg = "Upload failed"
    try {
      const err = await res.json()
      msg = err.detail || msg
    } catch {
      /* ignore */
    }
    throw new Error(msg)
  }
  const data = await res.json()
  return {
    url: data.url as string,
    filename: (data.filename as string) || file.name,
    size_bytes: (data.size_bytes as number) ?? file.size,
  }
}

/* ------------------------------------------------------------------ */

function StepRail({
  current,
  furthest,
  errorSteps,
  onJump,
}: {
  current: number
  furthest: number
  errorSteps: Set<number>
  onJump: (i: number) => void
}) {
  return (
    <ol className="flex gap-1.5 overflow-x-auto pb-1" aria-label="Progress">
      {STEPS.map((s, i) => {
        const active = i === current
        const done = i < furthest && !errorSteps.has(i)
        const bad = errorSteps.has(i) && i < furthest
        const reachable = i <= furthest
        return (
          <li key={s.title} className="min-w-0 flex-1">
            <button
              type="button"
              disabled={!reachable}
              aria-current={active ? "step" : undefined}
              onClick={() => reachable && onJump(i)}
              className={cn(
                "group flex w-full items-center gap-2.5 rounded-xl border px-3 py-2.5 text-left transition-all outline-none",
                "focus-visible:ring-3 focus-visible:ring-ring/30",
                active
                  ? "border-primary/60 bg-surface-brand"
                  : reachable
                    ? "border-border bg-card hover:border-primary/35"
                    : "cursor-not-allowed border-dashed border-border bg-transparent opacity-55"
              )}
            >
              <span
                className={cn(
                  "flex size-7 shrink-0 items-center justify-center rounded-lg text-xs font-semibold tabular-nums transition-colors",
                  bad
                    ? "bg-destructive/15 text-destructive"
                    : active
                      ? "bg-primary text-primary-foreground"
                      : done
                        ? "bg-success/15 text-success"
                        : "bg-muted text-muted-foreground"
                )}
              >
                {bad ? (
                  <CircleAlert className="size-3.5" />
                ) : done ? (
                  <BadgeCheck className="size-3.5" />
                ) : (
                  i + 1
                )}
              </span>
              <span className="hidden min-w-0 sm:block">
                <span className="block truncate text-xs font-semibold text-foreground">
                  {s.title}
                </span>
                <span className="block truncate text-[11px] text-muted-foreground">{s.blurb}</span>
              </span>
            </button>
          </li>
        )
      })}
    </ol>
  )
}

const STEP_HEADING_ID = "wizard-step-heading"

/** Field keys whose rendered control uses a different element id. */
const ERROR_TARGET_ID: Record<string, string> = {
  proof_files: "proof-upload",
  sec_proof_files: "sec-proof-upload",
  affiliation_ok: "affiliation-ok",
}

/**
 * Named list of everything wrong on this step, linked to each field.
 * Inline errors alone leave a keyboard or screen-reader user hunting for what
 * blocked them; this is the pattern GOV.UK and USWDS both specify.
 */
function ErrorSummary({
  errors,
  stepTitle,
}: {
  errors: Record<string, string | undefined>
  stepTitle: string
}) {
  const entries = Object.entries(errors).filter(([, v]) => !!v) as [string, string][]
  const ref = useRef<HTMLDivElement>(null)
  const count = entries.length

  useEffect(() => {
    if (count) ref.current?.focus()
  }, [count])

  if (!count) return null

  return (
    <div
      ref={ref}
      tabIndex={-1}
      role="alert"
      className="mb-5 rounded-xl border border-destructive/40 bg-surface-danger/50 px-4 py-3.5 outline-none focus-visible:ring-3 focus-visible:ring-destructive/30"
    >
      <h2 className="text-sm font-semibold text-destructive">
        {count === 1
          ? `One thing to fix on ${stepTitle}`
          : `${count} things to fix on ${stepTitle}`}
      </h2>
      <ul className="mt-2 space-y-1 text-sm text-foreground">
        {entries.map(([key, message]) => (
          <li key={key}>
            <a
              href={`#${ERROR_TARGET_ID[key] || key}`}
              className="underline underline-offset-2 hover:no-underline"
              onClick={(e) => {
                e.preventDefault()
                const el = document.getElementById(ERROR_TARGET_ID[key] || key)
                el?.scrollIntoView({ block: "center" })
                el?.focus()
              }}
            >
              {message}
            </a>
          </li>
        ))}
      </ul>
    </div>
  )
}

function StepCard({
  step,
  children,
  aside,
}: {
  step: (typeof STEPS)[number]
  children: React.ReactNode
  aside?: React.ReactNode
}) {
  return (
    <section className="overflow-hidden rounded-2xl border border-border bg-card">
      <header className="flex items-center gap-3 border-b border-border bg-muted/40 px-5 py-3.5">
        <span className="flex size-9 items-center justify-center rounded-xl bg-surface-brand text-primary">
          <step.Icon className="size-4.5" />
        </span>
        <div className="min-w-0">
          {/* Focus target on step change — tabIndex -1 keeps it out of the tab
              order while letting us move focus here programmatically. */}
          <h2
            id={STEP_HEADING_ID}
            tabIndex={-1}
            className="text-sm font-semibold text-foreground outline-none"
          >
            {step.title}
          </h2>
          <p className="text-xs text-muted-foreground">{step.blurb}</p>
        </div>
      </header>
      <div className="space-y-5 p-5">
        {aside}
        {children}
      </div>
    </section>
  )
}

/* ------------------------------------------------------------------ */

export function PublicationForm({
  mode,
  claimId,
  onSuccess,
}: {
  mode: "faculty" | "admin"
  claimId?: string | null
  onSuccess?: (claim: Claim) => void
}) {
  const { user } = useAuth()
  const [step, setStep] = useState(0)
  const [furthest, setFurthest] = useState(0)
  const [showErrors, setShowErrors] = useState<Record<number, boolean>>({})
  const [form, setForm] = useState<PublicationFormState>(() =>
    user ? formStateFromUser(user) : formStateFromUser({})
  )
  const [facultyOptions, setFacultyOptions] = useState<FacultyOption[]>([])
  const [facultyQuery, setFacultyQuery] = useState("")
  const [busy, setBusy] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [calc, setCalc] = useState<{ remuneration?: number | null; error?: string | null } | null>(
    null
  )
  const [enriching, setEnriching] = useState(false)
  const [filledLabels, setFilledLabels] = useState<string[]>([])
  const lastSuccess = useRef({ doi: "", title: "", issn: "" })
  const formRef = useRef(form)
  formRef.current = form
  const [sendAnywayOpen, setSendAnywayOpen] = useState(false)
  const [sendNote, setSendNote] = useState("")
  const [blockReason, setBlockReason] = useState("")
  const [successOpen, setSuccessOpen] = useState(false)
  const [issuedTicket, setIssuedTicket] = useState<string | null>(null)
  const [issuedId, setIssuedId] = useState<string | null>(null)
  const [issuedAmount, setIssuedAmount] = useState<number | null>(null)

  useEffect(() => {
    if (mode === "faculty" && user) setForm(formStateFromUser(user))
  }, [mode, user])

  // Move focus to the new step's heading. Without this the panel swaps while
  // focus stays on the Continue button, so nothing announces the change and the
  // next Tab carries on from the old position.
  // Compare against the previous step rather than a mounted flag: StrictMode
  // double-invokes effects in development, which would defeat a one-shot guard
  // and steal focus on first paint.
  const prevStep = useRef(step)
  useEffect(() => {
    if (prevStep.current === step) return
    prevStep.current = step
    document.getElementById(STEP_HEADING_ID)?.focus()
  }, [step])

  useEffect(() => {
    if (!claimId) return
    api<Claim>(`/api/claims/${claimId}`)
      .then((c) => {
        setForm(claimToFormState(c))
        setFurthest(STEPS.length - 1)
      })
      .catch(() => toast.error("Could not load ticket"))
  }, [claimId])

  useEffect(() => {
    if (mode !== "admin") return
    const q = facultyQuery.trim()
    const t = setTimeout(() => {
      api<FacultyOption[]>(`/api/admin/faculty-options${q ? `?q=${encodeURIComponent(q)}` : ""}`)
        .then(setFacultyOptions)
        .catch(() => setFacultyOptions([]))
    }, 200)
    return () => clearTimeout(t)
  }, [mode, facultyQuery])

  const errors: FieldErrors = useMemo(() => validateStep(step, form), [step, form])
  const visibleErrors: FieldErrors = showErrors[step] ? errors : {}

  const errorSteps = useMemo(() => {
    const s = new Set<number>()
    for (let i = 0; i < 4; i++) {
      if (Object.keys(validateStep(i, form)).length) s.add(i)
    }
    return s
  }, [form])

  const countOnly = form.claim_reason === "COUNT_ONLY"

  function set<K extends keyof PublicationFormState>(key: K, value: PublicationFormState[K]) {
    setForm((f) => ({ ...f, [key]: value }))
  }

  async function recalc(next?: Partial<PublicationFormState>) {
    const f = { ...form, ...next }
    if (f.claim_reason === "COUNT_ONLY") {
      setCalc({ remuneration: 0 })
      return
    }
    try {
      const c = await api<{ remuneration?: number | null; error?: string | null }>(
        "/api/calculate",
        {
          method: "POST",
          json: {
            snip: f.snip === "" ? null : Number(f.snip),
            quartile: f.quartile || f.self_reported_quartile || null,
            total_authors: f.total_authors,
            author_position: f.author_position,
            publication_type: f.aggregation_type || f.publication_type,
          },
        }
      )
      setCalc(c)
    } catch {
      /* estimate is advisory */
    }
  }

  async function quietFill(
    explicit = false,
    snapshot?: PublicationFormState
  ): Promise<PublicationFormState> {
    const current = snapshot ?? formRef.current
    const doi = normalizeDoiInput(current.doi)
    const title = current.paper_title.trim()
    const issn = formatIssn(current.issn)
    const canLookup = isLikelyDoi(doi) || title.length >= 12 || isIssnComplete(issn)
    if (!canLookup) return current

    if (!explicit) {
      const seen =
        (isLikelyDoi(doi) && lastSuccess.current.doi === doi) ||
        (title.length >= 12 && lastSuccess.current.title === title) ||
        (isIssnComplete(issn) && lastSuccess.current.issn === issn)
      if (seen) return current
    }

    if (explicit) setEnriching(true)
    try {
      const res = await api<EnrichResult>("/api/lookup/enrich", {
        method: "POST",
        json: {
          doi: isLikelyDoi(doi) ? doi : null,
          title: title || null,
          issn: isIssnComplete(issn) ? issn : null,
        },
      })
      if (!res.ok) {
        if (explicit) toast.info("No matching record found — fill the details manually")
        return current
      }
      const { form: next, filled } = applyEnrichment(current, res, { overwrite: explicit })
      lastSuccess.current = {
        doi: next.doi || doi,
        title: next.paper_title || title,
        issn: next.issn || issn,
      }
      setForm(next)
      setFilledLabels(filled)
      if (explicit) {
        toast.success(
          filled.length
            ? `Filled ${filled.join(", ")} from the indexing record`
            : "Indexing record matches what you already entered"
        )
      }
      await recalc(next)
      return next
    } catch {
      if (explicit) toast.error("Lookup unavailable right now")
      return current
    } finally {
      if (explicit) setEnriching(false)
    }
  }

  async function handleUpload(
    field: "proof_files" | "sec_proof_files",
    incoming: File[],
    max: number
  ) {
    setUploading(true)
    try {
      const room = max - form[field].length
      const uploaded: UploadedFileRef[] = []
      for (const file of incoming.slice(0, Math.max(0, room))) {
        uploaded.push(await uploadPdf(file))
      }
      if (uploaded.length) {
        setForm((f) => ({ ...f, [field]: [...f[field], ...uploaded] }))
        toast.success(uploaded.length > 1 ? `${uploaded.length} files uploaded` : "File uploaded")
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Upload failed")
    } finally {
      setUploading(false)
    }
  }

  function goNext() {
    if (Object.keys(errors).length) {
      setShowErrors((s) => ({ ...s, [step]: true }))
      toast.error("Fix the highlighted fields to continue")
      return
    }
    const next = Math.min(step + 1, STEPS.length - 1)
    setStep(next)
    setFurthest((f) => Math.max(f, next))
  }

  async function save(submit: boolean, sendAnyway = false) {
    if (submit && !sendAnyway) {
      const blocked = [0, 1, 2, 3].find((s) => Object.keys(validateStep(s, form)).length)
      if (blocked !== undefined) {
        setShowErrors({ 0: true, 1: true, 2: true, 3: true })
        setStep(blocked)
        toast.error("Some required details are missing")
        return
      }
    }
    if (!form.paper_title.trim()) {
      toast.error("Enter the paper title")
      return
    }
    if (mode === "admin" && !form.owner_id) {
      toast.error("Select a faculty member")
      return
    }
    setBusy(true)
    try {
      const latest = submit && !sendAnyway ? await quietFill(false, form) : form
      const payload = buildClaimPayload(latest, {
        submit,
        contest_forward: sendAnyway,
        contest_note: sendNote,
        owner_id: mode === "admin" ? latest.owner_id : undefined,
      })
      const claim = claimId
        ? await api<Claim>(`/api/claims/${claimId}`, { method: "PATCH", json: payload })
        : await api<Claim>("/api/claims", { method: "POST", json: payload })

      if (submit && claim.ticket_number) {
        setIssuedTicket(claim.ticket_number)
        setIssuedId(claim.id)
        setIssuedAmount(claim.remuneration ?? calc?.remuneration ?? null)
        setSuccessOpen(true)
        setSendAnywayOpen(false)
        toast.success("Submitted")
        onSuccess?.(claim)
      } else if (!submit) {
        toast.success("Draft saved")
        onSuccess?.(claim)
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : "Submit failed"
      if (submit && !sendAnyway && /auto-confirm|send with a short note|Could not/i.test(message)) {
        setBlockReason(message)
        setSendAnywayOpen(true)
      } else {
        toast.error(message)
      }
    } finally {
      setBusy(false)
    }
  }

  /* ---------------- step 0 — identity ---------------- */

  const identityStep = (
    <StepCard
      step={STEPS[0]}
      aside={
        <Callout tone="warning" title="Your Biometric ID decides where the money lands">
          It is read from the faculty master record and cannot be edited here. If it is wrong or
          missing, get it corrected with the research cell before you submit — a wrong ID pays the
          wrong account.
        </Callout>
      }
    >
      {mode === "admin" ? (
        <div className="space-y-2 rounded-xl border border-border bg-muted/40 p-3.5">
          <Label htmlFor="faculty-search" className="text-sm font-medium">
            Submitting on behalf of
          </Label>
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              id="faculty-search"
              className="h-9 pl-9"
              placeholder="Search by name, staff ID, or email"
              value={facultyQuery}
              onChange={(e) => setFacultyQuery(e.target.value)}
            />
          </div>
          <div className="max-h-52 space-y-1 overflow-y-auto">
            {facultyOptions.length === 0 ? (
              <p className="px-1 py-3 text-sm text-muted-foreground">No matches</p>
            ) : (
              facultyOptions.map((opt) => {
                const selected = form.owner_id && form.owner_id === opt.owner_id
                return (
                  <button
                    key={`${opt.owner_id || opt.master_id}`}
                    type="button"
                    className={cn(
                      "flex w-full flex-col rounded-lg border px-3 py-2 text-left transition-colors",
                      selected
                        ? "border-primary/60 bg-surface-brand"
                        : "border-transparent hover:bg-card"
                    )}
                    onClick={() => {
                      setForm(formStateFromFacultyOption(opt))
                      if (!opt.has_user_account) {
                        toast.warning("No login account — create the user before submitting")
                      }
                    }}
                  >
                    <span className="text-sm font-medium">{opt.name}</span>
                    <span className="text-xs text-muted-foreground">
                      {opt.staff_id} · {opt.department || "—"}
                      {opt.has_user_account ? "" : " · no account"}
                    </span>
                  </button>
                )
              })
            )}
          </div>
        </div>
      ) : null}

      <FieldGrid>
        <FieldSpan>
          <ReadOnlyField label="Email" value={form.email} />
        </FieldSpan>

        <Field
          label="Faculty name"
          htmlFor="faculty_name"
          required
          error={visibleErrors.faculty_name}
        >
          <Input
            id="faculty_name"
            className="h-9"
            autoComplete="name"
            value={form.faculty_name}
            readOnly={mode === "faculty"}
            aria-invalid={!!visibleErrors.faculty_name}
            onChange={(e) => set("faculty_name", e.target.value)}
          />
        </Field>

        <ReadOnlyField
          label="Department"
          value={form.department}
          error={visibleErrors.department}
          hint="Set from your staff record — it decides which HoD approves this ticket."
        />

        <ReadOnlyField label="Staff ID" value={form.staff_id} mono />

        <ReadOnlyField
          label="Biometric ID"
          value={form.biometric_id}
          mono
          error={visibleErrors.biometric_id}
          hint="Linked to your bank account for disbursement."
        />

        <FieldSpan>
          <Field
            label="Designation"
            required
            error={visibleErrors.designation}
            hint="Saved to your profile when you submit."
          >
            <ChoiceCards
              name="Designation"
              columns={2}
              value={form.designation}
              onChange={(v) => set("designation", v)}
              options={DESIGNATIONS.map((d) => ({ value: d, label: d }))}
            />
          </Field>
        </FieldSpan>

        <FieldSpan>
          <Field
            label="Author Scopus link"
            htmlFor="scopus_author_url"
            required
            error={visibleErrors.scopus_author_url}
            hint="Your personal Scopus Author Profile. The article must already be indexed and linked to this profile."
          >
            <Input
              id="scopus_author_url"
              className="h-9"
              inputMode="url"
              autoComplete="url"
              placeholder="https://www.scopus.com/authid/detail.uri?authorId=…"
              value={form.scopus_author_url}
              aria-invalid={!!visibleErrors.scopus_author_url}
              onChange={(e) => set("scopus_author_url", e.target.value)}
            />
          </Field>
        </FieldSpan>
      </FieldGrid>
    </StepCard>
  )

  /* ---------------- step 1 — publication ---------------- */

  const needsIndexingRef = ANNEXURE_LEVELS.includes(form.indexing_level)

  const publicationStep = (
    <StepCard step={STEPS[1]}>
      {filledLabels.length ? (
        <Callout tone="success" title="Filled from the indexing record">
          {filledLabels.join(" · ")}. You can still edit anything that looks wrong.
        </Callout>
      ) : (
        <Callout tone="info" title="Paste a DOI or the paper title, then leave the field">
          Journal, ISSN, date, SNIP, and quartile fill in automatically when the article is in
          Scopus. Use Autofill if you want to overwrite what is already there.
        </Callout>
      )}
      <FieldGrid>
        <FieldSpan>
          <Field
            label="Title of the paper"
            htmlFor="paper_title"
            required
            error={visibleErrors.paper_title}
            action={
              <Button
                type="button"
                variant="ghost"
                size="xs"
                disabled={
                  enriching ||
                  (!form.paper_title.trim() && !isLikelyDoi(form.doi) && !isIssnComplete(form.issn))
                }
                onClick={() => quietFill(true)}
              >
                <Sparkles />
                {enriching ? "Looking up…" : "Autofill from index"}
              </Button>
            }
          >
            <Textarea
              id="paper_title"
              rows={2}
              className="resize-none"
              value={form.paper_title}
              aria-invalid={!!visibleErrors.paper_title}
              onChange={(e) => set("paper_title", e.target.value)}
              onBlur={(e) => quietFill(false, { ...formRef.current, paper_title: e.target.value })}
            />
          </Field>
        </FieldSpan>

        <FieldSpan>
          <Field
            label="Journal name"
            htmlFor="journal_title"
            required
            error={visibleErrors.journal_title}
          >
            <Input
              id="journal_title"
              className="h-9"
              value={form.journal_title}
              aria-invalid={!!visibleErrors.journal_title}
              onChange={(e) => set("journal_title", e.target.value)}
            />
          </Field>
        </FieldSpan>

        <FieldSpan>
          <Field
            label="Publication type"
            required
            error={visibleErrors.publication_type}
          >
            <ChoiceCards
              name="Publication type"
              columns={2}
              value={form.publication_type}
              onChange={(v) => {
                set("publication_type", v)
                set("aggregation_type", v)
                recalc({ publication_type: v, aggregation_type: v })
              }}
              options={PUBLICATION_TYPES.map((t) => ({ value: t.value, label: t.label }))}
            />
          </Field>
        </FieldSpan>

        <FieldSpan>
          <Field
            label="Journal indexing level"
            required
            error={visibleErrors.indexing_level}
          >
            <ChoiceCards
              name="Journal indexing level"
              columns={2}
              value={form.indexing_level}
              onChange={(v) => set("indexing_level", v)}
              options={INDEXING_LEVELS.map((l) => ({
                value: l.value,
                label: l.label,
                description: l.hint,
              }))}
            />
          </Field>
        </FieldSpan>

        {needsIndexingRef ? (
          <FieldSpan>
            <Field
              label={`${form.indexing_level} reference number`}
              htmlFor="indexing_ref"
              required
              error={visibleErrors.indexing_ref}
              hint="Enter NA if the journal has no reference number."
            >
              <Input
                id="indexing_ref"
                className="h-9"
                placeholder="Ref no or NA"
                value={form.indexing_ref}
                aria-invalid={!!visibleErrors.indexing_ref}
                onChange={(e) => set("indexing_ref", e.target.value)}
              />
            </Field>
          </FieldSpan>
        ) : null}

        <Field
          label="ISSN"
          htmlFor="issn"
          required
          error={visibleErrors.issn}
          hint="Format 1234-567X — fills journal, SNIP, and quartile on its own if you only have this."
        >
          <Input
            id="issn"
            className="h-9 font-mono tabular-nums"
            placeholder="1234-567X"
            value={form.issn}
            aria-invalid={!!visibleErrors.issn}
            onChange={(e) => set("issn", formatIssn(e.target.value))}
            onBlur={(e) => {
              const issn = formatIssn(e.target.value)
              if (isIssnComplete(issn)) quietFill(false, { ...formRef.current, issn })
            }}
          />
        </Field>

        <Field
          label="Date of publication"
          htmlFor="publication_date"
          required
          error={visibleErrors.publication_date}
        >
          <DateField
            id="publication_date"
            value={form.publication_date}
            invalid={!!visibleErrors.publication_date}
            onChange={(iso) => set("publication_date", iso)}
          />
        </Field>

        <Field
          label="Yukthi ID"
          htmlFor="yukthi_id"
          required
          error={visibleErrors.yukthi_id}
        >
          <Input
            id="yukthi_id"
            className="h-9"
            value={form.yukthi_id}
            aria-invalid={!!visibleErrors.yukthi_id}
            onChange={(e) => set("yukthi_id", e.target.value)}
          />
        </Field>

        <Field
          label="DOI"
          htmlFor="doi"
          hint="Best starting point. Paste a doi.org link — it is cleaned automatically."
        >
          <Input
            id="doi"
            className="h-9 font-mono"
            placeholder="10.1000/xyz123"
            value={form.doi}
            onChange={(e) => set("doi", normalizeDoiInput(e.target.value))}
            onBlur={(e) => {
              const doi = normalizeDoiInput(e.target.value)
              if (isLikelyDoi(doi)) quietFill(false, { ...formRef.current, doi })
            }}
          />
        </Field>

        <FieldSpan>
          <Field
            label="Subject category"
            htmlFor="subject_category"
            hint="Optional — as listed by the indexing database."
          >
            <Input
              id="subject_category"
              className="h-9"
              value={form.subject_category}
              onChange={(e) => set("subject_category", e.target.value)}
            />
          </Field>
        </FieldSpan>
      </FieldGrid>
    </StepCard>
  )

  /* ---------------- step 2 — claim, authors, metrics ---------------- */

  const claimStep = (
    <StepCard step={STEPS[2]}>
      <Field label="Claim reason" required error={visibleErrors.claim_reason}>
        <ChoiceCards
          name="Claim reason"
          value={form.claim_reason}
          onChange={(v) => {
            const reason = v as ClaimReason
            setForm((f) => ({
              ...f,
              claim_reason: reason,
              snip: reason === "COUNT_ONLY" ? "0" : f.snip === "0" ? "" : f.snip,
              // Must flip back too. Leaving it true after switching to Option A
              // made the formula pay zero with nothing on screen explaining why.
              is_student_publication: reason === "COUNT_ONLY",
            }))
            recalc({ claim_reason: reason })
          }}
          options={CLAIM_REASONS}
        />
      </Field>

      {countOnly ? (
        <Callout tone="info" title="No incentive will be paid for this article">
          SNIP is locked to 0 because the article is going to Final Year Student Project
          Reimbursement. The ticket still runs through approval so the publication is counted.
        </Callout>
      ) : null}

      <FieldGrid>
        <Field label="Total number of authors" required error={visibleErrors.total_authors}>
          <NumberStepper
            ariaLabel="Total number of authors"
            value={form.total_authors}
            min={1}
            max={50}
            onChange={(n) => {
              setForm((f) => ({
                ...f,
                total_authors: n,
                author_position: Math.min(f.author_position, n),
              }))
              recalc({ total_authors: n })
            }}
          />
        </Field>

        <Field
          label="Your author position"
          required
          error={visibleErrors.author_position}
          hint={`1 = first author, ${form.total_authors} = last author`}
        >
          <NumberStepper
            ariaLabel="Your author position"
            value={form.author_position}
            min={1}
            max={form.total_authors}
            onChange={(n) => {
              set("author_position", n)
              recalc({ author_position: n })
            }}
          />
        </Field>

        <FieldSpan>
          <Field label="Journal quartile" required error={visibleErrors.quartile}>
            <SegmentedControl
              ariaLabel="Journal quartile"
              value={form.self_reported_quartile || form.quartile}
              onChange={(v) => {
                setForm((f) => ({ ...f, self_reported_quartile: v, quartile: v }))
                recalc({ quartile: v })
              }}
              options={QUARTILE_OPTIONS.map((q) => ({ value: q, label: q }))}
            />
          </Field>
        </FieldSpan>

        <Field
          label="SNIP"
          htmlFor="snip"
          required={!countOnly}
          error={visibleErrors.snip}
          hint={
            countOnly
              ? "Locked to 0 for a count-only submission."
              : "Source Normalized Impact per Paper."
          }
        >
          <Input
            id="snip"
            className="h-9 tabular-nums"
            inputMode="decimal"
            disabled={countOnly}
            value={form.snip}
            aria-invalid={!!visibleErrors.snip}
            onChange={(e) => set("snip", e.target.value)}
            onBlur={() => recalc()}
          />
        </Field>

        <Field label="Impact factor" htmlFor="impact_factor" error={visibleErrors.impact_factor}>
          <Input
            id="impact_factor"
            className="h-9 tabular-nums"
            inputMode="decimal"
            value={form.impact_factor}
            aria-invalid={!!visibleErrors.impact_factor}
            onChange={(e) => set("impact_factor", e.target.value)}
          />
        </Field>
      </FieldGrid>

      {!countOnly && calc?.remuneration != null ? (
        <div className="flex items-center justify-between rounded-xl border border-primary/25 bg-surface-brand px-4 py-3">
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Estimated incentive
            </p>
            <p className="text-xs text-muted-foreground">
              Indicative only — Finance confirms the final amount.
            </p>
          </div>
          <p className="text-2xl font-semibold tabular-nums text-primary">
            <Money value={calc.remuneration} />
          </p>
        </div>
      ) : null}
      {calc?.error ? <Callout tone="warning">{calc.error}</Callout> : null}
    </StepCard>
  )

  /* ---------------- step 3 — evidence ---------------- */

  const evidenceStep = (
    <StepCard
      step={STEPS[3]}
      aside={
        <Callout tone="info" title="What the research cell checks">
          The full-length published paper, and the papers behind the SEC-affiliated references you
          cite. Every file must be a PDF under 10 MB.
        </Callout>
      }
    >
      <div className="space-y-5">
        <Field
          label="Full-length published paper"
          required
          error={visibleErrors.proof_files}
          hint="One PDF of the published article."
        >
          <FileDropzone
            id="proof-upload"
            files={form.proof_files}
            max={1}
            busy={uploading}
            invalid={!!visibleErrors.proof_files}
            onAdd={(files) => handleUpload("proof_files", files, 1)}
            onRemove={(url) =>
              set(
                "proof_files",
                form.proof_files.filter((f) => f.url !== url)
              )
            }
          />
        </Field>

        <Field
          label="Reference numbers cited with SEC affiliation"
          required
          error={visibleErrors.sec_refs}
          hint="The reference numbers as they appear in your manuscript's reference list. Press Enter or comma after each."
        >
          <TagInput
            id="sec_refs"
            numericOnly
            placeholder="14, 15, 57"
            invalid={!!visibleErrors.sec_refs}
            value={parseRefNumbers(form.sec_refs)}
            onChange={(tags) => set("sec_refs", joinRefNumbers(tags))}
          />
        </Field>

        <Field
          label="Reference articles cited with SEC affiliation"
          htmlFor="reference_articles"
          hint="List the cited articles authored by Saveetha Engineering College faculty, one per line."
        >
          <Textarea
            id="reference_articles"
            rows={3}
            className="resize-y"
            value={form.reference_articles}
            onChange={(e) => set("reference_articles", e.target.value)}
          />
        </Field>

        <Field
          label="Reference papers with SEC affiliation"
          required
          error={visibleErrors.sec_proof_files}
          hint="Up to 5 PDFs. At least two cited references authored by SEC faculty are expected."
        >
          <FileDropzone
            id="sec-proof-upload"
            files={form.sec_proof_files}
            max={5}
            busy={uploading}
            invalid={!!visibleErrors.sec_proof_files}
            onAdd={(files) => handleUpload("sec_proof_files", files, 5)}
            onRemove={(url) =>
              set(
                "sec_proof_files",
                form.sec_proof_files.filter((f) => f.url !== url)
              )
            }
          />
        </Field>

        <div
          className={cn(
            "flex items-center justify-between gap-4 rounded-xl border px-4 py-3",
            visibleErrors.affiliation_ok
              ? "border-destructive/50 bg-surface-danger/50"
              : "border-border bg-muted/40"
          )}
        >
          <div className="min-w-0">
            <Label htmlFor="affiliation-ok" className="text-sm font-medium">
              Affiliation is listed as Saveetha Engineering College
            </Label>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Required. The institutional affiliation printed on the article must read exactly that.
            </p>
            {visibleErrors.affiliation_ok ? (
              <p role="alert" className="mt-1 text-xs font-medium text-destructive">
                {visibleErrors.affiliation_ok}
              </p>
            ) : null}
          </div>
          <Switch
            id="affiliation-ok"
            checked={form.affiliation_ok}
            onCheckedChange={(v) => set("affiliation_ok", v)}
          />
        </div>
      </div>
    </StepCard>
  )

  /* ---------------- step 4 — review ---------------- */

  const reviewRows: { label: string; value: React.ReactNode; step: number }[] = [
    { label: "Faculty", value: `${form.faculty_name} · ${form.staff_id || "—"}`, step: 0 },
    { label: "Department", value: form.department || "—", step: 0 },
    { label: "Designation", value: form.designation || "—", step: 0 },
    { label: "Paper", value: form.paper_title || "—", step: 1 },
    { label: "Journal", value: form.journal_title || "—", step: 1 },
    {
      label: "Type",
      value:
        PUBLICATION_TYPES.find((t) => t.value === form.publication_type)?.label ||
        form.publication_type ||
        "—",
      step: 1,
    },
    { label: "Indexing", value: form.indexing_level || "—", step: 1 },
    ...(needsIndexingRef
      ? [{ label: "Indexing ref", value: form.indexing_ref || "—", step: 1 }]
      : []),
    { label: "ISSN", value: form.issn || "—", step: 1 },
    { label: "Published", value: form.publication_date || "—", step: 1 },
    { label: "Yukthi ID", value: form.yukthi_id || "—", step: 1 },
    {
      label: "Claim reason",
      value: CLAIM_REASONS.find((r) => r.value === form.claim_reason)?.badge || "—",
      step: 2,
    },
    {
      label: "Authors",
      value: `Position ${form.author_position} of ${form.total_authors}`,
      step: 2,
    },
    { label: "Quartile", value: form.quartile || form.self_reported_quartile || "—", step: 2 },
    { label: "SNIP", value: form.snip || "—", step: 2 },
    { label: "SEC references", value: form.sec_refs || "—", step: 3 },
    {
      label: "Documents",
      value: `${form.proof_files.length} paper · ${form.sec_proof_files.length} reference${
        form.sec_proof_files.length === 1 ? "" : "s"
      }`,
      step: 3,
    },
  ]

  const outstanding = Array.from(errorSteps)

  const reviewStep = (
    <StepCard step={STEPS[4]}>
      {outstanding.length ? (
        <Callout tone="danger" title="Some steps still need attention">
          <ul className="mt-1 space-y-1">
            {outstanding.map((s) => (
              <li key={s}>
                <button
                  type="button"
                  className="text-primary underline underline-offset-2"
                  onClick={() => {
                    setShowErrors((v) => ({ ...v, [s]: true }))
                    setStep(s)
                  }}
                >
                  {STEPS[s].title}
                </button>{" "}
                — {Object.values(validateStep(s, form))[0]}
              </li>
            ))}
          </ul>
        </Callout>
      ) : (
        <Callout tone="success" title="Everything required is filled in">
          Submitting raises a ticket and sends it to your HoD for approval.
        </Callout>
      )}

      <dl className="overflow-hidden rounded-xl border border-border">
        {reviewRows.map((row, i) => (
          <div
            key={row.label}
            className={cn(
              "group flex items-start justify-between gap-4 px-4 py-2.5 text-sm",
              i % 2 ? "bg-muted/30" : "bg-card"
            )}
          >
            <dt className="shrink-0 text-muted-foreground">{row.label}</dt>
            <dd className="flex min-w-0 items-center gap-2 text-right font-medium text-foreground">
              <span className="min-w-0 break-words">{row.value}</span>
              <button
                type="button"
                aria-label={`Edit ${row.label}`}
                className="shrink-0 text-xs text-primary opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
                onClick={() => setStep(row.step)}
              >
                Edit
              </button>
            </dd>
          </div>
        ))}
      </dl>

      {countOnly ? (
        <Callout tone="info" title="Option B — no incentive payable">
          Recorded for publication count only.
        </Callout>
      ) : calc?.remuneration != null ? (
        <div className="flex items-center justify-between rounded-xl border border-primary/25 bg-surface-brand px-4 py-3">
          <p className="text-sm font-medium text-foreground">Estimated incentive</p>
          <p className="text-2xl font-semibold tabular-nums text-primary">
            <Money value={calc.remuneration} />
          </p>
        </div>
      ) : null}
    </StepCard>
  )

  const stepViews = [identityStep, publicationStep, claimStep, evidenceStep, reviewStep]
  const isFirst = step === 0
  const isLast = step === STEPS.length - 1

  return (
    <form
      noValidate
      className="pb-28"
      onSubmit={(e) => {
        e.preventDefault()
        // Enter advances the wizard but never fires the final submit — moving
        // money stays an explicit click on the Review step (WCAG 3.3.4).
        if (!isLast) goNext()
      }}
    >
      <Callout tone="info" title="Before you start" className="mb-5">
        File this only after the article is indexed in Scopus and linked to your author profile, and
        only once per article. The affiliation on the article must read Saveetha Engineering College.
      </Callout>

      <div className="mb-5">
        <StepRail
          current={step}
          furthest={furthest}
          errorSteps={
            new Set(Array.from(errorSteps).filter((s) => showErrors[s] || s < furthest))
          }
          onJump={setStep}
        />
      </div>

      <p aria-live="polite" className="sr-only">
        Step {step + 1} of {STEPS.length}: {STEPS[step].title}
      </p>

      {step < STEPS.length - 1 && showErrors[step] ? (
        <ErrorSummary errors={visibleErrors} stepTitle={STEPS[step].title} />
      ) : null}

      {stepViews[step]}

      <StickyActions>
        {!isFirst ? (
          <Button
            type="button"
            variant="ghost"
            disabled={busy}
            onClick={() => setStep((s) => s - 1)}
          >
            Back
          </Button>
        ) : null}
        <Button
          type="button"
          variant="secondary"
          disabled={busy || !form.paper_title.trim()}
          onClick={() => save(false)}
        >
          Save draft
        </Button>
        {isLast ? (
          <Button
            type="button"
            disabled={busy || outstanding.length > 0}
            onClick={() => save(true, false)}
          >
            {busy ? "Submitting…" : "Submit claim"}
          </Button>
        ) : (
          <Button type="submit" disabled={busy}>
            Continue
          </Button>
        )}
      </StickyActions>

      <AlertDialog open={sendAnywayOpen} onOpenChange={setSendAnywayOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Send for approval anyway?</AlertDialogTitle>
            <AlertDialogDescription>{blockReason}</AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-2">
            <Label htmlFor="send-note">Note for your HoD (10+ characters)</Label>
            <Textarea
              id="send-note"
              rows={3}
              className="resize-none"
              value={sendNote}
              onChange={(e) => setSendNote(e.target.value)}
            />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>Edit details</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy || sendNote.trim().length < 10}
              onClick={(e) => {
                e.preventDefault()
                save(true, true)
              }}
            >
              Send anyway
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={successOpen} onOpenChange={setSuccessOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Claim submitted</DialogTitle>
            <DialogDescription>Your ticket is with the HoD for approval.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3 rounded-xl bg-surface-brand py-5 text-center">
            <p className="font-mono text-3xl font-semibold tracking-tight text-primary">
              {issuedTicket}
            </p>
            {issuedAmount != null ? (
              <p className="text-sm text-muted-foreground">
                Estimated: <Money value={issuedAmount} />
              </p>
            ) : null}
          </div>
          <DialogFooter>
            <Button asChild className="w-full">
              <Link to={mode === "admin" ? "/admin" : `/faculty?claim=${issuedId}`}>
                {mode === "admin" ? "Back to admin" : "View ticket"}
              </Link>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </form>
  )
}
