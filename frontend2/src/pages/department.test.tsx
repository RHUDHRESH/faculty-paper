import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return { ...actual, api: vi.fn() }
})

import { api } from "@/lib/api"
import { Department } from "@/pages/department"
import { HOD, failing, fakeApi, renderWithProviders, type ApiTable } from "@/test/harness"

/**
 * A head of department's own page: four tabs, one question each. The planning
 * tab (vision, work handed out, targets with a deadline) and the reminder are
 * exercised here, and so are the rules the screen must show: the head is
 * money-blind, so no rupee figure may appear anywhere on it, and no other
 * department is named.
 */

const TARGET = {
  id: "t1", year: 2026, metric: "Q1", metric_label: "Q1 publications", target: 4, done: 1, remaining: 3,
  fraction: 0.25, met: false, person_id: null, person_name: null, note: null, due_date: "2026-12-31",
  set_by: "Dr Meera Pillai",
}

const TARGETS = {
  department: "Physics", year: 2026, department_targets: [TARGET], personal_targets: [],
  metrics: [{ key: "PUBLICATIONS", label: "Publications" }, { key: "Q1", label: "Q1 publications" }],
  years: [2026],
}

const person = (id: string, name: string, over: Record<string, unknown> = {}) => ({
  id, name, designation: "Assistant Professor", photo_url: null, is_you: false,
  this_year: 1, last_year: 1, q1_this_year: 0, led_this_year: 0, total: 3,
  last_year_published: 2026, area: null, has_scopus_id: true, target: null, last_reminded_at: null,
  ...over,
})

const ASHA = person("u1", "Asha Physicist", { this_year: 2 })
const RAVI = person("u2", "Ravi Physicist")
const QUIET = person("u3", "Quiet Physicist", { this_year: 0, last_year: 2 })

const BRIEF = {
  department: "Physics", year: 2026, as_of: "2026-09-28", elapsed: 0.74, months_left: 3,
  totals: {
    publications: 3, q1: 0, quartile_known: 2, first_author: 0, faculty: 3, faculty_published: 2, silent: 1,
    per_teacher: 1, last_year_full: 4, last_year_to_date: 3, this_year_to_date: 3,
    missing_doi: 1, missing_issn: 2, missing_issn_or_doi: 2, record_papers: 3, scopus_indexed: 2, without_scopus_id: 1,
  },
  college: { per_teacher: 2.7, papers: 100, top_quartile_share: 50, rank: 2, of: 5 },
  targets: [{
    metric: "Q1", label: "Q1 publications", target: 4, done: 1, expected_by_now: 2.96, verdict: "behind",
    due_date: "2026-12-31", to_go: 3, months_left: 3, per_month_needed: 1,
  }],
  by_year: [
    { year: 2025, publications: 4, q1: 1, partial: false },
    { year: 2026, publications: 3, q1: 0, partial: true },
  ],
  people: [ASHA, RAVI, QUIET],
  push: [{
    person: QUIET, reasons: ["No paper in 2026; 2 in 2025"], kind: "slipped",
    next_step: "Ask what is in progress and remind them to file it.",
    draft: "A reminder from your head of department: you had 2 papers in 2025 and none for 2026.",
  }],
  pairs: [], years: [2026, 2025],
}

const RECORDS = {
  department: "Physics", years: [2022, 2023, 2024, 2025, 2026], papers_checked: 40,
  papers: [{ id: "pub1", title: "A paper with no DOI", journal: "Journal of Tests", year: 2026, authors: ["Asha Physicist"], missing: ["DOI"] }],
  no_scopus_id: [{ id: "u3", name: "Quiet Physicist", designation: "Assistant Professor", photo_url: null }],
}

const PLAN = {
  department: "Physics",
  vision: "A department industry reads for condensed-matter work.",
  research_areas: ["Photonics", "Condensed matter"],
  updated_by: "Dr Meera Pillai",
  updated_at: "2026-09-01T00:00:00Z",
}

