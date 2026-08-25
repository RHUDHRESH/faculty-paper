import { useEffect, useRef, useState } from "react"
import { Link, useNavigate, useParams } from "react-router-dom"
import {
  AlertTriangle,
  ArrowLeft,
  ExternalLink,
  LoaderCircle,
  Paperclip,
  Search,
  Trash2,
  Upload,
} from "lucide-react"

import { api, ApiError } from "@/lib/api"
import { useApi } from "@/lib/query"
import { Button } from "@/ui/button"
import { Combobox, type ComboboxOption } from "@/ui/combobox"
import { ConfirmDialog } from "@/ui/dialog"
import {
  Checkbox,
  DateInput,
  Field,
  Input,
  NumberInput,
  Radio,
  Textarea,
} from "@/ui/field"
import { money, stageOf } from "@/ui/paper"
import { Callout, EmptyState, ErrorState, SkeletonText } from "@/ui/state"
import { Meta, PageTitle, SectionTitle, Sub } from "@/ui/text"
import { toast } from "@/ui/toast"
import { Wizard, type Step } from "@/ui/wizard"

/* ------------------------------------------------------------------------ */
/* Server shapes — read out of backend/core/api.py, not guessed             */
/* ------------------------------------------------------------------------ */

type AttachmentRow = {
  kind: "PUBLISHED_PAPER" | "SEC_REFERENCE"
  url: string
  filename: string
  size_bytes: number | null
  ref_number?: string | null
  ref_title?: string | null
  content_hash?: string | null
}

/** The subset of `GET /api/claims/{id}` this screen reads to pre-fill a draft
 *  or a sent-back paper. The full object carries approval and payment fields
 *  no faculty-facing form has any business touching. */
type ClaimDetail = {
  id: string
  status: string
  ticket_number: string | null
  paper_title: string | null
  doi: string | null
  issn: string | null
  journal_title: string | null
  publication_date: string | null
  publication_type: string | null
  indexing_level: string | null
  au_annexure_ref: string | null
  ugc_care_ref: string | null
  yukthi_id: string | null
  self_reported_quartile: string | null
  self_reported_snip: number | null
  impact_factor: string | null
  subject_category: string | null
  scopus_author_url: string | null
  designation: string | null
  claim_reason: string | null
  affiliation_ok: boolean
  total_authors: number
  author_position: number
  attachments: AttachmentRow[]
}

type MeProfile = {
  scopus_author_url?: string | null
  designation?: string | null
}

type ScopusPaper = {
  title?: string | null
  doi?: string | null
  issn?: string | null
  journal_title?: string | null
  cover_date?: string | null
  publication_year?: number | null
  aggregation_type?: string | null
  eid?: string | null
  scopus_url?: string | null
}

type Candidate = ScopusPaper & {
  author_count?: number | null
  linked_to_author: boolean | null
  already_claimed: boolean
}

type CandidatesResult = {
  ok: boolean
  message: string | null
  candidates: Candidate[]
}

type ScimagoResult = {
  found: boolean
  title?: string | null
  sjr?: number | null
  matched_quartile?: string | null
  matched_category?: string | null
  dataset_year?: number | null
  official_url?: string | null
  message?: string | null
}

/** `POST /api/lookup/enrich` — Scopus paper, SNIP and Scimago quartile in one
 *  round trip, which is what makes "paste a DOI" fill in three steps at once
 *  instead of one. */
type EnrichResult = {
  ok: boolean
  message: string | null
  matched_title: string | null
  doi: string | null
  issn: string | null
  journal: string | null
  cover_date: string | null
  aggregation_type: string | null
  snip: number | null
  quartile: string | null
  subject_category: string | null
  scimago: ScimagoResult | null
}

type DuplicateMatch = {
  source?: string | null
  reference?: string | null
  who?: string | null
  when?: string | null
  amount?: number | null
}

type PriorCheckResult = {
  warning: boolean
  matches: DuplicateMatch[]
}

type CalcResult = {
  base: number | null
  point: number | null
  remuneration: number | null
  qf: number | null
  error: string | null
  note: string | null
  category_label?: string | null
}

type UploadResult = {
  url: string
  filename: string
  size_bytes: number
  content_hash: string
  duplicate_of: { ticket_number: string | null; owner_name: string; same_owner: boolean } | null
}

/* ------------------------------------------------------------------------ */
/* Form state — the faculty-writable slice of the claim, in editor shape    */
/* ------------------------------------------------------------------------ */

type FormState = {
  paperTitle: string
  doi: string
  publicationType: string
  publicationDate: string
  journalTitle: string
  issn: string
  indexing: string[]
  auAnnexureRef: string
  ugcCareRef: string
  yukthiId: string
  subjectCategory: string
  selfReportedQuartile: string | null
  selfReportedSnip: string
  impactFactor: string
  scopusAuthorUrl: string
  designation: string
  authorPosition: number
  totalAuthors: number
  affiliationOk: boolean
  claimReason: "INCENTIVE" | "COUNT_ONLY"
  attachments: AttachmentRow[]
}

function emptyForm(): FormState {
  return {
    paperTitle: "",
    doi: "",
    publicationType: "",
    publicationDate: "",
    journalTitle: "",
    issn: "",
    indexing: [],
    auAnnexureRef: "",
    ugcCareRef: "",
    yukthiId: "",
    subjectCategory: "",
    selfReportedQuartile: null,
    selfReportedSnip: "",
    impactFactor: "",
    scopusAuthorUrl: "",
    designation: "",
    authorPosition: 1,
    totalAuthors: 1,
    affiliationOk: false,
    claimReason: "INCENTIVE",
    attachments: [],
  }
}

function formFromClaim(c: ClaimDetail): FormState {
  return {
    paperTitle: c.paper_title || "",
    doi: c.doi || "",
    publicationType: c.publication_type || "",
    publicationDate: c.publication_date || "",
    journalTitle: c.journal_title || "",
    issn: c.issn || "",
    indexing: (c.indexing_level || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    auAnnexureRef: c.au_annexure_ref || "",
    ugcCareRef: c.ugc_care_ref || "",
    yukthiId: c.yukthi_id || "",
    subjectCategory: c.subject_category || "",
    selfReportedQuartile: c.self_reported_quartile || null,
    selfReportedSnip: c.self_reported_snip != null ? String(c.self_reported_snip) : "",
    impactFactor: c.impact_factor || "",
    scopusAuthorUrl: c.scopus_author_url || "",
    designation: c.designation || "",
    authorPosition: c.author_position || 1,
    totalAuthors: c.total_authors || 1,
    affiliationOk: c.affiliation_ok,
    claimReason: c.claim_reason === "COUNT_ONLY" ? "COUNT_ONLY" : "INCENTIVE",
    attachments: c.attachments.map((a) => ({
      kind: a.kind,
      url: a.url,
      filename: a.filename,
      size_bytes: a.size_bytes,
      ref_number: a.ref_number,
      ref_title: a.ref_title,
    })),
  }
}

function yearOf(dateStr: string): number | null {
  const y = Number(dateStr.slice(0, 4))
  return dateStr && Number.isFinite(y) && y > 1900 ? y : null
}

function isoDate(raw: string): string {
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10)
  const d = new Date(raw)
  return Number.isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10)
}

