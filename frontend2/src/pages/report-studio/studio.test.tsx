import { fireEvent, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { Navigate, Route, Routes } from "react-router-dom"
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return { ...actual, api: vi.fn(), apiFile: vi.fn() }
})

import { REDIRECTS } from "@/app/nav"
import { api, apiFile, ApiError } from "@/lib/api"
import { ReportStudio } from "@/pages/report-studio"
import { renderWithProviders } from "@/test/harness"
import { DATASETS, RUN_RESULT, SAVED_ONE, SAVED_SHARED, TEMPLATES } from "@/test/studio-fixtures"

// A whole designer is drawn and driven by hand in each test; a busy machine needs the room.
vi.setConfig({ testTimeout: 30_000 })

type Call = { method: string; path: string; json: unknown }
type Handler = (json: unknown, path: string) => unknown

let calls: Call[] = []

/** Answers by "METHOD /path", longest match first; anything else is a 404 so a forgotten stub is loud. */
function serve(routes: Record<string, Handler>) {
  const keys = Object.keys(routes).sort((a, b) => b.length - a.length)
  vi.mocked(api).mockImplementation((async (path: string, options: { method?: string; json?: unknown } = {}) => {
    const method = (options.method ?? "GET").toUpperCase()
    calls.push({ method, path, json: options.json })
    const hit = keys.find((k) => `${method} ${path}`.startsWith(k))
    if (!hit) throw new ApiError(404, `No stub for ${method} ${path}`)
    return routes[hit](options.json, path)
  }) as typeof api)
}

const base = {
  "GET /api/reports/datasets": () => DATASETS,
  "GET /api/reports/templates": () => TEMPLATES,
  "GET /api/reports/saved": () => ({ mine: [SAVED_ONE], shared: [SAVED_SHARED] }),
  "POST /api/reports/run": () => RUN_RESULT,
}

const callsTo = (method: string, path: string) => calls.filter((c) => c.method === method && c.path === path)

function renderStudio(route: string) {
  return renderWithProviders(
    <Routes>
      <Route path="/reports/studio" element={<ReportStudio />} />
      {Object.entries(REDIRECTS).map(([from, to]) => (
        <Route key={from} path={from} element={<Navigate to={to} replace />} />
      ))}
    </Routes>,
    { route }
  )
}


beforeEach(() => {
  calls = []
  window.sessionStorage.clear()
  window.localStorage.clear()
  URL.createObjectURL = vi.fn(() => "blob:report")
  URL.revokeObjectURL = vi.fn()
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {})
})

/** The designer, blank, on the Papers dataset. */
async function openBlank(user: ReturnType<typeof userEvent.setup>) {
  renderStudio("/reports/studio?new=1")
  await user.selectOptions(await screen.findByLabelText("The report is about"), "papers")
}

