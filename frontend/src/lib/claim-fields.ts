import type { Claim } from "@/lib/api"

export type UploadedFileRef = {
  url: string
  filename: string
  size_bytes: number
}

/**
 * One cited reference authored by SEC faculty.
 *
 * Previously the number, the title, and the PDF were three parallel fields, so
 * nothing said which file proved which citation — the approver had to guess and
 * the claimant typed the same set out three times.
 */
export type SecCitation = {
  /** As printed in the manuscript's reference list. */
  number: string
  title: string
  file: UploadedFileRef | null
}

export function emptyCitation(): SecCitation {
  return { number: "", title: "", file: null }
}

/** The ERP sheets read these two columns; the server derives them the same way. */
export function citationNumbers(citations: SecCitation[]): string {
  return citations
    .map((c) => c.number.trim())
    .filter(Boolean)
    .join(", ")
}

export function citationTitles(citations: SecCitation[]): string {
  return citations
    .map((c) => c.title.trim())
    .filter(Boolean)
    .join("\n")
}

export type PublicationFormState = {
  owner_id?: string | null
  email: string
  faculty_name: string
  department: string
  staff_id: string
  biometric_id: string
  designation: string
  scopus_author_url: string
  paper_title: string
  journal_title: string
  self_reported_quartile: string
  quartile: string
  issn: string
  yukthi_id: string
  publication_date: string
  publication_year: string
  /** An article can be filed under more than one type. */
  publication_types: string[]
  aggregation_type: string
  /** A journal is often in several indexes at once — Scopus and UGC Care, say. */
  indexing_levels: string[]
  /** Separate registers, separate numbers. */
  au_annexure_ref: string
  ugc_care_ref: string
  doi: string
  total_authors: number
  author_position: number
  snip: string
  impact_factor: string
  is_student_publication: boolean
  affiliation_ok: boolean
  /** Number + title + file, kept together. Replaces sec_refs / reference_articles. */
  sec_citations: SecCitation[]
  proof_url: string
  sec_proof_url: string
  proof_files: UploadedFileRef[]
  claim_reason: ClaimReason
  subject_category: string
}

export const PUBLICATION_STEPS = [
  "Identity",
  "Publication",
  "Authors",
  "Documents",
  "Review",
] as const

export const QUARTILE_OPTIONS = ["Q1", "Q2", "Q3", "Q4", "Others"]

/**
 * Evidence caps, mirroring ATTACHMENT_LIMITS in core/api.py. These are abuse
 * ceilings rather than editorial limits — a paper can cite many SEC-affiliated
 * references, and the published article sometimes arrives split across files.
 */
export const MAX_PAPER_FILES = 10
export const MAX_REFERENCE_FILES = 50

/** Policy minimum: fewer than this is counted but carries no remuneration. */
export const EXPECTED_SEC_REFERENCES = 2

/** Wording matches the official claim form; the value is what the ERP stores. */
export const PUBLICATION_TYPES = [
  { value: "Journal", label: "Regular Research Article" },
  { value: "Conference Proceeding", label: "Conference Proceedings" },
  { value: "Book Series", label: "Book Chapter" },
  { value: "Other", label: "Others" },
] as const

export const INDEXING_LEVELS = [
  { value: "Scopus", label: "Scopus", hint: "Elsevier Scopus indexed" },
  { value: "SCIE", label: "Web of Science — SCIE", hint: "Science Citation Index Expanded" },
  { value: "ESCI", label: "Web of Science — ESCI", hint: "Emerging Sources Citation Index" },
  { value: "AU Annexure", label: "AU Annexure", hint: "Reference number required" },
  { value: "UGC Care", label: "UGC Care", hint: "Reference number required" },
] as const

/** Max authors the scheme pays for; beyond this the publication is not eligible. */
export const MAX_ELIGIBLE_AUTHORS = 9

/** Indexing levels where the form demands a reference number (or an explicit NA). */
export const ANNEXURE_LEVELS = ["AU Annexure", "UGC Care"]

