import path from "node:path"
import { fileURLToPath } from "node:url"

import { defineConfig, devices } from "@playwright/test"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(HERE, "..")
const BACKEND_DIR = path.join(REPO_ROOT, "backend")

/**
 * The interpreter that can import Django. Mirrors `e2e/fixtures/backend.ts`
 * — the config cannot import that module, because Playwright evaluates this
 * file before the TypeScript path setup the specs get.
 */
const PYTHON =
  process.env.E2E_PYTHON ||
  (process.platform === "win32"
    ? path.join(REPO_ROOT, ".venv", "Scripts", "python.exe")
    : path.join(REPO_ROOT, ".venv", "bin", "python"))

/** `localhost`, not `127.0.0.1`: Vite binds the loopback name, which on
 *  Windows resolves to ::1 and nothing is listening on 127.0.0.1. It is also
 *  the origin in Django's `CSRF_TRUSTED_ORIGINS`, so a mutating request from
 *  any other spelling is refused with a bare "CSRF check Failed". */
const FRONTEND = process.env.E2E_BASE_URL || "http://localhost:5174"
const BACKEND = process.env.E2E_API_URL || "http://localhost:8000"

export default defineConfig({
  testDir: "./e2e",
  /**
   * Generous, because every spec here drives a real database through a real
   * workflow and several steps re-verify against Scopus, which is a network
   * round trip. The sweeps raise this further for themselves, in proportion
   * to how many routes they found — see `sidebarRoutes`.
   *
   * 90s was the first guess and it was wrong: the same suite that runs in
   * 2.6 minutes on a quiet machine takes 6 on a busy one, and a fixed budget
   * turns that difference into a test failure. A timeout should catch a hang,
   * not a slow afternoon.
   */
  timeout: 150_000,
  // Same reasoning as the timeout above: an assertion that waits on a page
  // render has to survive a machine under load, and 15s did not.
  expect: { timeout: 25_000 },

  /**
   * Serial, deliberately.
   *
   * The suite shares one Django instance and one database, and the payment
   * chain moves a single ticket through five desks in order. Running the
   * specs in parallel would have the clearing queue changing underneath the
   * spec that is asserting what is in it. This is not a suite where wall
   * clock is the thing worth optimising.
   */
  fullyParallel: false,
  workers: 1,

  // A test that only passes on the second attempt is a test that is telling
  // you something. Locally it says so immediately; on CI one retry absorbs a
  // genuinely flaky network hop to Scopus without hiding a real failure,
  // because the retry is reported.
  retries: process.env.CI ? 1 : 0,
  forbidOnly: !!process.env.CI,

  reporter: process.env.CI
    ? [["list"], ["html", { open: "never", outputFolder: "./e2e/.artifacts/report" }]]
    : [["list"]],

  /**
   * Traces, screenshots and the HTML report land inside `e2e/`, which has its
   * own `.gitignore`. Playwright's defaults are `frontend2/test-results` and
   * `frontend2/playwright-report`, and neither is ignored here — the root
   * `.gitignore` anchors both to the repository root, so a failed run would
   * leave a few megabytes of untracked zip files in `git status`.
   */
  outputDir: "./e2e/.artifacts/results",

  globalSetup: "./e2e/global-setup.ts",

  use: {
    baseURL: FRONTEND,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
    // The app is same-origin against the dev proxy; a stray navigation to
    // the API port would leave the session behind.
    ignoreHTTPSErrors: false,
  },

  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 900 } },
    },
  ],

  /**
   * CI starts both servers; a developer with them already running keeps them.
   *
   * `reuseExistingServer` is on outside CI for exactly that: this repository
   * is normally worked on with `npm run dev` and `manage.py runserver`
   * already up, and a test run that killed and restarted both would be
   * slower and would drop whatever state the developer was looking at.
   */
  webServer: [
    {
      command: "npm run dev",
      cwd: HERE,
      url: FRONTEND,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      stdout: "ignore",
      // Vite is quiet unless something is wrong, so its stderr is worth
      // having: a failed transform or a missing dependency shows up here and
      // nowhere else.
      stderr: "pipe",
    },
    {
      // `--noreload` because the autoreloader forks, and Playwright then
      // holds the parent while the child keeps the port.
      command: `"${PYTHON}" manage.py runserver 8000 --noreload`,
      cwd: BACKEND_DIR,
      url: `${BACKEND}/api/auth/csrf`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      stdout: "ignore",
      // `runserver` logs every request to stderr, and this suite makes a few
      // thousand of them — piped, they bury the test results in the one place
      // anybody reads them. Silenced by default; set E2E_SERVER_LOGS=1 to get
      // them back, which is what you want on the one occasion they matter,
      // when the server will not start and the URL check above times out.
      stderr: process.env.E2E_SERVER_LOGS ? "pipe" : "ignore",
      env: {
        // The command that opens sessions without a password refuses to run
        // unless this is on, and there is no override. Stating it here means
        // a CI job cannot accidentally point the suite at a hardened
        // configuration and get a confusing failure three specs later.
        DJANGO_DEBUG: "true",
      },
    },
  ],
})
