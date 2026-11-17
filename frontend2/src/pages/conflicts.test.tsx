import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return { ...actual, api: vi.fn() }
})
vi.mock("@/ui/toast", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/ui/toast")>()
  return { ...actual, toast: { ...actual.toast, ok: vi.fn(), fail: vi.fn() } }
})

import type { Me } from "@/app/auth"
import { ApiError, api } from "@/lib/api"
import { Conflicts } from "@/pages/conflicts"
import { changeText, matches, primaryOf, type ConflictList, type ConflictRow } from "@/pages/conflicts-model"
import { renderWithProviders } from "@/test/harness"
import { toast } from "@/ui/toast"

/**
 * The Data conflicts screen, with a made-up server. What is pinned: the numbers
 * and rows the office sees, the one primary button each row leads with, a
 * dialog that names the exact change before it is made, the note a ledger
 * update cannot do without, and the filters.
 */

const CELL: Me = { id: "u-cell", email: "cell@example.edu", name: "Office", role: "RESEARCH_CELL", department: null }

const base = {
  source_file: "Faculty_List.xlsx",
  detected_at: "2026-11-10T09:00:00Z",
  title: null,
  month: null,
  ledger_amount: null,
  file_amount: null,
  resolution: "",
  resolution_note: "",
  resolved_by: null,
  resolved_at: null,
  paused: false,
  account_active: true,
  actions: ["use_list", "keep_app", "pause_account"],
  locked: null,
} as const

const EMAIL: ConflictRow = {
  ...base,
  id: "c-email",
  kind: "faculty",
  status: "open",
  staff_id: "TS002",
  name: "Asha Rao",
  user_id: "u-asha",
  field: "email",
  field_label: "Email",
  current: "old.asha@example.edu",
  incoming: "asha@example.edu",
  actions: ["use_list", "keep_app", "pause_account"],
}
const SCOPUS: ConflictRow = {
  ...EMAIL,
  id: "c-scopus",
  staff_id: "TS003",
  name: "Ravi Kumar",
  user_id: "u-ravi",
  field: "scopus_author_id",
  field_label: "Scopus author ID",
  current: "57999999999",
  incoming: "57000000002",
}
const AMOUNT: ConflictRow = {
  ...base,
  id: "c-amount",
  kind: "amount",
  status: "open",
  source_file: "Settled.xlsx",
  staff_id: "TS001",
  name: "Meera Pillai",
  user_id: "u-meera",
  field: null,
  field_label: null,
  current: null,
  incoming: null,
  title: "Power converters for light vehicles",
  month: "2026-08-01",
  ledger_amount: 600,
  file_amount: 999,
  actions: ["update_ledger", "keep_ledger"],
}
const LOCKED: ConflictRow = { ...EMAIL, id: "c-locked", staff_id: "TS900", name: "The Principal", actions: [], locked: "Only a super admin can change this account." }
const PAUSED: ConflictRow = { ...SCOPUS, id: "c-paused", staff_id: "TS004", name: "Paused Person", paused: true, account_active: false, actions: ["use_list", "keep_app", "reactivate"] }
const SETTLED: ConflictRow = {
  ...EMAIL,
  id: "c-done",
  status: "resolved",
  staff_id: "TS005",
  name: "Settled Person",
  resolution: "use_list",
  resolved_by: "Office",
  resolved_at: "2026-11-12T10:00:00Z",
  actions: [],
}

const COUNTS = { open: 3, open_faculty: 2, open_amount: 1, resolved_week: 4 }

function list(rows: ConflictRow[], extra: Partial<ConflictList> = {}): ConflictList {
  return { counts: COUNTS, total: rows.length, truncated: false, may_resolve: true, rows, ...extra }
}

type Posted = { path: string; json: { action: string; note: string } }

/** A server that answers the list for whatever filter is asked, and records each resolve. */
function server(rows: ConflictRow[], opts: { extra?: Partial<ConflictList>; refuse?: ApiError } = {}) {
  const posted: Posted[] = []
  const listed: string[] = []
  vi.mocked(api).mockImplementation(((path: string, init?: { method?: string; json?: unknown }) => {
    if (path === "/api/auth/me") return Promise.resolve(CELL)
    if (init?.method === "POST") {
      posted.push({ path, json: init.json as Posted["json"] })
      return opts.refuse ? Promise.reject(opts.refuse) : Promise.resolve({ ok: true, changed: true, id: "x", status: "resolved", message: "Done." })
    }
    if (path.startsWith("/api/admin/conflicts")) {
      listed.push(path)
      return Promise.resolve(list(rows, opts.extra))
    }
    return Promise.reject(new ApiError(404, `No handler for ${path}`))
  }) as typeof api)
  return { posted, listed }
}

