import type { ComponentType } from "react"
import { render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return { ...actual, api: vi.fn() }
})

/**
 * Every point the page hands to a chart, recorded on the way past.
 *
 * `vi.hoisted` because a `vi.mock` factory is lifted above the imports and
 * would otherwise close over a `const` that has not been initialised yet.
 */
const { chartPoints } = vi.hoisted(() => ({
  chartPoints: [] as { key: string; count: number; amount?: number }[],
}))

/**
 * The real charts, with a tap on the wire.
 *
 * Asserting on the rendered page cannot tell the two money guards apart. The
 * HOD branch strips the amount off every point *and* passes `showAmounts=
 * false`, so weakening either one alone leaves the other holding the rule and
 * nothing visible changes — which is what defence in depth is for, and also
 * what makes a pixel-level assertion unable to fail. The property that must
 * hold is about the object: a point handed to a chart on that screen carries
 * no `amount` key at all. So the components are wrapped rather than replaced,
 * every chart still renders for real, and the points are inspected directly.
 */
vi.mock("@/ui/chart", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/ui/chart")>()
  type WithPoints = { points: { key: string; count: number; amount?: number }[] }
  const tap = <P extends WithPoints>(Real: ComponentType<P>) =>
    function Tapped(props: P) {
      chartPoints.push(...props.points)
      return <Real {...props} />
    }
  return {
    ...actual,
    RankedBars: tap(actual.RankedBars),
    MixBar: tap(actual.MixBar),
    Trend: tap(actual.Trend),
    Distribution: tap(actual.Distribution),
  }
})

import type { Me } from "@/app/auth"
import { api } from "@/lib/api"
import { Reports } from "@/pages/reports"
import { DATA_GAP_THRESHOLD, RankedBars } from "@/ui/chart"
import { FINANCE, fakeApi, failing, renderWithProviders } from "@/test/harness"

beforeEach(() => {
  chartPoints.length = 0
})

/**
 * The report screen, and the two rules it is the easiest place in the app to
 * break.
 *
 * The first is money-blindness. A head of department must never see a rupee
 * figure, and the way that broke was not a missing check — it was a passing
 * one. `/api/hod/overview` builds every breakdown row with `"amount": 0`
 * (`backend/core/api.py`), `Figure` in `@/ui/chart` decides whether to print
 * its "Paid" column with `points.some((p) => p.amount != null)`, and zero is
 * not null. A ₹0 column appeared on four charts of a screen whose own
 * docstring said the amounts had been stripped. A typecheck, a route audit,
 * the backend suite and an end-to-end sweep of the same page all passed. The
 * sweep below is what catches it, and it is written over the whole rendered
 * document rather than over one named chart so that it keeps working when
 * somebody adds a fifth.
 *
 * The second is the data-gap guard: a breakdown that is almost all "not
 * recorded" must not be drawn, and the numbers behind it must still be. Both
 * halves are asserted, because a later change that suppressed the table along
 * with the chart would look like a tidy-up and would delete the only honest
 * thing left on the panel.
 */

const HOD: Me = {
  id: "u-hod",
  email: "hod@example.edu",
  name: "Dr V Raman",
  role: "HOD",
  department: "ECE",
}

/** Every `<th>` on the page, which is where a money column shows up first. */
const columnHeaders = () =>
  Array.from(document.querySelectorAll("th")).map((th) => (th.textContent ?? "").trim())

/* ------------------------------------------------------------------------ */
/* What the server actually sends                                            */
/* ------------------------------------------------------------------------ */

/** Shaped exactly like `hod_overview`: `amount: 0` on every row of every
 *  breakdown. That placeholder is the bug, so the fixture keeps it. */
const HOD_OVERVIEW = {
  department: "ECE",
  years_on_record: [2024, 2023],
  totals: {
    publications: 312,
    faculty_in_department: 40,
    faculty_who_published: 22,
    q1: 10,
    first_author: 8,
    under_review: 3,
  },
  by_year: [
    { key: "2023", count: 12, amount: 0 },
    { key: "2024", count: 300, amount: 0 },
  ],
  by_quartile: [
    { key: "Q1", count: 10, amount: 0 },
    { key: "Q2", count: 302, amount: 0 },
  ],
  by_type: [{ key: "Journal", count: 312, amount: 0 }],
  by_journal: [{ key: "IEEE Access", count: 40, amount: 0 }],
  by_indexing: [{ key: "Scopus", count: 300, amount: 0 }],
  people: [
    { id: "p1", name: "A Kumar", designation: null, publications: 200, first_author: 1, q1: 1 },
    { id: "p2", name: "B Selvi", designation: null, publications: 112, first_author: 1, q1: 1 },
  ],
}

