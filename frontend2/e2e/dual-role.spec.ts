/**
 * An officer's own paper.
 *
 * The owner's rule: people with office roles "must be able to do both: do
 * their own research as well as track others'". So a Principal who is also an
 * academic files a paper like any claimant, and then it goes through the chain
 * like anybody else's -- handled by every desk except the one they sit at:
 *
 *   the Principal files it → the research cell checks and clears it
 *     → the Principal cannot approve it (not in their queue; refused if asked)
 *     → the super admin approves it in the Principal's place
 *     → the Director authorises it → Finance pays it
 *     → the Principal sees it paid, as a claimant does, with no desk named
 *
 * Where the browser stops, and why
 * --------------------------------
 * The Principal opens the filing wizard and it saves their draft by itself,
 * through the screens. The filing itself is then sent as the request the
 * wizard's own button sends, from the Principal's own signed-in browser --
 * the same seam `rejection.spec.ts` draws, for the same reason: filing through
 * the form means walking ten questions that belong to the wizard's own spec.
 *
 * No Scopus key is configured for this suite, so the paper is filed with a
 * note, as a claimant does when the index cannot confirm it, and the research
 * cell enters its verified values by hand before clearing it -- the manual
 * verification lane, which is the real path for such a paper.
 */
import { expect, test, type Browser, type Page } from "@playwright/test"

import { openSession, storageStatePath, writeStorageState } from "./fixtures/backend"
import { FILEABLE_FIELDS, csrfToken, patchClaim, uploadPdf } from "./fixtures/claim-api"
import { waitForSettled } from "./fixtures/page-health"

/** The names the fixture accounts carry (`e2e_session._account`). */
const OFFICERS = ["E2E Research Cell", "E2E Super Admin", "E2E Director", "E2E Finance"]

async function asRole(browser: Browser, role: string): Promise<Page> {
  const context = await browser.newContext({ storageState: storageStatePath(role) })
  return context.newPage()
}

async function done(page: Page): Promise<void> {
  const context = page.context()
  await page.close()
  await context.close()
}

/** Press a confirm button and wait for the server's verdict. See the long note
 *  on `confirmAndWait` in `money-chain.spec.ts` for why the response, and not
 *  the dialog closing, is what is asserted. */
async function confirmAndWait(
  page: Page,
  confirm: ReturnType<Page["getByRole"]>,
  endpoint: string,
  where: string
): Promise<void> {
  const [response] = await Promise.all([
    page.waitForResponse(
      (r) => r.url().includes(endpoint) && r.request().method() === "POST",
      { timeout: 60_000 }
    ),
    confirm.click(),
  ])
  expect(
    response.status(),
    `${where}: ${endpoint} answered ${response.status()} — ${await response.text().catch(() => "")}`
  ).toBe(200)
  const dialog = page.getByRole("dialog")
  await expect(dialog).toHaveCount(0, { timeout: 5_000 }).catch(async () => {
    await page.keyboard.press("Escape")
  })
  await expect(dialog).toHaveCount(0, { timeout: 20_000 })
}