function mapPublicationType(aggregationType: string): string {
  const a = aggregationType.toLowerCase()
  if (a.includes("conference")) return "Conference Proceeding"
  if (a.includes("book")) return "Book Series"
  if (a.includes("journal")) return "Journal"
  return "Other"
}

/** What the server actually accepts back — everything else in `ClaimIn` is
 *  either verification-owned or not something this form manages, and sending
 *  those keys at all (even as `null`) would overwrite a value the server
 *  derives on its own, such as `sec_refs` from the attachments' reference
 *  numbers. So a field this screen does not render is simply absent from the
 *  body, never nulled. */
function buildPayload(
  form: FormState,
  extra: { submit: boolean; contest?: boolean; contestNote?: string }
) {
  return {
    paper_title: form.paperTitle.trim(),
    doi: form.doi.trim() || null,
    issn: form.issn.trim() || null,
    journal_title: form.journalTitle.trim() || null,
    publication_year: yearOf(form.publicationDate),
    publication_date: form.publicationDate || null,
    publication_type: form.publicationType || null,
    indexing_level: form.indexing.join(", ") || null,
    au_annexure_ref: form.auAnnexureRef.trim() || null,
    ugc_care_ref: form.ugcCareRef.trim() || null,
    yukthi_id: form.yukthiId.trim() || null,
    subject_category: form.subjectCategory.trim() || null,
    self_reported_quartile: form.selfReportedQuartile || null,
    self_reported_snip: form.selfReportedSnip.trim() ? Number(form.selfReportedSnip) : null,
    impact_factor: form.impactFactor.trim() || null,
    scopus_author_url: form.scopusAuthorUrl.trim() || null,
    designation: form.designation.trim() || null,
    total_authors: form.totalAuthors,
    author_position: form.authorPosition,
    affiliation_ok: form.affiliationOk,
    claim_reason: form.claimReason,
    attachments: form.attachments.map((a) => ({
      kind: a.kind,
      url: a.url,
      filename: a.filename,
      size_bytes: a.size_bytes ?? 0,
      ref_number: a.ref_number || undefined,
      ref_title: a.ref_title || undefined,
      content_hash: a.content_hash || undefined,
    })),
    contest_forward: extra.contest ?? false,
    contest_note: extra.contest ? (extra.contestNote || "").trim() || undefined : undefined,
    submit: extra.submit,
  }
}

/** `body: formData` is the one shape `api()`'s `Options` type deliberately
 *  omits — every other endpoint in this app is JSON. The cast is the escape
 *  hatch for the one call that genuinely needs a multipart body; the request
 *  itself still goes through `api()` so the CSRF header is still attached. */
async function uploadAttachment(file: File): Promise<UploadResult> {
  const body = new FormData()
  body.append("file", file)
  return api<UploadResult>("/api/claims/upload", {
    method: "POST",
    body,
  } as unknown as Parameters<typeof api>[1])
}

/* ------------------------------------------------------------------------ */
/* Constants                                                                */
/* ------------------------------------------------------------------------ */

const PUBLICATION_TYPES: ComboboxOption[] = [
  { value: "Journal", label: "Journal article" },
  { value: "Conference Proceeding", label: "Conference proceeding" },
  { value: "Book Series", label: "Book or book chapter" },
  { value: "Other", label: "Other" },
]

const QUARTILE_OPTIONS: ComboboxOption[] = [
  { value: "Q1", label: "Q1" },
  { value: "Q2", label: "Q2" },
  { value: "Q3", label: "Q3" },
  { value: "Q4", label: "Q4" },
]

// Exact tokens the server's category rules match on (case-insensitively) —
// see `is_scopus_indexed` / `is_web_of_science` in
// backend/core/services/remuneration.py. AU Annexure and UGC Care are their
// own registers with their own reference numbers.
const INDEXING_OPTIONS = ["Scopus", "Web of Science", "AU Annexure", "UGC Care"] as const

const ACCEPT = ".pdf,.png,.jpg,.jpeg,.webp,.gif,.tif,.tiff,.doc,.docx"

const STEPS: Step[] = [
  { id: "paper", title: "The paper", hint: "What was published, and when" },
  { id: "journal", title: "The journal", hint: "Where it was published" },
  { id: "authors", title: "Authors", hint: "Your place among them" },
  { id: "proof", title: "Proof", hint: "What backs this claim up" },
  { id: "review", title: "Check and file", hint: "The estimate, then send it" },
]

/* ------------------------------------------------------------------------ */
/* FilePaper                                                                */
/* ------------------------------------------------------------------------ */

/**
 * The form that turns a publication into a payment claim.
 *
 * Serves `/papers/new` and `/papers/:id/edit` (a draft, or a paper sent back
 * for changes — both are PATCHable per API.md). Without this screen a
 * claimant re-types a paper's journal, ISSN and SNIP by hand into a form that
 * cannot tell them whether it has already been paid, and finds out the
 * amount was only ever a guess after they have already spent it. Every
 * safeguard here — the lookups, the duplicate check, the autosave, the
 * "estimate" label on the money — exists because the old ERP form had none
 * of them and each was how somebody lost work or a rupee figure they trusted.
 */
