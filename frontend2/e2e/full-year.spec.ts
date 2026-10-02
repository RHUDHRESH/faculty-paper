/**
 * One academic year at the college, with real clicks, end to end.
 *
 * Built on `manage.py e2e_year` (see that file for the cast). Serial: each
 * step starts where the last one left the database.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"

import { expect, test, type Page } from "@playwright/test"

import { csrfToken, textPdf } from "./fixtures/claim-api"
import { openFromQueue } from "./fixtures/review"
import { as, close, manage, seedYear, type Year } from "./fixtures/year"

const OUT = "e2e/.artifacts/year"

/** Leave the page's accessibility tree behind, for whoever reads a failure. */
async function snap(page: Page, name: string): Promise<void> {
  mkdirSync(OUT, { recursive: true })
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true }).catch(() => {})
  writeFileSync(`${OUT}/${name}.txt`, await page.locator("body").ariaSnapshot().catch(() => ""))
}

type PaperRef = { title: string; doi: string }
const pdf = (name: string, lines: string[]) => ({ name, mimeType: "application/pdf", buffer: textPdf(lines) })

/** Steps 2-4 of the wizard: the three conditions, the details, the proof, file. */
async function confirmDetailsAndFile(page: Page, paper: PaperRef, tag: string): Promise<string> {
  const boxes = page.getByRole("checkbox", { name: "I confirm this is true for this article" })
  await expect(boxes).toHaveCount(3)
  for (const box of await boxes.all()) await box.check()
  await page.getByRole("button", { name: "Start the claim" }).click()
  await expect(page.getByRole("heading", { name: "Add the details", level: 1 })).toBeVisible()
  // The form opens on the first section that still needs the person
  // (docs/ux/25 option C): a paper pulled from Scopus or looked up by DOI
  // arrives with "The paper" complete, so it opens on a later one. Walk the
  // sections from wherever it opens, doing what each asks.
  const section = page.getByRole("heading", { level: 2, name: /^(The paper|The journal|You and the claim|The proof|Check and file)$/ })
  for (let guard = 0; guard < 6; guard++) {
    const name = (await section.first().innerText()).trim()
    if (name === "Check and file") break
    if (name === "The paper") {
      const type = page.getByRole("button", { name: "Type of publication" })
      if ((await type.innerText()).includes("Select")) {
        await type.click()
        await page.getByRole("option", { name: "Journal article" }).click()
      }
    } else if (name === "The journal") {
      await page.getByRole("checkbox", { name: "Scopus" }).check()
      await page.getByRole("textbox", { name: "Yukthi ID" }).fill("NA")
      // Pulled or looked up, the quartile and SNIP come from the college's journal
      // tables; by hand, the claimant asks Scimago.
      const scimago = page.getByRole("button", { name: "Look up the quartile in Scimago" })
      if (await scimago.isVisible()) {
        await scimago.click()
        await expect(page.getByText(/Scimago has this as Q\d/)).toBeVisible()
      }
      await expect(page.getByRole("button", { name: "Quartile", exact: true })).toHaveText(/Q\d/)
      await snap(page, `${tag}-journal`)
    } else if (name === "You and the claim") {
      await page.getByRole("checkbox", { name: /the article names Saveetha Engineering College/ }).check()
    } else if (name === "The proof") {
      await attachProof(page, paper, tag)
    }
    await page.getByRole("button", { name: "Continue" }).click()
    await expect(section.first(), `the form did not move on from "${name}"`).not.toHaveText(name)
  }
  return fileIt(page, tag)
}

async function attachProof(page: Page, paper: PaperRef, tag: string): Promise<void> {
  let chooser = page.waitForEvent("filechooser")
  await page.getByRole("button", { name: /Choose a file|Replace or add a file/ }).click()
  await (await chooser).setFiles(pdf(`paper-${tag}.pdf`, [paper.title, `doi ${paper.doi}`, "Saveetha Engineering College"]))
  chooser = page.waitForEvent("filechooser")
  await page.getByRole("button", { name: /Choose files|Add more files/ }).click()
  await (await chooser).setFiles([
    pdf(`ref-a-${tag}.pdf`, ["A cited SEC paper", "Saveetha Engineering College", `${tag}-a-${Date.now()}`]),
    pdf(`ref-b-${tag}.pdf`, ["Another cited SEC paper", "Saveetha Engineering College", `${tag}-b-${Date.now()}`]),
  ])
  await page.getByRole("textbox", { name: `Reference number for ref-a-${tag}.pdf` }).fill("12")
  await page.getByRole("textbox", { name: `Reference number for ref-b-${tag}.pdf` }).fill("17")
}

/** Step 5, Check and file: the note Scopus-less filing asks for, then File it. */
async function fileIt(page: Page, tag: string): Promise<string> {
  await expect(page.getByRole("heading", { name: "Check and file", level: 2 })).toBeVisible()
  await page
    .getByRole("textbox", { name: "A note for the checkers" })
    .fill("Indexed in Scopus; the DOI resolves and the paper names the college.")
  await page.getByRole("button", { name: "File this paper" }).click()
  await page.getByRole("dialog", { name: "File this paper?" }).getByRole("button", { name: "File it" }).click()
  await expect(page.getByRole("heading", { name: /Filed/ })).toBeVisible()
  await snap(page, `${tag}-filed`)
  const ticket = (await page.locator("main").innerText()).match(/[A-Z]{2,4}-\d{4}-\d{3,}/)
  expect(ticket, "no ticket number after filing").not.toBeNull()
  return ticket![0]
}

