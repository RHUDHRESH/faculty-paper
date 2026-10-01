import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter } from "react-router-dom"
import { describe, expect, it, vi } from "vitest"

import { isBlankCell, Table, type Column } from "@/ui/table"

type Row = { id: string; name: string; amount: number | null; note: string | null }
const rows: Row[] = [
  { id: "a", name: "ERP-RAW-3", amount: null, note: "-" },
  { id: "b", name: "FP-2026-000002", amount: 5000, note: "checked" },
]
const columns: Column<Row>[] = [
  { key: "name", header: "Claim no.", cell: (r) => r.name },
  { key: "amount", header: "Amount", align: "right", cell: (r) => r.amount },
  { key: "note", header: "Note", cell: (r) => r.note, sortable: true },
  { key: "act", header: "", label: "Open", cell: () => <button type="button">Open</button> },
]

const wrap = (ui: React.ReactElement) => render(<MemoryRouter>{ui}</MemoryRouter>)

describe("Table (docs/ux/22)", () => {
  it("gives every column a heading, including one whose heading is blank", () => {
    wrap(<Table rows={rows} columns={columns} getKey={(r) => r.id} />)
    const heads = screen.getAllByRole("columnheader")
    expect(heads).toHaveLength(4)
    for (const h of heads) expect(h.textContent?.trim(), "a column with no name").not.toBe("")
    expect(within(heads[3]).getByText("Open")).toHaveClass("sr-only")
  })

  it("says Not recorded for a missing value, never a blank cell or a lone dash", () => {
    wrap(<Table rows={rows} columns={columns} getKey={(r) => r.id} />)
    // amount null and note "-" on the first row.
    expect(screen.getAllByText("Not recorded")).toHaveLength(2)
    // A real number, and a zero, are values.
    expect(isBlankCell(0)).toBe(false)
    expect(isBlankCell("—")).toBe(true)
    expect(isBlankCell("- ".repeat(3).trim())).toBe(true)
    expect(isBlankCell("None")).toBe(false)
    // A dash wrapped in a plain element is still a dash; an image is not blank.
    expect(isBlankCell(<span className="tabular">—</span>)).toBe(true)
    expect(isBlankCell(<div><span>-</span></div>)).toBe(true)
    expect(isBlankCell(<span>12</span>)).toBe(false)
    expect(isBlankCell(<img alt="" src="x" />)).toBe(false)
  })

  it("lets a column say None when absence is a fact", () => {
    const cols: Column<Row>[] = [
      { key: "name", header: "Claim no.", cell: (r) => r.name },
      { key: "note", header: "Flags", empty: "None", cell: () => null },
    ]
    wrap(<Table rows={rows} columns={cols} getKey={(r) => r.id} />)
    expect(screen.getAllByText("None")).toHaveLength(2)
    expect(screen.queryByText("Not recorded")).toBeNull()
  })

  it("right-aligns numbers in tabular figures", () => {
    wrap(<Table rows={rows} columns={columns} getKey={(r) => r.id} />)
    const cell = screen.getByText("5000").closest("td")
    expect(cell).toHaveClass("text-right")
    expect(cell).toHaveClass("tabular")
  })

  it("keeps the labels when the rows stack on a phone", () => {
    wrap(<Table rows={rows} columns={columns} getKey={(r) => r.id} />)
    expect(document.querySelector("table")).toHaveClass("stack-table")
    const first = document.querySelectorAll("tbody tr")[0]
    const labels = [...first.querySelectorAll("td")].map((td) => td.getAttribute("data-label"))
    expect(labels).toEqual(["Claim no.", "Amount", "Note", "Open"])
  })

  it("can be a plain grid when stacking would make no sense", () => {
    wrap(<Table rows={rows} columns={columns} getKey={(r) => r.id} stack={false} />)
    expect(document.querySelector("table")).not.toHaveClass("stack-table")
  })

  it("sorts from the heading, and says which way", async () => {
    const onSort = vi.fn()
    wrap(<Table rows={rows} columns={columns} getKey={(r) => r.id} sortKey="note" sortDir="desc" onSort={onSort} />)
    const head = screen.getByRole("columnheader", { name: /note/i })
    expect(head).toHaveAttribute("aria-sort", "descending")
    await userEvent.click(within(head).getByRole("button"))
    expect(onSort).toHaveBeenCalledWith("note")
    // A column that is not sortable is not a button.
    expect(within(screen.getByRole("columnheader", { name: /amount/i })).queryByRole("button")).toBeNull()
  })

  it("says Not recorded when a cell renders an empty string, an empty list or an empty fragment", () => {
    const cols: Column<Row>[] = [
      { key: "name", header: "Claim no.", cell: (r) => r.name },
      { key: "a", header: "A", cell: () => "" },
      { key: "b", header: "B", cell: () => [] },
      { key: "c", header: "C", cell: () => <>{""}</> },
    ]
    wrap(<Table rows={rows.slice(0, 1)} columns={cols} getKey={(r) => r.id} />)
    expect(screen.getAllByText("Not recorded")).toHaveLength(3)
  })

  it("adds a totals row under the last row, blank where a column has no total", () => {
    wrap(
      <Table
        rows={rows}
        columns={columns}
        getKey={(r) => r.id}
        footer={{ name: "Total, 2 claims", amount: "5,000" }}
      />
    )
    const foot = document.querySelectorAll("tfoot tr")
    expect(foot).toHaveLength(1)
    expect(within(foot[0] as HTMLElement).getByText("Total, 2 claims")).toBeInTheDocument()
    expect(foot[0].querySelector("td:nth-child(2)")).toHaveClass("text-right")
    // A column with no total is not stacked as an empty labelled line on a phone.
    expect(foot[0].querySelector("td:nth-child(3)")).toHaveClass("max-sm:hidden")
  })

  it("keeps a long cell to one line and puts the whole text in a tooltip", () => {
    const long = "A very long paper title that would otherwise wrap into a tall row"
    const cols: Column<Row>[] = [
      { key: "name", header: "Title", truncate: true, cell: () => long },
      { key: "note", header: "Note", cell: (r) => r.note ?? "x" },
    ]
    wrap(<Table rows={rows.slice(1)} columns={cols} getKey={(r) => r.id} />)
    const el = screen.getByText(long)
    expect(el).toHaveAttribute("title", long)
    expect(el).toHaveClass("sm:truncate")
    expect(screen.getByText("checked")).not.toHaveAttribute("title")
  })

  it("explains an empty list with what would be here and one action", () => {
    wrap(
      <Table
        rows={[]}
        columns={columns}
        getKey={(r) => r.id}
        empty={{ title: "No imports yet", message: "Each file you bring in is listed here.", action: <button>Import a file</button> }}
      />
    )
    expect(screen.getByText("No imports yet")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Import a file" })).toBeInTheDocument()
  })
})
