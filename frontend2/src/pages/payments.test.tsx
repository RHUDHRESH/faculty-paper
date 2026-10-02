import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return { ...actual, api: vi.fn() }
})

import { ApiError, api } from "@/lib/api"
import { Payments } from "@/pages/payments"
import { FINANCE, fakeApi, failing, renderWithProviders } from "@/test/harness"

/**
 * The screen where a mistake costs money twice.
 *
 * Two properties are asserted here and nowhere else in the suite: that a
 * failed queue load is not drawn as "everything has already been paid", and
 * that the confirm button cannot be pressed a second time while the first
 * press is still in flight. A double-click on Pay is not a duplicate render,
 * it is a duplicate payment.
 */

const PAYABLE = {
  id: "claim-1",
  ticket_number: "PUB-2025-0041",
  paper_title: "A finite element study of lattice struts",
  journal_title: "Journal of Materials",
  owner_name: "Dr Asha Menon",
  owner_department: "Mechanical Engineering",
  remuneration: 52_377.5,
  calc_error: null,
  voucher_number: null,
  cleared_by_name: "S Rao",
  second_approved_by_name: null,
  principal_approved_by_name: "K Nair",
  principal_approved_at: "2025-06-01T00:00:00Z",
  paid_at: null,
  needs_second_approval: false,
  duplicate_warning: false,
  override_duplicate: null,
  override_by_name: null,
  waiting_days: 3,
}

function payoutsPage(results: (typeof PAYABLE)[]) {
  return { total: results.length, limit: 50, offset: 0, results }
}

/* ------------------------------------------------------------------------ */
/* A failed queue is not an empty queue                                      */
/* ------------------------------------------------------------------------ */

describe("the payable queue", () => {
  it("says nothing is waiting only when the server said so", async () => {
    vi.mocked(api).mockImplementation(
      fakeApi({
        "/api/auth/me": () => FINANCE,
        "/api/admin/payouts": () => payoutsPage([]),
      })
    )
    renderWithProviders(<Payments />)

    expect(await screen.findByText("Nothing waiting on Finance")).toBeInTheDocument()
    expect(screen.queryByRole("alert")).toBeNull()
  })

  it("shows the failure, not an empty queue, when the request fails", async () => {
    vi.mocked(api).mockImplementation(
      fakeApi({
        "/api/auth/me": () => FINANCE,
        "/api/admin/payouts": failing(500),
      })
    )
    renderWithProviders(<Payments />)

    // Wait for the account to load first: until it does the page draws its
    // own "not open to this account" alert, which is a different alert.
    await screen.findByText("Could not load payments")

    const alert = await screen.findByRole("alert")
    expect(alert).toHaveTextContent("Could not load payments")
    expect(alert).toHaveTextContent(/nothing has been paid or lost/i)

    // A Finance officer told "every ticket has already been paid" when the
    // queue simply did not load stops paying people.
    expect(screen.queryByText("Nothing waiting on Finance")).toBeNull()
    expect(screen.queryByText(/already been paid/i)).toBeNull()
    expect(screen.getByRole("button", { name: /try again/i })).toBeInTheDocument()
  })

  it("gives every control on the queue an accessible name", async () => {
    vi.mocked(api).mockImplementation(
      fakeApi({
        "/api/auth/me": () => FINANCE,
        "/api/admin/payouts": () => payoutsPage([PAYABLE]),
      })
    )
    const { container } = renderWithProviders(<Payments />)
    await screen.findAllByRole("button", { name: "Pay" })

    // The row's select checkbox and the refresh button are both icon-only or
    // glyph-led; an unnamed one is announced as "button" and nothing else.
    const unnamed = [...container.querySelectorAll("button")].filter(
      (b) =>
        !(b.textContent || "").trim() &&
        !b.getAttribute("aria-label") &&
        !b.getAttribute("aria-labelledby")
    )
    expect(unnamed.map((b) => b.outerHTML)).toEqual([])
  })
})

/* ------------------------------------------------------------------------ */
/* A payment cannot be sent twice                                            */
/* ------------------------------------------------------------------------ */

