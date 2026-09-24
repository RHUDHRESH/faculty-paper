/**
 * The one way this app talks to the server.
 *
 * Same-origin on purpose: the session is a cookie, and a cross-site cookie is
 * a cookie that does not arrive. In development Vite proxies /api to Django;
 * in production Vercel rewrites it to Cloud Run. Neither the app nor any page
 * ever knows a hostname.
 */

export class ApiError extends Error {
  readonly status: number
  readonly body?: unknown

  constructor(status: number, message: string, body?: unknown) {
    super(message)
    this.status = status
    this.body = body
  }
}

let csrf: string | null = null

async function token(): Promise<string> {
  if (csrf) return csrf
  const res = await fetch("/api/auth/csrf", { credentials: "same-origin" })
  csrf = ((await res.json()) as { csrfToken: string }).csrfToken
  return csrf
}

/** Django rotates it on login and logout, so both must forget the old one. */
export function forgetCsrf() {
  csrf = null
}

type Options = Omit<RequestInit, "body"> & { json?: unknown }

export async function api<T = unknown>(path: string, options: Options = {}): Promise<T> {
  const { json, ...init } = options
  const method = (init.method || "GET").toUpperCase()
  const headers = new Headers(init.headers)

  if (method !== "GET" && method !== "HEAD") {
    headers.set("X-CSRFToken", await token())
    if (json !== undefined) headers.set("Content-Type", "application/json")
  }

  const res = await fetch(path, {
    ...init,
    method,
    headers,
    credentials: "same-origin",
    body: json !== undefined ? JSON.stringify(json) : (init as RequestInit).body,
  })

  if (res.status === 401 && !path.startsWith("/api/auth/")) {
    // Said once, loudly, rather than by every screen rendering its own empty
    // state and letting the reader conclude they have no publications.
    window.dispatchEvent(new CustomEvent("auth:expired"))
  }

  const text = await res.text()
  const body = text ? safeJson(text) : null

  if (!res.ok) {
    const detail =
      body && typeof body === "object" && "detail" in body
        ? String((body as { detail: unknown }).detail)
        : `Request failed (${res.status})`
    throw new ApiError(res.status, detail, body)
  }
  return body as T
}

/**
 * A GET that `index.html` already started, if it did.
 *
 * The first two questions every visit asks -- who is signed in, and which
 * college this is -- used to leave only after the whole of the app's
 * JavaScript had arrived and run: half a second of network each, queued
 * behind a second of download. `index.html` asks them as the page starts,
 * and the first caller for each path here gets that answer instead of asking
 * again. Once only: a response body can be read once, and later callers want
 * a fresh answer anyway.
 */
export function bootAnswer<T>(path: string): Promise<T> | null {
  const boot = (window as unknown as { __boot?: Record<string, Promise<Response> | undefined> })
    .__boot
  const started = boot?.[path]
  if (!started) return null
  delete boot[path]
  return started.then(async (res) => {
    const text = await res.text()
    const body = text ? safeJson(text) : null
    if (!res.ok) {
      const detail =
        body && typeof body === "object" && "detail" in body
          ? String((body as { detail: unknown }).detail)
          : `Request failed (${res.status})`
      throw new ApiError(res.status, detail, body)
    }
    return body as T
  })
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}
