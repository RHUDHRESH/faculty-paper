import { screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return { ...actual, api: vi.fn() }
})

import type { Me } from "@/app/auth"
import { api } from "@/lib/api"
import { AdminHub } from "@/pages/hub"
import { AdminHome } from "@/pages/home-admin"
import { AdminStart } from "@/pages/admin-start"
import { fakeApi, renderWithProviders, type ApiTable } from "@/test/harness"

const ADMIN: Me = { id: "u-admin", email: "a@x.edu", name: "Suresh Admin", role: "SUPER_ADMIN", department: null }

const item = (over: Record<string, unknown>) => ({
  key: "k",
  job: "data",
  severity: "warning",
  title: "A thing",
  why: "Because.",
  to: "/faults",
  count: null,
  action: "Open faults",
  unit: null,
  ...over,
})

const step = (over: Record<string, unknown>) => ({
  key: "record",
  title: "Load the college's record",
  state: "done",
  fact: "412 people and 8,466 papers on record.",
  to: "/imports",
  action: "Open Imports",
  required: true,
  ...over,
})

const RUNNING = {
  checked_at: "",
  done: 5,
  total: 5,
  next: null,
  complete: true,
  steps: [step({})],
}

const FRESH = {
  checked_at: "",
  done: 0,
  total: 5,
  next: "record",
  complete: false,
  steps: [
    step({ state: "todo", fact: "Nothing is loaded.", action: "Load the record" }),
    step({ key: "desks", title: "Put someone at every desk", state: "todo", fact: "Nobody holds Principal.", to: "/people?role=PRINCIPAL", action: "Choose the Principal" }),
    step({ key: "email", title: "Set up email", state: "todo", required: false, fact: "No mail server.", to: "/settings/notifications", action: "Open email settings" }),
  ],
}

function mount(ui: React.ReactElement, extra: ApiTable = {}) {
  vi.mocked(api).mockReset()
  vi.mocked(api).mockImplementation((path: string, ...rest: unknown[]) =>
    fakeApi({
      "/api/auth/me": () => ADMIN,
      "/api/claims/counts": () => ({ counts: { filed: 14 } }),
      "/api/admin/clearing-queue": () => [],
      "/api/track": () => ({ stages: [], results: [], sees_money: true, sees_flags: true }),
      "/api/admin/start": () => RUNNING,
      ...extra,
    })(path, ...(rest as []))
  )
  renderWithProviders(ui)
}

describe("the super admin's home", () => {
  it("answers in one sentence, then lists what needs attention with real counts, units and one button each", async () => {
    mount(<AdminHome />, {
      "/api/admin/attention": () => ({
        checked_at: "",
        ok: ["A policy version is active"],
        items: [
          item({ key: "author_matches", title: "College author names nobody has matched", count: 2841, unit: "names", action: "Match names", to: "/people/matches" }),
          item({ key: "one", severity: "critical", title: "Paid with no ledger row", count: 1, unit: "claims", action: "Open faults" }),
        ],
      }),
    })
    // The answer is the one sentence; the count is not repeated as a heading.
    expect(await screen.findByRole("status")).toHaveTextContent(/2 things need you, 1 of them urgent/)
    const rows = screen.getAllByTestId(/^attention-/)
    expect(rows).toHaveLength(2)
    // The real number, not "99+"; the unit agrees with the count.
    expect(within(rows[0]).getByText("2,841")).toBeInTheDocument()
    expect(within(rows[0]).getByText("names")).toBeInTheDocument()
    expect(within(rows[1]).getByText("claim")).toBeInTheDocument()
    // Words as well as colour for how urgent it is; never the internal job word.
    expect(within(rows[1]).getByText("Urgent")).toBeInTheDocument()
    expect(screen.queryByText("Running")).toBeNull()
    // The action is a button-shaped link to the place it is fixed.
    expect(within(rows[0]).getByRole("link", { name: /Match names/ })).toHaveAttribute("href", "/people/matches")
  })

  it("shows five and lets the admin open the rest without leaving", async () => {
    const many = Array.from({ length: 8 }, (_, i) => item({ key: `k${i}`, title: `Thing ${i}` }))
    mount(<AdminHome />, { "/api/admin/attention": () => ({ checked_at: "", ok: [], items: many }) })
    expect(await screen.findByText(/8 things need you/)).toBeInTheDocument()
    expect(screen.getAllByTestId(/^attention-/)).toHaveLength(5)
    await userEvent.click(screen.getByRole("button", { name: /Show 3 more/ }))
    expect(screen.getAllByTestId(/^attention-/)).toHaveLength(8)
  })

  it("says so when nothing needs attention", async () => {
    mount(<AdminHome />, { "/api/admin/attention": () => ({ checked_at: "", ok: ["A policy version is active"], items: [] }) })
    expect(await screen.findByText("Nothing is broken or stuck.")).toBeInTheDocument()
  })

  it("has a Find button that opens the same finder as Ctrl K", async () => {
    mount(<AdminHome />, { "/api/admin/attention": () => ({ checked_at: "", ok: [], items: [] }) })
    const seen = vi.fn()
    window.addEventListener("keydown", seen)
    await userEvent.click(await screen.findByRole("button", { name: /Find a claim, person or payment/ }))
    window.removeEventListener("keydown", seen)
    expect(seen).toHaveBeenCalled()
    expect(seen.mock.calls[0][0]).toMatchObject({ key: "k", ctrlKey: true })
  })

  it("on a college that is not running yet, the sentence is the setup and the next step is the one primary button", async () => {
    mount(<AdminHome />, {
      "/api/admin/start": () => FRESH,
      "/api/admin/attention": () => ({ checked_at: "", ok: [], items: [] }),
    })
    expect(await screen.findByRole("status")).toHaveTextContent(/steps are left. Next, load the college.s record/)
    const next = screen.getByTestId("start-record")
    expect(within(next).getByRole("link", { name: /Load the record/ })).toHaveAttribute("href", "/imports")
    // The daily list is not shown over an empty college.
    expect(screen.queryByTestId(/^attention-/)).toBeNull()
    // Optional steps are under "Also", never counted.
    expect(screen.getByText("Also")).toBeInTheDocument()
  })
})

