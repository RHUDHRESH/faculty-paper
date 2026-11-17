import { screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return { ...actual, api: vi.fn() }
})

import { api } from "@/lib/api"
import { ApiDocs } from "@/pages/api-docs"
import { buildExamples } from "@/pages/api-examples"
import { fakeApi, renderWithProviders } from "@/test/harness"

const field = (name: string, type = "text", money = false) => ({
  name,
  type,
  description: `The ${name}.`,
  money,
})

function meta(over: { money?: boolean; payments?: boolean } = {}) {
  const money = over.money ?? true
  return {
    version: 1,
    rate_limit_per_minute: 60,
    max_page_size: 1000,
    max_file_page_size: 20000,
    formats: ["json", "csv", "xlsx"],
    params: { year: "Only this year.", page_size: "Rows per page." },
    endpoints: [
      {
        name: "papers",
        path: "/api/v1/papers",
        scope: "read:papers",
        title: "Papers",
        description: "The publication record.",
        who: "Faculty: your own papers.",
        available: true,
        params: ["year", "page"],
        date_field: "date",
        fields: [field("title"), field("doi"), field("citations", "number")],
      },
      {
        name: "claims",
        path: "/api/v1/claims",
        scope: "read:claims",
        title: "Claims",
        description: "Incentive claims.",
        who: "Faculty: your own claims.",
        available: true,
        params: ["year"],
        date_field: "filed date",
        fields: [field("claim_no"), ...(money ? [field("amount", "money", true)] : [])],
      },
      {
        name: "payments",
        path: "/api/v1/payments",
        scope: "read:payments",
        title: "Payments",
        description: "The paid ledger.",
        who: "Not for heads.",
        available: over.payments ?? true,
        params: ["year"],
        date_field: "month paid",
        fields: [field("voucher")],
      },
    ],
  }
}

beforeEach(() => {
  vi.mocked(api).mockReset()
})

describe("the API documentation page", () => {
  it("renders every endpoint, its parameters and its fields from /api/v1/meta", async () => {
    vi.mocked(api).mockImplementation(fakeApi({ "/api/auth/me": () => ({}), "/api/v1/meta": () => meta() }))
    renderWithProviders(<ApiDocs />, { route: "/api-docs" })
    expect(await screen.findByRole("heading", { level: 1, name: "API documentation" })).toBeInTheDocument()
    await screen.findByRole("heading", { name: "Papers" })
    for (const title of ["Papers", "Claims", "Payments"]) {
      expect(screen.getByRole("heading", { name: title })).toBeInTheDocument()
    }
    const fields = screen.getByRole("list", { name: "Claims fields" })
    expect(within(fields).getByText("claim_no")).toBeInTheDocument()
    expect(within(fields).getByText("amount")).toBeInTheDocument()
    expect(screen.getByText(/limited to 60 requests a minute/)).toBeInTheDocument()
    expect(screen.getByRole("link", { name: /API access on your profile/ })).toHaveAttribute("href", "/me")
  })

  it("shows a head of department no amount field, and says a closed endpoint is closed", async () => {
    vi.mocked(api).mockImplementation(
      fakeApi({ "/api/auth/me": () => ({}), "/api/v1/meta": () => meta({ money: false, payments: false }) })
    )
    renderWithProviders(<ApiDocs />, { route: "/api-docs" })
    await screen.findByRole("heading", { name: "Claims" })
    expect(within(screen.getByRole("list", { name: "Claims fields" })).queryByText("amount")).not.toBeInTheDocument()
    expect(screen.getByText("Your role cannot read this, so a token of yours cannot either.")).toBeInTheDocument()
  })

  it("switches the copy-ready example between Excel, Python, curl and Google Sheets", async () => {
    const user = userEvent.setup()
    vi.mocked(api).mockImplementation(fakeApi({ "/api/auth/me": () => ({}), "/api/v1/meta": () => meta() }))
    renderWithProviders(<ApiDocs />, { route: "/api-docs" })
    await screen.findByRole("heading", { name: "Papers" })
    // Power Query is the first thing an Excel user needs.
    expect(screen.getAllByLabelText(/Excel Power Query example for Papers/)[0].textContent).toContain("Web.Contents")
    await user.click(screen.getByRole("radio", { name: "Google Sheets" }))
    expect(screen.getAllByLabelText(/Google Sheets example for Papers/)[0].textContent).toContain("UrlFetchApp.fetch")
    await user.click(screen.getByRole("radio", { name: "Python" }))
    expect(screen.getAllByLabelText(/Python example for Papers/)[0].textContent).toContain("requests.get")
    await user.click(screen.getByRole("radio", { name: "curl" }))
    expect(screen.getAllByLabelText(/curl example for Papers/)[0].textContent).toContain(
      "Authorization: Bearer YOUR_TOKEN"
    )
  })
})

describe("the copy-ready examples", () => {
  const ex = buildExamples({ origin: "https://papers.example.edu", path: "/api/v1/claims", params: { year: "2025" } })

  it("sends the token as a header, never in the address, and never a real one", () => {
    for (const code of Object.values(ex)) {
      expect(code).toContain("YOUR_TOKEN")
      expect(code).not.toMatch(/sec_[A-Za-z0-9_-]{10,}/)
      expect(code).not.toMatch(/\?[^"\s]*token=/)
    }
  })

  it("builds Power Query with Web.Contents, an Authorization header and format=csv", () => {
    expect(ex.excel).toContain("Web.Contents")
    expect(ex.excel).toContain('Headers = [Authorization = "Bearer YOUR_TOKEN"]')
    expect(ex.excel).toContain('format="csv"')
    expect(ex.excel).toContain('"https://papers.example.edu/api/v1/claims"')
  })

  it("builds an Apps Script that fetches csv with the header and drops the byte-order mark", () => {
    expect(ex.sheets).toContain("UrlFetchApp.fetch")
    expect(ex.sheets).toContain("format=csv")
    expect(ex.sheets).toContain('Authorization: "Bearer YOUR_TOKEN"')
    expect(ex.sheets).toContain("\\uFEFF")
  })

  it("pages through `next` in Python", () => {
    expect(ex.python).toContain('body["next"]')
    expect(ex.python).toContain('"year": "2025"')
  })
})
