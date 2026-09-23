import { useEffect, useRef, useState } from "react"
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom"
import {
  AlertTriangle,
  ArrowLeft,
  BadgeCheck,
  Check,
  CircleCheck,
  CircleHelp,
  CircleX,
  Copy,
  ExternalLink,
  LoaderCircle,
  Paperclip,
  Search,
  ShieldCheck,
  Trash2,
  Upload,
} from "lucide-react"

import { api, ApiError } from "@/lib/api"
import { cn } from "@/lib/cn"
import { useCollegeName } from "@/app/institution"
import { useApi } from "@/lib/query"
import { Button } from "@/ui/button"
import { Combobox, type ComboboxOption } from "@/ui/combobox"
import { ConfirmDialog } from "@/ui/dialog"
import { ClaimEligibilityGate, ClaimRulesDialog } from "@/ui/eligibility"
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
import { Callout, EmptyState, ErrorState, InlineError, SkeletonText } from "@/ui/state"
import { ColumnLabel, Meta, PageTitle, SectionTitle, Sub } from "@/ui/text"
import { toast } from "@/ui/toast"


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
  /** Kept on the row rather than only announced in a toast: "you have already
   *  attached this file to another paper" is worth seeing while looking at
   *  the file, not for four seconds while looking somewhere else. */
  duplicateOf?: {
    ticket_number: string | null
    owner_name: string
    same_owner: boolean
  } | null
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
  team: { code: string } | null
  affiliation_ok: boolean
  total_authors: number
  author_position: number
  attachments: AttachmentRow[]
  /**
   * The legacy single-URL evidence columns, and the reference numbers derived
   * from the attachments. Read here, never sent — `buildPayload` deliberately
   * omits all three so the server keeps deriving them from the attachment set.
   *
   * They are read because the submission gate and the payout formula do not
   * agree about them, and the disagreement costs the claimant the whole
   * payment. `_check_mandatory_fields` accepts a `sec_proof_url` or a
   * left-over `sec_refs` string as evidence of SEC references, so the claim
   * files without complaint; `_apply_calc` counts only SEC_REFERENCE
   * attachments that carry a `ref_number`, so it prices at zero. Without
   * these fields the form cannot see the difference and cannot warn about it.
   */
  proof_url?: string | null
  sec_proof_url?: string | null
  sec_refs?: string | null
}

/** The three server-side evidence values above, trimmed, as the form tracks
 *  them between saves. */
export type CarriedEvidence = {
  proofUrl: string
  secProofUrl: string
  secRefs: string
}

export const NO_CARRIED_EVIDENCE: CarriedEvidence = { proofUrl: "", secProofUrl: "", secRefs: "" }

function carriedFrom(c: ClaimDetail): CarriedEvidence {
  return {
    proofUrl: (c.proof_url || "").trim(),
    secProofUrl: (c.sec_proof_url || "").trim(),
    secRefs: (c.sec_refs || "").trim(),
  }
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
  /** The Scopus author ID the linkage column was worked out against, or null
   *  when there was none — which is the difference between "this one is not
   *  yours" and "nobody checked whether it is". */
  author_id?: string | null
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
  /** `_pack_enrich` sends these too and this screen used to throw them away.
   *  The author count is a term in the payout formula and the year is the
   *  commonest reason a paper is sent back, so both are worth filling in. */
  publication_year: number | null
  author_count: number | null
  /** Present when Scopus itself held the record, as opposed to a Scimago-only
   *  match on the journal. That distinction is what makes it honest to tick
   *  "Scopus" in the indexing list on the claimant's behalf. */
  paper: ScopusPaper | null
  serial: { snip: number | null; journal_title: string | null } | null
}

type DuplicateMatch = {
  source?: string | null
  reference?: string | null
  who?: string | null
  when?: string | null
  amount?: number | null
  /** `check_already_paid` sends the matched paper's own title and this screen
   *  used to drop it. A reference and a month name a row in somebody's
   *  ledger; the title is the only part a claimant can recognise as their
   *  paper or somebody else's. */
  title?: string | null
}

type PriorCheckResult = {
  warning: boolean
  matches: DuplicateMatch[]
}

/**
 * `POST /api/lookup/verify` — the three facts the claim rules turn on, from
 * the same sources the server checks with when the ticket is filed.
 *
 * Shaped from `verify_publication` in `backend/core/services/verify.py`. The
 * `paid` block is byte-for-byte what `/prior/check` returns, which is why the
 * result of one is fed straight into the other's state on this screen.
 */
type VerifyResult = {
  ok: boolean
  scopus: { indexed: boolean; linked: boolean; message?: string | null }
  scimago: {
    found: boolean
    quartile?: string | null
    sjr?: number | null
    official_url?: string | null
    message?: string | null
  }
  paid: PriorCheckResult
  snip?: number | null
  engineering_class?: string | null
  /** Whether the journal was still on the recognised lists when the paper
   *  came out. `checked: false` means no list is loaded, which is "we did not
   *  look", not "it is fine". */
  standing?: {
    checked: boolean
    issues: string[]
    notes?: string[]
    message?: string | null
  } | null
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
  duplicate_of: {
    /** Which claim already holds this file. Read because the endpoint
     *  matches against every stored attachment including this draft's own —
     *  so a file re-attached to the claim being edited comes back flagged as
     *  "already on another of your papers", which is a different and much
     *  more alarming sentence than "you attached this twice". */
    claim_id: string
    ticket_number: string | null
    owner_name: string
    same_owner: boolean
  } | null
}

/**
 * The eligibility rules, read from the live policy rather than written here.
 *
 * A hard-coded 2 in the client is a rule that silently stops matching the one
 * the money is calculated from the day somebody publishes a new policy. These
 * come from `/api/meta/filing-rules`, which reads the active FormulaConfig.
 */
/** The little of a draft this screen needs to offer it back. */
type DraftRow = {
  id: string
  paper_title: string | null
  updated_at: string | null
}

type FilingRules = {
  max_authors: number
  min_sec_references: number
  attachment_limits: { PUBLISHED_PAPER: number; SEC_REFERENCE: number }
  max_upload_bytes: number
  why: { max_authors: string; min_sec_references: string }
  policy_version: number | null
}

/** Used only until the real rules arrive, and matching the server's own
 *  fallbacks so the two never briefly disagree on screen. */
export const RULE_FALLBACK: FilingRules = {
  max_authors: 9,
  min_sec_references: 2,
  attachment_limits: { PUBLISHED_PAPER: 10, SEC_REFERENCE: 50 },
  max_upload_bytes: 10 * 1024 * 1024,
  why: {
    max_authors: "A paper with more than 9 authors carries no remuneration.",
    min_sec_references:
      "The policy requires 2 cited references that carry the college's affiliation.",
  },
  policy_version: null,
}

/* ------------------------------------------------------------------------ */
/* Identifiers — tidied on the way in, so a typo is not a 502 later          */
/* ------------------------------------------------------------------------ */

/**
 * A DOI as the server wants it, out of whatever was pasted.
 *
 * People paste the whole address bar. `https://doi.org/10.1016/j.x` is the
 * same DOI as `10.1016/j.x` and the lookup only recognises the second, so the
 * first came back "no match for that DOI" and the claimant concluded their
 * paper was not indexed.
 */
function normaliseDoi(raw: string): string {
  let d = raw.trim()
  for (const prefix of ["https://doi.org/", "http://doi.org/", "https://dx.doi.org/", "doi:"]) {
    if (d.toLowerCase().startsWith(prefix)) d = d.slice(prefix.length)
  }
  return d.replace(/^\/+|\/+$/g, "").trim()
}

function doiProblem(raw: string): string | null {
  const d = normaliseDoi(raw)
  if (!d) return null
  // Every DOI is "10.<registrant>/<suffix>". Anything else is a title, a URL
  // to somewhere else, or a typo.
  return /^10\.\d{4,9}\/\S+$/.test(d) ? null : "That does not look like a DOI (10.xxxx/…)."
}

/**
 * An ISSN as eight characters, whatever a spreadsheet did to it first.
 *
 * A direct port of `normalize_issn` in `backend/core/services/normalize.py`,
 * and it has to stay one. Two things happen to ISSNs on the way in, both from
 * being read as numbers, and the order they are undone in matters:
 *
 * - A trailing ".0" from a float. Stripping non-digits *first* turns
 *   "2728842.0" into "27288420" — eight characters, so it passes the length
 *   check and comes out as "2728-8420", a real-looking ISSN belonging to
 *   nobody. A wrong match is worse than no match: it attaches another
 *   journal's quartile to this one, and quartile is a term in the payout. So
 *   the float suffix goes first, and only when the *whole* value looks like a
 *   float, leaving an ISSN that legitimately ends in 0 alone.
 * - A lost leading zero: 0272-8842 arrives as "2728842". Seven characters,
 *   which the server pads back.
 *
 * 59,741 stored values needed repairing for these two. A form that accepts
 * them writes the same fault by hand, one paper at a time.
 */
function issnDigits(raw: string): string {
  let text = raw.trim()
  if (/^\d+\.0+$/.test(text)) text = text.split(".")[0]
  const cleaned = text.toUpperCase().replace(/[^0-9X]/g, "")
  return cleaned.length === 7 ? `0${cleaned}` : cleaned
}

function normaliseIssn(raw: string): string {
  const cleaned = issnDigits(raw)
  if (cleaned.length !== 8) return raw.trim()
  return `${cleaned.slice(0, 4)}-${cleaned.slice(4)}`
}

function issnProblem(raw: string): string | null {
  const value = raw.trim()
  if (!value) return null
  const cleaned = issnDigits(value)
  if (cleaned.length !== 8) return "An ISSN is eight characters, like 0390-6663."
  if (cleaned.slice(0, 7).includes("X")) return "Only the last character of an ISSN may be an X."
  return null
}

/** Said when the value was repaired rather than merely reformatted, because
 *  restoring a dropped leading zero is a guess — a correct one nine times out
 *  of ten, and worth a second look the tenth. */
function issnRepairNote(raw: string): string | null {
  const value = raw.trim()
  if (!value) return null
  const bare = value.toUpperCase().replace(/[^0-9X]/g, "")
  if (/^\d+\.0+$/.test(value)) {
    return "A trailing “.0” was dropped — that is a spreadsheet having read this as a number."
  }
  if (bare.length === 7) {
    return "A leading zero was added to make eight characters. Check it against the journal."
  }
  return null
}

/* ------------------------------------------------------------------------ */
/* Form state — the faculty-writable slice of the claim, in editor shape    */
/* ------------------------------------------------------------------------ */

export type FormState = {
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
  claimReason: "INCENTIVE" | "COUNT_ONLY" | "STUDENT_PROJECT"
  /** The team code on a student project claim. Empty otherwise. */
  teamCode: string
  attachments: AttachmentRow[]
}

export function emptyForm(): FormState {
  return {
    teamCode: "",
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
    claimReason:
      c.claim_reason === "COUNT_ONLY" || c.claim_reason === "STUDENT_PROJECT"
        ? c.claim_reason
        : "INCENTIVE",
    teamCode: c.team?.code || "",
    attachments: c.attachments.map((a) => ({
      kind: a.kind,
      url: a.url,
      filename: a.filename,
      size_bytes: a.size_bytes,
      ref_number: a.ref_number,
      ref_title: a.ref_title,
      /*
       * Carried rather than dropped, and it still is not enough.
       *
       * `_persist_attachments` deletes the claim's attachment rows and
       * rebuilds them from whatever the payload holds, so a hash left off
       * here is a hash erased on the server the next time the draft
       * autosaves. Reading it back is therefore the only way an edited draft
       * keeps the one thing that says a file has been seen before.
       *
       * `_claim_dict` does not currently send `content_hash` on its
       * attachment rows, so on a reopened draft this reads undefined and the
       * hashes are lost anyway — the same-file-twice check below then works
       * only for files attached in this sitting. Fixing that is one field in
       * the claim serialiser, not a change this screen can make. Written this
       * way so it starts working the moment the field appears, rather than
       * needing to be remembered.
       */
      content_hash: a.content_hash,
    })),
  }
}

/** "a, b and c" — a list a person reads, not one a machine emits. Three
 *  field names joined by bullets is a log line; this is a sentence. */
