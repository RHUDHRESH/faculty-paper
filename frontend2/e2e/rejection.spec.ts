/**
 * The way back.
 *
 *   filed → the research cell sends it back → the claimant is told why
 *         → they edit it → they file it again → it is in the queue again
 *
 * Every other spec in this suite follows a ticket that goes forwards. This is
 * the one that goes back, and it is the path a claimant is most likely to be
 * on: the research cell sends tickets back for a living, and the whole of
 * `_faculty_status_copy`, `stageOf("REJECTED")`, the send-back callout on the
 * paper page, the Edit button that only exists for two statuses, and the
 * re-submit branch in `patch_claim` exist for nobody else.
 *
 * Three things here are worth a test on their own, and none had one:
 *
 *  1. **The reason survives.** The server refuses a send-back under ten
 *     characters precisely because "your claim was rejected" with no reason
 *     is what the old system did. The sentence the research cell types has to
 *     arrive, verbatim, at the top of the claimant's own page — not a
 *     paraphrase, not a status word.
 *  2. **A sent-back ticket is editable.** `canEdit` is `DRAFT || REJECTED`.
 *     Drop `REJECTED` from that expression and the page still explains at
 *     length what to fix and then offers no way to fix it, which is exactly
 *     the state that had people emailing the research cell instead.
 *  3. **Re-filing keeps the ticket.** `assign_ticket_number` returns early
 *     when a number is already set, and `_assign_quota_position` is idempotent
 *     for the same reason. If either stopped being so, a re-filed paper would
 *     get a second ticket number — and, worse, consume a second slot of its
 *     author's research quota, which is what decides whether it is paid at
 *     all. Nothing else in the suite would notice.
 *
 * Where the browser stops, and why
 * --------------------------------
 * Steps 1–5 below are driven through the screens. The re-filing itself is not:
 * it is sent as the request the wizard's own "File this paper" button sends,
 * from the claimant's own signed-in browser context.
 *
 * That is a deliberate line, not a shortcut. Re-filing through the form means
 * walking ten questions — a date, an ISSN, an indexing level, a Yukthi ID, a
 * Scopus profile, a quartile, a SNIP, and a PDF upload — none of which this
 * test is about, all of which belong to the filing wizard, and every one of
 * which is a label that can be reworded by somebody polishing that page. The
 * spec beside this one already records what that costs: two assertions there
 * broke inside an afternoon because a heading and a button changed wording,
 * while the thing being tested never stopped working. A rejection-path test
 * that goes red every time the filing form is edited is a rejection-path test
 * nobody will keep.
 *
 * So the seam is drawn where the claim leaves the claimant's hands, and both
 * sides of it are asserted through the UI: what they were told, that they
 * could act on it, and where the ticket ended up.
 */
import { expect, test, type Browser, type Page } from "@playwright/test"

import { seedClaim, storageStatePath, type SessionInfo } from "./fixtures/backend"
import { FILEABLE_FIELDS, patchClaim, uploadPdf } from "./fixtures/claim-api"
import { waitForSettled } from "./fixtures/page-health"

/** The sentence the research cell types. Asserted verbatim on the claimant's
 *  page, so it is worth it being a sentence and not "test note". */
const REASON =
  "The affiliation on page one reads Saveetha University, not Saveetha Engineering College. Attach the corrected first page."

async function asRole(browser: Browser, role: string): Promise<Page> {
  const context = await browser.newContext({ storageState: storageStatePath(role) })
  return context.newPage()
}

async function done(page: Page): Promise<void> {
  const context = page.context()
  await page.close()
  await context.close()
}