describe("the start screen", () => {
  it("offers templates, saved reports and reports shared with me", async () => {
    serve(base)
    renderStudio("/reports/studio")
    expect(await screen.findByRole("heading", { name: "Report studio" })).toBeInTheDocument()
    expect(await screen.findByText("Papers by department", { selector: "span.text-lg" })).toBeInTheDocument()
    expect(screen.getByText("How many papers each department has, and what was paid.")).toBeInTheDocument()
    expect(screen.getByRole("heading", { name: "My reports" })).toBeInTheDocument()
    expect(screen.getByRole("heading", { name: "Shared with me" })).toBeInTheDocument()
    const mine = await screen.findByRole("table", { name: "My reports" })
    expect(within(mine).getByText("R Iyer")).toBeInTheDocument()
    expect(within(mine).getByText("Not scheduled")).toBeInTheDocument()
    const shared = screen.getByRole("table", { name: "Reports shared with me" })
    expect(within(shared).getByText("Finance month end")).toBeInTheDocument()
    expect(within(shared).queryByRole("button", { name: /Delete/ })).not.toBeInTheDocument()
  })

  it("duplicates a saved report and deletes one after asking", async () => {
    const user = userEvent.setup()
    serve({
      ...base,
      "POST /api/reports/saved/s1/duplicate": () => ({ ...SAVED_ONE, id: "s9" }),
      "DELETE /api/reports/saved/s1": () => null,
    })
    renderStudio("/reports/studio")
    await user.click(await screen.findByRole("button", { name: "Duplicate Papers by department" }))
    await waitFor(() => expect(callsTo("POST", "/api/reports/saved/s1/duplicate")).toHaveLength(1))

    await user.click(screen.getByRole("button", { name: "Delete Papers by department" }))
    const dialog = await screen.findByRole("dialog")
    expect(within(dialog).getByText("Delete this report?")).toBeInTheDocument()
    expect(callsTo("DELETE", "/api/reports/saved/s1")).toHaveLength(0)
    await user.click(within(dialog).getByRole("button", { name: "Delete report" }))
    await waitFor(() => expect(callsTo("DELETE", "/api/reports/saved/s1")).toHaveLength(1))
  })

  it("redirects the old Build a report address to the studio", async () => {
    serve(base)
    expect(REDIRECTS["/reports/build"]).toBe("/reports/studio")
    renderStudio("/reports/build")
    expect(await screen.findByRole("heading", { name: "Report studio" })).toBeInTheDocument()
  })
})

describe("asking in plain words", () => {
  it("opens the designer with the answer, the explanation and a finished run", async () => {
    const user = userEvent.setup()
    serve({
      ...base,
      "POST /api/reports/ai": () => ({
        definition: { dataset: "papers", columns: [], group_by: ["department"], aggregates: [{ field: "amount", fn: "sum" }] },
        explanation: "Papers grouped by department, adding up the incentive.",
      }),
    })
    renderStudio("/reports/studio")
    await user.type(await screen.findByLabelText("What would you like to know?"), "incentive by department")
    await user.click(screen.getByRole("button", { name: "Make my report" }))
    expect(await screen.findByText(/Papers grouped by department, adding up the incentive/)).toBeInTheDocument()
    await waitFor(() => expect(callsTo("POST", "/api/reports/run")).toHaveLength(1))
    expect(callsTo("POST", "/api/reports/ai")[0].json).toEqual({ question: "incentive by department" })
    expect(callsTo("POST", "/api/reports/run")[0].json).toMatchObject({ group_by: ["department"], aggregates: [{ field: "amount", fn: "sum" }] })
    expect(await screen.findByText("CSE")).toBeInTheDocument()
  })

  it("takes the box away when the server says it is not set up (501)", async () => {
    const user = userEvent.setup()
    serve({
      ...base,
      "POST /api/reports/ai": () => {
        throw new ApiError(501, "Asking in plain words is not set up.")
      },
    })
    renderStudio("/reports/studio")
    expect(await screen.findByRole("heading", { name: "Ask in plain words" })).toBeInTheDocument()
    await user.type(screen.getByLabelText("What would you like to know?"), "anything")
    await user.click(screen.getByRole("button", { name: "Make my report" }))
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Ask in plain words" })).not.toBeInTheDocument())
    expect(screen.queryByLabelText("What would you like to know?")).not.toBeInTheDocument()
    // The templates are still there.
    expect(screen.getByRole("heading", { name: "Start from a template" })).toBeInTheDocument()
  })
})