test.describe("A Principal's own paper", () => {
  test.describe.configure({ mode: "serial" })

  const title = `E2E the Principal's own paper ${Date.now()}`
  let claimId = ""
  let ticket = ""

  test.beforeAll(() => {
    // The global setup signs in six roles; the super admin is the seventh
    // this spec needs, as the one who decides a paper nobody else at its
    // desk may.
    writeStorageState("SUPER_ADMIN", openSession("SUPER_ADMIN"))
  })

  test("the Principal's sidebar and home carry their own research beside the desk", async ({ browser }) => {
    const page = await asRole(browser, "PRINCIPAL")
    await page.goto("/")
    await waitForSettled(page)

    const nav = page.getByRole("navigation", { name: "Main" })
    await expect(nav.getByRole("link", { name: "Approvals" })).toBeVisible()
    await expect(nav.getByText("My research", { exact: true }).first()).toBeVisible()
    await expect(nav.getByRole("link", { name: "My papers" })).toBeVisible()
    await expect(nav.getByRole("link", { name: "File a paper" })).toBeVisible()

    // The office's work first, and a compact "Your papers" after it.
    await expect(page.getByRole("region", { name: "Your papers" })).toBeVisible()

    await done(page)
  })

  test("the Principal files a paper of their own", async ({ browser }) => {
    const page = await asRole(browser, "PRINCIPAL")
    await page.goto("/papers/new")
    await waitForSettled(page)
    await expect(page.getByRole("heading", { name: "File a paper", level: 1 })).toBeVisible()

    for (const box of await page.getByRole("checkbox").all()) await box.check()
    await page.getByRole("button", { name: "Start the claim" }).click()
    await page.getByLabel("Paper title").fill(title)
    // The wizard saves the draft by itself, as the Principal's own.
    await expect(page.getByRole("status").filter({ hasText: /^Saved/ })).toBeVisible({ timeout: 30_000 })
    await expect(page).toHaveURL(/\/papers\/[^/]+\/edit$/)
    claimId = page.url().split("/papers/")[1].split("/")[0]

    // Filed as the wizard's "File this paper" button files it.
    const paper = await uploadPdf(page, "principal-paper.pdf")
    const refs = [await uploadPdf(page, "principal-ref-1.pdf"), await uploadPdf(page, "principal-ref-2.pdf")]
    const res = await patchClaim(page, claimId, {
      ...FILEABLE_FIELDS,
      paper_title: title,
      journal_title: "Journal of Dual Roles",
      publication_type: "Journal",
      total_authors: 1,
      author_position: 1,
      affiliation_ok: true,
      attachments: [
        { kind: "PUBLISHED_PAPER", ...paper },
        ...refs.map((r, i) => ({ kind: "SEC_REFERENCE", ...r, ref_number: String(14 + i) })),
      ],
      submit: true,
      contest_forward: true,
      contest_note: "The index could not confirm this journal; the details are the publisher's.",
    })
    expect(res.status(), `filing answered ${res.status()} — ${await res.text().catch(() => "")}`).toBe(200)
    const filed = (await res.json()) as { status: string; ticket_number: string; owner_id: string }
    expect(filed.status).toBe("SUBMITTED")
    ticket = filed.ticket_number

    // It is in their own papers, at the claimant's stage.
    await page.goto("/papers")
    await waitForSettled(page)
    await page.getByLabel("Search your papers").fill(ticket)
    const row = page.getByRole("row").filter({ hasText: ticket })
    await expect(row).toHaveCount(1)
    await expect(row).toContainText("Under review")

    await done(page)
  })

  test("the research cell verifies it by hand and clears it", async ({ browser }) => {
    const page = await asRole(browser, "RESEARCH_CELL")
    await page.goto("/clearing")
    await waitForSettled(page)

    const row = page.getByRole("row").filter({ hasText: ticket })
    await expect(row, "the Principal's paper is not in the clearing queue").toHaveCount(1)
    await row.getByText(title).click()
    const sheet = page.getByRole("dialog")
    await expect(sheet).toBeVisible()

    await sheet.getByRole("button", { name: "Enter verified values" }).click()
    const verify = page.getByRole("dialog", { name: "Enter verified values" })
    await verify.getByLabel("SNIP").fill("1.2")
    await verify.getByLabel("Where these came from").fill("SNIP 1.2 from the journal's own page, 2026")
    const [saved] = await Promise.all([
      page.waitForResponse((r) => r.url().includes(`/claims/${claimId}/set-verified`) && r.request().method() === "POST"),
      verify.getByRole("button", { name: "Record and recalculate" }).click(),
    ])
    expect(saved.status(), await saved.text().catch(() => "")).toBe(200)
    await expect(verify).toHaveCount(0, { timeout: 20_000 })

    await page.getByRole("dialog").getByRole("button", { name: "Clear", exact: true }).click()
    const confirm = page.getByRole("button", { name: /^Clear — ₹/ })
    await expect(confirm).toBeEnabled({ timeout: 180_000 })
    await confirmAndWait(page, confirm, `/claims/${claimId}/clear`, "clearing")

    await done(page)
  })

  test("the Principal cannot approve their own paper", async ({ browser }) => {
    const page = await asRole(browser, "PRINCIPAL")
    await page.goto("/approvals")
    await waitForSettled(page)

    // Not in their queue, and the page says where it went.
    await expect(page.getByText(/Your own papers are never in this queue/)).toBeVisible()
    await page.getByLabel("Search the queue").fill(ticket)
    await expect(page.getByRole("row").filter({ hasText: ticket })).toHaveCount(0)

    // And asked directly, the server refuses it.
    const res = await page.request.post(`/api/claims/${claimId}/principal-approve`, {
      headers: { "X-CSRFToken": await csrfToken(page) },
      data: { expected_amount: 0 },
    })
    expect(res.status()).toBe(403)
    expect(((await res.json()) as { detail: string }).detail).toMatch(/Your own paper/)

    // On their own paper they are the claimant: a stage, never a desk or a name.
    await page.goto(`/papers/${claimId}`)
    await waitForSettled(page)
    await expect(page.getByLabel("Stage: Under review")).toBeVisible()
    for (const name of OFFICERS) await expect(page.getByText(name)).toHaveCount(0)

    await done(page)
  })

  test("the super admin approves it in the Principal's place", async ({ browser }) => {
    const page = await asRole(browser, "SUPER_ADMIN")
    await page.goto("/approvals")
    await waitForSettled(page)

    await page.getByLabel("Search the queue").fill(ticket)
    const row = page.getByRole("row").filter({ hasText: ticket })
    await expect(row, "the Principal's paper did not reach the super admin").toHaveCount(1)
    await row.getByText(title).click()
    await expect(page.getByRole("dialog")).toBeVisible()
    await page.getByRole("dialog").getByRole("button", { name: "Approve", exact: true }).click()
    const confirm = page.getByRole("button", { name: /^Approve — ₹/ })
    await expect(confirm).toBeEnabled({ timeout: 180_000 })
    await confirmAndWait(page, confirm, `/claims/${claimId}/principal-approve`, "approval")

    await done(page)
  })

  test("the Director authorises it and Finance pays it", async ({ browser }) => {
    const director = await asRole(browser, "DIRECTOR")
    await director.goto("/authorisations")
    await waitForSettled(director)
    const item = director.locator("li").filter({ hasText: ticket })
    await expect(item, "the approved paper did not reach the Director").toHaveCount(1)
    await item.getByRole("button", { name: "Authorise", exact: true }).click()
    const authorise = director.getByRole("button", { name: /^Authorise ₹/ })
    await expect(authorise).toBeEnabled({ timeout: 180_000 })
    await confirmAndWait(director, authorise, `/claims/${claimId}/director-approve`, "authorisation")
    await done(director)

    const finance = await asRole(browser, "FINANCE")
    await finance.goto("/payments")
    await waitForSettled(finance)
    const row = finance.getByRole("row").filter({ hasText: ticket })
    await expect(row, "the authorised paper did not reach Finance").toHaveCount(1)
    await row.getByRole("button", { name: "Pay", exact: true }).click()
    const pay = finance.getByRole("button", { name: /^Pay — ₹/ })
    await expect(pay).toBeEnabled({ timeout: 180_000 })
    await confirmAndWait(finance, pay, `/claims/${claimId}/mark-paid`, "payment")
    await done(finance)
  })

  test("the Principal sees it paid, as any claimant does", async ({ browser }) => {
    const page = await asRole(browser, "PRINCIPAL")
    await page.goto(`/papers/${claimId}`)
    await waitForSettled(page)
    await expect(page.getByText(`Ticket ${ticket}`)).toBeVisible()
    await expect(page.getByLabel("Stage: Paid")).toBeVisible()
    // Handled by four other people, and named by none of them.
    for (const name of OFFICERS) await expect(page.getByText(name)).toHaveCount(0)

    await done(page)
  })
})
