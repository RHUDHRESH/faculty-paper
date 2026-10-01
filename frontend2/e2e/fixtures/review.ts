import { expect, type Locator, type Page } from "@playwright/test"

export type Queue = "clearing" | "approvals" | "authorisations"

/**
 * Open a claim from its row in a desk queue.
 *
 * A row opens the full-page review at `/review/:id?queue=<queue>`; it is
 * never a side sheet (docs/ux/21-review-and-apply.md). So this clicks the
 * row's paper link, checks the address, and checks that nothing opened in a
 * dialog. It returns the page: the review's own controls (the decision bar
 * with Clear, Send back, Hold, Reject outright and Flag) sit on the page, not
 * inside a dialog, so a spec scopes to the page where it used to scope to the
 * sheet.
 */
export async function openFromQueue(page: Page, row: Locator, queue: Queue): Promise<Page> {
  await row.getByRole("link").first().click()
  await expect(page).toHaveURL(new RegExp(`/review/[^/?]+\\?queue=${queue}`))
  await expect(page.getByRole("dialog"), "the claim opened in a side sheet").toHaveCount(0)
  return page
}