describe("from a template to a table", () => {
  it("opens the template, runs it by itself and shows the table and the summary", async () => {
    const user = userEvent.setup()
    serve(base)
    renderStudio("/reports/studio")
    await user.click(await screen.findByRole("link", { name: /Papers by departments*How many papers/ }))

    await waitFor(() => expect(callsTo("POST", "/api/reports/run")).toHaveLength(1))
    expect(callsTo("POST", "/api/reports/run")[0].json).toMatchObject({
      dataset: "papers",
      group_by: ["department"],
      aggregates: [{ field: "amount", fn: "sum", label: "Total incentive" }],
      sort: [{ field: "amount", dir: "desc" }],
      pivot: null,
    })
    const table = await screen.findByRole("table", { name: "Papers by department" })
    expect(within(table).getByText("CSE")).toBeInTheDocument()
    expect(within(table).getByText("₹1,50,000")).toBeInTheDocument()
    expect(screen.getByTestId("result-summary")).toHaveTextContent("1,234 rows, grouped by department")
    // The three steps are all on the page.
    for (const name of ["What", "Shape", "Result"]) expect(screen.getByRole("heading", { name })).toBeInTheDocument()
  })

  it("warns when the rows were cut short, and draws a chart when asked", async () => {
    const user = userEvent.setup()
    serve({ ...base, "POST /api/reports/run": () => ({ ...RUN_RESULT, truncated: true, total_rows: 5000 }) })
    renderStudio("/reports/studio?t=by-department")
    expect(await screen.findByText("This is not every row")).toBeInTheDocument()
    expect(screen.getByText(/Showing the first 3 of 5,000 rows/)).toBeInTheDocument()

    for (const [name, label] of [
      [/Bars/, "Bar chart of Total incentive by Department"],
      [/Line/, "Line chart of Total incentive by Department"],
      [/Pie/, "Pie chart of Total incentive by Department"],
    ] as const) {
      await user.click(screen.getByRole("radio", { name }))
      expect(screen.getByRole("img", { name: new RegExp(label) })).toBeInTheDocument()
    }
    await user.click(screen.getByRole("radio", { name: /Table only/ }))
    expect(screen.queryByRole("img")).not.toBeInTheDocument()
  })

  it("shows a head of department's refusal for a money column in the server's own words", async () => {
    serve({
      ...base,
      "POST /api/reports/run": () => {
        throw new ApiError(400, "Money columns are not open to heads of department. Remove the incentive and run it again.")
      },
    })
    renderStudio("/reports/studio?t=by-department")
    const alert = await screen.findByRole("alert")
    expect(alert).toHaveTextContent("Money columns are not open to heads of department. Remove the incentive and run it again.")
    expect(screen.queryByTestId("result-summary")).not.toBeInTheDocument()
  })
})

