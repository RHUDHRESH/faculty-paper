/**
 * What "this page rendered" actually means, in one place.
 *
 * A route test that only checks the URL changed passes on a blank screen. The
 * three things worth asserting are the three ways a page in this app fails:
 *
 *  1. React threw and unmounted. There is no error boundary in `main.tsx`, so
 *     a throw during render leaves `#root` empty and the window silent except
 *     for a `pageerror`. Both are caught here.
 *  2. A request failed and the page drew `ErrorState` — "Could not load …".
 *     That component carries `role="alert"`, which is a far better signal
 *     than matching its prose, so both are checked: the role for the general
 *     case, the wording because the brief names it.
 *  3. Something logged to `console.error`. Usually React complaining about a
 *     key, a controlled input, or a hook — none of which are visible, all of
 *     which are real.
 */
import { expect, test, type ConsoleMessage, type Page } from "@playwright/test"

/**
 * Console noise that is not this application's fault and not a defect.
 *
 * Kept deliberately short. Every entry is a licence for a real error to slip
 * through, so a new one needs a reason written next to it.
 */
const IGNORED_CONSOLE = [
  // The dev server has no favicon route; the browser asks anyway on every
  // first navigation and logs the 404 as an error.
  /favicon/i,
  // Vite's own websocket, when the dev server restarts mid-run.
  /\[vite\] (server connection lost|connecting)/i,
  // React DevTools nag, which is an error-level message in some builds.
  /Download the React DevTools/i,
]

export type PageErrors = {
  /** `console.error` lines, minus the ignorable ones. */
  console: string[]
  /** Uncaught exceptions and unhandled rejections. */
  uncaught: string[]
}

/**
 * Start listening. Call once per page, before the first navigation.
 *
 * Returns the live arrays rather than a promise, so a spec can navigate,
 * assert, navigate again, and read everything collected across the lot.
 */
export function watchForErrors(page: Page): PageErrors {
  const errors: PageErrors = { console: [], uncaught: [] }

  page.on("console", (msg: ConsoleMessage) => {
    if (msg.type() !== "error") return
    const text = msg.text()
    if (IGNORED_CONSOLE.some((re) => re.test(text))) return
    const where = msg.location()
    errors.console.push(`${text}${where.url ? `  (${where.url}:${where.lineNumber})` : ""}`)
  })

  page.on("pageerror", (err) => {
    errors.uncaught.push(`${err.name}: ${err.message}`)
  })

  return errors
}

/**
 * Navigate, and do not report the browser's own race as a broken page.
 *
 * `page.goto` occasionally rejects with `net::ERR_ABORTED` when a navigation
 * is cancelled out from under it — the previous screen's in-flight requests
 * being torn down, or Vite's dev client reconnecting. It is a statement about
 * the browser, not about the route, and a sweep of twenty-three pages hits it
 * often enough on a loaded machine to matter. One retry; anything else, and
 * any second abort, is raised as it stands.
 */
export async function gotoRoute(page: Page, route: string): Promise<void> {
  try {
    await page.goto(route)
  } catch (err) {
    if (!String(err).includes("ERR_ABORTED")) throw err
    await page.goto(route)
  }
}

/**
 * Navigate, settle, and make sure the app came back *signed in*.
 *
 * `AuthProvider` turns any failed `/api/auth/me` into "no session" and never
 * asks again, so a single dropped request — Django's single-threaded dev
 * server refusing a connection under load, which shows up as a 502 through
 * the Vite proxy — strands the whole page on the sign-in form for the rest of
 * the test. Every assertion after that then fails describing the sign-in
 * screen, which sends you looking in the wrong place entirely.
 *
 * One reload fixes it, because the session cookie was never the problem. If
 * it does not, this says what the server actually thinks of the session
 * rather than letting the next assertion report "button not found".
 */
