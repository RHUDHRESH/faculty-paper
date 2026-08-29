import { useQuery } from "@tanstack/react-query"

import { api } from "@/lib/api"

export type Institution = {
  college_name: string
  sign_in_note: string
  support_email: string
}

const EMPTY: Institution = {
  college_name: "",
  sign_in_note: "",
  support_email: "",
}

/**
 * The college this instance belongs to, as the server states it.
 *
 * Every surface that used to say "Saveetha Engineering College" out loud --
 * the sign-in panel, the sidebar mark, the policy sentences in the filing
 * wizard -- reads its name from here, so the same build can belong to a
 * different college after one setup form. The query never refetches: a
 * college renames itself about once a decade, and the settings screen bumps
 * the key when it does.
 */
export function useInstitution(): Institution {
  const q = useQuery({
    queryKey: ["institution"],
    queryFn: () => api<Institution>("/api/institution"),
    staleTime: Infinity,
    retry: 1,
  })
  return q.data ?? EMPTY
}

/** Just the college's name, with an honest placeholder while it loads. */
export function useCollegeName(): string {
  return useInstitution().college_name || "the college"
}

export function useInstitutionRequired(): Institution {
  const q = useQuery({
    queryKey: ["institution"],
    queryFn: () => api<Institution>("/api/institution"),
    staleTime: Infinity,
  })
  return q.data ?? EMPTY
}