describe("paying one claim", () => {
  it("refuses to fire twice while the first request is still in flight", async () => {
    const user = userEvent.setup()

    // Held open so the mutation stays pending for as long as the assertions
    // need it to. A handler that resolves immediately would let the second
    // click land after the first had already settled, and the test would
    // pass against a component with no guard at all.
    let release: (value: unknown) => void = () => {}
    const inFlight = new Promise((resolve) => {
      release = resolve
    })

    vi.mocked(api).mockImplementation(
      fakeApi({
        "/api/auth/me": () => FINANCE,
        "/api/admin/payouts": () => payoutsPage([PAYABLE]),
        "/api/claims/claim-1/mark-paid": () => inFlight,
      })
    )
    renderWithProviders(<Payments />)

    await user.click((await screen.findAllByRole("button", { name: "Pay" }))[0]!)

    const dialog = await screen.findByRole("dialog")
    const confirm = within(dialog).getByRole("button", { name: "Pay ₹52,377.50" })

    await user.click(confirm)

    // The button is now the pending one, and it is disabled.
    const pending = await within(dialog).findByRole("button", { name: "Paying…" })
    expect(pending).toBeDisabled()
    // Cancel too — closing the dialog mid-flight leaves a payment nobody is
    // watching the result of.
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeDisabled()

    // The impatient second and third click.
    await user.click(pending)
    await user.click(pending)

    expect(markPaidCalls()).toHaveLength(1)

    release({ ok: true })
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())

    // And still only one after it settled.
    expect(markPaidCalls()).toHaveLength(1)
  })

  it("sends the amount the reader confirmed, so the server can refuse a stale one", async () => {
    const user = userEvent.setup()
    vi.mocked(api).mockImplementation(
      fakeApi({
        "/api/auth/me": () => FINANCE,
        "/api/admin/payouts": () => payoutsPage([PAYABLE]),
        "/api/claims/claim-1/mark-paid": () => ({ ok: true }),
      })
    )
    renderWithProviders(<Payments />)

    await user.click((await screen.findAllByRole("button", { name: "Pay" }))[0]!)
    const dialog = await screen.findByRole("dialog")
    await user.click(within(dialog).getByRole("button", { name: "Pay ₹52,377.50" }))

    await waitFor(() => expect(markPaidCalls()).toHaveLength(1))
    const [, options] = markPaidCalls()[0]
    expect(options).toMatchObject({
      method: "POST",
      json: { expected_amount: 52_377.5 },
    })
  })

  it("refuses a second payment in plain words and offers no second Pay", async () => {
    const user = userEvent.setup()
    vi.mocked(api).mockImplementation(
      fakeApi({
        "/api/auth/me": () => FINANCE,
        "/api/admin/payouts": () => payoutsPage([{ ...PAYABLE, payout_month: "2025-09" } as typeof PAYABLE]),
        "/api/claims/claim-1/mark-paid": failing(400, "Invalid status — the claim must be authorised by the Director first"),
      })
    )
    renderWithProviders(<Payments />)

    expect((await screen.findAllByText(/Sept? 2025/))[0]).toBeTruthy()
    await user.click((await screen.findAllByRole("button", { name: "Pay" }))[0]!)
    const dialog = await screen.findByRole("dialog")
    await user.click(within(dialog).getByRole("button", { name: "Pay ₹52,377.50" }))

    expect(await within(dialog).findByText("Already paid")).toBeTruthy()
    expect(within(dialog).queryByRole("button", { name: /^Pay ₹/ })).toBeNull()
  })

  it("never shows Finance a flag or a duplicate warning", async () => {
    vi.mocked(api).mockImplementation(
      fakeApi({
        "/api/auth/me": () => FINANCE,
        "/api/admin/payouts": () =>
          payoutsPage([{ ...PAYABLE, needs_second_approval: true, duplicate_warning: true, override_duplicate: true, override_by_name: "X" } as unknown as typeof PAYABLE]),
      })
    )
    renderWithProviders(<Payments />)
    expect(await screen.findByText(/Needs a second approver/)).toBeTruthy()
    expect(document.body.textContent).not.toMatch(/flag|duplicate|warning|history/i)
  })
})

/** Every call the component made to the one endpoint that moves money. */
function markPaidCalls() {
  return vi.mocked(api).mock.calls.filter(([path]) => String(path).includes("mark-paid"))
}