describe("the Get the college running page", () => {
  it("lists the steps in order with a fact and one button each", async () => {
    mount(<AdminStart />, { "/api/admin/start": () => FRESH })
    expect(await screen.findByText("0 of 5 steps done.")).toBeInTheDocument()
    const desks = screen.getByTestId("start-desks")
    expect(within(desks).getByText("Nobody holds Principal.")).toBeInTheDocument()
    expect(within(desks).getByRole("link", { name: /Choose the Principal/ })).toHaveAttribute("href", "/people?role=PRINCIPAL")
  })
})

describe("choosing who holds an empty desk", () => {
  const withDesks = {
    ...FRESH,
    steps: [
      step({ state: "done" }),
      step({
        key: "desks",
        title: "Put someone at every desk",
        state: "todo",
        fact: "Nobody holds Director.",
        action: "Choose the Director",
        desks: [{ role: "DIRECTOR", label: "Director" }],
      }),
    ],
    next: "desks",
  }

  it("searches the people and gives the role with one button, never offering someone who already holds a desk", async () => {
    const patch = vi.fn((_body: unknown) => ({ id: "u2", role: "DIRECTOR" }))
    mount(<AdminStart />, {
      "/api/admin/start": () => withDesks,
      "/api/admin/users": () => ({
        results: [
          { id: "u1", name: "Already Finance", email: "f@x.edu", role: "FINANCE", department: null, designation: null },
          { id: "u2", name: "Dr Choice", email: "c@x.edu", role: "FACULTY", department: "CSE", designation: "Professor" },
        ],
      }),
      "/api/admin/users/u2": patch,
    })
    await userEvent.click(await screen.findByRole("button", { name: "Choose the Director" }))
    const dialog = await screen.findByRole("dialog")
    expect(await within(dialog).findByText("Dr Choice")).toBeInTheDocument()
    expect(within(dialog).queryByText("Already Finance")).toBeNull()
    await userEvent.click(within(dialog).getByRole("button", { name: "Make Dr Choice Director" }))
    const call = vi.mocked(api).mock.calls.find((c) => c[0] === "/api/admin/users/u2")
    expect(call?.[1]).toMatchObject({ method: "PATCH", json: { role: "DIRECTOR" } })
  })
})

describe("the Admin page", () => {
  it("is a directory: names and real counts, no readiness list, a way in to the setup while it is unfinished", async () => {
    mount(<AdminHub />, {
      "/api/admin/hub": () => ({ counts: { "/people/matches": { count: 2841, tone: "caution", note: null } } }),
      "/api/admin/start": () => FRESH,
    })
    expect(await screen.findByText("2,841")).toBeInTheDocument()
    expect(screen.queryByText("99+")).toBeNull()
    expect(screen.queryByText("Is the system ready?")).toBeNull()
    expect(await screen.findByRole("link", { name: "Continue" })).toHaveAttribute("href", "/admin/start")
  })

  it("filters the pages as you type", async () => {
    mount(<AdminHub />, { "/api/admin/hub": () => ({ counts: {} }) })
    await userEvent.type(await screen.findByLabelText("Find an admin page"), "passw")
    expect(screen.getByRole("link", { name: /Issue passwords/ })).toBeInTheDocument()
    expect(screen.queryByRole("link", { name: /Audit log/ })).toBeNull()
  })
})
