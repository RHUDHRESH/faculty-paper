import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return { ...actual, api: vi.fn() }
})

import { ApiError, api } from "@/lib/api"
import { Imports } from "@/pages/imports"
import { FACULTY, fakeApi, renderWithProviders } from "@/test/harness"
import type { Me } from "@/app/auth"

const OFFICE: Me = {
  id: "u-cell",
  email: "cell@example.edu",
  name: "Research Office",
  role: "RESEARCH_CELL",
  department: null,
}

const STATS = {
  faculty_master: 435, claims: 10, claims_paid: 2, prior_payments: 0,
  paid_ledger: 0, scimago: 0, snip: 0, users: 411,
}

const FACULTY_CHECK = {
  dry_run: true,
  sheets: { Teaching: { people: 3 } },
  counts: { created: 2, updated: 1, unchanged: 5, conflicts: 1, needs_email: 1 },
  created: [
    { staff_id: "TS101", name: "Dr New Person", email: "new@example.edu", faculty_type: "Teaching", department: "ECE" },
  ],
  updated_fields: { designation: 1, phone: 0, scopus_author_id: 0, email: 0 },
  conflicts: [{ staff_id: "TS007", name: "Dr Old Hand", field: "phone", current: "9000000001", incoming: "9000000002" }],
  needs_email: [{ staff_id: "TS102", name: "Mr No Mail" }],
  not_in_list: 0,
}

const CLAIMS_CHECK = {
  dry_run: true,
  rows: 40,
  counts: {
    already_recorded: 30, new: 8, amount_differs: 1, zero_amount: 0,
    unmatched_staff: 1, unparseable_amount: 0, doi_filled: 2,
  },
  new_total_amount: 109265,
  by_month: [{ month: "2026-09", new: 8, amount: 109265 }],
  amount_differs: [
    { staff_id: "TS007", name: "Dr Old Hand", title: "A study of beams", ledger_amount: 5000, file_amount: 7500, month: "2026-08" },
  ],
  unmatched_staff: [{ staff_id: "TS999", name: "Unknown Person" }],
}

function dryRunOf(call: unknown[]): string | null {
  const body = (call[1] as { body?: FormData } | undefined)?.body
  return body instanceof FormData ? String(body.get("dry_run")) : null
}

function mount(opts: { me?: Me; faculty?: () => unknown; claims?: () => unknown } = {}) {
  const me = opts.me ?? OFFICE
  vi.mocked(api).mockReset()
  const base = fakeApi({
    "/api/auth/me": () => me,
    "/api/admin/erp-stats": () => STATS,
    "/api/admin/faculty-master": () => [],
    "/api/admin/process": () => [],
  })
  // The import answers carry `dry_run` as the request asked for it.
  const answer = (path: string, init: unknown, make: () => unknown) => {
    try {
      const data = make() as object
      return Promise.resolve({ ...data, dry_run: dryRunOf([path, init]) === "true" })
    } catch (err) {
      return Promise.reject(err)
    }
  }
  vi.mocked(api).mockImplementation(((path: string, init?: unknown) => {
    if (path === "/api/admin/faculty-list/import") return answer(path, init, opts.faculty ?? (() => FACULTY_CHECK))
    if (path === "/api/admin/settled-claims/import") return answer(path, init, opts.claims ?? (() => CLAIMS_CHECK))
    return base(path)
  }) as typeof api)
  return renderWithProviders(<Imports />, { route: "/imports" })
}

const importCalls = (path: string) => vi.mocked(api).mock.calls.filter(([p]) => p === path)

function xlsx(name = "file.xlsx") {
  return new File(["x"], name, {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  })
}

