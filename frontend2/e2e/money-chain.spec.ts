/**
 * The money chain, which is the product.
 *
 *   filed → the research cell clears it → the Principal approves the spend
 *         → the Director authorises it → Finance pays
 *
 * Five people, five screens, four decisions, and one number that must be the
 * same at every one of them. The server enforces this — `_guard_recomputed_amount`
 * recomputes the amount from the verified columns before every transition and
 * answers 409 unless the actor confirmed exactly that figure, which is why
 * every confirm button in the app carries the amount in its own label. None of
 * it had a browser test.
 *
 * What this spec asserts, in order:
 *  - the ticket appears in each desk's queue and only that desk's,
 *  - the confirm button at each step names an amount,
 *  - that amount is the same amount at all four steps,
 *  - the ticket ends PAID and the claimant sees it as paid.
 *
 * Where the ticket comes from
 * ---------------------------
 * It is seeded by `manage.py e2e_session --claim` rather than filed through
 * the wizard. Filing verifies the title against Scopus and prices the result
 * from live Scimago data, so a chain spec that filed its own paper would be
 * asserting Elsevier's uptime as much as this application's behaviour — and
 * would price differently on different days, which is the one thing this
 * spec cannot tolerate.
 *
 * The seed writes no amount. It writes the *inputs* — a SNIP, a quartile, an
 * author position, and the two SEC-affiliated references the policy requires
 * — and lets the application's own calculator produce the figure. So the
 * number this spec follows through five screens is arithmetic the product
 * did, not a number a test made up.
 *
 * The filing form itself is exercised by the last test in this file.
 */
import { expect, test, type Browser, type Page } from "@playwright/test"

import { seedClaim, storageStatePath, type SessionInfo } from "./fixtures/backend"
import { waitForSettled } from "./fixtures/page-health"

/** `ui/paper.tsx` writes amounts as `₹1,05,000` — en-IN grouping, paise only
 *  when they are not zero. This pulls one back out of a button label. */
const AMOUNT = /₹\s*[\d,]+(?:\.\d+)?/

function amountIn(text: string, where: string): string {
  const match = text.match(AMOUNT)
  expect(match, `${where}: expected an amount in ${JSON.stringify(text)}`).not.toBeNull()
  // Normalised, because one screen writes "Clear — ₹1,05,000" and another
  // "Authorise ₹1,05,000", and the spaces around the glyph differ.
  return match![0].replace(/\s+/g, "")
}

/** A page already signed in as one role, in its own context. */
async function asRole(browser: Browser, role: string): Promise<Page> {
  const context = await browser.newContext({ storageState: storageStatePath(role) })
  return context.newPage()
}

/** Close the page and the context behind it, so a run does not accumulate
 *  five live browser contexts holding five sessions open. */
async function done(page: Page): Promise<void> {
  const context = page.context()
  await page.close()
  await context.close()
}

/**
 * Press a confirm button and wait for the decision to actually land.
 *
 * This is not belt and braces, it is the assertion. Asserting instead that
 * the row left the queue looks equivalent and is not: every one of these
 * dialogs is a Radix modal, which marks the rest of the page `aria-hidden`
 * while it is open — so `getByRole("row")` reports zero rows the moment the
 * dialog opens, long before anything has been decided. A spec written that
 * way passes instantly, closes the page out from under an in-flight POST,
 * and hands the next desk a ticket that has not moved yet. It cost an
 * afternoon to find, which is exactly the failure this suite exists to make
 * cheap.
 *
 * Waiting on the response also means the *server's* verdict is what is
 * checked. A 409 here is the amount having moved between the screen being
 * drawn and the button being pressed, and it should fail loudly rather than
 * be reported three screens later as an empty queue.
 */
async function confirmAndWait(
  page: Page,
  confirm: ReturnType<Page["getByRole"]>,
  endpoint: string,
  where: string
): Promise<void> {
  const [response] = await Promise.all([
    page.waitForResponse(
      (r) => r.url().includes(endpoint) && r.request().method() === "POST",
      // The clear step re-verifies against Scopus inside its transaction.
      { timeout: 60_000 }
    ),
    confirm.click(),
  ])
  expect(
    response.status(),
    `${where}: ${endpoint} answered ${response.status()} — ${await response.text().catch(() => "")}`
  ).toBe(200)
  // The dialog closes on success. Until it has, the page behind it is still
  // `aria-hidden` and nothing on it can be asserted. The clearing sheet is
  // the exception: with more tickets waiting it moves straight on to the
  // next one, so it is closed here by hand once the decision has landed.
  const dialog = page.getByRole("dialog")
  await expect(dialog).toHaveCount(0, { timeout: 5_000 }).catch(async () => {
    await page.keyboard.press("Escape")
  })
  await expect(dialog).toHaveCount(0, { timeout: 20_000 })
}

