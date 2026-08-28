/**
 * Talking to Django from a test, without a password anywhere.
 *
 * Every screen in this application is behind a session cookie, so a browser
 * test that cannot sign in can test nothing. The three obvious ways to sign
 * one in all end the same way — a real, working credential for this
 * application written down somewhere read by more people than the account is
 * meant for: in a spec file, in CI configuration, or typed into the password
 * field by a robot that had to be told it.
 *
 * So none of them is used. `backend/core/management/commands/e2e_session.py`
 * creates a throwaway account whose password is *unusable* — no string signs
 * it in — and writes a `django.contrib.sessions` row for it by hand. It
 * prints the session key. This module runs that command and turns the key
 * into a Playwright `storageState`. Nothing here has ever seen a password,
 * because there is no password to see.
 *
 * The command refuses to run unless `DJANGO_DEBUG` is on, with no override
 * flag, so none of this is reachable against a live system.
 */
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const HERE = path.dirname(fileURLToPath(import.meta.url))
/** frontend2/e2e/fixtures -> frontend2/e2e -> frontend2 -> the repository. */
export const REPO_ROOT = path.resolve(HERE, "..", "..", "..")
export const BACKEND_DIR = path.join(REPO_ROOT, "backend")
/** Where the generated storageState files land. Git-ignored by `.gitignore`
 *  in the same directory, because a session key is still a session key. */
export const AUTH_DIR = path.join(HERE, "..", ".auth")

export const ROLES = [
  "FACULTY",
  "RESEARCH_CELL",
  "PRINCIPAL",
  "FINANCE",
  "HOD",
  "DIRECTOR",
] as const

export type E2ERole = (typeof ROLES)[number]

/** Human wording for a role, as the account menu writes it. */
export const ROLE_LABEL: Record<E2ERole, string> = {
  FACULTY: "Faculty",
  RESEARCH_CELL: "Research cell",
  PRINCIPAL: "Principal",
  FINANCE: "Finance",
  HOD: "Head of department",
  DIRECTOR: "Director",
}

/**
 * The interpreter that can import Django.
 *
 * The repository keeps a virtualenv at `.venv`; CI may not, so `E2E_PYTHON`
 * overrides and a bare `python` is the last resort. Guessing silently and
 * failing later with "No module named django" is a slow way to find out, so
 * this says which one it picked when it has to fall back.
 */
export function pythonExecutable(): string {
  if (process.env.E2E_PYTHON) return process.env.E2E_PYTHON
  const candidates =
    process.platform === "win32"
      ? [path.join(REPO_ROOT, ".venv", "Scripts", "python.exe")]
      : [path.join(REPO_ROOT, ".venv", "bin", "python3"), path.join(REPO_ROOT, ".venv", "bin", "python")]
  for (const c of candidates) if (existsSync(c)) return c
  return process.platform === "win32" ? "python" : "python3"
}

/** Run `manage.py e2e_session ...` and hand back whatever it printed. */
function manage(args: string[]): string {
  try {
    return execFileSync(pythonExecutable(), ["manage.py", "e2e_session", ...args], {
      cwd: BACKEND_DIR,
      encoding: "utf8",
      // Long enough for a cold Django import on Windows, short enough that a
      // hung command is reported rather than hanging the whole run.
      timeout: 120_000,
      env: { ...process.env, PYTHONIOENCODING: "utf-8" },
    })
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string }
    throw new Error(
      `manage.py e2e_session ${args.join(" ")} failed.\n` +
        `Interpreter: ${pythonExecutable()}\n` +
        `Working directory: ${BACKEND_DIR}\n` +
        `${e.stderr || e.stdout || e.message || err}`
    )
  }
}

/** The command prints one JSON object on the last line; Django may write
 *  warnings above it, so the last non-empty line is the one to parse. */
function lastJsonLine<T>(out: string): T {
  const lines = out.split(/\r?\n/).filter((l) => l.trim())
  const last = lines[lines.length - 1] ?? ""
  try {
    return JSON.parse(last) as T
  } catch {
    throw new Error(`e2e_session did not print JSON. Full output:\n${out}`)
  }
}

export type SessionInfo = {
  session_key: string
  cookie_name: string
  email: string
  user_id: string
  name: string
  role: string
  department: string | null
  claim?: {
    id: string
    ticket_number: string
    title: string
    remuneration: number
    owner_email: string
  }
}

/** A fresh signed-in session for one role. */
export function openSession(role: string, extra: string[] = []): SessionInfo {
  return lastJsonLine<SessionInfo>(manage(["--role", role, "--json", ...extra]))
}

/** Seed a SUBMITTED ticket for the faculty fixture and return it with the
 *  session that owns it. Used only by the payment-chain spec. */
export function seedClaim(): SessionInfo {
  const info = openSession("FACULTY", ["--claim"])
  if (!info.claim) throw new Error("e2e_session --claim printed no claim")
  return info
}

/** Remove every fixture account, ticket and session this suite created. */
export function cleanupFixtures(): void {
  manage(["--cleanup"])
}

/**
 * A session key, written where Playwright's `storageState` can find it.
 *
 * The cookie is scoped to `localhost` with no port, which is how cookies
 * work: the same jar serves the Vite dev server on 5174 and Django on 8000,
 * which is the whole reason the app proxies `/api` rather than talking
 * cross-origin.
 */
export function writeStorageState(role: string, session: SessionInfo): string {
  mkdirSync(AUTH_DIR, { recursive: true })
  const file = path.join(AUTH_DIR, `${role}.json`)
  const state = {
    cookies: [
      {
        name: session.cookie_name,
        value: session.session_key,
        domain: "localhost",
        path: "/",
        // A year out. A test run that outlives this has other problems.
        expires: Math.floor(Date.now() / 1000) + 365 * 24 * 60 * 60,
        httpOnly: true,
        secure: false,
        sameSite: "Lax" as const,
      },
    ],
    origins: [],
  }
  writeFileSync(file, JSON.stringify(state, null, 2))
  return file
}

/** The path a spec passes to `test.use({ storageState })`. Written by the
 *  global setup before any spec runs. */
export function storageStatePath(role: string): string {
  return path.join(AUTH_DIR, `${role}.json`)
}