const REPORTS = {
  totals: {
    publications: 3227,
    count_only: 0,
    paid_claims: 3138,
    paid_amount: 28_000_000,
    awaiting_payment: 18,
    committed_amount: 0,
  },
  by_department: [{ key: "ECE", count: 900, amount: 1 }],
  by_quartile: [
    { key: "Q1", count: 341, amount: 1 },
    { key: "Q4", count: 488, amount: 1 },
  ],
  by_month: [],
  by_journal: { rows: [], hidden: 0, hidden_count: 0, hidden_amount: 0 },
  top_by_publications: { rows: [], hidden: 0, hidden_count: 0, hidden_amount: 0 },
  top_by_amount: { rows: [], hidden: 0, hidden_count: 0, hidden_amount: 0 },
  per_paper: { count: 1, mean: 1, median: 1, min: 1, max: 1 },
  pipeline: [],
  ageing: { rows: [], oldest_days: 57, total: 89 },
  breadth: [
    // 2019 holds one paper by one person, so its top-ten share is 100% by
    // arithmetic. It must be listed and must not be the baseline.
    { key: "2019", count: 1, people: 1, per_person: 1, top_ten_share: 100 },
    { key: "2023", count: 140, people: 73, per_person: 1.92, top_ten_share: 29 },
    { key: "2026", count: 675, people: 207, per_person: 3.26, top_ten_share: 21 },
  ],
  year_on_year: {
    this_year: 2024,
    last_year: 2023,
    this_year_is_partial: false,
    months_elapsed: 12,
    // 300 against 12 is not a 2,400% rise, it is where the import stops.
    rows: [{ key: "ECE", count: 300, previous: 12, change: 288, percent: 2400 }],
  },
  years: [2026],
  payout_months: [],
}

const WAITING = {
  id: "c1",
  ticket_number: "PUB-1",
  paper_title: "Random Forest Assisted Floorplanning",
  journal_title: null,
  owner_name: "Dr A Kumar",
  owner_department: "ECE",
  publication_year: 2026,
  status: "SUBMITTED",
  remuneration: null,
  remuneration_is_estimate: false,
  calc_error: null,
  updated_at: null,
  waiting_days: 57,
}

const COLLEGE_API = {
  "/api/auth/me": () => FINANCE,
  "/api/reports/search": (path: string) =>
    path.includes("status=SUBMITTED")
      ? { total: 1, total_amount: 0, results: [WAITING] }
      : { total: 0, total_amount: 0, results: [] },
  "/api/reports/areas": () => ({
    areas: [],
    distinct: 0,
    shown: 0,
    coverage: { classified: 0, total: 0, unclassified: 0, fraction: 0 },
  }),
  "/api/reports": () => REPORTS,
  "/api/meta/departments": () => ["ECE"],
  "/api/trends/me": () => ({
    college: {
      window: {
        latest_year: 2026,
        recent_from: 2024,
        recent_to: 2026,
        prior_from: 2021,
        prior_to: 2023,
      },
      totals: {
        papers: 3029,
        papers_prior: 140,
        comparable: false,
        not_comparable_why:
          "Only 140 papers are recorded for 2021-2023, against 3029 since 2024.",
      },
    },
  }),
}

const hodApi = () =>
  fakeApi({
    "/api/auth/me": () => HOD,
    "/api/hod/overview": () => HOD_OVERVIEW,
  }) as typeof api

/* ------------------------------------------------------------------------ */
/* Money-blindness                                                           */
/* ------------------------------------------------------------------------ */

describe("a head of department is shown no money, by any route", () => {
  it("renders no rupee sign anywhere in the document", async () => {
    vi.mocked(api).mockImplementation(hodApi())
    renderWithProviders(<Reports />, { route: "/reports" })

    await waitFor(() => expect(screen.getByText(/ECE — publications/)).toBeInTheDocument())

    // Deliberately the whole document rather than a named chart. The rule is
    // "not by any route", and a per-chart assertion only ever covers the
    // charts that existed on the day it was written.
    expect(document.body.textContent).not.toMatch(/₹/)
  })

  it("gives no chart a Paid column, because the amount never reaches one", async () => {
    vi.mocked(api).mockImplementation(hodApi())
    renderWithProviders(<Reports />, { route: "/reports" })

    await waitFor(() => expect(screen.getByText(/ECE — publications/)).toBeInTheDocument())

    // Not vacuous: the numbers tables are there, they simply have no money
    // column in them.
    expect(columnHeaders()).toContain("Papers")
    expect(columnHeaders()).not.toContain("Paid")
  })

  it("hands every chart a point with no amount key at all", async () => {
    vi.mocked(api).mockImplementation(hodApi())
    renderWithProviders(<Reports />, { route: "/reports" })

    await waitFor(() => expect(screen.getByText(/ECE — publications/)).toBeInTheDocument())

    // The fixture carries `amount: 0` on every row, exactly as the server
    // does, so this can only pass if the page took the key off.
    expect(chartPoints.length).toBeGreaterThan(0)
    const carrying = chartPoints.filter((p) => Object.hasOwn(p, "amount"))
    expect(carrying).toEqual([])

    // `toBeFalsy` is the assertion that would have let the original bug
    // through, and it is written out here so nobody reaches for it later:
    // zero is falsy, and zero was the leak.
    expect(chartPoints.every((p) => !p.amount)).toBe(true)
  })

  it("draws a failed overview as an error, not as a department with nothing in it", async () => {
    vi.mocked(api).mockImplementation(
      fakeApi({ "/api/auth/me": () => HOD, "/api/hod/overview": failing(500) }) as typeof api
    )
    renderWithProviders(<Reports />, { route: "/reports" })

    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument())
    expect(screen.getByText(/Could not load the report/)).toBeInTheDocument()
    expect(screen.queryByText(/Nothing recorded yet/)).toBeNull()
  })
})

