/**
 * The claim that used to file for nothing.
 *
 * The policy pays the incentive on a number of cited references carrying a
 * Saveetha Engineering College affiliation, and `_apply_calc` counts exactly
 * one thing towards it: a `SEC_REFERENCE` attachment that carries the number
 * that citation has in the paper's own reference list. A file with no number
 * is priced as though it were never attached.
 *
 * The submission gate used to count something else. It was satisfied by a
 * typed `sec_refs` string, or by any single reference URL — neither of which
 * the formula can see. So a claim could pass every check, be ticketed,
 * travel five desks, and be worked out as ₹0 with a note saying it cited no
 * references, while the form the claimant filled in said it cited three. The
 * first anybody heard of it was a payment of nothing, weeks later, with no
 * screen anywhere explaining which of the two counts was the real one.
 *
 * Submission now refuses it instead, at the one moment it is still cheap to
 * fix — and the refusal is not a validation grunt. It has to say how many were
 * counted, what to attach, where the number comes from, what would otherwise
 * happen to the money, and what to do if there genuinely are no more to cite.
 * All five are asserted, because a refusal a claimant cannot act on sends them
 * to the research cell, which is the outcome the old behaviour already had.
 *
 * The positive control is not optional
 * ------------------------------------
 * Most of this file asserts that something is refused. A suite of nothing but
 * refusals passes perfectly against an application that refuses *everything*,
 * which is a likelier regression than any of them — it is one over-tightened
 * condition away. So one test files the same claim, with the same evidence and
 * one thing changed, and requires it through for a real amount. Without it the
 * refusals are worth very little.
 *
 * The last test in this file is expected to be red. It is documented where it
 * stands, and it is not a flake.
 */
import { expect, test, type Browser, type Page } from "@playwright/test"

import { seedClaim, storageStatePath, type SessionInfo } from "./fixtures/backend"
import { FILEABLE_FIELDS, getClaim, patchClaim, uploadPdf, type Uploaded } from "./fixtures/claim-api"
import { waitForSettled } from "./fixtures/page-health"

/** What the live policy asks for. Seeded fixtures and the code default agree
 *  on two; the refusal quotes whatever `FormulaConfig` actually holds, so the
 *  assertions below read the number out of the message rather than assuming
 *  it, and only the shape of the sentence is fixed here. */
const NEEDED = 2

async function asRole(browser: Browser, role: string): Promise<Page> {
  const context = await browser.newContext({ storageState: storageStatePath(role) })
  return context.newPage()
}

async function done(page: Page): Promise<void> {
  const context = page.context()
  await page.close()
  await context.close()
}

/** The claim, with the evidence described and a submission attempted — the
 *  request the wizard's "File this paper" button sends. */
async function fileWith(
  page: Page,
  claimId: string,
  refs: { file: Uploaded; number: string | null }[],
  paper: Uploaded,
  extra: Record<string, unknown> = {}
) {
  return patchClaim(page, claimId, {
    ...FILEABLE_FIELDS,
    attachments: [
      {
        kind: "PUBLISHED_PAPER",
        url: paper.url,
        filename: paper.filename,
        size_bytes: paper.size_bytes,
      },
      ...refs.map((r, i) => ({
        kind: "SEC_REFERENCE",
        url: r.file.url,
        filename: r.file.filename,
        size_bytes: r.file.size_bytes,
        ref_number: r.number,
        ref_title: `Cited SEC reference ${i + 1}`,
      })),
    ],
    submit: true,
    // No Scopus key is configured in test, so every title comes back "could
    // not be auto-confirmed" and the application's own answer to that is to
    // send it with a note. This is that note — it is not a way past the
    // reference rule, which is checked before verification is even attempted.
    contest_forward: true,
    contest_note: "Indexed under a slightly different title; the DOI on the PDF matches.",
    ...extra,
  })
}

