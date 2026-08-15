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

/** The wizard sits behind an eligibility gate: three confirmations, then
 * "Start the claim". Every test that wants the form goes through it. */
async function openClaimForm(page: import("@playwright/test").Page) {
  await page.goto("/faculty/new")
  const boxes = page.getByRole("checkbox")
  await expect(boxes).toHaveCount(3)
  for (let i = 0; i < 3; i++) {
    const box = boxes.nth(i)
    await box.click()
    await expect(box).toBeChecked()
  }
  await page.getByRole("button", { name: /start the claim/i }).click()
}

/** Step 0 (identity) → step 1 (publication). The identity step is mostly
 * pre-filled from the profile; the Scopus link is the one field a fresh seed
 * account is missing, so supply it before advancing. */
async function goToPublicationStep(page: import("@playwright/test").Page) {
  const scopus = page.getByLabel(/author scopus link/i)
  if (!(await scopus.inputValue()).trim()) {
    await scopus.fill("https://www.scopus.com/authid/detail.uri?authorId=57193912800")
  }
  await page.getByRole("button", { name: /^continue$/i }).click()
  await expect(page.getByRole("heading", { name: /publication/i }).first()).toBeVisible()
}

test.describe("faculty smoke", () => {
  test("sign in lands on the faculty portal", async ({ page }) => {
    await signInAsFaculty(page)
    await openClaimForm(page)
    await expect(page.getByRole("heading", { name: /identity/i })).toBeVisible()
  })

  test("saving a draft does not 403", async ({ page }) => {
    // The regression guard: buildClaimPayload must not send owner_id in faculty
    // mode, or the server rejects it as an admin-proxy attempt.
    await signInAsFaculty(page)
    await openClaimForm(page)
    await goToPublicationStep(page)
    await page.getByLabel(/title of the paper/i).fill("Playwright Smoke Paper")

    const created = page.waitForResponse(
      (r) => r.url().includes("/api/claims") && r.request().method() === "POST"
    )
    await page.getByRole("button", { name: /save draft/i }).click()
    expect((await created).status()).toBe(200)
  })

  test("the wizard blocks advancing with empty required fields", async ({ page }) => {
    await signInAsFaculty(page)
    await openClaimForm(page)
    await goToPublicationStep(page)

    // The publication step's required fields are untouched, so Continue must
    // refuse and surface the error summary — the accessible entry point.
    await page.getByRole("button", { name: /^continue$/i }).click()
    await expect(page.getByRole("alert").first()).toBeVisible()
  })
})