test.describe("A ticket sent back, and filed again", () => {
  test.describe.configure({ mode: "serial" })

  let seeded: SessionInfo

  test.beforeAll(() => {
    seeded = seedClaim()
  })

  test("the research cell sends it back, and has to say why", async ({ browser }) => {
    const page = await asRole(browser, "RESEARCH_CELL")
    await page.goto("/clearing")
    await waitForSettled(page)

    const row = page.getByRole("row").filter({ hasText: seeded.claim!.ticket_number })
    await expect(row, "the seeded ticket is not in the clearing queue").toHaveCount(1)
    await row.getByText(seeded.claim!.title).click()

    const sheet = page.getByRole("dialog")
    await expect(sheet).toBeVisible()
    await sheet.getByRole("button", { name: "Send it back" }).click()

    await expect(page.getByRole("heading", { name: "Send this ticket back?" })).toBeVisible()

    /**
     * The reason is not optional, and the button says so by being unusable.
     *
     * Asserted before the reason is typed rather than after, because this is
     * the guard: the server refuses a note under ten characters, and a screen
     * that let somebody press the button and then showed them a toast has
     * already taken the decision away from them.
     */
    const sendBack = page.getByRole("button", { name: "Send back", exact: true })
    await expect(sendBack, "a ticket can be sent back with no reason").toBeDisabled()
    await page.getByLabel("Reason").fill("too short")
    await expect(page.getByText("At least 10 characters.")).toBeVisible()
    await expect(sendBack, "a nine-character reason was accepted").toBeDisabled()

    await page.getByLabel("Reason").fill(REASON)
    await expect(sendBack).toBeEnabled()

    // The server's verdict, not the dialog closing. See the long note in
    // `money-chain.spec.ts`: while any dialog is open the page behind it is
    // `aria-hidden`, so "the row left the queue" is true and meaningless from
    // the moment this was clicked.
    const [response] = await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes(`/claims/${seeded.claim!.id}/reject`) && r.request().method() === "POST",
        { timeout: 60_000 }
      ),
      sendBack.click(),
    ])
    expect(
      response.status(),
      `send back answered ${response.status()} — ${await response.text().catch(() => "")}`
    ).toBe(200)

    await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 20_000 })
    await expect(
      page.getByRole("row").filter({ hasText: seeded.claim!.ticket_number }),
      "a ticket that was sent back is still in the clearing queue"
    ).toHaveCount(0, { timeout: 30_000 })

    await done(page)
  })

  test("the claimant is told what to fix, in the words it was written in", async ({ browser }) => {
    const page = await asRole(browser, "FACULTY")
    await page.goto(`/papers/${seeded.claim!.id}`)
    await waitForSettled(page)

    /**
     * The callout, above everything including the back link — and the reason
     * asserted *inside it*, not merely somewhere on the page.
     *
     * The distinction is the test. This page writes the same sentence twice:
     * once here, and once further down in the history as "… sent it back —
     * <reason>". A bare `getByText(REASON)` is therefore satisfied by the
     * history line alone, which means it would go on passing with the callout
     * deleted — and the callout is the whole point, because the history is
     * eight items down a page the claimant has to scroll to reach.
     *
     * `Callout` is a plain `<div>` with its title in a `<p>`, so the callout
     * is reached as that paragraph's parent.
     */
    const callout = page.getByText("Sent back — what to fix").locator("..")
    await expect(callout, "the sent-back callout is not on the page").toBeVisible()
    await expect(
      callout,
      "the callout does not carry the reason the research cell wrote"
    ).toContainText(REASON)
    // Who said it and when, so it is a person's decision rather than the
    // system's.
    await expect(callout).toContainText("E2E Research Cell")

    // And again in the history, which is the durable record of it.
    await expect(page.getByText(`sent it back — ${REASON}`)).toBeVisible()

    // And the tracker agrees, in the claimant's own vocabulary.
    await expect(page.getByText("Sent back", { exact: true }).first()).toBeVisible()
    await expect(page.getByText("Edit the details and file it again.")).toBeVisible()

    // The list says the same thing, because that is the screen they land on.
    await page.goto("/papers")
    await waitForSettled(page)
    await page.getByLabel("Search your papers").fill(seeded.claim!.ticket_number)
    const row = page.getByRole("row").filter({ hasText: seeded.claim!.ticket_number })
    await expect(row).toHaveCount(1)
    await expect(row).toContainText("Sent back")

    await done(page)
  })

  test("and can actually act on it — the edit form opens on their ticket", async ({ browser }) => {
    const page = await asRole(browser, "FACULTY")
    await page.goto(`/papers/${seeded.claim!.id}`)
    await waitForSettled(page)

    // The button whose absence is the whole defect: a page that explains what
    // to fix and offers no way to fix it.
    const edit = page.getByRole("link", { name: "Edit" })
    await expect(edit, "a sent-back ticket offers its owner no way to edit it").toBeVisible()
    await edit.click()

    await expect(page).toHaveURL(new RegExp(`/papers/${seeded.claim!.id}/edit$`))
    await waitForSettled(page)

    // No eligibility gate on the way back in — the three confirmations belong
    // to starting a claim, and making somebody re-tick them to correct a typo
    // is how a correction gets abandoned.
    await expect(
      page.getByRole("heading", { name: "Confirm before you start" }),
      "the eligibility gate stands in front of an edit"
    ).toHaveCount(0)

    // It opened on *their* ticket, not on a blank form. The page title carries
    // the ticket number, which is the one thing on this screen that could not
    // be there by accident.
    await expect(
      page.getByRole("heading", { name: `Edit ticket ${seeded.claim!.ticket_number}`, level: 1 })
    ).toBeVisible()

    await done(page)
  })

  test("re-filing keeps the same ticket, and puts it back in the queue", async ({ browser }) => {
    const faculty = await asRole(browser, "FACULTY")
    await faculty.goto(`/papers/${seeded.claim!.id}/edit`)
    await waitForSettled(faculty)

    /**
     * The request the "File this paper" button makes, from the claimant's own
     * session. See the note at the top of this file for why this half is not
     * driven through the ten questions of the wizard.
     *
     * The fields below are the ones `_check_mandatory_fields` names and the
     * seeded ticket does not carry — a fixture is a ticket in the queue, not a
     * ticket somebody filled a form in for. `contest_forward` is not a way
     * round a check: this college has no Scopus key configured in test, so
     * `verify_publication` reports "could not be auto-confirmed" for every
     * title, and sending with a note is the path the application itself offers
     * a claimant in exactly that situation.
     */
    /**
     * The evidence, attached the way a claimant correcting a ticket attaches
     * it — uploaded, then named on the claim.
     *
     * The seeded fixture's own references cannot simply be re-sent. It writes
     * them straight into the database at `/media/e2e/reference-1.pdf`, and the
     * claim API only accepts an attachment URL matching
     * `^claims/[0-9a-f]{32}\.[a-z0-9]{2,5}$` — the shape `POST /claims/upload`
     * hands back. So a fixture ticket is fileable through the queues but not
     * through the form, and re-filing one means uploading real files first.
     * That is closer to the truth of this step anyway: the ticket was sent
     * back *because of* its evidence.
     *
     * The whole set goes in one payload because `_persist_attachments`
     * replaces it wholesale whenever the key is present — sending only the
     * published paper would delete both references and turn a re-file into a
     * different refusal.
     */
    const paper = await uploadPdf(faculty, "corrected-published-paper.pdf")
    const refOne = await uploadPdf(faculty, "sec-reference-1.pdf")
    const refTwo = await uploadPdf(faculty, "sec-reference-2.pdf")

    const response = await patchClaim(faculty, seeded.claim!.id, {
      ...FILEABLE_FIELDS,
      attachments: [
        {
          kind: "PUBLISHED_PAPER",
          url: paper.url,
          filename: paper.filename,
          size_bytes: paper.size_bytes,
        },
        // Numbered, because a reference with no number is priced as though it
        // were not attached — which is the subject of `policy-refusal.spec.ts`
        // and must not be what this test is quietly exercising.
        {
          kind: "SEC_REFERENCE",
          url: refOne.url,
          filename: refOne.filename,
          size_bytes: refOne.size_bytes,
          ref_number: "1",
          ref_title: "First cited SEC reference",
        },
        {
          kind: "SEC_REFERENCE",
          url: refTwo.url,
          filename: refTwo.filename,
          size_bytes: refTwo.size_bytes,
          ref_number: "2",
          ref_title: "Second cited SEC reference",
        },
      ],
      submit: true,
      contest_forward: true,
      contest_note: "Corrected first page attached, affiliation now reads Saveetha Engineering College.",
    })
    expect(
      response.status(),
      `re-filing answered ${response.status()} — ${await response.text().catch(() => "")}`
    ).toBe(200)

    const refiled = (await response.json()) as { status: string; ticket_number: string }
    expect(refiled.status, "a re-filed ticket did not go back to SUBMITTED").toBe("SUBMITTED")
    /**
     * The same ticket, not a second one.
     *
     * `assign_ticket_number` returns early when a number is already set. If it
     * stopped doing so, a paper sent back once would come back wearing a new
     * number — the claimant's emails, the research cell's notes and the audit
     * trail would all point at a ticket that no longer exists, and the earlier
     * number would be an orphan in the ledger.
     */
    expect(
      refiled.ticket_number,
      "re-filing minted a new ticket number for the same paper"
    ).toBe(seeded.claim!.ticket_number)

    // The claimant's own screens say it is travelling again.
    await faculty.goto(`/papers/${seeded.claim!.id}`)
    await waitForSettled(faculty)
    // The tracker is back on the road at step one. Its accessible name is
    // `Step <n> of 5: <label>`, and the label is the claimant's word for the
    // status ("Awaiting check"), not the step's name ("Filed") — a sent-back
    // ticket has no step at all and draws no track, so this locator existing
    // is itself the assertion that it is travelling again.
    await expect(faculty.getByLabel("Step 1 of 5: Awaiting check")).toBeVisible()
    await expect(faculty.getByText("With the research cell.")).toBeVisible()
    // And the sent-back callout is gone, because it no longer describes
    // anything the claimant has to do.
    await expect(
      faculty.getByText("Sent back — what to fix"),
      "the ticket is filed again and still shows the send-back callout"
    ).toHaveCount(0)
    await done(faculty)

    // The other end of the round trip: it is back on the research cell's desk,
    // under the number it left with.
    const cell = await asRole(browser, "RESEARCH_CELL")
    await cell.goto("/clearing")
    await waitForSettled(cell)
    await expect(
      cell.getByRole("row").filter({ hasText: seeded.claim!.ticket_number }),
      "a re-filed ticket did not come back to the clearing queue"
    ).toHaveCount(1, { timeout: 30_000 })
    await done(cell)
  })
})
