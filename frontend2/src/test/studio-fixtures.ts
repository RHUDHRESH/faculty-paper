/** What the Report studio's tests pretend the server answers. */

export const DATASETS = {
  datasets: [
    {
      key: "papers",
      label: "Papers",
      description: "Every paper the college has claimed.",
      fields: [
        { key: "title", label: "Title", type: "string" },
        { key: "department", label: "Department", type: "enum", options: ["CSE", "ECE", "Physics"] },
        { key: "published_on", label: "Date published", type: "date" },
        { key: "pages", label: "Pages", type: "number" },
        { key: "amount", label: "Incentive", type: "money" },
        { key: "scopus", label: "In Scopus", type: "bool" },
        { key: "academic_year", label: "Academic year", type: "string" },
      ],
    },
  ],
}

export const TEMPLATES = {
  templates: [
    {
      key: "by-department",
      name: "Papers by department",
      description: "How many papers each department has, and what was paid.",
      definition: {
        dataset: "papers",
        columns: [],
        group_by: ["department"],
        aggregates: [{ field: "amount", fn: "sum", label: "Total incentive" }],
        sort: [{ field: "amount", dir: "desc" }],
      },
    },
    {
      key: "recent",
      name: "Recent papers",
      description: "The latest papers filed.",
      definition: { dataset: "papers", columns: ["title", "department"] },
    },
  ],
}

export const RUN_RESULT = {
  columns: [
    { key: "department", label: "Department", type: "enum" },
    { key: "total", label: "Total incentive", type: "money" },
  ],
  rows: [
    { department: "CSE", total: 150000 },
    { department: "ECE", total: 90000 },
    { department: "Physics", total: 60000 },
  ],
  total_rows: 1234,
  truncated: false,
  chart_hint: { kind: "bar", x: "department", y: "total" },
}

export const SAVED_ONE = {
  id: "s1",
  name: "Papers by department",
  description: "For the Monday meeting",
  dataset: "papers",
  visibility: "private",
  mine: true,
  owner: { id: "u-office", name: "R Iyer" },
  last_run_at: "2026-11-10T09:30:00Z",
  schedule: null,
  feed_url: null,
  definition: {
    dataset: "papers",
    columns: [],
    group_by: ["department"],
    aggregates: [{ field: "amount", fn: "sum" }],
  },
}

export const SAVED_SHARED = {
  ...SAVED_ONE,
  id: "s2",
  name: "Finance month end",
  description: "",
  mine: false,
  visibility: "everyone",
  owner: { id: "u-fin", name: "Meera Pillai" },
  last_run_at: null,
}
