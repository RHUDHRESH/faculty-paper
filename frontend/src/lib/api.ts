/** Single source of truth — every fetch in the app must go through this. */
export const API_BASE = import.meta.env.VITE_API_BASE || "";

export async function ensureCsrf(): Promise<string> {
  const res = await fetch(`${API_BASE}/api/auth/csrf`, { credentials: "include" });
  const data = await res.json();
  return data.csrfToken as string;
}

export async function api<T = unknown>(
  path: string,
  opts: RequestInit & { json?: unknown } = {}
): Promise<T> {
  const headers = new Headers(opts.headers || {});
  if (opts.json !== undefined) {
    headers.set("Content-Type", "application/json");
  }
  const method = (opts.method || "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    const csrf = await ensureCsrf();
    if (csrf) headers.set("X-CSRFToken", csrf);
  }
  const res = await fetch(`${API_BASE}${path}`, {
    ...opts,
    headers,
    credentials: "include",
    body: opts.json !== undefined ? JSON.stringify(opts.json) : opts.body,
  });
  if (!res.ok) {
    let msg = res.statusText;
    try {
      const err = await res.json();
      msg = err.detail || JSON.stringify(err);
    } catch {
      /* ignore */
    }
    throw new Error(typeof msg === "string" ? msg : "Request failed");
  }
  if (res.status === 204) return undefined as T;
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) return res.json();
  return (await res.text()) as T;
}

export type User = {
  id: string;
  email: string;
  name: string;
  role: string;
  department?: string | null;
  employee_id?: string | null;
  staff_id?: string | null;
  biometric_id?: string | null;
  designation?: string | null;
  scopus_author_url?: string | null;
  scopus_author_id?: string | null;
  must_change_password?: boolean;
  portal?: "faculty" | "admin" | "finance" | "hod" | "principal";
};

export type ClaimAttachment = {
  id: string;
  kind: "PUBLISHED_PAPER" | "SEC_REFERENCE";
  url: string;
  filename?: string | null;
  size_bytes?: number;
};

export type Claim = {
  id: string;
  owner_id?: string | null;
  status: string;
  ticket_number?: string | null;
  contest_forward?: boolean;
  contest_note?: string | null;
  verification_ok?: boolean;
  verification_snapshot_json?: string | null;
  paper_title?: string | null;
  journal_title?: string | null;
  doi?: string | null;
  issn?: string | null;
  snip?: number | null;
  quartile?: string | null;
  self_reported_quartile?: string | null;
  remuneration?: number | null;
  owner_name?: string;
  owner_email?: string;
  owner_department?: string | null;
  staff_id?: string | null;
  biometric_id?: string | null;
  designation?: string | null;
  scopus_author_url?: string | null;
  publication_date?: string | null;
  publication_type?: string | null;
  indexing_level?: string | null;
  indexing_ref?: string | null;
  yukthi_id?: string | null;
  impact_factor?: string | null;
  proof_url?: string | null;
  sec_refs?: string | null;
  sec_proof_url?: string | null;
  reference_articles?: string | null;
  claim_reason?: "INCENTIVE" | "COUNT_ONLY" | null;
  attachments?: ClaimAttachment[];
  is_student_publication?: boolean;
  affiliation_ok?: boolean;
  subject_category?: string | null;
  total_authors?: number;
  author_position?: number;
  authors_json?: string | null;
  eid?: string | null;
  scopus_url?: string | null;
  cover_date?: string | null;
  aggregation_type?: string | null;
  engineering_class?: string | null;
  publication_year?: number | null;
  indexing_status?: string | null;
  linkage_status?: string | null;
  calc_error?: string | null;
  duplicate_warning?: boolean;
  status_note?: string | null;
  voucher_number?: string | null;
  actions?: Array<{
    id: string;
    action: string;
    note?: string | null;
    actor_name?: string;
    from_status?: string | null;
    to_status?: string | null;
    created_at: string;
  }>;
};

export function parseVerifySnapshot(raw?: string | null): {
  issues?: string[];
  scopus?: Record<string, unknown>;
  scimago?: Record<string, unknown>;
  paid?: Record<string, unknown>;
} | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
