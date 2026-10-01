import { screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return { ...actual, api: vi.fn() }
})

import { BulkSummaryDialog, NoBulkSendBack, QueueTable, reviewLink, waitTone, waitingLabel, type QueueRow } from "@/ui/queue"
import { renderWithProviders } from "@/test/harness"

const row: QueueRow = {
  id: "r1",
  ticket_number: "FP-2026-000001",
  paper_title: "A paper",
  journal_title: "Nature",
  quartile: "Q2",
  owner_name: "Asha Faculty",
  owner_department: "ECE",
  remuneration: 5000,
  waiting_days: 16,
}

describe("the queue table for a role that may not see money or flags", () => {
  it("draws no amount column and no flags column unless asked", () => {
    renderWithProviders(<QueueTable label="Claims" rows={[row]} showAmount={false} reviewHref={(r) => `/review/${r.id}`} />)
    const t = within(screen.getByRole("table", { name: "Claims" }))
    expect(t.queryByRole("columnheader", { name: "Amount" })).toBeNull()
    expect(t.queryByRole("columnheader", { name: "Flags" })).toBeNull()
    expect(t.queryByText("₹5,000")).toBeNull()
    expect(screen.queryByText("₹5,000")).toBeNull() // the phone cards too
    expect(t.getByRole("columnheader", { name: "Claim no." })).toBeInTheDocument()
  })

  it("draws them when the caller allows", () => {
    renderWithProviders(
      <QueueTable label="Claims" rows={[row]} showAmount flags={() => <span>A flag</span>} reviewHref={(r) => `/review/${r.id}`} />
    )
    const t = within(screen.getByRole("table", { name: "Claims" }))
    expect(t.getByRole("columnheader", { name: "Flags" })).toBeInTheDocument()
    expect(t.getByText("₹5,000")).toBeInTheDocument()
  })
})

describe("waiting time and links", () => {
  it("is amber over 14 days, red over 30, and plain otherwise", () => {
    expect(waitTone(14)).toBe("")
    expect(waitTone(15)).toBe("text-caution")
    expect(waitTone(30)).toBe("text-caution")
    expect(waitTone(31)).toBe("text-critical")
    expect(waitingLabel(0)).toBe("Today")
    expect(waitingLabel(1)).toBe("1 day")
    expect(waitingLabel(null)).toBe("—")
  })

  it("names the queue and the filters in the review link", () => {
    expect(reviewLink("abc", "clearing")).toBe("/review/abc?queue=clearing")
    expect(reviewLink("abc", "approvals", new URLSearchParams("department=CSE&age=older"))).toBe(
      "/review/abc?queue=approvals&filter=department%3DCSE%26age%3Dolder"
    )
  })
})

describe("the summary before a batch goes", () => {
  it("says how many, how much, what is worth a look and what is left out", async () => {
    const onConfirm = vi.fn()
    const user = userEvent.setup()
    renderWithProviders(
      <BulkSummaryDialog
        open
        onOpenChange={() => {}}
        title="Clear 2 claims?"
        showMoney
        rows={[
          { ...row, note: null },
          { ...row, id: "r2", ticket_number: "FP-2026-000002", remuneration: 2500, note: "checks failed" },
        ]}
        leftOut={{ count: 3, reasons: [{ label: "watched journal", count: 3 }] }}
        confirmLabel="Clear 2 for ₹7,500"
        onConfirm={onConfirm}
      />
    )
    const d = await screen.findByRole("dialog", { name: "Clear 2 claims?" })
    expect(d).toHaveTextContent("2 claims, ₹7,500 in all")
    expect(d).toHaveTextContent("1 claim is worth a second look")
    expect(d).toHaveTextContent("3 left out")
    expect(d).toHaveTextContent("3 watched journal")
    await user.click(within(d).getByRole("button", { name: "Clear 2 for ₹7,500" }))
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it("shows no money to a role that may not see it", async () => {
    renderWithProviders(
      <BulkSummaryDialog open onOpenChange={() => {}} title="Hold 1 claim?" showMoney={false} rows={[row]} confirmLabel="Go" onConfirm={() => {}} />
    )
    const d = await screen.findByRole("dialog")
    expect(d).not.toHaveTextContent("₹")
  })
})

describe("bulk send back", () => {
  it("is explained rather than offered", () => {
    renderWithProviders(<NoBulkSendBack />)
    expect(screen.getByText(/one claim at a time, because each needs its own reason/)).toBeInTheDocument()
    expect(screen.queryByRole("button")).toBeNull()
  })
})
