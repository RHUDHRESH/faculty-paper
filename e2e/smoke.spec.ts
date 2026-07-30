import { test, expect } from "@playwright/test";

/**
 * Smoke: login as faculty → open new claim page.
 * Full approve chain needs seeded users + running app (`npm run dev`).
 */
test.describe("faculty smoke", () => {
  test("login and reach new claim", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("Email").fill("faculty@college.edu");
    await page.getByLabel("Password").fill("faculty123");
    await page.getByRole("button", { name: /sign in/i }).click();
    await expect(page).toHaveURL(/dashboard/);
    await page.goto("/claims/new");
    await expect(page.getByRole("heading", { name: /file a claim/i })).toBeVisible();
  });
});