describe("the designer's request", () => {
  it("does not run until Run report is pressed, then sends the columns in the order chosen", async () => {
    const user = userEvent.setup()
    serve(base)
    await openBlank(user)
    expect(callsTo("POST", "/api/reports/run")).toHaveLength(0)
    expect(screen.getByText("Every paper the college has claimed.")).toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "Move Incentive up" }))
    await user.click(screen.getByRole("button", { name: "Run report" }))
    await waitFor(() => expect(callsTo("POST", "/api/reports/run")).toHaveLength(1))
    expect(callsTo("POST", "/api/reports/run")[0].json).toMatchObject({
      columns: ["title", "department", "published_on", "amount", "pages"],
    })
  })

  it("searches the columns and lets one be taken off", async () => {
    const user = userEvent.setup()
    serve(base)
    await openBlank(user)
    await user.type(screen.getByLabelText("Find a column"), "year")
    const list = screen.getByRole("list", { name: "All the columns you can show" })
    expect(within(list).getAllByRole("checkbox")).toHaveLength(1)
    await user.click(within(list).getByRole("checkbox", { name: "Academic year" }))
    expect(screen.getByRole("button", { name: "Remove Academic year" })).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Remove Academic year" }))
    expect(screen.queryByRole("button", { name: "Remove Academic year" })).not.toBeInTheDocument()
  })

  it("sets a condition suited to each kind of field", async () => {
    const user = userEvent.setup()
    serve(base)
    await openBlank(user)

    // A date, between two days.
    await user.click(screen.getByRole("button", { name: "Add a condition" }))
    await user.selectOptions(screen.getByLabelText("Condition 1: field"), "published_on")
    expect(within(screen.getByLabelText("Condition 1: how to compare")).getAllByRole("option").map((o) => o.textContent)).toEqual([
      "is on",
      "is after",
      "is before",
      "is between",
    ])
    await user.selectOptions(screen.getByLabelText("Condition 1: how to compare"), "between")
    fireEvent.change(screen.getByLabelText("Condition 1: from"), { target: { value: "2026-01-01" } })
    fireEvent.change(screen.getByLabelText("Condition 1: to"), { target: { value: "2026-03-31" } })

    // A number.
    await user.click(screen.getByRole("button", { name: "Add a condition" }))
    await user.selectOptions(screen.getByLabelText("Condition 2: field"), "pages")
    await user.selectOptions(screen.getByLabelText("Condition 2: how to compare"), "gt")
    await user.type(screen.getByLabelText("Condition 2: number"), "10")

    // An enum, as a list to tick.
    await user.click(screen.getByRole("button", { name: "Add a condition" }))
    await user.selectOptions(screen.getByLabelText("Condition 3: field"), "department")
    const choices = screen.getByRole("list", { name: "Condition 3: choose one or more" })
    await user.click(within(choices).getByRole("checkbox", { name: "CSE" }))
    await user.click(within(choices).getByRole("checkbox", { name: "ECE" }))

    // Yes or no.
    await user.click(screen.getByRole("button", { name: "Add a condition" }))
    await user.selectOptions(screen.getByLabelText("Condition 4: field"), "scopus")
    await user.selectOptions(screen.getByLabelText("Condition 4: yes or no"), "false")

    // Money, with the rupee sign; and one left unfinished, which is not sent.
    await user.click(screen.getByRole("button", { name: "Add a condition" }))
    await user.selectOptions(screen.getByLabelText("Condition 5: field"), "amount")
    await user.selectOptions(screen.getByLabelText("Condition 5: how to compare"), "gte")
    await user.type(screen.getByLabelText("Condition 5: number"), "5000")
    await user.click(screen.getByRole("button", { name: "Add a condition" }))
    expect(screen.getByText("Not used yet. Fill in a value, or remove it.")).toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "Run report" }))
    await waitFor(() => expect(callsTo("POST", "/api/reports/run")).toHaveLength(1))
    expect((callsTo("POST", "/api/reports/run")[0].json as { filters: unknown }).filters).toEqual([
      { field: "published_on", op: "between", value: ["2026-01-01", "2026-03-31"] },
      { field: "pages", op: "gt", value: 10 },
      { field: "department", op: "in", value: ["CSE", "ECE"] },
      { field: "scopus", op: "eq", value: false },
      { field: "amount", op: "gte", value: 5000 },
    ])
  })

  it("builds groups, a date bucket, totals, order and top rows", async () => {
    const user = userEvent.setup()
    serve(base)
    await openBlank(user)

    await user.click(screen.getByRole("button", { name: "Group the report" }))
    await user.selectOptions(screen.getByLabelText("Group by 1"), "department")
    await user.click(screen.getByRole("button", { name: "Add another group" }))
    await user.selectOptions(screen.getByLabelText("Group by 2"), "published_on")
    await user.selectOptions(screen.getByLabelText("Group dates"), "academic_year")

    await user.click(screen.getByRole("button", { name: "Add a total" }))
    await user.selectOptions(screen.getByLabelText("Add up 1: of which column"), "amount")
    await user.type(screen.getByLabelText("Add up 1: name for the column (optional)"), "Total incentive")
    await user.click(screen.getByRole("button", { name: "Add a total" }))
    await user.selectOptions(screen.getByLabelText("Add up 2: what to work out"), "count")

    await user.click(screen.getByRole("button", { name: "Put the rows in order" }))
    await user.selectOptions(screen.getByLabelText("Order 1: column"), "amount")
    await user.selectOptions(screen.getByLabelText("Order 1: direction"), "desc")
    await user.type(screen.getByLabelText("Show only the top rows"), "10")

    await user.click(screen.getByRole("button", { name: "Run report" }))
    await waitFor(() => expect(callsTo("POST", "/api/reports/run")).toHaveLength(1))
    expect(callsTo("POST", "/api/reports/run")[0].json).toEqual({
      dataset: "papers",
      columns: ["title", "department", "published_on", "pages", "amount"],
      filters: [],
      group_by: ["department", "published_on"],
      date_bucket: "academic_year",
      aggregates: [
        { field: "amount", fn: "sum", label: "Total incentive" },
        { field: "pages", fn: "count" },
      ],
      pivot: null,
      sort: [{ field: "amount", dir: "desc" }],
      limit: 1000,
      top_n: 10,
    })
    expect(await screen.findByTestId("result-summary")).toHaveTextContent("1,234 rows, grouped by department and date published (by academic year)")
  })

  it("allows only three groups", async () => {
    const user = userEvent.setup()
    serve(base)
    await openBlank(user)
    await user.click(screen.getByRole("button", { name: "Group the report" }))
    await user.click(screen.getByRole("button", { name: "Add another group" }))
    await user.click(screen.getByRole("button", { name: "Add another group" }))
    expect(screen.queryByRole("button", { name: "Add another group" })).not.toBeInTheDocument()
    expect(screen.getByText("That is the most, three groups.")).toBeInTheDocument()
  })

  it("sends a grid on its own, leaving groups and totals out", async () => {
    const user = userEvent.setup()
    serve(base)
    await openBlank(user)
    await user.click(screen.getByRole("button", { name: "Group the report" }))
    await user.click(screen.getByRole("button", { name: "Add a total" }))

    await user.click(screen.getByRole("checkbox", { name: /Show the report as a grid/ }))
    await user.selectOptions(screen.getByLabelText("Down the side"), "department")
    await user.selectOptions(screen.getByLabelText("Across the top"), "academic_year")
    await user.selectOptions(screen.getByLabelText("In each box, of which column"), "amount")
    expect(screen.getByLabelText("Group by 1")).toBeDisabled()

    await user.click(screen.getByRole("button", { name: "Run report" }))
    await waitFor(() => expect(callsTo("POST", "/api/reports/run")).toHaveLength(1))
    expect(callsTo("POST", "/api/reports/run")[0].json).toMatchObject({
      pivot: { rows: "department", columns: "academic_year", value: { field: "amount", fn: "sum" } },
      group_by: [],
      aggregates: [],
    })
  })

  it("says what is missing instead of sending an empty report", async () => {
    const user = userEvent.setup()
    serve(base)
    renderStudio("/reports/studio?new=1")
    await screen.findByLabelText("The report is about")
    await user.click(screen.getByRole("button", { name: "Run report" }))
    expect(await screen.findByRole("alert")).toHaveTextContent("Choose what the report is about.")
    expect(callsTo("POST", "/api/reports/run")).toHaveLength(0)
  })
})

