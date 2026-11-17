/**
 * What `GET /api/teams` and `GET /api/teams/{code}` send (backend
 * core/services/student_teams.py). The server decides what the reader may see,
 * so a head of department's payload has no `amount` and a faculty member's
 * holds only the teams they mentor.
 */

export type TeamMentor = {
  /** Null for a mentor on the roster who has no account here yet. */
  id: string | null
  name: string | null
  staff_id: string | null
  initials?: string
  photo_url?: string | null
}

export type TeamClaim = {
  id: string
  ticket_number: string | null
  /** The workflow status, or for a head of department the translated one. Never shown as is. */
  status: string
  /** Where the claim stands, in words this reader may be told. */
  stage: string
  /** Where the reader opens it: the review desk, or the paper. */
  url: string
  /** Only for a reader who may see money. */
  amount?: number | null
}

export type TeamRow = {
  id: string
  code: string
  academic_year: string | null
  department: string | null
  mentor: TeamMentor | null
  students: { reg_no: string | null; name: string }[]
  student_count: number
  project_title: string | null
  publications_count: number
  claim: TeamClaim | null
  /** The reader mentors this team. */
  mine: boolean
}

export type TeamsPayload = {
  results: TeamRow[]
  total: number
  limit: number
  offset: number
  counts: { teams: number; students: number; with_publication: number; claimed: number }
  years: string[]
  departments: string[]
  scope: "college" | "department" | "mine"
  money: boolean
}

export type TeamArticle = {
  article_title?: string | null
  source_title?: string | null
  document_type?: string | null
  issn?: string | null
  publication_date?: string | null
  scopus_eid?: string | null
  doi?: string | null
  scopus_link?: string | null
  article_link?: string | null
}

export type TeamClaimHistory = TeamClaim & {
  holds_team: boolean
  owner_name: string | null
  submitted_at: string | null
  paper_title: string | null
}

export type TeamDetail = Omit<TeamRow, "students"> & {
  students: { reg_no: string | null; name: string; programme: string | null; year_of_study: string | null }[]
  publications: TeamArticle[]
  claims: TeamClaimHistory[]
  /** The reader is the mentor and nothing holds the team. */
  can_file: boolean
  /** Why they cannot, in a sentence, when they cannot. */
  cannot_file_because: string | null
}

/** The status filter's choices, in the words a reader uses. */
export const STATUS_OPTIONS: { value: string; label: string }[] = [
  { value: "", label: "Any status" },
  { value: "claimed", label: "Claimed" },
  { value: "unclaimed", label: "Not claimed" },
  { value: "with_publication", label: "Has a paper" },
  { value: "no_publication", label: "No paper yet" },
  { value: "with_publication,unclaimed", label: "Has a paper, not claimed" },
]

/** "4 students", "1 student". */
export function studentsWord(n: number): string {
  return `${n} ${n === 1 ? "student" : "students"}`
}

/** "2 papers", "1 paper". */
export function papersWord(n: number): string {
  return `${n} ${n === 1 ? "paper" : "papers"}`
}

/** The page where a mentor files the claim for this team: File a paper, with the reason and the team chosen. */
export function fileClaimPath(code: string): string {
  return `/papers/new?reason=STUDENT_PROJECT&team=${encodeURIComponent(code)}`
}

