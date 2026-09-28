/**
 * The gate behind docs/jtbd/a11y-mobile-speed-audit.md.
 *
 * Every sidebar route for every role, at a phone width and a desktop width,
 * light and dark, fails on:
 *   - horizontal page scroll (the page itself, not a container that scrolls
 *     on purpose), and
 *   - any axe-core WCAG 2.1 A/AA violation of impact "serious" or "critical".
 *
 * The collector that produced the audit table is audit-collect.spec.ts; this
 * file only keeps the fixes fixed.
 */
import AxeBuilder from "@axe-core/playwright"
import { expect, test, type Page } from "@playwright/test"

import { ALL_ROLES as ROLES, ANY_ROLE_LABEL, storageStatePath } from "./fixtures/backend"
import { gotoRoute, sidebarRoutes, waitForSettled } from "./fixtures/page-health"

const VIEWS = [
  { name: "phone", width: 390, height: 844, dark: false },
  { name: "desktop", width: 1280, height: 900, dark: false },
  { name: "phone-dark", width: 375, height: 812, dark: true },
] as const

async function pageOverflow(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const limit = window.innerWidth
    const doc = document.documentElement
    if (doc.scrollWidth <= limit + 1) return null
    const scrolls = (el: Element) => {
      for (let p = el.parentElement; p; p = p.parentElement)
        if (/(auto|scroll|hidden|clip)/.test(getComputedStyle(p).overflowX)) return true
      return false
    }
    const culprit = Array.from(document.body.querySelectorAll("*")).find((el) => {
      const b = el.getBoundingClientRect()
      return b.width > 0 && b.right > limit + 1 && !scrolls(el)
    })
    const what = culprit
      ? `${culprit.tagName.toLowerCase()}.${String(culprit.className).split(/\s+/).slice(0, 4).join(".")}`
      : "unknown"
    return `page is ${doc.scrollWidth}px wide in a ${limit}px window; widest: ${what}`
  })
}

for (const role of ROLES) {
  for (const v of VIEWS) {
    test(`${ANY_ROLE_LABEL[role]} @ ${v.name}: no sideways scroll, no serious axe violations`, async ({
      browser,
    }) => {
      const ctx = await browser.newContext({
        storageState: storageStatePath(role),
        viewport: { width: v.width, height: v.height },
        colorScheme: v.dark ? "dark" : "light",
        // Entrance animations fade text in; axe sampling mid-fade reports
        // contrast failures that are not there a moment later.
        reducedMotion: "reduce",
      })
      const page = await ctx.newPage()
      const routes = await sidebarRoutes(page)
      const problems: string[] = []
      for (const route of routes) {
        await gotoRoute(page, route)
        await waitForSettled(page)
        const over = await pageOverflow(page)
        if (over) problems.push(`${route}: ${over}`)
        const axe = await new AxeBuilder({ page })
          .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
          .analyze()
        for (const x of axe.violations) {
          if (x.impact !== "serious" && x.impact !== "critical") continue
          const where = x.nodes
            .slice(0, 2)
            .map((n) => n.target.join(" "))
            .join(" | ")
          problems.push(`${route}: axe ${x.impact} ${x.id} (${x.nodes.length}) at ${where}`)
        }
      }
      await ctx.close()
      expect(problems, `${role} @ ${v.name}`).toEqual([])
    })
  }
}