function mount(route = "/admin/conflicts") {
  renderWithProviders(<Conflicts />, { route })
  return userEvent.setup()
}

beforeEach(() => {
  vi.mocked(api).mockReset()
  vi.mocked(toast.ok).mockReset()
})

describe("the list", () => {
  it("says what the page is for, counts the three things, and lists each difference", async () => {
    server([EMAIL, SCOPUS, AMOUNT])
    mount()
    expect(await screen.findByText("Differences between the college's files and the app. Nothing changes until you choose.")).toBeInTheDocument()
    const glance = await screen.findByRole("group", { name: "At a glance" })
    await waitFor(() => expect(glance).toHaveTextContent("2 Open faculty differences"))
    expect(glance).toHaveTextContent("1 Open amounts")
    expect(glance).toHaveTextContent("4 Resolved this week")
    const table = await screen.findByRole("table")
    expect(within(table).getByText("Asha Rao")).toBeInTheDocument()
    expect(within(table).getByText("old.asha@example.edu")).toBeInTheDocument()
    expect(within(table).getByText("asha@example.edu")).toBeInTheDocument()
    expect(within(table).getByText("Power converters for light vehicles")).toBeInTheDocument()
    expect(within(table).getByText("₹600")).toBeInTheDocument()
    expect(within(table).getByText("₹999")).toBeInTheDocument()
  })

  it("leads each row with one primary button, and keeps the others in a menu", async () => {
    server([EMAIL, AMOUNT])
    const user = mount()
    expect(await screen.findByRole("button", { name: /^Use the file's value for Asha Rao/ })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /^Update ledger for Meera Pillai/ })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /^Keep the app's value/ })).not.toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: /More choices for Asha Rao/ }))
    expect(await screen.findByRole("menuitem", { name: "Keep the app's value" })).toBeInTheDocument()
    expect(screen.getByRole("menuitem", { name: "Pause the account" })).toBeInTheDocument()
  })

  it("is plain when nothing differs, and says where the differences come from", async () => {
    server([])
    mount()
    expect(await screen.findByText("No conflicts to settle")).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "Open the imports" })).toHaveAttribute("href", "/imports")
  })

  it("shows an account only a super admin may touch as locked, with no buttons", async () => {
    server([LOCKED])
    mount()
    const cell = await screen.findByText("Super admin only")
    expect(cell).toHaveAttribute("title", "Only a super admin can change this account.")
    expect(screen.queryByRole("button", { name: /Use the file's value/ })).not.toBeInTheDocument()
  })

  it("is read only for somebody who may look but not settle", async () => {
    server([EMAIL], { extra: { may_resolve: false } })
    mount()
    expect(await screen.findByText(/^Read only\. /)).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /Use the file's value/ })).not.toBeInTheDocument()
  })

  it("offers to reactivate a paused account, and says who settled a finished one", async () => {
    server([PAUSED, SETTLED], { extra: {} })
    const user = mount("/admin/conflicts?status=all")
    expect(await screen.findByText("Account paused")).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: /More choices for Paused Person/ }))
    expect(await screen.findByRole("menuitem", { name: "Reactivate the account" })).toBeInTheDocument()
    expect(screen.queryByRole("menuitem", { name: "Pause the account" })).not.toBeInTheDocument()
    expect(screen.getByText(/Used the file's value by Office, 12 Nov 2026/)).toBeInTheDocument()
  })
})

