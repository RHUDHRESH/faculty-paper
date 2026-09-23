import type { Role } from "@/app/auth"

/**
 * How the parts of an account that are codes on the server read on screen.
 *
 * The profile page and the request queue both show a role or a faculty type
 * that somebody asked to change. Raw, that is "RESEARCH_COORDINATOR →
 * FACULTY" in a sentence meant for the person it happened to — and each
 * screen spelling the labels out for itself is how the shell came to call a
 * role one thing and the queue another.
 */

//: The same wording the people screen uses, so an account reads the same
//: name for its own role as the office reads for it.
export const ROLE_LABEL: Record<Role, string> = {
  FACULTY: "Faculty",
  HOD: "Head of department",
  PRINCIPAL: "Principal",
  DIRECTOR: "Director",
  FINANCE: "Finance",
  RESEARCH_CELL: "Research cell",
  RESEARCH_COORDINATOR: "Research coordinator",
  SUPER_ADMIN: "Super admin",
}

/** Mirrors `ASSIGNABLE_ROLES` in backend/core/api/admin.py. A role offered
 *  that the server will not assign is a request that can never be approved. */
export const ASSIGNABLE_ROLES: Role[] = [
  "FACULTY",
  "HOD",
  "PRINCIPAL",
  "DIRECTOR",
  "RESEARCH_CELL",
  "RESEARCH_COORDINATOR",
  "FINANCE",
  "SUPER_ADMIN",
]

export const FACULTY_TYPE_LABEL: Record<string, string> = {
  REGULAR: "Regular faculty",
  RESEARCH: "Research faculty",
}

export function roleLabel(role: string): string {
  return ROLE_LABEL[role as Role] ?? role.replace(/_/g, " ").toLowerCase()
}

export function quotaLabel(quota: number): string {
  return `${quota} ${quota === 1 ? "paper" : "papers"} a year`
}

/** A value of a profile field as a person reads it. Empty stays empty, so
 *  each screen can say "not set" in its own sentence. */
export function requestValueLabel(field: string, value: string): string {
  if (!value) return ""
  if (field === "role") return roleLabel(value)
  if (field === "faculty_type") return FACULTY_TYPE_LABEL[value] ?? value
  if (field === "research_quota" && /^\d+$/.test(value)) return quotaLabel(Number(value))
  return value
}