export async function gotoAsUser(page: Page, route: string): Promise<void> {
  const signedOut = () => page.getByRole("button", { name: "Sign in" }).count()

  await gotoRoute(page, route)
  await waitForSettled(page)
  if ((await signedOut()) > 0) {
    await gotoRoute(page, route)
    await waitForSettled(page)
  }
  if ((await signedOut()) > 0) {
    const probe = await page.request.get("/api/auth/me")
    const cookie = (await page.context().cookies()).find((c) => c.name === "sessionid")
    throw new Error(
      `${route}: the app is signed out.\n` +
        `  /api/auth/me answered ${probe.status()}\n` +
        `  session cookie: ${cookie ? `${cookie.value} (domain ${cookie.domain})` : "NOT PRESENT"}`
    )
  }
}

/** Nothing is still drawing. The app's loading states are skeletons marked
 *  `aria-hidden`, plus a bare spinner while `/api/auth/me` is in flight. */
export async function waitForSettled(page: Page, errors?: PageErrors): Promise<void> {
  try {
    await page.waitForFunction(
      () => {
        const root = document.getElementById("root")
        if (!root || root.childElementCount === 0) return false
        // The whole-app spinner shown while the session is being resolved.
        if (document.querySelector(".animate-spin")) return false
        return true
      },
      undefined,
      { timeout: 20_000 }
    )
  } catch (err) {
    /**
     * Say what actually happened.
     *
     * A bare `waitForFunction: Timeout 20000ms exceeded` is the least useful
     * true sentence available here, and it is the message you get for the
     * single most important failure this suite detects: React threw during
     * render, `main.tsx` has no error boundary to catch it, the whole tree
     * unmounted, and the user is looking at a blank white page. The
     * exception that caused it was already captured by `watchForErrors` —
     * this puts it in the failure instead of leaving it in a trace nobody
     * opens.
     */
    const rootChildren = await page
      .evaluate(() => document.getElementById("root")?.childElementCount ?? -1)
      .catch(() => -1)
    const thrown = errors?.uncaught.length ? errors.uncaught.join("\n    ") : null
    if (rootChildren === 0) {
      throw new Error(
        `${page.url()} rendered nothing: #root is empty, so React unmounted or never mounted.` +
          (thrown
            ? `\n  The exception that did it:\n    ${thrown}`
            : "\n  No uncaught exception was captured — pass the watchForErrors() result " +
              "to waitForSettled to have it reported here.")
      )
    }
    throw err
  }
  // Skeletons come and go as each query resolves; give the last of them a
  // moment rather than asserting against a half-drawn screen.
  await page
    .waitForFunction(() => document.querySelectorAll(".skeleton").length === 0, undefined, {
      // A screen against a local dev server still showing skeletons after
      // this is waiting on something that is not coming, and every second
      // spent here is spent again on every route, for every role.
      timeout: 10_000,
    })
    .catch(() => {
      // A screen that is legitimately still loading after 15s is a finding
      // for the assertions below, not a reason to abort here.
    })
}

/**
 * The whole check, for one route.
 *
 * `where` is only used in failure messages — a bare "expected 0, got 1" over
 * thirty routes is a message you have to go and reproduce to understand.
 */
