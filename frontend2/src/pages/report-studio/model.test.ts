import { describe, expect, it } from "vitest"

import {
  buildRunBody,
  describeResult,
  describeSchedule,
  emptyDefinition,
  formatCell,
  formatDate,
  newFilter,
  problemsWith,
  readDatasets,
  readDefinition,
  readResult,
  readSavedLists,
  rowObjects,
  type Dataset,
  type Definition,
} from "./model"
import { DATASETS } from "@/test/studio-fixtures"
import { chartColumns, chartKindOf, chartPoints } from "./result-chart"

const dataset: Dataset = readDatasets(DATASETS)[0]

const def = (patch: Partial<Definition>): Definition => ({ ...emptyDefinition("papers"), columns: ["title"], ...patch })

describe("readDatasets", () => {
  it("reads a list or an object around the list, and keeps enum choices", () => {
    expect(readDatasets(DATASETS)).toHaveLength(1)
    expect(readDatasets(DATASETS.datasets)).toHaveLength(1)
    const dept = dataset.fields.find((f) => f.key === "department")!
    expect(dept.options).toEqual([
      { value: "CSE", label: "CSE" },
      { value: "ECE", label: "ECE" },
      { value: "Physics", label: "Physics" },
    ])
  })
})

describe("buildRunBody", () => {
  it("sends each kind of condition in the type the server compares", () => {
    const body = buildRunBody(
      def({
        filters: [
          { id: "a", field: "pages", op: "gt", value: "10" },
          { id: "b", field: "published_on", op: "between", value: ["2026-01-01", "2026-03-31"] },
          { id: "c", field: "department", op: "in", value: ["CSE", "ECE"] },
          { id: "d", field: "scopus", op: "eq", value: "false" },
          { id: "e", field: "amount", op: "between", value: ["1000", "5000"] },
          { id: "f", field: "title", op: "contains", value: "graph" },
        ],
      }),
      dataset
    )
    expect(body.filters).toEqual([
      { field: "pages", op: "gt", value: 10 },
      { field: "published_on", op: "between", value: ["2026-01-01", "2026-03-31"] },
      { field: "department", op: "in", value: ["CSE", "ECE"] },
      { field: "scopus", op: "eq", value: false },
      { field: "amount", op: "between", value: [1000, 5000] },
      { field: "title", op: "contains", value: "graph" },
    ])
  })

  it("leaves out a condition that has no value yet", () => {
    const body = buildRunBody(
      def({
        filters: [
          { id: "a", field: "pages", op: "gt", value: "" },
          { id: "b", field: "department", op: "in", value: [] },
          { id: "c", field: "published_on", op: "between", value: ["2026-01-01", ""] },
          { id: "d", field: "pages", op: "gt", value: "0" },
        ],
      }),
      dataset
    )
    expect(body.filters).toEqual([{ field: "pages", op: "gt", value: 0 }])
  })

  it("builds group, bucket, totals, order and top rows", () => {
    const body = buildRunBody(
      def({
        group_by: ["department", "published_on"],
        date_bucket: "year",
        aggregates: [
          { field: "amount", fn: "sum", label: "  Total incentive " },
          { field: "title", fn: "count" },
        ],
        sort: [{ field: "amount", dir: "desc" }],
        top_n: 10,
      }),
      dataset
    )
    expect(body).toEqual({
      dataset: "papers",
      columns: ["title"],
      filters: [],
      group_by: ["department", "published_on"],
      date_bucket: "year",
      aggregates: [
        { field: "amount", fn: "sum", label: "Total incentive" },
        { field: "title", fn: "count" },
      ],
      pivot: null,
      sort: [{ field: "amount", dir: "desc" }],
      limit: 1000,
      top_n: 10,
    })
  })

  it("sends no date bucket when no date is grouped", () => {
    const body = buildRunBody(def({ group_by: ["department"], date_bucket: "year" }), dataset)
    expect(body.date_bucket).toBeNull()
    expect(buildRunBody(def({ group_by: ["published_on"], date_bucket: "none" }), dataset).date_bucket).toBeNull()
  })

  it("sends a grid on its own, without groups or totals", () => {
    const body = buildRunBody(
      def({
        group_by: ["department"],
        aggregates: [{ field: "amount", fn: "sum" }],
        pivot: { rows: "department", columns: "academic_year", value: { field: "amount", fn: "sum" } },
      }),
      dataset
    )
    expect(body.pivot).toEqual({ rows: "department", columns: "academic_year", value: { field: "amount", fn: "sum" } })
    expect(body.group_by).toEqual([])
    expect(body.aggregates).toEqual([])
  })

  it("does not send a grid that is not finished", () => {
    const body = buildRunBody(def({ pivot: { rows: "department", columns: "", value: { field: "amount", fn: "sum" } } }), dataset)
    expect(body.pivot).toBeNull()
  })
})

describe("problemsWith", () => {
  it("says in words what is missing", () => {
    expect(problemsWith(emptyDefinition())[0]).toMatch(/what the report is about/i)
    expect(problemsWith(emptyDefinition("papers"))[0]).toMatch(/at least one/i)
    expect(problemsWith(def({}))).toEqual([])
    expect(problemsWith(def({ columns: [], group_by: ["department"] }))).toEqual([])
    expect(problemsWith(def({ pivot: { rows: "a", columns: "", value: { field: "b", fn: "sum" } } }))[0]).toMatch(/grid/i)
  })
})

