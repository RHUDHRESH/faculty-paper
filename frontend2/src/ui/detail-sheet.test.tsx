import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { useLocation } from "react-router-dom"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return { ...actual, api: vi.fn() }
})

import { api } from "@/lib/api"
import { decodeDetail, DetailHost, DetailLink, encodeDetail } from "@/ui/detail-sheet"
import { FACULTY, fakeApi, renderWithProviders, type ApiTable } from "@/test/harness"

const PAPER = {
  id: "p1",
  title: "Grid inverter control",
  year: 2024,
  type: "Article",
  venue: "World Journal of English Language",
  quartile: "Q1",
  snip: 1.23,
  citations: 5,
  doi: "10.1/x",
  topics: ["Power systems"],
  links: { doi: "https://doi.org/10.1/x", scopus: null, openalex: null, open_access: null },
  authors: [
    { name: "Me Author", position: 1, user_id: "u-me", is_college: true, institution: null },
    { name: "Outside Prof", position: 2, user_id: null, is_college: false, institution: "IIT Madras" },
  ],
  is_author: true,
  mine: { claim_id: null, stage: null, days_waiting: null, eligible: true, ineligible_reason: null },
}

const METRIC = {
  name: "h_index",
  title: "h-index 2",
  explain: "An h-index of 2 means 2 of your papers have at least 2 citations each.",
  count: 2,
  papers: [
    { id: "p1", title: "Grid inverter control", year: 2024, venue: "IEEE Power", quartile: "Q1", citations: 12, position: 1 },
    { id: "p2", title: "Solar harvesting", year: 2025, venue: "IEEE Power", quartile: null, citations: 3, position: 2 },
  ],
}

function Where() {
  const l = useLocation()
  return <output data-testid="where">{l.search}</output>
}

function mount(route = "/research", extra: ApiTable = {}) {
  vi.mocked(api).mockReset()
  vi.mocked(api).mockImplementation(
    fakeApi({
      "/api/auth/me": () => FACULTY,
      "/api/papers/p1/detail": () => PAPER,
      "/api/me/metric/h_index": () => METRIC,
      ...extra,
    })
  )
  renderWithProviders(
    <>
      <DetailLink kind="paper" id="p1">
        Grid inverter control
      </DetailLink>
      <DetailLink kind="metric" metric="h_index" number>
        2
      </DetailLink>
      <DetailLink kind="paper" id="claim-3">
        Known only from a claim
      </DetailLink>
      <DetailHost />
      <Where />
    </>,
    { route }
  )
}

describe("the detail panel", () => {
  it("round-trips its URL form", () => {
    expect(encodeDetail({ kind: "metric", metric: "year", value: 2026 })).toBe("metric:year:2026")
    expect(decodeDetail("metric:topic:solar: energy")).toEqual({ kind: "metric", metric: "topic", value: "solar: energy" })
    expect(decodeDetail("journal:IEEE Access")).toEqual({ kind: "journal", name: "IEEE Access" })
    expect(decodeDetail("nonsense")).toBeNull()
  })

  it("opens from a click, puts itself in the URL, and Escape closes it", async () => {
    const user = userEvent.setup()
    mount()
    await user.click(screen.getByRole("button", { name: "Grid inverter control" }))
    const sheet = await screen.findByRole("dialog")
    expect(screen.getByTestId("where").textContent).toBe("?detail=paper%3Ap1")
    expect(await within(sheet).findByRole("heading", { name: "Grid inverter control" })).toBeInTheDocument()
    await user.keyboard("{Escape}")
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
    expect(screen.getByTestId("where").textContent).toBe("")
  })

  it("opens from the URL parameter, so a link to it can be shared", async () => {
    mount("/research?detail=paper:p1")
    const sheet = await screen.findByRole("dialog")
    expect(await within(sheet).findByRole("heading", { name: "Grid inverter control" })).toBeInTheDocument()
  })

  it("shows a paper's authors, with college ones linked, and its journal as a link", async () => {
    mount("/research?detail=paper:p1")
    const sheet = await screen.findByRole("dialog")
    expect(await within(sheet).findByRole("link", { name: "Me Author" })).toHaveAttribute("href", "/u/u-me")
    expect(within(sheet).getByText("Outside Prof")).toBeInTheDocument()
    expect(within(sheet).getByRole("button", { name: "World Journal of English Language" })).toBeInTheDocument()
    expect(within(sheet).getByRole("link", { name: "File it" })).toHaveAttribute("href", "/papers/new?publication=p1")
    expect(sheet.textContent).not.toMatch(/₹/)
  })

  it("lists the papers behind a number, each one opening", async () => {
    const user = userEvent.setup()
    mount()
    await user.click(screen.getByRole("button", { name: "2" }))
    const sheet = await screen.findByRole("dialog")
    expect(await within(sheet).findByRole("heading", { name: "h-index 2" })).toBeInTheDocument()
    expect(within(sheet).getByText(/at least 2 citations each/)).toBeInTheDocument()
    expect(within(sheet).getByRole("button", { name: "Grid inverter control" })).toBeInTheDocument()
    expect(within(sheet).getByRole("button", { name: "Solar harvesting" })).toBeInTheDocument()
  })

  it("leaves a paper with no record to open as plain text", () => {
    mount()
    expect(screen.getByText("Known only from a claim").tagName).toBe("SPAN")
  })
})
