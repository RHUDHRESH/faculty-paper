// Visual inspection runner: drives the running app (Vite :5174 -> Django :8000)
// as a user would — real navigation, clicks and typing, no state injection —
// and saves one PNG per test point into gui-test-screenshots/ plus a JSON log
// of read-only DOM facts (headings, rupee-glyph checks, console errors).
//
// Sessions come from manage.py e2e_session (minted during environment prep);
// they are injected once per role as cookies, which is the same storageState
// mechanism the repo's own e2e fixtures use. It only makes pages reachable.
//
// Run:  cd frontend2 && node ../scripts/visual_inspect.mjs
import { chromium } from "@playwright/test";
import { readFile, writeFile, mkdir } from "node:fs/promises";

const BASE = "http://localhost:5174";
const OUT = "../gui-test-screenshots";
const roles = {};
for (const r of ["FACULTY", "RESEARCH_CELL", "PRINCIPAL", "DIRECTOR", "FINANCE", "HOD", "SUPER_ADMIN"]) {
  roles[r] = JSON.parse(await readFile(`${OUT}/session_${r}.json`, "utf8"));
}

const results = [];
let context;
let page;

async function settle(ms = 700) {
  await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(ms);
}

async function asRole(role) {
  // environment re-preparation between test points: swap the session cookie
  const existing = await context.cookies("http://localhost");
  await context.clearCookies();
  const keep = existing.filter((c) => c.name !== "sessionid");
  await context.addCookies([
    ...keep,
    { name: "sessionid", value: roles[role].session_key, domain: "localhost", path: "/" },
  ]);
}

async function shot(name, { fullPage = false } = {}) {
  const png = await page.screenshot({ fullPage });
  await writeFile(`${OUT}/${name}.png`, png);
  return `${OUT}/${name}.png`;
}

async function visit(name, path, { fullPage = false, rupeeCheck = false } = {}) {
  await page.goto(BASE + path, { waitUntil: "domcontentloaded" });
  await settle();
  const file = await shot(name, { fullPage });
  const entry = { name, path, file, title: await page.title(), h1: null, rupeeCount: null, errors: [] };
  try {
    entry.h1 = (await page.locator("h1").first().textContent({ timeout: 3000 }))?.trim() ?? null;
  } catch {}
  if (rupeeCheck) {
    entry.rupeeCount = await page.locator("text=₹").count();
  }
  return entry;
}

async function clickFirstRowTo(name, path, rowLocatorDesc, shotName) {
  await page.goto(BASE + path, { waitUntil: "domcontentloaded" });
  await settle();
  const rows = page.locator(rowLocatorDesc);
  const n = await rows.count();
  const entry = { name, path, file: null, rows: n };
  if (n > 0) {
    await rows.first().click();
    await settle(900);
    entry.file = await shot(shotName);
  }
  return entry;
}

const browser = await chromium.launch();
context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
page = await context.newPage();
const consoleErrors = [];
page.on("pageerror", (e) => consoleErrors.push({ type: "pageerror", text: String(e).slice(0, 300) }));
page.on("console", (m) => {
  if (m.type() === "error") consoleErrors.push({ type: "console", text: m.text().slice(0, 300) });
});

// ---- T1 sign-in (no session) -------------------------------------------
results.push(await visit("t01_signin", "/"));
{
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForTimeout(700);
  const r = results.at(-1);
  r.emptySubmitShot = await shot("t02_signin_empty_submit");
  r.emptySubmitText = (await page.locator("body").innerText()).slice(0, 400);
}

// ---- T3-T8 faculty ------------------------------------------------------
await asRole("FACULTY");
results.push(await visit("t03_faculty_home", "/", { fullPage: true }));
results.push(await visit("t04_faculty_papers", "/papers"));
// wizard: open it, screenshot step 1, advance once, screenshot step 2
{
  await page.goto(BASE + "/papers/new", { waitUntil: "domcontentloaded" });
  await settle();
  const w = { name: "wizard", file1: await shot("t05_wizard_step1") };
  const next = page.getByRole("button", { name: /continue|next/i });
  if ((await next.count()) > 0) {
    await next.first().click();
    await settle(800);
    w.file2 = await shot("t06_wizard_step2");
  }
  results.push(w);
}
{
  await page.goto(BASE + "/papers", { waitUntil: "domcontentloaded" });
  await settle();
  const link = page.locator("a[href^='/papers/']").first();
  if ((await link.count()) > 0) {
    await link.click();
    await settle(1000);
    const r = { name: "paper_detail", file: await shot("t07_paper_detail", { fullPage: true }) };
    r.h1 = (await page.locator("h1").first().textContent().catch(() => null))?.trim() ?? null;
    results.push(r);
  } else {
    results.push({ name: "paper_detail", note: "no paper links found on /papers" });
  }
}
results.push(await visit("t08_faculty_programme", "/programme", { fullPage: true }));
results.push(await visit("t09_faculty_discover", "/discover"));
results.push(await visit("t10_faculty_collaborate", "/collaborate"));
results.push(await visit("t11_faculty_calendar", "/calendar"));

