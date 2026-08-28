import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return { ...actual, api: vi.fn() }
})

import { api } from "@/lib/api"
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
    await screen.findByRole("button", { name: /refresh/i })

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
    await screen.findByRole("button", { name: "Pay" })

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

    await user.click(await screen.findByRole("button", { name: "Pay" }))

    const dialog = await screen.findByRole("dialog")
    const confirm = within(dialog).getByRole("button", { name: "Pay — ₹52,377.50" })

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

    await user.click(await screen.findByRole("button", { name: "Pay" }))
    const dialog = await screen.findByRole("dialog")
    await user.click(within(dialog).getByRole("button", { name: "Pay — ₹52,377.50" }))

    await waitFor(() => expect(markPaidCalls()).toHaveLength(1))
    const [, options] = markPaidCalls()[0]
    expect(options).toMatchObject({
      method: "POST",
      json: { expected_amount: 52_377.5 },
    })
  })
})

/** Every call the component made to the one endpoint that moves money. */
function markPaidCalls() {
  return vi.mocked(api).mock.calls.filter(([path]) => String(path).includes("mark-paid"))
}
