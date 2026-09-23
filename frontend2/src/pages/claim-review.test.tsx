import { screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return { ...actual, api: vi.fn() }
})

import type { Me } from "@/app/auth"
import { api } from "@/lib/api"
import {
  ClaimFlagsPanel,
  FileCheckLine,
  checkSummary,
  useClaimReview,
  type FileCheck,
} from "@/pages/claim-review"
import { fakeApi, renderWithProviders } from "@/test/harness"

const CELL: Me = {
  id: "u-cell",
  email: "cell@example.edu",
  name: "Ravi",
  role: "RESEARCH_CELL",
  department: null,
}

function check(over: Partial<FileCheck>): FileCheck {
  return {
    id: "c1",
    url: "/media/claims/0123456789abcdef0123456789abcdef.pdf",
    kind: "PUBLISHED_PAPER",
    filename: "paper.pdf",
    outcome: "MATCHED",
    outcome_label: "",
    found: ["title", "doi", "journal", "claimant", "affiliation"],
    missing: [],
    score: 100,
    detail: null,
    text_chars: 3000,
    checked_at: "2026-09-20T10:00:00Z",
    ...over,
  }
}

describe("what a file was found to say", () => {
  it("names what is missing, in words", () => {
    const s = checkSummary(check({ outcome: "MISMATCH", found: ["journal"], missing: ["title", "doi"], score: 33 }))
    expect(s.tone).toBe("critical")
    expect(s.text).toBe("Not found in the file: title and DOI")
  })

  it("says a scan is a scan, not a mismatch", () => {
    const s = checkSummary(check({ outcome: "NO_TEXT", found: [], missing: [], score: null }))
    expect(s.tone).toBe("caution")
    expect(s.text).toMatch(/scanned/)
  })

  it("passes a match quietly, with its score", () => {
    const s = checkSummary(check({}))
    expect(s.tone).toBe("positive")
    expect(s.text).toBe("Matches the claim · 100%")
  })

  it("says a file has not been read, rather than nothing", () => {
    expect(checkSummary(undefined).text).toBe("Not read yet")
  })

  it("names a cited reference's missing affiliation once, not twice", () => {
    renderWithProviders(
      <FileCheckLine
        readable
        check={check({ kind: "SEC_REFERENCE", outcome: "MISMATCH", found: ["reference_title"], missing: ["affiliation"], score: 50 })}
      />
    )
    expect(screen.getByText("Not found in the file: college affiliation")).toBeInTheDocument()
    expect(screen.queryByText(/also missing/)).toBeNull()
  })
})

describe("reading the files again", () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it("keeps asking for the result until the queued read has had time to land", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    vi.mocked(api).mockImplementation(
      fakeApi({
        "/api/auth/me": () => CELL,
        "/api/claims/claim-1/check-files": () => ({ queued: true, file_checks: [] }),
        "/api/claims/claim-1/review": () => ({ flags: [], file_checks: [] }),
      })
    )
    const reviews = () => vi.mocked(api).mock.calls.filter(([p]) => p === "/api/claims/claim-1/review").length
    function Review() {
      const r = useClaimReview("claim-1", true)
      return <ClaimFlagsPanel claimId="claim-1" review={r.data} />
    }
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    renderWithProviders(<Review />)
    await waitFor(() => expect(reviews()).toBe(1))

    await user.click(screen.getByRole("button", { name: /Read the files again/ }))
    // Once straight away, when the queue has not run yet...
    await waitFor(() => expect(reviews()).toBe(2))
    // ...and again later, when it has.
    await vi.advanceTimersByTimeAsync(12_000)
    await waitFor(() => expect(reviews()).toBeGreaterThan(2))
  })
})

describe("the flags panel on a claim", () => {
  it("raises a flag with its kind and note", async () => {
    vi.mocked(api).mockImplementation(
      fakeApi({
        "/api/auth/me": () => CELL,
        "/api/claims/claim-1/flags": () => ({ id: "f-new" }),
      })
    )
    const user = userEvent.setup()
    renderWithProviders(
      <ClaimFlagsPanel claimId="claim-1" review={{ flags: [], file_checks: [] }} />
    )

    expect(screen.getByText("No flags on this claim.")).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Raise a flag" }))
    await user.click(screen.getByRole("radio", { name: /^Amount/ }))
    await user.type(screen.getByLabelText("What looks wrong"), "Paid more than the formula gives")
    await user.click(screen.getByRole("button", { name: "Raise it" }))

    await waitFor(() => {
      const call = vi.mocked(api).mock.calls.find(([p]) => p === "/api/claims/claim-1/flags")
      expect(call?.[1]).toMatchObject({
        method: "POST",
        json: { kind: "AMOUNT", note: "Paid more than the formula gives" },
      })
    })
  })
})
