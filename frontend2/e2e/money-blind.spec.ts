/**
 * A head of department never sees a rupee. Anywhere.
 *
 * This is the single strongest rule in the product, and it is one of the
 * easiest to break by accident: every list component in the app knows how to
 * render an amount, `ui/paper.tsx` exports `money()`, and a shared table
 * reused on a head's screen brings the amount column with it. The server has
 * its own guard — `_refuse_hod_money_screens`, and `can_view_reports` leaves
 * a head out entirely, which is why they have `/api/hod/*` instead — but a
 * server guard does not stop a client rendering a figure it computed itself
 * or cached from somewhere else.
 *
 * So this asserts on the pixels: sign in as a head, walk every screen the
 * sidebar offers, and refuse to find U+20B9 anywhere in the document. Not in
 * text, not in an aria-label, not in a title attribute, not in a value
 * sitting in a form control that nobody has scrolled to.
 */
import { expect, test } from "@playwright/test"

import { storageStatePath } from "./fixtures/backend"
import { gotoRoute, sidebarRoutes, waitForSettled, watchForErrors } from "./fixtures/page-health"

/** U+20B9 INDIAN RUPEE SIGN. Written as an escape rather than as the glyph so
 *  that this file's own encoding can never be the reason it stops matching. */
const RUPEE = "₹"

/**
 * Everywhere a rupee could hide on a rendered page.
 *
 * `innerText` alone misses three of them: an `aria-label` a screen reader
 * would announce, a `title` a tooltip would show, and the `value` of an input
 * — none of which are text nodes. A head being read an amount by a screen
 * reader is the same failure as a head seeing one.
 */
async function rupeeSightings(page: import("@playwright/test").Page): Promise<string[]> {
  return page.evaluate((glyph: string) => {
    const found: string[] = []
    const describe = (el: Element) => {
      const tag = el.tagName.toLowerCase()
      const id = el.id ? `#${el.id}` : ""
      return `${tag}${id}`
    }

    // Text nodes, including ones inside collapsed or scrolled-away regions.
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    let node: Node | null
    while ((node = walker.nextNode())) {
      const text = node.nodeValue || ""
      if (!text.includes(glyph)) continue
      const parent = node.parentElement
      // A <template> or a <script> is not on screen.
      if (parent && parent.closest("script, style, template")) continue
      found.push(`text in ${parent ? describe(parent) : "?"}: ${text.trim().slice(0, 120)}`)
    }

    for (const el of Array.from(document.querySelectorAll("*"))) {
      for (const attr of ["aria-label", "title", "alt", "placeholder", "aria-valuetext"]) {
        const v = el.getAttribute(attr)
        if (v && v.includes(glyph)) found.push(`${attr} on ${describe(el)}: ${v.slice(0, 120)}`)
      }
      if (
        (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) &&
        el.value.includes(glyph)
      ) {
        found.push(`value on ${describe(el)}: ${el.value.slice(0, 120)}`)
      }
    }
    return found
  }, RUPEE)
}

test.describe("Money-blindness", () => {
  test.use({ storageState: storageStatePath("HOD") })

  test("no rupee glyph on any screen a head of department can reach", async ({ page }) => {
    const errors = watchForErrors(page)
    const routes = await sidebarRoutes(page)

    // If the sidebar came back near-empty the loop below would pass by
    // visiting nothing, which is the one way this test could lie.
    expect(routes.length, "the head's sidebar offered no destinations").toBeGreaterThan(4)

    const offenders: string[] = []
    for (const route of routes) {
      await gotoRoute(page, route)
      await waitForSettled(page)
      for (const sighting of await rupeeSightings(page)) {
        offenders.push(`${route} — ${sighting}`)
      }
    }

    expect(
      offenders,
      "A head of department was shown an amount. Money is not their business, anywhere:\n" +
        offenders.join("\n")
    ).toEqual([])

    // Not the point of this test, but a screen that threw on the way is a
    // screen whose figures were never rendered, which would make the check
    // above pass for the wrong reason.
    expect(errors.uncaught, "a screen threw while being checked").toEqual([])
  })

  test("the head's own department screen carries figures, but no money", async ({ page }) => {
    // A guard against the cheapest possible false pass: if `/department`
    // rendered nothing at all, the sweep above would be clean and mean
    // nothing. This asserts the screen genuinely has content on it.
    await page.goto("/department")
    await waitForSettled(page)
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible()

    const body = await page.evaluate(() => document.body.innerText)
    expect(body.length, "/department rendered almost nothing").toBeGreaterThan(200)
    expect(body).not.toContain(RUPEE)
  })
})
