/**
 * Leaving.
 *
 * `signOut` existed in `auth.tsx` from the first day and nothing called it.
 * There was no way out of a session short of clearing cookies, which on a
 * shared departmental machine means the next person files a paper as the last
 * one. It is now an item in the account menu, and this is the test that says
 * so — including the part that matters most, which is that the *server*
 * session is gone and not merely the client's memory of it.
 *
 * This spec opens its own session rather than using a shared one, because
 * ending a session other specs are holding is a good way to make an unrelated
 * test fail three files later.
 */
import { expect, test } from "@playwright/test"

import { openSession } from "./fixtures/backend"
import { waitForSettled } from "./fixtures/page-health"

test.describe("Signing out", () => {
  test("the account menu ends the session, on the server as well as here", async ({ browser }) => {
    const session = openSession("FACULTY")
    const context = await browser.newContext()
    await context.addCookies([
      {
        name: session.cookie_name,
        value: session.session_key,
        domain: "localhost",
        path: "/",
      },
    ])
    const page = await context.newPage()

    await page.goto("/")
    await waitForSettled(page)
    await expect(page.getByRole("button", { name: `Account: ${session.name}` })).toBeVisible()

    await page.getByRole("button", { name: `Account: ${session.name}` }).click()
    const [response] = await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes("/api/auth/logout") && r.request().method() === "POST"
      ),
      page.getByRole("menuitem", { name: "Sign out" }).click(),
    ])
    expect(response.status(), "the logout request was refused").toBe(200)

    // The app falls back to the sign-in screen, which is the whole `!me`
    // branch of `main.tsx` — not a redirect, so there is no URL to assert.
    await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible()
    await expect(page.getByLabel("Email")).toBeVisible()
    await expect(page.getByRole("navigation", { name: "Main" })).toHaveCount(0)

    // The important half. A client that forgot its session while the server
    // still honours the cookie has not signed anybody out — the next person
    // at this machine gets the previous one's account back by pressing Back.
    await page.goto("/papers")
    await waitForSettled(page)
    await expect(
      page.getByRole("button", { name: "Sign in" }),
      "the session cookie still works after signing out"
    ).toBeVisible()

    const me = await page.request.get("/api/auth/me")
    expect(me.status(), "/api/auth/me still answers for the ended session").toBe(401)

    await page.close()
    await context.close()
  })

  test("signing out is offered on a phone too", async ({ browser }) => {
    // The drawer is a different component from the sidebar and carries its
    // own copy of the account menu. It had no way out either.
    const session = openSession("FACULTY")
    const context = await browser.newContext({ viewport: { width: 375, height: 812 } })
    await context.addCookies([
      { name: session.cookie_name, value: session.session_key, domain: "localhost", path: "/" },
    ])
    const page = await context.newPage()

    await page.goto("/")
    await waitForSettled(page)
    await page.getByRole("button", { name: "Menu" }).click()
    await page.getByRole("button", { name: `Account: ${session.name}` }).click()
    await expect(page.getByRole("menuitem", { name: "Sign out" })).toBeVisible()
    await expect(page.getByRole("menuitem", { name: "Your profile" })).toBeVisible()

    await page.close()
    await context.close()
  })
})