test.describe("The money chain", () => {
  /**
   * Serial, and scoped to this block rather than to the file.
   *
   * These five tests are one workflow: each starts from the state the last
   * one left, so a failure part-way through means the rest have nothing to
   * act on and should be skipped rather than run against a ticket that never
   * moved. But `Filing a paper` below is independent, and configuring the
   * whole file serial meant a stumble in the chain silently skipped it too —
   * losing coverage precisely when something had just gone wrong.
   */
  test.describe.configure({ mode: "serial" })

  let seeded: SessionInfo
  /** The amount each desk confirmed, keyed by the desk. Compared at the end
   *  rather than pairwise, so a failure reports the whole picture. */
  const confirmed: Record<string, string> = {}

  test.beforeAll(() => {
    seeded = seedClaim()
  })

  test("the claimant sees their filed paper waiting to be checked", async ({ browser }) => {
    const page = await asRole(browser, "FACULTY")
    await page.goto("/papers")
    await waitForSettled(page)

    await page.getByLabel("Search your papers").fill(seeded.claim!.ticket_number)
    const row = page.getByRole("row").filter({ hasText: seeded.claim!.ticket_number })
    await expect(row).toHaveCount(1)
    // A claimant sees how far it has come, never whose desk it is on: a filed
    // paper is "Under review" from the moment it is filed (core/visibility.py).
    await expect(row).toContainText("Under review")

    await done(page)
  })

  test("the research cell clears it, at a confirmed amount", async ({ browser }) => {
    const page = await asRole(browser, "RESEARCH_CELL")
    await page.goto("/clearing")
    await waitForSettled(page)

    const row = page.getByRole("row").filter({ hasText: seeded.claim!.ticket_number })
    await expect(row, "the seeded ticket is not in the clearing queue").toHaveCount(1)

    // Rows here are not links; the row opens a sheet on click.
    await row.getByText(seeded.claim!.title).click()
    const sheet = page.getByRole("dialog")
    await expect(sheet).toBeVisible()
    await sheet.getByRole("button", { name: "Clear", exact: true }).click()

    // The dialog recalculates against Scopus before it will let anything be
    // confirmed, so the button only carries a figure once that has landed.
    //
    // The timeout is generous because that call is a live third party and its
    // latency is not ours to control. Measured on this step: 5.5s, 5.7s, 7.3s
    // and 9.6s across runs, against two full-suite runs that blew straight
    // through 60s. A tenfold spread on somebody else's API is not a defect in
    // the money chain, and this test exists to prove one amount survives five
    // desks -- not to hold Scopus to a response time. Below 60s it was failing
    // roughly half the time in full-suite runs and passing every time in
    // isolation, which is the worst way for a suite to be wrong: it teaches
    // whoever sees it that a red run means nothing.
    const confirm = page.getByRole("button", { name: /^Clear — ₹/ })
    await expect(confirm).toBeEnabled({ timeout: 180_000 })
    confirmed.cleared = amountIn(await confirm.innerText(), "clearing")

    await confirmAndWait(page, confirm, `/claims/${seeded.claim!.id}/clear`, "clearing")

    // And it leaves this queue, which is the visible half of the same fact.
    await expect(
      page.getByRole("row").filter({ hasText: seeded.claim!.ticket_number })
    ).toHaveCount(0, { timeout: 30_000 })

    await done(page)
  })

  test("the Principal approves the spend, at the same amount", async ({ browser }) => {
    const page = await asRole(browser, "PRINCIPAL")
    await page.goto("/approvals")
    await waitForSettled(page)

    await page.getByLabel("Search the queue").fill(seeded.claim!.ticket_number)
    const row = page.getByRole("row").filter({ hasText: seeded.claim!.ticket_number })
    await expect(row, "the cleared ticket did not reach the Principal").toHaveCount(1)

    await row.getByText(seeded.claim!.title).click()
    const sheet = page.getByRole("dialog")
    await expect(sheet).toBeVisible()
    await sheet.getByRole("button", { name: "Approve", exact: true }).click()

    const confirm = page.getByRole("button", { name: /^Approve — ₹/ })
    // Same live-Scopus exposure as the clearing step above; these ran fast
    // only because that call was already cached by the time they ran.
    await expect(confirm).toBeEnabled({ timeout: 180_000 })
    confirmed.approved = amountIn(await confirm.innerText(), "approval")

    await confirmAndWait(
      page,
      confirm,
      `/claims/${seeded.claim!.id}/principal-approve`,
      "approval"
    )
    await expect(
      page.getByRole("row").filter({ hasText: seeded.claim!.ticket_number })
    ).toHaveCount(0, { timeout: 30_000 })

    await done(page)
  })

  test("the Director authorises it, at the same amount", async ({ browser }) => {
    const page = await asRole(browser, "DIRECTOR")
    await page.goto("/authorisations")
    await waitForSettled(page)

    // This queue is a list, not a table, and the paper title is a link.
    const row = page.locator("li").filter({ hasText: seeded.claim!.ticket_number })
    await expect(row, "the approved ticket did not reach the Director").toHaveCount(1)
    await row.getByRole("button", { name: "Authorise", exact: true }).click()

    const confirm = page.getByRole("button", { name: /^Authorise ₹/ })
    // Same live-Scopus exposure as the clearing step above; these ran fast
    // only because that call was already cached by the time they ran.
    await expect(confirm).toBeEnabled({ timeout: 180_000 })
    confirmed.authorised = amountIn(await confirm.innerText(), "authorisation")

    await confirmAndWait(
      page,
      confirm,
      `/claims/${seeded.claim!.id}/director-approve`,
      "authorisation"
    )
    await expect(
      page.locator("li").filter({ hasText: seeded.claim!.ticket_number })
    ).toHaveCount(0, { timeout: 30_000 })

    await done(page)
  })

  test("Finance pays it, at the same amount", async ({ browser }) => {
    const page = await asRole(browser, "FINANCE")
    await page.goto("/payments")
    await waitForSettled(page)

    const row = page.getByRole("row").filter({ hasText: seeded.claim!.ticket_number })
    await expect(row, "the authorised ticket did not reach Finance").toHaveCount(1)
    // Nothing may block the payment: a ticket needing a second signature
    // arrives here with the button disabled, and that is a defect in the
    // chain, not a reason for this spec to skip.
    const pay = row.getByRole("button", { name: "Pay", exact: true })
    await expect(pay, "Finance cannot pay this ticket").toBeEnabled()
    await pay.click()

    const confirm = page.getByRole("button", { name: /^Pay — ₹/ })
    // Same live-Scopus exposure as the clearing step above; these ran fast
    // only because that call was already cached by the time they ran.
    await expect(confirm).toBeEnabled({ timeout: 180_000 })
    confirmed.paid = amountIn(await confirm.innerText(), "payment")

    await confirmAndWait(page, confirm, `/claims/${seeded.claim!.id}/mark-paid`, "payment")
    await expect(
      page.getByRole("row").filter({ hasText: seeded.claim!.ticket_number })
    ).toHaveCount(0, { timeout: 30_000 })

    // It is on the paid list, with the same figure, which is the other half
    // of "it left the payable queue" — a row can leave a queue by being
    // rejected just as easily as by being paid.
    await page.goto("/payments/done")
    await waitForSettled(page)
    const paidRow = page.getByRole("row").filter({ hasText: seeded.claim!.ticket_number })
    await expect(paidRow).toHaveCount(1)
    await expect(paidRow).toContainText(confirmed.paid.replace("₹", ""))

    await done(page)
  })

  test("one amount was confirmed at every step, and the ticket is paid", async ({ browser }) => {
    // The four figures, compared in one place. Asserting them pairwise as the
    // chain went along would report "the Director's figure differs from the
    // Principal's" and leave you to go and find the other two.
    expect(Object.keys(confirmed).sort()).toEqual(["approved", "authorised", "cleared", "paid"])
    const distinct = Array.from(new Set(Object.values(confirmed)))
    expect(
      distinct,
      `the amount changed between desks: ${JSON.stringify(confirmed)}`
    ).toHaveLength(1)
    // A chain that confirmed ₹0 four times would satisfy everything above and
    // mean nothing.
    expect(distinct[0]).not.toBe("₹0")

    // And the claimant, who started this, is told it is settled.
    const page = await asRole(browser, "FACULTY")
    await page.goto(`/papers/${seeded.claim!.id}`)
    await waitForSettled(page)
    await expect(page.getByText(`Ticket ${seeded.claim!.ticket_number}`)).toBeVisible()
    // The five-step tracker, by its label rather than by the word "Paid" --
    // which this screen writes twice, once as the status and once as the last
    // step, so matching the bare word is ambiguous and was passing only by
    // luck about which of the two rendered first.
    await expect(page.getByLabel("Stage: Paid")).toBeVisible()
    // And the history records it, without naming who paid it.
    await expect(page.getByRole("listitem").filter({ hasText: /^Paid/ }).first()).toBeVisible()

    await done(page)
  })
})

