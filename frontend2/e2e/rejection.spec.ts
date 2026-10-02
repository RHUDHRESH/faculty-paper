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
import { openFromQueue } from "./fixtures/review"
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

    const row = page.locator("[data-claim]").filter({ hasText: seeded.claim!.ticket_number })
    await expect(row, "the seeded ticket is not in the clearing queue").toHaveCount(1)
    const review = await openFromQueue(page, row, "clearing")
    await review.getByRole("button", { name: "Send back" }).click()

    await expect(page.getByRole("heading", { name: /Send this (claim|ticket) back\?/ })).toBeVisible()

    /**
     * The reason is not optional, and the button says so by being unusable.
     *
     * Asserted before the reason is typed rather than after, because this is
     * the guard: the server refuses a note under ten characters, and a screen
     * that let somebody press the button and then showed them a toast has
     * already taken the decision away from them.
     */
    const sendBack = page.getByRole("dialog").getByRole("button", { name: "Send back", exact: true })
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

    // After a send-back the sheet moves on to the next ticket in the queue
    // (or closes when there is none); either way this ticket's sheet is gone.
    await expect(
      page.getByRole("dialog").filter({ hasText: seeded.claim!.ticket_number })
    ).toHaveCount(0, { timeout: 20_000 })
    await page.keyboard.press("Escape")
    await expect(
      page.locator("[data-claim]").filter({ hasText: seeded.claim!.ticket_number }),
      "a ticket that was sent back is still in the clearing queue"
    ).toHaveCount(0, { timeout: 30_000 })

    await done(page)
  })

  test("the claimant is told what to fix, in the words it was written in", async ({ browser }) => {
    const page = await asRole(browser, "FACULTY")
    await page.goto(`/papers/${seeded.claim!.id}`)
    await waitForSettled(page)

    /**
     * The fix view ("Sent back: what to fix", docs/ux/21 section E), above
     * everything else on the page -- and the reason asserted *inside it*, not
     * merely somewhere on the page.
     *
     * The distinction is the test. This page writes the same sentence twice:
     * once here, as the item the claimant has to put right, and once further
     * down in the history. A bare `getByText(REASON)` is therefore satisfied
     * by the history line alone, which means it would go on passing with the
     * fix view deleted -- and the fix view is the whole point, because the
     * history is a long way down a page the claimant has to scroll to reach.
     *
     * A send-back with no marks is split into items; this reason is one
     * sentence-pair, so it is one item, word for word. The note as written
     * sits one click away under "Read the college's note as it was written".
     */
    await expect(
      page.getByRole("heading", { name: "Sent back: what to fix" }),
      "the fix view is not on the page"
    ).toBeVisible()
    await expect(
      page.getByRole("listitem").filter({ hasText: "Fix this" }).filter({ hasText: REASON }),
      "the fix view does not carry the reason the research cell wrote"
    ).toHaveCount(1)
    await page.getByText("Read the college's note as it was written").click()
    await expect(page.getByText(REASON, { exact: true })).toHaveCount(1)
    // Never who said it: a claimant does not learn which desk or person holds
    // their paper (core/visibility.py). The reason is theirs; the name is not.
    await expect(page.locator("main")).not.toContainText("E2E Research Cell")

    // And again in the history, which is the durable record of it, written as
    // the college and not as a person.
    await expect(page.getByText("The college sent it back")).toBeVisible()
    await expect(page.getByText(`“${REASON}”`)).toBeVisible()

    // And the tracker agrees, in the claimant's own vocabulary.
    await expect(page.getByLabel("Stage: Sent back")).toBeVisible()
    await expect(page.getByRole("link", { name: "Fix and resend" })).toBeVisible()

    // The list says the same thing, because that is the screen they land on.
    await page.goto("/papers/claims")
    await waitForSettled(page)
    await page.getByLabel("Search your claims").fill(seeded.claim!.ticket_number)
    const row = page.getByRole("listitem").filter({ hasText: seeded.claim!.ticket_number })
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
    const edit = page.getByRole("link", { name: "Fix and resend" })
    await expect(edit, "a sent-back ticket offers its owner no way to edit it").toBeVisible()
    await edit.click()

    await expect(page).toHaveURL(new RegExp(`/papers/${seeded.claim!.id}/edit$`))
    await waitForSettled(page)

    // docs/ux/04: ticks are never remembered, so a reopened ticket with no
    // acknowledgement on record for its article shows the three conditions
    // again, unticked, about *this* article by name — then the form.
    await expect(
      page.getByRole("heading", { name: "Confirm three things about this paper", level: 1 })
    ).toBeVisible()
    await expect(page.getByText(seeded.claim!.title).first()).toBeVisible()
    const gate = page.getByRole("checkbox")
    await expect(gate).toHaveCount(3)
    for (const box of await gate.all()) await expect(box).not.toBeChecked()
    for (const box of await gate.all()) await box.check()
    await page.getByRole("button", { name: "Start the claim" }).click()

    // It opened on *their* ticket, not on a blank form. The page title carries
    // the ticket number, which is the one thing on this screen that could not
    // be there by accident.
    await expect(
      page.getByRole("heading", { name: `Edit claim ${seeded.claim!.ticket_number}`, level: 1 })
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

    const refiled = (await response.json()) as { faculty_stage?: string; status?: string; ticket_number: string }
    expect(refiled.faculty_stage, "a re-filed ticket did not go back to the college").toBe("Under review")
    expect(refiled.status, "the claimant was shown the desk status of their own paper").toBeUndefined()
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
    // The journey is back on the road at its first stage, named for the
    // claimant ("Stage: Being checked"). It never says whose desk it is on --
    // the college's rule -- so the old desk sentence must be gone.
    await expect(faculty.getByLabel("Stage: Being checked")).toBeVisible()
    await expect(faculty.getByText("Being checked by the college.")).toHaveCount(0)
    // And the sent-back callout is gone, because it no longer describes
    // anything the claimant has to do.
    await expect(
      faculty.getByText("Sent back: what to fix"),
      "the ticket is filed again and still shows the send-back callout"
    ).toHaveCount(0)
    await done(faculty)

    // The other end of the round trip: it is back on the research cell's desk,
    // under the number it left with.
    const cell = await asRole(browser, "RESEARCH_CELL")
    await cell.goto("/clearing")
    await waitForSettled(cell)
    await expect(
      cell.locator("[data-claim]").filter({ hasText: seeded.claim!.ticket_number }),
      "a re-filed ticket did not come back to the clearing queue"
    ).toHaveCount(1, { timeout: 30_000 })
    await done(cell)
  })
})