describe("settling one", () => {
  it("names the exact change in a dialog, and writes nothing until it is confirmed", async () => {
    const s = server([EMAIL])
    const user = mount()
    await user.click(await screen.findByRole("button", { name: /^Use the file's value for Asha Rao/ }))
    const dialog = await screen.findByRole("dialog")
    expect(dialog).toHaveTextContent("Use the file's value?")
    expect(dialog).toHaveTextContent("Change Asha Rao's email from old.asha@example.edu to asha@example.edu.")
    expect(s.posted).toHaveLength(0)

    await user.click(within(dialog).getByRole("button", { name: "Cancel" }))
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
    expect(s.posted).toHaveLength(0)

    await user.click(screen.getByRole("button", { name: /^Use the file's value for Asha Rao/ }))
    const again = await screen.findByRole("dialog")
    await user.type(within(again).getByLabelText(/Note/), "Confirmed on the phone")
    await user.click(within(again).getByRole("button", { name: "Use the file's value" }))
    await waitFor(() => expect(s.posted).toHaveLength(1))
    expect(s.posted[0]).toEqual({ path: "/api/admin/conflicts/c-email/resolve", json: { action: "use_list", note: "Confirmed on the phone" } })
    await waitFor(() => expect(toast.ok).toHaveBeenCalledWith("Done."))
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
  })

  it("warns that a new Scopus ID means syncing again", async () => {
    server([SCOPUS])
    const user = mount()
    await user.click(await screen.findByRole("button", { name: /^Use the file's value for Ravi Kumar/ }))
    expect(await screen.findByRole("dialog")).toHaveTextContent("Their papers will need syncing from Scopus again.")
  })

  it("will not update the ledger without a note", async () => {
    const s = server([AMOUNT])
    const user = mount()
    await user.click(await screen.findByRole("button", { name: /^Update ledger for Meera Pillai/ }))
    const dialog = await screen.findByRole("dialog")
    expect(dialog).toHaveTextContent("from ₹600 to ₹999")
    expect(dialog).toHaveTextContent("The old amount is kept in the row's history.")
    const confirm = within(dialog).getByRole("button", { name: "Update ledger" })
    expect(confirm).toBeDisabled()
    const note = within(dialog).getByLabelText("Note")
    await user.type(note, "   ")
    expect(confirm).toBeDisabled()
    await user.type(note, "Accounts sent the corrected sheet")
    expect(confirm).toBeEnabled()
    await user.click(confirm)
    await waitFor(() => expect(s.posted).toHaveLength(1))
    expect(s.posted[0].json).toEqual({ action: "update_ledger", note: "Accounts sent the corrected sheet" })
  })

  it("asks for no note on a keep, and names that nothing changes", async () => {
    const s = server([AMOUNT])
    const user = mount()
    await user.click(await screen.findByRole("button", { name: /More choices for Meera Pillai/ }))
    await user.click(await screen.findByRole("menuitem", { name: "Keep the ledger amount" }))
    const dialog = await screen.findByRole("dialog")
    expect(dialog).toHaveTextContent("Nothing is changed.")
    const confirm = within(dialog).getByRole("button", { name: "Keep the ledger amount" })
    expect(confirm).toBeEnabled()
    await user.click(confirm)
    await waitFor(() => expect(s.posted[0]?.json).toEqual({ action: "keep_ledger", note: "" }))
  })

  it("says what pausing does, and that it can be undone", async () => {
    const s = server([EMAIL])
    const user = mount()
    await user.click(await screen.findByRole("button", { name: /More choices for Asha Rao/ }))
    await user.click(await screen.findByRole("menuitem", { name: "Pause the account" }))
    const dialog = await screen.findByRole("dialog")
    expect(dialog).toHaveTextContent("Pause this account?")
    expect(dialog).toHaveTextContent("Asha Rao cannot sign in until you reactivate the account.")
    await user.click(within(dialog).getByRole("button", { name: "Pause the account" }))
    await waitFor(() => expect(s.posted[0]?.json.action).toBe("pause_account"))
  })

  it("keeps the dialog open and says why when the server refuses", async () => {
    const s = server([EMAIL], { refuse: new ApiError(409, "The email in the app is now x@y.edu. Check the file again, then decide.") })
    const user = mount()
    await user.click(await screen.findByRole("button", { name: /^Use the file's value for Asha Rao/ }))
    const dialog = await screen.findByRole("dialog")
    await user.click(within(dialog).getByRole("button", { name: "Use the file's value" }))
    expect(await within(dialog).findByText(/The email in the app is now x@y\.edu/)).toBeInTheDocument()
    expect(screen.getByRole("dialog")).toBeInTheDocument()
    expect(s.posted).toHaveLength(1)
    expect(toast.ok).not.toHaveBeenCalled()
  })
})

describe("the filters", () => {
  it("asks the server for the kind and the status that were chosen", async () => {
    const s = server([EMAIL, AMOUNT])
    const user = mount()
    await screen.findByRole("table")
    expect(s.listed.at(-1)).toBe("/api/admin/conflicts?status=open")
    await user.selectOptions(screen.getByRole("combobox", { name: "Kind" }), "amount")
    await waitFor(() => expect(s.listed.at(-1)).toBe("/api/admin/conflicts?status=open&kind=amount"))
    await user.selectOptions(screen.getByRole("combobox", { name: "Status" }), "resolved")
    await waitFor(() => expect(s.listed.at(-1)).toBe("/api/admin/conflicts?status=resolved&kind=amount"))
  })

  it("searches the names, Staff IDs and values already on the page", async () => {
    server([EMAIL, SCOPUS, AMOUNT])
    const user = mount()
    await screen.findByRole("table")
    await user.type(screen.getByRole("searchbox", { name: "Search conflicts" }), "ravi")
    const table = screen.getByRole("table")
    expect(within(table).getByText("Ravi Kumar")).toBeInTheDocument()
    expect(within(table).queryByText("Asha Rao")).not.toBeInTheDocument()
    expect(within(table).queryByText("Meera Pillai")).not.toBeInTheDocument()
    await user.clear(screen.getByRole("searchbox", { name: "Search conflicts" }))
    await user.type(screen.getByRole("searchbox", { name: "Search conflicts" }), "zzz")
    expect(await screen.findByText("No conflict matches")).toBeInTheDocument()
    await user.click(screen.getAllByRole("button", { name: "Clear filters" })[0])
    expect(await screen.findByText("Asha Rao")).toBeInTheDocument()
  })

  it("reads the filters from the address", async () => {
    const s = server([AMOUNT])
    mount("/admin/conflicts?status=resolved&kind=amount")
    await screen.findByRole("table")
    expect(s.listed.at(-1)).toBe("/api/admin/conflicts?status=resolved&kind=amount")
    expect(screen.getByRole("combobox", { name: "Status" })).toHaveValue("resolved")
  })
})

describe("the words", () => {
  it("names each change plainly", () => {
    expect(changeText(EMAIL, "keep_app")).toBe("Keep old.asha@example.edu as Asha Rao's email. The file's asha@example.edu is ignored. Nothing is changed.")
    expect(changeText({ ...SCOPUS, field: "staff_id", current: "A1", incoming: "A2" }, "use_list")).toContain("stay under the old Staff ID")
    expect(changeText(PAUSED, "reactivate")).toBe("Paused Person can sign in again.")
  })

  it("leads with use the file's value, then update ledger, then reactivate", () => {
    expect(primaryOf(EMAIL)).toBe("use_list")
    expect(primaryOf(AMOUNT)).toBe("update_ledger")
    expect(primaryOf({ ...PAUSED, actions: ["reactivate"] })).toBe("reactivate")
    expect(primaryOf(LOCKED)).toBeNull()
  })

  it("matches a search on the person, the Staff ID or either value", () => {
    expect(matches(EMAIL, "ts002")).toBe(true)
    expect(matches(EMAIL, "OLD.ASHA")).toBe(true)
    expect(matches(AMOUNT, "999")).toBe(true)
    expect(matches(AMOUNT, "nobody")).toBe(false)
    expect(matches(AMOUNT, "  ")).toBe(true)
  })
})

describe("a paper paid more than once", () => {
  const TWICE: ConflictRow = {
    ...AMOUNT,
    id: "c-twice",
    kind: "double_payment",
    name: "Dev Anand",
    staff_id: "TS010",
    user_id: "u-dev",
    title: "Solar cells for rural roofs",
    month: null,
    ledger_amount: null,
    file_amount: null,
    payments: [
      { month: "2026-08-01", amount: 500 },
      { month: "2026-09-01", amount: 500 },
    ],
    total: 1000,
    actions: ["confirmed", "mark_error"],
  }

  it("shows each payment and the total, and leads with the confirmation", async () => {
    server([TWICE], { extra: { counts: { ...COUNTS, open: 1, open_double_payment: 1 } } })
    const user = mount()
    const table = await screen.findByRole("table")
    expect(within(table).getByText("Solar cells for rural roofs paid more than once")).toBeInTheDocument()
    expect(within(table).getByText("2 payments, ₹1,000")).toBeInTheDocument()
    expect(within(table).getByText("Aug 2026 ₹500, Sep 2026 ₹500")).toBeInTheDocument()
    expect(screen.getByRole("group", { name: "At a glance" })).toHaveTextContent("1 Papers paid more than once")
    expect(primaryOf(TWICE)).toBe("confirmed")
    await user.click(screen.getByRole("button", { name: /More choices for Dev Anand/ }))
    expect(await screen.findByRole("menuitem", { name: "Mark as an error to recover" })).toBeInTheDocument()
  })

  it("records the decision with its note, and an error needs one", async () => {
    const s = server([TWICE])
    const user = mount()
    await user.click(await screen.findByRole("button", { name: /^Confirmed: both payments were right for Dev Anand/ }))
    expect(await screen.findByText(/No amount is changed/)).toBeInTheDocument()
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Confirmed: both payments were right" }))
    await waitFor(() => expect(s.posted).toHaveLength(1))
    expect(s.posted[0]).toEqual({ path: "/api/admin/conflicts/c-twice/resolve", json: { action: "confirmed", note: "" } })

    await user.click(screen.getByRole("button", { name: /More choices for Dev Anand/ }))
    await user.click(await screen.findByRole("menuitem", { name: "Mark as an error to recover" }))
    const dialog = await screen.findByRole("dialog")
    const go = within(dialog).getByRole("button", { name: "Mark as an error to recover" })
    expect(go).toBeDisabled()
    await user.type(within(dialog).getByRole("textbox"), "Paid twice by mistake")
    expect(go).toBeEnabled()
  })
})