function assignment(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: "a1", department: "Physics", kind: "TASK", kind_label: "Task", title: "Draft the NAAC criterion 3 narrative",
    notes: "", status: "OPEN", status_label: "Open", assignee_id: "u1", assignee_name: "Asha Physicist",
    partner_id: null, partner_name: null, due_date: null, set_by: "Dr Meera Pillai",
    created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-01T00:00:00Z", ...over,
  }
}

function mount(over: ApiTable = {}, route = "/department?tab=plan") {
  vi.mocked(api).mockReset()
  vi.mocked(api).mockImplementation(
    fakeApi({
      "/api/auth/me": () => HOD,
      "/api/hod/brief": () => BRIEF,
      "/api/hod/targets": () => TARGETS,
      "/api/hod/plan": () => PLAN,
      "/api/hod/assignments": () => [],
      "/api/hod/department/records": () => RECORDS,
      ...over,
    })
  )
  return renderWithProviders(<Department />, { route })
}

/** Every call the page made to one path, with the options it sent. */
function callsTo(path: string, method?: string) {
  return vi.mocked(api).mock.calls.filter(
    ([p, options]) => p === path && (!method || (options as { method?: string } | undefined)?.method === method)
  )
}

describe("the page opens on the answer", () => {
  it("says how the department stands in one sentence, and offers the note for the Principal", async () => {
    mount({}, "/department")
    expect(await screen.findByTestId("report-answer")).toHaveTextContent("Physics has 3 papers in 2026 so far")
    expect(screen.getByRole("link", { name: /Download the note for the Principal/ })).toHaveAttribute(
      "href",
      "/api/hod/report?fmt=pdf&year=2026"
    )
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Physics")
  })

  it("draws four tabs, the current one marked, with the counts behind two of them", async () => {
    mount({}, "/department")
    const nav = await screen.findByRole("navigation", { name: "Department views" })
    const tabs = within(nav).getAllByRole("button")
    expect(tabs.map((t) => t.textContent)).toEqual([
      "On track", "Faculty(3)", "Targets and work", "Records to fix(3)",
    ])
    expect(tabs[0]).toHaveAttribute("aria-current", "page")
  })

  it("shows pace against the calendar, and who needs a push with a reason and a next step", async () => {
    mount({}, "/department")
    const pace = await screen.findByRole("region", { name: "Pace against the year" })
    expect(within(pace).getByText("Behind")).toBeInTheDocument()
    expect(within(pace).getByText(/3 to go in 3 months, about 1 a month/)).toBeInTheDocument()
    const push = screen.getByRole("region", { name: "Who needs a push" })
    expect(within(push).getByText("No paper in 2026; 2 in 2025")).toBeInTheDocument()
    expect(within(push).getByText(/Ask what is in progress/)).toBeInTheDocument()
    expect(within(push).getByRole("link", { name: "Quiet Physicist" })).toHaveAttribute("href", "/faculty/u3")
  })

  it("places the department without naming another one", async () => {
    mount({}, "/department")
    expect(await screen.findByText(/2nd of 5 departments on papers per teacher/)).toBeInTheDocument()
    expect(screen.getByText(/No other department is named/)).toBeInTheDocument()
  })

  it("shows a failed request as an error with a retry, never as an empty department", async () => {
    mount({ "/api/hod/brief": failing(500) }, "/department")
    expect(await screen.findByRole("button", { name: "Try again" })).toBeInTheDocument()
    expect(screen.queryByTestId("report-answer")).toBeNull()
  })

  it("says an account with no department cannot use it, and offers no retry that cannot help", async () => {
    mount({ "/api/hod/brief": failing(400, "no department") }, "/department")
    expect(await screen.findByText(/no department set/i)).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull()
  })
})

describe("the faculty tab", () => {
  it("is one table, sortable, with a heading on every column and a face and link on every name", async () => {
    mount({}, "/department?tab=faculty")
    const table = await screen.findByRole("table")
    const heads = within(table).getAllByRole("columnheader").map((h) => h.textContent?.trim())
    expect(heads).toEqual(["Faculty", "2026", "2025", "Q1", "Led", "All years", "Their target"])
    expect(within(table).getByRole("link", { name: "Asha Physicist" })).toHaveAttribute("href", "/faculty/u1")
    expect(within(table).getAllByRole("button", { name: /Set a target for/ })).toHaveLength(3)
  })
})

