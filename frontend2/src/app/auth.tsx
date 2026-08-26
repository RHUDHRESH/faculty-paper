import { createContext, useCallback, useContext, useEffect, useState } from "react"

import { api, forgetCsrf } from "@/lib/api"

export type Role =
  | "FACULTY"
  | "HOD"
  | "PRINCIPAL"
  | "DIRECTOR"
  | "RESEARCH_COORDINATOR"
  | "FINANCE"
  | "SUPER_ADMIN"
  | "RESEARCH_CELL"

export type Me = {
  id: string
  email: string
  name: string
  role: Role
  department?: string | null
  designation?: string | null
  staff_id?: string | null
  must_change_password?: boolean
}

type Ctx = {
  me: Me | null
  loading: boolean
  refresh: () => Promise<void>
  signIn: (email: string, password: string) => Promise<void>
  /** Exchange a Google ID token for a session. Never creates an account. */
  signInWithGoogle: (credential: string) => Promise<void>
  signOut: () => Promise<void>
}

const AuthContext = createContext<Ctx | null>(null)

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [me, setMe] = useState<Me | null>(null)
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    try {
      setMe(await api<Me>("/api/auth/me"))
    } catch {
      setMe(null)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
    // One place decides what an expired session means, rather than every
    // screen rendering an empty state that reads as "you have nothing".
    const onExpired = () => setMe(null)
    window.addEventListener("auth:expired", onExpired)
    return () => window.removeEventListener("auth:expired", onExpired)
  }, [refresh])

  const signIn = useCallback(
    async (email: string, password: string) => {
      await api("/api/auth/login", { method: "POST", json: { email, password } })
      forgetCsrf() // Django rotates it on login; the old one is already dead.
      await refresh()
    },
    [refresh]
  )

  const signInWithGoogle = useCallback(
    async (credential: string) => {
      // The ID token is all that crosses. It is verified on the server
      // against Google's keys with our own client id as the audience, so a
      // token minted for some other application will not open a session here.
      await api("/api/auth/google", { method: "POST", json: { credential } })
      forgetCsrf() // Django rotates it on login; the old one is already dead.
      await refresh()
    },
    [refresh]
  )

  const signOut = useCallback(async () => {
    try {
      await api("/api/auth/logout", { method: "POST" })
    } finally {
      forgetCsrf()
      setMe(null)
    }
  }, [])

  return (
    <AuthContext.Provider value={{ me, loading, refresh, signIn, signInWithGoogle, signOut }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error("useAuth outside AuthProvider")
  return ctx
}

/** What this account is allowed to see. Asked once, here, so no screen has to
 *  reason about roles inline and get it subtly different from its neighbour. */
export function can(role: Role | undefined) {
  const r = role
  // Mirrors `rbac.ADMIN_ROLES`. The coordinator checks papers beside the
  // admin office rather than after it, so anything the office may do to a
  // filed paper, a coordinator may do.
  const office =
    r === "SUPER_ADMIN" || r === "RESEARCH_CELL" || r === "RESEARCH_COORDINATOR"
  return {
    /** Money is not a head of department's business, anywhere. */
    seeMoney: !!r && r !== "HOD",

    // These four mirror named functions in `backend/core/services/rbac.py`
    // and `api.py`. Where they disagree, the screen hides a control the
    // server would have allowed — which reads as a broken account rather
    // than as a client that is out of date, and is diagnosed slowly.
    //
    // A super admin stands in for the Principal and for Finance. That is
    // deliberate on the server, whose own comment reads "the principal, and
    // a super admin who has to stand in for one" — somebody has to be able
    // to keep payments moving while a post is vacant or a person is away.
    /** `_may_approve_as_principal` */
    approve: r === "PRINCIPAL" || r === "SUPER_ADMIN",
    /**
     * `rbac.can_approve_as_director` — the step between the Principal and
     * Finance. The Principal agrees the spend; the Director authorises it,
     * and Finance pays only what carries that authorisation.
     */
    authorise: r === "DIRECTOR" || r === "SUPER_ADMIN",
    /** `rbac.can_approve_as_finance` */
    pay: r === "FINANCE" || r === "SUPER_ADMIN",
    /** `rbac.can_clear_claims` */
    clear: office,
    /** `rbac.can_manage_users` */
    manageUsers: office,
    /** `rbac.can_view_audit` */
    viewAudit: office || r === "PRINCIPAL" || r === "DIRECTOR" || r === "FINANCE",
    /**
     * `rbac.can_view_reports` — the gate on the ledger, the budget, the
     * duplicate findings and both report endpoints. Note who is *not* here:
     * a head of department, who is refused all of them outright and has
     * `/api/hod/*` instead. A screen that offers a head one of these gets
     * them a 403, which reads as a broken account rather than as a screen
     * that was never theirs.
     */
    viewReports: office || r === "PRINCIPAL" || r === "DIRECTOR" || r === "FINANCE",
    /** `budgets` and `duplicate-findings` writes: ADMIN_ROLES or Finance. */
    manageMoney: office || r === "FINANCE",

    seeCollege: !!r && r !== "FACULTY",
    seeDepartment: r === "HOD",
    admin: r === "SUPER_ADMIN",
  }
}
