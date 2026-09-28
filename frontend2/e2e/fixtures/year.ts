/**
 * The cast of the year-long scenario (`manage.py e2e_year`), signed in.
 *
 * Same trick as `backend.ts`: sessions without passwords, DEBUG only. The
 * command also writes the recorded Crossref answer the DOI route needs, to
 * the file the server reads through `E2E_UPSTREAM_FIXTURES`.
 */
import { execFileSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"

import { type Browser, type Page } from "@playwright/test"

import { AUTH_DIR, BACKEND_DIR, pythonExecutable } from "./backend"

export const UPSTREAM_FIXTURES =
  process.env.E2E_UPSTREAM_FIXTURES || path.join(AUTH_DIR, "upstream.json")

export type CastKey = "anand" | "revathi" | "meena" | "hod" | "cell" | "principal" | "director" | "finance" | "admin"

export type Year = {
  people: Record<CastKey, { id: string; name: string; email: string; session: string }>
  cookie_name: string
  papers: Record<string, { title: string; doi: string; journal: string; issn: string }>
  doi_paper: { title: string; doi: string; journal: string }
  watched_journal: string
  team: { code: string; title: string }
  department: string
}

export function manage(args: string[], timeout = 180_000): string {
  return execFileSync(pythonExecutable(), ["manage.py", ...args], {
    cwd: BACKEND_DIR,
    encoding: "utf8",
    timeout,
    env: { ...process.env, PYTHONIOENCODING: "utf-8", DJANGO_DEBUG: "true" },
  })
}

export function seedYear(): Year {
  mkdirSync(AUTH_DIR, { recursive: true })
  const out = manage(["e2e_year", "--reset", "--fixtures", UPSTREAM_FIXTURES])
  const lines = out.split(/\r?\n/).filter((l) => l.trim())
  const year = JSON.parse(lines[lines.length - 1]) as Year
  for (const [key, who] of Object.entries(year.people)) {
    writeFileSync(
      path.join(AUTH_DIR, `year-${key}.json`),
      JSON.stringify({
        cookies: [
          {
            name: year.cookie_name,
            value: who.session,
            domain: "localhost",
            path: "/",
            expires: Math.floor(Date.now() / 1000) + 86_400,
            httpOnly: true,
            secure: false,
            sameSite: "Lax",
          },
        ],
        origins: [],
      })
    )
  }
  return year
}

export async function as(browser: Browser, who: CastKey, viewport = { width: 1280, height: 900 }): Promise<Page> {
  const context = await browser.newContext({
    storageState: path.join(AUTH_DIR, `year-${who}.json`),
    viewport,
    acceptDownloads: true,
  })
  return context.newPage()
}

export async function close(page: Page): Promise<void> {
  const context = page.context()
  await page.close()
  await context.close()
}
