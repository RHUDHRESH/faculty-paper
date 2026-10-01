import type { ScopusProfile } from "@/ui/scopus"

/**
 * What `/api/directory/faculty*` sends (backend/core/api/faculty_directory.py).
 *
 * Money arrives only when the reader may see it: `incentive` on a row and
 * `payments` on a record are simply absent for a head of department (except
 * on their own), so a screen asks "is it there", never "what is the role".
 */

export type FacultyType = "REGULAR" | "RESEARCH"
export type MissingKey = "photo" | "scopus" | "department" | "designation"

export type FacultyRow = {
  id: string
  name: string
  initials: string
  photo_url: string | null
  department: string | null
  designation: string | null
  active: boolean
  role: string
  staff_id: string | null
  faculty_type: FacultyType
  /** A research threshold has been recorded. The value is `threshold`, only for those who may see it. */
  threshold_set: boolean
  threshold?: number | null
  scopus_author_id: string | null
  scopus_url: string | null
  orcid_id: string | null
  orcid_url: string | null
  papers: number
  papers_year: number
  citations: number
  h_index: number
  last_paper_year: number | null
  last_paper_on: string | null
  claims_filed_year: number
  claims_done: number
  claims_done_year: number
  completeness: number
  missing: MissingKey[]
  incentive?: { amount: number; total_amount: number }
}

export type DirectoryPayload = {
  total: number
  limit: number
  offset: number
  year: number
  money: boolean
  scope: "college" | "department"
  counts: { people: number; left: number; research: number; no_photo: number; no_scopus: number; no_papers_year: number }
  results: FacultyRow[]
}

export type GapsPayload = {
  population: number
  any: boolean
  categories: {
    key: MissingKey
    label: string
    count: number
    who_fixes: "office" | "person"
    hint: string
    people: {
      id: string
      name: string
      initials: string
      photo_url: string | null
      department: string | null
      designation: string | null
      fix_path: string
    }[]
  }[]
}

export type RecordPaper = {
  id: string
  title: string
  year: number | null
  date: string | null
  venue: string | null
  type: string | null
  quartile: string | null
  citations: number | null
  doi: string | null
  scopus_indexed: boolean
  author_position: number | null
  total_authors: number | null
  corresponding: boolean | null
  topics: string[]
  claim: { id: string | null; claim_no: string | null; stage: string; review_path: string | null; amount?: number } | null
  eligible: boolean
}

export type RecordClaim = {
  id: string
  claim_no: string | null
  title: string | null
  journal: string | null
  year: number | null
  quartile: string | null
  author_position: number | null
  stage: string
  filed_on: string | null
  review_path: string | null
  amount?: number | null
  paid_at?: string | null
}

export type RecordPayment = {
  id: string
  claim_id: string | null
  month: string | null
  title: string | null
  journal: string | null
  amount: number
  voucher: string | null
}

export type CoauthorIn = {
  user_id: string | null
  name: string
  department: string | null
  papers_together: number
  first_year_together: number | null
  last_year_together: number | null
  photo_url?: string | null
  initials?: string
}

export type CoauthorOut = {
  key: string
  name: string
  papers_together: number
  institutions: string[]
  countries: string[]
  last_year_together: number | null
}

export type FacultyRecordPayload = {
  person: Omit<FacultyRow, "papers" | "papers_year" | "citations" | "h_index" | "last_paper_year" | "last_paper_on" | "claims_filed_year" | "claims_done" | "claims_done_year" | "completeness" | "incentive"> & {
    employee_id: string | null
    email: string | null
    phone: string | null
  }
  viewer: { is_self: boolean; money: boolean; may_edit: boolean; sees_everyone: boolean; year: number }
  metrics: {
    total_publications: number
    total_citations: number
    h_index: number
    i10_index: number
    first_year: number | null
    last_year: number | null
    papers_this_year: number
  }
  papers: RecordPaper[]
  claims: RecordClaim[]
  payments: {
    total_amount: number
    this_year: { amount: number }
    count: number
    year: number
    rows: RecordPayment[]
  } | null
  research: {
    by_year: { year: number; papers: number; citations: number }[]
    quartiles: { name: string; papers: number }[]
    topics: { name: string; papers: number }[]
    interests: string[]
    coauthors_inside: CoauthorIn[]
    coauthors_outside: CoauthorOut[]
    scopus_profile: ScopusProfile | null
  }
  details: {
    bio: string | null
    interests: string[]
    skills: string[]
    joined: string | null
    changes_visible: boolean
    changes: {
      id: string
      field: string
      from: string | null
      to: string
      state: string
      note: string | null
      decision_note: string | null
      asked_on: string
      decided_on: string | null
    }[]
  }
}

const DAY = { day: "numeric", month: "short", year: "numeric" } as const

/** "11 Sept 2026", or just the year where that is all the record knows. */
export function paperDate(on: string | null | undefined, year: number | null | undefined): string {
  if (on) {
    const d = new Date(on)
    if (!Number.isNaN(d.getTime())) return d.toLocaleDateString("en-IN", DAY)
  }
  return year ? String(year) : "No date"
}

/** "Jun 2026" from "2026-06". */
export function monthLabel(month: string | null | undefined): string {
  if (!month) return "Date not recorded"
  const d = new Date(`${month.slice(0, 7)}-01T00:00:00`)
  return Number.isNaN(d.getTime()) ? month : d.toLocaleDateString("en-IN", { month: "short", year: "numeric" })
}

export const MISSING_WORDS: Record<MissingKey, string> = {
  photo: "No photo",
  scopus: "No Scopus ID",
  department: "No department",
  designation: "No designation",
}

export const count = (n: number | null | undefined) => (n == null ? "—" : n.toLocaleString("en-IN"))