function listOf(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? ""
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`
}

/** First letter up, for a phrase built from field names that starts a
 *  sentence. */
function sentenceCase(text: string): string {
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : text
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
  extra: {
    submit: boolean
    contest?: boolean
    contestNote?: string
    /**
     * Whose paper this is, when somebody is filing it for them. Only ever
     * sent on creation: the server reads it to decide the owner, and a PATCH
     * carrying it would be an attempt to move a filed claim to a different
     * person, which is not a thing this form does.
     */
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
    affiliation_ok: form.affiliationOk,
    claim_reason: form.claimReason,
    // Sent on every save, including empty, so that dropping the student
    // project reason lets go of the team rather than leaving a roster of
    // students attached to a paper that is no longer theirs.
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
/** The server refuses larger files (upload_claim_file, "max 10MB"). */
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024

/** What to call a field when reporting back what a lookup filled in. The form
 *  state's own names are camelCase identifiers, and "selfReportedSnip was
 *  filled" is not a sentence anybody should be shown. */
const ENRICH_LABEL: Partial<Record<keyof FormState, string>> = {
  paperTitle: "the title",
  journalTitle: "the journal",
  doi: "the DOI",
  issn: "the ISSN",
  publicationDate: "the date it was published",
  publicationType: "the publication type",
  indexing: "Scopus indexing",
  selfReportedSnip: "the SNIP",
  selfReportedQuartile: "the quartile",
  subjectCategory: "the subject category",
  totalAuthors: "the number of authors",
}

/* ------------------------------------------------------------------------ */
/* The flow — one question to a screen                                       */
/* ------------------------------------------------------------------------ */

/**
 * Five named stretches of the form, for orientation and nothing else.
 *
 * The reader is told which stretch they are in and the bar moves as they
 * leave one. They are never told how many questions remain, and never how
 * many they have not answered: the form used to open on "11 things still
 * needed", which is a page telling somebody off before they have typed a
 * character. A count of your own shortcomings is not progress information.
 */
const PHASES = [
  { id: "paper", title: "The paper" },
  { id: "journal", title: "The journal" },
  { id: "claim", title: "You and the claim" },
  { id: "proof", title: "The proof" },
  { id: "file", title: "Check and file" },
] as const

type QuestionId =
  | "find"
  | "reason"
  | "paper"
  | "journal"
  | "indexing"
  | "standing"
  | "authors"
  | "profile"
  | "affiliation"
  | "paper-file"
  | "references"
  | "verify"
  | "review"

type QuestionDef = {
  id: QuestionId
  /** Index into `PHASES`. Must not go backwards down the list. */
  phase: number
  /** Asked as a question, because a screen with one answer on it is one. */
  ask: string
  hint?: string
  /** False when this particular claim does not have this question at all. */
  applies?: (form: FormState) => boolean
  /**
   * True when the answer is already on the form — nearly always because the
   * Scopus lookup put it there.
   *
   * An answered question is stepped over rather than shown as a screenful of
   * pre-filled boxes to press Continue through. Nothing is hidden by it:
   * every value lands on the last screen, listed and editable, and the
   * lookup names on screen one exactly which fields it filled.
   */
  answered?: (form: FormState) => boolean
}

/**
 * The questions, in the order they are asked.
 *
 * One thing per screen, or one group whose parts genuinely cannot be answered
 * apart — a total and a position, a file and the number that makes it count.
 * The list is walked, not indexed into: `applies` and `answered` decide which
 * of these a given claimant ever sees, which is how a paper pulled cleanly
 * out of Scopus becomes six questions instead of sixteen fields.
 */
const QUESTIONS: QuestionDef[] = [
  {
    id: "find",
    phase: 0,
    ask: "Which paper is this?",
    hint: "Pull it out of Scopus and most of this form fills itself in.",
  },
  {
    id: "reason",
    phase: 0,
    ask: "What are you filing this for?",
    hint: "It decides whether this claims money or only records the publication.",
  },
  {
    id: "paper",
    phase: 0,
    ask: "What was published, and when?",
    answered: (f) =>
      Boolean(f.paperTitle.trim() && f.publicationType && f.publicationDate),
  },
  {
    id: "journal",
    phase: 1,
    ask: "Which journal was it published in?",
    answered: (f) => Boolean(f.journalTitle.trim() && f.issn.trim()) && !issnProblem(f.issn),
  },
  {
    id: "indexing",
    phase: 1,
    ask: "Where is the journal indexed?",
    hint: "This is what decides the category the paper is priced in.",
    answered: (f) =>
      f.indexing.length > 0 &&
      Boolean(f.yukthiId.trim()) &&
      (!f.indexing.includes("AU Annexure") || Boolean(f.auAnnexureRef.trim())) &&
      (!f.indexing.includes("UGC Care") || Boolean(f.ugcCareRef.trim())),
  },
  {
    id: "standing",
    phase: 1,
    ask: "What is the journal's quartile and SNIP?",
    hint: "The two numbers the payout is worked out from.",
    // A count-only filing asks for no money, so neither number changes
    // anything about it. Asking anyway is asking somebody to look up two
    // figures that will not be used.
    applies: (f) => f.claimReason !== "COUNT_ONLY",
    answered: (f) => Boolean(f.selfReportedQuartile && f.selfReportedSnip.trim()),
  },
  {
    id: "authors",
    phase: 2,
    ask: "How many authors, and where do you come?",
    // Never skipped, even when Scopus supplied the count: your position in
    // the list is a term in the payout and is the one thing on this form no
    // index can answer for you.
    hint: "Your position is part of what the paper is worth, so it is worth a second look.",
  },
  {
    id: "profile",
    phase: 2,
    ask: "Which Scopus author profile is yours?",
    answered: (f) => Boolean(f.scopusAuthorUrl.trim() && f.designation.trim()),
  },
  {
    id: "affiliation",
    phase: 2,
    ask: "Does the article name the college as its institutional affiliation?",
    answered: (f) => f.affiliationOk,
  },
  {
    id: "paper-file",
    phase: 3,
    ask: "Attach the published paper",
    hint: "The full-length article as it appears in the journal.",
  },
  {
    id: "references",
    phase: 3,
    ask: "Attach the cited references with SEC affiliation",
    hint: "Each one needs the number it carries in your reference list.",
  },
  {
    id: "verify",
    phase: 4,
    ask: "Does this paper check out?",
    hint: "The same three sources the research cell checks against, run now rather than after the ticket is raised.",
    // Nothing to look up without a title, and a claim with no title cannot be
    // filed anyway — the paper screen refuses to be left without one.
    applies: (f) => Boolean(f.paperTitle.trim()),
  },
  { id: "review", phase: 4, ask: "Check it, then file it" },
]

/**
 * Which screen fixes which problem.
 *
 * `readiness()` names problems by a stable key; this is the only place that
 * knows where each of them is answered, so "take me to it" lands on the field
 * rather than on the step that happens to contain it. Anything unmapped falls
 * through to the last screen, which lists everything.
 */
const PROBLEM_QUESTION: Record<string, QuestionId> = {
  title: "paper",
  type: "paper",
  date: "paper",
  // The DOI box is on the finding screen, not repeated on the next one.
  doi: "find",
  year: "paper",
  "not-indexed": "paper",
  journal: "journal",
  issn: "journal",
  indexing: "indexing",
  au: "indexing",
  ugc: "indexing",
  yukthi: "indexing",
  quartile: "standing",
  authors: "authors",
  position: "authors",
  "author-cap": "authors",
  scopus: "profile",
  affiliation: "affiliation",
  team: "reason",
  "paper-file": "paper-file",
  "file-dup": "paper-file",
  "file-dup-ref": "references",
  "file-twice": "paper-file",
  "file-twice-ref": "references",
  linkage: "profile",
  "refs-none": "references",
  "ref-numbers": "references",
  "refs-url-only": "references",
  "ref-numbers-zero": "references",
  "ref-numbers-some": "references",
  "refs-few": "references",
  // Not "review": the answer to "has this already been paid for" is which
  // paper this is, so the jump lands on the screen that decides that.
  prior: "find",
  calc: "review",
  "calc-failed": "review",
  zero: "review",
}

function questionFor(problem: Problem): QuestionId {
  return PROBLEM_QUESTION[problem.key] ?? "review"
}

function questionById(id: QuestionId): QuestionDef {
  return QUESTIONS.find((q) => q.id === id) ?? QUESTIONS[0]
}

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
  const collegeName = useCollegeName()
  const { id } = useParams<{ id?: string }>()
  const navigate = useNavigate()
  const isEditRoute = !!id

  // Filing for somebody else, from /papers/new?for=<id>. Only on a new
  // claim: an existing one already has an owner, and this form is not where
  // a paper changes hands.
  const [searchParams] = useSearchParams()
  const filingForId = isEditRoute ? null : searchParams.get("for")
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
  } = useApi<ClaimDetail>(["claim", id], `/api/claims/${id}`, { enabled: isEditRoute })

  const { data: me } = useApi<MeProfile>(["auth-me-full"], "/api/auth/me")
  // The eligibility rules, from the live policy rather than written into this
  // file. Until they arrive the server's own fallbacks stand in, so the two
  // never briefly disagree on screen.
  const { data: fetchedRules } = useApi<FilingRules>(
    ["meta", "filing-rules"],
    "/api/meta/filing-rules"
  )
  const rules = fetchedRules ?? RULE_FALLBACK

  // What the index said the year was, kept so it can be compared with what
  // the claimant typed. A disagreement is the single commonest reason a
  // paper is sent back.
  const [indexedYear, setIndexedYear] = useState<number | null>(null)

  // Drafts already going, offered before a second one is started by accident.
  // Autosave means an interrupted attempt is always still there; nothing ever
  // said so, so people began again and left the first one behind.
  const { data: draftList } = useApi<{ results: DraftRow[] }>(
    ["claims", "drafts"],
    "/api/claims?status=DRAFT&limit=5",
    { enabled: !isEditRoute }
  )
  const drafts = draftList?.results ?? []

  const [form, setForm] = useState<FormState>(emptyForm)

  /**
   * The screens actually visited, in order, and where in that list the reader
   * is standing.
   *
   * A trail rather than an index into `QUESTIONS`, because which questions
   * get asked depends on what the Scopus lookup already answered — and that
   * changes underneath the reader as they type. Walking a recorded trail
   * means Back always returns to the screen they came from, never to one the
   * form has since decided to skip.
   */
  const [trail, setTrail] = useState<QuestionId[]>(["find"])
  const [pos, setPos] = useState(0)
  const currentId: QuestionId = trail[pos] ?? "find"
  const question = questionById(currentId)

  /** What the last press of Continue was refused for. Empty the rest of the
   *  time — this screen does not pre-emptively list what has not been done. */
  const [stuck, setStuck] = useState<Problem[]>([])

  /** Where a "change this" jump came from, so Continue can put the reader
   *  back there rather than restarting the walk from the screen they landed
   *  on. Not state: nothing renders differently for it. */
  const returnTo = useRef<QuestionId | null>(null)

  // A screen change moves focus to the new question, so somebody on a
  // keyboard or a screen reader lands on what is being asked rather than at
  // the bottom of a page whose content changed under them. Skipped on the
  // first render: the page's own initial focus is already right, and taking
  // it would be the surprising thing.
  const headingRef = useRef<HTMLHeadingElement>(null)
  const flowMounted = useRef(false)
  useEffect(() => {
    if (!flowMounted.current) {
      flowMounted.current = true
      return
    }
    headingRef.current?.focus()
  }, [currentId])

  /**
   * Whether the three eligibility confirmations have been ticked for *this*
   * article.
   *
   * Deliberately plain state: not localStorage, not a profile flag. The
   * acknowledgement is about one article — "no claim has been filed for this
   * one before" is a different sentence every time — and a remembered tick is
   * exactly how a duplicate claim gets filed a second year running.
   */
  const [acknowledged, setAcknowledged] = useState(false)

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
  const [saveError, setSaveError] = useState<string | null>(null)
  const [, forceTick] = useState(0) // re-renders the "saved N ago" label as time passes

  const hydratedRef = useRef(false)
  const meAppliedRef = useRef(false)

  const [ticketNumber, setTicketNumber] = useState<string | null>(null)

  // What the server currently holds in proof_url / sec_proof_url / sec_refs.
  // Refreshed from every save response rather than only on load, because the
  // server rewrites two of the three from the attachment set on each save and
  // a stale copy here would warn about a trap that is no longer set — or,
  // worse, stay quiet about one that is.
  const [carried, setCarried] = useState<CarriedEvidence>(NO_CARRIED_EVIDENCE)

  // "File another in this journal": start from a previous claim's journal,
  // not its paper. Title, DOI, date, files and author position belong to the
  // new paper and are never copied.
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
    toast.info(`Started from ${copySource.journal_title || "your earlier claim"} — the journal is filled in; add this paper's own details and files.`)
  }, [copySource])

  // Pre-fill from the existing claim (edit route) exactly once, without
  // marking the form dirty — a page load is not an edit.
  useEffect(() => {
    if (!existing || hydratedRef.current) return
    hydratedRef.current = true
    setForm(formFromClaim(existing))
    setCarried(carriedFrom(existing))
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
      const payload = buildPayload(form, { submit: false, ownerId: filingFor?.id })
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
      setCarried(carriedFrom(result))
      dirtyRef.current = false
      setSaveError(null)
      setLastSavedAt(new Date())
      setSavingState("saved")
    } catch (err) {
      // Left dirty on purpose: the next edit re-arms the debounce and tries
      // again, and the banner below offers an explicit retry too.
      setSaveError(
        err instanceof ApiError
          ? err.message
          : "The server did not answer. Your typing is still on this screen."
      )
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
  /** What the last lookup actually filled in, named back to the claimant.
   *  "Found on Scopus" with no list leaves them checking eleven fields to
   *  work out which of them moved under their hands. */
  const [filledLabels, setFilledLabels] = useState<string[]>([])

  /**
   * What the last successful lookup was keyed on.
   *
   * Pressing the lookup button a second time with the same DOI is almost
   * never a request to fill the form in again — it is a reader who has since
   * corrected the journal name or the date by hand and wants the SNIP
   * checked. Re-applying would quietly put the index's version back. The
   * legacy form guarded its on-blur autofill exactly this way; here the
   * button press *is* the repeat, so the guard sits on the press.
   */
  const lastLookup = useRef({ doi: "", title: "", issn: "" })

  // Read by the lookups, which resolve long after the request went out and
  // after the claimant may have carried on typing. `form` captured in an
  // async closure is whatever it was when the button was pressed.
  const formRef = useRef(form)
  useEffect(() => {
    formRef.current = form
  }, [form])

  /**
   * Map a `/lookup/enrich` reply onto the form.
   *
   * `overwrite` is the difference between the claimant asking for this and it
   * happening to them: an explicit lookup replaces what is on screen, an
   * automatic one only fills what is blank.
   */
  function applyEnrich(res: EnrichResult, opts: { overwrite: boolean }) {
    const prev = formRef.current
    const patch: Partial<FormState> = {}
    const filled: string[] = []
    const wants = (current: string, next: string) =>
      Boolean(next) && next !== current && (opts.overwrite || !current.trim())
    const mark = (key: keyof FormState) => filled.push(ENRICH_LABEL[key] ?? key)

    if (res.cover_date) setIndexedYear(yearOf(isoDate(res.cover_date)))

    const title = (res.matched_title || res.paper?.title || "").trim()
    if (wants(prev.paperTitle, title)) {
      patch.paperTitle = title
      mark("paperTitle")
    }

    const journal = (res.journal || "").trim()
    if (wants(prev.journalTitle, journal)) {
      patch.journalTitle = journal
      mark("journalTitle")
    }

    const doi = normaliseDoi(res.doi || "")
    if (wants(prev.doi, doi)) {
      patch.doi = doi
      mark("doi")
    }

    const issn = res.issn ? normaliseIssn(res.issn) : ""
    if (wants(prev.issn, issn)) {
      patch.issn = issn
      mark("issn")
    }

    const date = isoDate(res.cover_date || res.paper?.cover_date || "")
    if (wants(prev.publicationDate, date)) {
      patch.publicationDate = date
      mark("publicationDate")
    }

    const aggregation = res.aggregation_type || res.paper?.aggregation_type || ""
    const type = aggregation ? mapPublicationType(aggregation) : ""
    if (wants(prev.publicationType, type)) {
      patch.publicationType = type
      mark("publicationType")
    }

    const subject = (res.subject_category || "").trim()
    if (wants(prev.subjectCategory, subject)) {
      patch.subjectCategory = subject
      mark("subjectCategory")
    }

    // A count-only claim asks for no money, so a SNIP filled in on its behalf
    // is at best noise and at worst a contradiction of what was chosen.
    if (prev.claimReason !== "COUNT_ONLY" && res.snip != null) {
      const snip = String(res.snip)
      if (wants(prev.selfReportedSnip, snip)) {
        patch.selfReportedSnip = snip
        mark("selfReportedSnip")
      }
    }

    const quartile = (res.quartile || "").trim()
    if (
      quartile &&
      quartile !== prev.selfReportedQuartile &&
      (opts.overwrite || !prev.selfReportedQuartile)
    ) {
      patch.selfReportedQuartile = quartile
      mark("selfReportedQuartile")
    }

    // Added to the set, never substituted for it: a Scopus hit proves Scopus
    // indexing and says nothing about Web of Science or the two registers,
    // which the claimant may already have ticked. Without this a reader pulls
    // their paper straight out of Scopus and is still told, two steps later,
    // to select an indexing level.
    if (res.paper && !prev.indexing.includes("Scopus")) {
      patch.indexing = [...prev.indexing, "Scopus"]
      mark("indexing")
    }

    // Over a form that still reads 1 — the default, and so indistinguishable
    // from unanswered — but never over a number somebody typed, unless they
    // asked for this lookup themselves.
    const authors = res.author_count
    if (
      authors &&
      authors >= 1 &&
      authors !== prev.totalAuthors &&
      (opts.overwrite || prev.totalAuthors === 1)
    ) {
      const clamped = Math.max(1, Math.min(50, authors))
      patch.totalAuthors = clamped
      patch.authorPosition = Math.min(prev.authorPosition, clamped)
      mark("totalAuthors")
    }

    if (Object.keys(patch).length) patchForm(patch)
    setFilledLabels(filled)
    setScopusMatch(res)
    if (res.scimago) setScimago(res.scimago)
  }

  /**
   * Pull the paper up from Scopus.
   *
   * One action over three identifiers, in the order they can be trusted: a
   * DOI names exactly one article, a title usually does, and an ISSN names
   * only the journal — but the journal is where the SNIP and the quartile
   * come from, and those are the two terms in the payout formula, so an
   * ISSN-only hit still earns its round trip.
   */
  async function pullFromScopus() {
    const snapshot = formRef.current
    const doi = normaliseDoi(snapshot.doi)
    const title = snapshot.paperTitle.trim()
    const issn = snapshot.issn.trim() ? normaliseIssn(snapshot.issn) : ""
    const haveDoi = Boolean(doi) && !doiProblem(doi)
    // Short titles match half the database. Below this length the candidate
    // search is the right tool, and it asks before it fills anything in.
    const haveTitle = title.length >= 12
    const haveIssn = Boolean(issn) && !issnProblem(issn)

    if (!haveDoi && !haveTitle && !haveIssn) {
      setLookupError(
        "Nothing to look up yet. Enter a DOI, the paper's title, or the journal's ISSN, and this fills in the rest."
      )
      return
    }

    const repeat =
      (haveDoi && lastLookup.current.doi === doi) ||
      (!haveDoi && haveTitle && lastLookup.current.title === title) ||
      (!haveDoi && !haveTitle && haveIssn && lastLookup.current.issn === issn)
    if (repeat) {
      setLookupError(null)
      toast.info(
        "That is the same record as last time, so nothing has been changed. Edit the DOI or the title to look up a different paper."
      )
      return
    }

    setLookupBusy(true)
    setLookupError(null)
    setCandidates(null)
    try {
      /*
       * A title goes past the picker first.
       *
       * `/lookup/enrich` searches by title too, and takes the index's first
       * hit without saying that there were others. That is right most of the
       * time and wrong in exactly the cases that matter — an erratum carries
       * the paper's own title, so does a translation, so does a same-titled
       * paper by another group — and a claimant who is quietly given the
       * erratum's DOI files a ticket for the wrong record and finds out at
       * clearing. A DOI names one article and skips this; so does an ISSN,
       * which names only the journal.
       */
      if (!haveDoi && haveTitle) {
        let byTitle: CandidatesResult | null = null
        try {
          byTitle = await fetchCandidates(title)
        } catch {
          // The picker is a courtesy; if the candidate search is down the
          // one-shot lookup below still answers, and losing the choice is
          // better than losing the lookup.
        }
        if (byTitle && byTitle.candidates.length > 1) {
          setCandidates(byTitle.candidates)
          setFilledLabels([])
          setScopusMatch(null)
          return
        }
        if (byTitle && byTitle.candidates.length === 1) {
          await pickCandidate(byTitle.candidates[0])
          return
        }
        // Nothing matched the title. An ISSN can still fill in the journal,
        // the SNIP and the quartile, so fall through rather than stopping.
      }

      const res = await api<EnrichResult>("/api/lookup/enrich", {
        method: "POST",
        json: {
          doi: haveDoi ? doi : null,
          title: haveTitle ? title : null,
          issn: haveIssn ? issn : null,
        },
      })
      if (!res.ok) {
        setFilledLabels([])
        setLookupError(
          res.message ||
            "Nothing in the index matches that — enter the details yourself, or search by title below."
        )
        return
      }
      applyEnrich(res, { overwrite: true })
      lastLookup.current = {
        doi: normaliseDoi(res.doi || doi),
        title: (res.matched_title || title).trim(),
        issn: res.issn ? normaliseIssn(res.issn) : issn,
      }
    } catch (err) {
      setFilledLabels([])
      setLookupError(lookupFailureMessage(err))
    } finally {
      setLookupBusy(false)
    }
  }

  /** Whether the linkage column on the last candidate list means anything.
   *  `linked_to_author` comes back `null` — not `false` — when there was no
   *  author ID to check against, and "we did not check" must not be drawn as
   *  "not yours". */
  const [checkedLinkage, setCheckedLinkage] = useState(false)

  /**
   * Ask Scopus which records answer to this title.
   *
   * Separate from the one-shot lookup because it returns *all* of them. A
   * title names one article most of the time and several in exactly the cases
   * that cost a claimant the ticket: an erratum carries the paper's own title,
   * so does its translation, and so does a same-titled paper by another group.
   */
  async function fetchCandidates(title: string): Promise<CandidatesResult> {
    const res = await api<CandidatesResult>("/api/lookup/candidates", {
      method: "POST",
      json: {
        title,
        // Sent explicitly rather than left to the account's stored link: the
        // profile screen lets a claimant correct it, and it is the corrected
        // one the linkage badges have to be worked out against.
        scopus_author_url: formRef.current.scopusAuthorUrl.trim() || undefined,
        limit: 10,
      },
    })
    setCheckedLinkage(Boolean(res.author_id))
    return res
  }

  async function searchByTitle() {
    const title = form.paperTitle.trim()
    if (!title) return
    setLookupBusy(true)
    setLookupError(null)
    setScopusMatch(null)
    setFilledLabels([])
    try {
      const res = await fetchCandidates(title)
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
    // Said once, at the moment the record is chosen, because the list that
    // carried the badge is gone the instant it is. `null` is "we had no author
    // ID to check against" and must not be reported as a no.
    if (c.linked_to_author === false) {
      toast.info(
        "That record is not on your Scopus author profile. Link or merge it with the Author Feedback Wizard before you file, or the ticket comes back."
      )
    }
    const patch: Partial<FormState> = {}
    if (c.title) patch.paperTitle = c.title
    if (c.doi) patch.doi = normaliseDoi(c.doi)
    if (c.journal_title) patch.journalTitle = c.journal_title
    if (c.issn) patch.issn = normaliseIssn(c.issn)
    if (c.cover_date) patch.publicationDate = isoDate(c.cover_date)
    if (c.aggregation_type) patch.publicationType = mapPublicationType(c.aggregation_type)
    if (Object.keys(patch).length) patchForm(patch)
    // The candidate list has no SNIP or quartile — one more round trip gets
    // both, plus confirms the DOI, exactly as a direct DOI paste would.
    setLookupBusy(true)
    try {
      const res = await api<EnrichResult>("/api/lookup/enrich", {
        method: "POST",
        json: c.doi
          ? { doi: normaliseDoi(c.doi) }
          : { title: c.title || undefined, issn: c.issn || undefined },
      })
      // Choosing a record from a list is as explicit as pasting its DOI, so
      // it overwrites — and it is recorded as the last lookup, so pressing
      // the lookup button afterwards does not quietly do it a second time.
      if (res.ok) {
        applyEnrich(res, { overwrite: true })
        lastLookup.current = {
          doi: normaliseDoi(res.doi || c.doi || ""),
          title: (res.matched_title || c.title || "").trim(),
          issn: res.issn ? normaliseIssn(res.issn) : c.issn ? normaliseIssn(c.issn) : "",
        }
      }
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
    // Said before a byte is sent: a 40 MB scan used to upload in full and
    // only then be refused by the server.
    const ext = (file.name.split(".").pop() || "").toLowerCase()
    if (!ACCEPT.split(",").includes("." + ext)) {
      toast.fail(new Error(`${file.name} is not a file this form takes — use a PDF, an image or a Word document.`))
      return
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      toast.fail(new Error(`${file.name} is ${(file.size / 1024 / 1024).toFixed(1)} MB; the limit is 10 MB. Save it smaller (a PDF of just the relevant pages is enough) and try again.`))
      return
    }
    setUploadingKind(kind)
    try {
      const res = await uploadAttachment(file)
      /*
       * Two different things wear the same fingerprint, and the words for
       * them are not interchangeable.
       *
       * The upload endpoint matches the bytes against *every* stored
       * attachment, this draft's own included — so re-attaching a file that
       * is already on the claim being edited comes back flagged as a match on
       * another paper. Told that way it reads as an accusation of
       * double-claiming, when it is a mis-drop and the fix is to remove one
       * of the two. So a match on this same claim is dropped here and left to
       * the on-form comparison below, which says the right sentence.
       *
       * A match on a *different* ticket stays, and stays a warning: one paper
       * genuinely cited twice is a real thing, and the research cell sees the
       * same fingerprint from its side.
       */
      const elsewhere =
        res.duplicate_of && res.duplicate_of.claim_id !== claimIdRef.current
          ? {
              ticket_number: res.duplicate_of.ticket_number,
              owner_name: res.duplicate_of.owner_name,
              same_owner: res.duplicate_of.same_owner,
            }
          : null
      if (elsewhere) {
        toast.info(
          elsewhere.same_owner
            ? `That file is already attached to ${elsewhere.ticket_number || "another one of your papers"}.`
            : `That file matches one already on ticket ${elsewhere.ticket_number || "another claim"}, filed by ${elsewhere.owner_name}.`
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
            duplicateOf: elsewhere,
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

  // Run it as soon as there is a DOI or a title to check, not at the end.
  // Finding out on step five that this paper was paid for in 2023 wastes
  // every step before it, and the answer was available at step one.
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

  /* --------------------------- verification ------------------------------- */

  /**
   * The pre-submission check, against the same sources the server verifies
   * with when the ticket is filed.
   *
   * Three of the claim rules turn on facts a claimant cannot see from this
   * form — is the article indexed, is it on their own author profile, has it
   * been paid for before — and each one sends a filed ticket back. Failing
   * here costs a minute; failing after filing costs a round trip through the
   * research cell.
   *
   * `/lookup/verify` is behind `_require_may_see_money`, which refuses only a
   * head of department. A head of department cannot file a claim at all
   * (`can_issue_claims`), so nobody who can reach this screen is refused —
   * but the 403 is still handled below rather than assumed away, because an
   * endpoint's guard is not this screen's to promise.
   */
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
      // The `paid` block is exactly what `/prior/check` returns, so the
      // fresher of the two answers wins rather than the two disagreeing on
      // consecutive screens about whether this paper has been paid for.
      if (res.paid) {
        setPriorCheck(res.paid)
        priorKeyRef.current = `${snapshot.doi.trim()}|${title}`
      }
    } catch (err) {
      setVerify(null)
      setVerifyError(
        err instanceof ApiError && err.status === 403
          ? `${err.message} Filing is unaffected — the research cell runs the same check.`
          : err instanceof ApiError && err.status === 502
            ? "Scopus did not answer, so this could not be checked. That does not stop you filing — the research cell checks again."
            : err instanceof ApiError
              ? err.message
              : "The check could not be run. Nothing about your claim is wrong, and filing still works."
      )
    } finally {
      setVerifyBusy(false)
    }
  }

  // Run on arrival rather than behind a button. The screen asks one question
  // — does this check out — and a screen whose only content is a button that
  // fetches the answer has asked the reader to press Continue twice. Keyed on
  // what the check is actually about, so coming back to it after correcting
  // the ISSN or the author link runs it again, and coming back having changed
  // nothing does not.
  const verifyKeyRef = useRef("")
  useEffect(() => {
    if (currentId !== "verify") return
    const title = form.paperTitle.trim()
    if (!title) return
    const key = `${title}|${form.issn.trim()}|${form.scopusAuthorUrl.trim()}`
    if (key === verifyKeyRef.current) return
    verifyKeyRef.current = key
    void runVerify()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentId, form.paperTitle, form.issn, form.scopusAuthorUrl])

  /* ------------------------------ estimate -------------------------------- */

  const [calc, setCalc] = useState<CalcResult | null>(null)
  const [calcBusy, setCalcBusy] = useState(false)
  // Kept apart from `calc === null`. A failed request and "not enough entered
  // to price it yet" both leave no figure, and on a screen about money they
  // are not the same sentence: one means try again, the other means carry on.
  const [calcFailed, setCalcFailed] = useState(false)
  const [calcNonce, setCalcNonce] = useState(0)

  const secReferenceCount = form.attachments.filter(
    (a) => a.kind === "SEC_REFERENCE" && (a.ref_number || "").trim()
  ).length

  // Not gated on the last step any more. The whole point of the standing
  // panel is that "this will pay nothing" is visible while there is still
  // something to do about it -- so this runs as soon as there is enough to
  // price, and stays quiet on an empty form.
  const priceable =
    form.totalAuthors >= 1 &&
    Boolean(
      form.selfReportedQuartile ||
        form.selfReportedSnip.trim() ||
        form.indexing.length ||
        form.publicationType
    )

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
          sec_reference_count: secReferenceCount,
        },
      })
        // Guarded on the run number so a slow reply to an earlier keystroke
        // cannot overwrite a newer figure — on this screen that would be a
        // stale amount presented as the current one.
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
      const payload = buildPayload(form, {
        submit: true,
        contest: opts.contest,
        contestNote,
        ownerId: filingFor?.id,
      })
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

  /* ------------------------------- readiness ------------------------------- */

  const problems = readiness(form, rules, {
    calc,
    calcFailed,
    priorWarning: Boolean(priorCheck?.warning),
    indexedYear,
    carried,
    // `verify.ok` throughout: a result whose Scopus call failed carries every
    // block at its default — not indexed, not linked, no Scimago match — and
    // reading those as findings would turn an outage at Scopus's end into
    // four accusations about the claimant's paper.
    scimagoQuartile: scimago?.found
      ? scimago.matched_quartile || null
      : verify?.ok && verify.scimago.found
        ? verify.scimago.quartile || null
        : null,
    scopusConfirmed: Boolean(scopusMatch?.ok) || Boolean(verify?.ok && verify.scopus.indexed),
    // `null` where the check has not been run, could not be run, or ran with
    // no author ID to check against. Only `false` is a finding.
    linkedToAuthor:
      verify?.ok && verify.scopus.indexed && form.scopusAuthorUrl.trim()
        ? verify.scopus.linked
        : null,
    verifiedIndexed: verify?.ok ? verify.scopus.indexed : null,
  })

  /* ------------------------------- the flow -------------------------------- */

  /**
   * Whether a question is worth putting on screen at all: it has to apply to
   * this claim, and it must not already have been answered by the lookup.
   */
  function shouldAsk(q: QuestionDef): boolean {
    if (q.applies && !q.applies(form)) return false
    if (q.answered && q.answered(form)) return false
    return true
  }

  /**
   * What is stopping this screen, and nothing else's business.
   *
   * The old wizard gathered every unanswered field in the whole form and put
   * the total in front of the reader. One screen answers one question, so a
   * screen can only be blocked by its own.
   */
  function blockingOn(id: QuestionId): Problem[] {
    return problems.filter((p) => p.kind === "missing" && questionFor(p) === id)
  }

  // Ctrl Enter continues, the same as pressing Continue -- from inside a text
  // box too, where Enter alone has to stay a newline. Not on the last screen:
  // filing is a confirmed action and keeps its own button and dialog.
  const forward = useRef(goForward)
  forward.current = goForward
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && currentId !== "review" && !fileBusy) {
        e.preventDefault()
        forward.current()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [currentId, fileBusy])

  function goForward() {
    // Checked every time, including on the way back through a screen already
    // passed. Going back and emptying a field has to stop the reader again;
    // the old wizard only validated on the way out the first time.
    const blocking = blockingOn(currentId)
    if (blocking.length > 0) {
      setStuck(blocking)
      return
    }
    setStuck([])
    // Jumped here from somewhere to correct one value: go straight back to
    // where the jump came from. Correcting an answer from the last screen has
    // to cost one press each way — walking the reader forward through six
    // screens they have already answered is how a form makes people stop
    // correcting things.
    const back = returnTo.current
    if (back && back !== currentId) {
      returnTo.current = null
      const at = trail.indexOf(back)
      if (at >= 0) {
        setPos(at)
        return
      }
    }
    // Already been further: walk the recorded trail rather than recomputing
    // it, so going back to change something and pressing on returns the
    // reader to exactly where they were.
    if (pos < trail.length - 1) {
      setPos(pos + 1)
      return
    }
    const from = QUESTIONS.findIndex((q) => q.id === currentId)
    const next = QUESTIONS.slice(from + 1).find(shouldAsk)
    if (!next) return
    setTrail((t) => [...t, next.id])
    setPos(pos + 1)
  }

  function goBack() {
    setStuck([])
    // Back is the reader saying they want the ordinary order again, so any
    // "return me to the review screen" promise is dropped here.
    returnTo.current = null
    if (pos > 0) setPos(pos - 1)
  }

  /**
   * Jump straight to the screen that answers something, from the last screen
   * or from a warning. A question that does not apply to this claim has no
   * screen to jump to, so the request is dropped rather than landing the
   * reader somewhere that makes no sense.
   */
  function goToQuestion(id: QuestionId) {
    const def = questionById(id)
    if (def.applies && !def.applies(form)) return
    if (id === currentId) return
    setStuck([])
    returnTo.current = currentId
    const at = trail.indexOf(id)
    if (at >= 0) {
      setPos(at)
      return
    }
    // Never asked — the lookup had already answered it, so it was skipped.
    // Inserted *before* the screen being left rather than after it, so that
    // Continue brings the reader straight back to where they were instead of
    // marching them through everything that follows it. Correcting one value
    // from the last screen must cost one press each way.
    setTrail((t) => [...t.slice(0, pos), id, ...t.slice(pos)])
  }

  function goToProblem(p: Problem) {
    goToQuestion(questionFor(p))
  }

  /** A paper the policy will not pay for can still be worth recording, and
   *  saying so is kinder than letting somebody file for money they will not
   *  get. This switches the claim to the count-only reason and goes to the
   *  screen where that choice lives, so it can be seen to have changed. */
  function fileForTheRecord() {
    patchForm({ claimReason: "COUNT_ONLY" })
    goToQuestion("reason")
    toast.info("Switched to a count-only claim — the publication is recorded, with no payment.")
  }

  /* --------------------------------- render --------------------------------- */

  // Both of these run before the form, and for the same reason: a form
  // rendered while the answer is still on its way, or after it failed to
  // arrive, is a form that looks finished and is filing the wrong thing.
  if (isEditRoute && loadingExisting) {
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
    // Without this the form falls through with `filingFor` undefined, which
    // renders as an ordinary "File a paper" — and files the claim under the
    // wrong person's name, silently, with the money following it.
    return (
      <div className="page py-8">
        <ErrorState
          title={
            filingForError.status === 404
              ? "That person could not be found"
              : "Could not check whose paper this is"
          }
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

  /* Drafts already going, offered before a second one is started by accident.
     Shown on the gate as well as inside the form, because one of the three
     things the gate asks a claimant to confirm is that this article has not
     been claimed before — and their own unfinished attempt at it is the
     likeliest answer to that question. */
  const draftsNotice =
    !isEditRoute && !filingFor && drafts.length > 0 ? (
      <Callout
        tone="info"
        title={`You have ${drafts.length === 1 ? "a draft" : `${drafts.length} drafts`} already started`}
      >
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
          Carrying on with one of those keeps everything already filled in. Starting here makes a
          separate paper.
        </p>
      </Callout>
    ) : null

  // The conditions are the ticket's own preconditions, so they are read
  // before the form exists rather than as a banner above it that scrolls
  // away. Nothing is saved on this screen and no draft is created, so
  // arriving here by accident costs nothing.
  //
  // Skipped for a draft or a sent-back paper being edited — it was confirmed
  // when that article was first filed — and skipped when filing on somebody
  // else's behalf, because all three confirmations are in the first person
  // and whoever is filing cannot truthfully make any of them. Those readers
  // get the same five conditions from the link above the wizard instead.
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
          <Sub className="mt-1">
            Read the conditions, then confirm three things. The form opens after that.
          </Sub>
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

  return (
    <div className="page space-y-6 pb-16">
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
            {isEditRoute
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
              : "One question at a time. Paste a DOI at the start and most of them answer themselves."}
          </Sub>
        </div>
        <SaveStatus state={savingState} lastSavedAt={lastSavedAt} onRetry={() => void save()} />
      </header>

      {/* The status line above is deliberately small; this is not. A claimant
          who keeps typing past a failed save loses the lot, and a grey line in
          a page header is not how you tell somebody that. */}
      {savingState === "error" && (
        <Callout tone="critical" title="Your changes are not being saved">
          <p>
            {saveError || "The server did not answer."} Nothing typed here has been lost yet, but
            it only exists in this browser tab — do not close it until this saves.
          </p>
          <Button kind="default" size="sm" className="mt-2" onClick={() => void save()}>
            Try saving again
          </Button>
        </Callout>
      )}

      {filingFor && (
        // Stated plainly and kept on screen the whole way down. Filing on
        // somebody else's behalf looks exactly like filing your own, and the
        // difference is whose record it lands on and who gets paid.
        <Callout tone="info" title={`Filing on behalf of ${filingFor.name}`}>
          {filingFor.email}
          {filingFor.department ? ` · ${filingFor.department}` : ""}. The ticket
          will be raised in their name, and the payment goes to them.
        </Callout>
      )}

      {draftsNotice}

      {/* The gate is read once and then gone; the questions it answers — does
          AU Annexure need a reference number, what did it say about SNIP —
          arrive four steps later. Without this the only way back to them is
          to abandon the draft and start again. */}
      <Callout
        tone="caution"
        title="File only after the article is indexed in Scopus and linked to your author profile"
      >
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span>
            One claim per article, and the affiliation printed on it must read{" "}
            {collegeName}.
          </span>
          <ClaimRulesDialog
            minReferences={rules.min_sec_references}
            trigger={
              <button
                type="button"
                className="font-medium text-accent underline underline-offset-2"
              >
                Read the full conditions
              </button>
            }
          />
        </p>
      </Callout>

      {/* The money, always. Everything else it used to carry — the standing
          list of what had not been done yet — moved to the last screen,
          where it is a checklist rather than a running tally of failures.
          What stays is the estimate and the warnings that cost money, because
          "this will pay ₹0" has to be visible while there is still something
          to do about it. */}
      <Readiness
        problems={problems}
        calc={calc}
        calcBusy={calcBusy}
        calcFailed={calcFailed}
        priceable={priceable}
        onRetryCalc={() => setCalcNonce((n) => n + 1)}
        countOnly={form.claimReason === "COUNT_ONLY"}
        visited={new Set(trail)}
        onGoToProblem={goToProblem}
        onFileAsCount={fileForTheRecord}
      />

      <div className="space-y-6">
        {/* Pinned under the top edge while the question scrolls, so where you
            are in the five steps is never more than a glance away. The mobile
            header is 48px; the desktop has none. */}
        <div className="sticky top-12 z-20 -mx-2 bg-bg/90 px-2 py-2 backdrop-blur md:top-0">
          <FlowProgress phase={question.phase} />
        </div>

        {/* Keyed on the question so React swaps the subtree outright rather
            than reusing an input from the previous screen — a value left in a
            reused box would be the previous answer wearing the next
            question's label. */}
        <section key={currentId} aria-labelledby="question-heading" className="space-y-5">
          <div>
            <h2
              id="question-heading"
              ref={headingRef}
              tabIndex={-1}
              className="text-lg font-semibold"
            >
              {question.ask}
            </h2>
            {question.hint && <p className="mt-1 text-base text-fg-muted">{question.hint}</p>}
          </div>

          {currentId === "find" && (
            <FindQuestion
              form={form}
              patchForm={patchForm}
              lookupBusy={lookupBusy}
              lookupError={lookupError}
              candidates={candidates}
              checkedLinkage={checkedLinkage}
              scopusMatch={scopusMatch}
              filledLabels={filledLabels}
              onPullFromScopus={() => void pullFromScopus()}
              onSearchTitle={() => void searchByTitle()}
              onPickCandidate={(c) => void pickCandidate(c)}
            />
          )}
          {currentId === "reason" && (
            <ReasonQuestion form={form} patchForm={patchForm} problems={problems} />
          )}
          {currentId === "paper" && <PaperQuestion form={form} patchForm={patchForm} />}
          {currentId === "journal" && <JournalQuestion form={form} patchForm={patchForm} />}
          {currentId === "indexing" && <IndexingQuestion form={form} patchForm={patchForm} />}
          {currentId === "standing" && (
            <StandingQuestion
              form={form}
              patchForm={patchForm}
              lookupBusy={lookupBusy}
              lookupError={lookupError}
              scimago={scimago}
              onCheckScimago={() => void checkScimago()}
            />
          )}
          {currentId === "authors" && <AuthorsQuestion form={form} patchForm={patchForm} />}
          {currentId === "profile" && <ProfileQuestion form={form} patchForm={patchForm} />}
          {currentId === "affiliation" && (
            <AffiliationQuestion form={form} patchForm={patchForm} />
          )}
          {currentId === "paper-file" && (
            <PaperFileQuestion
              form={form}
              carried={carried}
              uploadingKind={uploadingKind}
              onAdd={(kind, file) => void addAttachment(kind, file)}
              onRemove={removeAttachment}
            />
          )}
          {currentId === "references" && (
            <ReferencesQuestion
              form={form}
              rules={rules}
              carried={carried}
              uploadingKind={uploadingKind}
              onAdd={(kind, file) => void addAttachment(kind, file)}
              onRemove={removeAttachment}
              onUpdate={updateAttachment}
            />
          )}
          {currentId === "verify" && (
            <VerifyQuestion
              form={form}
              result={verify}
              busy={verifyBusy}
              error={verifyError}
              onRun={() => void runVerify()}
              onGoToQuestion={goToQuestion}
            />
          )}
          {currentId === "review" && (
            <ReviewQuestion
              problems={problems}
              rules={rules}
              form={form}
              calc={calc}
              calcBusy={calcBusy}
              calcFailed={calcFailed}
              priceable={priceable}
              onRetryCalc={() => setCalcNonce((n) => n + 1)}
              priorCheck={priorCheck}
              priorCheckBusy={priorCheckBusy}
              onRecheck={() => void runPriorCheck()}
              submitError={submitError}
              contestNote={contestNote}
              onContestNoteChange={setContestNote}
              onSendAnyway={() => void fileNow({ contest: true })}
              fileBusy={fileBusy}
              onGoToQuestion={goToQuestion}
              onGoToProblem={goToProblem}
            />
          )}

          {/* Only ever what this screen asked for, only after Continue was
              pressed, and it goes away line by line as each is answered
              rather than sitting there until the next refusal. Never a
              count. */}
          <Stuck
            problems={stuck.filter((s) =>
              problems.some((p) => p.key === s.key && p.kind === "missing")
            )}
          />

          <div className="flex flex-wrap items-center gap-3 border-t border-line pt-5">
            <Button
              kind="default"
              size="lg"
              type="button"
              onClick={goBack}
              disabled={pos === 0 || fileBusy}
            >
              Back
            </Button>
            {currentId === "review" ? (
              <Button
                kind="primary"
                size="lg"
                type="button"
                onClick={() => setConfirmFile(true)}
                disabled={fileBusy}
              >
                {fileBusy && <LoaderCircle className="animate-spin" />}
                File this paper
              </Button>
            ) : (
              <Button kind="primary" size="lg" type="button" onClick={goForward} disabled={fileBusy}>
                Continue
              </Button>
            )}
            {/* Going back has to be visibly free, or nobody does it. The save
                state is already in the header; this says what it means. */}
            <Meta>
              {savingState === "error"
                ? "Not saved — see above"
                : "Answers are saved as you give them. Going back changes nothing."}
            </Meta>
          </div>
        </section>
      </div>

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

/**
 * Whether the draft is safe, in one line, at the top of every step.
 *
 * The state that matters is `pending`, and it used to be the one this did not
 * render: between a keystroke and the debounce firing the component fell
 * through to "Saved 4 minutes ago" — a true sentence about an older version of
 * the form and a false impression about the paragraph just typed. Somebody who
 * closes the tab on the strength of it loses the work, and on this screen the
 * work is a payment claim.
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
      <div
        role="alert"
        className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-medium text-critical"
      >
        <AlertTriangle className="size-4 shrink-0" aria-hidden />
        Not saved
        <button
          type="button"
          onClick={onRetry}
          className="font-medium underline underline-offset-2"
        >
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
      // Polite rather than assertive: a claimant mid-sentence should not be
      // interrupted by a screen reader every time the debounce fires.
      role="status"
      aria-live="polite"
      className={cn(
        "flex flex-wrap items-center gap-1.5 text-sm",
        state === "pending" ? "text-fg" : "text-fg-muted"
      )}
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

/* ------------------------------------------------------------------------ */
/* Which paper is this? — the lookup, and the whole reason the rest is short */
/* ------------------------------------------------------------------------ */

function FindQuestion({
  form,
  patchForm,
  lookupBusy,
  lookupError,
  candidates,
  checkedLinkage,
  scopusMatch,
  filledLabels,
  onPullFromScopus,
  onSearchTitle,
  onPickCandidate,
}: {
  form: FormState
  patchForm: (updater: Partial<FormState> | ((prev: FormState) => Partial<FormState>)) => void
  lookupBusy: boolean
  lookupError: string | null
  candidates: Candidate[] | null
  /** Whether the linkage column means anything — see `fetchCandidates`. */
  checkedLinkage: boolean
  scopusMatch: EnrichResult | null
  filledLabels: string[]
  onPullFromScopus: () => void
  onSearchTitle: () => void
  onPickCandidate: (c: Candidate) => void
}) {
  const doiIssue = doiProblem(form.doi)
  const title = form.paperTitle.trim()
  // The three things the one-shot lookup can be keyed on. It takes whichever
  // is present, in this order, which is why this is not a DOI-only button:
  // most claimants have the title to hand and the DOI somewhere else, and a
  // button that only works for the identifier they do not have is a button
  // they conclude is broken.
  const haveDoi = Boolean(form.doi.trim()) && !doiIssue
  const haveTitle = title.length >= 12
  const haveIssn = Boolean(form.issn.trim()) && !issnProblem(form.issn)
  const canPull = haveDoi || haveTitle || haveIssn

  return (
    <div className="space-y-5">
      <Field
        label="DOI"
        hint="Paste the whole address if that is what you have — it is tidied up for you."
        error={doiIssue ?? undefined}
      >
        <Input
          value={form.doi}
          onChange={(e) => patchForm({ doi: e.target.value })}
          // Tidied when the field is left rather than as it is typed: a paste
          // of the whole address bar is the normal case, and rewriting
          // mid-keystroke fights somebody who is still typing.
          onBlur={(e) => {
            const tidy = normaliseDoi(e.target.value)
            if (tidy !== e.target.value) patchForm({ doi: tidy })
          }}
          placeholder="10.1000/xyz123"
          aria-invalid={doiIssue ? true : undefined}
        />
      </Field>

      <Field label="Paper title" hint="Or search by this instead, if the DOI is not to hand.">
        <Textarea
          value={form.paperTitle}
          onChange={(e) => patchForm({ paperTitle: e.target.value })}
          rows={2}
          maxRows={4}
        />
      </Field>

      <div className="flex flex-wrap items-center gap-2">
        <Button kind="default" size="lg" onClick={onPullFromScopus} disabled={lookupBusy || !canPull}>
          {lookupBusy ? <LoaderCircle className="animate-spin" /> : <Search />}
          {lookupBusy ? "Looking…" : "Pull it up from Scopus"}
        </Button>
        {/* Kept alongside rather than hidden behind an empty DOI box: a DOI
            that came back "no match" is exactly when somebody needs to search
            by title, and that was the one moment the old form took the
            fallback away. Unlike the one-shot lookup it asks which record is
            yours before filling anything in. */}
        <Button kind="quiet" size="md" onClick={onSearchTitle} disabled={lookupBusy || !title}>
          <Search />
          Search by title instead
        </Button>
      </div>

      {/* Why the button is grey, beside the button. It used to be grey with
          nothing said, which reads as "this feature is broken". */}
      {!canPull && !doiIssue && (
        <p className="text-sm text-fg-muted">
          A DOI, or a title of a few words, is enough. You can also skip this and answer
          everything by hand — it is a few more questions, nothing more.
        </p>
      )}

      {lookupError && (
        <Callout tone="caution" title="Could not find it automatically">
          {lookupError}
        </Callout>
      )}

      {candidates && <CandidatePicker candidates={candidates} checkedLinkage={checkedLinkage} onPick={onPickCandidate} />}

      {/* The record itself, read back. This is what makes the questions after
          it disappear honestly: the claimant has seen the title, the journal
          and the date the form is about to use, so it does not have to ask
          for them again. */}
      {scopusMatch?.ok && (
        <div className="rounded-md bg-positive-wash p-4">
          <p className="text-sm font-medium">This is what Scopus has</p>
          <dl className="mt-2 space-y-1.5 text-sm">
            <SummaryRow label="Title" value={scopusMatch.matched_title || form.paperTitle} />
            <SummaryRow label="Journal" value={scopusMatch.journal || form.journalTitle} />
            <SummaryRow label="Published" value={form.publicationDate} />
            <SummaryRow label="Quartile" value={form.selfReportedQuartile || ""} />
            <SummaryRow label="SNIP" value={form.selfReportedSnip} />
          </dl>
          <p className="mt-2 text-sm text-fg-muted">
            {filledLabels.length
              ? `${sentenceCase(listOf(filledLabels))} came from the index, so you will not be asked for them. Everything stays editable on the last screen.`
              : "Nothing needed changing — this matches what you had already entered."}
          </p>
        </div>
      )}
    </div>
  )
}

/**
 * "Find my article" — the Scopus matches, for the claimant to pick from.
 *
 * The quiet autofill takes the index's first hit, which is right most of the
 * time and wrong in exactly the cases that matter: an erratum carries the
 * paper's own title, so does its translation, and so does a same-titled paper
 * by another group. A DOI filled in from the wrong one of those is not a
 * typo the claimant can spot — it looks like their paper — and it comes back
 * at clearing. Choosing from the list is how they confirm the record on the
 * ticket is really theirs.
 *
 * Every row says which of those it is: whether it sits on their own author
 * profile, how many authors it carries, and whether they have already filed
 * for it.
 */
function CandidatePicker({
  candidates,
  checkedLinkage,
  onPick,
}: {
  candidates: Candidate[]
  checkedLinkage: boolean
  onPick: (c: Candidate) => void
}) {
  const anyLinked = candidates.some((c) => c.linked_to_author === true)

  return (
    <div className="space-y-3">
      <div>
        <p className="text-base font-medium">
          {candidates.length === 1
            ? "One record matched — is this it?"
            : `${candidates.length} records match that title. Which one is yours?`}
        </p>
        <p className="mt-0.5 text-sm text-fg-muted">
          Nothing has been filled in yet. An erratum, a translation and a paper of the same name by
          another group all answer to the same title, so this asks rather than guessing.
        </p>
      </div>

      {/* Said above the list, not after a choice has been made. If none of
          these sit on the claimant's own profile then whichever they pick
          will be sent back, and that is worth knowing before they pick. */}
      {checkedLinkage && !anyLinked && (
        <Callout tone="caution" title="None of these are on your Scopus author profile">
          The rules require the article to sit on your own profile. Merge or link it with the
          Scopus Author Feedback Wizard before you file, or correct your profile link on the
          Scopus step.
        </Callout>
      )}

      <ul className="divide-y divide-line border-y border-line">
        {candidates.map((c, i) => (
          <li key={c.eid || c.doi || i}>
            <button
              type="button"
              onClick={() => onPick(c)}
              disabled={c.already_claimed}
              className="row w-full rounded-sm px-2 py-3 text-left disabled:cursor-not-allowed disabled:opacity-60"
            >
              <span className="block text-base font-medium">{c.title || "Untitled record"}</span>
              <Meta className="mt-0.5 block">
                {[
                  c.journal_title,
                  c.publication_year ? String(c.publication_year) : null,
                  c.aggregation_type,
                  // A count that disagrees with the one on the form is the
                  // cheapest sign this is a different paper of the same name.
                  c.author_count ? `${c.author_count} authors` : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </Meta>
              {c.doi && <Meta className="mt-0.5 block break-all">{c.doi}</Meta>}
              <span className="mt-1.5 flex flex-wrap gap-1.5">
                {c.already_claimed && (
                  <Tag tone="critical" icon={AlertTriangle}>
                    You have already filed for this one
                  </Tag>
                )}
                {c.linked_to_author === true ? (
                  <Tag tone="positive" icon={BadgeCheck}>
                    On your Scopus profile
                  </Tag>
                ) : c.linked_to_author === false ? (
                  <Tag tone="caution" icon={AlertTriangle}>
                    Not on your profile
                  </Tag>
                ) : null}
              </span>
            </button>
          </li>
        ))}
      </ul>

      <p className="text-sm text-fg-muted">
        Picking one fills in the title, journal, ISSN, DOI, date, SNIP and quartile. Everything
        stays editable afterwards.
      </p>
    </div>
  )
}

/** A word on a wash. The icon and the wording both carry the meaning, so the
 *  colour is never the only thing saying which of these is bad news. */
function Tag({
  tone,
  icon: Icon,
  children,
}: {
  tone: "positive" | "caution" | "critical"
  icon: React.ComponentType<{ className?: string; "aria-hidden"?: boolean }>
  children: React.ReactNode
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-xs font-medium",
        tone === "positive" && "bg-positive-wash text-positive",
        tone === "caution" && "bg-caution-wash text-caution",
        tone === "critical" && "bg-critical-wash text-critical"
      )}
    >
      <Icon className="size-3 shrink-0" aria-hidden />
      {children}
    </span>
  )
}

/* ------------------------------------------------------------------------ */
/* What are you filing this for?                                             */
/* ------------------------------------------------------------------------ */

function ReasonQuestion({
  form,
  patchForm,
  problems,
}: {
  form: FormState
  patchForm: (updater: Partial<FormState> | ((prev: FormState) => Partial<FormState>)) => void
  problems: Problem[]
}) {
  const teamMissing = problems.some((p) => p.key === "team")
  return (
    <div className="space-y-4">
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
      </div>

      {form.claimReason === "STUDENT_PROJECT" && (
        <TeamPicker
          code={form.teamCode}
          onCode={(teamCode) => patchForm({ teamCode })}
          // The server refuses a student-project claim that names no team, and
          // it refuses it at the very end. Said here instead, where the code
          // is typed.
          required={teamMissing}
        />
      )}
    </div>
  )
}

/* ------------------------------------------------------------------------ */
/* What was published, and when?                                             */
/* ------------------------------------------------------------------------ */

function PaperQuestion({
  form,
  patchForm,
}: {
  form: FormState
  patchForm: (updater: Partial<FormState> | ((prev: FormState) => Partial<FormState>)) => void
}) {
  return (
    <div className="space-y-5">
      <Field label="Paper title">
        <Textarea
          value={form.paperTitle}
          onChange={(e) => patchForm({ paperTitle: e.target.value })}
          rows={2}
          maxRows={4}
        />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Type of publication">
          <Combobox
            value={form.publicationType || null}
            onChange={(v) => patchForm({ publicationType: v })}
            options={PUBLICATION_TYPES}
            placeholder="Select…"
          />
        </Field>
        <Field
          label="Date published"
          hint="Online-first and print dates often differ. Use the one the index carries."
        >
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
/* Which journal?                                                            */
/* ------------------------------------------------------------------------ */

function JournalQuestion({
  form,
  patchForm,
}: {
  form: FormState
  patchForm: (updater: Partial<FormState> | ((prev: FormState) => Partial<FormState>)) => void
}) {
  return (
    <div className="space-y-5">
      <Field label="Journal title">
        <Input
          value={form.journalTitle}
          onChange={(e) => patchForm({ journalTitle: e.target.value })}
        />
      </Field>
      <Field
        label="ISSN"
        hint="Print or online — either works for the lookup."
        // Only ever set on a value somebody has actually typed, so an
        // untouched field is never red. A malformed ISSN matters more than
        // most: the quartile is matched on it and the wrong match attaches
        // another journal's ranking to this claim.
        error={issnProblem(form.issn) ?? undefined}
      >
        <Input
          value={form.issn}
          onChange={(e) => patchForm({ issn: e.target.value })}
          // Eight characters with the hyphen where it belongs. The college's
          // own reference data had 59,741 ISSNs mangled by a spreadsheet
          // import; a form that accepts "14327643" writes the same fault by
          // hand, one paper at a time.
          onBlur={(e) => {
            const note = issnRepairNote(e.target.value)
            const tidy = normaliseIssn(e.target.value)
            if (tidy !== e.target.value) patchForm({ issn: tidy })
            // Repairing is a guess, and a silent guess about a field the
            // payout is matched on is exactly what put 59,741 wrong values in
            // the reference data.
            if (note) toast.info(note)
          }}
          className="max-w-xs"
        />
      </Field>
    </div>
  )
}

/* ------------------------------------------------------------------------ */
/* Where is it indexed?                                                      */
/* ------------------------------------------------------------------------ */

function IndexingQuestion({
  form,
  patchForm,
}: {
  form: FormState
  patchForm: (updater: Partial<FormState> | ((prev: FormState) => Partial<FormState>)) => void
}) {
  function toggleIndexing(opt: string) {
    patchForm((prev) => ({
      indexing: prev.indexing.includes(opt)
        ? prev.indexing.filter((x) => x !== opt)
        : [...prev.indexing, opt],
    }))
  }

  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <p className="text-base font-medium">Tick every one that applies</p>
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

      {/* Each register carries its own reference number, and the question only
          exists once the register has been ticked. */}
      {form.indexing.includes("AU Annexure") && (
        <Field label="AU Annexure reference number" hint="Enter NA if there is none.">
          <Input
            value={form.auAnnexureRef}
            onChange={(e) => patchForm({ auAnnexureRef: e.target.value })}
            className="max-w-xs"
          />
        </Field>
      )}
      {form.indexing.includes("UGC Care") && (
        <Field label="UGC Care reference number" hint="Enter NA if there is none.">
          <Input
            value={form.ugcCareRef}
            onChange={(e) => patchForm({ ugcCareRef: e.target.value })}
            className="max-w-xs"
          />
        </Field>
      )}

      <Field label="Yukthi ID" hint="Enter NA if there is none.">
        <Input
          value={form.yukthiId}
          onChange={(e) => patchForm({ yukthiId: e.target.value })}
          className="max-w-xs"
        />
      </Field>
    </div>
  )
}

/* ------------------------------------------------------------------------ */
/* Quartile and SNIP — the two numbers the money comes from                  */
/* ------------------------------------------------------------------------ */

function StandingQuestion({
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
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <Button kind="default" onClick={onCheckScimago} disabled={lookupBusy}>
          {lookupBusy ? <LoaderCircle className="animate-spin" /> : <Search />}
          {lookupBusy ? "Checking…" : "Look up the quartile in Scimago"}
        </Button>
        <Meta>Fills the quartile in for you, from the journal's ISSN.</Meta>
      </div>

      {scimago && !scimago.found && !lookupBusy && (
        // "Not in the dataset" is an answer, not a failure, and it must not
        // read as one — but it must also not read as "checked and fine".
        <p className="text-sm text-caution">
          {scimago.message ||
            "Scimago has no entry for this journal in the year it was published. Declare the quartile yourself below; you will be asked for a note when you file."}
        </p>
      )}

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

      {/* The quartile the claim is judged on is the one the server confirms at
          the moment of filing, and if it confirms none the claim is refused
          pending a note. Somebody who leaves this blank because the hint says
          it does not decide the payout was told the truth about the money and
          nothing about the refusal. */}
      {!form.selfReportedQuartile && !scimago?.matched_quartile && (
        <Callout tone="caution" title="A claim with no quartile at all is refused">
          Filing looks the journal up in Scimago. If it comes back with no ranking, the claim is
          turned away unless you send it with a short note. Check it now, or declare the quartile
          you know the journal holds.
        </Callout>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Quartile you are declaring"
          hint="Self-reported. The research cell confirms the journal's ranking separately."
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

      <Field label="Subject area" hint="Optional — descriptive only, it does not affect the payout.">
        <Input
          value={form.subjectCategory}
          onChange={(e) => patchForm({ subjectCategory: e.target.value })}
        />
      </Field>
    </div>
  )
}

/* ------------------------------------------------------------------------ */
/* How many authors, and where do you come?                                  */
/* ------------------------------------------------------------------------ */

function AuthorsQuestion({
  form,
  patchForm,
}: {
  form: FormState
  patchForm: (updater: Partial<FormState> | ((prev: FormState) => Partial<FormState>)) => void
}) {
  const positionWrong = form.authorPosition > form.totalAuthors

  return (
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Total authors" hint="Including you.">
          <NumberInput
            value={form.totalAuthors}
            min={1}
            onChange={(e) => patchForm({ totalAuthors: Math.max(1, Number(e.target.value) || 1) })}
          />
        </Field>
        <Field
          label="Your author position"
          hint="1 if you are the first author."
          // Stated on the field as well as in the callout below: the server
          // refuses a position past the last author, and the two numbers that
          // disagree are both right here.
          error={
            positionWrong
              ? `Must be between 1 and ${form.totalAuthors}, the number of authors above.`
              : undefined
          }
        >
          <NumberInput
            value={form.authorPosition}
            min={1}
            max={form.totalAuthors}
            onChange={(e) => patchForm({ authorPosition: Math.max(1, Number(e.target.value) || 1) })}
          />
        </Field>
      </div>

      {positionWrong && (
        <Callout tone="critical" title="This cannot be filed as it stands">
          You are author {form.authorPosition} of {form.totalAuthors}, which puts you after the
          last author. The server refuses the claim outright — correct whichever of the two
          numbers is wrong.
        </Callout>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------------ */
/* Your Scopus author profile                                                */
/* ------------------------------------------------------------------------ */

function ProfileQuestion({
  form,
  patchForm,
}: {
  form: FormState
  patchForm: (updater: Partial<FormState> | ((prev: FormState) => Partial<FormState>)) => void
}) {
  return (
    <div className="space-y-5">
      <Field
        label="Your Scopus author profile"
        hint="The link to your author page on Scopus. The claim cannot be filed without it, because the article has to be shown to sit on your profile."
      >
        <Input
          value={form.scopusAuthorUrl}
          onChange={(e) => patchForm({ scopusAuthorUrl: e.target.value })}
          placeholder="https://www.scopus.com/authid/detail.uri?authorId=…"
        />
      </Field>
      <Field label="Your designation" hint="Optional — it appears on the ticket.">
        <Input
          value={form.designation}
          onChange={(e) => patchForm({ designation: e.target.value })}
          className="max-w-xs"
        />
      </Field>
    </div>
  )
}

/* ------------------------------------------------------------------------ */
/* The affiliation                                                           */
/* ------------------------------------------------------------------------ */

function AffiliationQuestion({
  form,
  patchForm,
}: {
  form: FormState
  patchForm: (updater: Partial<FormState> | ((prev: FormState) => Partial<FormState>)) => void
}) {
  const collegeName = useCollegeName()
  return (
    <div className="space-y-4">
      <Checkbox
        checked={form.affiliationOk}
        onCheckedChange={(v) => patchForm({ affiliationOk: v === true })}
        label={`Yes — the article names ${collegeName}`}
        hint={`The institutional affiliation printed on the article has to read ${collegeName}. A different form of the name is what the research cell sends papers back for.`}
      />
    </div>
  )
}

/* ------------------------------------------------------------------------ */
/* The published paper                                                       */
/* ------------------------------------------------------------------------ */

function PaperFileQuestion({
  form,
  carried,
  uploadingKind,
  onAdd,
  onRemove,
}: {
  form: FormState
  carried: CarriedEvidence
  uploadingKind: AttachmentRow["kind"] | null
  onAdd: (kind: AttachmentRow["kind"], file: File) => void
  onRemove: (url: string) => void
}) {
  const papers = form.attachments.filter((a) => a.kind === "PUBLISHED_PAPER")
  return (
    <AttachmentGroup
      title="The published paper"
      hint="The full-length article as it appears in the journal (PDF, scan or photo)."
      kind="PUBLISHED_PAPER"
      rows={papers}
      busy={uploadingKind === "PUBLISHED_PAPER"}
      sameAs={sameFileOnThisForm(form.attachments)}
      onAdd={onAdd}
      onRemove={onRemove}
      empty={
        carried.proofUrl
          ? "Nothing attached here. This claim already carries a link to the paper, which is enough to file — attach the file itself if you have it."
          : "Nothing attached yet. The claim cannot be filed without the full-length paper."
      }
    />
  )
}

/* ------------------------------------------------------------------------ */
/* The cited SEC references — and the number that makes each one count       */
/* ------------------------------------------------------------------------ */

function ReferencesQuestion({
  form,
  rules,
  carried,
  uploadingKind,
  onAdd,
  onRemove,
  onUpdate,
}: {
  form: FormState
  rules: FilingRules
  carried: CarriedEvidence
  uploadingKind: AttachmentRow["kind"] | null
  onAdd: (kind: AttachmentRow["kind"], file: File) => void
  onRemove: (url: string) => void
  onUpdate: (url: string, patch: Partial<AttachmentRow>) => void
}) {
  const collegeName = useCollegeName()
  const refs = form.attachments.filter((a) => a.kind === "SEC_REFERENCE")
  const numbered = refs.filter((r) => (r.ref_number || "").trim()).length
  const paid = form.claimReason !== "COUNT_ONLY"

  return (
    <div className="space-y-3">
      <AttachmentGroup
        title="Cited references with SEC affiliation"
        hint={`Each reference in your paper that carries a ${collegeName} affiliation, with the number it has in your reference list. The policy pays only when ${rules.min_sec_references} are cited and numbered.`}
        kind="SEC_REFERENCE"
        rows={refs}
        busy={uploadingKind === "SEC_REFERENCE"}
        sameAs={sameFileOnThisForm(form.attachments)}
        onAdd={onAdd}
        onRemove={onRemove}
        empty={
          carried.secProofUrl
            ? "Nothing attached here. This claim carries a link instead, which files but is worth nothing — see below."
            : "Nothing attached yet. At least one cited SEC reference is needed to file."
        }
        renderExtra={(row) => {
          const missingNumber = !(row.ref_number || "").trim()
          return (
            <div className="mt-2 space-y-1.5">
              <div className="grid gap-2 sm:grid-cols-2">
                <Input
                  value={row.ref_number || ""}
                  onChange={(e) => onUpdate(row.url, { ref_number: e.target.value })}
                  placeholder="Reference number, e.g. 12"
                  aria-label={`Reference number for ${row.filename}`}
                  aria-invalid={missingNumber || undefined}
                />
                <Input
                  value={row.ref_title || ""}
                  onChange={(e) => onUpdate(row.url, { ref_title: e.target.value })}
                  placeholder="Reference title (optional)"
                  aria-label={`Reference title for ${row.filename}`}
                />
              </div>
              {/* The number is not a label on the file. It is the only thing
                  that makes the file count towards the money. */}
              {missingNumber && (
                <p className="text-sm text-caution">
                  No reference number — this file is attached but counts for nothing in the
                  amount.
                </p>
              )}
            </div>
          )
        }}
      />

      <ReferenceTally
        attached={refs.length}
        numbered={numbered}
        needed={rules.min_sec_references}
        why={rules.why.min_sec_references}
        carried={carried}
        paid={paid}
      />
    </div>
  )
}

/**
 * How many of the attached references the payout will actually count, said
 * as a number, on the step where the files are.
 *
 * This used to be where the claim lost its money without being told: the
 * submission gate was satisfied by a `sec_proof_url`, or by reference numbers
 * left over from an earlier version, while the payout formula counted only
 * files attached here carrying a reference number. A claimant who evidenced
 * references with a link passed every check, was paid nothing, and learned
 * why from a note on a zero weeks later.
 *
 * The server now refuses that submission instead of ticketing it at ₹0, so
 * this panel says what will be refused rather than what will pay nothing. The
 * two are not interchangeable and the wording has to keep up: telling someone
 * a claim "will file" when it will be turned away is the same broken promise
 * as the old zero, pointed the other way.
 */
function ReferenceTally({
  attached,
  numbered,
  needed,
  why,
  carried,
  paid,
}: {
  attached: number
  numbered: number
  needed: number
  why: string
  carried: CarriedEvidence
  paid: boolean
}) {
  // Nothing to warn about: enough numbered references are attached.
  if (attached > 0 && numbered >= needed) {
    return (
      <p className="text-sm text-fg-muted">
        {numbered} of {attached} attached reference{attached === 1 ? "" : "s"} carry a reference
        number, which is what the amount is counted from. The policy needs {needed}.
      </p>
    )
  }

  // The two gates the server actually applies, kept apart because they are
  // satisfied by different things and only the pair of them being satisfied
  // makes the ₹0 possible.
  const passesEvidenceGate = attached > 0 || Boolean(carried.secProofUrl)
  const passesNumberGate = numbered > 0 || Boolean(carried.secRefs)

  // Filing is blocked outright, so this is not yet a story about money. The
  // line under each unnumbered file and the summary above the Next button
  // both say what is wrong; a "this will pay ₹0" here would imply the claim
  // is filable and merely underpaid.
  if (!passesEvidenceGate || !passesNumberGate) return null

  return (
    <Callout
      tone={paid ? "critical" : "caution"}
      title={
        paid
          ? `This will be refused: ${numbered} of the ${needed} references the policy counts ${numbered === 1 ? "is" : "are"} numbered`
          : `${numbered} of the ${needed} references the policy counts are numbered`
      }
    >
      <p>
        The amount is worked out from attached reference files that carry a reference number, and{" "}
        {numbered === 0 ? "none of them do" : `only ${numbered} of them ${numbered === 1 ? "does" : "do"}`}
        . {why}
      </p>
      {attached === 0 && Boolean(carried.secProofUrl) && (
        <p className="mt-2">
          This claim evidences its references with a link rather than files. The submission check
          accepts the link and lets the paper through — the amount does not count it, so the
          paper prices at nothing and the ticket comes back saying 0 references were cited.
        </p>
      )}
      {attached > 0 && numbered === 0 && Boolean(carried.secRefs) && (
        <p className="mt-2">
          Reference numbers left on the claim from an earlier version ({carried.secRefs}) are what
          lets it file at all. They are not attached to any of the files above, so the amount
          counts none of them.
        </p>
      )}
      <p className="mt-2">
        Attach each cited SEC reference and put its number from your reference list beside it.
      </p>
    </Callout>
  )
}

function AttachmentGroup({
  title,
  hint,
  kind,
  rows,
  busy,
  empty,
  sameAs,
  onAdd,
  onRemove,
  renderExtra,
}: {
  title: string
  hint: string
  kind: AttachmentRow["kind"]
  rows: AttachmentRow[]
  busy: boolean
  /** From `sameFileOnThisForm`, over *every* attachment rather than this
   *  group's — the published paper dropped a second time into the reference
   *  list is the same mistake and has to be caught across the two. */
  sameAs: Map<string, string>
  /** Said in place of the list when nothing is attached. An unexplained gap
   *  above an upload button reads as "this is optional", which for the
   *  published paper is the opposite of true. */
  empty: string
  onAdd: (kind: AttachmentRow["kind"], file: File) => void
  onRemove: (url: string) => void
  renderExtra?: (row: AttachmentRow) => React.ReactNode
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [over, setOver] = useState(false)

  // The whole group is a drop target: a PDF dragged from the downloads bar
  // lands here without a trip through the file dialog. One file per drop,
  // the same as the picker, so each gets its own fingerprint check.
  return (
    <div
      className={cn("space-y-2 rounded-md transition-shadow", over && "ring-2 ring-accent ring-offset-4 ring-offset-bg")}
      onDragOver={(e) => {
        if (busy || !e.dataTransfer.types.includes("Files")) return
        e.preventDefault()
        setOver(true)
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        setOver(false)
        if (busy) return
        e.preventDefault()
        const file = e.dataTransfer.files?.[0]
        if (file) onAdd(kind, file)
      }}
    >
      <div>
        <p className="text-sm font-medium">{title}</p>
        <p className="text-xs text-fg-muted">{hint}</p>
      </div>

      {rows.length === 0 && !busy && <p className="text-sm text-fg-subtle">{empty}</p>}

      {busy && rows.length === 0 && (
        <p className="flex items-center gap-1.5 text-sm text-fg-muted">
          <LoaderCircle className="size-3.5 animate-spin" aria-hidden />
          Uploading…
        </p>
      )}

      {rows.length > 0 && (
        <ul className="divide-y divide-line border-y border-line">
          {rows.map((row) => (
            <li key={row.url} className="row px-1 py-2.5">
              <div className="flex items-start justify-between gap-3">
                <span className="flex min-w-0 items-start gap-2">
                  <Paperclip className="mt-0.5 size-4 shrink-0 text-fg-subtle" aria-hidden />
                  <span className="min-w-0">
                    {/* Wraps on a phone rather than truncating. A scan is
                        called something like `IEEE-TIM-2024-affiliation-p3.pdf`
                        and at 375px an ellipsis after the first eight
                        characters leaves nothing to tell two of them apart by,
                        on the one screen where removing the wrong file loses
                        evidence. */}
                    <span className="block break-all text-sm sm:truncate">{row.filename}</span>
                    <Meta className="block">{formatBytes(row.size_bytes)}</Meta>
                    {/* The same file twice on this form. Its own sentence,
                        because the fix is different: remove one of the two.
                        Renaming the second copy does not change its bytes,
                        which is why two differently named rows can be one
                        piece of evidence. */}
                    {sameAs.has(row.url) && (
                      <span className="mt-0.5 flex items-start gap-1.5 text-sm text-caution">
                        <Copy className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                        <span>
                          The same file as {sameAs.get(row.url)}, attached twice. If they are
                          different papers, attach the right one here.
                        </span>
                      </span>
                    )}
                    {/* Said on the file, not for four seconds in a toast. The
                        same evidence on two claims is what a duplicate-payment
                        sweep looks for, so it is worth seeing here — as a
                        warning, not a block: one paper genuinely cited on two
                        of your claims is a real thing. */}
                    {row.duplicateOf && (
                      <span className="mt-0.5 flex items-start gap-1.5 text-sm text-caution">
                        <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                        <span>
                          {row.duplicateOf.same_owner
                            ? `Already attached to ${row.duplicateOf.ticket_number || "another of your papers"}`
                            : `Already on ${row.duplicateOf.ticket_number || "a claim"} filed by ${row.duplicateOf.owner_name}`}
                          . That is fine if the same paper really is cited again — the research
                          cell sees the same fingerprint from its side.
                        </span>
                      </span>
                    )}
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
        {busy ? "Uploading — wait for this one" : rows.length ? "Add another file" : "Upload a file"}
      </Button>
      {!busy && <span className="ml-2 text-xs text-fg-subtle">or drop it here</span>}
    </div>
  )
}

/**
 * The files on this form that are the same file twice.
 *
 * A file's own bytes say whether it has been seen before, so renaming it
 * changes nothing — and renaming is exactly what happens, because a scan
 * saved twice comes out `scan.pdf` and `scan (1).pdf` and looks like two
 * pieces of evidence in a list. The same document attached twice is nearly
 * always a mis-drop, and it is worth telling apart from the other thing a
 * matching fingerprint means: the same file already on a *different* ticket,
 * which may be perfectly legitimate — one paper genuinely cited twice — and
 * so is a warning, never a block.
 *
 * Keyed on the later of the pair, valued with what to call the earlier one,
 * so the message points at the copy the claimant is looking at.
 */
function sameFileOnThisForm(rows: AttachmentRow[]): Map<string, string> {
  const firstByHash = new Map<string, AttachmentRow>()
  const out = new Map<string, string>()
  let referenceSeen = 0
  const nameFor = new Map<string, string>()

  for (const row of rows) {
    if (row.kind === "SEC_REFERENCE") referenceSeen += 1
    nameFor.set(
      row.url,
      row.kind === "PUBLISHED_PAPER"
        ? "the published paper"
        : (row.ref_number || "").trim()
          ? `reference ${(row.ref_number || "").trim()}`
          : `reference ${referenceSeen} in the list above`
    )
  }

  for (const row of rows) {
    const hash = (row.content_hash || "").trim()
    if (!hash) continue
    const first = firstByHash.get(hash)
    if (first) out.set(row.url, nameFor.get(first.url) || first.filename)
    else firstByHash.set(hash, row)
  }
  return out
}

function formatBytes(bytes: number | null): string {
  if (bytes == null) return ""
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/* ------------------------------------------------------------------------ */
/* Does this paper check out? — the pre-submission verification              */
/* ------------------------------------------------------------------------ */

type CheckState = "pass" | "fail" | "unknown"

const CHECK_ICON: Record<CheckState, { Icon: typeof CircleCheck; className: string; word: string }> =
  {
    pass: { Icon: CircleCheck, className: "text-positive", word: "Passed" },
    fail: { Icon: CircleX, className: "text-critical", word: "Failed" },
    unknown: { Icon: CircleHelp, className: "text-fg-muted", word: "Not determined" },
  }

/** One fact, its verdict, and what to do if the verdict is bad. The word in
 *  the screen-reader span is there because an icon and a colour are the same
 *  signal twice, not two signals. */
function CheckRow({
  state,
  label,
  detail,
}: {
  state: CheckState
  label: string
  detail?: React.ReactNode
}) {
  const { Icon, className, word } = CHECK_ICON[state]
  return (
    <li className="flex gap-2.5 py-3">
      <Icon className={cn("mt-0.5 size-4 shrink-0", className)} aria-hidden />
      <div className="min-w-0">
        <p className="text-base font-medium">{label}</p>
        {detail && <p className="mt-0.5 text-sm text-fg-muted">{detail}</p>}
      </div>
      <span className="sr-only">{word}</span>
    </li>
  )
}

/**
 * The pre-submission check, on a screen of its own before the last one.
 *
 * Three of the claim rules turn on facts the claimant cannot see from this
 * form — is the article indexed, is it on their own author profile, has it
 * been paid for before — and each of the three sends a filed ticket back.
 * Without this screen the first they hear of any of them is a rejection with
 * the paper already out of their hands; here it costs a minute and a
 * correction. Nothing on it blocks filing: everything it finds is fixable at
 * Scopus's end or is a judgement the claimant is entitled to make.
 */
function VerifyQuestion({
  form,
  result,
  busy,
  error,
  onRun,
  onGoToQuestion,
}: {
  form: FormState
  result: VerifyResult | null
  busy: boolean
  error: string | null
  onRun: () => void
  onGoToQuestion: (id: QuestionId) => void
}) {
  const haveAuthorId = Boolean(form.scopusAuthorUrl.trim())
  /**
   * `ok: false` means the index refused to answer, not that it answered no.
   *
   * `verify_publication` returns early on a `ScopusError` with every block
   * left at its default — indexed false, linked false, no Scimago match — and
   * drawn straight those defaults read as five failures, which is the worst
   * possible thing to show somebody whose paper is fine. Only the payment
   * history survives that path, because it is a question about our own
   * database, so only that is drawn.
   */
  const reached = Boolean(result?.ok)

  const indexed: CheckState = !result || !reached ? "unknown" : result.scopus.indexed ? "pass" : "fail"
  const linked: CheckState =
    !result || !reached
      ? "unknown"
      : !result.scopus.indexed
        ? "fail"
        : result.scopus.linked
          ? "pass"
          : haveAuthorId
            ? "fail"
            : "unknown"
  const standingIssues = (reached && result?.standing?.issues) || []

  return (
    <div className="space-y-5">
      {busy && !result && (
        <p className="flex items-center gap-1.5 text-base text-fg-muted">
          <LoaderCircle className="size-4 animate-spin" aria-hidden />
          Checking Scopus, Scimago and the payment history…
        </p>
      )}

      {/* An error here is an error, drawn as one. "Could not check" and
          "checked and found nothing" are different sentences and only one of
          them means carry on. */}
      {error && !busy && <InlineError message={error} onRetry={onRun} />}

      {!busy && !result && !error && (
        <p className="text-base text-fg-muted">
          Not checked yet. This is the same check the research cell runs after you file — running
          it now means a mismatch costs you a minute instead of a returned ticket.
        </p>
      )}

      {result && !reached && (
        <Callout tone="caution" title="Scopus did not answer, so it could not be checked">
          {result.scopus.message || "The index is unreachable at the moment."} That is a fault at
          their end and says nothing about your paper. Filing is unaffected — try again in a
          minute, or carry on and let the research cell check it.
        </Callout>
      )}

      {result && (
        <ul className="divide-y divide-line border-y border-line">
          {reached && (
            <>
              <CheckRow
                state={indexed}
                label={result.scopus.indexed ? "Indexed in Scopus" : "Not found in Scopus"}
                detail={
                  result.scopus.indexed
                    ? result.scopus.message
                    : "A claim filed before the article is indexed cannot be processed. File again once the record appears."
                }
              />
              <CheckRow
                state={linked}
                label={
                  linked === "pass"
                    ? "On your Scopus author profile"
                    : linked === "unknown"
                      ? "Author profile not checked"
                      : "Not on your Scopus author profile"
                }
                detail={
                  linked === "unknown" ? (
                    <>
                      There is no Scopus author link on this claim to check against.{" "}
                      <button
                        type="button"
                        onClick={() => onGoToQuestion("profile")}
                        className="font-medium text-accent underline underline-offset-2"
                      >
                        Add it
                      </button>{" "}
                      and this runs again.
                    </>
                  ) : linked === "fail" && result.scopus.indexed ? (
                    "Merge or link the article to your correct author ID with the Scopus Author Feedback Wizard before you file, or correct the profile link on this claim."
                  ) : linked === "fail" ? (
                    // Not a second finding. There is nothing on the profile
                    // because there is nothing in the index yet, and drawing
                    // it as an independent failure doubles one problem.
                    "There is nothing to link to yet — the row above is the reason. This settles itself when the article is indexed."
                  ) : null
                }
              />
              <CheckRow
                state={result.scimago.found ? "pass" : "unknown"}
                label={
                  result.scimago.found
                    ? `Quartile ${result.scimago.quartile || "unranked"} in Scimago`
                    : "Quartile not found automatically"
                }
                detail={
                  result.scimago.found
                    ? result.scimago.sjr != null
                      ? `SJR ${result.scimago.sjr}`
                      : null
                    : result.scimago.message ||
                      "Declare the quartile yourself — filing is refused without one unless you send a note."
                }
              />
              <CheckRow
                state={result.snip != null ? "pass" : "unknown"}
                label={
                  result.snip != null ? `SNIP ${result.snip}` : "SNIP not found automatically"
                }
                detail={
                  result.snip == null
                    ? "Enter the SNIP printed on the journal's own Scopus page. It is one of the two terms the amount is worked out from."
                    : null
                }
              />
              {standingIssues.length > 0 && (
                <CheckRow
                  state="fail"
                  label="The journal has been removed from a recognised list"
                  detail={standingIssues.join(" · ")}
                />
              )}
            </>
          )}
          {/* Drawn whether or not Scopus answered. Whether this paper has
              already been paid for is a question about our own database, and
              the server answers it on both paths for exactly that reason. */}
          <CheckRow
            state={result.paid.warning ? "fail" : "pass"}
            label={
              result.paid.warning
                ? "A previous claim or payment matches this article"
                : "No previous payment found for this article"
            }
            detail={
              result.paid.warning
                ? "One incentive claim per article. Check the matches below — you can still file once you have."
                : null
            }
          />
        </ul>
      )}

      {result?.paid.warning && result.paid.matches.length > 0 && (
        <Callout tone="critical" title="This may already have been paid for">
          <ul className="mt-1 space-y-1.5">
            {result.paid.matches.slice(0, 5).map((m, i) => (
              <li key={i} className="text-sm">
                <span className="block break-words">{m.title || "Untitled"}</span>
                <span className="block text-fg-muted">
                  {[m.reference, m.who, m.when].filter(Boolean).join(" · ") || "A prior payment"}
                  {m.amount != null && <> — {money(m.amount)}</>}
                </span>
              </li>
            ))}
          </ul>
        </Callout>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <Button kind="default" onClick={onRun} disabled={busy}>
          {busy ? <LoaderCircle className="animate-spin" /> : <ShieldCheck />}
          {busy ? "Checking…" : result || error ? "Check again" : "Run the check"}
        </Button>
        <Meta>Nothing here stops you filing. It is what the research cell checks after you do.</Meta>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------------ */
/* Check it, then file it                                                    */
/* ------------------------------------------------------------------------ */

/**
 * The last screen: everything answered, listed and changeable, then the
 * estimate, then the button that sends it.
 *
 * The list is here rather than standing on every screen for the same reason
 * the questions are asked one at a time — a summary is a thing you read once,
 * at the end, when it is a record of what you did. Standing on every screen
 * it was a running tally of what you had not.
 */
function ReviewQuestion({
  problems,
  rules,
  form,
  calc,
  calcBusy,
  calcFailed,
  priceable,
  onRetryCalc,
  priorCheck,
  priorCheckBusy,
  onRecheck,
  submitError,
  contestNote,
  onContestNoteChange,
  onSendAnyway,
  fileBusy,
  onGoToQuestion,
  onGoToProblem,
}: {
  problems: Problem[]
  rules: FilingRules
  form: FormState
  calc: CalcResult | null
  calcBusy: boolean
  calcFailed: boolean
  priceable: boolean
  onRetryCalc: () => void
  priorCheck: PriorCheckResult | null
  priorCheckBusy: boolean
  onRecheck: () => void
  submitError: string | null
  contestNote: string
  onContestNoteChange: (v: string) => void
  onSendAnyway: () => void
  fileBusy: boolean
  onGoToQuestion: (id: QuestionId) => void
  onGoToProblem: (p: Problem) => void
}) {
  const contestable = submitError?.includes("Could not auto-confirm") ?? false
  const countOnly = form.claimReason === "COUNT_ONLY"
  const missing = problems.filter((p) => p.kind === "missing")

  return (
    <div className="space-y-8">
      {/* One sentence, one destination. Reaching this screen with something
          outstanding is rare — every question refuses to be left until its own
          answer is given — so this names the next one rather than reciting a
          list of everything. */}
      {missing.length > 0 && (
        <div className="rounded-md bg-caution-wash p-3">
          <p className="text-base font-medium">Before this can be filed</p>
          <p className="mt-1 text-sm">{missing[0].label}.</p>
          <Button
            kind="default"
            size="sm"
            className="mt-2"
            onClick={() => onGoToProblem(missing[0])}
          >
            Take me to it
          </Button>
        </div>
      )}

      <section className="space-y-3">
        <SectionTitle>What you answered</SectionTitle>
        <dl className="space-y-1.5 text-sm">
          <SummaryRow label="Title" value={form.paperTitle} onChange={() => onGoToQuestion("paper")} />
          <SummaryRow label="DOI" value={form.doi} onChange={() => onGoToQuestion("find")} />
          <SummaryRow label="Type" value={form.publicationType} onChange={() => onGoToQuestion("paper")} />
          <SummaryRow label="Published" value={form.publicationDate} onChange={() => onGoToQuestion("paper")} />
          <SummaryRow label="Journal" value={form.journalTitle} onChange={() => onGoToQuestion("journal")} />
          <SummaryRow label="ISSN" value={form.issn} onChange={() => onGoToQuestion("journal")} />
          <SummaryRow
            label="Indexing"
            value={form.indexing.join(", ")}
            onChange={() => onGoToQuestion("indexing")}
          />
          <SummaryRow
            label="Quartile and SNIP"
            value={[form.selfReportedQuartile, form.selfReportedSnip].filter(Boolean).join(" · ")}
            onChange={() => onGoToQuestion("standing")}
          />
          <SummaryRow
            label="Authors"
            value={`Position ${form.authorPosition} of ${form.totalAuthors}`}
            onChange={() => onGoToQuestion("authors")}
          />
          <SummaryRow
            label="Filed as"
            value={
              countOnly
                ? "Publication count only"
                : form.claimReason === "STUDENT_PROJECT"
                  ? `Student project${form.teamCode ? ` · team ${form.teamCode}` : ""}`
                  : "Faculty publication incentive"
            }
            onChange={() => onGoToQuestion("reason")}
          />
          <SummaryRow
            label="Attached"
            value={`${form.attachments.filter((a) => a.kind === "PUBLISHED_PAPER").length} paper, ${form.attachments.filter((a) => a.kind === "SEC_REFERENCE").length} reference(s)`}
            onChange={() => onGoToQuestion("paper-file")}
          />
        </dl>
      </section>

      <PreFlight problems={problems} rules={rules} form={form} onGoToProblem={onGoToProblem} />

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
      {priorCheckBusy && (
        <p className="flex items-center gap-1.5 text-sm text-fg-muted">
          <LoaderCircle className="size-3.5 animate-spin" aria-hidden />
          Checking whether this paper has been paid for before…
        </p>
      )}
      {!priorCheckBusy && priorCheck && !priorCheck.warning && (
        <p className="text-sm text-fg-muted">No prior payment found for this paper.</p>
      )}
      {/* Never silently blank. `runPriorCheck` swallows its failure so that a
          down duplicate service cannot block filing, but "we did not manage to
          check" and "we checked and it is clean" are different sentences and
          only one of them is reassuring. */}
      {!priorCheckBusy && !priorCheck && (
        <p className="text-sm text-caution">
          The check for an earlier payment has not run, or did not come back. The research cell
          runs it again after filing, so this does not stop you.
        </p>
      )}
      <Button kind="quiet" size="sm" onClick={onRecheck} disabled={priorCheckBusy}>
        {priorCheckBusy ? <LoaderCircle className="animate-spin" /> : <Search />}
        {priorCheckBusy ? "Checking…" : "Check again"}
      </Button>

      <section className="space-y-3">
        <SectionTitle>Estimated remuneration</SectionTitle>

        {countOnly ? (
          <p className="text-base">
            No payment is being claimed. This is a count-only filing: the publication goes on
            your record and no remuneration is calculated.
          </p>
        ) : calcBusy && !calc ? (
          <p className="flex items-center gap-1.5 text-sm text-fg-muted">
            <LoaderCircle className="size-3.5 animate-spin" aria-hidden />
            Working out the estimate…
          </p>
        ) : calcFailed ? (
          <InlineError
            message="Could not work out the estimate. The figure below is missing because the server did not answer, not because the paper is worth nothing."
            onRetry={onRetryCalc}
          />
        ) : calc?.error ? (
          <Callout tone="critical" title="This amount could not be worked out">
            {calc.error}
          </Callout>
        ) : calc ? (
          <div className="space-y-2">
            <p className="text-3xl font-semibold tabular">
              {money(calc.remuneration)}{" "}
              <span className="align-middle text-base font-normal text-fg-muted">estimated</span>
            </p>
            {calc.remuneration === 0 && (
              <Callout tone="critical" title="This estimate is ₹0 — filing it pays nothing">
                <p>{zeroReason(calc, problems)}</p>
              </Callout>
            )}
            <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2 lg:grid-cols-4">
              <SummaryRow label="Base amount" value={money(calc.base)} />
              <SummaryRow label="QF amount" value={money(calc.qf)} />
              <SummaryRow
                label="Author point"
                value={calc.point != null ? calc.point.toFixed(3) : "—"}
              />
              {calc.category_label && <SummaryRow label="Category" value={calc.category_label} />}
            </dl>
            {calc.note && calc.remuneration !== 0 && (
              <p className="text-sm text-fg-muted">{calc.note}</p>
            )}
          </div>
        ) : (
          <p className="text-sm text-fg-muted">
            {priceable
              ? "No estimate yet."
              : "Not enough entered yet to work one out — the quartile, the SNIP or the indexing level is what prices a paper."}
          </p>
        )}

        {!countOnly && (
          <Callout tone="caution" title="This is an estimate, not the amount you will be paid">
            It is worked out from the SNIP and quartile you declared, not a verified value. The
            research cell checks both separately once this is filed, and the figure may change.
          </Callout>
        )}
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
                {fileBusy ? "Sending…" : "Send anyway, with this note"}
              </Button>
              {/* The server rejects a note under ten characters, and the grey
                  button used to be the only sign of it. */}
              {contestNote.trim().length < 10 && (
                <p className="text-sm text-fg-muted">
                  {contestNote.trim().length === 0
                    ? "Write the note first — it goes to the research cell with the paper."
                    : `${10 - contestNote.trim().length} more character${10 - contestNote.trim().length === 1 ? "" : "s"} needed before this can be sent.`}
                </p>
              )}
            </div>
          )}
        </Callout>
      )}
    </div>
  )
}

/**
 * One answered thing, read back — with the way to change it, when there is
 * one.
 *
 * The change link is what makes skipping a question honest: a value the
 * lookup filled in is never asked about, so this is where the claimant sees
 * it, and one press puts them on the screen that owns it. Without that, a
 * wrong journal name pulled from the index is unreachable until the research
 * cell sends the paper back.
 */
function SummaryRow({
  label,
  value,
  onChange,
}: {
  label: string
  value: string
  onChange?: () => void
}) {
  if (!value) return null
  return (
    // Stacked below `sm`. Side by side at 375px a paper title got two or three
    // characters of the available width and was truncated to an ellipsis, so
    // the one row on this screen a claimant is meant to check — is this the
    // right paper? — showed nothing checkable.
    <div className="flex flex-col gap-0.5 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4">
      <dt className="shrink-0 text-fg-muted">{label}</dt>
      <dd className="flex min-w-0 items-baseline gap-2 sm:justify-end">
        <span className="min-w-0 break-words sm:truncate sm:text-right">{value}</span>
        {onChange && (
          <button
            type="button"
            onClick={onChange}
            className="shrink-0 text-sm text-accent underline-offset-2 hover:underline"
          >
            Change
            <span className="sr-only"> {label}</span>
          </button>
        )}
      </dd>
    </div>
  )
}

/**
 * Why an estimate came out at zero, in the claimant's own terms.
 *
 * A bare "₹0" is read as a bug and ignored. The formula's own note is the
 * best answer when there is one; the readiness problems are the fallback, and
 * they are more specific than the note about the reference trap because they
 * can see the attachments the note only counted.
 */
function zeroReason(calc: CalcResult, problems: Problem[]): string {
  const unpaid = problems.filter((p) => p.kind === "unpaid")
  if (unpaid.length > 0) {
    return `${unpaid.map((p) => p.detail || p.label).join(" ")}${
      calc.note ? ` The formula's own note: ${calc.note}` : ""
    }`
  }
  return (
    calc.note ||
    "The policy prices this paper at nothing. That is usually a journal we hold no SNIP or quartile for, or a publication type the scheme does not pay for. The paper is still recorded."
  )
}


/* ------------------------------------------------------------------------ */
/* Readiness — one list of everything wrong, computed once                  */
/* ------------------------------------------------------------------------ */

/**
 * Three kinds of problem, and the difference between the second and the third
 * is the whole point of this screen.
 *
 * - `missing`  the server will refuse to file it. Must be fixed.
 * - `unpaid`   it will file perfectly well and pay **nothing**. The policy
 *              counts the publication and awards no money — for too many
 *              authors, or too few SEC-affiliated references. This used to be
 *              discoverable only afterwards, in a note attached to a zero.
 * - `check`    worth a second look but nobody is wrong: a possible earlier
 *              payment, a year that disagrees with the index.
 */
type ProblemKind = "missing" | "unpaid" | "check"

export type Problem = {
  key: string
  kind: ProblemKind
  label: string
  detail?: string
  /**
   * Show this one whether or not the reader has reached the screen that
   * answers it.
   *
   * The visited gate exists so the page does not find fault before somebody
   * has typed anything. A finding that only exists *because* a check was run
   * — Scopus has no such paper, the article is not on your profile — cannot
   * be premature by construction, and hiding it because the profile screen
   * was skipped (it was skipped precisely because it was already filled in)
   * is how the one thing worth knowing goes unsaid.
   */
  always?: boolean
  /** The step that fixes it, so the reader can be sent straight there. */
  step: number
}

export function readiness(
  form: FormState,
  rules: FilingRules,
  opts: {
    calc: CalcResult | null
    calcFailed: boolean
    priorWarning: boolean
    indexedYear: number | null
    /** What the server currently holds in proof_url / sec_proof_url /
     *  sec_refs — the three values that let a claim file and pay nothing. */
    carried: CarriedEvidence
    scimagoQuartile: string | null
    scopusConfirmed: boolean
    /** From the pre-submission check. `null` means it was not run, or ran
     *  with no author ID — which is not the same as "not linked", and must
     *  not be reported as one. */
    linkedToAuthor: boolean | null
    /** `false` only when the check ran and Scopus did not hold the paper. */
    verifiedIndexed: boolean | null
  }
): Problem[] {
  const out: Problem[] = []
  const add = (p: Problem) => out.push(p)
  // A count-only filing is never paid, so "this pays nothing" is not news
  // about it — the eligibility warnings below downgrade to a note.
  const paid = form.claimReason !== "COUNT_ONLY"
  const unpaidKind: ProblemKind = paid ? "unpaid" : "check"
  // Short of `min_sec_references` numbered references, a paid claim is now
  // *refused* at submission rather than ticketed at zero. So these have to
  // block the wizard: letting somebody press Next to a server refusal is the
  // same lie as the old ₹0, told the other way round. A count-only filing is
  // exempt on the server, so it stays a note there.
  const refusedKind: ProblemKind = paid ? "missing" : "check"

  /* ---- step 0: the paper ---- */
  if (!form.paperTitle.trim())
    add({ key: "title", kind: "missing", label: "The paper needs a title", step: 0 })
  if (!form.publicationType)
    add({ key: "type", kind: "missing", label: "Choose what kind of publication this is", step: 0 })
  if (!form.publicationDate)
    add({ key: "date", kind: "missing", label: "Enter the date it was published", step: 0 })

  const doiIssue = doiProblem(form.doi)
  if (doiIssue) add({ key: "doi", kind: "missing", label: doiIssue, step: 0 })

  const enteredYear = yearOf(form.publicationDate)
  if (enteredYear && opts.indexedYear && enteredYear !== opts.indexedYear) {
    add({
      key: "year",
      kind: "check",
      label: `You entered ${enteredYear}; the index says ${opts.indexedYear}`,
      detail:
        "The research cell checks the year against the index, and a mismatch is what sends a paper back. Online-first and print dates often differ — use the one the index carries if you can.",
      step: 0,
    })
  }

  /* ---- step 1: the journal ---- */
  if (!form.journalTitle.trim())
    add({ key: "journal", kind: "missing", label: "The journal needs a title", step: 1 })
  const issnIssue = issnProblem(form.issn)
  if (!form.issn.trim())
    add({ key: "issn", kind: "missing", label: "Enter the journal's ISSN", step: 1 })
  else if (issnIssue)
    add({ key: "issn", kind: "missing", label: issnIssue, step: 1 })
  if (form.indexing.length === 0)
    add({ key: "indexing", kind: "missing", label: "Select at least one indexing level", step: 1 })
  if (form.indexing.includes("AU Annexure") && !form.auAnnexureRef.trim())
    add({
      key: "au",
      kind: "missing",
      label: "AU Annexure needs its reference number (NA if there is none)",
      step: 1,
    })
  if (form.indexing.includes("UGC Care") && !form.ugcCareRef.trim())
    add({
      key: "ugc",
      kind: "missing",
      label: "UGC Care needs its reference number (NA if there is none)",
      step: 1,
    })
  if (!form.yukthiId.trim())
    add({ key: "yukthi", kind: "missing", label: "Enter the Yukthi ID, or NA", step: 1 })

  // Not "missing": the server's refusal for a quartile it cannot confirm is
  // the contestable kind, so a note gets the claim through. But it is a
  // refusal, and finding that out at the moment of filing is what this panel
  // exists to prevent.
  if (!form.selfReportedQuartile && !opts.scimagoQuartile)
    add({
      key: "quartile",
      kind: "check",
      label: "No journal quartile — filing will be refused without one",
      detail:
        "Filing looks the journal up in Scimago. If it finds no ranking, the claim is refused unless you send it with a short note. Run “Check Scimago” on this step to find out now rather than at the end.",
      step: 1,
    })

  /* ---- step 2: the authors ---- */
  if (!form.scopusAuthorUrl.trim())
    add({ key: "scopus", kind: "missing", label: "Add your Scopus author profile link", step: 2 })
  // The second of the three facts the claim rules turn on and the claimant
  // cannot see: the article is indexed, but not against their author ID.
  // Filing it that way is a ticket that comes back. Not `missing` — the fix
  // is at Scopus's end, not on this form, so refusing to file would only
  // trap the claimant.
  else if (opts.linkedToAuthor === false)
    add({
      key: "linkage",
      kind: "check",
      always: true,
      label: "The article is indexed, but not on your Scopus author profile",
      detail:
        "The rules require the paper to sit on your own profile, and the research cell checks it against the same source. Merge or link it with the Scopus Author Feedback Wizard before you file, or correct the profile link above if this is not your ID.",
      step: 2,
    })
  if (!form.totalAuthors || form.totalAuthors < 1)
    add({ key: "authors", kind: "missing", label: "Enter how many authors the paper has", step: 2 })
  else if (form.authorPosition < 1 || form.authorPosition > form.totalAuthors)
    add({
      key: "position",
      kind: "missing",
      label: `Your position must be between 1 and ${form.totalAuthors}`,
      step: 2,
    })
  else if (form.totalAuthors > rules.max_authors)
    add({
      key: "author-cap",
      kind: "unpaid",
      label: `${form.totalAuthors} authors is over the limit of ${rules.max_authors}`,
      detail: rules.why.max_authors,
      step: 2,
    })
  if (!form.affiliationOk)
    add({
      key: "affiliation",
      kind: "missing",
      label: "Confirm the article is affiliated to the college",
      step: 2,
    })
  // The server refuses a student-project claim that names no team, and the
  // team has to already exist. Nothing said so until the moment of filing.
  if (form.claimReason === "STUDENT_PROJECT" && !form.teamCode.trim())
    add({
      key: "team",
      kind: "missing",
      label: "A student project claim has to name the team",
      detail:
        "Enter the code from the project sheet and check the students it brings back. The team has to exist already — this claim cannot create one.",
      step: 2,
    })

  /* ---- step 3: the proof ---- */
  const papers = form.attachments.filter((a) => a.kind === "PUBLISHED_PAPER")
  const refs = form.attachments.filter((a) => a.kind === "SEC_REFERENCE")
  // The count the money is worked out from. Not `refs.length`: the payout
  // formula counts SEC_REFERENCE attachments that carry a `ref_number` and
  // nothing else, so a file with no number is, to the amount, not there.
  const numbered = refs.filter((r) => (r.ref_number || "").trim()).length

  if (papers.length === 0) {
    if (opts.carried.proofUrl)
      // The gate takes either the attachment or the URL, so this files.
      add({
        key: "paper-file",
        kind: "check",
        label: "The published paper is a link on the claim, not an attached file",
        detail:
          "That is enough to file — the submission check accepts either. Attach the article itself if you have it, so the research cell is not chasing a link.",
        step: 3,
      })
    else
      add({
        key: "paper-file",
        kind: "missing",
        label: "Attach the full-length published paper",
        step: 3,
      })
  }

  /* The trap this whole panel exists for.
   *
   * `_check_mandatory_fields` accepts a `sec_proof_url`, or a `sec_refs`
   * string left over from an earlier save, as evidence that SEC references
   * were cited — so the claim files without a word of complaint. `_apply_calc`
   * then counts only SEC_REFERENCE attachments carrying a `ref_number`, finds
   * none, and prices the paper at zero with a note telling the claimant they
   * cited 0 references when they declared several. Every branch below is one
   * way into that, and each has to name the ₹0 before it is filed, not after.
   */
  // The server applies two separate checks and they are satisfied by
  // different things: one wants evidence to exist (an attachment OR a URL),
  // the other wants a non-empty `sec_refs` string (derived from the numbers on
  // the attachments, but never cleared, so an old one still counts). Only when
  // BOTH are satisfied while no attachment carries a number does the claim
  // file and pay nothing — which is why they are tested apart here.
  const passesEvidenceGate = refs.length > 0 || Boolean(opts.carried.secProofUrl)
  const passesNumberGate = numbered > 0 || Boolean(opts.carried.secRefs)

  if (!passesEvidenceGate) {
    add({
      key: "refs-none",
      kind: "missing",
      label: "Attach at least one cited reference with SEC affiliation",
      step: 3,
    })
  } else if (!passesNumberGate) {
    add({
      key: "ref-numbers",
      kind: "missing",
      label:
        refs.length === 0
          ? "Attach the cited SEC references themselves — a link carries no reference numbers"
          : "Every cited reference needs its reference number",
      detail:
        "The number is not a label on the file. It is the only thing that makes the file count towards the amount, and the claim is refused without at least one.",
      step: 3,
    })
  } else if (numbered === 0) {
    // Both gates pass and nothing is counted: the ₹0 this panel exists for.
    if (refs.length === 0)
      add({
        key: "refs-url-only",
        kind: refusedKind,
        label: "Your SEC references are a link, not attached files",
        detail:
          "A link carries no reference numbers, and the amount is counted only from attached reference files that have one. The submission check no longer accepts a link in their place — it would file a claim that priced at nothing. Attach each cited SEC reference and give it the number it has in your reference list.",
        step: 3,
      })
    else
      add({
        key: "ref-numbers-zero",
        kind: refusedKind,
        label: "No attached reference carries a reference number",
        detail: `Reference numbers left on the claim from an earlier version (${opts.carried.secRefs}) no longer stand in for the files themselves — they are a note, and nobody can check a number against a file that was never attached. The amount counts only the files attached here that carry a number, and none of them do. Put each reference's number from your reference list beside its file.`,
        step: 3,
      })
  } else if (numbered < refs.length) {
    add({
      key: "ref-numbers-some",
      kind: unpaidKind,
      label: `${refs.length - numbered} of ${refs.length} attached references have no reference number`,
      detail:
        "A reference with no number files perfectly well and is priced as though it were not attached. Give each one the number it has in your reference list.",
      step: 3,
    })
  }

  if (numbered > 0 && numbered < rules.min_sec_references)
    add({
      key: "refs-few",
      kind: refusedKind,
      label: `${numbered} numbered SEC reference${numbered === 1 ? "" : "s"} counted; the policy needs ${rules.min_sec_references}`,
      detail: `${rules.why.min_sec_references} Below that the claim is refused rather than filed, because filing it would work out at ₹0. If you have no more to cite, file it as a publication count instead.`,
      step: 3,
    })
  // Two files that are one file. Nearly always a mis-drop rather than
  // anything dishonest, and the fix is on this form — remove one — so it is a
  // check and it points at the group the second copy landed in.
  const twice = sameFileOnThisForm(form.attachments)
  const twiceRow = form.attachments.find((a) => twice.has(a.url))
  if (twiceRow)
    add({
      key: twiceRow.kind === "SEC_REFERENCE" ? "file-twice-ref" : "file-twice",
      kind: "check",
      label: `“${twiceRow.filename}” is the same file as ${twice.get(twiceRow.url)}`,
      detail:
        "The same document is attached twice — a file's own bytes say so, whatever it was renamed to. Remove one of the two, or attach the file that should have gone there.",
      step: 3,
    })

  // The other thing a matching fingerprint means, and deliberately not the
  // same sentence: this file is on somebody's other ticket. Left as a warning
  // because one paper genuinely cited on two claims is a real thing.
  const dupFile = form.attachments.find((a) => a.duplicateOf)
  if (dupFile?.duplicateOf)
    add({
      key: dupFile.kind === "SEC_REFERENCE" ? "file-dup-ref" : "file-dup",
      kind: "check",
      label: `“${dupFile.filename}” is already attached to another paper`,
      detail: dupFile.duplicateOf.same_owner
        ? `It is on ${dupFile.duplicateOf.ticket_number || "another of your papers"}. That is allowed — the same reference can be cited by two papers — but attaching the same evidence twice is what a duplicate-payment check looks for, so make sure it is deliberate.`
        : `It is on ${dupFile.duplicateOf.ticket_number || "a claim"} filed by ${dupFile.duplicateOf.owner_name}. That is allowed if the same paper is genuinely cited again; the research cell sees the same fingerprint from its side.`,
      step: 3,
    })

  /* ---- step 4: what it comes to ---- */
  if (opts.priorWarning)
    add({
      key: "prior",
      kind: "check",
      label: "This paper may already have been paid for",
      detail: "Look at the matches before filing. You can still go ahead once you have.",
      step: 4,
    })
  // A recently published paper is very often not in the index yet, and the
  // refusal that follows reads like a rejection. Saying so first makes the
  // note it asks for an expected step rather than a setback.
  const published = form.publicationDate ? Date.parse(form.publicationDate) : NaN
  const recentlyPublished =
    Number.isFinite(published) && Date.now() - published < 150 * 24 * 60 * 60 * 1000
  // Told apart on purpose. "It may not be indexed yet" is a guess from the
  // date; "Scopus was asked and does not hold it" is an answer, and it is
  // worth saying whichever screen the reader is on.
  const notIndexed = opts.verifiedIndexed === false
  if (!opts.scopusConfirmed && (notIndexed || recentlyPublished))
    add({
      key: "not-indexed",
      kind: "check",
      always: notIndexed,
      label: notIndexed
        ? "Scopus has no record of this paper"
        : "Recently published — the index may not have it yet",
      detail: notIndexed
        ? "A claim filed before the article is indexed cannot be processed. Filing checks again and asks for a short note if it still cannot confirm the paper — but the usual answer is to wait until the record appears and file then."
        : "Filing checks the publication index again. If it still cannot confirm the paper, you will be asked for a short note and it goes through with that. For a paper this new that is normal, not a rejection.",
      step: 0,
    })

  if (opts.calcFailed)
    add({
      key: "calc-failed",
      kind: "check",
      label: "The estimate could not be worked out",
      detail:
        "The server did not answer the pricing request. There is no figure because of that, not because the paper is worth nothing — filing is unaffected.",
      step: 4,
    })
  else if (opts.calc?.error)
    add({ key: "calc", kind: "check", label: opts.calc.error, step: 4 })
  else if (
    opts.calc &&
    opts.calc.remuneration === 0 &&
    form.claimReason === "INCENTIVE" &&
    !out.some((x) => x.kind === "unpaid")
  )
    // A zero with no rule of ours behind it — usually a journal we hold no
    // SNIP or quartile for. Worth flagging separately so it is not mistaken
    // for one of the eligibility rules above.
    add({
      key: "zero",
      kind: "unpaid",
      label: "This works out to nothing",
      detail:
        opts.calc.note ||
        "We may hold no SNIP or quartile for this journal. The research cell verifies it separately, and the figure can change.",
      step: 4,
    })

  return out
}

const PROBLEM_STYLE: Record<ProblemKind, { tone: "critical" | "caution" | "info"; word: string }> = {
  missing: { tone: "critical", word: "Needed" },
  unpaid: { tone: "caution", word: "Pays nothing" },
  check: { tone: "info", word: "Worth checking" },
}

/**
 * What this paper is worth, standing above every question.
 *
 * The estimate used to appear only on the last screen, so "this will pay
 * nothing because you attached one reference" arrived after five steps of
 * typing, if at all. This says it from the first screen and keeps saying it,
 * while there is still something to do about it.
 *
 * What it deliberately no longer carries is the list of everything not yet
 * answered. That list, standing here on every screen, was a running tally of
 * a first-time claimant's shortfall — and the form's own opening remark to
 * them. Unanswered things now surface where they are answered: the screen
 * that asks refuses to be left, and the last screen lists what is left.
 */
function Readiness({
  problems,
  calc,
  calcBusy,
  calcFailed,
  priceable,
  onRetryCalc,
  countOnly,
  visited,
  onGoToProblem,
  onFileAsCount,
}: {
  problems: Problem[]
  calc: CalcResult | null
  calcBusy: boolean
  calcFailed: boolean
  priceable: boolean
  onRetryCalc: () => void
  countOnly: boolean
  /** The screens the reader has actually reached. */
  visited: Set<QuestionId>
  onGoToProblem: (p: Problem) => void
  onFileAsCount: () => void
}) {
  const missing = problems.filter((p) => p.kind === "missing")
  const unpaid = problems.filter((p) => p.kind === "unpaid")
  // Only about screens already seen. "No journal quartile — filing will be
  // refused" is true and useful, and putting it in front of somebody who has
  // not yet said which paper this is makes the page look like it is finding
  // fault before they have started. Money warnings are exempt on purpose:
  // "this will pay ₹0" has to arrive the moment it becomes true.
  const checks = problems.filter(
    (p) => p.kind === "check" && (p.always || visited.has(questionFor(p)))
  )

  const ready = missing.length === 0
  const amount = calc?.remuneration

  return (
    <aside className="space-y-3 rounded-lg bg-sunken p-4" aria-label="What this paper is worth">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-2">
        <div className="min-w-0">
          <ColumnLabel className="block">
            {countOnly ? "Filing for the count only" : "Estimated remuneration"}
          </ColumnLabel>
          {countOnly ? (
            <p className="mt-0.5 text-lg font-medium">No payment requested</p>
          ) : calcFailed ? (
            // Never a bare dash. On this screen "—" is read as "nothing", and
            // "we could not reach the server" is a different sentence.
            <p className="mt-0.5 text-base font-medium text-critical">Estimate unavailable</p>
          ) : calcBusy && !calc ? (
            <p className="mt-0.5 text-lg text-fg-muted">Working it out…</p>
          ) : (
            <p
              className={cn(
                "mt-0.5 text-2xl font-semibold tabular",
                amount === 0 && "text-caution"
              )}
            >
              {amount == null ? "No estimate yet" : money(amount)}
              {amount != null && (
                // On the figure itself, not only in the label above it. The
                // ERP showed a number with no such word anywhere near it and
                // people budgeted against it.
                <span className="ml-1.5 align-middle text-sm font-normal text-fg-muted">
                  estimated
                </span>
              )}
            </p>
          )}
        </div>
        {/* No number. "Ready to file" is worth saying; "8 still needed" is a
            score against somebody who has been answering questions for two
            minutes, and it was the first thing this page said to them. */}
        <Meta className="shrink-0">{ready ? "Ready to file" : "Still a few to answer"}</Meta>
      </div>

      {/* A ₹0 gets a sentence rather than being left to speak for itself. A
          bare zero reads as "not worked out yet", which is the reading that
          let people file a claim they had already been told was worthless. */}
      {!countOnly && !calcFailed && (
        <p className="text-sm text-fg-muted">
          {amount === 0
            ? "An estimate of ₹0 — as things stand this paper would be recorded and paid nothing. The reasons are below."
            : amount == null
              ? priceable
                ? "No figure yet. It appears as soon as the journal details are enough to price."
                : "An estimate appears once the quartile, the SNIP or the indexing level is entered."
              : "An estimate from your own declared SNIP and quartile. The research cell verifies both, and the figure can change."}
        </p>
      )}

      {calcFailed && !countOnly && (
        <InlineError
          message="The estimate could not be worked out — the server did not answer. Nothing about your claim is wrong, and filing still works."
          onRetry={onRetryCalc}
        />
      )}

      {unpaid.length > 0 && !countOnly && (
        <div className="space-y-2 rounded-md bg-caution-wash p-3">
          {unpaid.map((p) => (
            <div key={p.key}>
              <button
                type="button"
                onClick={() => onGoToProblem(p)}
                className="text-left text-sm font-medium underline-offset-2 hover:underline"
              >
                {p.label}
              </button>
              {p.detail && <p className="mt-0.5 text-sm text-fg-muted">{p.detail}</p>}
            </div>
          ))}
          {/* The honest alternative, offered rather than left to be found:
              a publication that cannot be paid for can still be recorded. */}
          <Button kind="default" size="sm" onClick={onFileAsCount}>
            File it for the record instead
          </Button>
        </div>
      )}

      {checks.length > 0 && (
        <ul className="space-y-1 border-t border-line pt-2">
          {checks.map((p) => (
            <li key={p.key}>
              <button
                type="button"
                onClick={() => onGoToProblem(p)}
                className="text-left text-sm text-fg-muted underline-offset-2 hover:text-fg hover:underline"
              >
                {p.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </aside>
  )
}

/**
 * Where the reader is, without a number anywhere on it.
 *
 * The bar is the only progress signal, and it moves by named stretch rather
 * than by question, so it does not lurch about as the lookup answers three
 * questions at once. "Step 4 of 12" and "11 things still needed" were the two
 * numbers this form used to lead with, and between them they told a first-time
 * claimant that the form was long and that they were failing it.
 */
function FlowProgress({ phase }: { phase: number }) {
  const done = Math.min(PHASES.length, phase + 1)
  // Five named segments: all five stretches are visible from the first screen,
  // so nobody wonders how long the form is -- still with no question count.
  return (
    <ol
      className="grid grid-cols-5 gap-1.5"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={PHASES.length}
      aria-valuenow={done}
      aria-valuetext={`${PHASES[phase]?.title}, part ${done} of ${PHASES.length}`}
    >
      {PHASES.map((p, i) => (
        <li key={p.id} className="min-w-0">
          <span
            aria-hidden
            className={cn(
              "block h-1.5 rounded-full transition-colors duration-[var(--dur-2)]",
              i <= phase ? "bg-accent" : "bg-active"
            )}
          />
          <span
            className={cn(
              "mt-1.5 hidden truncate text-xs sm:block",
              i === phase ? "font-medium text-fg" : i < phase ? "text-fg-muted" : "text-fg-subtle"
            )}
          >
            {p.title}
          </span>
        </li>
      ))}
      <li className="col-span-5 text-sm font-medium text-fg-muted sm:hidden">{PHASES[phase]?.title}</li>
    </ol>
  )
}

/**
 * Why Continue did not move, said as the thing to do next.
 *
 * Shown only after the button has been pressed, and only about the screen it
 * was pressed on — a screen asks one question, so it can only be short of one
 * answer, or of the two or three parts of one. What it must never be is what
 * it replaced: a critical panel reading "This cannot be filed yet — 11 things
 * still needed", which totted up a first-time claimant's shortfall and put
 * the number in red before they had answered anything.
 */
function Stuck({ problems }: { problems: Problem[] }) {
  if (problems.length === 0) return null
  return (
    <div role="alert" className="rounded-md bg-caution-wash p-3">
      {problems.length === 1 ? (
        <p className="text-base">{problems[0].label}.</p>
      ) : (
        <ul className="space-y-1">
          {problems.map((p) => (
            <li key={p.key} className="text-base">
              {p.label}.
            </li>
          ))}
        </ul>
      )}
      {problems[0].detail && <p className="mt-1 text-sm text-fg-muted">{problems[0].detail}</p>}
    </div>
  )
}

/**
 * The pre-flight list on the last step: every rule, and whether this paper
 * satisfies it.
 *
 * Deliberately shows what passes as well as what does not. "Nothing is wrong"
 * is only reassuring if you can see what was actually checked.
 */
function PreFlight({
  problems,
  rules,
  form,
  onGoToProblem,
}: {
  problems: Problem[]
  rules: FilingRules
  form: FormState
  onGoToProblem: (p: Problem) => void
}) {
  const collegeName = useCollegeName()
  const refs = form.attachments.filter((a) => a.kind === "SEC_REFERENCE")
  // The count the payout uses, not the count of files. Saying "you have 3"
  // when three unnumbered files are attached is exactly the reassurance that
  // preceded a ₹0 ticket.
  const numbered = refs.filter((r) => (r.ref_number || "").trim()).length
  const byKey = new Map(problems.map((p) => [p.key, p]))

  const rows: { key: string; label: string; step: number; fallbacks?: string[] }[] = [
    {
      key: "title",
      label: "The paper has a title, a type and a date",
      step: 0,
      fallbacks: ["type", "date"],
    },
    { key: "issn", label: "The journal has a valid ISSN", step: 1 },
    {
      key: "indexing",
      label: "At least one indexing level, with its reference",
      step: 1,
      fallbacks: ["au", "ugc"],
    },
    { key: "quartile", label: "The journal has a quartile", step: 1 },
    { key: "scopus", label: "Your Scopus author profile is linked", step: 2 },
    {
      key: "author-cap",
      label: `The paper has ${rules.max_authors} authors or fewer`,
      step: 2,
    },
    { key: "affiliation", label: `Affiliated to ${collegeName}`, step: 2 },
    { key: "paper-file", label: "The published paper is attached", step: 3 },
    {
      key: "refs-few",
      label: `${rules.min_sec_references} cited SEC references attached and numbered (${numbered} of ${refs.length} attached ${refs.length === 1 ? "file carries" : "files carry"} a number)`,
      step: 3,
      fallbacks: [
        "refs-none",
        "ref-numbers",
        "refs-url-only",
        "ref-numbers-zero",
        "ref-numbers-some",
      ],
    },
    { key: "prior", label: "No earlier payment found for this paper", step: 4 },
  ]

  return (
    <section className="space-y-3">
      <SectionTitle>Before it goes</SectionTitle>
      <ul className="divide-y divide-line border-y border-line">
        {rows.map((row) => {
          const problem =
            byKey.get(row.key) ?? row.fallbacks?.map((k) => byKey.get(k)).find(Boolean)
          const style = problem ? PROBLEM_STYLE[problem.kind] : null
          return (
            <li
              key={row.key}
              className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 py-2"
            >
              <span className={cn("min-w-0 text-sm", problem && "text-fg")}>{row.label}</span>
              {problem ? (
                <button
                  type="button"
                  onClick={() => onGoToProblem(problem)}
                  className={cn(
                    "shrink-0 text-sm font-medium underline-offset-2 hover:underline",
                    style?.tone === "critical" && "text-critical",
                    style?.tone === "caution" && "text-caution",
                    style?.tone === "info" && "text-fg-muted"
                  )}
                >
                  {style?.word}
                </button>
              ) : (
                <span className="shrink-0 text-sm text-positive">Yes</span>
              )}
            </li>
          )
        })}
      </ul>
    </section>
  )
}


/* ------------------------------------------------------------------------ */
/* Team picker — student project claims                                     */
/* ------------------------------------------------------------------------ */

type TeamLookup = {
  code: string
  title: string | null
  department: string | null
  academic_year: string | null
  mentor_name: string | null
  members: {
    id: string
    name: string
    register_number: string | null
    programme: string | null
    year_of_study: string | null
    mentor_name: string | null
  }[]
}

/**
 * Find the team by the code on the project sheet, then agree with what comes
 * back.
 *
 * By code rather than by picking from a list: the code is what is printed on
 * the sheet in front of the claimant, and a list of every student project in
 * the college is neither what they came for nor theirs to browse. A code that
 * matches nothing is an ordinary answer here, not an error — the first time a
 * project is entered anywhere, no team exists yet — so it says so and points
 * at where teams are made, instead of rendering a failure.
 *
 * Nothing is confirmed silently. The students are shown by name and register
 * number because that is what the claimant is being asked to vouch for, and a
 * code echoed back as "found" would let a mistyped digit attach somebody
 * else's project to a payment.
 */
function TeamPicker({
  code,
  onCode,
  required,
}: {
  code: string
  onCode: (code: string) => void
  /** The claim names no team yet and the server will refuse it. */
  required?: boolean
}) {
  const trimmed = code.trim()
  const { data, isLoading, error } = useApi<TeamLookup>(
    ["team", trimmed],
    `/api/teams/${encodeURIComponent(trimmed)}`,
    { enabled: trimmed.length >= 2 }
  )

  // A 404 means "no team with that code yet", which is a normal state of the
  // world rather than something going wrong.
  const notFound = !!error && (error as { status?: number }).status === 404

  return (
    <div className="space-y-3 rounded-md border border-line p-4">
      <Field
        label="Team code"
        hint="The code on the project sheet — for example CSE-24-011."
        error={required ? "A student project claim cannot be filed without one." : undefined}
      >
        <Input
          value={code}
          onChange={(e) => onCode(e.target.value)}
          placeholder="CSE-24-011"
        />
      </Field>

      {trimmed.length < 2 ? null : isLoading ? (
        <SkeletonText lines={2} />
      ) : notFound ? (
        <Callout tone="caution" title={`No team with the code ${trimmed}`}>
          Teams are created once, with the students on them, and then claimed
          against by code. If this project has not been entered yet, create the
          team first — this claim cannot be filed until it names one.
        </Callout>
      ) : error ? (
        <Callout tone="critical" title="Could not look that code up">
          The server did not answer. Nothing you have typed has been lost.
        </Callout>
      ) : data ? (
        <div className="space-y-2">
          <div>
            <p className="text-sm font-medium">{data.title || "Untitled project"}</p>
            <Meta>
              {[data.code, data.department, data.academic_year]
                .filter(Boolean)
                .join(" · ")}
            </Meta>
            {data.mentor_name ? <Meta>Mentor: {data.mentor_name}</Meta> : null}
          </div>

          {data.members.length === 0 ? (
            <Callout tone="caution" title="This team has no students on it">
              The team exists but nobody is listed on it, so the claim would
              name a project with no one behind it.
            </Callout>
          ) : (
            <ul className="divide-y divide-line border-y border-line">
              {data.members.map((m) => (
                <li key={m.id} className="px-1 py-2">
                  <p className="text-sm">{m.name}</p>
                  <Meta>
                    {[m.register_number, m.programme, m.year_of_study]
                      .filter(Boolean)
                      .join(" · ") || "No register number recorded"}
                  </Meta>
                </li>
              ))}
            </ul>
          )}

          <p className="text-xs text-fg-subtle">
            Check the names and register numbers before filing. This is what
            the claim says the project was, and who it was by.
          </p>
        </div>
      ) : null}
    </div>
  )
}
