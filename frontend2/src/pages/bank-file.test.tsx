import { screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return { ...actual, api: vi.fn() }
})

import { api } from "@/lib/api"
import { BankFileButton } from "@/pages/bank-file"
import { fakeApi, renderWithProviders } from "@/test/harness"

const FIRST = { id: "e1", created_at: "2026-09-03T10:00:00Z", by: "Kavya", count: 12, total: 150000, scope: "all" }

function clicked() {
  const urls: string[] = []
  const spy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
    urls.push(this.getAttribute("href") ?? "")
  })
  return { urls, spy }
}

afterEach(() => vi.restoreAllMocks())

describe("the bank file", () => {
  it("downloads the first file straight away", async () => {
    vi.mocked(api).mockImplementation(
      fakeApi({
        "/api/payouts/bank-exports": () => ({ month: "2026-08", exports: [], new_count: 3, new_total: 900, all_count: 3, all_total: 900 }),
      })
    )
    const { urls } = clicked()
    renderWithProviders(<BankFileButton month="2026-08" />)
    await userEvent.click(await screen.findByRole("button", { name: /Bank file/ }))
    expect(urls).toEqual(["/api/payouts/statement.csv?month=2026-08"])
  })

  it("says it was already made, by whom and when, and offers only the new payments", async () => {
    vi.mocked(api).mockImplementation(
      fakeApi({
        "/api/payouts/bank-exports": () => ({
          month: "2026-08",
          exports: [FIRST],
          new_count: 2,
          new_total: 4000,
          all_count: 14,
          all_total: 154000,
        }),
      })
    )
    const { urls } = clicked()
    renderWithProviders(<BankFileButton month="2026-08" />)
    // Wait for the answer before pressing, or the plain first-file button is what is on screen.
    await screen.findByRole("button", { name: /Bank file/ })
    await vi.waitFor(async () => {
      await userEvent.click(screen.getByRole("button", { name: /Bank file/ }))
      expect(screen.getByRole("dialog")).toBeInTheDocument()
    })
    const dialog = screen.getByRole("dialog")
    expect(within(dialog).getByText(/Generated on .* by Kavya, 12 payments/)).toBeInTheDocument()
    expect(within(dialog).getByText(/2 payments \(₹4,000\) have been made since/)).toBeInTheDocument()
    await userEvent.click(within(dialog).getByRole("button", { name: "Download the 2 new payments" }))
    expect(urls).toEqual(["/api/payouts/statement.csv?month=2026-08&scope=new"])
  })

  it("needs a reason before the whole month goes again", async () => {
    vi.mocked(api).mockImplementation(
      fakeApi({
        "/api/payouts/bank-exports": () => ({ month: "2026-08", exports: [FIRST], new_count: 0, new_total: 0, all_count: 12, all_total: 150000 }),
      })
    )
    const { urls } = clicked()
    renderWithProviders(<BankFileButton month="2026-08" />)
    await screen.findByRole("button", { name: /Bank file/ })
    await vi.waitFor(async () => {
      await userEvent.click(screen.getByRole("button", { name: /Bank file/ }))
      expect(screen.getByRole("dialog")).toBeInTheDocument()
    })
    const dialog = screen.getByRole("dialog")
    expect(within(dialog).getByRole("button", { name: "No new payments" })).toBeDisabled()
    await userEvent.click(within(dialog).getByRole("button", { name: "The whole month again" }))
    const send = within(dialog).getByRole("button", { name: "Download the whole month again" })
    expect(send).toBeDisabled()
    await userEvent.type(within(dialog).getByLabelText(/Why the whole month is going again/), "The first file never reached the bank")
    await userEvent.click(send)
    expect(urls[0]).toBe(
      "/api/payouts/statement.csv?month=2026-08&scope=all&reason=The%20first%20file%20never%20reached%20the%20bank"
    )
  })
})