/* ------------------------------------------------------------------------ */
/* The audit: what the screen must say                                       */
/* ------------------------------------------------------------------------ */

describe("the payments desk says what it is doing", () => {
  const RESEARCH = {
    ...PAYABLE,
    id: "claim-2",
    ticket_number: "PUB-2025-0042",
    remuneration: 7_600,
    threshold_absorbed: 10_000,
    threshold_full_amount: 17_600,
    quota_applied: true,
    ledger_paid: 0,
  }
  const HELD = { ...PAYABLE, id: "claim-3", ticket_number: "PUB-2025-0043", needs_second_approval: true }

  function load(results: unknown[], extra: Record<string, () => unknown> = {}) {
    vi.mocked(api).mockImplementation(
      fakeApi({
        "/api/auth/me": () => FINANCE,
        "/api/admin/payouts": () => payoutsPage(results as (typeof PAYABLE)[]),
        ...extra,
      })
    )
  }

  it("shows the research threshold on the claim it reduces, in rupees", async () => {
    load([PAYABLE, RESEARCH])
    renderWithProviders(<Payments />)
    expect(await screen.findByText(/of ₹17,600; ₹10,000 held back by the research threshold/)).toBeInTheDocument()
    // and once, in a sentence, for the whole queue
    expect(screen.getByText(/research threshold holds back ₹10,000 on 1 claim/)).toBeInTheDocument()
  })

  it("keeps a claim awaiting a second signature out of the payable list", async () => {
    load([PAYABLE, HELD])
    renderWithProviders(<Payments />)
    expect(await screen.findByRole("heading", { name: "Ready to pay (1)" })).toBeInTheDocument()
    expect(screen.getByRole("heading", { name: "Held up (1)" })).toBeInTheDocument()
    // only the one ready claim can be paid
    expect(screen.getAllByRole("button", { name: "Pay" })).toHaveLength(1)
  })

  it("names the duplicate-payment check before the button can be pressed", async () => {
    const user = userEvent.setup()
    load([{ ...PAYABLE, ledger_paid: 0 }])
    renderWithProviders(<Payments />)
    await user.click((await screen.findAllByRole("button", { name: "Pay" }))[0]!)
    const dialog = await screen.findByRole("dialog")
    expect(within(dialog).getByText(/Not paid before/)).toBeInTheDocument()
    expect(within(dialog).getByRole("button", { name: "Pay ₹52,377.50" })).toBeEnabled()
  })

  it("refuses to pay a claim the ledger already holds", async () => {
    const user = userEvent.setup()
    load([{ ...PAYABLE, ledger_paid: 52_377.5 }])
    renderWithProviders(<Payments />)
    await user.click((await screen.findAllByRole("button", { name: "Pay" }))[0]!)
    const dialog = await screen.findByRole("dialog")
    expect(within(dialog).getByText(/Already paid: ₹52,377.50 is on the ledger/)).toBeInTheDocument()
    expect(within(dialog).getByRole("button", { name: "Pay ₹52,377.50" })).toBeDisabled()
  })

  it("confirms a batch with counts and totals, then points at the bank file", async () => {
    const user = userEvent.setup()
    const B = { ...PAYABLE, id: "claim-9", ticket_number: "PUB-2025-0049", remuneration: 10_000, payout_month: "2025-09" }
    load([{ ...PAYABLE, payout_month: "2025-09" }, B], {
      "/api/admin/bulk-mark-paid": () => ({ paid: 2, paid_ids: ["claim-1", "claim-9"], skipped: [] }),
    })
    renderWithProviders(<Payments />)
    await user.click(await screen.findByRole("button", { name: /Select all 2/ }))
    await user.click(screen.getByRole("button", { name: "Pay 2 claims" }))
    const dialog = await screen.findByRole("dialog")
    expect(within(dialog).getByRole("heading", { name: "Pay 2 claims?" })).toBeInTheDocument()
    expect(within(dialog).getByText("₹62,377.50", { selector: ".figure" })).toBeInTheDocument()
    await user.click(within(dialog).getByRole("button", { name: "Pay 2 claims, ₹62,377.50" }))
    // A button, not a bare link: it asks the server whether this month's file
    // was already made before it offers one (pages/bank-file.tsx).
    expect(await within(dialog).findByRole("button", { name: /Bank file/ })).toBeInTheDocument()
    expect(within(dialog).getByRole("heading", { name: "Paid 2 of 2" })).toBeInTheDocument()
  })
})


