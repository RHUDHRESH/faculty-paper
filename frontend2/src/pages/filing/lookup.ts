/**
 * `POST /api/lookup/paper`, and what its answer puts on the filing form.
 *
 * The shape is read out of `backend/core/services/paper_lookup.py`, not
 * guessed. The mapping lives here, apart from the page, because it is the part
 * with rules worth pinning: a lookup fills what it found and names what it
 * filled, never confirms the affiliation for the claimant, never invents a day
 * the source only knew to the month, and -- unless the claimant asked for it
 * -- never replaces something they typed.
 */
import { isoDate, normaliseDoi, normaliseIssn } from "./identifiers"
import type { FormState } from "./types"

export type LookupAuthor = {
  position: number
  name: string
  orcid?: string | null
  affiliations: string[]
  institutions?: string[]
  is_claimant?: boolean
  /** Whether this author's printed affiliation names the college: yes, a
   *  differently named body sharing its distinctive word, no -- or null when
   *  the source gave no affiliation for them. */
  college?: "yes" | "other" | "no" | null
  scopus_id?: string | null
}

/** The author list as the claim keeps it (`authors_json`), so a reopened
 *  draft still shows who the authors are and which one is the claimant. */
export type StoredAuthor = {
  position: number
  name: string
  college?: "yes" | "other" | "no" | null
}

export type LookupSource = {
  id: string
  label: string
  ok: boolean
  count: number | null
  detail: string | null
  code: string | null
}

export type LookupMetrics = {
  found: boolean
  journal: string | null
  issn: string | null
  matched_by: "issn" | "title" | null
  quartile: string | null
  category: string | null
  categories?: { category: string; quartile: string | null }[]
  sjr: number | null
  dataset_year: number | null
  snip: number | null
  snip_year: number | null
  engineering_class: string | null
  scimago_url?: string | null
}

export type PaperLookup = {
  ok: boolean
  code: "ok" | "choose" | "not_found" | "bad_input" | "scopus_link" | "unreachable" | "error"
  message: string | null
  paper: {
    title: string | null
    doi: string | null
    journal: string | null
    issns: string[]
    issn: string | null
    publication_date: string | null
    publication_date_precision: "day" | "month" | "year" | null
    publication_year: number | null
    document_type: string | null
    publication_type: string | null
    publisher?: string | null
    volume?: string | null
    issue?: string | null
    pages?: string | null
    citations: number
    open_access_url: string | null
    is_retracted: boolean
    eid?: string | null
    scopus_url?: string | null
    total_authors: number | null
    authors: LookupAuthor[]
  } | null
  claimant: {
    position: number | null
    name_on_paper: string | null
    confidence: "exact" | "likely" | "ambiguous" | "none"
    matched_on: string | null
    candidates: number[]
  } | null
  affiliation: {
    status: "yes" | "other" | "no" | "unknown"
    claimant_status: string | null
    positions: number[]
    text: string | null
  } | null
  metrics: LookupMetrics | null
  /** Field name to the source it came from, as a reader would name it:
   *  "OpenAlex", "Crossref", "Scopus" or "Our journal data". */
  field_sources: Record<string, string>
  sources: LookupSource[]
  scopus_status: "ok" | "not_configured" | "unavailable"
  warnings: string[]
  to_check: { key: string; text: string }[]
  already_filed: { id: string; ticket_number: string | null; is_draft: boolean } | null
  candidates: {
    doi: string | null
    title: string | null
    journal: string | null
    year: number | null
    authors: string[]
    author_count: number | null
  }[]
}

/** The form's own publication types; anything else is left for the claimant. */
const FORM_TYPES = new Set(["Journal", "Conference Proceeding", "Book Series", "Other"])

/**
 * The form patch a lookup answer makes, and a list of what it filled.
 *
 * `overwrite` is the difference between the claimant asking for this and it
 * happening to them: a lookup they ran replaces what is on screen; one run on
 * their behalf (reopening a draft) only fills what is blank.
 */
