/**
 * 375 pixels wide, and nothing sticking out of the side.
 *
 * Horizontal page scroll is a real defect here and several screens had it.
 * It is also the kind that never shows up on the machine it was built on: a
 * table that is 40px too wide at 375 looks perfect at 1440, and the person
 * who finds it is a head of department on a phone in a corridor, who reports
 * it as "the page is broken".
 *
 * The assertion is the plain one — `document.documentElement.scrollWidth` must
 * not exceed `window.innerWidth`. When it does, the spec goes and finds which
 * element is responsible, because "the page scrolls sideways by 40px" is not
 * something anybody can act on and "this table is 415px wide" is.
 */
import { expect, test } from "@playwright/test"

import { ROLES, ROLE_LABEL, storageStatePath, type E2ERole } from "./fixtures/backend"
import { gotoAsUser, gotoRoute, sidebarRoutes, waitForSettled } from "./fixtures/page-health"

const PHONE = { width: 375, height: 812 }

/** A pixel of slack. Sub-pixel layout rounding can put `scrollWidth` one
 *  above `innerWidth` on a page that is visually flush, and a suite that
 *  cries wolf over one pixel gets switched off. */
const TOLERANCE = 1

/**
 * Screens that still do this, each with the reason.
 *
 * This is not a mute button. The sweep below asserts that every route *not*
 * on this list is clean, and a second test asserts that every route *on* it
 * still overflows — so fixing one of these turns this file red and the entry
 * has to be deleted. An exception that cannot rot is the only kind worth
 * writing down.
 *
 * `/programme` — still 1,158px wide inside a 375px window, in the
 * `Departments` block of `pages/programme.tsx`.
 *
 * Note the correction, because the first diagnosis was wrong and a `min-w-0`
 * has already been added on its strength without fixing anything. The problem
 * is **not** the grid item's `min-width`. It is the track.
 *
 * Below `sm` the wrapper `<div className="grid gap-x-8 gap-y-6 pt-2
 * sm:grid-cols-2">` declares no `grid-template-columns` at all, so its
 * children land in a single *implicit* column sized by `grid-auto-columns:
 * auto`. An `auto` track is sized from its items' **max-content
 * contribution** — and `min-width: 0` lowers an item's *minimum*
 * contribution, not its maximum. So the track still comes out as wide as the
 * longest unbroken run of text, which here is `d.areas.join(", ")`, a
 * comma-separated list of every subject area a department publishes in.
 *
 * The fix belongs on the container, not the item: give it an explicit
 * `grid-cols-1` (Tailwind expands that to `repeat(1, minmax(0, 1fr))`), which
 * is a definite track that cannot outgrow its container. The existing
 * `min-w-0` on the item is then doing the job it was added for.
 */
//: Screens that are known to scroll sideways, with why. Empty is the goal.
//:
//: `/programme` used to live here -- its container declared no columns below
//: `sm`, so children landed in an implicit `grid-auto-columns: auto` track
//: that sizes from max-content, and the page came out 1,158px wide in a 375px
//: window. `grid-cols-1` on the container fixed it and the entry came out,
//: which is the point of the guard below: an exception cannot outlive the bug
//: it excuses.
const KNOWN_OVERFLOW: Record<string, string> = {}

type Overflow = { scrollWidth: number; innerWidth: number; culprits: string[] }

async function measureOverflow(page: import("@playwright/test").Page): Promise<Overflow> {
  return page.evaluate(() => {
    const doc = document.documentElement
    const limit = window.innerWidth
    const culprits: string[] = []
    if (doc.scrollWidth > limit) {
      for (const el of Array.from(document.body.querySelectorAll("*"))) {
        const box = el.getBoundingClientRect()
        if (box.width === 0 || box.height === 0) continue
        if (box.right <= limit + 1) continue
        // Something inside a container that scrolls on its own is allowed to
        // be wider than the screen — that is what the container is for. Only
        // an element that pushes the *page* out is a finding.
        let node: Element | null = el.parentElement
        let contained = false
        while (node && node !== document.body) {
          const overflowX = getComputedStyle(node).overflowX
          if (overflowX === "auto" || overflowX === "scroll" || overflowX === "hidden") {
            contained = true
            break
          }
          node = node.parentElement
        }
        if (contained) continue
        const cls = typeof el.className === "string" ? el.className.slice(0, 90) : ""
        culprits.push(
          `<${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}${cls ? ` class="${cls}"` : ""}>` +
            ` right=${Math.round(box.right)} width=${Math.round(box.width)}`
        )
        if (culprits.length >= 5) break
      }
    }
    return { scrollWidth: doc.scrollWidth, innerWidth: limit, culprits }
  })
}