export const DESIGNATIONS = [
  "Professor",
  "Associate Professor",
  "Assistant Professor",
  "Research Faculty",
]

/**
 * The four canonical designations, plus whatever this person's record already
 * says.
 *
 * The staff roster carries grades these four do not cover — "Assistant
 * Professor (OG)", "Professor & Head", "Lab-Technician". Offering only the four
 * left the field blank for all but one person on the roster, forcing them to
 * overwrite their real grade with a coarser one just to get past the step.
 */
export function designationOptions(
  ...current: (string | null | undefined)[]
): { value: string; label: string }[] {
  const extra = current.filter(
    (d): d is string => !!d && !DESIGNATIONS.includes(d),
  )
  return [...new Set([...extra, ...DESIGNATIONS])].map((d) => ({ value: d, label: d }))
}

export type ClaimReason = "INCENTIVE" | "COUNT_ONLY"

export const CLAIM_REASONS: {
  value: ClaimReason
  label: string
  description: string
  badge: string
}[] = [
  {
    value: "INCENTIVE",
    label: "Claim the Faculty Publication Incentive",
    description:
      "This article will NOT be submitted for Final Year Student Project Reimbursement. The incentive is calculated from SNIP and your author position.",
    badge: "Option A",
  },
  {
    value: "COUNT_ONLY",
    label: "Record for publication count only",
    description:
      "This article will also be submitted for Final Year Student Project Reimbursement. No incentive is payable, so SNIP is recorded as 0.",
    badge: "Option B",
  },
]

/** Reference numbers are stored as the form writes them: "14, 15, 57". */
export function parseRefNumbers(raw: string): string[] {
  return raw
    .split(/[,\s]+/)
    .map((p) => p.trim())
    .filter(Boolean)
}

export function joinRefNumbers(tags: string[]): string {
  return tags.join(", ")
}

/**
 * Sanity ceiling mirroring the default `snip_cap` policy value. The server is
 * authoritative; this exists so a typo reads as a field error instead of coming
 * back as a calc_error on an already-submitted claim.
 */
export const SNIP_MAX = 30

const ISSN_RE = /^\d{4}-\d{3}[\dxX]$/
const SCOPUS_AUTHOR_RE = /scopus\.com/i
const DOI_RE = /^10\.\d{4,9}\/\S+$/i

const AGGREGATION_TO_TYPE: Record<string, string> = {
  Journal: "Journal",
  "Trade Journal": "Journal",
  "Conference Proceeding": "Conference Proceeding",
  "Book Series": "Book Series",
  Book: "Book Series",
}

export type EnrichResult = {
  ok: boolean
  matched_title?: string | null
  doi?: string | null
  issn?: string | null
  journal?: string | null
  cover_date?: string | null
  publication_year?: number | null
  aggregation_type?: string | null
  author_count?: number | null
  snip?: number | null
  quartile?: string | null
  subject_category?: string | null
  paper?: {
    title?: string | null
    aggregation_type?: string | null
    publication_year?: number | null
    author_count?: number | null
    cover_date?: string | null
  } | null
  serial?: { snip?: number | null; journal_title?: string | null } | null
}

const ENRICH_LABELS: Record<string, string> = {
  paper_title: "Title",
  journal_title: "Journal",
  doi: "DOI",
  issn: "ISSN",
  publication_date: "Publication date",
  publication_year: "Year",
  publication_types: "Publication type",
  indexing_levels: "Indexing",
  snip: "SNIP",
  quartile: "Quartile",
  subject_category: "Subject",
  total_authors: "Author count",
}

/** Insert the ISSN hyphen as the user types: 1234567X → 1234-567X */
export function formatIssn(raw: string): string {
  const cleaned = raw.replace(/[^0-9Xx]/g, "").toUpperCase().slice(0, 8)
  if (cleaned.length <= 4) return cleaned
  return `${cleaned.slice(0, 4)}-${cleaned.slice(4)}`
}