async function fileFromRecord(page: Page, paper: PaperRef, tag: string): Promise<string> {
  await page.goto("/papers/new")
  await page.getByRole("radio", { name: new RegExp(paper.title) }).click()
  await page.getByRole("button", { name: "Continue" }).click()
  return confirmDetailsAndFile(page, paper, tag)
}

async function fileByDoi(page: Page, paper: PaperRef, tag: string): Promise<string> {
  await page.goto("/papers/new")
  // Filing the first paper left no second draft of it behind.
  await expect(page.getByText("You have a draft already started")).toHaveCount(0)
  await page.getByRole("radio", { name: /Paste a DOI or link/ }).click()
  await page.getByRole("textbox", { name: "Paste the DOI or link" }).fill(paper.doi)
  await page.getByRole("button", { name: "Find it" }).click()
  const found = page.getByRole("region", { name: "Found it" })
  await expect(found).toContainText(paper.title)
  await expect(found).toContainText("Saveetha Engineering College is printed on the paper")
  await page.getByRole("button", { name: "Continue" }).click()
  return confirmDetailsAndFile(page, paper, tag)
}

const FYP_TITLE = "Edge vision attendance for large classrooms"
const SEND_BACK_REASON = "The author position or the number of authors does not match the paper."
const FLAG_NOTE = "Co-author 3 has the same name as a student; check the author list."

/** The month the payments are made in is the month the suite runs in, as the
 *  statement names it ("October 2026"). It used to be written out as
 *  September, which turned this spec red on the first of the next month. */
const MONTH = new Date().toLocaleDateString("en-GB", { month: "long", year: "numeric" })

/** `₹1,19,200` as written on a button, spaces dropped. */
function amountIn(text: string): string {
  const m = text.match(/₹\s*[\d,]+(?:\.\d+)?/)
  expect(m, `no amount in ${JSON.stringify(text)}`).not.toBeNull()
  return m![0].replace(/\s+/g, "")
}

/** Click something that downloads, and read what arrived. */
async function download(page: Page, click: () => Promise<unknown>): Promise<{ name: string; text: string; size: number }> {
  const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 20_000 }), click()])
  const file = await dl.path()
  const buf = readFileSync(file!)
  return { name: dl.suggestedFilename(), text: buf.toString("latin1"), size: buf.length }
}

/** Figures read off one page, to compare against the next. */
const money: Record<string, string> = {}

/** Ticket numbers as they were issued, by paper key. */
const tickets: Record<string, string> = {}

