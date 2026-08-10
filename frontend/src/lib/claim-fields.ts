import type { Claim } from "@/lib/api"

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
  publication_type: string
  aggregation_type: string
  indexing_level: string
  indexing_ref: string
  doi: string
  total_authors: number
  author_position: number
  snip: string
  impact_factor: string
  is_student_publication: boolean
  affiliation_ok: boolean
  sec_refs: string
  reference_articles: string
  proof_url: string
  sec_proof_url: string
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
export const PUBLICATION_TYPES = [
  "Journal",
  "Conference Proceeding",
  "Book Series",
  "Other",
]
export const INDEXING_LEVELS = [
  "Scopus",
  "SCI",
  "SCIE",
  "SSCI",
  "AHCI",
  "UGC CARE",
  "AU Annexure",
  "Other",
  "NA",
]

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
    publication_type: "Journal",
    aggregation_type: "Journal",
    indexing_level: "",
    indexing_ref: "",
    doi: "",
    total_authors: 1,
    author_position: 1,
    snip: "",
    impact_factor: "",
    is_student_publication: false,
    affiliation_ok: true,
    sec_refs: "",
    reference_articles: "",
    proof_url: "",
    sec_proof_url: "",
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
  let reference_articles = ""
  let sec_refs = claim.sec_refs || ""
  if (claim.authors_json) {
    try {
      const parsed = JSON.parse(claim.authors_json)
      if (typeof parsed === "string") reference_articles = parsed
      else if (parsed?.reference_articles) reference_articles = String(parsed.reference_articles)
    } catch {
      reference_articles = claim.authors_json
    }
  }
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
    publication_type: claim.publication_type || claim.aggregation_type || "Journal",
    aggregation_type: claim.aggregation_type || claim.publication_type || "Journal",
    indexing_level: claim.indexing_level || "",
    indexing_ref: claim.indexing_ref || "",
    doi: claim.doi || "",
    total_authors: claim.total_authors || 1,
    author_position: claim.author_position || 1,
    snip: claim.snip != null ? String(claim.snip) : "",
    impact_factor: claim.impact_factor || "",
    is_student_publication: claim.is_student_publication || false,
    affiliation_ok: claim.affiliation_ok !== false,
    sec_refs,
    reference_articles,
    proof_url: claim.proof_url || "",
    sec_proof_url: claim.sec_proof_url || "",
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
  const authors_json =
    form.reference_articles.trim() ?
      JSON.stringify({ reference_articles: form.reference_articles.trim() })
    : null

  return {
    owner_id: opts.owner_id ?? form.owner_id ?? undefined,
    paper_title: form.paper_title.trim() || null,
    journal_title: form.journal_title.trim() || null,
    issn: form.issn.trim() || null,
    doi: form.doi.trim() || null,
    publication_date: form.publication_date.trim() || null,
    publication_year: parseYear(form.publication_date, form.publication_year),
    publication_type: form.publication_type || null,
    aggregation_type: form.aggregation_type || form.publication_type || null,
    indexing_level: form.indexing_level || null,
    indexing_ref: form.indexing_ref.trim() || null,
    yukthi_id: form.yukthi_id.trim() || null,
    self_reported_quartile: form.self_reported_quartile || quartile,
    quartile,
    impact_factor: form.impact_factor.trim() || null,
    proof_url: form.proof_url.trim() || null,
    sec_refs: form.sec_refs.trim() || null,
    sec_proof_url: form.sec_proof_url.trim() || null,
    scopus_author_url: form.scopus_author_url.trim() || null,
    total_authors: form.total_authors,
    author_position: form.author_position,
    snip: form.snip.trim() === "" ? null : Number(form.snip),
    is_student_publication: form.is_student_publication,
    affiliation_ok: form.affiliation_ok,
    authors_json,
    subject_category: form.subject_category.trim() || null,
    submit: opts.submit ?? false,
    contest_forward: opts.contest_forward ?? false,
    contest_note: opts.contest_note ?? null,
  }
}