// ---- research cell ------------------------------------------------------
await asRole("RESEARCH_CELL");
results.push(await visit("t12_clearing_queue", "/clearing", { fullPage: true }));
{
  await page.goto(BASE + "/clearing", { waitUntil: "domcontentloaded" });
  await settle();
  const rows = page.locator("tbody tr");
  const n = await rows.count();
  const r = { name: "clearing_review", rows: n, file: null };
  if (n > 0) {
    await rows.first().click();
    await settle(1000);
    r.file = await shot("t13_clearing_review");
  }
  results.push(r);
}
results.push(await visit("t14_requests", "/requests"));

// ---- principal ----------------------------------------------------------
await asRole("PRINCIPAL");
results.push(await visit("t15_principal_home", "/"));
results.push(await visit("t16_principal_approvals", "/approvals", { fullPage: true }));
results.push(await visit("t17_principal_publications", "/publications"));

// ---- director -----------------------------------------------------------
await asRole("DIRECTOR");
results.push(await visit("t18_director_home", "/", { fullPage: true }));
results.push(await visit("t19_director_authorisations", "/authorisations", { fullPage: true }));

// ---- finance ------------------------------------------------------------
await asRole("FINANCE");
results.push(await visit("t20_finance_home", "/"));
results.push(await visit("t21_finance_payments", "/payments"));
results.push(await visit("t22_finance_ledger", "/ledger", { fullPage: true }));
results.push(await visit("t23_finance_budget", "/budget"));

// ---- HOD: money-blindness ------------------------------------------------
await asRole("HOD");
{
  const r = { name: "hod_money_blind", pages: [] };
  for (const [label, path] of [["home", "/"], ["department", "/department"], ["publications", "/publications"], ["people", "/people"]]) {
    await page.goto(BASE + path, { waitUntil: "domcontentloaded" });
    await settle();
    const file = `t24_hod_${label}.png`;
    await shot(file.replace(".png", ""));
    r.pages.push({ path, file: `${OUT}/${file}`, rupeeCount: await page.locator("text=₹").count() });
  }
  results.push(r);
}

// ---- admin ---------------------------------------------------------------
await asRole("SUPER_ADMIN");
for (const [name, path] of [
  ["t25_admin_people", "/people"],
  ["t26_admin_data", "/data"],
  ["t27_admin_policy", "/policy"],
  ["t28_admin_batches", "/batches"],
  ["t29_admin_audit", "/audit"],
]) {
  results.push(await visit(name, path, { fullPage: true }));
}

// ---- search + discussions ------------------------------------------------
await asRole("FACULTY");
results.push(await visit("t30_search", "/search"));
{
  await page.goto(BASE + "/search", { waitUntil: "domcontentloaded" });
  await settle();
  const box = page.getByPlaceholder(/search/i).first();
  if ((await box.count()) > 0) {
    await box.fill("machine learning");
    await page.waitForTimeout(1200);
    const r = results.at(-1);
    r.afterQueryShot = await shot("t31_search_results");
    r.afterQueryText = (await page.locator("main, body").first().innerText()).slice(0, 500);
  }
}
results.push(await visit("t32_discussions", "/discussions"));

// ---- mobile spot checks ---------------------------------------------------
await page.setViewportSize({ width: 375, height: 812 });
for (const [name, path] of [["t33_mobile_faculty_home", "/"], ["t34_mobile_hod", "/department"]]) {
  await asRole(name.includes("hod") ? "HOD" : "FACULTY");
  await page.goto(BASE + path, { waitUntil: "domcontentloaded" });
  await settle();
  await shot(name);
}
await page.setViewportSize({ width: 1280, height: 900 });

await writeFile(`${OUT}/visual_log.json`, JSON.stringify({ results, consoleErrors }, null, 2));
console.log(`done: ${results.length} test points, ${consoleErrors.length} console errors`);
await browser.close();
