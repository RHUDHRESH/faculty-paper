/**
 * The rules the desks live by, checked end to end against a real server.
 *
 * `money-chain.spec.ts` proves one amount survives five desks. This file
 * proves the rules around that chain, each on its own freshly seeded ticket:
 *
 *  - hold and resume, and the claimant never learns whose desk holds it;
 *  - a flag raised at the research cell is seen by the Principal and never by
 *    the Director or Finance, on screen or through the API;
 *  - a payment is marked paid once; Finance cannot undo it, a super admin can;
 *  - reject outright is final: the claimant cannot refile;
 *  - "view as" is read-only: every write is refused until it stops.
 *
 * Decisions are sent as the requests the desk screens send, from each role's
 * own signed-in browser (same seam as `rejection.spec.ts`); what is asserted
 * is the server's verdict and what each screen shows.
 */
import { expect, test, type APIResponse, type Browser, type Page } from "@playwright/test"

import { openSession, seedClaim, storageStatePath, writeStorageState, type SessionInfo } from "./fixtures/backend"
import { FILEABLE_FIELDS, csrfToken, getClaim, patchClaim } from "./fixtures/claim-api"
import { waitForSettled } from "./fixtures/page-health"

async function asRole(browser: Browser, role: string): Promise<Page> {
  const context = await browser.newContext({ storageState: storageStatePath(role) })
  return context.newPage()
}

async function done(page: Page): Promise<void> {
  const context = page.context()
  await page.close()
  await context.close()
}

async function post(page: Page, path: string, data: Record<string, unknown> = {}): Promise<APIResponse> {
  return page.request.post(`/api${path}`, { headers: { "X-CSRFToken": await csrfToken(page) }, data })
}

async function ok(res: APIResponse, where: string): Promise<void> {
  expect(res.status(), `${where}: ${res.status()} — ${await res.text().catch(() => "")}`).toBe(200)
}

/** Run one decision as one role and close its browser. */
async function act(browser: Browser, role: string, path: string, data: Record<string, unknown> = {}) {
  const page = await asRole(browser, role)
  const res = await post(page, path, data)
  const status = res.status()
  const text = await res.text().catch(() => "")
  await done(page)
  return { status, text }
}

test.beforeAll(() => {
  writeStorageState("SUPER_ADMIN", openSession("SUPER_ADMIN"))
})

test.describe("Hold and resume, and the claimant never sees the desk", () => {
  let seeded: SessionInfo

  test.beforeAll(() => {
    seeded = seedClaim()
  })

  test("the cell holds it, the claimant sees only 'Under review', and it resumes", async ({ browser }) => {
    const id = seeded.claim!.id
    const reason = "Waiting on the erratum from the publisher"
    const held = await act(browser, "RESEARCH_CELL", `/claims/${id}/hold`, { reason })
    expect(held.status, held.text).toBe(200)

    const faculty = await asRole(browser, "FACULTY")
    const body = JSON.stringify(await getClaim(faculty, id))
    expect(body, "the claimant is shown the hold reason").not.toContain(reason)
    expect(body, "the claimant is shown who holds the paper").not.toContain("E2E Research Cell")
    expect((await faculty.request.get("/api/admin/clearing-queue")).status()).toBe(403)

    await faculty.goto("/papers/claims")
    await waitForSettled(faculty)
    await faculty.getByLabel("Search your papers").fill(seeded.claim!.ticket_number)
    const row = faculty.getByRole("listitem").filter({ hasText: seeded.claim!.ticket_number })
    await expect(row).toHaveCount(1)
    await expect(row).toContainText("Being checked")
    await expect(faculty.locator("body")).not.toContainText(reason)
    await expect(faculty.locator("body")).not.toContainText(/research cell|Principal|Director|Finance/i)
    await done(faculty)

    const resumed = await act(browser, "RESEARCH_CELL", `/claims/${id}/resume`)
    expect(resumed.status, resumed.text).toBe(200)
    const cell = await asRole(browser, "RESEARCH_CELL")
    const after = await getClaim(cell, id)
    expect(after.status).toBe("SUBMITTED")
    expect((after as unknown as { on_hold: boolean }).on_hold).toBeFalsy()
    await done(cell)
  })
})