export async function expectPageHealthy(
  page: Page,
  errors: PageErrors,
  where: string
): Promise<void> {
  await waitForSettled(page, errors)

  // 1. React is still mounted and drew something.
  //
  // The exception goes in the message, for the same reason `waitForSettled`
  // does it: this check and the console check below are ten lines apart, and
  // the first one to fire ends the test — so a page that mounted, settled,
  // and *then* threw (an effect, a late query resolving into a render that
  // blows up) reported a bare "#root is empty" and left the actual TypeError
  // sitting unread in `errors.uncaught`. That sends you to open a trace to
  // find something the test already had in its hand.
  const rootChildren = await page.evaluate(
    () => document.getElementById("root")?.childElementCount ?? 0
  )
  const thrown = errors.uncaught.length
    ? `\n  The exception that did it:\n    ${errors.uncaught.join("\n    ")}`
    : errors.console.length
      ? `\n  Nothing was thrown, but the console said:\n    ${errors.console.join("\n    ")}`
      : ""
  expect(
    rootChildren,
    `${where}: #root is empty — React unmounted or never rendered${thrown}`
  ).toBeGreaterThan(0)

  // 2. No error state on screen. `role="alert"` is what `ui/state.tsx` gives
  //    both ErrorState and InlineError, so this catches a failed widget in
  //    the corner of an otherwise fine page as well as a failed page.
  const alerts = page.locator('[role="alert"]')
  const alertCount = await alerts.count()
  if (alertCount > 0) {
    const texts = await alerts.allInnerTexts()
    expect(alertCount, `${where}: error state on screen — ${JSON.stringify(texts)}`).toBe(0)
  }

  // 3. The specific wording the brief names, in case a future error state is
  //    built without the role.
  const couldNotLoad = await page.getByText(/Could not load/i).count()
  expect(couldNotLoad, `${where}: a "Could not load" message is on screen`).toBe(0)

  // 4. Nothing in the console.
  expect(errors.uncaught, `${where}: uncaught error(s)`).toEqual([])
  expect(errors.console, `${where}: console error(s)`).toEqual([])

  // Reset so the next route in a loop is judged on its own.
  errors.console.length = 0
  errors.uncaught.length = 0
}

/**
 * Every destination this account's sidebar offers, read from the sidebar
 * itself rather than from a list kept beside it.
 *
 * `nav.ts` already declares who each page is for; copying that list into the
 * test suite would create a second copy to drift, and a route added to the
 * sidebar next month would go untested in exactly the way this spec exists to
 * prevent. Reading the rendered `<nav aria-label="Main">` means the test
 * covers whatever the sidebar actually offers today.
 */
export async function sidebarRoutes(page: Page): Promise<string[]> {
  // `gotoAsUser` owns the retry-and-explain for a dropped session, so this
  // does not carry a second copy of it.
  const read = async (): Promise<string[]> => {
    await gotoAsUser(page, "/")
    return page.evaluate(() => {
      // On a phone the sidebar is `display:none` rather than unmounted, so
      // its links are still here to be read. The drawer's copy only exists
      // while the drawer is open.
      const nav = document.querySelector('nav[aria-label="Main"]')
      if (!nav) return [] as string[]
      return Array.from(nav.querySelectorAll("a[href]")).map((a) => a.getAttribute("href") || "")
    })
  }

  const hrefs = await read()
  if (hrefs.length === 0) {
    // Signed in (gotoAsUser proved that) and still no sidebar, which is a
    // different fault altogether: the shell rendered without its navigation.
    throw new Error(
      `The shell drew no <nav aria-label="Main"> for this account, though the ` +
        `session is valid. url: ${page.url()}`
    )
  }

  const unique = Array.from(new Set(hrefs.filter((h) => h.startsWith("/"))))
  // "/" is the index route; every account has one and it is the screen they
  // land on, so it is tested whether or not it is drawn as a nav link.
  // "/me" is reachable from the account menu, not the sidebar.
  for (const always of ["/", "/me"]) {
    if (!unique.includes(always)) unique.push(always)
  }

  /**
   * Give the caller a budget that matches the work it just found.
   *
   * A sweep over a role's sidebar is one test doing between nine and
   * twenty-three page loads, and a fixed per-test timeout is therefore a
   * timeout that is generous for a claimant and tight for the research
   * cell. It was: the research cell's twenty-three routes ran in seventeen
   * seconds on a quiet machine and blew a ninety-second budget on a busy
   * one, failing on `/reference` — a page that had rendered perfectly and
   * simply arrived after the clock ran out. That is a test reporting the
   * machine's load as a defect, which is how a suite loses its audience.
   *
   * Twenty-five seconds a route is enormously more than any of them needs —
   * the whole sweep runs at about 1.5s a route on an idle machine — and it
   * still fails in reasonable time if one genuinely hangs. The number is set
   * for the worst machine this has been watched on, not the best, because
   * the failure mode of setting it for the best is a red suite that nobody
   * believes.
   */
  test.setTimeout(Math.max(150_000, unique.length * 25_000))

  return unique
}
