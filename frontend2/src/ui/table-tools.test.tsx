import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter } from "react-router-dom"
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/lib/table-export", () => ({
  exportTable: vi.fn(async () => "faculty.xlsx"),
  printTable: vi.fn(),
}))

import { exportTable, printTable } from "@/lib/table-export"
import { Table, type Column } from "@/ui/table"
import { useTablePrefs } from "@/ui/table-tools"

type Row = { id: string; name: string; dept: string; amount: number | null }
const rows: Row[] = [
  { id: "a", name: "Asha", dept: "EEE", amount: 5000 },
  { id: "b", name: "Ben", dept: "CSE", amount: null },
]
const columns: Column<Row>[] = [
  { key: "name", header: "Faculty", cell: (r) => r.name },
  { key: "dept", header: "Department", cell: (r) => r.dept },
  { key: "amount", header: "Amount", exportKind: "money", align: "right", cell: (r) => r.amount ?? null },
  { key: "act", header: "", label: "Open", cell: () => <button type="button">Open</button> },
]

const wrap = (ui: React.ReactElement) => render(<MemoryRouter>{ui}</MemoryRouter>)

beforeEach(() => {
  window.localStorage.clear()
  vi.mocked(exportTable).mockClear()
  vi.mocked(printTable).mockClear()
})

function Probe({ id, keys }: { id: string; keys: string[] }) {
  const p = useTablePrefs(id, keys)
  return (
    <div>
      <span data-testid="state">{`${[...p.hidden].sort().join(",")}|${p.grid}|${p.density}`}</span>
      <button type="button" onClick={() => p.setGrid(true)}>
        grid on
      </button>
      <button type="button" onClick={() => p.setDensity("compact")}>
        compact on
      </button>
      <button type="button" onClick={() => p.setHidden(new Set(["dept"]))}>
        hide dept
      </button>
      <button type="button" onClick={p.reset}>
        reset
      </button>
    </div>
  )
}

describe("useTablePrefs", () => {
  it("persists the view under table-prefs:<id> and reads it back", async () => {
    const user = userEvent.setup()
    const keys = ["name", "dept", "amount"]
    const first = render(<Probe id="faculty" keys={keys} />)
    await user.click(screen.getByRole("button", { name: "grid on" }))
    await user.click(screen.getByRole("button", { name: "compact on" }))
    await user.click(screen.getByRole("button", { name: "hide dept" }))
    expect(JSON.parse(window.localStorage.getItem("table-prefs:faculty")!)).toEqual({
      hidden: ["dept"],
      grid: true,
      density: "compact",
    })
    first.unmount()
    render(<Probe id="faculty" keys={keys} />)
    expect(screen.getByTestId("state")).toHaveTextContent("dept|true|compact")
  })

  it("works with no storage at all, for the length of the visit", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied")
    })
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("full")
    })
    const user = userEvent.setup()
    render(<Probe id="faculty" keys={["name", "dept"]} />)
    expect(screen.getByTestId("state")).toHaveTextContent("|false|comfortable")
    await user.click(screen.getByRole("button", { name: "grid on" }))
    expect(screen.getByTestId("state")).toHaveTextContent("|true|comfortable")
    vi.restoreAllMocks()
  })

  it("ignores a saved choice that hides the first column or leaves fewer than two", () => {
    window.localStorage.setItem("table-prefs:x", JSON.stringify({ hidden: ["name", "dept"], grid: false }))
    render(<Probe id="x" keys={["name", "dept"]} />)
    expect(screen.getByTestId("state")).toHaveTextContent("|false|comfortable")
  })
})