describe("zero is not null", () => {
  /**
   * The trap, made executable.
   *
   * `Figure` prints a money column for `amount: 0`, and that is correct — a
   * report where nothing has been paid yet should still show the column. It
   * is also precisely why the HOD branch cannot fix its leak by zeroing the
   * amount: the key has to be absent. This pair pins that. The test above
   * proves nothing reaches the gate; this one proves the gate would let it
   * through if it did.
   *
   * Written as `expect(point.amount).toBeFalsy()`, a test of this passes on
   * the bug.
   */
  it("a point carrying amount: 0 still gets a Paid column", () => {
    render(
      <RankedBars
        title="By year"
        dimension="Year"
        points={[{ key: "2024", count: 300, amount: 0 }]}
      />
    )
    expect(columnHeaders()).toContain("Paid")
  })

  it("the same point with the amount stripped does not", () => {
    render(<RankedBars title="By year" dimension="Year" points={[{ key: "2024", count: 300 }]} />)
    expect(columnHeaders()).toContain("Papers")
    expect(columnHeaders()).not.toContain("Paid")
  })
})

/* ------------------------------------------------------------------------ */
/* The data-gap guard                                                        */
/* ------------------------------------------------------------------------ */

describe("a breakdown that is almost all 'not recorded'", () => {
  /**
   * The counts below are literals on purpose.
   *
   * Deriving them from `DATA_GAP_THRESHOLD` would make the test move with the
   * constant, which is the one thing it must not do — a threshold quietly
   * raised to 0.99 so that somebody's chart draws again would sail through a
   * self-adjusting test. 90 of 100 must be refused and 89 of 100 must be
   * drawn, whatever the constant has been changed to say.
   */
  it("is refused at nine in ten", () => {
    render(
      <RankedBars
        title="Payout category"
        dimension="Payout category"
        points={[
          { key: "Not recorded", count: 90 },
          { key: "Category I", count: 10 },
        ]}
      />
    )
    expect(screen.getByText(/gap in the data, not a breakdown/i)).toBeInTheDocument()
    // The drawing itself is gone. The bar list is the only `<ul>` on this
    // panel; neither the notice nor the numbers table renders one.
    expect(document.querySelectorAll("ul")).toHaveLength(0)
  })

  it("is still drawn just under it", () => {
    render(
      <RankedBars
        title="Payout category"
        dimension="Payout category"
        points={[
          { key: "Not recorded", count: 89 },
          { key: "Category I", count: 11 },
        ]}
      />
    )
    expect(screen.queryByText(/gap in the data, not a breakdown/i)).toBeNull()
    expect(document.querySelectorAll("ul")).toHaveLength(1)
  })

  it("is pinned at nine in ten", () => {
    expect(DATA_GAP_THRESHOLD).toBe(0.9)
  })

  it("keeps the numbers even when it will not draw them", () => {
    render(
      <RankedBars
        title="Payout category"
        dimension="Payout category"
        points={[
          { key: "Not recorded", count: 3208 },
          { key: "Category I", count: 11 },
          { key: "Category II", count: 8 },
        ]}
      />
    )
    // "3,208 not recorded, 11 category I, 8 category II" is a true and useful
    // set of rows. Only the picture of it lies, so only the picture is
    // withheld.
    expect(screen.getByText("Show the numbers")).toBeInTheDocument()
    expect(columnHeaders()).toEqual(["Payout category", "Papers", "Share"])
    const cells = Array.from(document.querySelectorAll("td")).map((td) => td.textContent)
    expect(cells).toContain("3,208")
    expect(cells).toContain("Category II")
  })

  it("says how much is missing without rounding the exception away", () => {
    // 3,216 of 3,226 is 99.69%, and these counts are chosen because that is
    // the case where an ordinary `Math.round` prints "100%" — erasing the ten
    // records that do carry the value and turning "almost none" into a claim
    // of "none at all". A fixture that rounds to 99 either way would let the
    // cap be deleted without a test noticing.
    render(
      <RankedBars
        title="Payout category"
        dimension="Payout category"
        points={[
          { key: "Not recorded", count: 3216 },
          { key: "Category I", count: 10 },
        ]}
      />
    )
    expect(screen.getByText(/99%/)).toBeInTheDocument()
    expect(screen.queryByText(/100%/)).toBeNull()
    expect(screen.getByText(/10 carry a value/)).toBeInTheDocument()
  })

  it("counts a row as absent by the words the server actually uses", () => {
    // The API names a blank differently per column — "Not recorded", "Not
    // calculated", "No quartile", "Unclassified" — and a guard that knows only
    // some of those words is a guard that is not there on the other columns.
    for (const blank of ["Not recorded", "Not calculated", "No quartile", "Unclassified"]) {
      const { unmount } = render(
        <RankedBars
          title="A breakdown"
          dimension="A breakdown"
          points={[
            { key: blank, count: 95 },
            { key: "A real value", count: 5 },
          ]}
        />
      )
      expect(screen.getByText(/gap in the data, not a breakdown/i)).toBeInTheDocument()
      unmount()
    }
  })
})