describe("the monthly files", () => {
  it("sits under a plain heading at the top of the page", async () => {
    mount()
    const heading = await screen.findByRole("heading", { name: "Monthly files" })
    const older = screen.getByRole("heading", { name: "Load a file" })
    expect(heading.compareDocumentPosition(older) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it("keeps Import off until the file has been checked", async () => {
    const user = userEvent.setup()
    mount()
    const card = await screen.findByRole("region", { name: "Faculty list" })
    const importBtn = within(card).getByRole("button", { name: "Import" })
    expect(importBtn).toBeDisabled()
    expect(within(card).getByRole("button", { name: "Check the file" })).toBeDisabled()

    await user.upload(within(card).getByLabelText(/faculty list workbook/i), xlsx())
    expect(importBtn).toBeDisabled()
    expect(within(card).getByRole("button", { name: "Check the file" })).toBeEnabled()
  })

  it("checks the faculty list, then imports it", async () => {
    const user = userEvent.setup()
    mount({ faculty: () => ({ ...FACULTY_CHECK, dry_run: false }) })
    const card = await screen.findByRole("region", { name: "Faculty list" })
    await user.upload(within(card).getByLabelText(/faculty list workbook/i), xlsx())
    await user.click(within(card).getByRole("button", { name: "Check the file" }))

    await within(card).findByText(/Nothing is saved yet/)
    // The check is a dry run.
    expect(importCalls("/api/admin/faculty-list/import").map(dryRunOf)).toEqual(["true"])
    expect(within(card).getByText("Dr New Person")).toBeInTheDocument()
    expect(within(card).getByText("9000000002")).toBeInTheDocument()
    expect(within(card).getByText("Mr No Mail")).toBeInTheDocument()
    expect(within(card).getByText("Conflicts to look at (1)")).toBeInTheDocument()

    const importBtn = within(card).getByRole("button", { name: "Import" })
    expect(importBtn).toBeEnabled()
    await user.click(importBtn)

    await within(card).findByText(/Imported\. This is what was saved/)
    expect(importCalls("/api/admin/faculty-list/import").map(dryRunOf)).toEqual(["true", "false"])
    // Once imported, it cannot be imported again without a new check.
    expect(within(card).getByRole("button", { name: "Import" })).toBeDisabled()
  })

  it("checks the settled claims in rupees, then imports them", async () => {
    const user = userEvent.setup()
    mount({ claims: () => CLAIMS_CHECK })
    const card = await screen.findByRole("region", { name: "Settled claims" })
    await user.upload(within(card).getByLabelText(/settled claims workbook/i), xlsx())
    await user.click(within(card).getByRole("button", { name: "Check the file" }))

    await within(card).findByText(/Nothing is saved yet/)
    // Indian grouping, not 109,265.
    expect(within(card).getAllByText("₹1,09,265").length).toBeGreaterThan(0)
    expect(within(card).getByText("2026-09")).toBeInTheDocument()
    expect(within(card).getByText("A study of beams")).toBeInTheDocument()
    expect(within(card).getByText("₹7,500")).toBeInTheDocument()
    expect(within(card).getByText("Unknown Person")).toBeInTheDocument()
    expect(
      within(card).getByText("Amounts that differ are reported only; nothing already recorded is changed.")
    ).toBeInTheDocument()

    await user.click(within(card).getByRole("button", { name: "Import" }))
    await waitFor(() =>
      expect(importCalls("/api/admin/settled-claims/import").map(dryRunOf)).toEqual(["true", "false"])
    )
    await within(card).findByText(/Imported\. This is what was saved/)
  })

  it("never sends the import twice for a double click", async () => {
    const user = userEvent.setup()
    mount()
    const card = await screen.findByRole("region", { name: "Settled claims" })
    await user.upload(within(card).getByLabelText(/settled claims workbook/i), xlsx())
    await user.click(within(card).getByRole("button", { name: "Check the file" }))
    await within(card).findByText(/Nothing is saved yet/)

    await user.dblClick(within(card).getByRole("button", { name: "Import" }))
    await within(card).findByText(/Imported\. This is what was saved/)
    expect(importCalls("/api/admin/settled-claims/import").map(dryRunOf)).toEqual(["true", "false"])
  })

  it("starts again when the file changes", async () => {
    const user = userEvent.setup()
    mount()
    const card = await screen.findByRole("region", { name: "Faculty list" })
    const input = within(card).getByLabelText(/faculty list workbook/i)
    await user.upload(input, xlsx("one.xlsx"))
    await user.click(within(card).getByRole("button", { name: "Check the file" }))
    await within(card).findByText(/Nothing is saved yet/)
    expect(within(card).getByRole("button", { name: "Import" })).toBeEnabled()

    await user.upload(input, xlsx("two.xlsx"))
    expect(within(card).queryByText(/Nothing is saved yet/)).not.toBeInTheDocument()
    expect(within(card).getByRole("button", { name: "Import" })).toBeDisabled()
  })

  it("shows the server's error, and leaves Import off", async () => {
    const user = userEvent.setup()
    mount({
      claims: () => {
        throw new ApiError(400, "The file has no Amount column.")
      },
    })
    const card = await screen.findByRole("region", { name: "Settled claims" })
    await user.upload(within(card).getByLabelText(/settled claims workbook/i), xlsx())
    await user.click(within(card).getByRole("button", { name: "Check the file" }))

    expect(await within(card).findByRole("alert")).toHaveTextContent("The file has no Amount column.")
    expect(within(card).getByRole("button", { name: "Import" })).toBeDisabled()
  })

  it("is not shown to someone the page is closed to", async () => {
    mount({ me: FACULTY })
    expect(await screen.findByText(/research office's job/i)).toBeInTheDocument()
    expect(screen.queryByRole("heading", { name: "Monthly files" })).not.toBeInTheDocument()
    expect(screen.queryByRole("region", { name: "Faculty list" })).not.toBeInTheDocument()
  })
})

describe("the logins for the new people", () => {
  const CREDS = [
    { staff_id: "TS101", name: "Dr New Person", email: "new@example.edu", password: "Xk7mPq3RtYw9" },
    { staff_id: "TS102", name: "=cmd|' /C calc'!A0", email: "odd@example.edu", password: "Hn4Bc8Vz2Jd5" },
  ]
  const withLogins = () => ({ ...FACULTY_CHECK, credentials: CREDS })

  async function readBlob(blob: Blob): Promise<Uint8Array> {
    // `Blob.text()` drops a byte-order mark, so read the raw bytes.
    const buf = await new Promise<ArrayBuffer>((resolve) => {
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result as ArrayBuffer)
      reader.readAsArrayBuffer(blob)
    })
    return new Uint8Array(buf)
  }

  async function checkThenImport(user: ReturnType<typeof userEvent.setup>, doImport: boolean) {
    const card = await screen.findByRole("region", { name: "Faculty list" })
    await user.upload(within(card).getByLabelText(/faculty list workbook/i), xlsx())
    await user.click(within(card).getByRole("button", { name: "Check the file" }))
    await within(card).findByText(/Nothing is saved yet/)
    if (doImport) {
      await user.click(within(card).getByRole("button", { name: "Import" }))
      await within(card).findByText(/Imported\. This is what was saved/)
    }
    return card
  }

  it("offers the download only after an import that returned logins, and never shows the passwords", async () => {
    const user = userEvent.setup()
    mount({ faculty: withLogins })
    // The check (a dry run) carries none, whatever the server sent.
    let card = await checkThenImport(user, false)
    expect(within(card).queryByRole("button", { name: "Download logins (CSV)" })).not.toBeInTheDocument()
    expect(within(card).queryByText(/Logins for the/)).not.toBeInTheDocument()

    await user.click(within(card).getByRole("button", { name: "Import" }))
    await within(card).findByText(/Imported\. This is what was saved/)
    card = screen.getByRole("region", { name: "Faculty list" })
    expect(within(card).getByRole("heading", { name: "Logins for the 2 new people" })).toBeInTheDocument()
    expect(within(card).getByText("These passwords are shown once. Save the file now.")).toBeInTheDocument()
    expect(within(card).getByRole("button", { name: "Download logins (CSV)" })).toBeInTheDocument()
    for (const c of CREDS) expect(document.body.textContent).not.toContain(c.password)
  })

  it("has no download when the import created nobody", async () => {
    const user = userEvent.setup()
    mount({ faculty: () => ({ ...FACULTY_CHECK, credentials: [] }) })
    const card = await checkThenImport(user, true)
    expect(within(card).queryByRole("button", { name: "Download logins (CSV)" })).not.toBeInTheDocument()
  })

  it("builds the file with a byte-order mark, the four columns and formulas defused", async () => {
    const created: Blob[] = []
    vi.stubGlobal("URL", { ...URL, createObjectURL: (b: Blob) => (created.push(b), "blob:x"), revokeObjectURL: () => {} })
    const anchors: HTMLAnchorElement[] = []
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      anchors.push(this)
    })
    const user = userEvent.setup()
    mount({ faculty: withLogins })
    const card = await checkThenImport(user, true)
    await user.click(within(card).getByRole("button", { name: "Download logins (CSV)" }))

    expect(created).toHaveLength(1)
    expect(anchors[0].download).toMatch(/^faculty-new-logins-\d{4}-\d{2}-\d{2}\.csv$/)
    const bytes = await readBlob(created[0])
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
    const text = new TextDecoder().decode(bytes.slice(3))
    const lines = text.trim().split("\r\n")
    expect(lines[0]).toBe("staff_id,name,email,password")
    expect(lines[1]).toBe("TS101,Dr New Person,new@example.edu,Xk7mPq3RtYw9")
    expect(lines[2]).toBe("TS102,'=cmd|' /C calc'!A0,odd@example.edu,Hn4Bc8Vz2Jd5")
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it("drops the logins when the file changes", async () => {
    const user = userEvent.setup()
    mount({ faculty: withLogins })
    const card = await checkThenImport(user, true)
    expect(within(card).getByRole("button", { name: "Download logins (CSV)" })).toBeInTheDocument()
    await user.upload(within(card).getByLabelText(/faculty list workbook/i), xlsx("two.xlsx"))
    expect(within(card).queryByRole("button", { name: "Download logins (CSV)" })).not.toBeInTheDocument()
    expect(within(card).queryByText(/Logins for the/)).not.toBeInTheDocument()
  })
})
