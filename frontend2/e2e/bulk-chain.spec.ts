/**
 * The same chain, done to three tickets at once.
 *
 *   filed → bulk clear → bulk approve → bulk authorise → bulk pay
 *
 * `money-chain.spec.ts` follows one ticket through five desks one button at a
 * time. That is not how any of these desks is actually used: the clearing
 * queue is routinely dozens of straightforward tickets, and every screen in
 * the chain grew a select-and-do-it-to-all-of-them bar for exactly that. Those
 * four bars move more money per press than anything else in the product and
 * none of them had a browser test.
 *
 * What makes them worth their own spec rather than a fourth assertion in the
 * single-ticket one is that they are *different code on both sides*. The
 * server endpoints are separate (`/admin/bulk-clear`, `/principal/bulk-approve`,
 * `/director/bulk-approve`, `/admin/bulk-mark-paid`), they loop per ticket in
 * their own transaction, and — this is the part worth testing — they do not
 * take a confirmed figure the way a single transition does. There is no
 * `_guard_recomputed_amount` here. Each endpoint instead compares the stored
 * amount against a fresh recomputation itself and *skips* the row rather than
 * moving it at a figure nobody saw. A batch that silently paid three claims at
 * the wrong number would look exactly like a batch that worked.
 *
 * So the assertion at every step is the endpoint's own report — "cleared 3 of
 * 3", "Paid 3 of 3" — and never "the rows left the queue". A row leaves a
 * queue by being skipped, by being sent back, or by a filter changing under
 * it, and two of those three are failures.
 *
 * Three tickets, not two: a batch of two cannot tell "it did them all" from
 * "it did the first one and stopped", because the count and the index agree.
 */
import { expect, test, type Browser, type Locator, type Page } from "@playwright/test"

import { seedClaim, storageStatePath, type SessionInfo } from "./fixtures/backend"
import { waitForSettled } from "./fixtures/page-health"

/** How many tickets the batch carries. See the note above about two. */
const BATCH = 3

/** `ui/paper.tsx` writes amounts as `₹1,05,000`. Pulled back out of a label. */
const AMOUNT = /₹\s*[\d,]+(?:\.\d+)?/

function amountIn(text: string, where: string): string {
  const match = text.match(AMOUNT)
  expect(match, `${where}: expected an amount in ${JSON.stringify(text)}`).not.toBeNull()
  return match![0].replace(/\s+/g, "")
}

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
 * Press a button and hold until the server has answered.
 *
 * The same reasoning as `confirmAndWait` in `money-chain.spec.ts`, and it
 * matters more here. Every one of these batches opens a *second* dialog on
 * success to report what it did, so the page behind stays `aria-hidden`
 * throughout and `getByRole("row")` reports zero rows the whole time —
 * "the queue is empty" is true and meaningless from the moment the first
 * dialog opens. The only honest signal is the response.
 */
async function pressAndWait(
  page: Page,
  button: Locator,
  endpoint: string,
  where: string
): Promise<unknown> {
  const [response] = await Promise.all([
    page.waitForResponse(
      (r) => r.url().includes(endpoint) && r.request().method() === "POST",
      { timeout: 60_000 }
    ),
    button.click(),
  ])
  expect(
    response.status(),
    `${where}: ${endpoint} answered ${response.status()} — ${await response.text().catch(() => "")}`
  ).toBe(200)
  return response.json().catch(() => null)
}