describe("TableToolbar through Table", () => {
  const tools = { id: "faculty", title: "Faculty", subtitle: "All faculty" }

  it("hides a column from the screen and from the export payload", async () => {
    const user = userEvent.setup()
    wrap(<Table rows={rows} columns={columns} getKey={(r) => r.id} tools={tools} />)
    await user.click(screen.getByRole("button", { name: "Columns" }))
    await user.click(await screen.findByRole("menuitemcheckbox", { name: "Department" }))
    await user.keyboard("{Escape}")
    expect(screen.queryByRole("columnheader", { name: "Department" })).toBeNull()

    await user.click(screen.getByRole("button", { name: "Export" }))
    await user.click(await screen.findByRole("menuitem", { name: "Excel (.xlsx)" }))
    await waitFor(() => expect(exportTable).toHaveBeenCalledTimes(1))
    const payload = vi.mocked(exportTable).mock.calls[0][0]
    expect(payload.columns.map((c) => c.key)).toEqual(["name", "amount"])
    expect(payload.format).toBe("xlsx")
  })

  it("never lets the first column be hidden, and keeps at least two columns", async () => {
    const user = userEvent.setup()
    wrap(<Table rows={rows} columns={columns} getKey={(r) => r.id} tools={tools} />)
    await user.click(screen.getByRole("button", { name: "Columns" }))
    expect(await screen.findByRole("menuitemcheckbox", { name: "Faculty" })).toHaveAttribute("data-disabled")
    await user.click(screen.getByRole("menuitemcheckbox", { name: "Faculty" }))
    expect(screen.getByRole("menuitemcheckbox", { name: "Faculty" })).toHaveAttribute("aria-checked", "true")
  })

  it("exports the visible rows, and the whole list from getAllRows when given", async () => {
    const user = userEvent.setup()
    const getAllRows = vi.fn(async () => [...rows, { id: "c", name: "Chitra", dept: "ECE", amount: 700 }])
    wrap(
      <Table
        rows={rows.slice(0, 1)}
        columns={columns}
        getKey={(r) => r.id}
        tools={{ ...tools, getAllRows }}
      />
    )
    await user.click(screen.getByRole("button", { name: "Export" }))
    await user.click(await screen.findByRole("menuitem", { name: "CSV" }))
    await waitFor(() => expect(exportTable).toHaveBeenCalled())
    expect(getAllRows).toHaveBeenCalledTimes(1)
    const payload = vi.mocked(exportTable).mock.calls[0][0]
    expect(payload.title).toBe("Faculty")
    expect(payload.subtitle).toBe("All faculty")
    expect(payload.columns).toEqual([
      { key: "name", label: "Faculty", kind: null },
      { key: "dept", label: "Department", kind: null },
      { key: "amount", label: "Amount", kind: "money" },
    ])
    expect(payload.rows).toEqual([
      ["Asha", "EEE", 5000],
      ["Ben", "CSE", null],
      ["Chitra", "ECE", 700],
    ])
  })

  it("exports the rows on screen when there is no getAllRows", async () => {
    const user = userEvent.setup()
    wrap(<Table rows={rows.slice(1)} columns={columns} getKey={(r) => r.id} tools={tools} />)
    await user.click(screen.getByRole("button", { name: "Export" }))
    await user.click(await screen.findByRole("menuitem", { name: "PDF" }))
    await waitFor(() => expect(exportTable).toHaveBeenCalled())
    expect(vi.mocked(exportTable).mock.calls[0][0].rows).toEqual([["Ben", "CSE", null]])
  })

  it("shows Preparing the file and disables the menu while the file is made", async () => {
    let finish: (name: string) => void = () => {}
    vi.mocked(exportTable).mockImplementationOnce(() => new Promise<string>((r) => (finish = r)))
    const user = userEvent.setup()
    wrap(<Table rows={rows} columns={columns} getKey={(r) => r.id} tools={tools} />)
    await user.click(screen.getByRole("button", { name: "Export" }))
    await user.click(await screen.findByRole("menuitem", { name: "Excel (.xlsx)" }))
    expect(await screen.findByRole("status")).toHaveTextContent("Preparing the file...")
    expect(screen.getByRole("button", { name: "Export" })).toBeDisabled()
    finish("faculty.xlsx")
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull())
  })

  it("prints through printTable with the title", async () => {
    const user = userEvent.setup()
    wrap(<Table rows={rows} columns={columns} getKey={(r) => r.id} tools={tools} />)
    await user.click(screen.getByRole("button", { name: "Export" }))
    await user.click(await screen.findByRole("menuitem", { name: "Print" }))
    expect(printTable).toHaveBeenCalledWith("Faculty")
    expect(exportTable).not.toHaveBeenCalled()
  })

  it("sets data-grid and data-density from the toggles and the reset link clears them", async () => {
    const user = userEvent.setup()
    const { container } = wrap(<Table rows={rows} columns={columns} getKey={(r) => r.id} tools={tools} />)
    const table = container.querySelector("table")!
    expect(table).not.toHaveAttribute("data-grid")
    expect(table).not.toHaveAttribute("data-density")
    await user.click(screen.getByRole("button", { name: "Grid lines" }))
    await user.click(screen.getByRole("button", { name: "Compact rows" }))
    expect(table).toHaveAttribute("data-grid", "true")
    expect(table).toHaveAttribute("data-density", "compact")
    expect(screen.getByRole("button", { name: "Grid lines" })).toHaveAttribute("aria-pressed", "true")
    await user.click(screen.getByRole("button", { name: "Reset" }))
    expect(table).not.toHaveAttribute("data-grid")
    expect(table).not.toHaveAttribute("data-density")
  })

  it("renders no toolbar at all without tools", () => {
    const { container } = wrap(<Table rows={rows} columns={columns} getKey={(r) => r.id} />)
    expect(container.querySelector(".table-tools")).toBeNull()
    expect(screen.queryByRole("button", { name: "Export" })).toBeNull()
    expect(within(container).queryByRole("button", { name: "Grid lines" })).toBeNull()
  })
})
