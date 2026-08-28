/**
 * Every route every role can reach, opened once, and checked for the three
 * ways a screen in this app fails silently.
 *
 * This is the cheapest test in the suite and the one that finds the most.
 * Nine screens were added recently and nothing proved any of them rendered:
 * a route can be wired into `nav.ts`, appear in the sidebar, and throw on
 * arrival, and the only person who finds out is whoever clicks it. There is
 * no error boundary in `main.tsx`, so a throw during render blanks the page
 * rather than showing anything.
 *
 * The route list is read from the rendered sidebar rather than kept here.
 * `nav.ts` already declares who each page is for; a second copy in the test
 * suite would drift, and the route added next month would go untested in
 * exactly the way this spec exists to prevent.
 */
import { expect, test } from "@playwright/test"

import { ROLES, ROLE_LABEL, storageStatePath, type E2ERole } from "./fixtures/backend"
import {
  expectPageHealthy,
  gotoRoute,
  sidebarRoutes,
  waitForSettled,
  watchForErrors,
} from "./fixtures/page-health"

for (const role of ROLES) {
  test.describe(`${ROLE_LABEL[role as E2ERole]} — every route renders`, () => {
    test.use({ storageState: storageStatePath(role) })

    test(`${role} sidebar offers pages and every one of them renders`, async ({ page }) => {
      const errors = watchForErrors(page)

      const routes = await sidebarRoutes(page)

      // A sidebar with nothing in it means the session did not take, and
      // every assertion after this would pass vacuously against a sign-in
      // screen. Say so here rather than reporting thirty healthy blanks.
      expect(routes.length, `${role}: the sidebar offered no destinations`).toBeGreaterThan(2)
      test.info().annotations.push({ type: role, description: routes.join(" ") })

      for (const route of routes) {
        await gotoRoute(page, route)
        await expectPageHealthy(page, errors, `${role} ${route}`)

        // A refusal is a real screen with a heading and no error state, so
        // without these two a route that 404s or 403s inside the app reads as
        // perfectly healthy. A page the sidebar itself offered must never
        // land on either.
        //
        // The refusal sentence is written twice in this app, and by two
        // different components: `not-found.tsx` puts it in an <h1> when the
        // router has no such route for this role, and a page that *is*
        // routed but checks the role itself draws it as an `EmptyState`
        // title, which is a <p>. Matching the text covers both.
        await expect(
          page.getByText("No page at this address"),
          `${role} ${route}: the sidebar offers a route the router does not know`
        ).toHaveCount(0)
        await expect(
          page.getByText("Not open to this account"),
          `${role} ${route}: the sidebar offers a route this role is refused`
        ).toHaveCount(0)
      }
    })
  })
}

test.describe("An address that is nothing at all", () => {
  test.use({ storageState: storageStatePath("FACULTY") })

  test("says so, rather than bouncing to the home page", async ({ page }) => {
    const errors = watchForErrors(page)
    await page.goto("/this-is-not-a-page")
    await waitForSettled(page)

    await expect(page.getByRole("heading", { name: "No page at this address" })).toBeVisible()
    // The URL is left alone on purpose — see the note in `not-found.tsx`.
    expect(new URL(page.url()).pathname).toBe("/this-is-not-a-page")
    expect(errors.uncaught).toEqual([])
  })
})

test.describe("A real page belonging to somebody else", () => {
  test.use({ storageState: storageStatePath("FACULTY") })

  test("is refused by name, not by a blank screen", async ({ page }) => {
    watchForErrors(page)
    // `/payments` is Finance's. A faculty account reaching it should be told
    // the page is real and not theirs, which is a different sentence from
    // "no such page" and is answered by asking somebody rather than by
    // going back. The page is routed for everybody and refuses on the role,
    // so the sentence arrives as an `EmptyState` title rather than an <h1>.
    await page.goto("/payments")
    await waitForSettled(page)
    await expect(page.getByText("Not open to this account")).toBeVisible()
    await expect(page.getByText("Only Finance can see or process payments.")).toBeVisible()
  })
})
