import { screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return { ...actual, api: vi.fn() }
})

import { api } from "@/lib/api"
import { DepartmentGlance, type Brief, type BriefPerson } from "@/pages/department-glance"
import { HOD, fakeApi, renderWithProviders } from "@/test/harness"

const person = (id: string, name: string, extra: Partial<BriefPerson> = {}): BriefPerson => ({
  id, name, designation: "Assistant Professor", photo_url: null, is_you: false,
  this_year: 0, last_year: 2, q1_this_year: 0, led_this_year: 0, total: 5,
  last_year_published: 2025, area: "Optics", target: null, last_reminded_at: null, ...extra,
})

const quiet = person("p1", "Asha Quiet")
const star = person("p2", "Ravi Star", { this_year: 6, q1_this_year: 3 })

const BRIEF: Brief = {
  department: "Physics", year: 2026, as_of: "2026-09-28", elapsed: 0.74,
  totals: {
    publications: 6, q1: 3, first_author: 4, faculty: 2, faculty_published: 1, per_teacher: 3,
    last_year_full: 9, last_year_to_date: 7, this_year_to_date: 6, rejected_outright: 1,
    missing_issn_or_doi: 0,
  },
  targets: [{ metric: "PUBLICATIONS", label: "Publications", target: 20, done: 6,
    expected_by_now: 14.8, verdict: "behind", due_date: null }],
  by_year: [2022, 2023, 2024, 2025, 2026].map((y) => ({ year: y, publications: 5, q1: 2, partial: y === 2026 })),
  people: [quiet, star],
  push: [{ person: quiet, reasons: ["Nothing in 2026; 2 in 2025"] }],
  pairs: [{ mentee: quiet, mentor: star, area: "Optics", why: "Both in Optics." }],
  years: [2026, 2025],
}

describe("DepartmentGlance", () => {
  it("answers on track, push and pairing, with downloads and no money", async () => {
    const calls: { path: string; body?: unknown }[] = []
    const fake = fakeApi({
      "/api/auth/me": () => HOD,
      "/api/hod/brief": () => BRIEF,
      "/api/hod/nudge": () => ({ sent: 1, skipped: [] }),
    })
    vi.mocked(api).mockImplementation(((path: string, opts?: { json?: unknown }) => {
      calls.push({ path, body: opts?.json })
      return fake(path)
    }) as typeof api)

    renderWithProviders(<DepartmentGlance year={2026} />)
    expect(await screen.findByText("Behind")).toBeInTheDocument()
    expect(screen.getByRole("link", { name: /Report for the Principal/ })).toHaveAttribute(
      "href", "/api/hod/report?fmt=pdf&year=2026"
    )
    expect(screen.getByRole("link", { name: /NAAC workbook/ })).toHaveAttribute(
      "href", "/api/hod/report?fmt=xlsx&year=2026"
    )
    expect(screen.getByText(/Both in Optics/)).toBeInTheDocument()
    expect(document.body.textContent).not.toMatch(/₹|Rs\./)

    await userEvent.click(screen.getByRole("button", { name: "Remind Asha Quiet" }))
    await waitFor(() => expect(calls.some((c) => c.path === "/api/hod/nudge")).toBe(true))
    const nudge = calls.find((c) => c.path === "/api/hod/nudge")!.body as { user_ids: string[] }
    expect(nudge.user_ids).toEqual(["p1"])
    expect(await screen.findByRole("button", { name: "Asha Quiet reminded" })).toBeDisabled()
  })
})