test.describe("A claim whose cited references carry no numbers", () => {
  test.describe.configure({ mode: "serial" })

  let claimA: SessionInfo
  let faculty: Page
  let paper: Uploaded
  let refOne: Uploaded
  let refTwo: Uploaded

  test.beforeAll(async ({ browser }) => {
    claimA = seedClaim()

    /**
     * The claim has to be editable before it can be re-filed, and a seeded
     * ticket arrives already SUBMITTED. So the research cell sends it back
     * first — through the API, because `rejection.spec.ts` is what tests that
     * it can be done through the screens, and a fixture arranged twice is a
     * fixture that breaks twice.
     */
    const cell = await asRole(browser, "RESEARCH_CELL")
    const { csrfToken } = await (await cell.request.get("/api/auth/csrf")).json()
    const sentBack = await cell.request.post(`/api/claims/${claimA.claim!.id}/reject`, {
      headers: { "X-CSRFToken": csrfToken },
      data: { note: "Please attach the cited references themselves, with their numbers." },
    })
    expect(
      sentBack.status(),
      `could not arrange a sent-back ticket: ${await sentBack.text().catch(() => "")}`
    ).toBe(200)
    await done(cell)

    faculty = await asRole(browser, "FACULTY")
    // Real uploads, because the claim API only accepts attachment URLs of the
    // shape `POST /claims/upload` hands back — the fixture's own
    // `/media/e2e/...` rows cannot be re-sent through the form at all.
    paper = await uploadPdf(faculty, "published-paper.pdf")
    refOne = await uploadPdf(faculty, "sec-reference-1.pdf")
    refTwo = await uploadPdf(faculty, "sec-reference-2.pdf")
  })

  test.afterAll(async () => {
    if (faculty) await done(faculty)
  })

  test("cannot be got through with reference numbers left over from an earlier version", async () => {
    /**
     * The exact loophole, on its own.
     *
     * `sec_refs` is a free-text column carrying the reference numbers as the
     * ERP sheets want them, and `_persist_attachments` only overwrites it when
     * the incoming files carry numbers — so a claim edited down to unnumbered
     * files *keeps* whatever string it had. The old gate read that string,
     * found "1, 2", and let the claim through; the formula read the files,
     * found none, and paid nothing. The two counts disagreed and only one of
     * them was on screen.
     */
    const response = await fileWith(
      faculty,
      claimA.claim!.id,
      [
        { file: refOne, number: null },
        { file: refTwo, number: null },
      ],
      paper,
      { sec_refs: "1, 2" }
    )

    expect(
      response.status(),
      "a typed reference-number string got a claim through with no numbered files behind it"
    ).toBe(400)
    const { detail } = (await response.json()) as { detail: string }

    /**
     * And the refusal is one a claimant can act on — asserted here because
     * this is the branch that carries the policy's own message. Four things,
     * because a refusal missing any of them is one they have to ask the
     * research cell about, which is the outcome the old behaviour already had.
     */
    expect(detail, "the refusal counted the typed string rather than the files").toContain(
      `0 of ${NEEDED}`
    )
    expect(detail, "the refusal does not say what to attach").toMatch(/attach the cited paper/i)
    expect(detail, "the refusal does not say where the number comes from").toMatch(
      /number it has in your reference list/i
    )
    expect(detail, "the refusal does not say what would otherwise happen").toMatch(/Rs\s*0|₹0/i)
    // The way out for somebody who genuinely has no more to cite. Without it
    // the refusal is a dead end for a real and legitimate case.
    expect(detail, "the refusal offers no alternative to a claimant who has none").toMatch(
      /publication count/i
    )

    /**
     * And it really did not file.
     *
     * This is the assertion the whole change is about, and the one that
     * separates the new behaviour from the old. A 400 raised *after* the claim
     * had been ticketed would look identical from the client's side, and the
     * money would still be Rs 0 — the old behaviour with an error message
     * painted on top.
     */
    const after = await getClaim(faculty, claimA.claim!.id)
    expect(after.status, "a refused claim was filed anyway").toBe("REJECTED")
  })

  test("is still refused one reference short, and says how far short", async () => {
    // The boundary. A gate written as "at least one" rather than "at least the
    // policy's number" passes every other test in this file.
    const response = await fileWith(
      faculty,
      claimA.claim!.id,
      [
        { file: refOne, number: "1" },
        { file: refTwo, number: null },
      ],
      paper
    )

    expect(response.status(), "a claim one reference short was accepted").toBe(400)
    const { detail } = (await response.json()) as { detail: string }
    expect(detail, "the refusal miscounted a partly-evidenced claim").toContain(
      `1 of ${NEEDED}`
    )
  })

  test("and files, for a real amount, once each reference carries its number", async () => {
    // The positive control. See the note at the top of this file: three
    // refusals prove nothing on an application that refuses everything.
    const response = await fileWith(
      faculty,
      claimA.claim!.id,
      [
        { file: refOne, number: "1" },
        { file: refTwo, number: "2" },
      ],
      paper
    )
    expect(
      response.status(),
      `a fully evidenced claim was refused: ${await response.text().catch(() => "")}`
    ).toBe(200)

    const filed = (await response.json()) as { status: string; remuneration: number | null }
    expect(filed.status).toBe("SUBMITTED")
    // Not ₹0 — which is the number this whole rule exists to stop a claimant
    // being surprised by, and would be what a claim that filed with its
    // references uncounted was worth.
    expect(
      filed.remuneration ?? 0,
      "the claim filed, but for nothing — the references were not counted after all"
    ).toBeGreaterThan(0)
  })

  test("and only then does it appear on the research cell's desk, priced", async ({ browser }) => {
    // The whole point, seen from the other end and on a screen: three refused
    // attempts put nothing in this queue, and the fourth put exactly one thing
    // in it, carrying an amount.
    const cell = await asRole(browser, "RESEARCH_CELL")
    await cell.goto("/clearing")
    await waitForSettled(cell)

    const row = cell.getByRole("row").filter({ hasText: claimA.claim!.ticket_number })
    await expect(row, "the filed ticket is not in the clearing queue").toHaveCount(1)
    await expect(row, "the ticket reached the queue without an amount").toContainText(/₹\s*[1-9]/)

    await done(cell)
  })
})

