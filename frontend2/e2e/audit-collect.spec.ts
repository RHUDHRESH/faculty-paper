/**
 * The audit collector behind docs/jtbd/a11y-mobile-speed-audit.md.
 *
 * Not a gate — it records, it does not assert. It only runs when AUDIT=1, and
 * writes one JSON file per role to e2e/.artifacts/audit/. The gate that keeps
 * the fixes fixed is sweep-a11y.spec.ts.
 */
import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import AxeBuilder from "@axe-core/playwright"
import { test, type Page } from "@playwright/test"

import { ROLES, storageStatePath } from "./fixtures/backend"
import { gotoRoute, sidebarRoutes, waitForSettled } from "./fixtures/page-health"

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), ".artifacts", process.env.AUDIT_OUT || "audit")
const VIEWS = [
  { name: "375", width: 375, height: 812, dark: false },
  { name: "390", width: 390, height: 844, dark: false },
  { name: "768", width: 768, height: 1024, dark: false },
  { name: "1280", width: 1280, height: 900, dark: false },
  { name: "390-dark", width: 390, height: 844, dark: true },
  { name: "1280-dark", width: 1280, height: 900, dark: true },
]

async function probe(page: Page, phone: boolean) {
  return page.evaluate((phone) => {
    const lim = window.innerWidth
    const out = {
      scrollWidth: document.documentElement.scrollWidth,
      overflow: [] as string[],
      small: [] as string[],
      imgNoAlt: [] as string[],
      clipped: [] as string[],
    }
    const desc = (el: Element) => {
      const id = el.id ? `#${el.id}` : ""
      const cls =
        typeof el.className === "string" ? "." + el.className.split(/\s+/).slice(0, 3).join(".") : ""
      const text = (el.textContent || el.getAttribute("aria-label") || "").trim().slice(0, 30)
      return `${el.tagName.toLowerCase()}${id}${cls} "${text}"`
    }
    const scrollsX = (el: Element | null) => {
      for (let p = el?.parentElement; p; p = p.parentElement) {
        const s = getComputedStyle(p)
        if (/(auto|scroll|hidden|clip)/.test(s.overflowX)) return true
      }
      return false
    }
    if (out.scrollWidth > lim + 1) {
      for (const el of Array.from(document.body.querySelectorAll("*"))) {
        const b = el.getBoundingClientRect()
        if (!b.width || b.right <= lim + 1 || scrollsX(el)) continue
        out.overflow.push(`${desc(el)} right=${Math.round(b.right)}`)
        if (out.overflow.length > 4) break
      }
    }
    if (phone) {
      const sel = 'a[href], button, input:not([type=hidden]), select, textarea, [role=button], [role=tab], [role=switch], [role=checkbox]'
      for (const el of Array.from(document.querySelectorAll(sel))) {
        const b = el.getBoundingClientRect()
        if (!b.width || !b.height) continue
        if (getComputedStyle(el).visibility === "hidden") continue
        // A link inside running text is exempt (WCAG 2.5.8 inline exception).
        if (el.tagName === "A" && el.closest("p, li > span, td")?.textContent !== el.textContent &&
          el.closest("p")) continue
        // A native checkbox/radio inside a label is sized by the label.
        if (el.tagName === "INPUT" && el.closest("label")) {
          const l = el.closest("label")!.getBoundingClientRect()
          if (l.height >= 40) continue
        }
        if (b.height < 40 || b.width < 40) out.small.push(`${desc(el)} ${Math.round(b.width)}x${Math.round(b.height)}`)
      }
    }
    for (const img of Array.from(document.querySelectorAll("img"))) {
      if (!img.hasAttribute("alt")) out.imgNoAlt.push(img.src.slice(-60))
    }
    for (const el of Array.from(document.querySelectorAll("h1,h2,h3,button,a,td,th,p"))) {
      const s = getComputedStyle(el)
      if (el.scrollWidth > el.clientWidth + 2 && s.overflowX === "visible" && s.textOverflow !== "ellipsis" && el.clientWidth > 0) {
        out.clipped.push(desc(el))
        if (out.clipped.length > 4) break
      }
    }
    return out
  }, phone)
}

async function focusRings(page: Page) {
  const missing: string[] = []
  await page.locator("body").click({ position: { x: 1, y: 1 } }).catch(() => {})
  for (let i = 0; i < 25; i++) {
    await page.keyboard.press("Tab")
    const r = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null
      if (!el || el === document.body) return null
      const s = getComputedStyle(el)
      const ring =
        (s.outlineStyle !== "none" && parseFloat(s.outlineWidth) > 0) ||
        (s.boxShadow && s.boxShadow !== "none")
      return ring ? null : `${el.tagName.toLowerCase()} "${(el.textContent || el.getAttribute("aria-label") || "").trim().slice(0, 30)}"`
    })
    if (r && !missing.includes(r)) missing.push(r)
  }
  return missing
}

test.skip(!process.env.AUDIT, "audit collector: set AUDIT=1")

for (const role of ROLES) {
  test(`audit ${role}`, async ({ browser }) => {
    test.setTimeout(3_600_000)
    const rows: unknown[] = []
    for (const v of VIEWS) {
      const ctx = await browser.newContext({
        storageState: storageStatePath(role),
        viewport: { width: v.width, height: v.height },
        colorScheme: v.dark ? "dark" : "light",
        hasTouch: v.width < 768,
      })
      const page = await ctx.newPage()
      const routes = await sidebarRoutes(page)
      const phone = v.width < 768
      for (const route of routes) {
        const consoleErr: string[] = []
        const failed: string[] = []
        const api: { url: string; ms: number }[] = []
        page.removeAllListeners("console")
        page.removeAllListeners("response")
        page.removeAllListeners("requestfailed")
        page.on("console", (m) => m.type() === "error" && consoleErr.push(m.text().slice(0, 200)))
        page.on("requestfailed", (r) => r.url().includes("/api/") && failed.push(`${r.url()} ${r.failure()?.errorText}`))
        page.on("response", async (res) => {
          if (!res.url().includes("/api/")) return
          if (res.status() >= 400) failed.push(`${res.status()} ${res.url()}`)
          await res.finished().catch(() => {})
          const t = res.request().timing()
          api.push({ url: res.url().replace(/^https?:\/\/[^/]+/, ""), ms: Math.round(t.responseEnd) })
        })
        const t0 = Date.now()
        let settleErr = ""
        try {
          await gotoRoute(page, route)
          await waitForSettled(page)
        } catch (e) {
          settleErr = String(e).slice(0, 200)
        }
        const ttc = Date.now() - t0
        const p = await probe(page, phone)
        let axe: { id: string; impact: string; nodes: string[] }[] = []
        if (v.name === "390" || v.name === "1280" || v.dark) {
          const b = new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
          if (v.dark) b.withRules(["color-contrast"])
          const res = await b.analyze().catch(() => null)
          axe = (res?.violations || []).map((x) => ({
            id: x.id,
            impact: x.impact || "",
            nodes: x.nodes.slice(0, 3).map((n) => `${n.target.join(" ")} :: ${n.failureSummary?.split("\n")[1]?.trim() ?? ""}`),
          }))
        }
        const focus = v.name === "1280" ? await focusRings(page) : []
        rows.push({ role, route, view: v.name, ttc, settleErr, ...p, axe, focus, consoleErr, failed, api })
      }
      await ctx.close()
    }
    mkdirSync(OUT, { recursive: true })
    writeFileSync(path.join(OUT, `${role}.json`), JSON.stringify(rows, null, 1))
  })
}