export function FilePaper() {
  const { id } = useParams<{ id?: string }>()
  const navigate = useNavigate()
  const isEditRoute = !!id

  const {
    data: existing,
    isLoading: loadingExisting,
    error: loadError,
    refetch: refetchExisting,
  } = useApi<ClaimDetail>(["claim", id], `/api/claims/${id}`, { enabled: isEditRoute })

  const { data: me } = useApi<MeProfile>(["auth-me-full"], "/api/auth/me")

  const [form, setForm] = useState<FormState>(emptyForm)
  const [current, setCurrent] = useState(0)
  const [furthest, setFurthest] = useState(0)

  // The draft id is read from the ref by the autosave timer and by the save
  // handler. The state half exists only to re-render once when a draft first
  // gets an id, so the value itself is never read — hence the empty slot.
  const claimIdRef = useRef<string | null>(null)
  const [, setClaimId] = useState<string | null>(null)
  const dirtyRef = useRef(false)
  const [savingState, setSavingState] = useState<"idle" | "pending" | "saving" | "saved" | "error">(
    "idle"
  )
  const [lastSavedAt, setLastSavedAt] = useState<Date | null>(null)
  const [, forceTick] = useState(0) // re-renders the "saved N ago" label as time passes

  const hydratedRef = useRef(false)
  const meAppliedRef = useRef(false)

  const [ticketNumber, setTicketNumber] = useState<string | null>(null)

  // Pre-fill from the existing claim (edit route) exactly once, without
  // marking the form dirty — a page load is not an edit.
  useEffect(() => {
    if (!existing || hydratedRef.current) return
    hydratedRef.current = true
    setForm(formFromClaim(existing))
    claimIdRef.current = existing.id
    setClaimId(existing.id)
    setTicketNumber(existing.ticket_number)
  }, [existing])

  // A brand-new claim starts from the account's own Scopus link and
  // designation, so the authors step is not blank for no reason. Only for a
  // fresh draft, and only until the claimant (or the hydration above) has
  // put something there first.
  useEffect(() => {
    if (isEditRoute || meAppliedRef.current || !me) return
    meAppliedRef.current = true
    setForm((prev) => {
      if (prev.scopusAuthorUrl || prev.designation) return prev
      return {
        ...prev,
        scopusAuthorUrl: me.scopus_author_url || prev.scopusAuthorUrl,
        designation: me.designation || prev.designation,
      }
    })
  }, [isEditRoute, me])

  /** Every field change goes through here: it updates the value, marks the
   *  draft dirty, and lets the autosave effect know there is something to
   *  send. Lookups use it too, via the updater-function form, so a result
   *  that arrives after the user has already typed something never clobbers
   *  it with a stale closure's idea of the previous value. */
  function patchForm(updater: Partial<FormState> | ((prev: FormState) => Partial<FormState>)) {
    setForm((prev) => ({ ...prev, ...(typeof updater === "function" ? updater(prev) : updater) }))
    dirtyRef.current = true
    setSavingState("pending")
  }

  async function save() {
    setSavingState("saving")
    try {
      const payload = buildPayload(form, { submit: false })
      let result: ClaimDetail
      if (claimIdRef.current) {
        result = await api<ClaimDetail>(`/api/claims/${claimIdRef.current}`, {
          method: "PATCH",
          json: payload,
        })
      } else {
        result = await api<ClaimDetail>("/api/claims", { method: "POST", json: payload })
        claimIdRef.current = result.id
        setClaimId(result.id)
        // Replace, not push — a browser Back from here should land on the
        // papers list the claimant actually came from, not on the moment
        // before the draft existed.
        navigate(`/papers/${result.id}/edit`, { replace: true })
      }
      dirtyRef.current = false
      setLastSavedAt(new Date())
      setSavingState("saved")
    } catch {
      // Left dirty on purpose: the next edit re-arms the debounce and tries
      // again, and the status line below offers an explicit retry too.
      setSavingState("error")
    }
  }

  // The debounce: every change resets this timer, so a burst of keystrokes
  // becomes one request 2.5s after the last of them, not one per keystroke.
  useEffect(() => {
    if (!dirtyRef.current) return
    const t = setTimeout(() => void save(), 2500)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form])

  useEffect(() => {
    const t = setInterval(() => forceTick((n) => n + 1), 30_000)
    return () => clearInterval(t)
  }, [])

  // Tab close, refresh, or typing a new address. A real Back-button or
  // sidebar navigation cannot be caught this way — see the report on why:
  // this app's router (`BrowserRouter` in main.tsx) is not a data router, and
  // `useBlocker` throws outright without one. The page's own "leave" link
  // below is guarded separately, by hand.
  useEffect(() => {
    function onBeforeUnload(e: BeforeUnloadEvent) {
      if (!dirtyRef.current && savingState !== "saving") return
      e.preventDefault()
      e.returnValue = ""
    }
    window.addEventListener("beforeunload", onBeforeUnload)
    return () => window.removeEventListener("beforeunload", onBeforeUnload)
  }, [savingState])

  const [confirmLeave, setConfirmLeave] = useState(false)

  /* ---------------------------- lookups --------------------------------- */

  const [lookupBusy, setLookupBusy] = useState(false)
  const [lookupError, setLookupError] = useState<string | null>(null)
  const [candidates, setCandidates] = useState<Candidate[] | null>(null)
  const [scopusMatch, setScopusMatch] = useState<EnrichResult | null>(null)
  const [scimago, setScimago] = useState<ScimagoResult | null>(null)

  function applyEnrich(res: EnrichResult) {
    const patch: Partial<FormState> = {}
    if (res.matched_title) patch.paperTitle = res.matched_title
    if (res.doi) patch.doi = res.doi
    if (res.journal) patch.journalTitle = res.journal
    if (res.issn) patch.issn = res.issn
    if (res.cover_date) patch.publicationDate = isoDate(res.cover_date)
    if (res.aggregation_type) patch.publicationType = mapPublicationType(res.aggregation_type)
    if (res.snip != null) patch.selfReportedSnip = String(res.snip)
    if (res.quartile) patch.selfReportedQuartile = res.quartile
    if (res.subject_category) patch.subjectCategory = res.subject_category
    if (Object.keys(patch).length) patchForm(patch)
    setScopusMatch(res)
    if (res.scimago) setScimago(res.scimago)
  }

  async function lookupByDoi() {
    if (!form.doi.trim()) return
    setLookupBusy(true)
    setLookupError(null)
    setCandidates(null)
    try {
      const res = await api<EnrichResult>("/api/lookup/enrich", {
        method: "POST",
        json: { doi: form.doi.trim() },
      })
      if (!res.ok) {
        setLookupError(res.message || "No match for that DOI — enter the details yourself.")
        return
      }
      applyEnrich(res)
    } catch (err) {
      setLookupError(lookupFailureMessage(err))
    } finally {
      setLookupBusy(false)
    }
  }

  async function searchByTitle() {
    if (!form.paperTitle.trim()) return
    setLookupBusy(true)
    setLookupError(null)
    setScopusMatch(null)
    try {
      const res = await api<CandidatesResult>("/api/lookup/candidates", {
        method: "POST",
        json: { title: form.paperTitle.trim() },
      })
      if (!res.candidates.length) {
        setLookupError(res.message || "No match for that title — enter the details yourself.")
        setCandidates(null)
        return
      }
      setCandidates(res.candidates)
    } catch (err) {
      setLookupError(lookupFailureMessage(err))
    } finally {
      setLookupBusy(false)
    }
  }

  async function pickCandidate(c: Candidate) {
    setCandidates(null)
    const patch: Partial<FormState> = {}
    if (c.title) patch.paperTitle = c.title
    if (c.doi) patch.doi = c.doi
    if (c.journal_title) patch.journalTitle = c.journal_title
    if (c.issn) patch.issn = c.issn
    if (c.cover_date) patch.publicationDate = isoDate(c.cover_date)
    if (c.aggregation_type) patch.publicationType = mapPublicationType(c.aggregation_type)
    if (Object.keys(patch).length) patchForm(patch)
    // The candidate list has no SNIP or quartile — one more round trip gets
    // both, plus confirms the DOI, exactly as a direct DOI paste would.
    setLookupBusy(true)
    try {
      const res = await api<EnrichResult>("/api/lookup/enrich", {
        method: "POST",
        json: c.doi ? { doi: c.doi } : { title: c.title || undefined, issn: c.issn || undefined },
      })
      if (res.ok) applyEnrich(res)
    } catch (err) {
      setLookupError(lookupFailureMessage(err))
    } finally {
      setLookupBusy(false)
    }
  }

  async function checkScimago() {
    setLookupBusy(true)
    setLookupError(null)
    try {
      const res = await api<ScimagoResult>("/api/lookup/scimago", {
        method: "POST",
        json: {
          issn: form.issn.trim() || undefined,
          title: form.journalTitle.trim() || undefined,
          year: yearOf(form.publicationDate) || undefined,
        },
      })
      setScimago(res)
      if (res.found && res.matched_quartile) {
        patchForm({ selfReportedQuartile: res.matched_quartile })
      } else if (!res.found) {
        setLookupError(res.message || "No match in the Scimago dataset — set the quartile yourself.")
      }
    } catch (err) {
      setLookupError(lookupFailureMessage(err))
    } finally {
      setLookupBusy(false)
    }
  }

  function lookupFailureMessage(err: unknown): string {
    if (err instanceof ApiError && err.status === 502) {
      return "Scopus is down right now — that will not stop you filing. Enter the details yourself and try the lookup again later."
    }
    return err instanceof ApiError ? err.message : "Could not look this up. Enter the details yourself."
  }

  /* ------------------------------ proof ---------------------------------- */

  const [uploadingKind, setUploadingKind] = useState<AttachmentRow["kind"] | null>(null)

  async function addAttachment(kind: AttachmentRow["kind"], file: File) {
    setUploadingKind(kind)
    try {
      const res = await uploadAttachment(file)
      if (res.duplicate_of) {
        toast.info(
          res.duplicate_of.same_owner
            ? `That file is already attached to ${res.duplicate_of.ticket_number || "another one of your papers"}.`
            : `That file matches one already on ticket ${res.duplicate_of.ticket_number || "another claim"}, filed by ${res.duplicate_of.owner_name}.`
        )
      }
      patchForm((prev) => ({
        attachments: [
          ...prev.attachments,
          {
            kind,
            url: res.url,
            filename: res.filename,
            size_bytes: res.size_bytes,
            content_hash: res.content_hash,
            ref_number: kind === "SEC_REFERENCE" ? "" : undefined,
            ref_title: kind === "SEC_REFERENCE" ? "" : undefined,
          },
        ],
      }))
    } catch (err) {
      toast.fail(err, "Could not upload that file.")
    } finally {
      setUploadingKind(null)
    }
  }

  function removeAttachment(url: string) {
    patchForm((prev) => ({ attachments: prev.attachments.filter((a) => a.url !== url) }))
  }

  function updateAttachment(url: string, patch: Partial<AttachmentRow>) {
    patchForm((prev) => ({
      attachments: prev.attachments.map((a) => (a.url === url ? { ...a, ...patch } : a)),
    }))
  }

  /* --------------------------- duplicate check ---------------------------- */

  const [priorCheck, setPriorCheck] = useState<PriorCheckResult | null>(null)
  const [priorCheckBusy, setPriorCheckBusy] = useState(false)

  async function runPriorCheck() {
    if (!form.doi.trim() && !form.paperTitle.trim()) return
    setPriorCheckBusy(true)
    try {
      const res = await api<PriorCheckResult>("/api/prior/check", {
        method: "POST",
        json: { doi: form.doi.trim() || undefined, title: form.paperTitle.trim() || undefined },
      })
      setPriorCheck(res)
    } catch {
      // Not blocking, and the server checks again on file — silent here,
      // the "Check again" button lets the claimant retry by hand.
    } finally {
      setPriorCheckBusy(false)
    }
  }

  useEffect(() => {
    if (current === 4) void runPriorCheck()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current])

  /* ------------------------------ estimate -------------------------------- */

  const [calc, setCalc] = useState<CalcResult | null>(null)
  const [calcBusy, setCalcBusy] = useState(false)

  const secReferenceCount = form.attachments.filter(
    (a) => a.kind === "SEC_REFERENCE" && (a.ref_number || "").trim()
  ).length

  useEffect(() => {
    if (current !== 4) return
    setCalcBusy(true)
    const t = setTimeout(() => {
      void api<CalcResult>("/api/calculate", {
        method: "POST",
        json: {
          snip: form.selfReportedSnip.trim() ? Number(form.selfReportedSnip) : undefined,
          quartile: form.selfReportedQuartile || undefined,
          total_authors: form.totalAuthors,
          author_position: form.authorPosition,
          publication_type: form.publicationType || undefined,
          is_student_publication: form.claimReason === "COUNT_ONLY",
          indexing_level: form.indexing.join(", ") || undefined,
          sec_reference_count: secReferenceCount,
        },
      })
        .then(setCalc)
        .catch(() => setCalc(null))
        .finally(() => setCalcBusy(false))
    }, 300)
    return () => clearTimeout(t)
  }, [
    current,
    form.selfReportedSnip,
    form.selfReportedQuartile,
    form.totalAuthors,
    form.authorPosition,
    form.publicationType,
    form.indexing,
    form.claimReason,
    secReferenceCount,
  ])

  /* -------------------------------- filing --------------------------------- */

  const [confirmFile, setConfirmFile] = useState(false)
  const [fileBusy, setFileBusy] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [contestNote, setContestNote] = useState("")

  async function fileNow(opts: { contest?: boolean } = {}) {
    setFileBusy(true)
    setSubmitError(null)
    try {
      const payload = buildPayload(form, { submit: true, contest: opts.contest, contestNote })
      const result = claimIdRef.current
        ? await api<ClaimDetail>(`/api/claims/${claimIdRef.current}`, { method: "PATCH", json: payload })
        : await api<ClaimDetail>("/api/claims", { method: "POST", json: payload })
      dirtyRef.current = false
      toast.ok(
        result.ticket_number
          ? `Filed — ticket ${result.ticket_number}. It has gone to the research cell to be checked.`
          : "Filed. It has gone to the research cell to be checked."
      )
      navigate(`/papers/${result.id}`)
    } catch (err) {
      const message =
        err instanceof ApiError ? err.message : "Could not file this paper. Try again."
      setSubmitError(message)
      toast.fail(err, "Could not file this paper.")
    } finally {
      setFileBusy(false)
    }
  }

  /* ------------------------------- validation ------------------------------ */

  function validate(index: number): string | null {
    switch (index) {
      case 0:
        if (!form.paperTitle.trim()) return "Enter the paper's title."
        if (!form.publicationType) return "Choose what kind of publication this is."
        if (!form.publicationDate) return "Enter the date it was published."
        return null
      case 1:
        if (!form.journalTitle.trim()) return "Enter the journal's title."
        if (!form.issn.trim()) return "Enter the journal's ISSN."
        if (form.indexing.length === 0) return "Select at least one indexing level."
        if (form.indexing.includes("AU Annexure") && !form.auAnnexureRef.trim())
          return "Enter the AU Annexure reference number, or NA if there is none."
        if (form.indexing.includes("UGC Care") && !form.ugcCareRef.trim())
          return "Enter the UGC Care reference number, or NA if there is none."
        if (!form.yukthiId.trim()) return "Enter the Yukthi ID, or NA if there is none."
        return null
      case 2:
        if (!form.scopusAuthorUrl.trim()) return "Add your Scopus author profile link."
        if (!form.totalAuthors || form.totalAuthors < 1)
          return "Enter how many authors the paper has."
        if (form.authorPosition < 1 || form.authorPosition > form.totalAuthors)
          return "Your author position must be between 1 and the total number of authors."
        if (!form.affiliationOk)
          return "Confirm the article is affiliated to Saveetha Engineering College."
        return null
      case 3: {
        if (!form.attachments.some((a) => a.kind === "PUBLISHED_PAPER"))
          return "Attach the full-length published paper."
        const refs = form.attachments.filter((a) => a.kind === "SEC_REFERENCE")
        if (refs.length === 0) return "Attach at least one cited reference with SEC affiliation."
        if (refs.some((r) => !(r.ref_number || "").trim()))
          return "Enter the reference number for each cited reference you attached."
        return null
      }
      default:
        return null
    }
  }

  /* --------------------------------- render --------------------------------- */

  if (isEditRoute && loadingExisting) {
    return (
      <div className="page space-y-8 py-8">
        <SkeletonText lines={6} />
      </div>
    )
  }

  if (isEditRoute && loadError) {
    if (loadError.status === 404) {
      return (
        <div className="page py-8">
          <ErrorState
            title="This paper does not exist"
            message="It may have been withdrawn, or the link is wrong."
          />
        </div>
      )
    }
    if (loadError.status === 403) {
      return (
        <div className="page py-8">
          <ErrorState
            title="This paper is not yours"
            message="You can only edit a paper you filed yourself."
          />
        </div>
      )
    }
    return (
      <div className="page py-8">
        <ErrorState onRetry={() => void refetchExisting()} />
      </div>
    )
  }

  if (isEditRoute && existing && existing.status !== "DRAFT" && existing.status !== "REJECTED") {
    return (
      <div className="page py-8">
        <EmptyState
          title="This paper can no longer be edited"
          message={`It is ${stageOf(existing.status).label.toLowerCase()} — only a draft or a paper sent back for changes can be edited here.`}
          action={
            <Button kind="default" size="sm" asChild>
              <Link to={`/papers/${existing.id}`}>Open the paper</Link>
            </Button>
          }
        />
      </div>
    )
  }

  const secWarning =
    secReferenceCount > 0 && secReferenceCount < 2
      ? "The policy requires at least two SEC-affiliated references for the incentive to be payable — one is attached so far. The paper is still recorded either way."
      : null

  return (
    <div className="page space-y-6 pb-16">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <button
            type="button"
            onClick={() => {
              if (dirtyRef.current) setConfirmLeave(true)
              else navigate("/papers")
            }}
            className="inline-flex items-center gap-1 text-sm text-fg-muted hover:text-fg"
          >
            <ArrowLeft className="size-3.5" aria-hidden />
            My papers
          </button>
          <PageTitle className="mt-2">
            {isEditRoute
              ? ticketNumber
                ? `Edit ticket ${ticketNumber}`
                : "Edit your draft"
              : "File a paper"}
          </PageTitle>
          <Sub className="mt-1">
            Paste a DOI on the first step and most of this fills itself in.
          </Sub>
        </div>
        <SaveStatus state={savingState} lastSavedAt={lastSavedAt} onRetry={() => void save()} />
      </header>

      <Wizard
        steps={STEPS}
        current={current}
        furthest={furthest}
        onCurrentChange={(i) => {
          setCurrent(i)
          setFurthest((f) => Math.max(f, i))
        }}
        onFinish={() => setConfirmFile(true)}
        finishLabel="File this paper"
        busy={fileBusy}
        validate={validate}
      >
        {current === 0 && (
          <PaperStep
            form={form}
            patchForm={patchForm}
            lookupBusy={lookupBusy}
            lookupError={lookupError}
            candidates={candidates}
            scopusMatch={scopusMatch}
            onLookupDoi={() => void lookupByDoi()}
            onSearchTitle={() => void searchByTitle()}
            onPickCandidate={(c) => void pickCandidate(c)}
          />
        )}
        {current === 1 && (
          <JournalStep
            form={form}
            patchForm={patchForm}
            lookupBusy={lookupBusy}
            lookupError={lookupError}
            scimago={scimago}
            onCheckScimago={() => void checkScimago()}
          />
        )}
        {current === 2 && <AuthorsStep form={form} patchForm={patchForm} />}
        {current === 3 && (
          <ProofStep
            form={form}
            uploadingKind={uploadingKind}
            secWarning={secWarning}
            onAdd={(kind, file) => void addAttachment(kind, file)}
            onRemove={removeAttachment}
            onUpdate={updateAttachment}
          />
        )}
        {current === 4 && (
          <ReviewStep
            form={form}
            calc={calc}
            calcBusy={calcBusy}
            priorCheck={priorCheck}
            priorCheckBusy={priorCheckBusy}
            onRecheck={() => void runPriorCheck()}
            submitError={submitError}
            contestNote={contestNote}
            onContestNoteChange={setContestNote}
            onSendAnyway={() => void fileNow({ contest: true })}
            fileBusy={fileBusy}
          />
        )}
      </Wizard>

      <ConfirmDialog
        open={confirmFile}
        onOpenChange={setConfirmFile}
        title="File this paper?"
        description="Once filed it leaves your hands and goes to the research cell to be checked. A ticket number appears here as soon as it is filed."
        confirmLabel="File it"
        onConfirm={async () => {
          await fileNow()
        }}
      />

      <ConfirmDialog
        open={confirmLeave}
        onOpenChange={setConfirmLeave}
        title="Leave without saving?"
        description="Your last few changes have not been saved yet. Give it a moment and they will be — or leave now and lose them."
        confirmLabel="Leave anyway"
        danger
        onConfirm={() => {
          dirtyRef.current = false
          navigate("/papers")
        }}
      />
    </div>
  )
}

