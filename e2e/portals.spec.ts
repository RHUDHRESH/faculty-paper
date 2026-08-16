/**
 * Every page of every portal must render.
 *
 * This exists because the claim wizard once threw during render â€” a hook that
 * only works inside a data router â€” and shipped as a blank white page that no
 * unit test, typecheck or build could see. The API was perfectly healthy the
 * whole time. So each route is opened as the role that owns it, and the page
 * has to produce its heading and log no uncaught error.
 */
import { expect, test, type Page } from "@playwright/test"

type Role = { email: string; password: string }

const FACULTY: Role = { email: "faculty@college.edu", password: "faculty123" }
const ADMIN: Role = { email: "admin@college.edu", password: "admin123" }
const FINANCE: Role = { email: "finance@college.edu", password: "finance123" }
const PRINCIPAL: Role = { email: "principal@college.edu", password: "principal123" }

async function signIn(page: Page, role: Role) {
  await page.goto("/login")
  await page.getByLabel("Email").fill(role.email)
  await page.getByLabel("Password").fill(role.password)
  await page.getByRole("button", { name: /sign in/i }).click()
  await expect(page).not.toHaveURL(/\/login/)
}

/** Collect uncaught page errors so a crashed render fails loudly. */
function watchForCrashes(page: Page): string[] {
  const errors: string[] = []
  page.on("pageerror", (e) => errors.push(e.message))
  return errors
}

const PAGES: { role: Role; label: string; path: string; heading: RegExp }[] = [
  { role: FACULTY, label: "faculty tickets", path: "/faculty", heading: /my tickets/i },
  { role: FACULTY, label: "faculty new ticket", path: "/faculty/new", heading: /new ticket/i },
  { role: FACULTY, label: "faculty profile", path: "/faculty/profile", heading: /profile/i },

  { role: ADMIN, label: "admin overview", path: "/admin", heading: /admin overview/i },
  { role: ADMIN, label: "admin clearing queue", path: "/admin/clearing", heading: /clearing queue/i },
  { role: ADMIN, label: "admin submit for faculty", path: "/admin/submit", heading: /submit/i },
  { role: ADMIN, label: "admin users", path: "/admin/users", heading: /users/i },
  { role: ADMIN, label: "admin imports", path: "/admin/scimago", heading: /scimago|imports/i },
  { role: ADMIN, label: "admin prior payments", path: "/admin/prior", heading: /prior/i },
  { role: ADMIN, label: "admin monthly", path: "/admin/monthly", heading: /monthly/i },
  { role: ADMIN, label: "admin query", path: "/admin/query", heading: /query/i },
  { role: ADMIN, label: "admin reports", path: "/admin/reports", heading: /reports/i },
  { role: ADMIN, label: "admin audit", path: "/admin/audit", heading: /audit/i },

  { role: FINANCE, label: "finance payment orders", path: "/finance", heading: /payment orders/i },
  { role: FINANCE, label: "finance processed", path: "/finance/paid", heading: /processed payments/i },
  { role: FINANCE, label: "finance ledger", path: "/finance/ledger", heading: /ledger/i },
  { role: FINANCE, label: "finance query", path: "/finance/query", heading: /query/i },
  { role: FINANCE, label: "finance reports", path: "/finance/reports", heading: /reports/i },
  { role: FINANCE, label: "finance formula", path: "/finance/formula", heading: /formula/i },

  { role: PRINCIPAL, label: "principal queue", path: "/principal", heading: /all tickets/i },
  { role: PRINCIPAL, label: "principal overview", path: "/principal/overview", heading: /overview/i },
  { role: PRINCIPAL, label: "principal reports", path: "/principal/reports", heading: /reports/i },
  { role: PRINCIPAL, label: "principal query", path: "/principal/query", heading: /query/i },
]

test.describe("every portal page renders", () => {
  for (const { role, label, path, heading } of PAGES) {
    test(label, async ({ page }) => {
      const crashes = watchForCrashes(page)
      await signIn(page, role)
      await page.goto(path)
      await expect(page.getByRole("heading", { name: heading }).first()).toBeVisible()
      expect(crashes, `uncaught error on ${path}`).toEqual([])
    })
  }
})

test.describe("routing guards", () => {
  test("an unknown URL shows the 404 page rather than silently redirecting", async ({ page }) => {
    await signIn(page, FACULTY)
    await page.goto("/faculty/definitely-not-a-page")
    await expect(page.getByText(/does not exist/i)).toBeVisible()
  })

  test("faculty cannot open an admin route", async ({ page }) => {
    await signIn(page, FACULTY)
    await page.goto("/admin/users")
    // The portal guard sends them back to their own portal.
    await expect(page).toHaveURL(/\/faculty/)
  })

  test("signing out returns to the login screen", async ({ page }) => {
    await signIn(page, FACULTY)
    await page.getByRole("button", { name: /account menu/i }).click()
    await page.getByRole("menuitem", { name: /sign out/i }).click()
    await expect(page).toHaveURL(/\/login/)
  })
})

