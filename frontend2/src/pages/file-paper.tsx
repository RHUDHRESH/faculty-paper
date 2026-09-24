import { useEffect, useRef, useState } from "react"
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom"
import { AlertTriangle, ArrowLeft, Check, ExternalLink, LoaderCircle, Search } from "lucide-react"

import { useCollegeName } from "@/app/institution"
import { api, ApiError } from "@/lib/api"
import { cn } from "@/lib/cn"
import { useApi } from "@/lib/query"
import { Button } from "@/ui/button"
import { Combobox, type ComboboxOption } from "@/ui/combobox"
import { ConfirmDialog } from "@/ui/dialog"
import { ClaimEligibilityGate, ClaimRulesDialog } from "@/ui/eligibility"
import { Checkbox, DateInput, Field, Input, NumberInput, Radio, Textarea } from "@/ui/field"
import { stageOf } from "@/ui/paper"
import { Callout, EmptyState, ErrorState, SkeletonText } from "@/ui/state"
import { PageTitle, Sub } from "@/ui/text"
import { toast } from "@/ui/toast"
import { Wizard, type Step } from "@/ui/wizard"

import { AuthorList } from "./filing/authors"
import { SourceTag } from "./filing/bits"
import { EstimateBar, EstimatePanel } from "./filing/estimate"
import {
  CHECK_TARGET,
  FoundCard,
  FoundCardSkeleton,
  LookupProblem,
  PasteBox,
  ScopusProfilePicker,
} from "./filing/finder"
import {
  doiProblem,
  issnProblem,
  issnRepairNote,
  normaliseDoi,
  normaliseIssn,
  yearOf,
} from "./filing/identifiers"
import { applyLookup, type PaperLookup, type StoredAuthor } from "./filing/lookup"
import { AttachmentGroup, ReferenceFields, ReferenceTally } from "./filing/proof"
import { readiness, sameFileOnThisForm, type Problem } from "./filing/readiness"
import { ContestNote, EstimateDetail, PreFlight, PriorCheckLine, Receipt } from "./filing/receipt"
import { TeamPicker } from "./filing/team"
import {
  emptyForm,
  NO_CARRIED_EVIDENCE,
  RULE_FALLBACK,
  type AttachmentRow,
  type CalcResult,
  type CarriedEvidence,
  type FilingRules,
  type FormState,
  type PatchForm,
  type PriorCheckResult,
  type VerifyResult,
} from "./filing/types"
import { VerifyPanel } from "./filing/verify"

// The pieces the readiness tests and other screens import from here.
export { emptyForm, NO_CARRIED_EVIDENCE, RULE_FALLBACK, readiness }
export type { CarriedEvidence, FormState, Problem }

/* ------------------------------------------------------------------------ */
/* Server shapes — read out of backend/core/api, not guessed                */
/* ------------------------------------------------------------------------ */

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
  team: { code: string } | null
  affiliation_ok: boolean
  total_authors: number
  author_position: number
  authors_json?: string | null
  attachments: AttachmentRow[]
  /**
   * The legacy single-URL evidence columns. Read here, never sent —
   * `buildPayload` omits all three so the server keeps deriving them from the
   * attachment set. Read because the submission gate and the payout formula
   * disagree about them, and the disagreement costs the claimant the whole
   * payment (see `readiness`).
   */
  proof_url?: string | null
  sec_proof_url?: string | null
  sec_refs?: string | null
}

