import { screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { useLocation } from "react-router-dom"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return { ...actual, api: vi.fn() }
})

import { api } from "@/lib/api"
import { ClaimsList } from "@/pages/claims-list"
import { FACULTY, fakeApi, renderWithProviders } from "@/test/harness"

function Where() {
  return <output data-testid="where">{useLocation().search}</output>
}

const claim = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  paper_title: `Claim paper ${id}`,
  journal_title: "A Journal",
  publication_year: 2025,
  status: "SUBMITTED",
  faculty_stage: "Filed",
  ticket_number: `FP-${id}`,
  remuneration: 1600,
  ...over,
})

function mount(route = "/papers/claims") {
  vi.mocked(api).mockReset()
  vi.mocked(api).mockImplementation(
    fakeApi({
      "/api/auth/me": () => FACULTY,
      "/api/claims/counts": () => ({ counts: { all: 3, draft: 1, sent_back: 0, filed: 1, checked: 0, approved: 0, authorised: 0, paid: 1 } }),
      "/api/claims": () => ({
        total: 3,
        limit: 30,
        offset: 0,
        results: [claim("1", { status: "DRAFT", faculty_stage: "Draft" }), claim("2"), claim("3", { status: "PAID", faculty_stage: "Paid" })],
      }),
      "/api/me/next-payout": () => null,
      "/api/me/research-threshold": () => ({ research: false }),
    })
  )
  renderWithProviders(
    <>
      <ClaimsList />
      <Where />
    </>,
    { route }
  )
}

describe("My claims", () => {
  it("is one table with the Export menu, and the figures are the tabs", async () => {
    mount()
    await screen.findByText("Claim paper 2")
    expect(screen.getByRole("button", { name: /export/i })).toBeTruthy()
    expect(screen.getAllByRole("table")).toHaveLength(1)
    const glance = screen.getByRole("group", { name: "At a glance" })
    expect(within(glance).getByRole("link", { name: "3 All" })).toBeTruthy()
    expect(within(glance).getByRole("link", { name: "1 Needs you" }).getAttribute("href")).toBe("/papers/claims?status=NEEDS")
  })

  it("keeps the one action each draft needs", async () => {
    mount()
    const finish = await screen.findByRole("link", { name: "Finish and file" })
    expect(finish.getAttribute("href")).toBe("/papers/1/edit")
  })

  it("a header sort changes the URL", async () => {
    mount()
    await screen.findByText("Claim paper 2")
    await userEvent.click(within(screen.getByRole("columnheader", { name: /Amount/ })).getByRole("button"))
    expect(screen.getByTestId("where").textContent).toContain("sort=amount")
  })
})