/* ------------------------------------------------------------------------ */
/* The safeguards on the pay dialog                                          */
/* ------------------------------------------------------------------------ */

describe("the pay dialog and the safeguards", () => {
  function refusal(status: number, detail: string, body: Record<string, unknown>) {
    return () => {
      throw new ApiError(status, detail, { detail, ...body })
    }
  }

  async function open(table: Record<string, () => unknown>) {
    const user = userEvent.setup()
    vi.mocked(api).mockImplementation(
      fakeApi({
        "/api/auth/me": () => FINANCE,
        "/api/admin/payouts": () => payoutsPage([PAYABLE]),
        ...table,
      } as Parameters<typeof fakeApi>[0])
    )
    renderWithProviders(<Payments />)
    await user.click((await screen.findAllByRole("button", { name: "Pay" }))[0]!)
    return { user, dialog: await screen.findByRole("dialog") }
  }

  it("says it was already paid, with the month, before the click, and offers no Pay", async () => {
    const { dialog } = await open({
      "/api/claims/claim-1/pay-check": () => ({
        claim_id: "claim-1",
        blocked: true,
        problems: [{ code: "paid_before", message: "This paper is already on the payment ledger for Dr A, paid in March 2025. It is not paid again." }],
      }),
    })
    expect(await within(dialog).findByText(/already on the payment ledger for Dr A, paid in March 2025/)).toBeInTheDocument()
    expect(within(dialog).getByRole("button", { name: "Pay ₹52,377.50" })).toBeDisabled()
  })

  it("sends one idempotency key and sends the same one again on a retry", async () => {
    let calls = 0
    const { user, dialog } = await open({
      "/api/claims/claim-1/pay-check": () => ({ claim_id: "claim-1", blocked: false, problems: [] }),
      "/api/claims/claim-1/mark-paid": () => {
        calls += 1
        if (calls === 1) throw new ApiError(409, "The recomputed amount is ₹52,377.50. Review it and confirm again.")
        return { ok: true }
      },
    })
    await user.click(within(dialog).getByRole("button", { name: "Pay ₹52,377.50" }))
    await user.click(await within(dialog).findByRole("button", { name: "Pay ₹52,377.50" }))
    await waitFor(() => expect(markPaidCalls()).toHaveLength(2))
    const keys = markPaidCalls().map(([, o]) => (o as { json: { idempotency_key: string } }).json.idempotency_key)
    expect(keys[0]).toBeTruthy()
    expect(keys[1]).toBe(keys[0])
  })

  it("tells Finance when the amount changed after authorisation and the claim went back", async () => {
    const { user, dialog } = await open({
      "/api/claims/claim-1/pay-check": () => ({ claim_id: "claim-1", blocked: false, problems: [] }),
      "/api/claims/claim-1/mark-paid": refusal(
        409,
        "The amount changed after the Director authorised it (₹52,377.50 to ₹40,000.00). Nothing was paid. It has gone back to the Principal to approve the new amount.",
        { code: "amount_changed" }
      ),
    })
    await user.click(within(dialog).getByRole("button", { name: "Pay ₹52,377.50" }))
    expect(await within(dialog).findByText("Sent back to the Principal")).toBeInTheDocument()
    expect(within(dialog).getByText(/gone back to the Principal/)).toBeInTheDocument()
    expect(within(dialog).queryByRole("button", { name: /^Pay ₹/ })).toBeNull()
  })

  it("asks a super admin for a reason when they would pay what they authorised", async () => {
    const { user, dialog } = await open({
      "/api/claims/claim-1/pay-check": () => ({ claim_id: "claim-1", blocked: false, problems: [] }),
      "/api/claims/claim-1/mark-paid": refusal(400, "Paying this needs a reason, because you authorised it yourself.", {
        code: "reason_needed",
      }),
    })
    await user.click(within(dialog).getByRole("button", { name: "Pay ₹52,377.50" }))
    expect(await within(dialog).findByLabelText("Why you are paying this")).toBeInTheDocument()
    expect(within(dialog).getByRole("button", { name: "Pay ₹52,377.50" })).toBeDisabled()
  })
})