test.describe("A flagged claim through every desk, paid once, and undone", () => {
  test.describe.configure({ mode: "serial" })

  let seeded: SessionInfo
  const note = `E2E flag ${Date.now()}: author list differs from Scopus`

  test.beforeAll(() => {
    seeded = seedClaim()
  })

  test("the research cell flags it and clears it", async ({ browser }) => {
    const id = seeded.claim!.id
    const flag = await act(browser, "RESEARCH_CELL", `/claims/${id}/flags`, { kind: "OTHER", note })
    expect(flag.status, flag.text).toBe(200)
    const clear = await act(browser, "RESEARCH_CELL", `/claims/${id}/clear`, {
      expected_amount: seeded.claim!.remuneration,
    })
    expect(clear.status, clear.text).toBe(200)
  })

  test("the Principal sees the flag, and approves", async ({ browser }) => {
    const page = await asRole(browser, "PRINCIPAL")
    const flags = await page.request.get("/api/flags")
    await ok(flags, "principal reads flags")
    expect(await flags.text()).toContain(note)
    await done(page)
    const res = await act(browser, "PRINCIPAL", `/claims/${seeded.claim!.id}/principal-approve`, {
      expected_amount: seeded.claim!.remuneration,
    })
    expect(res.status, res.text).toBe(200)
  })

  for (const role of ["DIRECTOR", "FINANCE"] as const) {
    test(`${role} is refused the flags, and no screen of theirs shows it`, async ({ browser }) => {
      const page = await asRole(browser, role)
      expect((await page.request.get("/api/flags")).status()).toBe(403)
      const claim = await page.request.get(`/api/claims/${seeded.claim!.id}`)
      expect(await claim.text()).not.toContain(note)
      for (const path of role === "DIRECTOR" ? ["/authorisations", "/"] : ["/payments", "/"]) {
        await page.goto(path)
        await waitForSettled(page)
        await expect(page.locator("body"), `${role} ${path}`).not.toContainText(note)
      }
      await done(page)
    })

    if (role === "DIRECTOR") {
      test("the Director authorises it", async ({ browser }) => {
        const queue = await asRole(browser, "DIRECTOR")
        const q = await queue.request.get("/api/director/queue")
        await ok(q, "director queue")
        expect(await q.text()).not.toContain(note)
        await done(queue)
        const res = await act(browser, "DIRECTOR", `/claims/${seeded.claim!.id}/director-approve`, {
          expected_amount: seeded.claim!.remuneration,
        })
        expect(res.status, res.text).toBe(200)
      })
    }
  }

  test("Finance pays it once; a second payment is refused", async ({ browser }) => {
    const id = seeded.claim!.id
    const body = { expected_amount: seeded.claim!.remuneration, voucher_number: `E2E-V-${Date.now()}` }
    const first = await act(browser, "FINANCE", `/claims/${id}/mark-paid`, body)
    expect(first.status, first.text).toBe(200)
    const again = await act(browser, "FINANCE", `/claims/${id}/mark-paid`, body)
    expect(again.status, "a paid claim was paid a second time").not.toBe(200)
  })

  test("Finance cannot undo a payment; the super admin can", async ({ browser }) => {
    const id = seeded.claim!.id
    const why = { note: "Paid against the wrong voucher" }
    expect((await act(browser, "FINANCE", `/claims/${id}/void-payment`, why)).status).toBe(403)
    const voided = await act(browser, "SUPER_ADMIN", `/claims/${id}/void-payment`, why)
    expect(voided.status, voided.text).toBe(200)
    const page = await asRole(browser, "SUPER_ADMIN")
    expect((await getClaim(page, id)).status).not.toBe("PAID")
    await done(page)

    // And the claimant is no longer told they were paid for it.
    const faculty = await asRole(browser, "FACULTY")
    const mine = await faculty.request.get("/api/me/payments")
    await ok(mine, "claimant's payments")
    expect(await mine.text(), "a voided payment still shows as paid to the claimant").not.toContain(
      seeded.claim!.ticket_number
    )
    await done(faculty)
  })
})

test.describe("Reject outright", () => {
  let seeded: SessionInfo

  test.beforeAll(() => {
    seeded = seedClaim()
  })

  test("needs a reason, is final, and the claimant cannot refile", async ({ browser }) => {
    const id = seeded.claim!.id
    const bare = await act(browser, "RESEARCH_CELL", `/claims/${id}/reject-outright`, { note: "no" })
    expect(bare.status, "rejected outright with no real reason").not.toBe(200)
    const res = await act(browser, "RESEARCH_CELL", `/claims/${id}/reject-outright`, {
      note: "Predatory journal, not eligible under the policy",
    })
    expect(res.status, res.text).toBe(200)

    const faculty = await asRole(browser, "FACULTY")
    const before = await getClaim(faculty, id)
    const refile = await patchClaim(faculty, id, { ...FILEABLE_FIELDS, submit: true })
    const after = await getClaim(faculty, id)
    expect(after.status, `refiled an outright rejection (${refile.status()})`).toBe(before.status)
    expect(after.status).not.toBe("SUBMITTED")
    await done(faculty)

    // And no desk can pick it back up.
    const clear = await act(browser, "RESEARCH_CELL", `/claims/${id}/clear`, {
      expected_amount: seeded.claim!.remuneration,
    })
    expect(clear.status).not.toBe(200)
  })
})

test.describe("View as somebody", () => {
  test("is read-only until it stops", async ({ browser }) => {
    const seeded = seedClaim()
    const page = await asRole(browser, "SUPER_ADMIN")
    const start = await post(page, `/admin/impersonate/${seeded.user_id}`)
    await ok(start, "start view-as")
    const me = await (await page.request.get("/api/auth/me")).json()
    expect(me.email).toBe(seeded.email)

    await page.goto("/")
    await waitForSettled(page)
    await expect(page.getByText(/viewing the app as/i).first()).toBeVisible()

    // Writes the viewed person could make are all refused.
    for (const [path, data] of [
      [`/claims/${seeded.claim!.id}/withdraw`, {}],
      ["/claims", {}],
      ["/notifications/read-all", {}],
    ] as const) {
      const res = await post(page, path, data)
      expect(res.status(), `view-as wrote ${path}`).toBe(403)
    }
    const patch = await patchClaim(page, seeded.claim!.id, { paper_title: "changed while viewing" })
    expect(patch.status()).toBe(403)
    expect((await getClaim(page, seeded.claim!.id)).paper_title).toBe(seeded.claim!.title)

    await ok(await post(page, "/admin/stop-impersonating"), "stop view-as")
    const back = await (await page.request.get("/api/auth/me")).json()
    expect(back.email).not.toBe(seeded.email)
    await done(page)
  })
})