/**
 * Pull the numeric author ID out of a pasted Scopus profile link.
 * Mirrors core/services/scopus.py::extract_author_id so the profile stores the
 * same value the linkage check queries with.
 */
export function extractScopusAuthorId(raw: string): string {
  const s = String(raw || "").trim()
  const m = s.match(/authorId[s]?=(\d+)/i)
  if (m) return m[1]
  return /^\d{6,}$/.test(s) ? s : ""
}

/** Strip doi.org URLs so a paste becomes a bare DOI. */
export function normalizeDoiInput(raw: string): string {
  return raw.trim().replace(/^https?:\/\/(dx\.)?doi\.org\//i, "")
}

export function isLikelyDoi(raw: string): boolean {
  return DOI_RE.test(normalizeDoiInput(raw))
}

export function isIssnComplete(raw: string): boolean {
  return ISSN_RE.test(formatIssn(raw))
}

/** Scopus coverDate is YYYY-MM-DD, YYYY-MM, or YYYY — DateField wants ISO. */
export function coverDateToIso(raw: string | null | undefined): string {
  if (!raw) return ""
  const s = raw.trim()
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s
  if (/^\d{4}-\d{2}$/.test(s)) return `${s}-01`
  if (/^\d{4}$/.test(s)) return `${s}-01-01`
  return ""
}

function mapAggregationType(raw: string | null | undefined): string {
  if (!raw) return ""
  return AGGREGATION_TO_TYPE[raw] || ""
}

function takeText(next: string, current: string, overwrite: boolean): string {
  if (!next) return current
  if (overwrite || !current.trim()) return next
  return current
}

/**
 * Map a /lookup/enrich payload onto the form.
 * Quiet fills only empty fields; an explicit Autofill click overwrites.
 */
export function applyEnrichment(
  form: PublicationFormState,
  res: EnrichResult,
  opts: { overwrite?: boolean } = {}
): { form: PublicationFormState; filled: string[] } {
  const overwrite = opts.overwrite === true
  const paper = res.paper || {}
  const next: PublicationFormState = { ...form }
  const changed: string[] = []

  const mark = (key: string, before: unknown, after: unknown) => {
    if (before !== after) changed.push(key)
  }

  const title = (res.matched_title || paper.title || "").trim()
  mark("paper_title", next.paper_title, (next.paper_title = takeText(title, next.paper_title, overwrite)))

  const journal = (res.journal || "").trim()
  mark("journal_title", next.journal_title, (next.journal_title = takeText(journal, next.journal_title, overwrite)))

  const doi = normalizeDoiInput(res.doi || "")
  mark("doi", next.doi, (next.doi = takeText(doi, next.doi, overwrite)))

  const issn = formatIssn(res.issn || "")
  mark("issn", next.issn, (next.issn = takeText(issn, next.issn, overwrite)))

  const date = coverDateToIso(res.cover_date || paper.cover_date)
  mark(
    "publication_date",
    next.publication_date,
    (next.publication_date = takeText(date, next.publication_date, overwrite))
  )

  const year = res.publication_year || paper.publication_year
  if (year && (overwrite || !next.publication_year.trim())) {
    mark("publication_year", next.publication_year, (next.publication_year = String(year)))
  }

  const pubType = mapAggregationType(res.aggregation_type || paper.aggregation_type)
  if (pubType && !next.publication_types.includes(pubType)) {
    // Added, not substituted — the index knows one of the types, not all of them.
    next.publication_types = [...next.publication_types, pubType]
    next.aggregation_type = next.aggregation_type || pubType
    changed.push("publication_types")
  }

  // A Scopus hit proves Scopus indexing; it says nothing about the others, so
  // it is added to the set rather than replacing what the claimant ticked.
  if ((res.paper || res.serial) && !next.indexing_levels.includes("Scopus")) {
    next.indexing_levels = [...next.indexing_levels, "Scopus"]
    changed.push("indexing_levels")
  }

  const quartile = (res.quartile || "").trim()
  if (quartile && (overwrite || (!next.quartile && !next.self_reported_quartile))) {
    mark("quartile", next.quartile, (next.quartile = quartile))
    next.self_reported_quartile = quartile
  }

  if (next.claim_reason !== "COUNT_ONLY" && res.snip != null && (overwrite || !next.snip.trim())) {
    mark("snip", next.snip, (next.snip = String(res.snip)))
  }

  const subject = (res.subject_category || "").trim()
  mark(
    "subject_category",
    next.subject_category,
    (next.subject_category = takeText(subject, next.subject_category, overwrite))
  )

  const authors = res.author_count || paper.author_count
  if (authors && authors >= 1 && (overwrite || next.total_authors === 1)) {
    const clamped = Math.max(1, Math.min(50, authors))
    mark("total_authors", next.total_authors, (next.total_authors = clamped))
    next.author_position = Math.min(next.author_position, clamped)
  }

  const filled = Array.from(new Set(changed.map((k) => ENRICH_LABELS[k] || k)))
  return { form: next, filled }
}

export type FieldErrors = Partial<Record<keyof PublicationFormState, string>>

/**
 * Mirrors the server rules in core/api.py::_check_mandatory_fields so the user
 * sees problems on the step that caused them, not as one lump on submit.
 */
export function validateStep(step: number, form: PublicationFormState): FieldErrors {
  const e: FieldErrors = {}

  if (step === 0) {
    if (!form.faculty_name.trim()) e.faculty_name = "Faculty name is required"
    if (!form.department.trim()) e.department = "Select your department"
    if (!form.designation.trim()) e.designation = "Select your designation"
    // Read-only and sourced from the faculty master, so presence is all we can require —
    // the user has no way to correct the format themselves.
    if (!form.biometric_id.trim()) {
      e.biometric_id = "Biometric ID is missing from your profile — contact the research cell"
    }
    if (!form.scopus_author_url.trim()) {
      e.scopus_author_url = "Your Scopus author link is required"
    } else if (!SCOPUS_AUTHOR_RE.test(form.scopus_author_url)) {
      e.scopus_author_url = "Enter a link on scopus.com"
    }
  }

  if (step === 1) {
    if (!form.paper_title.trim()) e.paper_title = "Title of the paper is required"
    if (!form.journal_title.trim()) e.journal_title = "Journal name is required"
    if (!form.publication_types.length) {
      e.publication_types = "Select the publication type"
    }
    if (!form.indexing_levels.length) {
      e.indexing_levels = "Select every index the journal is listed in"
    }
    if (!form.issn.trim()) {
      e.issn = "ISSN is required"
    } else if (!ISSN_RE.test(form.issn.trim())) {
      e.issn = "Use the ISSN format 1234-567X"
    }
    if (!form.publication_date.trim()) e.publication_date = "Date of publication is required"
    if (!form.yukthi_id.trim()) e.yukthi_id = "Yukthi ID is required"
    if (form.indexing_levels.includes("AU Annexure") && !form.au_annexure_ref.trim()) {
      e.au_annexure_ref = "AU Annexure requires its reference number — enter NA if none"
    }
    if (form.indexing_levels.includes("UGC Care") && !form.ugc_care_ref.trim()) {
      e.ugc_care_ref = "UGC Care requires its reference number — enter NA if none"
    }
  }

  if (step === 2) {
    if (!form.claim_reason) e.claim_reason = "Choose why you are filing this article"
    if (form.total_authors < 1) e.total_authors = "At least one author"
    if (form.author_position > form.total_authors) {
      e.author_position = "Your position cannot exceed the total number of authors"
    }
    if (!form.quartile && !form.self_reported_quartile) {
      e.quartile = "Select the journal quartile"
    }
    if (form.claim_reason === "INCENTIVE") {
      const snip = Number(form.snip)
      if (form.snip.trim() === "") {
        e.snip = "SNIP is required for an incentive claim"
      } else if (Number.isNaN(snip)) {
        e.snip = "SNIP must be a number"
      } else if (snip < 0) {
        e.snip = "SNIP cannot be negative"
      } else if (snip > SNIP_MAX) {
        e.snip = `SNIP looks too high — ${SNIP_MAX} is the maximum accepted`
      }
    }
    if (form.impact_factor.trim() && Number.isNaN(Number(form.impact_factor))) {
      e.impact_factor = "Impact factor must be a number"
    }
  }

  if (step === 3) {
    if (!form.affiliation_ok) {
      e.affiliation_ok = "The article must be affiliated to Saveetha Engineering College"
    }
    if (!form.proof_files.length) e.proof_files = "Upload the full-length published paper"

    const filled = form.sec_citations.filter(
      (c) => c.number.trim() || c.title.trim() || c.file
    )
    if (!filled.length) {
      e.sec_citations = "Add the SEC-affiliated references you cited"
    } else {
      // Each citation is one thing; a half-filled one helps nobody downstream.
      const incomplete = filled.findIndex(
        (c) => !c.number.trim() || !c.title.trim() || !c.file
      )
      if (incomplete >= 0) {
        e.sec_citations = `Reference ${incomplete + 1} needs a number, a title, and its file`
      }
    }
  }

  return e
}

export function firstInvalidStep(form: PublicationFormState): number | null {
  for (let s = 0; s < 4; s++) {
    if (Object.keys(validateStep(s, form)).length) return s
  }
  return null
}

export function emptyFormState(): PublicationFormState {
  return {
    owner_id: null,
    email: "",
    faculty_name: "",
    department: "",
    staff_id: "",
    biometric_id: "",
    designation: "",
    scopus_author_url: "",
    paper_title: "",
    journal_title: "",
    self_reported_quartile: "",
    quartile: "",
    issn: "",
    yukthi_id: "",
    publication_date: "",
    publication_year: "",
    publication_types: [],
    aggregation_type: "",
    indexing_levels: [],
    au_annexure_ref: "",
    ugc_care_ref: "",
    doi: "",
    total_authors: 1,
    author_position: 1,
    snip: "",
    impact_factor: "",
    is_student_publication: false,
    // Off by default: the claimant affirms this, the form does not affirm it
    // for them.
    affiliation_ok: false,
    // Two are expected, so the form opens with two blanks rather than an
    // empty area and an "add" button the claimant has to discover.
    sec_citations: [emptyCitation(), emptyCitation()],
    proof_url: "",
    sec_proof_url: "",
    proof_files: [],
    claim_reason: "INCENTIVE",
    subject_category: "",
  }
}

export function formStateFromUser(user: {
  email?: string
  name?: string
  department?: string | null
  staff_id?: string | null
  biometric_id?: string | null
  designation?: string | null
  scopus_author_url?: string | null
  id?: string
}): PublicationFormState {
  const base = emptyFormState()
  return {
    ...base,
    owner_id: user.id || null,
    email: user.email || "",
    faculty_name: user.name || "",
    department: user.department || "",
    staff_id: user.staff_id || "",
    biometric_id: user.biometric_id || "",
    designation: user.designation || "",
    scopus_author_url: user.scopus_author_url || "",
  }
}

export function formStateFromFacultyOption(opt: {
  owner_id?: string | null
  email?: string | null
  name?: string
  department?: string | null
  staff_id?: string | null
  biometric_id?: string | null
  designation?: string | null
  scopus_author_url?: string | null
}): PublicationFormState {
  const base = emptyFormState()
  return {
    ...base,
    owner_id: opt.owner_id || null,
    email: opt.email || "",
    faculty_name: opt.name || "",
    department: opt.department || "",
    staff_id: opt.staff_id || "",
    biometric_id: opt.biometric_id || "",
    designation: opt.designation || "",
    scopus_author_url: opt.scopus_author_url || "",
  }
}

export function claimToFormState(claim: Claim): PublicationFormState {
  const base = emptyFormState()
  const sec_refs = claim.sec_refs || ""
  // Proper column since the attachments migration; older rows stashed it in authors_json.
  let reference_articles = claim.reference_articles || ""
  if (!reference_articles && claim.authors_json) {
    try {
      const parsed = JSON.parse(claim.authors_json)
      if (typeof parsed === "string") reference_articles = parsed
      else if (parsed?.reference_articles) reference_articles = String(parsed.reference_articles)
    } catch {
      reference_articles = claim.authors_json
    }
  }

  const attachments = claim.attachments || []
  const pick = (kind: string): UploadedFileRef[] =>
    attachments
      .filter((a) => a.kind === kind)
      .map((a) => ({
        url: a.url,
        filename: a.filename || "Document.pdf",
        size_bytes: a.size_bytes || 0,
      }))

  // Fall back to the legacy single-URL columns for claims filed before attachments existed.
  const legacy = (url?: string | null): UploadedFileRef[] =>
    url ? [{ url, filename: url.split("/").pop() || "Document.pdf", size_bytes: 0 }] : []

  const proof_files = pick("PUBLISHED_PAPER").length
    ? pick("PUBLISHED_PAPER")
    : legacy(claim.proof_url)

  // Rebuild the citations. New claims carry number and title on the attachment
  // row; older ones only have the two free-text columns, so line those up by
  // position — imperfect, but it is all the old shape recorded.
  const refRows = attachments.filter((a) => a.kind === "SEC_REFERENCE")
  const legacyNumbers = parseRefNumbers(sec_refs)
  const legacyTitles = reference_articles.split("\n").map((t) => t.trim()).filter(Boolean)
  let sec_citations: SecCitation[] = refRows.map((a, i) => ({
    number: a.ref_number || legacyNumbers[i] || "",
    title: a.ref_title || legacyTitles[i] || "",
    file: {
      url: a.url,
      filename: a.filename || "Document",
      size_bytes: a.size_bytes || 0,
    },
  }))
  if (!sec_citations.length) {
    // No files at all: keep whatever numbers/titles were recorded.
    const rows = Math.max(legacyNumbers.length, legacyTitles.length)
    sec_citations = Array.from({ length: rows }, (_, i) => ({
      number: legacyNumbers[i] || "",
      title: legacyTitles[i] || "",
      file: i === 0 ? (legacy(claim.sec_proof_url)[0] ?? null) : null,
    }))
  }
  if (!sec_citations.length) sec_citations = [emptyCitation(), emptyCitation()]

  return {
    ...base,
    owner_id: claim.owner_id || null,
    email: claim.owner_email || "",
    faculty_name: claim.owner_name || "",
    department: claim.owner_department || "",
    staff_id: claim.staff_id || "",
    biometric_id: claim.biometric_id || "",
    designation: claim.designation || "",
    scopus_author_url: claim.scopus_author_url || "",
    paper_title: claim.paper_title || "",
    journal_title: claim.journal_title || "",
    self_reported_quartile: claim.self_reported_quartile || claim.quartile || "",
    quartile: claim.quartile || "",
    issn: claim.issn || "",
    yukthi_id: claim.yukthi_id || "",
    publication_date: claim.publication_date || "",
    publication_year: claim.publication_year ? String(claim.publication_year) : "",
    publication_types: (claim.publication_type || claim.aggregation_type || "")
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean),
    aggregation_type: claim.aggregation_type || claim.publication_type || "",
    indexing_levels: (claim.indexing_level || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    au_annexure_ref: claim.au_annexure_ref || "",
    ugc_care_ref: claim.ugc_care_ref || "",
    doi: claim.doi || "",
    total_authors: claim.total_authors || 1,
    author_position: claim.author_position || 1,
    snip: claim.snip != null ? String(claim.snip) : "",
    impact_factor: claim.impact_factor || "",
    is_student_publication: claim.is_student_publication || false,
    affiliation_ok: claim.affiliation_ok !== false,
    sec_citations,
    proof_url: claim.proof_url || "",
    sec_proof_url: claim.sec_proof_url || "",
    proof_files,
    claim_reason: claim.claim_reason === "COUNT_ONLY" ? "COUNT_ONLY" : "INCENTIVE",
    subject_category: claim.subject_category || "",
  }
}

function parseYear(dateStr: string, yearStr: string): number | null {
  if (yearStr.trim()) {
    const y = parseInt(yearStr, 10)
    if (!Number.isNaN(y)) return y
  }
  if (dateStr.trim()) {
    const m = dateStr.match(/\d{4}/)
    if (m) return parseInt(m[0], 10)
  }
  return null
}

export function buildClaimPayload(
  form: PublicationFormState,
  opts: { submit?: boolean; contest_forward?: boolean; contest_note?: string; owner_id?: string | null } = {}
) {
  const quartile = form.quartile || form.self_reported_quartile || null
  const countOnly = form.claim_reason === "COUNT_ONLY"

  // A citation only travels once it has its file; number and title ride along
  // on the same row so nothing downstream has to pair them up again.
  const citations = form.sec_citations.filter((c) => c.file)
  const attachments = [
    ...form.proof_files.map((f) => ({ ...f, kind: "PUBLISHED_PAPER" })),
    ...citations.map((c) => ({
      ...(c.file as UploadedFileRef),
      kind: "SEC_REFERENCE",
      ref_number: c.number.trim() || null,
      ref_title: c.title.trim() || null,
    })),
  ]

  return {
    // Only the caller decides this. Falling back to form.owner_id would resend the
    // faculty's own id in faculty mode, which the server rejects as an admin-proxy attempt.
    owner_id: opts.owner_id ?? undefined,
    paper_title: form.paper_title.trim() || null,
    journal_title: form.journal_title.trim() || null,
    issn: form.issn.trim() || null,
    doi: form.doi.trim() || null,
    publication_date: form.publication_date.trim() || null,
    publication_year: parseYear(form.publication_date, form.publication_year),
    publication_type: form.publication_types.join(", ") || null,
    // One value for the ERP's aggregation column; the set lives in publication_type.
    aggregation_type: form.aggregation_type || form.publication_types[0] || null,
    indexing_level: form.indexing_levels.join(", ") || null,
    au_annexure_ref: form.au_annexure_ref.trim() || null,
    ugc_care_ref: form.ugc_care_ref.trim() || null,
    yukthi_id: form.yukthi_id.trim() || null,
    self_reported_quartile: form.self_reported_quartile || quartile,
    quartile,
    impact_factor: form.impact_factor.trim() || null,
    proof_url: form.proof_files[0]?.url || form.proof_url.trim() || null,
    // Derived, and the server derives them again from the same citations.
    sec_refs: citationNumbers(citations) || null,
    sec_proof_url: citations[0]?.file?.url || form.sec_proof_url.trim() || null,
    reference_articles: citationTitles(citations) || null,
    claim_reason: form.claim_reason,
    attachments,
    scopus_author_url: form.scopus_author_url.trim() || null,
    // The step-0 hint promises this is saved to your profile on submit, and
    // _bind_identity_from_user reads it — it was simply never sent.
    designation: form.designation.trim() || null,
    total_authors: form.total_authors,
    author_position: form.author_position,
    // Option B carries no money; the server enforces this too.
    snip: countOnly ? 0 : form.snip.trim() === "" ? null : Number(form.snip),
    is_student_publication: countOnly || form.is_student_publication,
    affiliation_ok: form.affiliation_ok,
    subject_category: form.subject_category.trim() || null,
    submit: opts.submit ?? false,
    contest_forward: opts.contest_forward ?? false,
    contest_note: opts.contest_note ?? null,
  }
}
