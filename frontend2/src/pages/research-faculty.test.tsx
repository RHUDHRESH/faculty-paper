import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { api } from "@/lib/api"
import { ResearchFaculty } from "@/pages/research-faculty"
import { claimThresholdSentence, thresholdFlag } from "@/ui/research-threshold"
import { fakeApi, renderWithProviders } from "@/test/harness"

vi.mock("@/lib/api", async (orig) => {
  const real = await orig<typeof import("@/lib/api")>()
  return { ...real, api: vi.fn() }
})

const COORDINATOR = {
  id: "u-rc",
  email: "rc@example.edu",
  name: "Research Coordinator",
  role: "RESEARCH_COORDINATOR",
  welcome_seen: true,
}

const LIST = {
  year: "2026-27",
  year_start: "2026-06-01",
  year_end: "2027-06-01",
  count: 2,
  unset_count: 1,
  old_rule_count: 1,
  rows: [
    {
      user_id: "u-a",
      name: "Dr Asha Menon",
      initials: "AM",
      photo_url: null,
      department: "EEE",
      designation: "Professor",
      threshold: 300000,
      unset: false,
      used: 120000,
      left: 180000,
      on_the_way: 100000,
      on_the_way_above: 46000,
      year: "2026-27",
      old_quota: null,
      needs_rupee_threshold: false,
      set_by: "Research Coordinator",
      set_at: "2026-09-01T10:00:00Z",
      effective_from: "2026-09-01",
      note: "Agreed at appointment",
    },
    {
      user_id: "u-b",
      name: "Dr Ravi Kumar",
      initials: "RK",
      photo_url: null,
      department: "CSE",
      designation: null,
      threshold: null,
      unset: true,
      used: 0,
      left: null,
      on_the_way: 0,
      on_the_way_above: 0,
      year: "2026-27",
      old_quota: 4,
      needs_rupee_threshold: true,
      set_by: null,
      set_at: null,
      effective_from: null,
      note: null,
    },
  ],
}

beforeEach(() => {
  vi.mocked(api).mockReset()
  vi.mocked(api).mockImplementation(
    fakeApi({
      "/api/auth/me": () => COORDINATOR,
      "/api/research-faculty/u-b/threshold": () => ({
        research: true,
        threshold: null,
        unset: true,
        year: "2026-27",
        used: 0,
        left: null,
        on_the_way: 0,
        on_the_way_above: 0,
        old_quota: 4,
        needs_rupee_threshold: true,
        history: [],
      }),
      "/api/research-faculty": () => LIST,
    })
  )
})

describe("Research faculty list", () => {
  it("lists each person with threshold, used and left, and warns about the unset", async () => {
    renderWithProviders(<ResearchFaculty />, { route: "/research-faculty" })
    const asha = (await screen.findByText("Dr Asha Menon")).closest("li")!
    expect(within(asha).getByText("₹3,00,000")).toBeInTheDocument()
    expect(within(asha).getByText("₹1,20,000")).toBeInTheDocument()
    expect(within(asha).getByText("₹1,80,000")).toBeInTheDocument()
    expect(
      within(asha).getByText(/On the way, not used yet: would use ₹1,00,000; ₹46,000 above it would be paid/)
    ).toBeInTheDocument()
    expect(within(asha).getByRole("link", { name: "Dr Asha Menon" })).toHaveAttribute("href", "/faculty/u-a")
    expect(within(asha).getByText(/Agreed at appointment/)).toBeInTheDocument()

    const ravi = screen.getByText("Dr Ravi Kumar").closest("li")!
    expect(within(ravi).getByText("Not set")).toBeInTheDocument()
    expect(within(ravi).getByText(/Old rule: 4 papers a year. Please set a rupee threshold/)).toBeInTheDocument()
    expect(screen.getByText("1 person has no threshold set")).toBeInTheDocument()
  })

  it("sets a threshold with a note", async () => {
    const user = userEvent.setup()
    renderWithProviders(<ResearchFaculty />, { route: "/research-faculty" })
    const ravi = (await screen.findByText("Dr Ravi Kumar")).closest("li")!
    await user.click(within(ravi).getByRole("button", { name: /Set threshold/ }))
    const dialog = await screen.findByRole("dialog")
    await user.type(await within(dialog).findByLabelText(/Threshold a year/), "300000")
    await user.type(within(dialog).getByLabelText("Note"), "Appointment letter")
    await user.click(within(dialog).getByRole("button", { name: "Save threshold" }))
    await waitFor(() =>
      expect(
        vi
          .mocked(api)
          .mock.calls.filter(([p, o]) => p === "/api/research-faculty/u-b/threshold" && (o as { method?: string })?.method === "PUT")
      ).toHaveLength(1)
    )
    const put = vi
      .mocked(api)
      .mock.calls.find(([, o]) => (o as { method?: string })?.method === "PUT")![1] as { json: Record<string, unknown> }
    expect(put.json).toMatchObject({ amount: 300000, note: "Appointment letter" })
  })
})

describe("how a claim says what the threshold did", () => {
  it("says inside, crossing and nothing in plain words", () => {
    const inside = { threshold_absorbed: 100000, threshold_full_amount: 100000, remuneration: 0 }
    expect(thresholdFlag(inside)).toBe("Inside research threshold")
    expect(claimThresholdSentence(inside, true)).toBe(
      "Inside your research threshold. The ₹1,00,000 counts against your yearly threshold, so nothing is paid on this claim."
    )
    const crossing = { threshold_absorbed: 60000, threshold_full_amount: 100000, remuneration: 40000 }
    expect(thresholdFlag(crossing)).toBe("Part inside research threshold")
    expect(claimThresholdSentence(crossing, false)).toBe(
      "This claim crosses the research threshold. ₹60,000 of its ₹1,00,000 counts against it, and ₹40,000 above it is paid."
    )
    expect(thresholdFlag({ threshold_absorbed: 0, threshold_full_amount: 100000, remuneration: 100000 })).toBeNull()
  })
})