describe("the records tab", () => {
  it("names the papers to fix and the people with no Scopus ID, and can remind them", async () => {
    const user = userEvent.setup()
    mount({ "/api/hod/nudge": () => ({ sent: 1, skipped: [] }) }, "/department?tab=records")
    expect(await screen.findByText("A paper with no DOI")).toBeInTheDocument()
    expect(screen.getByText("no DOI")).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Remind Quiet Physicist to add a Scopus ID" }))
    const dialog = await screen.findByRole("dialog")
    expect((within(dialog).getByLabelText("Message") as HTMLTextAreaElement).value).toMatch(/Scopus ID/)
  })
})

describe("the department's vision", () => {
  it("shows the vision and its research areas", async () => {
    mount()
    expect(await screen.findByText(PLAN.vision)).toBeInTheDocument()
    expect(screen.getByText("Photonics")).toBeInTheDocument()
    expect(screen.getByText("Condensed matter")).toBeInTheDocument()
  })

  it("edits the areas as chips and saves the whole plan", async () => {
    const user = userEvent.setup()
    mount()

    await user.click(await screen.findByRole("button", { name: "Edit the vision" }))
    const dialog = await screen.findByRole("dialog")

    await user.click(within(dialog).getByRole("button", { name: "Remove Photonics" }))
    await user.type(within(dialog).getByLabelText("Add a research area"), "Optics{Enter}")
    await user.click(within(dialog).getByRole("button", { name: "Save" }))

    await waitFor(() => expect(callsTo("/api/hod/plan", "PUT")).toHaveLength(1))
    expect(callsTo("/api/hod/plan", "PUT")[0][1]).toMatchObject({
      json: { vision: PLAN.vision, research_areas: ["Condensed matter", "Optics"] },
    })
  })
})

describe("work assigned", () => {
  it("groups the work by status and says in words when a deadline has passed", async () => {
    mount({
      "/api/hod/assignments": () => [
        assignment({ id: "a1", due_date: "2020-01-15" }),
        assignment({
          id: "a2", kind: "PAIRING", kind_label: "Co-author pairing", title: "A joint paper on thin-film sensors",
          status: "IN_PROGRESS", status_label: "In progress", partner_id: "u2", partner_name: "Ravi Physicist",
        }),
        assignment({ id: "a3", title: "Finished thing", status: "DONE", status_label: "Done" }),
      ],
    })

    const section = await screen.findByRole("region", { name: "Work assigned" })
    await within(section).findByText("A joint paper on thin-film sensors")
    for (const group of ["Open", "In progress", "Done"]) {
      expect(within(section).getByRole("heading", { name: group })).toBeInTheDocument()
    }
    expect(within(section).getByText("Co-author pairing")).toBeInTheDocument()
    expect(within(section).getByText(/Ravi Physicist/)).toBeInTheDocument()
    expect(within(section).getByText(/overdue/i)).toBeInTheDocument()
  })

  it("asks for the second person only when pairing co-authors", async () => {
    const user = userEvent.setup()
    mount()

    await user.click(await screen.findByRole("button", { name: "Assign work" }))
    const dialog = await screen.findByRole("dialog")
    expect(within(dialog).queryByLabelText("Co-author")).toBeNull()

    await user.click(within(dialog).getByRole("radio", { name: "Pair co-authors" }))
    expect(within(dialog).getByLabelText("Co-author")).toBeInTheDocument()
  })

  it("hands out a task to the person chosen", async () => {
    const user = userEvent.setup()
    mount({ "/api/hod/assignments": () => [] })

    await user.click(await screen.findByRole("button", { name: "Assign work" }))
    const dialog = await screen.findByRole("dialog")
    await user.type(within(dialog).getByLabelText("What needs doing"), "Draft the SSR")
    await user.click(within(dialog).getByLabelText("Who"))
    await user.click(within(dialog).getByRole("option", { name: "Asha Physicist" }))
    await user.click(within(dialog).getByRole("button", { name: "Assign" }))

    await waitFor(() => expect(callsTo("/api/hod/assignments", "POST")).toHaveLength(1))
    expect(callsTo("/api/hod/assignments", "POST")[0][1]).toMatchObject({
      json: { kind: "TASK", title: "Draft the SSR", assignee_id: "u1" },
    })
  })

  it("moves an assignment's status where it stands", async () => {
    const user = userEvent.setup()
    mount({
      "/api/hod/assignments/a1": () => assignment({ status: "DONE" }),
      "/api/hod/assignments": () => [assignment()],
    })

    const select = await screen.findByLabelText("Status of Draft the NAAC criterion 3 narrative")
    await user.selectOptions(select, "DONE")

    await waitFor(() => expect(callsTo("/api/hod/assignments/a1", "PATCH")).toHaveLength(1))
    expect(callsTo("/api/hod/assignments/a1", "PATCH")[0][1]).toMatchObject({ json: { status: "DONE" } })
  })

  it("withdraws an assignment only after a confirmation", async () => {
    const user = userEvent.setup()
    mount({
      "/api/hod/assignments/a1": () => ({ ok: true }),
      "/api/hod/assignments": () => [assignment()],
    })

    await user.click(await screen.findByRole("button", { name: "Withdraw Draft the NAAC criterion 3 narrative" }))
    expect(callsTo("/api/hod/assignments/a1", "DELETE")).toHaveLength(0)
    const confirm = await screen.findByRole("dialog")
    await user.click(within(confirm).getByRole("button", { name: "Withdraw it" }))

    await waitFor(() => expect(callsTo("/api/hod/assignments/a1", "DELETE")).toHaveLength(1))
  })
})