type MeProfile = {
  scopus_author_url?: string | null
  designation?: string | null
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

type UploadResult = {
  url: string
  filename: string
  size_bytes: number
  content_hash: string
  duplicate_of: {
    /** Which claim already holds this file. The endpoint matches against
     *  every stored attachment including this draft's own, so a file
     *  re-attached to the claim being edited comes back flagged. */
    claim_id: string
    ticket_number: string | null
    owner_name: string
    same_owner: boolean
  } | null
}

/** The little of a draft this screen needs to offer it back. */
type DraftRow = {
  id: string
  paper_title: string | null
  updated_at: string | null
}

function carriedFrom(c: ClaimDetail): CarriedEvidence {
  return {
    proofUrl: (c.proof_url || "").trim(),
    secProofUrl: (c.sec_proof_url || "").trim(),
    secRefs: (c.sec_refs || "").trim(),
  }
}

/** `authors_json` as this form writes it, or as an older import wrote it (a
 *  list of names). Anything else reads as no list, never as an error. */
function parseAuthors(raw: string | null | undefined): StoredAuthor[] {
  if (!raw) return []
  try {
    const value: unknown = JSON.parse(raw)
    if (!Array.isArray(value)) return []
    const out: StoredAuthor[] = []
    value.forEach((a, i) => {
      if (typeof a === "string" && a.trim()) out.push({ position: i + 1, name: a.trim() })
      else if (a && typeof a === "object" && typeof (a as StoredAuthor).name === "string") {
        const author = a as StoredAuthor
        out.push({ position: Number(author.position) || i + 1, name: author.name, college: author.college ?? null })
      }
    })
    return out
  } catch {
    return []
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
    authors: parseAuthors(c.authors_json),
    affiliationOk: c.affiliation_ok,
    claimReason:
      c.claim_reason === "COUNT_ONLY" || c.claim_reason === "STUDENT_PROJECT" ? c.claim_reason : "INCENTIVE",
    teamCode: c.team?.code || "",
    attachments: c.attachments.map((a) => ({
      kind: a.kind,
      url: a.url,
      filename: a.filename,
      size_bytes: a.size_bytes,
      ref_number: a.ref_number,
      ref_title: a.ref_title,
      // Carried rather than dropped: `_persist_attachments` rebuilds the rows
      // from the payload, so a hash left off here is erased on the next save.
      content_hash: a.content_hash,
    })),
  }
}

/** What the server accepts back. A field this screen does not manage is
 *  absent from the body, never nulled — sending `sec_refs: null` would
 *  overwrite a value the server derives from the attachments. */
function buildPayload(
  form: FormState,
  extra: {
    submit: boolean
    contest?: boolean
    contestNote?: string
    /** Whose paper this is, when somebody files it for them. Only ever sent on
     *  creation: a PATCH carrying it would move a claim to another person. */
    ownerId?: string | null
  }
) {
  return {
    ...(extra.ownerId ? { owner_id: extra.ownerId } : {}),
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
    // Only when there is a list: an author list written by an older import
    // in a shape this form cannot read is left as it is.
    ...(form.authors.length ? { authors_json: JSON.stringify(form.authors) } : {}),
    affiliation_ok: form.affiliationOk,
    claim_reason: form.claimReason,
    // Sent on every save, including empty, so dropping the student project
    // reason lets go of the team rather than leaving students attached.
    team_code: form.claimReason === "STUDENT_PROJECT" ? form.teamCode.trim() : "",
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

/** `body: formData` is the one shape `api()`'s `Options` type omits; the
 *  cast is the escape hatch, and the request still carries the CSRF header. */
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

// Exact tokens the server's category rules match on — `is_scopus_indexed` /
// `is_web_of_science` in backend/core/services/remuneration.py.
const INDEXING_OPTIONS = ["Scopus", "Web of Science", "AU Annexure", "UGC Care"] as const

const ACCEPTED_EXTENSIONS = [".pdf", ".png", ".jpg", ".jpeg", ".webp", ".gif", ".tif", ".tiff", ".doc", ".docx"]

/**
 * The five steps. The owner's rule: keep all five, and everything on them.
 * Each one refuses to be left while something the server will refuse is
 * missing from it, and says what beside the field that is missing it.
 */
const STEPS: Step[] = [
  { id: "paper", title: "The paper", hint: "Paste the DOI or link and most of the form fills itself." },
  { id: "journal", title: "The journal", hint: "Where it was published, and the figures it is paid on." },
  { id: "claim", title: "You and the claim", hint: "Your place among the authors, and the college on the paper." },
  { id: "proof", title: "The proof", hint: "The published paper and the cited references, as files." },
  { id: "file", title: "Check and file", hint: "Read it back once, then send it to the research cell." },
]

/** Which field on which step answers each readiness problem. */
const PROBLEM_FIELD: Record<string, string> = {
  title: "title",
  type: "type",
  date: "date",
  doi: "doi",
  year: "date",
  "not-indexed": "find",
  team: "reason",
  journal: "journal",
  issn: "issn",
  indexing: "indexing",
  au: "indexing",
  ugc: "indexing",
  yukthi: "yukthi",
  quartile: "standing",
  scopus: "scopus",
  linkage: "scopus",
  authors: "position",
  position: "position",
  "position-found": "position",
  "author-cap": "position",
  affiliation: "affiliation",
  "affiliation-found": "affiliation",
  "paper-file": "paper-file",
  "file-dup": "paper-file",
  "file-twice": "paper-file",
  "file-dup-ref": "refs",
  "file-twice-ref": "refs",
  "refs-none": "refs",
  "ref-numbers": "refs",
  "refs-url-only": "refs",
  "ref-numbers-zero": "refs",
  "ref-numbers-some": "refs",
  "refs-few": "refs",
  prior: "prior",
  calc: "estimate",
  "calc-failed": "estimate",
  zero: "estimate",
}

/** Put the keyboard and the eye on one field, by its `data-field` anchor. */
function focusField(field: string) {
  const anchor = document.querySelector<HTMLElement>(`[data-field="${field}"]`)
  if (!anchor) return
  const target =
    anchor.querySelector<HTMLElement>("input:not([type=file]):not([disabled]), textarea, button[role=combobox], button") ??
    anchor
  anchor.scrollIntoView?.({ block: "center", behavior: "smooth" })
  target.focus({ preventScroll: true })
}

/* ------------------------------------------------------------------------ */
/* FilePaper                                                                */
/* ------------------------------------------------------------------------ */

/**
 * The form that turns a publication into a payment claim.
 *
 * Serves `/papers/new` and `/papers/:id/edit` (a draft, or a paper sent back
 * for changes). Five steps, and the first starts with one box: paste the DOI
 * or a link and the paper, the journal, its quartile and SNIP from the
 * college's own tables, the authors and your place among them are filled in,
 * each named with where it came from. Everything the old ERP form lacked —
 * the duplicate check, the autosave, the estimate labelled as one — stays.
 */
export function FilePaper() {
  const collegeName = useCollegeName()
  const { id } = useParams<{ id?: string }>()
  const navigate = useNavigate()
  const isEditRoute = !!id

  /**
   * The draft was created on this screen, by its first autosave.
   *
   * That save moves the page to /papers/{id}/edit, and the edit route used to
   * treat it like a draft opened from the list: fetch it, put a skeleton
   * where the form was, then overwrite the form with the server's copy —
   * dropping anything typed in between. The form already holds the draft.
   */
  const [createdHere, setCreatedHere] = useState(false)
  /** A draft or sent-back paper opened to be edited, as opposed to one
   *  being filed now whose address merely changed at its first save. */
  const editingExisting = isEditRoute && !createdHere

  // Filing for somebody else, from /papers/new?for=<id>. Only on a claim
  // started here: an existing one already has an owner. Carried through the
  // first save's move to the edit address, or the page forgot whose paper it
  // was and matched the office user's own name against the authors.
  const [searchParams] = useSearchParams()
  const filingForId = editingExisting ? null : searchParams.get("for")
  const {
    data: filingFor,
    isLoading: loadingFilingFor,
    error: filingForError,
    refetch: refetchFilingFor,
  } = useApi<{ id: string; name: string; email: string; department: string | null }>(
    ["person", filingForId],
    `/api/admin/users/${filingForId}`,
    { enabled: !!filingForId }
  )

  const {
    data: existing,
    isLoading: loadingExisting,
    error: loadError,
    refetch: refetchExisting,
  } = useApi<ClaimDetail>(["claim", id], `/api/claims/${id}`, { enabled: editingExisting })

  const { data: me } = useApi<MeProfile>(["auth-me-full"], "/api/auth/me")
  const { data: fetchedRules } = useApi<FilingRules>(["meta", "filing-rules"], "/api/meta/filing-rules")
  const rules = fetchedRules ?? RULE_FALLBACK

  // What the source said the year was, and which source: a disagreement is
  // the single commonest reason a paper is sent back.
  const [indexedYear, setIndexedYear] = useState<number | null>(null)
  const [indexedYearSource, setIndexedYearSource] = useState<string | null>(null)

  // Drafts already going, offered before a second one is started by accident.
  const { data: draftList } = useApi<{ results: DraftRow[] }>(
    ["claims", "drafts"],
    "/api/claims?status=DRAFT&limit=5",
    { enabled: !isEditRoute }
  )
  const drafts = draftList?.results ?? []

  const [form, setForm] = useState<FormState>(emptyForm)

  /* ------------------------------ the steps ------------------------------ */

  const [step, setStep] = useState(0)
  // A reopened draft has been through every step once already.
  const [furthest, setFurthest] = useState(0)
  /** Steps whose Continue has been pressed: only these show their missing
   *  fields in red. A form that opens covered in errors is telling somebody
   *  off before they have typed a character. */
  const [attempted, setAttempted] = useState<Set<number>>(new Set())
  const [pendingFocus, setPendingFocus] = useState<{ field: string; nonce: number } | null>(null)

  function goTo(next: number, field?: string) {
    setStep(next)
    setFurthest((f) => Math.max(f, next))
    if (field) setPendingFocus({ field, nonce: Date.now() })
  }

  // After the step has painted — the wizard moves focus to the step's heading
  // first, and a jump to one field has to land on that field. Keyed on the
  // request alone (it is set in the same update as the step), so a later step
  // change does not replay an old jump over the new step's heading.
  useEffect(() => {
    if (!pendingFocus) return
    const frame = requestAnimationFrame(() => focusField(pendingFocus.field))
    return () => cancelAnimationFrame(frame)
  }, [pendingFocus])

  /**
   * Whether the eligibility confirmations have been ticked for *this* article.
   * Plain state: a remembered tick is how a duplicate claim gets filed a
   * second year running.
   */
  const [acknowledged, setAcknowledged] = useState(false)

  // The draft id is read from the ref by the autosave timer and the save
  // handler; the state half only re-renders once when the draft gets an id.
  const claimIdRef = useRef<string | null>(null)
  const [, setClaimId] = useState<string | null>(null)
  const dirtyRef = useRef(false)
  const [savingState, setSavingState] = useState<"idle" | "pending" | "saving" | "saved" | "error">("idle")
  const [lastSavedAt, setLastSavedAt] = useState<Date | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [, forceTick] = useState(0)

  const hydratedRef = useRef(false)
  const meAppliedRef = useRef(false)
  const [ticketNumber, setTicketNumber] = useState<string | null>(null)
  // What the server holds in proof_url / sec_proof_url / sec_refs, refreshed
  // from every save response: the server rewrites two of them on each save.
  const [carried, setCarried] = useState<CarriedEvidence>(NO_CARRIED_EVIDENCE)

  // "File another in this journal": the journal, never the paper.
  const copyId = isEditRoute ? null : searchParams.get("copy")
  const { data: copySource } = useApi<ClaimDetail>(["claim", copyId], `/api/claims/${copyId}`, {
    enabled: !!copyId,
  })
  const copiedRef = useRef(false)
  useEffect(() => {
    if (!copySource || copiedRef.current) return
    copiedRef.current = true
    const c = formFromClaim(copySource)
    setForm((prev) => ({
      ...prev,
      journalTitle: c.journalTitle,
      issn: c.issn,
      publicationType: c.publicationType,
      indexing: c.indexing,
      auAnnexureRef: c.auAnnexureRef,
      ugcCareRef: c.ugcCareRef,
      subjectCategory: c.subjectCategory,
      selfReportedQuartile: c.selfReportedQuartile,
      selfReportedSnip: c.selfReportedSnip,
      impactFactor: c.impactFactor,
      totalAuthors: c.totalAuthors,
      claimReason: c.claimReason,
    }))
    toast.info(
      `Started from ${copySource.journal_title || "your earlier claim"} — the journal is filled in; add this paper's own details and files.`
    )
  }, [copySource])

  // Pre-fill from the existing claim exactly once, without marking it dirty.
  useEffect(() => {
    if (!existing || hydratedRef.current) return
    hydratedRef.current = true
    setForm(formFromClaim(existing))
    setCarried(carriedFrom(existing))
    claimIdRef.current = existing.id
    setClaimId(existing.id)
    setTicketNumber(existing.ticket_number)
    setFurthest(STEPS.length - 1)
  }, [existing])

  // A new claim starts from the account's own Scopus link and designation.
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

  /** Every change goes through here: value, dirty flag, autosave. The updater
   *  form means a lookup arriving late never clobbers newer typing. */
  const patchForm: PatchForm = (updater) => {
    setForm((prev) => ({ ...prev, ...(typeof updater === "function" ? updater(prev) : updater) }))
    dirtyRef.current = true
    setSavingState("pending")
  }

  async function save() {
    setSavingState("saving")
    try {
      const payload = buildPayload(form, { submit: false, ownerId: filingFor?.id })
      let result: ClaimDetail
      if (claimIdRef.current) {
        result = await api<ClaimDetail>(`/api/claims/${claimIdRef.current}`, { method: "PATCH", json: payload })
      } else {
        result = await api<ClaimDetail>("/api/claims", { method: "POST", json: payload })
        claimIdRef.current = result.id
        setClaimId(result.id)
        setCreatedHere(true)
        hydratedRef.current = true
        setTicketNumber(result.ticket_number)
        // Replace, not push: Back from here lands on the list they came from.
        navigate(
          `/papers/${result.id}/edit${filingForId ? `?for=${encodeURIComponent(filingForId)}` : ""}`,
          { replace: true }
        )
      }
      setCarried(carriedFrom(result))
      dirtyRef.current = false
      setSaveError(null)
      setLastSavedAt(new Date())
      setSavingState("saved")
    } catch (err) {
      // Left dirty on purpose: the next edit tries again, and the banner
      // offers an explicit retry.
      setSaveError(err instanceof ApiError ? err.message : "The server did not answer. Your typing is still on this screen.")
      setSavingState("error")
    }
  }

  // The debounce: a burst of keystrokes becomes one request 2.5s after the last.
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

  // Tab close, refresh, or a typed address. In-app navigation cannot be
  // caught (`BrowserRouter` is not a data router); the page's own "My papers"
  // link is guarded by hand below.
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

  // Read by the async handlers, which resolve after more typing.
  const formRef = useRef(form)
  useEffect(() => {
    formRef.current = form
  }, [form])

  /* ------------------------------- lookup -------------------------------- */

  const [pasted, setPasted] = useState("")
  const [lookupBusy, setLookupBusy] = useState(false)
  const [lookupRes, setLookupRes] = useState<PaperLookup | null>(null)
  const [lookupError, setLookupError] = useState<string | null>(null)
  /** What the last lookup filled in, named back to the claimant. */
  const [filled, setFilled] = useState<string[]>([])

  async function findPaper(text?: string) {
    const query = (text ?? pasted).trim()
    if (!query) return
    if (text) setPasted(text)
    setLookupBusy(true)
    setLookupError(null)
    try {
      const res = await api<PaperLookup>("/api/lookup/paper", {
        method: "POST",
        json: { query, owner_id: filingFor?.id || undefined, claim_id: claimIdRef.current || undefined },
      })
      setLookupRes(res)
      if (res.ok && res.paper) {
        const { patch, filled: names } = applyLookup(formRef.current, res, { overwrite: true })
        if (Object.keys(patch).length) patchForm(patch)
        setFilled(names)
        setIndexedYear(res.paper.publication_year)
        setIndexedYearSource(res.field_sources.publication_year || null)
      } else {
        setFilled([])
      }
    } catch (err) {
      setLookupRes(null)
      setLookupError(
        err instanceof ApiError
          ? err.message
          : "The server did not answer. Fill the details in below — nothing you typed is lost."
      )
    } finally {
      setLookupBusy(false)
    }
  }

  const [scimago, setScimago] = useState<ScimagoResult | null>(null)
  const [scimagoBusy, setScimagoBusy] = useState(false)
  const [scimagoError, setScimagoError] = useState<string | null>(null)

  async function checkScimago() {
    setScimagoBusy(true)
    setScimagoError(null)
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
      if (res.found && res.matched_quartile) patchForm({ selfReportedQuartile: res.matched_quartile })
      else if (!res.found) setScimagoError(res.message || "No match in the Scimago data — set the quartile yourself.")
    } catch (err) {
      setScimagoError(err instanceof ApiError ? err.message : "Could not look this up. Set the quartile yourself.")
    } finally {
      setScimagoBusy(false)
    }
  }

  /* ------------------------------- proof --------------------------------- */

  const [uploadingKind, setUploadingKind] = useState<AttachmentRow["kind"] | null>(null)

  async function addAttachment(kind: AttachmentRow["kind"], file: File) {
    // Said before a byte is sent: a 40 MB scan used to upload in full and
    // only then be refused.
    const ext = `.${(file.name.split(".").pop() || "").toLowerCase()}`
    if (!ACCEPTED_EXTENSIONS.includes(ext)) {
      toast.fail(new Error(`${file.name} is not a file this form takes — use a PDF, an image or a Word document.`))
      return
    }
    if (file.size > rules.max_upload_bytes) {
      toast.fail(
        new Error(
          `${file.name} is ${(file.size / 1024 / 1024).toFixed(1)} MB; the limit is ${Math.round(rules.max_upload_bytes / 1024 / 1024)} MB. Save just the relevant pages and try again.`
        )
      )
      return
    }
    setUploadingKind(kind)
    try {
      const res = await uploadAttachment(file)
      // A match on this same claim is a mis-drop, said by the on-form check;
      // a match on a *different* ticket stays, as a warning.
      const elsewhere =
        res.duplicate_of && res.duplicate_of.claim_id !== claimIdRef.current
          ? {
              ticket_number: res.duplicate_of.ticket_number,
              owner_name: res.duplicate_of.owner_name,
              same_owner: res.duplicate_of.same_owner,
            }
          : null
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
            duplicateOf: elsewhere,
          },
        ],
      }))
    } catch (err) {
      toast.fail(err, `Could not upload ${file.name}.`)
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

  /* --------------------------- duplicate check --------------------------- */

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
      // Not blocking; the server checks again on file, and "Check again" retries.
    } finally {
      setPriorCheckBusy(false)
    }
  }

  // As soon as there is a DOI or a title: finding out on the last step that
  // this was paid for in 2023 wastes every step before it.
  const priorKeyRef = useRef("")
  useEffect(() => {
    const key = `${form.doi.trim()}|${form.paperTitle.trim()}`
    if (key === "|" || key === priorKeyRef.current) return
    const t = setTimeout(() => {
      priorKeyRef.current = key
      void runPriorCheck()
    }, 700)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.doi, form.paperTitle])

  /* ---------------------------- verification ----------------------------- */

  const [verify, setVerify] = useState<VerifyResult | null>(null)
  const [verifyBusy, setVerifyBusy] = useState(false)
  const [verifyError, setVerifyError] = useState<string | null>(null)

  async function runVerify() {
    const snapshot = formRef.current
    const title = snapshot.paperTitle.trim()
    if (!title) {
      setVerifyError("There is no title to check yet.")
      return
    }
    setVerifyBusy(true)
    setVerifyError(null)
    try {
      const res = await api<VerifyResult>("/api/lookup/verify", {
        method: "POST",
        json: {
          title,
          issn: snapshot.issn.trim() ? normaliseIssn(snapshot.issn) : null,
          scopus_author_url: snapshot.scopusAuthorUrl.trim() || null,
          exclude_claim_id: claimIdRef.current,
        },
      })
      setVerify(res)
      // Byte for byte what /prior/check returns: the fresher answer wins.
      if (res.paid) {
        setPriorCheck(res.paid)
        priorKeyRef.current = `${snapshot.doi.trim()}|${title}`
      }
    } catch (err) {
      setVerify(null)
      setVerifyError(
        err instanceof ApiError && err.status === 403
          ? `${err.message} Filing is unaffected — the research cell runs the same check.`
          : err instanceof ApiError
            ? err.message
            : "The check could not be run. Nothing about your claim is wrong, and filing still works."
      )
    } finally {
      setVerifyBusy(false)
    }
  }

  // On arriving at the last step, and again only if what it is about changed.
  const verifyKeyRef = useRef("")
  useEffect(() => {
    if (step !== 4) return
    const title = form.paperTitle.trim()
    if (!title) return
    const key = `${title}|${form.issn.trim()}|${form.scopusAuthorUrl.trim()}`
    if (key === verifyKeyRef.current) return
    verifyKeyRef.current = key
    void runVerify()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, form.paperTitle, form.issn, form.scopusAuthorUrl])

  /* ------------------------------ estimate ------------------------------- */

  const [calc, setCalc] = useState<CalcResult | null>(null)
  const [calcBusy, setCalcBusy] = useState(false)
  // "Could not price it" and "not enough entered to price it" are different
  // sentences on a screen about money.
  const [calcFailed, setCalcFailed] = useState(false)
  const [calcNonce, setCalcNonce] = useState(0)

  const secReferenceCount = form.attachments.filter(
    (a) => a.kind === "SEC_REFERENCE" && (a.ref_number || "").trim()
  ).length
  // The references are attached on the proof step. Until the claimant has
  // reached it (or attached one), the estimate assumes the policy's minimum
  // will be there and says so — pricing the first three steps with none
  // attached showed ₹0 and offered to file the paper "for the record".
  const assumeReferences =
    furthest < 3 && !form.attachments.some((a) => a.kind === "SEC_REFERENCE") && !carried.secProofUrl
  const referencesPriced = assumeReferences
    ? Math.max(secReferenceCount, rules.min_sec_references)
    : secReferenceCount

  // The Engineering classification from our tables, when the journal on the
  // form is still the one the lookup found. The policy withholds the quartile
  // incentive from a journal nobody has classified.
  const lookupMetrics = lookupRes?.ok ? lookupRes.metrics : null
  const engineeringClass =
    lookupMetrics?.found &&
    lookupRes?.paper?.issn &&
    normaliseIssn(form.issn) === normaliseIssn(lookupRes.paper.issn)
      ? lookupMetrics.engineering_class
      : null

  const priceable =
    form.totalAuthors >= 1 &&
    Boolean(form.selfReportedQuartile || form.selfReportedSnip.trim() || form.indexing.length || form.publicationType)

  const calcRunRef = useRef(0)
  useEffect(() => {
    if (!priceable) return
    setCalcBusy(true)
    const run = ++calcRunRef.current
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
          engineering_class: engineeringClass || undefined,
          sec_reference_count: referencesPriced,
        },
      })
        // Guarded on the run number: a slow reply to an earlier keystroke must
        // not overwrite a newer figure.
        .then((res) => {
          if (run !== calcRunRef.current) return
          setCalc(res)
          setCalcFailed(false)
        })
        .catch(() => {
          if (run !== calcRunRef.current) return
          setCalc(null)
          setCalcFailed(true)
        })
        .finally(() => {
          if (run === calcRunRef.current) setCalcBusy(false)
        })
    }, 300)
    return () => clearTimeout(t)
  }, [
    priceable,
    calcNonce,
    form.selfReportedSnip,
    form.selfReportedQuartile,
    form.totalAuthors,
    form.authorPosition,
    form.publicationType,
    form.indexing,
    form.claimReason,
    engineeringClass,
    referencesPriced,
  ])

  /* ------------------------------- filing -------------------------------- */

  const [confirmFile, setConfirmFile] = useState(false)
  const [fileBusy, setFileBusy] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [contestNote, setContestNote] = useState("")

  // No Scopus here: the server cannot confirm indexing on its own and will
  // ask for a note, so the note is asked for first.
  const scopusOff =
    verify?.scopus_status === "not_configured" || (!verify && lookupRes?.scopus_status === "not_configured")

  async function fileNow(opts: { contest?: boolean } = {}) {
    setFileBusy(true)
    setSubmitError(null)
    const contest = opts.contest ?? (scopusOff && contestNote.trim().length >= 10)
    try {
      const payload = buildPayload(form, { submit: true, contest, contestNote, ownerId: filingFor?.id })
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
      setSubmitError(err instanceof ApiError ? err.message : "Could not file this paper. Try again.")
      setPendingFocus({ field: "contest", nonce: Date.now() })
    } finally {
      setFileBusy(false)
    }
  }

  /* ------------------------------ readiness ------------------------------ */

  const lookupClaimant = lookupRes?.ok ? lookupRes.claimant : null
  const problems = readiness(form, rules, {
    calc,
    calcFailed,
    priorWarning: Boolean(priorCheck?.warning),
    indexedYear,
    indexedYearSource,
    carried,
    // `verify.ok` throughout: a result whose Scopus call failed carries every
    // block at its default, and reading those as findings would turn an
    // outage into accusations about the claimant's paper.
    scimagoQuartile: scimago?.found
      ? scimago.matched_quartile || null
      : verify?.ok && verify.scimago.found
        ? verify.scimago.quartile || null
        : lookupMetrics?.quartile || null,
    scopusConfirmed: Boolean(lookupRes?.paper?.eid) || Boolean(verify?.ok && verify.scopus.indexed),
    linkedToAuthor: verify?.ok && verify.scopus.indexed && form.scopusAuthorUrl.trim() ? verify.scopus.linked : null,
    verifiedIndexed: verify?.ok ? verify.scopus.indexed : null,
    lookupPosition:
      lookupClaimant && (lookupClaimant.confidence === "exact" || lookupClaimant.confidence === "likely")
        ? lookupClaimant.position
        : null,
    lookupAffiliation: lookupRes?.ok ? lookupRes.affiliation : null,
    collegeName,
  })

  /** The reason beside a field, once its step's Continue has been pressed. */
  function err(...keys: string[]): string | undefined {
    const p = problems.find((x) => x.kind === "missing" && keys.includes(x.key))
    return p && attempted.has(p.step) ? p.label : undefined
  }

  function blockingOn(i: number): Problem[] {
    return problems.filter((p) => p.kind === "missing" && (i === STEPS.length - 1 || p.step === i))
  }

  function validate(i: number): string | null {
    const blocking = blockingOn(i)
    if (!blocking.length) return null
    setAttempted((prev) => new Set([...prev, i, ...blocking.map((b) => b.step)]))
    const first = blocking[0]
    if (first.step === i) setPendingFocus({ field: PROBLEM_FIELD[first.key] ?? first.key, nonce: Date.now() })
    if (i === STEPS.length - 1) {
      return `Before this can be filed: ${first.label.charAt(0).toLowerCase()}${first.label.slice(1)}. It is marked on the ${STEPS[first.step].title.toLowerCase()} step.`
    }
    return blocking.length === 1 ? `${first.label}.` : "Answer the questions marked above to carry on."
  }

  function goToProblem(p: Problem) {
    goTo(p.step, PROBLEM_FIELD[p.key] ?? p.key)
  }

  /** A paper the policy will not pay for can still be worth recording. */
  function fileForTheRecord() {
    patchForm({ claimReason: "COUNT_ONLY" })
    goTo(0, "reason")
    toast.info("Switched to a count-only claim — the publication is recorded, with no payment.")
  }

  // Ctrl Enter continues, from inside a text box too. Not on the last step:
  // filing keeps its own button and dialog.
  const advance = useRef(() => {})
  advance.current = () => {
    if (validate(step) === null) goTo(step + 1)
  }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && step < STEPS.length - 1 && !fileBusy) {
        e.preventDefault()
        advance.current()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [step, fileBusy])

  /* ------------------------------- render -------------------------------- */

  // A form rendered while its data is on the way, or after it failed, looks
  // finished and files the wrong thing.
  if (editingExisting && loadingExisting) {
    return (
      <div className="page space-y-8 py-8">
        <SkeletonText lines={6} />
      </div>
    )
  }
  if (filingForId && loadingFilingFor) {
    return (
      <div className="page space-y-8 py-8">
        <SkeletonText lines={4} />
      </div>
    )
  }
  if (filingForId && filingForError) {
    // Falling through would file the claim under the wrong person's name.
    return (
      <div className="page py-8">
        <ErrorState
          title={filingForError.status === 404 ? "That person could not be found" : "Could not check whose paper this is"}
          message={
            filingForError.status === 404
              ? "The link names an account that no longer exists. File from their profile, or file this as your own paper."
              : "The claim would be filed under your own name instead of theirs, so nothing is being shown until this is settled."
          }
          onRetry={() => void refetchFilingFor()}
        />
      </div>
    )
  }
  if (editingExisting && loadError) {
    if (loadError.status === 404) {
      return (
        <div className="page py-8">
          <ErrorState title="This paper does not exist" message="It may have been withdrawn, or the link is wrong." />
        </div>
      )
    }
    if (loadError.status === 403) {
      return (
        <div className="page py-8">
          <ErrorState title="This paper is not yours" message="You can only edit a paper you filed yourself." />
        </div>
      )
    }
    return (
      <div className="page py-8">
        <ErrorState onRetry={() => void refetchExisting()} />
      </div>
    )
  }
  if (editingExisting && existing && existing.status !== "DRAFT" && existing.status !== "REJECTED") {
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

  // Drafts already going — shown on the gate too, because "not claimed
  // before" is one of its confirmations and their own draft is the likeliest
  // answer to it.
  const draftsNotice =
    !isEditRoute && !filingFor && drafts.length > 0 ? (
      <Callout tone="info" title={`You have ${drafts.length === 1 ? "a draft" : `${drafts.length} drafts`} already started`}>
        <ul className="mt-1 space-y-1">
          {drafts.slice(0, 3).map((d) => (
            <li key={d.id}>
              <Link to={`/papers/${d.id}/edit`} className="text-sm underline-offset-2 hover:underline">
                {d.paper_title?.trim() || "Untitled draft"}
              </Link>
            </li>
          ))}
        </ul>
        <p className="mt-2 text-sm text-fg-muted">
          Carrying on with one of those keeps everything already filled in. Starting here makes a separate paper.
        </p>
      </Callout>
    ) : null

  // The conditions are the ticket's own preconditions, read before the form
  // exists. Skipped for a draft being edited and when filing on somebody
  // else's behalf: the confirmations are in the first person.
  if (!acknowledged && !isEditRoute && !filingFor) {
    return (
      <div className="page space-y-6 py-8">
        <div>
          <button
            type="button"
            onClick={() => navigate("/papers")}
            className="inline-flex items-center gap-1 text-sm text-fg-muted hover:text-fg"
          >
            <ArrowLeft className="size-3.5" aria-hidden />
            My papers
          </button>
          <PageTitle className="mt-2">File a paper</PageTitle>
          <Sub className="mt-1">Read the conditions, then confirm three things. The form opens after that.</Sub>
        </div>
        {draftsNotice}
        <ClaimEligibilityGate
          minReferences={rules.min_sec_references}
          onAcknowledge={() => setAcknowledged(true)}
          onCancel={() => navigate("/papers")}
          cancelLabel="Not yet — back to my papers"
        />
      </div>
    )
  }

  const countOnly = form.claimReason === "COUNT_ONLY"
  const estimateProps = {
    calc,
    calcBusy,
    calcFailed,
    priceable,
    countOnly,
    problems,
    onRetryCalc: () => setCalcNonce((n) => n + 1),
    onGoToProblem: goToProblem,
    onFileAsCount: fileForTheRecord,
    assumedReferences: assumeReferences && !countOnly ? rules.min_sec_references : null,
  }

  return (
    <div className="page space-y-5 pb-16 pt-6 md:pt-8">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
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
            {editingExisting
              ? ticketNumber
                ? `Edit ticket ${ticketNumber}`
                : "Edit your draft"
              : filingFor
                ? `File a paper for ${filingFor.name}`
                : "File a paper"}
          </PageTitle>
          <Sub className="mt-1">
            {filingFor
              ? "The claim will be theirs, not yours — it goes on their record and is paid to them."
              : "Five steps. Paste the DOI at the start and most of them fill themselves."}
          </Sub>
        </div>
        <SaveStatus state={savingState} lastSavedAt={lastSavedAt} onRetry={() => void save()} />
      </header>

      {/* Not a grey line in the header: a claimant typing past a failed save
          loses the lot. */}
      {savingState === "error" && (
        <Callout tone="critical" title="Your changes are not being saved">
          <p>
            {saveError || "The server did not answer."} Nothing typed here has been lost yet, but it only
            exists in this browser tab — do not close it until this saves.
          </p>
          <Button kind="default" size="sm" className="mt-2" onClick={() => void save()}>
            Try saving again
          </Button>
        </Callout>
      )}

      {filingFor && (
        <Callout tone="info" title={`Filing on behalf of ${filingFor.name}`}>
          {filingFor.email}
          {filingFor.department ? ` · ${filingFor.department}` : ""}. The ticket will be raised in their
          name, and the payment goes to them.
        </Callout>
      )}

      {draftsNotice}

      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-fg-muted">
        <AlertTriangle className="size-3.5 shrink-0 text-caution" aria-hidden />
        <span>
          File once the article is in Scopus and on your author profile, with {collegeName} printed as
          the affiliation. One claim per article.
        </span>
        <ClaimRulesDialog
          minReferences={rules.min_sec_references}
          trigger={
            <button type="button" className="font-medium text-accent underline underline-offset-2">
              Read the full conditions
            </button>
          }
        />
      </p>

      <EstimateBar {...estimateProps} />

      <Wizard
        steps={STEPS}
        current={step}
        furthest={furthest}
        onCurrentChange={(i) => goTo(i)}
        validate={validate}
        onFinish={() => setConfirmFile(true)}
        finishLabel="File this paper"
        nextLabel="Continue"
        busy={fileBusy}
        aside={<EstimatePanel {...estimateProps} />}
        footerNote={savingState === "error" ? "Not saved — see above" : "Saved as you go. Going back changes nothing."}
      >
        {step === 0 && (
          <PaperStep
            form={form}
            patchForm={patchForm}
            err={err}
            pasted={pasted}
            onPasted={setPasted}
            onFind={(text) => void findPaper(text)}
            lookupBusy={lookupBusy}
            lookupRes={lookupRes}
            lookupError={lookupError}
            filled={filled}
            ownerId={filingFor?.id}
            onJump={(key) => {
              const target = CHECK_TARGET[key]
              if (target) goTo(target.step, target.field)
            }}
          />
        )}
        {step === 1 && (
          <JournalStep
            form={form}
            patchForm={patchForm}
            err={err}
            lookupRes={lookupRes}
            scimago={scimago}
            scimagoBusy={scimagoBusy}
            scimagoError={scimagoError}
            onCheckScimago={() => void checkScimago()}
          />
        )}
        {step === 2 && <ClaimStep form={form} patchForm={patchForm} err={err} lookupRes={lookupRes} />}
        {step === 3 && (
          <ProofStep
            form={form}
            rules={rules}
            carried={carried}
            err={err}
            uploadingKind={uploadingKind}
            onAdd={addAttachment}
            onRemove={removeAttachment}
            onUpdate={updateAttachment}
            ownerId={filingFor?.id}
          />
        )}
        {step === 4 && (
          <div className="space-y-8">
            <Receipt form={form} calc={calc} countOnly={countOnly} onChange={(s, field) => goTo(s, field)} />
            <section className="space-y-3" data-field={verify ? "prior" : "verify"}>
              <h3 className="text-base font-semibold">Does it check out?</h3>
              <VerifyPanel
                form={form}
                result={verify}
                busy={verifyBusy}
                error={verifyError}
                metrics={lookupMetrics}
                onRun={() => void runVerify()}
                onGoToProfile={() => goTo(2, "scopus")}
              />
            </section>
            <PreFlight problems={problems} rules={rules} form={form} onGoToProblem={goToProblem} />
            {/* The check above answers this too, from the same query; said
                separately only when that check could not run. */}
            {!verify && (
              <section className="space-y-3" data-field="prior">
                <h3 className="text-base font-semibold">Paid before?</h3>
                <PriorCheckLine priorCheck={priorCheck} busy={priorCheckBusy} onRecheck={() => void runPriorCheck()} />
              </section>
            )}
            <section className="space-y-3" data-field="estimate">
              <h3 className="text-base font-semibold">How the estimate is worked out</h3>
              <EstimateDetail
                calc={calc}
                calcBusy={calcBusy}
                calcFailed={calcFailed}
                priceable={priceable}
                countOnly={countOnly}
                problems={problems}
                onRetryCalc={() => setCalcNonce((n) => n + 1)}
              />
            </section>
            <ContestNote
              value={contestNote}
              onChange={setContestNote}
              expected={scopusOff}
              submitError={submitError}
              busy={fileBusy}
              onSendAnyway={() => void fileNow({ contest: true })}
            />
          </div>
        )}
      </Wizard>

      <ConfirmDialog
        open={confirmFile}
        onOpenChange={setConfirmFile}
        title="File this paper?"
        description={
          scopusOff && contestNote.trim().length < 10
            ? "It goes to the research cell to be checked. Scopus is not connected here, so filing will ask for a one-line note — you can add it on the next screen."
            : "Once filed it leaves your hands and goes to the research cell to be checked. A ticket number appears as soon as it is filed."
        }
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
/* Save status                                                              */
/* ------------------------------------------------------------------------ */

/**
 * Whether the draft is safe, in one line. `pending` is rendered as its own
 * state: "Saved 4 minutes ago" between a keystroke and the debounce is a true
 * sentence about an older version and a false one about the paragraph typed.
 */
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
      <div role="alert" className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-medium text-critical">
        <AlertTriangle className="size-4 shrink-0" aria-hidden />
        Not saved
        <button type="button" onClick={onRetry} className="font-medium underline underline-offset-2">
          Retry
        </button>
      </div>
    )
  }
  const body =
    state === "saving" ? (
      <>
        <LoaderCircle className="size-3.5 shrink-0 animate-spin" aria-hidden />
        Saving…
      </>
    ) : state === "pending" ? (
      <>
        <span className="size-2 shrink-0 rounded-full bg-caution" aria-hidden />
        Unsaved changes — saving in a moment
      </>
    ) : lastSavedAt ? (
      <>
        <Check className="size-3.5 shrink-0 text-positive" aria-hidden />
        Saved {relativeTime(lastSavedAt)}
      </>
    ) : (
      <>Nothing to save yet — it saves itself as you type</>
    )
  return (
    <span
      role="status"
      aria-live="polite"
      className={cn("flex flex-wrap items-center gap-1.5 text-sm", state === "pending" ? "text-fg" : "text-fg-muted")}
    >
      {body}
    </span>
  )
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

