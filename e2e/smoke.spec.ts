/**
 * Faculty happy path, end to end.
 *
 * This exists because the endpoint tests all post hand-written JSON, so nothing
 * exercised the payload the browser actually builds — which is how a 403 on
 * every faculty submission survived in committed code.
 *
 * Needs a seeded database and both servers running:
 *   python manage.py migrate && python manage.py seed --force
 *   python manage.py runserver 8000
 *   cd frontend && npm run dev
 * Then: npx playwright test
 */
import { expect, test } from "@playwright/test"

async function signInAsFaculty(page: import("@playwright/test").Page) {
  await page.goto("/login")
  await page.getByLabel("Email").fill("faculty@college.edu")
  await page.getByLabel("Password").fill("faculty123")
  await page.getByRole("button", { name: /sign in/i }).click()
  await expect(page).toHaveURL(/\/faculty/)
}

test.describe("faculty smoke", () => {
  test("sign in lands on the faculty portal", async ({ page }) => {
    await signInAsFaculty(page)
    await page.goto("/faculty/new")
    await expect(page.getByRole("heading", { name: /identity/i })).toBeVisible()
  })

  test("saving a draft does not 403", async ({ page }) => {
    // The regression guard: buildClaimPayload must not send owner_id in faculty
    // mode, or the server rejects it as an admin-proxy attempt.
    await signInAsFaculty(page)
    await page.goto("/faculty/new")
    await page.getByLabel(/title of the paper/i).fill("Playwright Smoke Paper")

    const created = page.waitForResponse(
      (r) => r.url().includes("/api/claims") && r.request().method() === "POST"
    )
    await page.getByRole("button", { name: /save draft/i }).click()
    expect((await created).status()).toBe(200)
  })

  test("the wizard blocks advancing with empty required fields", async ({ page }) => {
    await signInAsFaculty(page)
    await page.goto("/faculty/new")

    await page.getByRole("button", { name: /^continue$/i }).click()
    // The error summary is the accessible entry point, so assert on that rather
    // than on any single inline message.
    await expect(page.getByRole("alert").first()).toBeVisible()
  })
})