export function applyLookup(
  prev: FormState,
  res: PaperLookup,
  opts: { overwrite: boolean }
): { patch: Partial<FormState>; filled: string[] } {
  const patch: Partial<FormState> = {}
  const filled: string[] = []
  const paper = res.paper
  if (!res.ok || !paper) return { patch, filled }

  const wants = (current: string, next: string) =>
    Boolean(next) && next !== current && (opts.overwrite || !current.trim())

  const set = <K extends keyof FormState>(key: K, value: FormState[K], label: string) => {
    patch[key] = value
    filled.push(label)
  }

  const title = (paper.title || "").trim()
  if (wants(prev.paperTitle, title)) set("paperTitle", title, "the title")

  const doi = normaliseDoi(paper.doi || "")
  if (wants(prev.doi, doi)) set("doi", doi, "the DOI")

  const journal = (paper.journal || "").trim()
  if (wants(prev.journalTitle, journal)) set("journalTitle", journal, "the journal")

  const issn = paper.issn ? normaliseIssn(paper.issn) : ""
  if (wants(prev.issn, issn)) set("issn", issn, "the ISSN")

  // A month is not a date. Filling the 1st would be a day invented for the
  // claimant, on the field the research cell checks most often.
  if (paper.publication_date_precision === "day" && paper.publication_date) {
    const date = isoDate(paper.publication_date)
    if (wants(prev.publicationDate, date)) set("publicationDate", date, "the date it was published")
  }

  const type = paper.publication_type && FORM_TYPES.has(paper.publication_type) ? paper.publication_type : ""
  if (wants(prev.publicationType, type)) set("publicationType", type, "the publication type")

  if (paper.authors.length) {
    const authors: StoredAuthor[] = paper.authors.map((a) => ({
      position: a.position,
      name: a.name,
      college: a.college ?? null,
    }))
    if (opts.overwrite || prev.authors.length === 0) set("authors", authors, "the authors")
  }

  const total = paper.total_authors || paper.authors.length
  if (total && total !== prev.totalAuthors && (opts.overwrite || prev.totalAuthors === 1)) {
    set("totalAuthors", Math.max(1, Math.min(200, total)), "the number of authors")
  }

  // Only a match the lookup is sure enough of to act on. "Likely" still fills
  // it -- the found card asks the claimant to confirm -- but two authors who
  // could equally be them is a question for them, not a guess for us.
  // Set even when it equals what is there: 1 is also the form's default, and
  // "the paper lists you first" is worth saying rather than looking unasked.
  const claimant = res.claimant
  if (
    claimant?.position &&
    (claimant.confidence === "exact" || claimant.confidence === "likely") &&
    (opts.overwrite || prev.authorPosition === 1)
  ) {
    set("authorPosition", claimant.position, "your author position")
  }

  const metrics = res.metrics
  if (metrics?.found && prev.claimReason !== "COUNT_ONLY") {
    if (metrics.snip != null) {
      const snip = String(metrics.snip)
      if (wants(prev.selfReportedSnip, snip)) set("selfReportedSnip", snip, "the SNIP")
    }
    if (metrics.quartile && metrics.quartile !== prev.selfReportedQuartile &&
        (opts.overwrite || !prev.selfReportedQuartile)) {
      set("selfReportedQuartile", metrics.quartile, "the quartile")
    }
  }
  if (metrics?.found && metrics.category && wants(prev.subjectCategory, metrics.category)) {
    set("subjectCategory", metrics.category, "the subject area")
  }

  // Added to the set, never substituted for it. Scopus holding the record
  // says so directly; a SNIP says so about the journal, because SNIP is
  // computed only for sources Scopus indexes.
  const inScopus = Boolean(paper.eid) || metrics?.snip != null
  if (inScopus && !prev.indexing.includes("Scopus")) {
    set("indexing", [...prev.indexing, "Scopus"], "Scopus indexing")
  }

  return { patch, filled }
}
