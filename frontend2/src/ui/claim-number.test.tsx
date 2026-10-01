import { screen, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return { ...actual, api: vi.fn() }
})

import { api } from "@/lib/api"
import { ClaimNo, ClaimNoJump, compactNo, looksLikeClaimNo, matchesClaimNo } from "@/ui/claim-number"
import { fakeApi, renderWithProviders } from "@/test/harness"

describe("claim numbers as people type them", () => {
  it("treats spaces, case and missing zeros as the same number", () => {
    expect(compactNo("fp 2026-000123")).toBe("FP2026000123")
    for (const typed of ["FP-2026-000123", "fp-2026-000123", "fp 2026 123", "FP2026123"]) {
      expect(matchesClaimNo("FP-2026-000123", typed), typed).toBe(true)
    }
    expect(matchesClaimNo("FP-2026-000124", "fp 2026 123")).toBe(false)
  })

  it("matches the start of a number, so ERP-PROC finds every imported claim", () => {
    expect(matchesClaimNo("ERP-PROCESSED-120", "erp-proc")).toBe(true)
    expect(matchesClaimNo("ERP-PROCESSED-120", "ERP-PROCESSED-120")).toBe(true)
    expect(matchesClaimNo("ERP-RAW-3", "erp-proc")).toBe(false)
    expect(matchesClaimNo("FP-2026-000123", "FP-2026-0001")).toBe(true)
  })

  it("does not call ordinary words claim numbers", () => {
    expect(looksLikeClaimNo("fuzzy control")).toBe(false)
    expect(looksLikeClaimNo("FP")).toBe(false)
    expect(looksLikeClaimNo("FP-20")).toBe(true)
    expect(matchesClaimNo("FP-2026-000123", "fuzzy")).toBe(false)
    expect(matchesClaimNo(null, "FP-2026")).toBe(false)
  })
})

describe("<ClaimNo>", () => {
  it("shows the number with a copy button", () => {
    renderWithProviders(<ClaimNo value="FP-2026-000123" />)
    expect(screen.getByText("FP-2026-000123")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /copy claim no\. FP-2026-000123/i })).toBeInTheDocument()
  })

  it("says so when there is no number yet", () => {
    renderWithProviders(<ClaimNo value={null} />)
    expect(screen.getByText("No claim no. yet")).toBeInTheDocument()
  })
})

describe("<ClaimNoJump>", () => {
  const hit = {
    id: "c-9",
    title: "A paper cleared last week",
    subtitle: "",
    url: "/papers/c-9",
    stage: "Cleared",
    review_url: null,
    meta: { ticket_number: "FP-2026-000009" },
  }

  it("offers a claim that is not on screen", async () => {
    vi.mocked(api).mockImplementation(
      fakeApi({ "/api/search/claim-number": () => ({ q: "fp 2026 9", exact: hit, results: [hit] }) })
    )
    renderWithProviders(<ClaimNoJump term="fp 2026 9" />)
    expect(await screen.findByText("FP-2026-000009")).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "Open it" })).toHaveAttribute("href", "/papers/c-9")
  })

  it("asks nothing for text that is not a claim number", async () => {
    vi.mocked(api).mockImplementation(fakeApi({}))
    renderWithProviders(<ClaimNoJump term="fuzzy control" />)
    await new Promise((r) => setTimeout(r, 350))
    expect(vi.mocked(api).mock.calls.filter(([p]) => String(p).includes("claim-number"))).toHaveLength(0)
  })

  it("stays quiet when the claim is already on screen", async () => {
    vi.mocked(api).mockImplementation(
      fakeApi({ "/api/search/claim-number": () => ({ q: "FP-2026-000009", exact: hit, results: [hit] }) })
    )
    renderWithProviders(<ClaimNoJump term="FP-2026-000009" skip={new Set(["c-9"])} />)
    await waitFor(() => expect(vi.mocked(api).mock.calls.some(([p]) => String(p).includes("claim-number"))).toBe(true))
    expect(screen.queryByRole("link", { name: "Open it" })).toBeNull()
  })
})
