import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return { ...actual, api: vi.fn() }
})

import { api } from "@/lib/api"
import { Department } from "@/pages/department"
import { HOD, fakeApi, renderWithProviders, type ApiTable } from "@/test/harness"

/**
 * A head of department's planning: the vision, the work handed out, a
 * deadline on a target, and a reminder to people who have gone quiet.
 *
 * Two things are asserted here that the server also enforces, because the
 * screen is where they are seen: the head is money-blind, so no rupee figure
 * may appear anywhere on this page; and the second person on a pairing is
 * only asked for when the head is pairing people.
 */

const RATES = { publications: 4, q1: 1, q1_rate: 0.25, first_author: 2, first_author_rate: 0.5 }

const STANDING = {
  department: "Physics",
  year: null,
  mine: { ...RATES, faculty: 3, per_head: 1.33 },
  college: { ...RATES, publications: 40, departments: 5, faculty: 30, per_head: 1.33 },
  share: 0.1,
  position: 2,
  of: 5,
  years: [2026],
}

const TARGET = {
  id: "t1",
  year: 2026,
  metric: "Q1",
  metric_label: "Q1 publications",
  target: 4,
  done: 1,
  remaining: 3,
  fraction: 0.25,
  met: false,
  person_id: null,
  person_name: null,
  note: null,
  due_date: "2026-12-31",
  set_by: "Dr Meera Pillai",
}

const TARGETS = {
  department: "Physics",
  year: 2026,
  department_targets: [TARGET],
  personal_targets: [],
  metrics: [
    { key: "PUBLICATIONS", label: "Publications" },
    { key: "Q1", label: "Q1 publications" },
  ],
  years: [2026],
}

const person = (id: string, name: string, publications = 1) => ({
  id,
  name,
  designation: "Assistant Professor",
  publications,
  first_author: 0,
  q1: 0,
  active: true,
})

const OVERVIEW = {
  department: "Physics",
  people: [
    person("u1", "Asha Physicist", 2),
    person("u2", "Ravi Physicist", 1),
    person("u3", "Quiet Physicist", 0),
  ],
}

const OPPORTUNITIES = {
  department: "Physics",
  groups: [
    {
      key: "silent",
      title: "Nobody has filed anything for them",
      blurb: "Not the same as having published nothing.",
      count: 1,
      people: [{ id: "u3", name: "Quiet Physicist" }],
    },
  ],
  incomplete_records: { count: 0, blurb: "", papers: [] },
  lower_quartile_journals: [],
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
    id: "a1",
    department: "Physics",
    kind: "TASK",
    kind_label: "Task",
    title: "Draft the NAAC criterion 3 narrative",
    notes: "",
    status: "OPEN",
    status_label: "Open",
    assignee_id: "u1",
    assignee_name: "Asha Physicist",
    partner_id: null,
    partner_name: null,
    due_date: null,
    set_by: "Dr Meera Pillai",
    created_at: "2026-09-01T00:00:00Z",
    updated_at: "2026-09-01T00:00:00Z",
    ...over,
  }
}

function mount(over: ApiTable = {}) {
  vi.mocked(api).mockImplementation(
    fakeApi({
      "/api/auth/me": () => HOD,
      "/api/hod/standing": () => STANDING,
      "/api/hod/targets": () => TARGETS,
      "/api/hod/overview": () => OVERVIEW,
      "/api/hod/opportunities": () => OPPORTUNITIES,
      "/api/hod/plan": () => PLAN,
      "/api/hod/assignments": () => [],
      ...over,
    })
  )
  return renderWithProviders(<Department />, { route: "/department" })
}

/** Every call the page made to one path, with the options it sent. */
function callsTo(path: string, method?: string) {
  return vi
    .mocked(api)
    .mock.calls.filter(
      ([p, options]) =>
        p === path && (!method || (options as { method?: string } | undefined)?.method === method)
    )
}

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
          id: "a2",
          kind: "PAIRING",
          kind_label: "Co-author pairing",
          title: "A joint paper on thin-film sensors",
          status: "IN_PROGRESS",
          status_label: "In progress",
          partner_id: "u2",
          partner_name: "Ravi Physicist",
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
    // Colour is the second signal; the word is the first.
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
    expect(callsTo("/api/hod/assignments/a1", "PATCH")[0][1]).toMatchObject({
      json: { status: "DONE" },
    })
  })

  it("withdraws an assignment only after a confirmation", async () => {
    const user = userEvent.setup()
    mount({
      "/api/hod/assignments/a1": () => ({ ok: true }),
      "/api/hod/assignments": () => [assignment()],
    })

    await user.click(
      await screen.findByRole("button", { name: "Withdraw Draft the NAAC criterion 3 narrative" })
    )
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
  it("opens pre-filled and goes to the people in that group", async () => {
    const user = userEvent.setup()
    mount({ "/api/hod/nudge": () => ({ sent: 1, skipped: [] }) })

    await user.click(await screen.findByRole("button", { name: /^send a reminder/i }))
    const dialog = await screen.findByRole("dialog")
    const message = within(dialog).getByLabelText("Message") as HTMLTextAreaElement
    expect(message.value).toMatch(/^A reminder from your head of department: /)
    expect(within(dialog).getByText(/Quiet Physicist/)).toBeInTheDocument()

    await user.click(within(dialog).getByRole("button", { name: "Send reminder" }))

    await waitFor(() => expect(callsTo("/api/hod/nudge", "POST")).toHaveLength(1))
    const [, options] = callsTo("/api/hod/nudge", "POST")[0]
    expect(options).toMatchObject({ json: { user_ids: ["u3"] } })
    expect((options as { json: { message: string } }).json.message).toBe(message.value)
  })
})

describe("money-blindness", () => {
  it("shows no rupee figure anywhere on the page", async () => {
    mount({
      "/api/hod/assignments": () => [
        assignment({ due_date: "2026-12-01" }),
        assignment({ id: "a2", kind: "PAIRING", partner_id: "u2", partner_name: "Ravi Physicist" }),
      ],
    })
    await screen.findByText(PLAN.vision)
    await screen.findAllByText("Draft the NAAC criterion 3 narrative")
    expect(document.body.textContent).not.toContain("₹")
  })
})