type Err = (...keys: string[]) => string | undefined

/* ------------------------------------------------------------------------ */
/* Step 1 — the paper                                                        */
/* ------------------------------------------------------------------------ */

function PaperStep({
  form,
  patchForm,
  err,
  pasted,
  onPasted,
  onFind,
  lookupBusy,
  lookupRes,
  lookupError,
  filled,
  ownerId,
  onJump,
}: {
  form: FormState
  patchForm: PatchForm
  err: Err
  pasted: string
  onPasted: (v: string) => void
  onFind: (text?: string) => void
  lookupBusy: boolean
  lookupRes: PaperLookup | null
  lookupError: string | null
  filled: string[]
  ownerId?: string | null
  onJump: (key: string) => void
}) {
  const collegeName = useCollegeName()
  const src = lookupRes?.ok ? lookupRes.field_sources : {}
  const doiIssue = doiProblem(form.doi)

  return (
    <div className="space-y-6">
      <div className="space-y-3 rounded-lg bg-accent-wash/60 p-4 ring-1 ring-inset ring-accent-line" data-field="find">
        <PasteBox value={pasted} onChange={onPasted} onFind={() => onFind()} busy={lookupBusy} />
        <ScopusProfilePicker scopusAuthorUrl={form.scopusAuthorUrl} ownerId={ownerId} onPick={(v) => onFind(v)} />
      </div>

      {lookupBusy ? (
        <FoundCardSkeleton />
      ) : lookupRes?.ok ? (
        <FoundCard res={lookupRes} filled={filled} collegeName={collegeName} onJump={onJump} />
      ) : (
        <LookupProblem res={lookupRes} error={lookupError} onPick={(doi) => onFind(doi)} />
      )}

      <fieldset className="space-y-2" data-field="reason">
        <legend className="mb-2 text-base font-medium">What are you filing this for?</legend>
        <Radio
          name="claim-reason"
          checked={form.claimReason === "INCENTIVE"}
          onChange={() => patchForm({ claimReason: "INCENTIVE" })}
          label="Faculty publication incentive"
          hint="The usual case — this claims the remuneration."
        />
        <Radio
          name="claim-reason"
          checked={form.claimReason === "STUDENT_PROJECT"}
          onChange={() => patchForm({ claimReason: "STUDENT_PROJECT" })}
          label="Student project conference incentive"
          hint="A conference paper from a student project you mentored. Paid — and it has to name the team."
        />
        <Radio
          name="claim-reason"
          checked={form.claimReason === "COUNT_ONLY"}
          onChange={() => patchForm({ claimReason: "COUNT_ONLY" })}
          label="Publication count only"
          hint="Records the paper without claiming any payment. You will not be asked for the quartile or the SNIP."
        />
      </fieldset>
      {form.claimReason === "STUDENT_PROJECT" && (
        <TeamPicker code={form.teamCode} onCode={(teamCode) => patchForm({ teamCode })} error={err("team")} />
      )}

      <div className="space-y-4">
        <p className="text-base font-medium">The paper's details</p>
        <div data-field="title">
          <Field label="Paper title" error={err("title")}>
            <Textarea
              value={form.paperTitle}
              onChange={(e) => patchForm({ paperTitle: e.target.value })}
              rows={2}
              maxRows={4}
            />
          </Field>
          <SourceTag source={src.title} className="mt-1 block" />
        </div>
        <div data-field="doi">
          <Field label="DOI" hint="Tidied up for you if you paste the whole address." error={doiIssue ?? undefined}>
            <Input
              value={form.doi}
              onChange={(e) => patchForm({ doi: e.target.value })}
              onBlur={(e) => {
                const tidy = normaliseDoi(e.target.value)
                if (tidy !== e.target.value) patchForm({ doi: tidy })
              }}
              placeholder="10.1000/xyz123"
              spellCheck={false}
            />
          </Field>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div data-field="type">
            <Field label="Type of publication" error={err("type")}>
              <Combobox
                value={form.publicationType || null}
                onChange={(v) => patchForm({ publicationType: v })}
                options={PUBLICATION_TYPES}
                placeholder="Select…"
              />
            </Field>
            <SourceTag source={src.publication_type} className="mt-1 block" />
          </div>
          <div data-field="date">
            <Field
              label="Date published"
              hint="Online-first and print dates often differ. Use the one the index carries."
              error={err("date")}
            >
              <DateInput
                value={form.publicationDate}
                onChange={(e) => patchForm({ publicationDate: e.target.value })}
              />
            </Field>
            <SourceTag source={form.publicationDate ? src.publication_date : null} className="mt-1 block" />
          </div>
        </div>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------------ */
/* Step 2 — the journal                                                     */
/* ------------------------------------------------------------------------ */

function JournalStep({
  form,
  patchForm,
  err,
  lookupRes,
  scimago,
  scimagoBusy,
  scimagoError,
  onCheckScimago,
}: {
  form: FormState
  patchForm: PatchForm
  err: Err
  lookupRes: PaperLookup | null
  scimago: ScimagoResult | null
  scimagoBusy: boolean
  scimagoError: string | null
  onCheckScimago: () => void
}) {
  const src = lookupRes?.ok ? lookupRes.field_sources : {}
  const metrics = lookupRes?.ok ? lookupRes.metrics : null
  const countOnly = form.claimReason === "COUNT_ONLY"

  function toggleIndexing(opt: string) {
    patchForm((prev) => ({
      indexing: prev.indexing.includes(opt) ? prev.indexing.filter((x) => x !== opt) : [...prev.indexing, opt],
    }))
  }

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_12rem]">
        <div data-field="journal">
          <Field label="Journal title" error={err("journal")}>
            <Input value={form.journalTitle} onChange={(e) => patchForm({ journalTitle: e.target.value })} />
          </Field>
          <SourceTag source={src.journal} className="mt-1 block" />
        </div>
        <div data-field="issn">
          <Field label="ISSN" hint="Print or online." error={err("issn") ?? issnProblem(form.issn) ?? undefined}>
            <Input
              value={form.issn}
              onChange={(e) => patchForm({ issn: e.target.value })}
              onBlur={(e) => {
                // Eight characters with the hyphen where it belongs; a repair
                // is a guess, so it is said out loud.
                const note = issnRepairNote(e.target.value)
                const tidy = normaliseIssn(e.target.value)
                if (tidy !== e.target.value) patchForm({ issn: tidy })
                if (note) toast.info(note)
              }}
              inputMode="text"
              spellCheck={false}
            />
          </Field>
          <SourceTag source={src.issn} className="mt-1 block" />
        </div>
      </div>

      <fieldset className="space-y-3" data-field="indexing">
        <legend className="text-base font-medium">Where is the journal indexed?</legend>
        <p className="-mt-1 text-sm text-fg-muted">Tick every one that applies. It decides the category the paper is priced in.</p>
        <div className="flex flex-wrap gap-x-6 gap-y-2">
          {INDEXING_OPTIONS.map((opt) => (
            <Checkbox
              key={opt}
              checked={form.indexing.includes(opt)}
              onCheckedChange={() => toggleIndexing(opt)}
              label={opt}
              aria-invalid={err("indexing") ? true : undefined}
            />
          ))}
        </div>
        {err("indexing") && (
          <p role="alert" className="text-xs text-critical">
            {err("indexing")}
          </p>
        )}
        {form.indexing.includes("Scopus") && metrics?.snip != null && (
          <p className="text-xs text-fg-muted">Scopus is ticked because the journal carries a Scopus SNIP.</p>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          {form.indexing.includes("AU Annexure") && (
            <Field label="AU Annexure reference number" hint="NA if there is none." error={err("au")}>
              <Input value={form.auAnnexureRef} onChange={(e) => patchForm({ auAnnexureRef: e.target.value })} />
            </Field>
          )}
          {form.indexing.includes("UGC Care") && (
            <Field label="UGC Care reference number" hint="NA if there is none." error={err("ugc")}>
              <Input value={form.ugcCareRef} onChange={(e) => patchForm({ ugcCareRef: e.target.value })} />
            </Field>
          )}
        </div>
      </fieldset>

      <div data-field="yukthi" className="max-w-xs">
        <Field label="Yukthi ID" hint="NA if there is none." error={err("yukthi")}>
          <Input value={form.yukthiId} onChange={(e) => patchForm({ yukthiId: e.target.value })} />
        </Field>
      </div>

      {!countOnly && (
        <section className="space-y-3" data-field="standing">
          <p className="text-base font-medium">The journal's quartile and SNIP</p>
          <p className="-mt-2 text-sm text-fg-muted">The two figures the payout is worked out from.</p>
          {metrics?.found ? (
            <p className="text-sm">
              Our journal data{metrics.dataset_year ? ` (${metrics.dataset_year})` : ""} holds{" "}
              <span className="font-medium">{metrics.journal}</span>
              {metrics.quartile ? ` as ${metrics.quartile}` : ""}
              {metrics.snip != null ? `, SNIP ${metrics.snip}` : ""}
              {metrics.engineering_class ? `, classified ${metrics.engineering_class}` : ""}.
              {metrics.matched_by === "title" && " Matched by name — check it is the same journal."}
            </p>
          ) : (
            <div className="flex flex-wrap items-center gap-3">
              <Button kind="default" onClick={onCheckScimago} disabled={scimagoBusy}>
                {scimagoBusy ? <LoaderCircle className="animate-spin" /> : <Search />}
                {scimagoBusy ? "Checking…" : "Look up the quartile in Scimago"}
              </Button>
              <span className="text-sm text-fg-muted">From the journal's ISSN.</span>
            </div>
          )}
          {scimago?.found && (
            <p className="text-sm text-fg-muted">
              Scimago has this as {scimago.matched_quartile || "an unranked title"}
              {scimago.sjr != null && `, SJR ${scimago.sjr}`}
              {scimago.dataset_year && ` (${scimago.dataset_year} data)`}.{" "}
              {scimago.official_url && (
                <a
                  href={scimago.official_url}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-0.5 text-accent underline-offset-4 hover:underline"
                >
                  View on Scimago
                  <ExternalLink className="size-3" aria-hidden />
                </a>
              )}
            </p>
          )}
          {scimagoError && <p className="text-sm text-caution">{scimagoError}</p>}
          {!form.selfReportedQuartile && !scimago?.matched_quartile && !metrics?.quartile && (
            <Callout tone="caution" title="A claim with no quartile at all needs a note">
              Filing looks the journal up again. If no ranking is found the claim goes through only with
              a short note, so declare the quartile you know the journal holds.
            </Callout>
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <Field label="Quartile" hint="As the journal held it when the paper came out.">
                <Combobox
                  value={form.selfReportedQuartile}
                  onChange={(v) => patchForm({ selfReportedQuartile: v })}
                  options={QUARTILE_OPTIONS}
                  placeholder="Not sure"
                />
              </Field>
              <SourceTag source={form.selfReportedQuartile ? src.quartile : null} className="mt-1 block" />
            </div>
            <div>
              <Field label="SNIP" hint="From the journal's Scopus page.">
                <NumberInput
                  value={form.selfReportedSnip}
                  onChange={(e) => patchForm({ selfReportedSnip: e.target.value })}
                  step="0.001"
                  min="0"
                />
              </Field>
              <SourceTag source={form.selfReportedSnip ? src.snip : null} className="mt-1 block" />
            </div>
          </div>
        </section>
      )}

      <Field label="Subject area" hint="Descriptive only — it does not change the amount.">
        <Input value={form.subjectCategory} onChange={(e) => patchForm({ subjectCategory: e.target.value })} />
      </Field>
    </div>
  )
}

/* ------------------------------------------------------------------------ */
/* Step 3 — you and the claim                                               */
/* ------------------------------------------------------------------------ */

function ClaimStep({
  form,
  patchForm,
  err,
  lookupRes,
}: {
  form: FormState
  patchForm: PatchForm
  err: Err
  lookupRes: PaperLookup | null
}) {
  const collegeName = useCollegeName()
  const hasList = form.authors.length > 0
  const positionError = err("position", "authors")
  const affiliation = lookupRes?.ok ? lookupRes.affiliation : null
  const claimant = lookupRes?.ok ? lookupRes.claimant : null

  function setTotal(n: number) {
    const total = Math.max(1, Math.min(200, n || 1))
    patchForm({ totalAuthors: total })
  }

  return (
    <div className="space-y-6">
      <section className="space-y-3" data-field="position">
        <p className="text-base font-medium">Which author are you?</p>
        <p className="-mt-2 text-sm text-fg-muted">
          Your position is part of the amount, so it is worth a second look.
        </p>
        {hasList ? (
          <>
            {claimant?.confidence === "likely" && (
              <p className="text-sm text-caution">
                Matched to “{claimant.name_on_paper}” by name. Pick your own name if that is someone else.
              </p>
            )}
            {claimant?.confidence === "ambiguous" && (
              <p className="text-sm text-caution">More than one author could be you. Pick your own name.</p>
            )}
            {claimant?.confidence === "none" && (
              <p className="text-sm text-caution">Your name was not found among the authors. Pick your own name.</p>
            )}
            <AuthorList
              authors={form.authors}
              position={form.authorPosition}
              onPick={(p) => patchForm({ authorPosition: p })}
              collegeName={collegeName}
            />
            <div className="flex flex-wrap items-end gap-3">
              <div className="w-32">
                <Field label="Total authors" error={positionError}>
                  <NumberInput value={form.totalAuthors} min={1} onChange={(e) => setTotal(Number(e.target.value))} />
                </Field>
              </div>
              {form.totalAuthors !== form.authors.length && (
                <p className="pb-1 text-sm text-caution">
                  The record lists {form.authors.length}. Keep {form.totalAuthors} only if the paper itself says so.
                </p>
              )}
            </div>
          </>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Total authors" hint="Including you." error={err("authors")}>
              <NumberInput value={form.totalAuthors} min={1} onChange={(e) => setTotal(Number(e.target.value))} />
            </Field>
            <Field label="Your author position" hint="1 if you are the first author." error={err("position")}>
              <NumberInput
                value={form.authorPosition}
                min={1}
                max={form.totalAuthors}
                onChange={(e) => patchForm({ authorPosition: Math.max(1, Number(e.target.value) || 1) })}
              />
            </Field>
          </div>
        )}
        {form.authorPosition > form.totalAuthors && (
          <p role="alert" className="text-sm text-critical">
            You are author {form.authorPosition} of {form.totalAuthors}, after the last author. Correct
            whichever of the two is wrong.
          </p>
        )}
      </section>

      <section className="space-y-2" data-field="affiliation">
        <p className="text-base font-medium">Does the article name {collegeName}?</p>
        {affiliation && affiliation.status !== "unknown" && (
          <p
            className={cn(
              "text-sm",
              affiliation.status === "yes" && affiliation.claimant_status !== "no" ? "text-positive" : "text-caution"
            )}
          >
            {affiliation.status === "yes"
              ? affiliation.claimant_status === "no"
                ? `The paper's record prints ${collegeName}, but not beside your name.`
                : `The paper's record prints ${collegeName}${affiliation.claimant_status === "yes" ? " beside your name" : ""}.`
              : affiliation.status === "other"
                ? `The paper's record names “${affiliation.text}”, not ${collegeName}.`
                : `The paper's record does not name ${collegeName}.`}{" "}
            <SourceTag source={lookupRes?.field_sources.authors} />
          </p>
        )}
        <Checkbox
          checked={form.affiliationOk}
          onCheckedChange={(v) => patchForm({ affiliationOk: v === true })}
          label={`Yes — the article names ${collegeName} as my affiliation`}
          hint="The name printed on the article has to be the college's own. A different form of it is what papers are sent back for."
          aria-invalid={err("affiliation") ? true : undefined}
        />
        {err("affiliation") && (
          <p role="alert" className="text-xs text-critical">
            {err("affiliation")}
          </p>
        )}
      </section>

      <section className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_14rem]" data-field="scopus">
        <Field
          label="Your Scopus author profile"
          hint="The link to your author page on Scopus. The research cell checks the paper is on it."
          error={err("scopus")}
        >
          <Input
            value={form.scopusAuthorUrl}
            onChange={(e) => patchForm({ scopusAuthorUrl: e.target.value })}
            placeholder="https://www.scopus.com/authid/detail.uri?authorId=…"
            spellCheck={false}
          />
        </Field>
        <Field label="Your designation" hint="Optional — it appears on the ticket.">
          <Input value={form.designation} onChange={(e) => patchForm({ designation: e.target.value })} />
        </Field>
      </section>
    </div>
  )
}

/* ------------------------------------------------------------------------ */
/* Step 4 — the proof                                                       */
/* ------------------------------------------------------------------------ */

function ProofStep({
  form,
  rules,
  carried,
  err,
  uploadingKind,
  onAdd,
  onRemove,
  onUpdate,
  ownerId,
}: {
  form: FormState
  rules: FilingRules
  carried: CarriedEvidence
  err: Err
  uploadingKind: AttachmentRow["kind"] | null
  onAdd: (kind: AttachmentRow["kind"], file: File) => Promise<void>
  onRemove: (url: string) => void
  onUpdate: (url: string, patch: Partial<AttachmentRow>) => void
  ownerId?: string | null
}) {
  const collegeName = useCollegeName()
  const papers = form.attachments.filter((a) => a.kind === "PUBLISHED_PAPER")
  const refs = form.attachments.filter((a) => a.kind === "SEC_REFERENCE")
  const numbered = refs.filter((r) => (r.ref_number || "").trim()).length
  const sameAs = sameFileOnThisForm(form.attachments)

  return (
    <div className="space-y-8">
      <div data-field="paper-file">
        <AttachmentGroup
          title="The published paper"
          hint="The full-length article as it appears in the journal — PDF, scan or photo."
          kind="PUBLISHED_PAPER"
          rows={papers}
          busy={uploadingKind === "PUBLISHED_PAPER"}
          sameAs={sameAs}
          onAdd={onAdd}
          onRemove={onRemove}
          form={form}
          ownerId={ownerId}
          error={err("paper-file")}
          empty={
            carried.proofUrl
              ? "This claim already carries a link to the paper, which is enough to file. Attach the file itself if you have it."
              : "Nothing attached yet. The claim cannot be filed without the full-length paper."
          }
        />
      </div>
      <div data-field="refs" className="space-y-3">
        <AttachmentGroup
          title="Cited references with SEC affiliation"
          hint={`Each reference in your paper with a ${collegeName} author, and the number it has in your reference list. The policy pays when ${rules.min_sec_references} are attached and numbered.`}
          kind="SEC_REFERENCE"
          rows={refs}
          busy={uploadingKind === "SEC_REFERENCE"}
          sameAs={sameAs}
          onAdd={onAdd}
          onRemove={onRemove}
          form={form}
          ownerId={ownerId}
          error={err("refs-none", "ref-numbers", "refs-url-only", "ref-numbers-zero", "refs-few")}
          empty={
            carried.secProofUrl
              ? "This claim carries a link instead of files, which is worth nothing in the amount — attach the papers."
              : "Nothing attached yet. Drop the cited papers here — several at once is fine."
          }
          renderExtra={(row) => <ReferenceFields row={row} onUpdate={onUpdate} />}
        />
        <ReferenceTally
          attached={refs.length}
          numbered={numbered}
          needed={rules.min_sec_references}
          why={rules.why.min_sec_references}
          carried={carried}
          paid={form.claimReason !== "COUNT_ONLY"}
        />
      </div>
    </div>
  )
}
