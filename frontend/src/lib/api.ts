/** Same-origin in production: vercel.json rewrites /api and /media to Cloud
 *  Run, so cookies stay first-party and there is no CORS to configure.
 *  A BOM or trailing slash in VITE_API_BASE used to turn that into a relative
 *  junk URL, so the SPA posted login at the static host and got HTML back. */
function readApiBase(): string {
  const raw = String(import.meta.env.VITE_API_BASE ?? "")
    .replace(/^\uFEFF/, "")
    .trim()
    .replace(/\/+$/, "");
  if (!raw || raw.toLowerCase() === "undefined") {
    return "";
  }
  return raw;
}

export const API_BASE = readApiBase();

/**
 * Absolute URL for an uploaded file.
 *
 * Attachments are stored as the server-relative "/media/claims/<id>.pdf". In
 * production the SPA and the API are on different origins, so rendering that
 * path raw pointed the link at the static host — every attachment opened the
 * SPA shell instead of the document.
 */
export function mediaUrl(url?: string | null): string {
  if (!url) return "";
  if (/^https?:\/\//i.test(url)) return url;
  return `${API_BASE}${url.startsWith("/") ? "" : "/"}${url}`;
}

const HTML_AS_JSON =
  "Cannot reach the API (got a web page instead of data). Try again in a moment.";

const DEFAULT_TIMEOUT_MS = 25_000;
export const SLOW_TIMEOUT_MS = 90_000;

function isAbortError(e: unknown): boolean {
  return (
    (typeof DOMException !== "undefined" && e instanceof DOMException && e.name === "AbortError") ||
    (e instanceof Error && e.name === "AbortError")
  );
}

/** fetch() with a timeout. Without this a sleeping Render instance left the
 *  SPA on a spinner until the proxy gave up — two to three minutes. */
export async function apiFetch(
  path: string,
  init: RequestInit & { timeoutMs?: number } = {}
): Promise<Response> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, signal, ...rest } = init;
  const ctrl = new AbortController();
  const timer = window.setTimeout(() => ctrl.abort(), timeoutMs);
  const onOuterAbort = () => ctrl.abort();
  signal?.addEventListener("abort", onOuterAbort);
  try {
    return await fetch(`${API_BASE}${path}`, {
      ...rest,
      credentials: rest.credentials ?? "include",
      signal: ctrl.signal,
    });
  } catch (e) {
    if (isAbortError(e)) {
      throw new Error(
        "The server did not respond in time. It may be waking up — wait a few seconds and try again."
      );
    }
    throw e;
  } finally {
    window.clearTimeout(timer);
    signal?.removeEventListener("abort", onOuterAbort);
  }
}

/** Parse a JSON response. HTML (SPA fallback, Render wake page) must never
 * surface as `Unexpected token '<'`. */
export async function readJson<T = unknown>(res: Response): Promise<T> {
  const ct = res.headers.get("content-type") || "";
  const text = await res.text();
  if (!ct.includes("application/json") || text.trimStart().startsWith("<")) {
    throw new Error(HTML_AS_JSON);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(HTML_AS_JSON);
  }
}

export async function ensureCsrf(): Promise<string> {
  const fromCookie = document.cookie
    .split("; ")
    .find((row) => row.startsWith("csrftoken="))
    ?.slice("csrftoken=".length);
  if (fromCookie) return decodeURIComponent(fromCookie);
  const res = await apiFetch("/api/auth/csrf");
  const data = await readJson<{ csrfToken?: string }>(res);
  return data.csrfToken as string;
}

export async function api<T = unknown>(
  path: string,
  opts: RequestInit & { json?: unknown; timeoutMs?: number } = {}
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
  const { json, timeoutMs, ...rest } = opts;
  const res = await apiFetch(path, {
    ...rest,
    headers,
    timeoutMs,
    body: json !== undefined ? JSON.stringify(json) : opts.body,
  });
  if (!res.ok) {
    // An expired session used to surface as a cryptic red toast on whatever
    // button was pressed; the auth provider listens for this and routes to
    // /login instead. /me and /login are exempt to avoid loops.
    if (
      res.status === 401 &&
      path !== "/api/auth/me" &&
      path !== "/api/auth/login"
    ) {
      window.dispatchEvent(new CustomEvent("auth:unauthorized"));
    }
    let msg = res.statusText;
    try {
      const err = await readJson<{ detail?: unknown }>(res);
      msg = (typeof err.detail === "string" ? err.detail : JSON.stringify(err)) || msg;
    } catch (e) {
      if (e instanceof Error && e.message === HTML_AS_JSON) msg = e.message;
    }
    throw new Error(typeof msg === "string" ? msg : "Request failed");
  }
  if (res.status === 204) return undefined as T;
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) return readJson<T>(res);
  const text = await res.text();
  if (text.trimStart().startsWith("<")) throw new Error(HTML_AS_JSON);
  return text as T;
}

/** Shape of the paginated list endpoints (/api/claims, /api/admin/payouts). */
export type Paginated<T> = {
  total: number;
  limit: number;
  offset: number;
  /** Sum across everything the filter matches, not just this page. Only the
   *  ledger reports it today. */
  total_amount?: number;
  results: T[];
};

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
  /** Present only while a super admin is viewing as this user. */
  impersonated_by?: { id: string; name?: string; email?: string } | null;
  /** True in an impersonated session: the server refuses every write. */
  read_only?: boolean;
};

export type ClaimAttachment = {
  id: string;
  kind: "PUBLISHED_PAPER" | "SEC_REFERENCE";
  url: string;
  filename?: string | null;
  size_bytes?: number;
  /** SEC_REFERENCE only: which citation this file proves. */
  ref_number?: string | null;
  ref_title?: string | null;
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
  snip_source?: "SCOPUS" | "SNIP_DUMP" | "MANUAL" | null;
  self_reported_snip?: number | null;
  quartile?: string | null;
  quartile_source?: "SCIMAGO" | "MANUAL" | null;
  self_reported_quartile?: string | null;
  manual_verified_by_name?: string | null;
  manual_verification_note?: string | null;
  remuneration_is_estimate?: boolean;
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
  au_annexure_ref?: string | null;
  ugc_care_ref?: string | null;
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
  remuneration_category?: string | null;
  remuneration_note?: string | null;
  duplicate_warning?: boolean;
  status_note?: string | null;
  voucher_number?: string | null;
  cleared_by_name?: string | null;
  second_approved_by_name?: string | null;
  second_approved_at?: string | null;
  needs_second_approval?: boolean;
  /** Days at the current step. On the payload since the four-step chain
   *  landed, but no queue displayed it. */
  waiting_days?: number | null;
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