/* ------------------------------------------------------------------------ */
/* The three cuts                                                            */
/* ------------------------------------------------------------------------ */

describe("the three questions a review meeting asks", () => {
  it("names what is stuck, at which desk, for how long", async () => {
    vi.mocked(api).mockImplementation(fakeApi(COLLEGE_API) as typeof api)
    renderWithProviders(<Reports />, { route: "/reports" })

    await waitFor(() =>
      expect(screen.getByText(/Random Forest Assisted Floorplanning/)).toBeInTheDocument()
    )
    // A bucket says there is a problem. Only a ticket, a desk and a number of
    // days can be chased.
    expect(screen.getByText("57 days")).toBeInTheDocument()
    expect(screen.getByText(/The research cell/)).toBeInTheDocument()
  })

  it("measures concentration from a year holding enough papers to have one", async () => {
    vi.mocked(api).mockImplementation(fakeApi(COLLEGE_API) as typeof api)
    renderWithProviders(<Reports />, { route: "/reports" })

    await waitFor(() => expect(screen.getByText(/ten most prolific authors/)).toBeInTheDocument())
    // 2019 is listed and is not the baseline: a top-ten share out of one
    // paper is 100% whatever happened.
    expect(screen.getByText(/fallen from 29% in 2023 to 21% in 2026/)).toBeInTheDocument()
  })

  it("refuses a direction when the earlier window was never populated", async () => {
    vi.mocked(api).mockImplementation(fakeApi(COLLEGE_API) as typeof api)
    renderWithProviders(<Reports />, { route: "/reports" })

    await waitFor(() =>
      expect(screen.getByText(/Only 140 papers are recorded for 2021-2023/)).toBeInTheDocument()
    )
    // And the same refusal applied to the pair actually on screen: ECE went
    // 12 -> 300 because 2023 is the edge of the import, not because it grew
    // by 2,400%.
    expect(screen.getByText(/the earlier year is not an earlier year/i)).toBeInTheDocument()
    expect(screen.queryByText(/2400%/)).toBeNull()
    expect(screen.getByText(/12 in 2023/)).toBeInTheDocument()
  })

  it("refuses it for one department even when the two years as a whole hold up", async () => {
    // The panel-level test above cannot see the per-row guard, because the
    // pair it uses fails the whole-panel test first and every row is withheld
    // anyway. This is the case that separates them: 330 against 281 is a real
    // comparison, ECE genuinely went up 20 — and AI&DS did not go up 2,900%,
    // it had one paper on record for 2023.
    vi.mocked(api).mockImplementation(
      fakeApi({
        ...COLLEGE_API,
        "/api/reports": () => ({
          ...REPORTS,
          year_on_year: {
            this_year: 2024,
            last_year: 2023,
            this_year_is_partial: false,
            months_elapsed: 12,
            rows: [
              { key: "ECE", count: 300, previous: 280, change: 20, percent: 7 },
              { key: "AI&DS", count: 30, previous: 1, change: 29, percent: 2900 },
            ],
          },
        }),
      }) as typeof api
    )
    renderWithProviders(<Reports />, { route: "/reports" })

    await waitFor(() => expect(screen.getByText(/\+20 \(\+7%\)/)).toBeInTheDocument())
    expect(screen.queryByText(/2900%/)).toBeNull()
    expect(screen.getByText(/1 in 2023/)).toBeInTheDocument()
    // And the whole-panel refusal is correctly absent this time.
    expect(screen.queryByText(/the earlier year is not an earlier year/i)).toBeNull()
  })
})