test.describe("Moving a batch of claims through every desk", () => {
  /** One workflow across five tests: each starts from where the last stopped,
   *  so a failure part-way through leaves the rest nothing to act on. */
  test.describe.configure({ mode: "serial" })

  const seeded: SessionInfo[] = []
  /** The batch total each desk was shown before it pressed, keyed by desk. */
  const totals: Record<string, string> = {}

  test.beforeAll(() => {
    for (let i = 0; i < BATCH; i++) seeded.push(seedClaim())
    // Distinct tickets, or every locator below matches three rows and the
    // whole spec is a lie about which one it acted on.
    const numbers = seeded.map((s) => s.claim!.ticket_number)
    expect(new Set(numbers).size, `seeded duplicate tickets: ${numbers}`).toBe(BATCH)
  })

  /** The rows for this batch, in whichever list the desk draws. */
  function rowsFor(page: Page, as: "row" | "listitem") {
    return seeded.map((s) =>
      as === "row"
        ? page.getByRole("row").filter({ hasText: s.claim!.ticket_number })
        : page.getByRole("listitem").filter({ hasText: s.claim!.ticket_number })
    )
  }

  test("the research cell clears all three in one press", async ({ browser }) => {
    const page = await asRole(browser, "RESEARCH_CELL")
    await page.goto("/clearing")
    await waitForSettled(page)

    // Tick each ticket's own checkbox, through its row rather than by the
    // checkbox's accessible name: the same name is rendered twice, once in
    // the desktop table and once in the `md:hidden` card list beside it.
    for (const row of rowsFor(page, "row")) {
      await expect(row, "a seeded ticket is not in the clearing queue").toHaveCount(1)
      await row.getByRole("checkbox").check()
    }

    // The selection bar is the only thing that says what is about to happen,
    // and it is what the person pressing the button reads.
    const bar = page.getByText(`${BATCH} selected`, { exact: false })
    await expect(bar, "the selection bar did not report three tickets").toBeVisible()

    await page.getByRole("button", { name: `Clear ${BATCH} tickets` }).click()

    const confirm = page.getByRole("button", { name: /^Clear — ₹/ })
    await expect(confirm).toBeEnabled()
    totals.cleared = amountIn(await confirm.innerText(), "bulk clearing")
    // A batch total of nothing would satisfy every count below and mean it.
    expect(totals.cleared, "the batch was about to clear ₹0").not.toBe("₹0")

    const result = (await pressAndWait(page, confirm, "/admin/bulk-clear", "bulk clearing")) as {
      cleared: number
      skipped: { id: string; reason: string }[]
    }
    // The server's own count, before anything on screen is believed.
    expect(
      result.skipped,
      `bulk clear skipped rows: ${JSON.stringify(result.skipped)}`
    ).toEqual([])
    expect(result.cleared).toBe(BATCH)

    // And the report the person is shown says the same thing. These can
    // disagree: the dialog counts `cleared + skipped.length`, so a response
    // the client mis-parsed shows a plausible number here and a wrong one
    // there.
    await expect(
      page.getByRole("heading", { name: `Cleared ${BATCH} of ${BATCH}` })
    ).toBeVisible()
    await page.getByRole("button", { name: "Done" }).click()
    await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 20_000 })

    // Only now, with no dialog holding the page `aria-hidden`, is an empty
    // queue a fact rather than an artefact.
    for (const row of rowsFor(page, "row")) {
      await expect(row, "a cleared ticket is still in the clearing queue").toHaveCount(0, {
        timeout: 30_000,
      })
    }

    await done(page)
  })

  test("the Principal approves all three in one press, at the same total", async ({ browser }) => {
    const page = await asRole(browser, "PRINCIPAL")
    await page.goto("/approvals")
    await waitForSettled(page)

    for (const row of rowsFor(page, "row")) {
      await expect(row, "a cleared ticket did not reach the Principal").toHaveCount(1)
      await row.getByRole("checkbox").check()
    }
    await expect(page.getByText(`${BATCH} selected`, { exact: false })).toBeVisible()

    await page.getByRole("button", { name: `Approve ${BATCH} tickets` }).click()

    const confirm = page.getByRole("button", { name: /^Approve — ₹/ })
    await expect(confirm).toBeEnabled()
    totals.approved = amountIn(await confirm.innerText(), "bulk approval")

    const result = (await pressAndWait(
      page,
      confirm,
      "/principal/bulk-approve",
      "bulk approval"
    )) as { approved: number; skipped: { id: string; reason: string }[] }
    expect(
      result.skipped,
      `bulk approve skipped rows: ${JSON.stringify(result.skipped)}`
    ).toEqual([])
    expect(result.approved).toBe(BATCH)

    await done(page)
  })

  test("the Director authorises all three in one press, at the same total", async ({ browser }) => {
    const page = await asRole(browser, "DIRECTOR")
    await page.goto("/authorisations")
    await waitForSettled(page)

    // This queue is a list, and its rows are `<li>` — there is only one copy
    // of them, so the checkbox can be reached through the row as before.
    for (const row of rowsFor(page, "listitem")) {
      await expect(row, "an approved ticket did not reach the Director").toHaveCount(1)
      await row.getByRole("checkbox").check()
    }
    await expect(page.getByText(`${BATCH} selected`, { exact: false })).toBeVisible()

    await page.getByRole("button", { name: `Authorise ${BATCH}`, exact: true }).click()

    const confirm = page.getByRole("button", { name: /^Authorise ₹/ })
    await expect(confirm).toBeEnabled()
    totals.authorised = amountIn(await confirm.innerText(), "bulk authorisation")

    const result = (await pressAndWait(
      page,
      confirm,
      "/director/bulk-approve",
      "bulk authorisation"
    )) as { approved: number; skipped: { id: string; reason: string }[] }
    expect(
      result.skipped,
      `bulk authorise skipped rows: ${JSON.stringify(result.skipped)}`
    ).toEqual([])
    expect(result.approved).toBe(BATCH)

    await done(page)
  })

  test("Finance pays all three in one press, each against its own voucher", async ({ browser }) => {
    const page = await asRole(browser, "FINANCE")
    await page.goto("/payments")
    await waitForSettled(page)

    for (const row of rowsFor(page, "row")) {
      await expect(row, "an authorised ticket did not reach Finance").toHaveCount(1)
      const box = row.getByRole("checkbox")
      // A ticket that arrives needing a second signature has its box disabled
      // — which is a defect in the chain, not a reason to select three and
      // quietly pay two.
      await expect(box, "Finance cannot select this ticket to pay").toBeEnabled()
      await box.check()
    }
    await expect(page.getByText(`${BATCH} selected`, { exact: false })).toBeVisible()

    await page.getByRole("button", { name: `Pay ${BATCH} claims` }).click()

    // The review table is the point of this dialog: one row per claim, its own
    // voucher box, its own amount. A batch that showed a single total and no
    // rows would be a batch nobody could check before pressing.
    const dialog = page.getByRole("dialog")
    await expect(dialog).toBeVisible()
    for (const s of seeded) {
      await expect(
        dialog.getByText(s.claim!.title),
        "a selected claim is missing from the review table"
      ).toBeVisible()
    }
    const vouchers = dialog.getByPlaceholder("Voucher #")
    await expect(vouchers).toHaveCount(BATCH)
    for (let i = 0; i < BATCH; i++) {
      await vouchers.nth(i).fill(`E2E-BULK-${Date.now()}-${i}`)
    }

    const confirm = dialog.getByRole("button", { name: /^Pay \d+ — ₹/ })
    await expect(confirm).toBeEnabled()
    totals.paid = amountIn(await confirm.innerText(), "bulk payment")

    const result = (await pressAndWait(page, confirm, "/admin/bulk-mark-paid", "bulk payment")) as {
      paid: number
      paid_ids: string[]
      skipped: { id: string; reason: string }[]
    }
    expect(result.skipped, `bulk pay skipped rows: ${JSON.stringify(result.skipped)}`).toEqual([])
    expect(result.paid).toBe(BATCH)
    // Every seeded claim, by id — `paid: 3` is also what paying one claim
    // three times would report.
    for (const s of seeded) {
      expect(result.paid_ids, `${s.claim!.ticket_number} was not in the paid batch`).toContain(
        s.claim!.id
      )
    }

    await done(page)
  })

  test("one total at every desk, and all three claimants are told it is settled", async ({
    browser,
  }) => {
    expect(Object.keys(totals).sort()).toEqual(["approved", "authorised", "cleared", "paid"])
    const distinct = Array.from(new Set(Object.values(totals)))
    expect(
      distinct,
      `the batch total changed between desks: ${JSON.stringify(totals)}`
    ).toHaveLength(1)

    // Finance's paid list, which is the other half of "it left the payable
    // queue" — a row leaves that queue by being sent back just as readily.
    const finance = await asRole(browser, "FINANCE")
    await finance.goto("/payments/done")
    await waitForSettled(finance)
    for (const s of seeded) {
      await expect(
        finance.getByRole("row").filter({ hasText: s.claim!.ticket_number }),
        `${s.claim!.ticket_number} is not on the paid list`
      ).toHaveCount(1)
    }
    await done(finance)

    // And the person who filed each one sees it as settled, which is the only
    // part of any of this that reaches a human outside the finance office.
    const faculty = await asRole(browser, "FACULTY")
    for (const s of seeded) {
      await faculty.goto(`/papers/${s.claim!.id}`)
      await waitForSettled(faculty)
      await expect(faculty.getByText(`Ticket ${s.claim!.ticket_number}`)).toBeVisible()
      await expect(faculty.getByLabel("Step 5 of 5: Paid")).toBeVisible()
    }
    await done(faculty)
  })
})
