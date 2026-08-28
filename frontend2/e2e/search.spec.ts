/**
 * The one box that searches everything, and the one thing it must never show.
 *
 * `/search` is second in the sidebar and offered to every role without
 * exception, which makes it the widest-reach screen added in a long time and
 * the only one a head of department is expected to use daily. It searches four
 * things at once — the literature, our own journal tables, the people here,
 * and the claims already filed — and the last of those four carries an amount.
 *
 * That is the whole risk. `money-blind.spec.ts` sweeps every screen a head can
 * reach and refuses to find a rupee anywhere, and it already covers this route
 * because it reads the sidebar rather than a list. But that sweep visits a
 * route and looks at it: on this page, with no query, there is nothing on
 * screen but a prompt. A search page passes a money check trivially by not
 * having searched. So the check has to be made against a page with results on
 * it, and the results have to include the one kind that carries money.
 *
 * The query is a seeded ticket's own title
 * ---------------------------------------
 * Not a real paper. Searching for a real one asks Crossref, OpenAlex and
 * Scopus, which makes the assertion partly a statement about three vendors'
 * uptime and gives a different answer on different days. A seeded ticket's
 * title is held in this college's own database, is unique per run, and is
 * matched by the part of the search that reads our own claims — the part that
 * renders an amount. It is the only query that is both deterministic and
 * actually exercises the rule being tested.
 */
import { expect, test, type Browser, type Page } from "@playwright/test"

import { ROLES, ROLE_LABEL, seedClaim, storageStatePath, type E2ERole, type SessionInfo } from "./fixtures/backend"
import { waitForSettled, watchForErrors } from "./fixtures/page-health"

/** U+20B9 INDIAN RUPEE SIGN, as an escape so this file's own encoding can
 *  never be the reason it stops matching. Same reasoning as `money-blind`. */
const RUPEE = "₹"

async function asRole(browser: Browser, role: string): Promise<Page> {
  const context = await browser.newContext({ storageState: storageStatePath(role) })
  return context.newPage()
}

async function done(page: Page): Promise<void> {
  const context = page.context()
  await page.close()
  await context.close()
}

/**
 * Everywhere a rupee could hide on a rendered page — text, the labels a screen
 * reader announces, a tooltip, and the value sitting in a form control.
 *
 * Deliberately the same shape as the sweep in `money-blind.spec.ts`: a head
 * being *read* an amount by a screen reader is the same failure as a head
 * seeing one, and `innerText` alone catches neither.
 */
async function rupeeSightings(page: Page): Promise<string[]> {
  return page.evaluate((glyph: string) => {
    const found: string[] = []
    const describe = (el: Element) => `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}`

    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    let node: Node | null
    while ((node = walker.nextNode())) {
      const text = node.nodeValue || ""
      if (!text.includes(glyph)) continue
      const parent = node.parentElement
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

/** Run a search by putting the query in the URL, which is where this page
 *  keeps it — the box debounces into `?q=`, and a shared link has to work. */
async function searchFor(page: Page, query: string): Promise<void> {
  await page.goto(`/search?q=${encodeURIComponent(query)}`)
  await waitForSettled(page)
}

test.describe("The search page", () => {
  let seeded: SessionInfo

  test.beforeAll(() => {
    seeded = seedClaim()
  })

  for (const role of ROLES) {
    test(`opens for ${ROLE_LABEL[role as E2ERole]}, and asks before it answers`, async ({
      browser,
    }) => {
      const page = await asRole(browser, role)
      const errors = watchForErrors(page)

      await page.goto("/search")
      await waitForSettled(page)

      // Offered to everybody, so it has to work for everybody — this is the
      // only route in the sidebar with no role condition on it at all.
      await expect(page.getByRole("heading", { name: "Search", level: 1 })).toBeVisible()
      await expect(
        page.getByRole("searchbox", { name: "Search papers, journals, people and claims" })
      ).toBeVisible()

      // An empty box is not an empty result. Saying "nothing found" before
      // anybody has asked is a lie with consequences on the screen people use
      // to check whether a paper has already been claimed.
      await expect(page.getByText("Search for anything")).toBeVisible()
      await expect(
        page.getByText(/no results|nothing found/i),
        "the page reported an empty result before anything was searched"
      ).toHaveCount(0)

      expect(errors.uncaught, `${role} /search: uncaught error(s)`).toEqual([])
      expect(errors.console, `${role} /search: console error(s)`).toEqual([])

      await done(page)
    })
  }

  test("finds a claim this college has already filed, and prices it", async ({ browser }) => {
    const page = await asRole(browser, "RESEARCH_CELL")
    await searchFor(page, seeded.claim!.title)

    // The section exists only when it has results in it — `Group` renders
    // nothing at count zero — so finding it by name is finding the results.
    const filed = page.getByRole("region", { name: "Claims filed here" })
    await expect(
      filed,
      "searching a filed paper's own title did not find the claim"
    ).toBeVisible()
    await expect(filed).toContainText(seeded.claim!.title)

    // And for somebody allowed to see money, the amount is there — which is
    // what makes the head-of-department test below mean anything. Without
    // this, a page that showed no amount to anybody would pass it.
    await expect(
      filed,
      "the claim was found but carries no amount for a role that may see one"
    ).toContainText(new RegExp(`${RUPEE}\\s*[\\d,]+`))

    await done(page)
  })

  test("shows a head of department the same claim, and not a rupee anywhere", async ({
    browser,
  }) => {
    const page = await asRole(browser, "HOD")
    await searchFor(page, seeded.claim!.title)

    /**
     * The head finds it. This half is not a formality — it is the guard
     * against the cheapest possible false pass, where the rupee sweep below
     * comes back clean because the search returned nothing, or errored, or the
     * claims section was hidden from heads outright. A head of department is
     * meant to be able to look a paper up; they are only not meant to be told
     * what it paid.
     */
    const filed = page.getByRole("region", { name: "Claims filed here" })
    await expect(
      filed,
      "a head of department cannot find a filed claim by its title"
    ).toBeVisible()
    await expect(filed).toContainText(seeded.claim!.title)

    // And the whole document, not just that section: `money()` is exported
    // from `ui/paper.tsx` and every list component in this app knows how to
    // call it, so an amount can arrive anywhere on the page.
    const offenders = await rupeeSightings(page)
    expect(
      offenders,
      "A head of department was shown an amount on the search page:\n" + offenders.join("\n")
    ).toEqual([])
  })
})