test.describe("A year at the college", () => {
  test.describe.configure({ mode: "serial" })
  test.setTimeout(240_000)

  let year: Year

  test.beforeAll(() => {
    year = seedYear()
  })

  test.afterEach(async ({}, info) => {
    if (info.status !== info.expectedStatus) info.annotations.push({ type: "snap", description: OUT })
  })

  test("Anand files a paper pulled from his Scopus record", async ({ browser }) => {
    const page = await as(browser, "anand")
    tickets.anand_scopus = await fileFromRecord(page, year.papers.anand_scopus, "01")
    await close(page)
  })

  test("Anand files a second paper by pasting its DOI", async ({ browser }) => {
    const page = await as(browser, "anand")
    tickets.anand_doi = await fileByDoi(page, year.doi_paper, "02")
    await close(page)
  })

  test("Anand files the paper in the watch-listed journal", async ({ browser }) => {
    const page = await as(browser, "anand")
    tickets.anand_watched = await fileFromRecord(page, year.papers.anand_watched, "03")
    await close(page)
  })

  test("Revathi, research faculty with a quota of 2, files three papers", async ({ browser }) => {
    const page = await as(browser, "revathi")
    tickets.revathi_1 = await fileFromRecord(page, year.papers.revathi_1, "04a")
    tickets.revathi_2 = await fileFromRecord(page, year.papers.revathi_2, "04b")
    tickets.revathi_3 = await fileFromRecord(page, year.papers.revathi_3, "04c")
    await close(page)
  })

  test("the research cell sends one paper back with a reason", async ({ browser }) => {
    const page = await as(browser, "cell")
    await page.goto("/clearing")
    const row = page.locator("[data-claim]").filter({ hasText: tickets.anand_doi })
    await expect(row).toHaveCount(1)
    const review = await openFromQueue(page, row, "clearing")
    await review.getByRole("button", { name: "Send back" }).click()
    const ask = page.getByRole("dialog", { name: /Send this (claim|ticket) back\?/ })
    await ask.getByRole("textbox", { name: "Reason" }).fill(SEND_BACK_REASON)
    await Promise.all([
      page.waitForResponse((r) => /\/return|\/reject|send-back/.test(r.url()) && r.request().method() === "POST" && r.ok()),
      ask.getByRole("button", { name: "Send back" }).click(),
    ])
    await page.keyboard.press("Escape")
    await expect(page.locator("[data-claim]").filter({ hasText: tickets.anand_doi })).toHaveCount(0)
    await close(page)
  })

  test("Anand reads the reason, fixes the paper and refiles it", async ({ browser }) => {
    const page = await as(browser, "anand")
    await page.goto("/papers/claims")
    const row = page.getByRole("listitem").filter({ hasText: tickets.anand_doi })
    await expect(row).toHaveCount(1)
    await snap(page, "05b-claims")
    await row.getByRole("link").first().click()
    // The fix view lists the reason as the item to put right.
    await expect(page.getByRole("listitem").filter({ hasText: "Fix this" }).filter({ hasText: SEND_BACK_REASON })).toHaveCount(1)
    await page.getByRole("link", { name: "Fix and resend" }).click()
    const boxes = page.getByRole("checkbox", { name: "I confirm this is true for this article" })
    await expect(boxes).toHaveCount(3)
    for (const box of await boxes.all()) await box.check()
    await page.getByRole("button", { name: /Start the claim|Continue/ }).first().click()
    await expect(page.getByRole("heading", { name: `Edit claim ${tickets.anand_doi}` })).toBeVisible()
    const heading = page.getByRole("heading", { name: "Check and file", level: 2 })
    for (let i = 0; i < 6 && !(await heading.isVisible()); i++) {
      await page.getByRole("button", { name: "Continue" }).click()
      await page.waitForTimeout(400)
    }
    await expect(heading).toBeVisible()
    await page
      .getByRole("textbox", { name: "A note for the checkers" })
      .fill("Checked against the published PDF: two authors, I am the first.")
    await page.getByRole("button", { name: /File this paper|File it again|Resend/ }).first().click()
    await page.getByRole("dialog").getByRole("button", { name: /File it|Resend/ }).click()
    await expect(page.getByRole("heading", { name: /Filed/ })).toBeVisible()
    await expect(page.locator("main")).toContainText(tickets.anand_doi)
    await snap(page, "05e-refiled")
    await close(page)
  })

  test("the research cell clears the refiled paper on its own", async ({ browser }) => {
    const page = await as(browser, "cell")
    await page.goto("/clearing")
    const row = page.locator("[data-claim]").filter({ hasText: tickets.anand_doi })
    const review = await openFromQueue(page, row, "clearing")
    // The claimant's own note travels with the refiled claim into its history.
    // (Its place is the History tab since the review was redesigned.)
    await review.getByRole("tab", { name: /^History/ }).click()
    await expect(review.getByText(/Checked against the published PDF/).first()).toBeVisible()
    await review.getByRole("tab", { name: /^Check/ }).click()
    await review.getByRole("button", { name: "Clear", exact: true }).click()
    const confirm = page.getByRole("button", { name: /^Clear ₹/ })
    await expect(confirm).toBeEnabled()
    money.cleared_doi = amountIn(await confirm.innerText())
    await Promise.all([
      page.waitForResponse((r) => r.url().includes(`/clear`) && r.request().method() === "POST" && r.ok()),
      confirm.click(),
    ])
    await close(page)
  })

  test("the research cell raises a flag on one paper", async ({ browser }) => {
    const page = await as(browser, "cell")
    await page.goto("/clearing")
    const row = page.locator("[data-claim]").filter({ hasText: tickets.anand_scopus })
    const review = await openFromQueue(page, row, "clearing")
    await review.getByRole("button", { name: /Raise a flag|^Flag$/ }).first().click()
    const ask = page.getByRole("dialog", { name: "Raise a flag" })
    await ask.getByRole("radio", { name: /^Author/ }).check()
    await ask.getByRole("textbox", { name: "What looks wrong" }).fill(FLAG_NOTE)
    await Promise.all([
      page.waitForResponse((r) => r.url().includes("flag") && r.request().method() === "POST" && r.ok()),
      ask.getByRole("button", { name: "Raise it" }).click(),
    ])
    // The panel's four tabs (docs/ux/26): the flags sit with the past cases.
    await page.getByRole("tab", { name: "Past cases" }).click()
    await expect(page.getByRole("region", { name: /^Flags/ })).toContainText(FLAG_NOTE)
    await close(page)
  })

  test("the research cell clears the rest in one batch, skipping the watched journal", async ({ browser }) => {
    const page = await as(browser, "cell")
    await page.goto("/clearing")
    const watched = page.locator("[data-claim]").filter({ hasText: tickets.anand_watched })
    await expect(watched).toContainText("Watched journal")
    // The four straightforward papers of the year, ticked by claim number.
    // Not "Select all": the research cell's queue is shared with every other
    // spec in the suite, and whatever they left waiting there is not this
    // scenario's to clear.
    for (const key of ["anand_scopus", "revathi_1", "revathi_2", "revathi_3"]) {
      await page.locator("[data-claim]").filter({ hasText: tickets[key] }).getByRole("checkbox").check()
    }
    await expect(watched.getByRole("checkbox")).not.toBeChecked()
    await snap(page, "07-bulk")
    const go = page.getByRole("button", { name: /^Clear \d+ claims?$/ })
    await go.click()
    const ask = page.getByRole("dialog", { name: /^Clear \d+ claims\?$/ })
    // Anand 74,500 + Revathi's first two inside her quota (0 + 0) + her third 44,700.
    await expect(ask).toContainText("Clear 4 claims?")
    const confirm = ask.getByRole("button", { name: /^Clear \d+ for ₹/ })
    money.cleared_batch = amountIn(await confirm.innerText())
    await Promise.all([
      page.waitForResponse((r) => r.url().includes("/admin/bulk-clear") && r.ok()),
      confirm.click(),
    ])
    await expect(page.getByRole("status").filter({ hasText: /4 claims, .*sent to the Principal/ })).toBeVisible()
    await expect(page.locator("[data-claim]").filter({ hasText: tickets.anand_scopus })).toHaveCount(0)
    await expect(watched).toHaveCount(1)
    await close(page)
  })

  test("the Principal sees the flag and approves, then approves the rest", async ({ browser }) => {
    const page = await as(browser, "principal")
    await page.goto("/approvals")
    const flagged = page.locator("[data-claim]").filter({ hasText: tickets.anand_scopus })
    // A flagged claim is in the "Needs a look" lane and its row offers Review,
    // not Approve (docs/ux/27): the Principal reads the flag first.
    await expect(flagged).toContainText("Open flag")
    await expect(flagged).toContainText("₹74,500")
    await expect(flagged.getByRole("button", { name: /^Approve/ })).toHaveCount(0)
    // The research cell's doubts are the Principal's to weigh, in the
    // full-page review, which carries the decision bar.
    await openFromQueue(page, flagged, "approvals")
    await page.getByRole("tab", { name: "Past cases" }).click()
    await expect(page.getByText(FLAG_NOTE).first()).toBeVisible()
    await page.getByRole("button", { name: /^Approve ₹/ }).first().click()
    const ask = page.getByRole("dialog", { name: "Approve this claim?" })
    const confirm = ask.getByRole("button", { name: /^Approve ₹/ })
    expect(amountIn(await confirm.innerText())).toBe("₹74,500")
    await Promise.all([
      page.waitForResponse((r) => r.url().endsWith("/principal-approve") && r.ok()),
      confirm.click(),
    ])
    await expect(page.getByRole("dialog")).toHaveCount(0)
    // After a decision the workspace opens the next claim; back to the list.
    await page.goto("/approvals")
    await expect(flagged).toHaveCount(0)
    // The rest in one go.
    await page.getByRole("checkbox", { name: /^Choose all 4 in ready to approve/ }).check()
    // Revathi's two inside her quota at ₹0, her third at ₹44,700, Anand's refiled one at ₹57,600.
    await expect(page.getByText("4 chosen · ₹1,02,300")).toBeVisible()
    await page.getByRole("button", { name: "Approve 4 claims" }).click()
    const bulk = page.getByRole("dialog")
    const go = bulk.getByRole("button", { name: /₹/ })
    expect(amountIn(await go.innerText())).toBe("₹1,02,300")
    await Promise.all([
      page.waitForResponse((r) => r.request().method() === "POST" && /approve/.test(r.url()) && r.ok()),
      go.click(),
    ])
    await page.waitForTimeout(1000)
    await snap(page, "08-bulk-done")
    await close(page)
  })

  test("the Director authorises the month's batch within budget, and never sees a flag", async ({ browser }) => {
    const page = await as(browser, "director")
    await page.goto("/authorisations")
    const list = page.getByRole("region", { name: "Approved claims" })
    // Five claims, each a row of the list.
    await expect(list.locator("[data-claim]")).toHaveCount(5)
    // 74,500 + 57,600 + 0 + 0 + 44,700
    await expect(page.getByText("₹1,76,800").first()).toBeVisible()
    // Money-desk rule: flags are for the research side, never for the Director.
    await expect(page.locator("main")).not.toContainText(/flag/i)
    await expect(page.locator("main")).not.toContainText(FLAG_NOTE)
    const left = page.getByRole("img", { name: /^Budget:/ })
    // ₹50,00,000 less these five claims. Exact, because `e2e_year --reset`
    // clears what the other specs paid out of the same year before this runs.
    await expect(left).toHaveAccessibleName(/₹48,23,200 left of/)
    await page.getByRole("checkbox", { name: "Choose every ready claim" }).check()
    await expect(page.getByText("5 chosen · ₹1,76,800")).toBeVisible()
    await page.getByRole("button", { name: "Authorise 5 chosen" }).click()
    const ask = page.getByRole("dialog", { name: "Authorise 5 claims?" })
    await expect(ask).toContainText("across 5 claims")
    await expect(ask).toContainText("₹1,76,800")
    await Promise.all([
      page.waitForResponse((r) => r.url().includes("/director/bulk-approve") && r.ok()),
      ask.getByRole("button", { name: "Authorise ₹1,76,800" }).click(),
    ])
    await expect(list).toContainText("Nothing is waiting for your signature")
    await close(page)
  })

  test("Finance pays the month and downloads the bank file, never seeing a flag", async ({ browser }) => {
    const page = await as(browser, "finance")
    await page.goto("/payments")
    await expect(page.getByRole("heading", { name: "Ready to pay (5)" })).toBeVisible()
    await expect(page.getByText("₹1,76,800", { exact: true }).first()).toBeVisible()
    await expect(page.locator("main")).not.toContainText(/flag/i)
    await page.getByRole("checkbox", { name: /Select all \d+ ready claims/ }).check()
    await expect(page.getByText("5 selected · ₹1,76,800")).toBeVisible()
    await page.getByRole("button", { name: "Pay 5 claims" }).click()
    const ask = page.getByRole("dialog", { name: "Pay 5 claims?" })
    await expect(ask).toContainText("₹1,76,800")
    await ask.getByRole("button", { name: /Show voucher numbering/ }).click()
    await ask.getByRole("button", { name: "Number the empty ones" }).click()
    await expect(ask.getByRole("textbox", { name: /Voucher number for/ }).first()).toHaveValue(/PV-2026-/)
    await Promise.all([
      page.waitForResponse((r) => r.url().includes("bulk-mark-paid") && r.ok()),
      ask.getByRole("button", { name: "Pay 5 claims, ₹1,76,800" }).click(),
    ])
    // The result says what to do next: the month bank file, one tap away.
    // The dialog is now the result ("Paid 5 of 5"), no longer "Pay 5 claims?".
    const result = page.getByRole("dialog", { name: "Paid 5 of 5" })
    const list = await download(page, () => result.getByRole("button", { name: "Bank file (CSV)" }).click())
    expect(list.text).toContain("Anand Kumar")
    await result.getByRole("button", { name: "Close" }).last().click()
    await page.goto("/statements")
    const statement = page.getByRole("region", { name: `Statement for ${MONTH}` })
    await expect(statement).toContainText("₹1,76,800")
    // The ledger reconciliation sits behind a disclosure now; opened, it must agree.
    await page.getByRole("button", { name: "Show how this agrees with the ledger" }).click()
    await expect(page.getByText("Agrees with this statement")).toBeVisible()
    // The first file was recorded when it was made. A second one for the same
    // month is how a month is paid twice, so the button now asks before it
    // downloads (docs/ops/safeguards.md, "Bank file generated twice"): nothing
    // new to send, so the only way on is the whole month again, with a reason.
    await statement.getByRole("button", { name: "Bank file (CSV)" }).click()
    const again = page.getByRole("dialog", { name: "This month's bank file was already made" })
    await expect(again).toContainText("Nothing has been paid since")
    await expect(again.getByRole("button", { name: "No new payments" })).toBeDisabled()
    await again.getByRole("button", { name: "The whole month again" }).click()
    const why = again.getByRole("textbox")
    await why.fill("short")
    await expect(again.getByRole("button", { name: "Download the whole month again" })).toBeDisabled()
    await why.fill("E2E: the first file never reached the bank")
    const bank = await download(page, () => again.getByRole("button", { name: "Download the whole month again" }).click())
    writeFileSync(`${OUT}/bank.csv`, bank.text)
    expect(bank.text).toContain("Anand Kumar")
    expect(bank.text).toContain("74500")
    await close(page)
  })

  test("the Director downloads the signed statement for the month", async ({ browser }) => {
    const page = await as(browser, "director")
    await page.goto("/statements")
    const statement = page.getByRole("region", { name: `Statement for ${MONTH}` })
    await expect(statement).toContainText("₹1,76,800")
    const pdf = await download(page, () => statement.getByRole("link", { name: "Statement to sign (PDF)" }).click())
    expect(pdf.text.startsWith("%PDF")).toBe(true)
    await close(page)
  })

  test("Anand sees Paid, downloads his payment statement and appraisal list, and never the desk", async ({ browser }) => {
    const page = await as(browser, "anand")
    await page.goto("/papers/claims")
    for (const [key, amount] of [["anand_scopus", "₹74,500"], ["anand_doi", "₹57,600"]] as const) {
      const row = page.getByRole("listitem").filter({ hasText: tickets[key] })
      // A paid claim sits under "Paid" as one line: the month the money went out, and the amount.
      await expect(page.getByRole("region", { name: "Paid" }).getByRole("listitem").filter({ hasText: tickets[key] })).toHaveCount(1)
      await expect(row).toContainText(MONTH)
      await expect(row).toContainText(amount)
    }
    await expect(
      page.getByRole("listitem").filter({ hasText: tickets.anand_watched }).getByRole("list", { name: "Progress: Being checked" })
    ).toBeVisible()
    // The research cell's flag and the desk's names are not the claimant's to see.
    await page.getByRole("listitem").filter({ hasText: tickets.anand_scopus }).getByRole("link").first().click()
    await expect(page.getByRole("heading", { level: 1 })).toContainText(year.papers.anand_scopus.title)
    await expect(page.locator("main")).not.toContainText(FLAG_NOTE)
    await expect(page.locator("main")).not.toContainText("Cell Officer")

    await page.goto("/papers/statement")
    await expect(page.getByRole("row", { name: /^Total.*₹1,32,100$/ })).toBeVisible()
    const sheet = await download(page, () => page.getByRole("link", { name: "Spreadsheet" }).click())
    expect(sheet.text).toContain(year.papers.anand_scopus.title)
    expect(sheet.text).toMatch(/74,?500/)
    money.anand_statement = "₹1,32,100"

    await page.goto("/papers/appraisal")
    const list = await download(page, () => page.getByRole("button", { name: "Spreadsheet" }).click())
    expect(list.size).toBeGreaterThan(0)
    expect(list.name).toMatch(/\.(csv|xlsx)$/)

    // Faculty never see the desk.
    await page.goto("/clearing")
    await expect(page.getByRole("heading", { name: "Clearing queue" })).toHaveCount(0)
    await expect(page.locator("body")).not.toContainText(tickets.revathi_3)
    await close(page)
  })

  test("Revathi's statement shows the one paper paid beyond her quota", async ({ browser }) => {
    const page = await as(browser, "revathi")
    await page.goto("/papers/statement")
    await expect(page.getByRole("row", { name: /^Total.*₹44,700$/ })).toBeVisible()
    await expect(page.getByRole("row").filter({ hasText: year.papers.revathi_3.title })).toHaveCount(1)
    await expect(page.getByRole("row").filter({ hasText: year.papers.revathi_1.title })).toHaveCount(0)
    await close(page)
  })

  test("the same month agrees on the ledger, the statement, Reports and the year brief", async ({ browser }) => {
    let page = await as(browser, "finance")
    await page.goto("/ledger")
    const totals = page.getByRole("region", { name: "The answer" })
    await expect(totals).toContainText("₹1,76,800")
    await expect(totals).toContainText("across 3 payments")
    await expect(totals).toContainText(/2\s*People paid/)
    // Each payment once.
    for (const key of ["anand_scopus", "anand_doi", "revathi_3"]) {
      await expect(
        page.getByRole("table", { name: "Payments matching the filter" }).getByRole("row").filter({ hasText: year.papers[key]?.title ?? year.doi_paper.title })
      ).toHaveCount(1)
    }
    await page.goto("/statements")
    const month = page.getByRole("region", { name: `Statement for ${MONTH}` })
    await expect(month).toContainText("3 payments to 2 people")
    await close(page)

    page = await as(browser, "principal")
    await page.goto("/reports")
    const paid = page.getByRole("button", { name: /^Paid ₹1,76,800/ })
    await expect(paid).toContainText("3 payments")
    // Every paper in the scenario is from 2026, so "all years" is 2026 here.
    const papers = (await page.getByRole("button", { name: /^Papers \d+/ }).innerText()).match(/\d+/)![0]
    await page.goto("/reports/brief")
    await page.getByRole("button", { name: "Year" }).click()
    await page.getByRole("option", { name: "2026" }).click()
    await expect(page.locator("main")).toContainText("It paid ₹1,76,800 in incentives in FY 2026-27")
    await expect(page.locator("main")).toContainText("₹1,76,800")
    await expect(page.locator("main")).toContainText(`the college has published ${papers} papers`)
    const pdf = await download(page, () => page.getByRole("link", { name: "Download the council pack" }).click())
    expect(pdf.text.startsWith("%PDF")).toBe(true)
    const xlsx = await download(page, () => page.getByRole("link", { name: /Excel.*NAAC 3.3.1/ }).click())
    expect(xlsx.text.startsWith("PK")).toBe(true)
    await close(page)
  })

  test("the ERP repeats a payment; the sweep finds it and the research cell decides it", async ({ browser }) => {
    manage(["e2e_year", "--erp-repeat"])
    manage(["find_duplicate_payments"])
    const page = await as(browser, "cell")
    await page.goto("/duplicates")
    const item = page.getByRole("button", { name: new RegExp(`Anand Kumar ${year.papers.anand_scopus.title}`) })
    await expect(item).toContainText("2 payments")
    await expect(page.getByText("Aug 2026").first()).toBeVisible()
    await page.getByRole("button", { name: "Confirm duplicate" }).click()
    const ask = page.getByRole("dialog", { name: "Confirm this is a duplicate?" })
    await expect(ask).toContainText("₹74,500 becomes money to recover")
    await ask.getByRole("textbox", { name: "What shows it is a duplicate?" }).fill(
      "The ERP sheet records the August payment of FP-2026-000001 that this app made in September."
    )
    await Promise.all([
      page.waitForResponse((r) => r.url().includes("/admin/duplicate-findings/") && r.request().method() === "POST" && r.ok()),
      ask.getByRole("button", { name: "Confirm duplicate" }).click(),
    ])
    await page.getByRole("button", { name: /^History/ }).click()
    await expect(page.getByRole("button", { name: new RegExp(year.papers.anand_scopus.title) })).toBeVisible()
    await close(page)
  })

  test("Director and Finance never see the duplicate finding", async ({ browser }) => {
    for (const who of ["director", "finance"] as const) {
      const page = await as(browser, who)
      await page.goto("/ledger")
      await expect(page.getByRole("region", { name: "The answer" })).toContainText("₹1,76,800")
      await expect(page.locator("main")).not.toContainText(/duplicate/i)
      await close(page)
    }
  })

  test("the HOD sees pace without money, reminds Meena and pairs Anand with Revathi", async ({ browser }) => {
    const page = await as(browser, "hod")
    await page.goto("/department")
    // The page opens with one sentence a head can say to the Principal.
    await expect(page.getByTestId("report-answer")).toBeVisible()
    await expect(page.locator("main")).not.toContainText("₹")
    await page.getByRole("button", { name: /^Remind Meena/ }).click()
    // The reminder is a draft the head edits first, then sends.
    await page.getByRole("dialog", { name: "Send a reminder" }).getByRole("button", { name: "Send reminder" }).click()
    await expect(page.getByRole("button", { name: /Meena Krishnan was reminded/ })).toBeVisible()
    await page.getByRole("button", { name: "Targets and work" }).click()
    await page.getByRole("button", { name: "Assign work" }).click()
    const ask = page.getByRole("dialog", { name: "Assign work" })
    await ask.getByRole("radio", { name: "Pair co-authors" }).check()
    await ask.getByRole("textbox", { name: "What they should write together" }).fill(
      "A joint paper on federated vision for campus energy"
    )
    await ask.getByRole("button", { name: "First author" }).click()
    await page.getByRole("option", { name: /Anand Kumar/ }).click()
    await ask.getByRole("button", { name: "Co-author" }).click()
    await page.getByRole("option", { name: /Revathi Sundaram/ }).click()
    await Promise.all([
      page.waitForResponse((r) => r.request().method() === "POST" && /assign/.test(r.url()) && r.ok()),
      ask.getByRole("button", { name: "Assign" }).click(),
    ])
    await expect(page.getByRole("region", { name: "Work assigned" })).toContainText("federated vision for campus energy")
    await close(page)
  })

  test("Anand finds the pairing on his home screen", async ({ browser }) => {
    const page = await as(browser, "anand")
    await page.goto("/")
    await expect(page.getByText(/federated vision for campus energy/).first()).toBeVisible()
    await close(page)
  })

  test("the super admin changes the policy with the preview, and finds it in the audit log", async ({ browser }) => {
    const page = await as(browser, "admin")
    await page.goto("/policy")
    await page.getByRole("button", { name: "Publish a new version" }).click()
    const ask = page.getByRole("dialog", { name: "Publish a new policy version" })
    await ask.getByRole("textbox", { name: "Name" }).fill("Policy 2026-27")
    await ask.getByRole("spinbutton", { name: "Q4" }).fill("8000")
    // The preview prices a Q4 paper from the numbers in the form, before anything is saved.
    await ask.getByRole("radio", { name: "Q4" }).check()
    await expect(ask.getByText("+ ₹8,000")).toBeVisible()
    await ask.getByRole("textbox", { name: "Notes" }).fill("Q4 incentive raised to 8,000 from April 2027 by council resolution.")
    await ask.getByRole("button", { name: "Publish…" }).click()
    const confirm = page.getByRole("dialog", { name: "Make v2 the active policy?" })
    // The one unpaid Q4 claim, the watch-listed one still with the research cell.
    await expect(confirm.getByRole("region", { name: "What this changes" })).toContainText(tickets.anand_watched)
    await expect(confirm).toContainText("₹17,400 to ₹18,000")
    await confirm.getByRole("textbox", { name: "Type v2 to confirm" }).fill("v2")
    await Promise.all([
      page.waitForResponse((r) => r.request().method() === "PUT" && r.url().endsWith("/admin/formula") && r.ok()),
      confirm.getByRole("button", { name: "Publish v2" }).click(),
    ])
    await expect(page.getByText("Policy 2026-27").first()).toBeVisible()
    await page.goto("/audit")
    const first = page.getByRole("table").getByRole("row").nth(1)
    // The log is in plain words and names the person, not their address.
    await expect(first).toContainText(year.people.admin.name)
    await expect(first).toContainText(/published a new policy/i)
    await close(page)
  })

  test("Anand files his final-year team's conference paper at the team rate", async ({ browser }) => {
    const page = await as(browser, "anand")
    await page.goto("/papers/new")
    await page.getByRole("button", { name: /Type it in by hand/ }).click()
    const boxes = page.getByRole("checkbox", { name: "I confirm this is true for this article" })
    for (const box of await boxes.all()) await box.check()
    await page.getByRole("button", { name: "Start the claim" }).click()
    await page.getByRole("radio", { name: /Final-year project conference incentive/ }).check()
    await page.getByRole("radio", { name: new RegExp(year.team.code) }).check()
    await page.getByRole("textbox", { name: "Paper title" }).fill(FYP_TITLE)
    await page.getByRole("button", { name: "Type of publication" }).click()
    await page.getByRole("option", { name: "Conference proceeding" }).click()
    await page.getByRole("textbox", { name: "Date published" }).fill("2026-08-20")
    await page.getByRole("button", { name: "Continue" }).click()
    await expect(page.getByRole("region", { name: "Incentive estimate" }).filter({ visible: true }).first()).toContainText("₹15,000")
    await page.getByRole("textbox", { name: "Journal title" }).fill("International Conference on Smart Campus Systems")
    await page.getByRole("checkbox", { name: "Scopus" }).check()
    await page.getByRole("textbox", { name: "Yukthi ID" }).fill("NA")
    await page.getByRole("textbox", { name: "ISSN" }).fill("2345-6744")
    await page.getByRole("button", { name: "Continue" }).click()
    await expect(page.getByRole("heading", { name: "You and the claim", level: 2 })).toBeVisible()
    await snap(page, "q-fyp-5")
    await page.getByRole("checkbox", { name: /the article names Saveetha Engineering College/ }).check()
    await page.getByRole("button", { name: "Continue" }).click()
    await expect(page.getByRole("heading", { name: "The proof", level: 2 })).toBeVisible()
    await attachProof(page, { title: FYP_TITLE, doi: "" }, "fyp")
    await page.getByRole("button", { name: "Continue" }).click()
    tickets.fyp = await fileIt(page, "fyp")
    await expect(page.locator("main")).toContainText("₹15,000")
    // One claim per team: the team is now shown with the ticket that holds it.
    await page.goto("/papers/new")
    await page.getByRole("button", { name: /Type it in by hand/ }).click()
    for (const box of await page.getByRole("checkbox", { name: "I confirm this is true for this article" }).all()) {
      await box.check()
    }
    await page.getByRole("button", { name: "Start the claim" }).click()
    await page.getByRole("radio", { name: /Final-year project conference incentive/ }).check()
    await expect(page.getByRole("radio", { name: new RegExp(year.team.code) })).toBeDisabled()
    await expect(page.getByText(tickets.fyp).first()).toBeVisible()
    await close(page)
  })

  test("the scheme is for the mentor only: Meena mentors no team", async ({ browser }) => {
    const page = await as(browser, "meena")
    await page.goto("/papers/new")
    await page.getByRole("button", { name: /Type it in by hand/ }).click()
    for (const box of await page.getByRole("checkbox", { name: "I confirm this is true for this article" }).all()) {
      await box.check()
    }
    await page.getByRole("button", { name: "Start the claim" }).click()
    await expect(page.getByRole("radio", { name: /Final-year project conference incentive/ })).toBeDisabled()
    await close(page)
  })

  test("the final-year claim goes through every desk and is paid at ₹15,000", async ({ browser }) => {
    let page = await as(browser, "cell")
    await page.goto("/clearing")
    const row = page.locator("[data-claim]").filter({ hasText: tickets.fyp })
    await expect(row).toContainText("₹15,000")
    const review = await openFromQueue(page, row, "clearing")
    await review.getByRole("button", { name: "Clear", exact: true }).click()
    const clear = page.getByRole("button", { name: /^Clear ₹/ })
    await expect(clear).toBeEnabled()
    expect(amountIn(await clear.innerText())).toBe("₹15,000")
    await Promise.all([
      page.waitForResponse((r) => r.url().endsWith("/clear") && r.ok()),
      clear.click(),
    ])
    await close(page)

    page = await as(browser, "principal")
    await page.goto("/approvals")
    const prow = page.locator("[data-claim]").filter({ hasText: tickets.fyp })
    await expect(prow).toContainText("₹15,000")
    await prow.getByRole("button", { name: /^Approve/ }).click()
    await Promise.all([
      page.waitForResponse((r) => r.url().endsWith("/principal-approve") && r.ok()),
      page.getByRole("dialog", { name: "Approve this claim?" }).getByRole("button", { name: "Approve ₹15,000" }).click(),
    ])
    await close(page)

    page = await as(browser, "director")
    await page.goto("/authorisations")
    await page.getByRole("checkbox", { name: "Choose every ready claim" }).check()
    await page.getByRole("button", { name: "Authorise 1 chosen" }).click()
    await Promise.all([
      page.waitForResponse((r) => r.url().includes("/director/bulk-approve") && r.ok()),
      page.getByRole("dialog").getByRole("button", { name: "Authorise ₹15,000" }).click(),
    ])
    await close(page)

    page = await as(browser, "finance")
    await page.goto("/payments")
    await page.getByRole("checkbox", { name: /Select all \d+ ready claims/ }).check()
    await page.getByRole("button", { name: "Pay 1 claim" }).click()
    const pay = page.getByRole("dialog")
    await pay.getByRole("button", { name: /Show voucher numbering/ }).click()
    await pay.getByRole("button", { name: "Number the empty ones" }).click()
    await Promise.all([
      page.waitForResponse((r) => r.url().includes("bulk-mark-paid") && r.ok()),
      pay.getByRole("button", { name: "Pay 1 claim, ₹15,000" }).click(),
    ])
    await page.goto("/ledger")
    const totals = page.getByRole("region", { name: "The answer" })
    await expect(totals).toContainText("₹1,91,800")
    await expect(totals).toContainText("across 4 payments")
    await expect(totals).toContainText(/2\s*People paid/)
    await close(page)

    page = await as(browser, "anand")
    await page.goto("/papers/statement")
    await expect(page.getByRole("row", { name: /^Total.*₹1,47,100$/ })).toBeVisible()
    await close(page)
  })

  test("nobody acts on their own claim: the research cell files its own paper", async ({ browser }) => {
    const page = await as(browser, "cell")
    tickets.cell_own = await fileFromRecord(page, year.papers.cell_own, "own")
    await page.goto("/clearing")
    await expect(page.getByRole("heading", { name: "Clearing queue" })).toBeVisible()
    await expect(page.locator("[data-claim]").filter({ hasText: tickets.cell_own })).toHaveCount(0)
    // And the server refuses it even if asked directly.
    const mine = await page.request.get(`/api/claims?limit=50`)
    const claim = ((await mine.json()).results ?? (await mine.json())).find(
      (c: { ticket_number: string }) => c.ticket_number === tickets.cell_own
    )
    const res = await page.request.post(`/api/claims/${claim.id}/clear`, {
      headers: { "X-CSRFToken": await csrfToken(page) },
      data: { expected_amount: 1 },
    })
    expect([400, 403]).toContain(res.status())
    expect(await res.text()).toMatch(/own/i)
    await close(page)
  })

  test("the year's pages at desk and phone widths", async ({ browser }) => {
    mkdirSync(OUT, { recursive: true })
    for (const [who, url, name] of [
      ["anand", "/papers/claims", "faculty-claims"],
      ["anand", "/papers/statement", "faculty-statement"],
      ["finance", "/statements", "finance-statements"],
      ["principal", "/reports/brief", "principal-brief"],
    ] as const) {
      for (const width of [1280, 390]) {
        const page = await as(browser, who, { width, height: 900 })
        await page.goto(url)
        await expect(page.getByRole("heading", { level: 1 })).toBeVisible()
        await page.waitForTimeout(1500)
        await page.screenshot({ path: `${OUT}/${width}-${name}.png`, fullPage: true })
        // Nothing wider than the screen at phone width.
        if (width === 390) {
          const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
          expect(overflow, `${url} scrolls sideways at 390px`).toBeLessThanOrEqual(1)
        }
        await close(page)
      }
    }
  })
})