for (const role of ROLES) {
  test.describe(`${ROLE_LABEL[role as E2ERole]} on a phone`, () => {
    test.use({ storageState: storageStatePath(role), viewport: PHONE })

    test(`${role}: no screen scrolls sideways at 375px`, async ({ page }) => {
      // The drawer is closed at rest, so the route list has to come from the
      // same sidebar the desktop test reads — it is in the DOM either way.
      const routes = await sidebarRoutes(page)
      expect(routes.length, `${role}: the sidebar offered no destinations`).toBeGreaterThan(2)

      const findings: string[] = []
      for (const route of routes) {
        if (route in KNOWN_OVERFLOW) continue
        await gotoRoute(page, route)
        await waitForSettled(page)
        const { scrollWidth, innerWidth, culprits } = await measureOverflow(page)
        if (scrollWidth > innerWidth + TOLERANCE) {
          findings.push(
            `${route}: the page is ${scrollWidth}px wide in a ${innerWidth}px window` +
              (culprits.length ? `\n    ${culprits.join("\n    ")}` : "")
          )
        }
      }

      expect(findings, `${role}: screens that scroll sideways on a phone:\n${findings.join("\n")}`).toEqual([])
    })
  })
}

test.describe("The screens known to scroll sideways", () => {
  test.use({ storageState: storageStatePath("FACULTY"), viewport: PHONE })

  test("still do, so the exception list cannot quietly go stale", async ({ page }) => {
    test.skip(
      Object.keys(KNOWN_OVERFLOW).length === 0,
      "Nothing is excepted — every route is swept by the tests above."
    )
    for (const [route, why] of Object.entries(KNOWN_OVERFLOW)) {
      await gotoRoute(page, route)
      await waitForSettled(page)

      /**
       * The content has to be on the page before its width means anything.
       *
       * This test once reported `/programme` as fixed when it was not: the
       * screen had rendered its frame but not yet the department list that
       * overflows, so nothing was wide and the guard concluded the defect
       * had gone. The entry was removed on that evidence and the sweep
       * immediately failed. A width assertion against an empty screen is not
       * a measurement, it is a coin toss.
       */
      await expect(
        page.locator("main"),
        `${route}: nothing had rendered, so its width proves nothing`
      ).not.toBeEmpty()
      const settled = await page.evaluate(() => document.body.innerText.length)
      expect(settled, `${route}: rendered almost nothing`).toBeGreaterThan(400)

      const { scrollWidth, innerWidth, culprits } = await measureOverflow(page)
      expect(
        scrollWidth,
        `${route} no longer scrolls sideways (${why}). Delete its entry from ` +
          `KNOWN_OVERFLOW in this file so the sweep starts guarding it.` +
          (culprits.length ? `\n${culprits.join("\n")}` : "")
      ).toBeGreaterThan(innerWidth + TOLERANCE)
    }
  })
})

test.describe("The mobile drawer", () => {
  test.use({ storageState: storageStatePath("RESEARCH_CELL"), viewport: PHONE })

  test("opens, navigates, and closes itself behind you", async ({ page }) => {
    // `gotoAsUser`, not `goto`: a dropped `/api/auth/me` leaves the app on the
    // sign-in screen for good, and this test then fails saying it could not
    // find the Menu button — which sends you looking at the drawer instead of
    // at the session.
    await gotoAsUser(page, "/")

    // The desktop sidebar is `md:hidden`'s opposite and must not be on screen.
    await expect(page.getByRole("button", { name: "Menu" })).toBeVisible()

    await page.getByRole("button", { name: "Menu" }).click()
    const drawer = page.getByRole("dialog")
    await expect(drawer).toBeVisible()
    await drawer.getByRole("link", { name: "Clearing queue" }).click()

    // A route change closes the drawer — leaving it open over the page
    // somebody just asked for is the commonest small annoyance in a mobile
    // shell, and it is also a modal, so leaving it open leaves the page inert.
    await expect(drawer).toBeHidden()
    await expect(page.getByRole("heading", { name: "Clearing queue", level: 1 })).toBeVisible()

    const { scrollWidth, innerWidth } = await measureOverflow(page)
    expect(scrollWidth).toBeLessThanOrEqual(innerWidth + TOLERANCE)
  })
})