describe("saving, scheduling, downloading and the live link", () => {
  it("saves a new report with its name and who can open it, then updates it", async () => {
    const user = userEvent.setup()
    serve({
      ...base,
      "POST /api/reports/saved": () => ({ ...SAVED_ONE, id: "s5", name: "Monthly incentive" }),
      "PUT /api/reports/saved/s5": () => ({ ...SAVED_ONE, id: "s5", name: "Monthly incentive" }),
    })
    renderStudio("/reports/studio?t=by-department")
    await screen.findByTestId("result-summary")

    await user.click(screen.getByRole("button", { name: "Save" }))
    const dialog = await screen.findByRole("dialog")
    await user.clear(within(dialog).getByLabelText("Name of the report"))
    await user.type(within(dialog).getByLabelText("Name of the report"), "Monthly incentive")
    await user.click(within(dialog).getByRole("radio", { name: /People in my role/ }))
    await user.click(within(dialog).getByRole("button", { name: "Save report" }))

    await waitFor(() => expect(callsTo("POST", "/api/reports/saved")).toHaveLength(1))
    expect(callsTo("POST", "/api/reports/saved")[0].json).toMatchObject({
      name: "Monthly incentive",
      visibility: "role",
      definition: { dataset: "papers", group_by: ["department"], aggregates: [{ field: "amount", fn: "sum", label: "Total incentive" }] },
    })
    expect(await screen.findByRole("heading", { name: "Monthly incentive" })).toBeInTheDocument()

    // Now it exists: Save updates it in place, and Save as makes a copy.
    await user.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => expect(callsTo("PUT", "/api/reports/saved/s5")).toHaveLength(1))
    expect(screen.getByRole("button", { name: "Save as" })).toBeInTheDocument()
  })

  it("opens a saved report and runs it by itself", async () => {
    serve({ ...base, "GET /api/reports/saved/s1": () => SAVED_ONE, "POST /api/reports/saved/s1/run": () => RUN_RESULT })
    renderStudio("/reports/studio?r=s1")
    expect(await screen.findByRole("heading", { name: "Papers by department" })).toBeInTheDocument()
    await waitFor(() => expect(callsTo("POST", "/api/reports/saved/s1/run")).toHaveLength(1))
    expect(await screen.findByRole("table", { name: "Papers by department" })).toBeInTheDocument()
  })

  it("asks to save first when the report has not been saved, then goes on to the schedule", async () => {
    const user = userEvent.setup()
    serve({
      ...base,
      "POST /api/reports/saved": () => ({ ...SAVED_ONE, id: "s5", name: "Weekly" }),
      "POST /api/reports/saved/s5/schedule": () => ({ ok: true }),
      "GET /api/mentions/search": () => ({ results: [{ kind: "USER", id: "u-hod", label: "Dr Meera Pillai", hint: "Physics" }] }),
    })
    renderStudio("/reports/studio?t=by-department")
    await screen.findByTestId("result-summary")

    await user.click(screen.getByRole("button", { name: "Schedule" }))
    let dialog = await screen.findByRole("dialog")
    expect(within(dialog).getByText("Save the report first. Then you can go on.")).toBeInTheDocument()
    await user.type(within(dialog).getByLabelText("Name of the report"), "Weekly")
    await user.click(within(dialog).getByRole("button", { name: "Save report" }))

    dialog = await screen.findByRole("dialog", { name: "Send this report on a schedule" })
    await user.selectOptions(within(dialog).getByLabelText("How often"), "monthly")
    await user.selectOptions(within(dialog).getByLabelText("On which day of the month"), "15")
    await user.selectOptions(within(dialog).getByLabelText("At what time"), "9")
    await user.selectOptions(within(dialog).getByLabelText("Send it as"), "pdf")
    const save = within(dialog).getByRole("button", { name: "Save the schedule" })
    expect(save).toBeDisabled()
    await user.type(within(dialog).getByPlaceholderText("Type a name to add someone"), "Meera")
    await user.click(await within(dialog).findByRole("button", { name: /Dr Meera Pillai/ }))
    expect(save).toBeEnabled()
    await user.click(save)

    await waitFor(() => expect(callsTo("POST", "/api/reports/saved/s5/schedule")).toHaveLength(1))
    expect(callsTo("POST", "/api/reports/saved/s5/schedule")[0].json).toEqual({
      frequency: "monthly",
      day: 15,
      hour: 9,
      format: "pdf",
      recipients: ["u-hod"],
    })
  })

  it("stops a schedule", async () => {
    const user = userEvent.setup()
    const scheduled = {
      ...SAVED_ONE,
      schedule: { frequency: "weekly", day: 0, hour: 8, format: "xlsx", recipients: [{ id: "u-hod", name: "Dr Meera Pillai" }] },
    }
    serve({
      ...base,
      "GET /api/reports/saved/s1": () => scheduled,
      "POST /api/reports/saved/s1/run": () => RUN_RESULT,
      "DELETE /api/reports/saved/s1/schedule": () => null,
    })
    renderStudio("/reports/studio?r=s1")
    await user.click(await screen.findByRole("button", { name: "Schedule" }))
    const dialog = await screen.findByRole("dialog")
    expect(within(dialog).getByText("Dr Meera Pillai")).toBeInTheDocument()
    await user.click(within(dialog).getByRole("button", { name: "Stop sending" }))
    await waitFor(() => expect(callsTo("DELETE", "/api/reports/saved/s1/schedule")).toHaveLength(1))
  })

  it("downloads the whole report as Excel, PDF or CSV from the server", async () => {
    const user = userEvent.setup()
    serve(base)
    vi.mocked(apiFile).mockResolvedValue({ blob: new Blob(["x"]), filename: "papers-by-department.xlsx" })
    renderStudio("/reports/studio?t=by-department")
    await screen.findByTestId("result-summary")

    await user.click(screen.getByRole("button", { name: /Download/ }))
    await user.click(await screen.findByRole("menuitem", { name: "PDF" }))
    await waitFor(() => expect(apiFile).toHaveBeenCalledTimes(1))
    const [path, body] = vi.mocked(apiFile).mock.calls[0]
    expect(path).toBe("/api/reports/export")
    expect(body).toMatchObject({ dataset: "papers", group_by: ["department"], format: "pdf", title: "Papers by department" })
  })

  it("sends the table's own Export menu to the same server export", async () => {
    const user = userEvent.setup()
    serve(base)
    vi.mocked(apiFile).mockResolvedValue({ blob: new Blob(["x"]), filename: "r.csv" })
    renderStudio("/reports/studio?t=by-department")
    await screen.findByTestId("result-summary")
    await user.click(screen.getByRole("button", { name: "Export" }))
    await user.click(await screen.findByRole("menuitem", { name: "CSV" }))
    await waitFor(() => expect(apiFile).toHaveBeenCalledTimes(1))
    expect(vi.mocked(apiFile).mock.calls[0][1]).toMatchObject({ format: "csv", group_by: ["department"] })
  })

  it("makes a live link with the Excel and Google Sheets steps, and turns it off", async () => {
    const user = userEvent.setup()
    const url = "https://papers.example.edu/api/reports/feed/abc123.csv"
    serve({
      ...base,
      "GET /api/reports/saved/s1": () => SAVED_ONE,
      "POST /api/reports/saved/s1/run": () => RUN_RESULT,
      "POST /api/reports/saved/s1/feed": () => ({ url }),
      "DELETE /api/reports/saved/s1/feed": () => null,
    })
    renderStudio("/reports/studio?r=s1")
    await user.click(await screen.findByRole("button", { name: "Get a live link" }))
    const dialog = await screen.findByRole("dialog")
    await user.click(within(dialog).getByRole("button", { name: "Make a live link" }))

    expect(await within(dialog).findByDisplayValue(url)).toBeInTheDocument()
    expect(within(dialog).getByText(/From Web/)).toBeInTheDocument()
    expect(within(dialog).getByText(`=IMPORTDATA("${url}")`)).toBeInTheDocument()
    await user.click(within(dialog).getByRole("button", { name: "Copy the link" }))
    expect(await navigator.clipboard.readText()).toBe(url)

    await user.click(within(dialog).getByRole("button", { name: "Turn this link off" }))
    expect(callsTo("DELETE", "/api/reports/saved/s1/feed")).toHaveLength(0)
    await user.click(within(dialog).getByRole("button", { name: "Yes, turn it off" }))
    await waitFor(() => expect(callsTo("DELETE", "/api/reports/saved/s1/feed")).toHaveLength(1))
    expect(await within(dialog).findByRole("button", { name: "Make a live link" })).toBeInTheDocument()
  })

  it("makes a copy, not a change, of a report shared with me", async () => {
    serve({ ...base, "GET /api/reports/saved/s2": () => SAVED_SHARED, "POST /api/reports/saved/s2/run": () => RUN_RESULT })
    renderStudio("/reports/studio?r=s2")
    expect(await screen.findByText(/Meera Pillai shared this report with you/)).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Save as" })).toBeInTheDocument()
  })
})