describe("a target's deadline", () => {
  it("is shown on the target and sent when one is set", async () => {
    const user = userEvent.setup()
    mount({ "/api/hod/targets": () => TARGETS })

    expect(await screen.findByText(/by 31 Dec 2026/)).toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "Set a target" }))
    const dialog = await screen.findByRole("dialog")
    await user.type(within(dialog).getByLabelText("Target"), "6")
    await user.type(within(dialog).getByLabelText("Deadline"), "2026-11-30")
    await user.click(within(dialog).getByRole("button", { name: "Save" }))

    await waitFor(() => expect(callsTo("/api/hod/targets", "POST")).toHaveLength(1))
    expect(callsTo("/api/hod/targets", "POST")[0][1]).toMatchObject({
      json: { target: 6, due_date: "2026-11-30" },
    })
  })
})

describe("a reminder", () => {
  it("opens with a specific draft, editable, and goes to the person chosen", async () => {
    const user = userEvent.setup()
    mount({ "/api/hod/nudge": () => ({ sent: 1, skipped: [] }) }, "/department")

    await user.click(await screen.findByRole("button", { name: "Remind Quiet Physicist" }))
    const dialog = await screen.findByRole("dialog")
    const message = within(dialog).getByLabelText("Message") as HTMLTextAreaElement
    expect(message.value).toMatch(/^A reminder from your head of department: you had 2 papers in 2025/)
    expect(within(dialog).getByText(/Quiet Physicist/)).toBeInTheDocument()

    await user.click(within(dialog).getByRole("button", { name: "Send reminder" }))

    await waitFor(() => expect(callsTo("/api/hod/nudge", "POST")).toHaveLength(1))
    const [, options] = callsTo("/api/hod/nudge", "POST")[0]
    expect(options).toMatchObject({ json: { user_ids: ["u3"] } })
    expect((options as { json: { message: string } }).json.message).toBe(message.value)
  })
})

describe("money-blindness", () => {
  it("shows no rupee figure anywhere on the page, on any tab", async () => {
    for (const tab of ["", "?tab=faculty", "?tab=plan", "?tab=records"]) {
      const view = mount(
        { "/api/hod/assignments": () => [assignment({ due_date: "2026-12-01" })] },
        `/department${tab}`
      )
      await screen.findByRole("navigation", { name: "Department views" })
      await new Promise((r) => setTimeout(r, 30))
      expect(document.body.textContent, tab).not.toContain("₹")
      expect(document.body.textContent, tab).not.toMatch(/payout|incentive|amount/i)
      view.unmount()
    }
  })
})