/* ------------------------------------------------------------------------ */
/* SaveStatus                                                                */
/* ------------------------------------------------------------------------ */

function SaveStatus({
  state,
  lastSavedAt,
  onRetry,
}: {
  state: "idle" | "pending" | "saving" | "saved" | "error"
  lastSavedAt: Date | null
  onRetry: () => void
}) {
  if (state === "error") {
    return (
      <div className="flex items-center gap-2 text-sm text-critical">
        <AlertTriangle className="size-4" aria-hidden />
        Could not save automatically.
        <button type="button" onClick={onRetry} className="font-medium underline-offset-2 hover:underline">
          Retry
        </button>
      </div>
    )
  }
  if (state === "saving") {
    return (
      <span className="flex items-center gap-1.5 text-sm text-fg-muted">
        <LoaderCircle className="size-3.5 animate-spin" aria-hidden />
        Saving…
      </span>
    )
  }
  if (state === "idle" && !lastSavedAt) {
    return <span className="text-sm text-fg-subtle">Not saved yet</span>
  }
  return <span className="text-sm text-fg-muted">Saved {relativeTime(lastSavedAt)}</span>
}

function relativeTime(when: Date | null): string {
  if (!when) return "just now"
  const seconds = Math.max(0, Math.round((Date.now() - when.getTime()) / 1000))
  if (seconds < 10) return "just now"
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`
  const hours = Math.round(minutes / 60)
  return `${hours} hour${hours === 1 ? "" : "s"} ago`
}

/* ------------------------------------------------------------------------ */
/* Step 1 — The paper                                                       */
/* ------------------------------------------------------------------------ */

function PaperStep({
  form,
  patchForm,
  lookupBusy,
  lookupError,
  candidates,
  scopusMatch,
  onLookupDoi,
  onSearchTitle,
  onPickCandidate,
}: {
  form: FormState
  patchForm: (updater: Partial<FormState> | ((prev: FormState) => Partial<FormState>)) => void
  lookupBusy: boolean
  lookupError: string | null
  candidates: Candidate[] | null
  scopusMatch: EnrichResult | null
  onLookupDoi: () => void
  onSearchTitle: () => void
  onPickCandidate: (c: Candidate) => void
}) {
  return (
    <div className="space-y-6">
      <div className="space-y-3 rounded-md bg-sunken p-4">
        <p className="text-sm font-medium">Have a DOI? Start there.</p>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            value={form.doi}
            onChange={(e) => patchForm({ doi: e.target.value })}
            placeholder="10.1000/xyz123"
            aria-label="DOI"
            className="sm:max-w-xs"
          />
          <Button kind="default" onClick={onLookupDoi} disabled={lookupBusy || !form.doi.trim()}>
            {lookupBusy ? <LoaderCircle className="animate-spin" /> : <Search />}
            Look it up
          </Button>
        </div>
        <p className="text-xs text-fg-muted">
          Filling this in finds the journal, its indexing and its quartile too, on the next steps.
        </p>
      </div>

      <Field label="Paper title">
        <Textarea
          value={form.paperTitle}
          onChange={(e) => patchForm({ paperTitle: e.target.value })}
          rows={2}
          maxRows={4}
        />
      </Field>

      {!form.doi.trim() && (
        <Button kind="quiet" size="sm" onClick={onSearchTitle} disabled={lookupBusy || !form.paperTitle.trim()}>
          {lookupBusy ? <LoaderCircle className="animate-spin" /> : <Search />}
          No DOI — search Scopus by this title
        </Button>
      )}

      {lookupError && (
        <Callout tone="caution" title="Could not find it automatically">
          {lookupError}
        </Callout>
      )}

      {candidates && (
        <div className="space-y-2 rounded-md ring-1 ring-inset ring-line p-3">
          <p className="text-sm font-medium">Which one is it?</p>
          <ul className="divide-y divide-line">
            {candidates.map((c, i) => (
              <li key={c.doi || c.eid || i} className="py-2">
                <button
                  type="button"
                  onClick={() => onPickCandidate(c)}
                  disabled={c.already_claimed}
                  className="w-full rounded-sm px-2 py-1.5 text-left hover:bg-hover disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <span className="block text-sm">{c.title || "Untitled"}</span>
                  <Meta className="mt-0.5 block">
                    {[c.journal_title, c.publication_year, c.doi].filter(Boolean).join(" · ")}
                    {c.already_claimed && " · Already on one of your claims"}
                  </Meta>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {scopusMatch?.ok && (
        <Callout tone="positive" title="Found on Scopus">
          <p>
            {[scopusMatch.journal, scopusMatch.scimago?.matched_quartile]
              .filter(Boolean)
              .join(" · ") || "Matched."}{" "}
            The details below have been filled in — check them before moving on.
          </p>
        </Callout>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Type of publication">
          <Combobox
            value={form.publicationType || null}
            onChange={(v) => patchForm({ publicationType: v })}
            options={PUBLICATION_TYPES}
            placeholder="Select…"
          />
        </Field>
        <Field label="Date published">
          <DateInput
            value={form.publicationDate}
            onChange={(e) => patchForm({ publicationDate: e.target.value })}
          />
        </Field>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------------ */
/* Step 2 — The journal                                                     */
/* ------------------------------------------------------------------------ */

function JournalStep({
  form,
  patchForm,
  lookupBusy,
  lookupError,
  scimago,
  onCheckScimago,
}: {
  form: FormState
  patchForm: (updater: Partial<FormState> | ((prev: FormState) => Partial<FormState>)) => void
  lookupBusy: boolean
  lookupError: string | null
  scimago: ScimagoResult | null
  onCheckScimago: () => void
}) {
  function toggleIndexing(opt: string) {
    patchForm((prev) => ({
      indexing: prev.indexing.includes(opt)
        ? prev.indexing.filter((x) => x !== opt)
        : [...prev.indexing, opt],
    }))
  }

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Journal title">
          <Input value={form.journalTitle} onChange={(e) => patchForm({ journalTitle: e.target.value })} />
        </Field>
        <Field label="ISSN" hint="Print or online — either works for the lookup.">
          <Input value={form.issn} onChange={(e) => patchForm({ issn: e.target.value })} />
        </Field>
      </div>

      <div className="space-y-2">
        <p className="text-sm font-medium">Indexing level</p>
        <div className="flex flex-wrap gap-x-6 gap-y-2">
          {INDEXING_OPTIONS.map((opt) => (
            <Checkbox
              key={opt}
              checked={form.indexing.includes(opt)}
              onCheckedChange={() => toggleIndexing(opt)}
              label={opt}
            />
          ))}
        </div>
      </div>

      {form.indexing.includes("AU Annexure") && (
        <Field label="AU Annexure reference number" hint="Enter NA if there is none.">
          <Input value={form.auAnnexureRef} onChange={(e) => patchForm({ auAnnexureRef: e.target.value })} />
        </Field>
      )}
      {form.indexing.includes("UGC Care") && (
        <Field label="UGC Care reference number" hint="Enter NA if there is none.">
          <Input value={form.ugcCareRef} onChange={(e) => patchForm({ ugcCareRef: e.target.value })} />
        </Field>
      )}

      <Field label="Yukthi ID" hint="Enter NA if there is none.">
        <Input value={form.yukthiId} onChange={(e) => patchForm({ yukthiId: e.target.value })} className="max-w-xs" />
      </Field>

      <div className="space-y-3 rounded-md bg-sunken p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm font-medium">Quartile and SNIP</p>
          <Button kind="default" size="sm" onClick={onCheckScimago} disabled={lookupBusy}>
            {lookupBusy ? <LoaderCircle className="animate-spin" /> : <Search />}
            Check Scimago
          </Button>
        </div>

        {scimago?.found && (
          <p className="text-sm text-fg-muted">
            Scimago has this as {scimago.matched_quartile || "an unranked title"}
            {scimago.sjr != null && `, SJR ${scimago.sjr}`}
            {scimago.dataset_year && ` (${scimago.dataset_year} data)`}.
            {scimago.official_url && (
              <>
                {" "}
                <a
                  href={scimago.official_url}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-0.5 text-accent underline-offset-4 hover:underline"
                >
                  View on Scimago
                  <ExternalLink className="size-3" aria-hidden />
                </a>
              </>
            )}
          </p>
        )}
        {lookupError && <p className="text-sm text-caution">{lookupError}</p>}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Quartile you are declaring"
            hint="Self-reported. It does not decide the payout — the research cell verifies it separately."
          >
            <Combobox
              value={form.selfReportedQuartile}
              onChange={(v) => patchForm({ selfReportedQuartile: v })}
              options={QUARTILE_OPTIONS}
              placeholder="Not sure"
            />
          </Field>
          <Field label="SNIP you are declaring" hint="Self-reported, same as the quartile.">
            <NumberInput
              value={form.selfReportedSnip}
              onChange={(e) => patchForm({ selfReportedSnip: e.target.value })}
              step="0.001"
              min="0"
            />
          </Field>
        </div>
      </div>

      <Field label="Subject area" hint="Optional — descriptive only, it does not affect the payout.">
        <Input value={form.subjectCategory} onChange={(e) => patchForm({ subjectCategory: e.target.value })} />
      </Field>
    </div>
  )
}

/* ------------------------------------------------------------------------ */
/* Step 3 — Authors                                                         */
/* ------------------------------------------------------------------------ */

function AuthorsStep({
  form,
  patchForm,
}: {
  form: FormState
  patchForm: (updater: Partial<FormState> | ((prev: FormState) => Partial<FormState>)) => void
}) {
  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Total authors" hint="Including you.">
          <NumberInput
            value={form.totalAuthors}
            min={1}
            onChange={(e) => patchForm({ totalAuthors: Math.max(1, Number(e.target.value) || 1) })}
          />
        </Field>
        <Field label="Your author position" hint="1 if you are the first author.">
          <NumberInput
            value={form.authorPosition}
            min={1}
            onChange={(e) => patchForm({ authorPosition: Math.max(1, Number(e.target.value) || 1) })}
          />
        </Field>
      </div>

      {form.authorPosition > form.totalAuthors && (
        <Callout tone="critical">
          Your position cannot be after the last author — check the two numbers above.
        </Callout>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Your Scopus author profile" hint="The link to your author page on Scopus.">
          <Input
            value={form.scopusAuthorUrl}
            onChange={(e) => patchForm({ scopusAuthorUrl: e.target.value })}
          />
        </Field>
        <Field label="Your designation" hint="Optional — used on the ticket.">
          <Input value={form.designation} onChange={(e) => patchForm({ designation: e.target.value })} />
        </Field>
      </div>

      <div className="space-y-2">
        <p className="text-sm font-medium">Why this is being filed</p>
        <div className="space-y-2">
          <Radio
            name="claim-reason"
            checked={form.claimReason === "INCENTIVE"}
            onChange={() => patchForm({ claimReason: "INCENTIVE" })}
            label="Faculty publication incentive"
            hint="The usual case — this claims the remuneration."
          />
          <Radio
            name="claim-reason"
            checked={form.claimReason === "COUNT_ONLY"}
            onChange={() => patchForm({ claimReason: "COUNT_ONLY" })}
            label="Publication count only"
            hint="Records the paper without claiming any payment — no remuneration is calculated."
          />
        </div>
      </div>

      <Checkbox
        checked={form.affiliationOk}
        onCheckedChange={(v) => patchForm({ affiliationOk: v === true })}
        label="This article is affiliated to Saveetha Engineering College."
      />
    </div>
  )
}

/* ------------------------------------------------------------------------ */
/* Step 4 — Proof                                                           */
/* ------------------------------------------------------------------------ */

function ProofStep({
  form,
  uploadingKind,
  secWarning,
  onAdd,
  onRemove,
  onUpdate,
}: {
  form: FormState
  uploadingKind: AttachmentRow["kind"] | null
  secWarning: string | null
  onAdd: (kind: AttachmentRow["kind"], file: File) => void
  onRemove: (url: string) => void
  onUpdate: (url: string, patch: Partial<AttachmentRow>) => void
}) {
  const papers = form.attachments.filter((a) => a.kind === "PUBLISHED_PAPER")
  const refs = form.attachments.filter((a) => a.kind === "SEC_REFERENCE")

  return (
    <div className="space-y-8">
      <AttachmentGroup
        title="The published paper"
        hint="The full-length article as it appears in the journal (PDF, scan or photo)."
        kind="PUBLISHED_PAPER"
        rows={papers}
        busy={uploadingKind === "PUBLISHED_PAPER"}
        onAdd={onAdd}
        onRemove={onRemove}
      />

      <div className="space-y-3">
        <AttachmentGroup
          title="Cited references with SEC affiliation"
          hint="At least one reference in the paper that carries a Saveetha Engineering College affiliation."
          kind="SEC_REFERENCE"
          rows={refs}
          busy={uploadingKind === "SEC_REFERENCE"}
          onAdd={onAdd}
          onRemove={onRemove}
          renderExtra={(row) => (
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              <Input
                value={row.ref_number || ""}
                onChange={(e) => onUpdate(row.url, { ref_number: e.target.value })}
                placeholder="Reference number, e.g. 12"
                aria-label={`Reference number for ${row.filename}`}
              />
              <Input
                value={row.ref_title || ""}
                onChange={(e) => onUpdate(row.url, { ref_title: e.target.value })}
                placeholder="Reference title (optional)"
                aria-label={`Reference title for ${row.filename}`}
              />
            </div>
          )}
        />
        {secWarning && <Callout tone="caution">{secWarning}</Callout>}
      </div>
    </div>
  )
}

function AttachmentGroup({
  title,
  hint,
  kind,
  rows,
  busy,
  onAdd,
  onRemove,
  renderExtra,
}: {
  title: string
  hint: string
  kind: AttachmentRow["kind"]
  rows: AttachmentRow[]
  busy: boolean
  onAdd: (kind: AttachmentRow["kind"], file: File) => void
  onRemove: (url: string) => void
  renderExtra?: (row: AttachmentRow) => React.ReactNode
}) {
  const inputRef = useRef<HTMLInputElement>(null)

  return (
    <div className="space-y-2">
      <div>
        <p className="text-sm font-medium">{title}</p>
        <p className="text-xs text-fg-muted">{hint}</p>
      </div>

      {rows.length > 0 && (
        <ul className="divide-y divide-line border-y border-line">
          {rows.map((row) => (
            <li key={row.url} className="row px-1 py-2.5">
              <div className="flex items-start justify-between gap-3">
                <span className="flex min-w-0 items-start gap-2">
                  <Paperclip className="mt-0.5 size-4 shrink-0 text-fg-subtle" aria-hidden />
                  <span className="min-w-0">
                    <span className="block truncate text-sm">{row.filename}</span>
                    <Meta className="block">{formatBytes(row.size_bytes)}</Meta>
                  </span>
                </span>
                <Button
                  kind="quiet"
                  size="icon"
                  aria-label={`Remove ${row.filename}`}
                  onClick={() => onRemove(row.url)}
                >
                  <Trash2 className="text-critical" />
                </Button>
              </div>
              {renderExtra?.(row)}
            </li>
          ))}
        </ul>
      )}

      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT}
        className="sr-only"
        onChange={(e) => {
          const file = e.target.files?.[0]
          e.target.value = ""
          if (file) onAdd(kind, file)
        }}
      />
      <Button kind="default" size="sm" onClick={() => inputRef.current?.click()} disabled={busy}>
        {busy ? <LoaderCircle className="animate-spin" /> : <Upload />}
        {rows.length ? "Add another file" : "Upload a file"}
      </Button>
    </div>
  )
}

function formatBytes(bytes: number | null): string {
  if (bytes == null) return ""
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/* ------------------------------------------------------------------------ */
/* Step 5 — Check and file                                                  */
/* ------------------------------------------------------------------------ */

function ReviewStep({
  form,
  calc,
  calcBusy,
  priorCheck,
  priorCheckBusy,
  onRecheck,
  submitError,
  contestNote,
  onContestNoteChange,
  onSendAnyway,
  fileBusy,
}: {
  form: FormState
  calc: CalcResult | null
  calcBusy: boolean
  priorCheck: PriorCheckResult | null
  priorCheckBusy: boolean
  onRecheck: () => void
  submitError: string | null
  contestNote: string
  onContestNoteChange: (v: string) => void
  onSendAnyway: () => void
  fileBusy: boolean
}) {
  const contestable = submitError?.includes("Could not auto-confirm") ?? false

  return (
    <div className="space-y-8">
      {priorCheck?.warning && (
        <Callout tone="critical" title="This paper may already have been paid">
          <p>Check the matches below before filing — you can still go ahead once you have.</p>
          {priorCheck.matches.length > 0 && (
            <ul className="mt-2 space-y-1">
              {priorCheck.matches.map((m, i) => (
                <li key={i} className="text-sm">
                  {[m.reference, m.who, m.when].filter(Boolean).join(" · ") || "A prior payment"}
                  {m.amount != null && <> — {money(m.amount)}</>}
                </li>
              ))}
            </ul>
          )}
        </Callout>
      )}
      {!priorCheck?.warning && !priorCheckBusy && priorCheck && (
        <p className="text-sm text-fg-muted">No prior payment found for this paper.</p>
      )}
      <Button kind="quiet" size="sm" onClick={onRecheck} disabled={priorCheckBusy}>
        {priorCheckBusy ? <LoaderCircle className="animate-spin" /> : <Search />}
        Check again
      </Button>

      <section className="space-y-3">
        <SectionTitle>The paper</SectionTitle>
        <dl className="space-y-1.5 text-sm">
          <SummaryRow label="Title" value={form.paperTitle} />
          <SummaryRow label="DOI" value={form.doi} />
          <SummaryRow label="Type" value={form.publicationType} />
          <SummaryRow label="Published" value={form.publicationDate} />
          <SummaryRow label="Journal" value={form.journalTitle} />
          <SummaryRow label="ISSN" value={form.issn} />
          <SummaryRow label="Indexing" value={form.indexing.join(", ")} />
          <SummaryRow
            label="Authors"
            value={`Position ${form.authorPosition} of ${form.totalAuthors}`}
          />
          <SummaryRow
            label="Attached"
            value={`${form.attachments.filter((a) => a.kind === "PUBLISHED_PAPER").length} paper, ${form.attachments.filter((a) => a.kind === "SEC_REFERENCE").length} reference(s)`}
          />
        </dl>
      </section>

      <section className="space-y-3">
        <SectionTitle>Estimated remuneration</SectionTitle>

        {calcBusy && !calc ? (
          <p className="text-sm text-fg-muted">Working it out…</p>
        ) : calc?.error ? (
          <Callout tone="critical" title="This amount could not be worked out">
            {calc.error}
          </Callout>
        ) : calc ? (
          <div className="space-y-2">
            <p className="text-3xl font-semibold tabular">{money(calc.remuneration)}</p>
            <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-4">
              <SummaryRow label="Base amount" value={money(calc.base)} />
              <SummaryRow label="QF amount" value={money(calc.qf)} />
              <SummaryRow label="Author point" value={calc.point != null ? calc.point.toFixed(3) : "—"} />
              {calc.category_label && <SummaryRow label="Category" value={calc.category_label} />}
            </dl>
            {calc.note && <p className="text-sm text-fg-muted">{calc.note}</p>}
          </div>
        ) : (
          <p className="text-sm text-fg-muted">—</p>
        )}

        <Callout tone="caution" title="This is an estimate">
          It is worked out from the SNIP and quartile you declared, not a verified value. The
          research cell checks it separately once this is filed, and the figure may change.
        </Callout>
      </section>

      {submitError && (
        <Callout tone="critical" title="Could not file this paper">
          <p>{submitError}</p>
          {contestable && (
            <div className="mt-3 space-y-2">
              <Textarea
                value={contestNote}
                onChange={(e) => onContestNoteChange(e.target.value)}
                placeholder="Say why this should go through anyway (10 characters or more)."
                aria-label="Note explaining why to send this anyway"
                rows={2}
              />
              <Button
                kind="default"
                size="sm"
                disabled={contestNote.trim().length < 10 || fileBusy}
                onClick={onSendAnyway}
              >
                {fileBusy && <LoaderCircle className="animate-spin" />}
                Send anyway, with this note
              </Button>
            </div>
          )}
        </Callout>
      )}
    </div>
  )
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  if (!value) return null
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="shrink-0 text-fg-muted">{label}</dt>
      <dd className="min-w-0 truncate text-right">{value}</dd>
    </div>
  )
}
