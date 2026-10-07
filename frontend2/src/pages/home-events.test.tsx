import { screen, waitFor, within } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return { ...actual, api: vi.fn() }
})

import { api, ApiError } from "@/lib/api"
import { CollegeThisMonth, ComingUpEvents } from "@/pages/home-events"
import type { Highlights } from "@/pages/events-model"
import { CALL, CONFERENCE, NOTHING_NEW, SEMINAR, WORKSHOP, highlights, summary } from "@/test/events-fixtures"
import { FACULTY, renderWithProviders } from "@/test/harness"

/**
 * Home is calm: these two draw nothing at all when there is nothing to say,
 * and nothing at all when the request fails, because a card that says "could
 * not load" about seminars on the page everybody lands on is worse than no card.
 */

function mount(ui: React.ReactElement, answers: { summary?: unknown; highlights?: Highlights | "fail" }) {
  vi.mocked(api).mockReset()
  vi.mocked(api).mockImplementation((async (path: string) => {
    if (path === "/api/auth/me") return FACULTY
    if (path.startsWith("/api/events/summary")) {
      if (answers.summary === "fail") throw new ApiError(500, "The server did not answer")
      return answers.summary
    }
    if (path.startsWith("/api/research/highlights")) {
      if (answers.highlights === "fail") throw new ApiError(500, "The server did not answer")
      return answers.highlights
    }
    throw new ApiError(404, `No handler in this test for ${path}`)
  }) as unknown as typeof api)
  return renderWithProviders(ui)
}

describe("Coming up, on Home", () => {
  it("lists the next three, each in a sentence, each opening its details", async () => {
    mount(<ComingUpEvents />, { summary: summary([SEMINAR, WORKSHOP, CALL]) })
    const card = await screen.findByRole("region", { name: "Coming up" })
    const rows = within(card).getAllByRole("link", { name: /./ }).filter((a) => a.getAttribute("href")?.startsWith("/events?event="))
    expect(rows).toHaveLength(3)
    expect(rows[0]).toHaveTextContent("Power electronics for electric vehicles")
    expect(rows[0]).toHaveTextContent("Thursday 8 Oct, 3 pm, Seminar Hall 2")
    expect(rows[0]).toHaveAttribute("href", `/events?event=${SEMINAR.id}`)
    expect(rows[2]).toHaveTextContent("Closes Monday 19 Oct")
    expect(rows[2]).toHaveTextContent("12 days left")
  })

  it("says how many are going when anybody is", async () => {
    mount(<ComingUpEvents />, { summary: summary([SEMINAR, CONFERENCE]) })
    const card = await screen.findByRole("region", { name: "Coming up" })
    expect(card).toHaveTextContent("4 going")
  })

  it("leads to every event", async () => {
    mount(<ComingUpEvents />, { summary: summary([SEMINAR]) })
    const card = await screen.findByRole("region", { name: "Coming up" })
    expect(within(card).getByRole("link", { name: "All events" })).toHaveAttribute("href", "/events")
  })

  it("draws nothing when nothing is coming", async () => {
    const { container } = mount(<ComingUpEvents />, { summary: summary([]) })
    await waitFor(() => expect(vi.mocked(api)).toHaveBeenCalledWith(expect.stringContaining("/api/events/summary")))
    await new Promise((r) => setTimeout(r, 30))
    expect(container.querySelector("section")).toBeNull()
    expect(screen.queryByText("Coming up")).toBeNull()
  })

  it("draws nothing when the request fails", async () => {
    const { container } = mount(<ComingUpEvents />, { summary: "fail" })
    await waitFor(() => expect(vi.mocked(api)).toHaveBeenCalledWith(expect.stringContaining("/api/events/summary")))
    await new Promise((r) => setTimeout(r, 30))
    expect(container.querySelector("section")).toBeNull()
    expect(screen.queryByText(/could not load/i)).toBeNull()
  })
})

describe("In the college this month, on Home", () => {
  it("says it in one line and leads to the showcase for the same month", async () => {
    mount(<CollegeThisMonth />, { highlights: highlights({ period: "month", label: "Past month" }) })
    const line = await screen.findByRole("region", { name: "In the college this month" })
    expect(line).toHaveTextContent("28 new papers in the past month, 3 of them in Q1 journals, by 30 colleagues.")
    expect(within(line).getByRole("link", { name: "See the research showcase" })).toHaveAttribute(
      "href",
      "/events?view=research&period=month"
    )
  })

  it("asks only for the month", async () => {
    mount(<CollegeThisMonth />, { highlights: highlights({ period: "month", label: "Past month" }) })
    await screen.findByRole("region", { name: "In the college this month" })
    expect(vi.mocked(api)).toHaveBeenCalledWith(expect.stringContaining("/api/research/highlights?period=month"))
  })

  it("draws nothing when there is nothing new, or when the request fails", async () => {
    const { container, unmount } = mount(<CollegeThisMonth />, { highlights: NOTHING_NEW })
    await waitFor(() => expect(vi.mocked(api)).toHaveBeenCalledWith(expect.stringContaining("/api/research/highlights")))
    await new Promise((r) => setTimeout(r, 30))
    expect(container.querySelector("section")).toBeNull()
    unmount()
    const again = mount(<CollegeThisMonth />, { highlights: "fail" })
    await waitFor(() => expect(vi.mocked(api)).toHaveBeenCalledWith(expect.stringContaining("/api/research/highlights")))
    await new Promise((r) => setTimeout(r, 30))
    expect(again.container.querySelector("section")).toBeNull()
  })
})