describe("newFilter", () => {
  it("starts with the first comparison for the kind of field", () => {
    const f = (key: string) => newFilter(dataset.fields.find((x) => x.key === key)!)
    expect(f("title")).toMatchObject({ op: "contains", value: "" })
    expect(f("pages")).toMatchObject({ op: "eq", value: "" })
    expect(f("department")).toMatchObject({ op: "in", value: [] })
    expect(f("published_on")).toMatchObject({ op: "eq" })
    expect(f("scopus")).toMatchObject({ op: "eq", value: "true" })
  })
})

describe("reading what the server sends", () => {
  it("fills every part of a definition from a template", () => {
    const d = readDefinition({ dataset: "papers", group_by: ["a", "b", "c", "d"], filters: [{ field: "x", op: "eq", value: 1 }] })
    expect(d.group_by).toHaveLength(3)
    expect(d.filters[0]).toMatchObject({ field: "x", op: "eq", value: 1 })
    expect(d.date_bucket).toBe("none")
    expect(d.limit).toBe(1000)
  })

  it("accepts the saved lists as two lists or one", () => {
    const one = { id: "1", name: "A", dataset: "papers", definition: { dataset: "papers" } }
    const two = { id: "2", name: "B", dataset: "papers", definition: { dataset: "papers" } }
    expect(readSavedLists({ mine: [one], shared: [two] })).toMatchObject({ mine: [{ id: "1", mine: true }], shared: [{ id: "2", mine: false }] })
    const flat = readSavedLists([{ ...one, mine: true }, { ...two, mine: false }])
    expect(flat.mine.map((r) => r.id)).toEqual(["1"])
    expect(flat.shared.map((r) => r.id)).toEqual(["2"])
  })

  it("reads rows whether they come as objects or as lists", () => {
    const columns = [
      { key: "a", label: "A", type: "string" },
      { key: "b", label: "B", type: "number" },
    ]
    expect(rowObjects(readResult({ columns, rows: [{ a: "x", b: 1 }] }))).toEqual([{ a: "x", b: 1 }])
    expect(rowObjects(readResult({ columns, rows: [["x", 1]] }))).toEqual([{ a: "x", b: 1 }])
  })
})

describe("how results read", () => {
  it("formats by type, and leaves a missing value to say Not recorded", () => {
    expect(formatCell("money", 109265)).toBe("₹1,09,265")
    expect(formatCell("number", 1234.5)).toBe("1,234.5")
    expect(formatCell("bool", true)).toBe("Yes")
    expect(formatCell("date", "2026-04-01")).toBe("1 Apr 2026")
    expect(formatCell("string", null)).toBeNull()
    expect(formatDate("2026-04")).toBe("Apr 2026")
  })

  it("says what the report is, in a sentence", () => {
    const result = readResult({ columns: [], rows: [], total_rows: 1234 })
    expect(describeResult(def({ group_by: ["department", "academic_year"] }), dataset, result)).toBe(
      "1,234 rows, grouped by department and academic year"
    )
    expect(describeResult(def({}), dataset, readResult({ total_rows: 1 }))).toBe("1 row")
    expect(
      describeResult(
        def({ group_by: ["published_on"], date_bucket: "month", filters: [{ id: "a", field: "pages", op: "gt", value: "1" }] }),
        dataset,
        result
      )
    ).toBe("1,234 rows, grouped by date published (by month), narrowed by 1 condition")
    expect(
      describeResult(
        def({ pivot: { rows: "department", columns: "academic_year", value: { field: "amount", fn: "sum" } } }),
        dataset,
        result
      )
    ).toBe("1,234 rows, as a grid of department down the side and academic year across the top")
  })

  it("says when a report is sent, in words", () => {
    expect(describeSchedule(null)).toBe("Not scheduled")
    expect(describeSchedule({ frequency: "weekly", day: 0, hour: 8, format: "xlsx", recipients: [] })).toBe("Every Monday at 8:00 am, as Excel")
    expect(describeSchedule({ frequency: "monthly", day: 1, hour: 15, format: "pdf", recipients: [] })).toBe(
      "On the 1st of every month at 3:00 pm, as PDF"
    )
  })
})

describe("charts", () => {
  const result = readResult({
    columns: [
      { key: "department", label: "Department", type: "enum" },
      { key: "total", label: "Total incentive", type: "money" },
    ],
    rows: [
      { department: "CSE", total: 150000 },
      { department: "ECE", total: null },
      { department: "Physics", total: 60000 },
    ],
    chart_hint: { kind: "bar", x: "department", y: "total" },
  })

  it("reads the hint's kind and the two columns it names", () => {
    expect(chartKindOf({ kind: "bar", x: null, y: null })).toBe("bar")
    expect(chartKindOf({ kind: "line", x: null, y: null })).toBe("line")
    expect(chartKindOf({ kind: "donut", x: null, y: null })).toBe("pie")
    expect(chartKindOf({ kind: null, x: null, y: null })).toBeNull()
    expect(chartColumns(result)).toMatchObject({ x: { key: "department" }, y: { key: "total" } })
  })

  it("takes the first column when the server names the value columns as a list", () => {
    const listed = readResult({
      columns: [
        { key: "department", label: "Department", type: "enum" },
        { key: "papers", label: "Papers", type: "number" },
        { key: "total", label: "Total incentive", type: "money" },
      ],
      rows: [{ department: "CSE", papers: 4, total: 150000 }],
      chart_hint: { kind: "bar", x: "department", y: ["total", "papers"] },
    })
    expect(listed.chart_hint?.y).toBe("total")
    expect(chartColumns(listed)).toMatchObject({ x: { key: "department" }, y: { key: "total" } })
  })

  it("draws only the rows that have a figure", () => {
    expect(chartPoints(result)).toEqual([
      { label: "CSE", value: 150000, shown: "₹1,50,000" },
      { label: "Physics", value: 60000, shown: "₹60,000" },
    ])
  })
})