/**
 * The filing form, on its own.
 *
 * The chain above deliberately starts from a seeded ticket, so this covers
 * what that skips: that a claimant can open the wizard, that it saves what
 * they type without being asked, and that the draft is theirs afterwards.
 * It stops short of filing, because filing needs a Scopus-indexed title, a
 * Scimago hit and three uploaded PDFs, and a test that depends on all three
 * fails for reasons that have nothing to do with this application.
 */
test.describe("Filing a paper", () => {
  test.use({ storageState: storageStatePath("FACULTY") })

  test("the wizard opens, saves a draft by itself, and the draft is listed", async ({ page }) => {
    const title = `E2E draft ${Date.now()}`

    await page.goto("/papers/new")
    await waitForSettled(page)
    await expect(page.getByRole("heading", { name: "File a paper", level: 1 })).toBeVisible()

    // The eligibility gate now stands in front of the wizard: three
    // confirmations, each of which is a real reason a filed ticket is sent
    // back, so the form does not exist until all three are ticked. Asserted
    // here rather than clicked past, because "the wizard opens" is what this
    // test is named after and opening it now takes this step.
    await expect(page.getByRole("heading", { name: "Confirm before you start" })).toBeVisible()
    // Pressing on with none of them ticked says which are outstanding and
    // what to do about each — the button is deliberately not disabled, so a
    // claimant who cannot tick one is told where to go instead of being left
    // at an inert control.
    await page.getByRole("button", { name: "Start the claim" }).click()
    await expect(page.getByText(/are not confirmed yet, so the form has not opened/)).toBeVisible()
    await expect(page.getByLabel("Paper title")).toHaveCount(0)

    // `check()` rather than `click()`: clicking a box that is already ticked
    // unticks it, so a click-loop is only correct while every box happens to
    // start clear — and silently unticks one the moment the gate remembers a
    // previous answer or gains a box that defaults to on. `check()` asserts
    // the end state instead of assuming the starting one.
    const gate = page.getByRole("checkbox")
    await expect(gate, "the eligibility gate should ask three things").toHaveCount(3)
    for (const box of await gate.all()) await box.check()

    await page.getByRole("button", { name: "Start the claim" }).click()

    /**
     * The form is open, asserted by the form being there.
     *
     * Not by its step heading, and not by the label on its next-step button.
     * Both were asserted here and both broke inside an afternoon — the step
     * was "The paper" and became "Which paper is this?", the button was
     * "Next" and became "Continue" — while the thing this test is named
     * after, the wizard opening, never stopped working. The field a claimant
     * types their title into is what "the wizard opened" means; the wording
     * around it is a design decision that is allowed to change without a
     * test failing.
     */
    await expect(page.getByLabel("Paper title")).toBeVisible()

    await page.getByLabel("Paper title").fill(title)

    // Autosave runs 2.5s after the last keystroke; the status region says so
    // out loud, which is what a claimant relies on and so is what is asserted.
    await expect(page.getByRole("status").filter({ hasText: /^Saved/ })).toBeVisible({
      timeout: 30_000,
    })

    /**
     * It refuses to move on with two named things missing, and says which.
     *
     * This assertion is older than the flow it runs against: it used to fire
     * on step one of a five-step wizard, where the type and the date sat
     * alongside the title. They now have a screen of their own, two questions
     * further along, because the form asks one thing at a time — so the
     * refusal is asserted where the question is rather than where it used to
     * be. What is being tested has not changed: a form that silently does
     * nothing when you press the button is the commonest way one gets
     * reported "broken", and it must name what it wants instead.
     */
    const carryOn = page.getByRole("button", { name: "Continue", exact: true })

    // Nothing blocks "which paper is this?" — a claimant without a DOI is
    // meant to walk straight past it and answer by hand.
    await carryOn.click()
    await expect(
      page.getByRole("radio", { name: /Faculty publication incentive/ })
    ).toBeVisible()
    await carryOn.click()
    await expect(page.getByLabel("Type of publication")).toBeVisible()

    await carryOn.click()
    await expect(page.getByText("Choose what kind of publication this is.")).toBeVisible()
    await expect(page.getByText("Enter the date it was published.")).toBeVisible()
    // And it stayed where it was.
    await expect(page.getByLabel("Type of publication")).toBeVisible()

    // Answer the two it named and it carries on.
    await page.getByLabel("Type of publication").click()
    await page.getByRole("option", { name: "Journal article" }).click()
    await page.getByLabel("Date published").fill("2026-01-15")
    await carryOn.click()
    await expect(page.getByLabel("Journal title")).toBeVisible()

    // And the draft really exists, on the server, as this account's.
    await page.goto("/papers")
    await waitForSettled(page)
    await page.getByLabel("Search your papers").fill(title)
    const row = page.getByRole("row").filter({ hasText: title })
    await expect(row).toHaveCount(1)
    await expect(row).toContainText("Draft")
  })
})