/**
 * The same mistake, made by somebody making it for the first time — which is
 * the way it is almost always made, and the one case the new message never
 * reaches.
 *
 * `_check_mandatory_fields` runs two checks over the same situation, in order:
 *
 *   1. a `missing` list, which refuses when the free-text `sec_refs` column is
 *      empty with "Complete these before submitting: Reference numbers with
 *      SEC affiliation";
 *   2. the policy check, which refuses with the sentence the tests above
 *      assert — how many counted, what to attach, where the number comes from,
 *      what it would otherwise be worth, and what to do instead.
 *
 * The first one wins whenever `sec_refs` is empty. And `sec_refs` is empty for
 * exactly one kind of claimant: the one who has never successfully attached a
 * numbered reference. The filing form has no box for it — `_persist_attachments`
 * derives the column *from* the numbers on the files, and only when at least
 * one file carries one. So a first-time claimant who attaches both references
 * and forgets both numbers is refused by name of a form field that does not
 * exist on their screen, and told nothing about the numbers, the files, or the
 * Rs 0. The good message is reserved for the claimant who already got it right
 * once.
 *
 * This test asserts the contract, not the current behaviour, and it is
 * expected to be red until the order of those two checks is fixed. Deleting it
 * would make the suite agree that the commonest case is fine.
 */
test.describe("The same claim, from somebody filing it for the first time", () => {
  test("is told what to do, not the name of a field that is not on the form", async ({
    browser,
  }) => {
    const claimB = seedClaim()

    const cell = await asRole(browser, "RESEARCH_CELL")
    const { csrfToken } = await (await cell.request.get("/api/auth/csrf")).json()
    const sentBack = await cell.request.post(`/api/claims/${claimB.claim!.id}/reject`, {
      headers: { "X-CSRFToken": csrfToken },
      data: { note: "Attach the cited references with their numbers, please." },
    })
    expect(sentBack.status()).toBe(200)
    await done(cell)

    const first = await asRole(browser, "FACULTY")
    const paper = await uploadPdf(first, "published-paper.pdf")
    const refOne = await uploadPdf(first, "sec-reference-1.pdf")
    const refTwo = await uploadPdf(first, "sec-reference-2.pdf")

    // Nothing carried over: no reference number has ever been entered on this
    // claim, so `sec_refs` is empty, exactly as it is for a brand-new one.
    const before = await getClaim(first, claimB.claim!.id)
    expect(
      (before.sec_refs || "").trim(),
      "this fixture is not testing a first-time claimant — it already has reference numbers on it"
    ).toBe("")

    const response = await fileWith(
      first,
      claimB.claim!.id,
      [
        { file: refOne, number: null },
        { file: refTwo, number: null },
      ],
      paper
    )
    expect(response.status(), "the claim was accepted with no numbered references").toBe(400)
    const { detail } = (await response.json()) as { detail: string }

    // The refusal a claimant can act on, for the claimant most likely to need
    // it. Same four things the leftover-numbers case is already given.
    expect(detail, "the first-time claimant is not told how many were counted").toContain(
      `0 of ${NEEDED}`
    )
    expect(detail, "the first-time claimant is not told what to attach").toMatch(
      /attach the cited paper/i
    )
    expect(
      detail,
      "the first-time claimant is not told where the reference number comes from"
    ).toMatch(/number it has in your reference list/i)

    await done(first)
  })
})
