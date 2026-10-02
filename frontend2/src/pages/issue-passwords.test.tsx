import { screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return { ...actual, api: vi.fn() }
})

import type { Me } from "@/app/auth"
import { api } from "@/lib/api"
import { PeoplePasswords } from "@/pages/people"
import { renderWithProviders } from "@/test/harness"

const ADMIN: Me = { id: "u-a", email: "a@x.edu", name: "Admin", role: "SUPER_ADMIN", department: null }
const CELL: Me = { ...ADMIN, id: "u-c", role: "RESEARCH_CELL", name: "Cell" }

const PREVIEW = {
  count: 409,
  by_role: [
    { role: "FACULTY", count: 400 },
    { role: "HOD", count: 9 },
  ],
  by_department: [
    { department: "CSE", count: 300 },
    { department: "ECE", count: 109 },
  ],
}

type Call = { path: string; json?: { dry_run?: boolean; who?: string; role?: string } }

function mount(me: Me) {
  const calls: Call[] = []
  vi.mocked(api).mockReset()
  vi.mocked(api).mockImplementation((async (path: string, opts?: { json?: Call["json"] }) => {
    calls.push({ path, json: opts?.json })
    if (path === "/api/auth/me") return me
    if (path.startsWith("/api/meta/departments")) return ["CSE", "ECE"]
    if (path.startsWith("/api/admin/users?")) return { total: 0, limit: 20, offset: 0, results: [] }
    if (path === "/api/admin/passwords/issue") {
      if (opts?.json?.dry_run) return PREVIEW
      return "Email,Name,Role,Department,Staff ID,Password\na@x.edu,A,FACULTY,CSE,S1,abc\n"
    }
    throw new Error(`unexpected ${path}`)
  }) as never)
  renderWithProviders(<PeoplePasswords />, { route: "/people/passwords" })
  return { calls, user: userEvent.setup() }
}

afterEach(() => vi.restoreAllMocks())

describe("Issue passwords", () => {
  it("shows the count and the warning, and names the count on the button", async () => {
    mount(ADMIN)
    expect(await screen.findByRole("button", { name: "Issue 409 passwords" })).toBeEnabled()
    expect(screen.getByText(/Their current passwords stop working/)).toBeInTheDocument()
    expect(screen.getByText(/The list downloads once. Keep it safe/)).toBeInTheDocument()
    expect(screen.getByText(/400 faculty, 9 heads of department/)).toBeInTheDocument()
    expect(screen.getByLabelText(/Everyone who has never signed in/)).toBeChecked()
  })

  it("asks the server for a dry run first and changes nothing until confirmed", async () => {
    const { calls } = mount(ADMIN)
    await screen.findByRole("button", { name: "Issue 409 passwords" })
    const issue = calls.filter((c) => c.path === "/api/admin/passwords/issue")
    expect(issue.length).toBeGreaterThan(0)
    expect(issue.every((c) => c.json?.dry_run === true)).toBe(true)
    expect(issue.some((c) => c.json?.who === "no_password_yet")).toBe(true)
  })

  it("downloads the file, then says it will not be shown again", async () => {
    const created: Blob[] = []
    vi.stubGlobal("URL", { ...URL, createObjectURL: (b: Blob) => (created.push(b), "blob:x"), revokeObjectURL: () => {} })
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {})
    const { calls, user } = mount(ADMIN)
    await user.click(await screen.findByRole("button", { name: "Issue 409 passwords" }))
    expect(await screen.findByText("This list will not be shown again")).toBeInTheDocument()
    expect(click).toHaveBeenCalledTimes(1)
    expect(calls.some((c) => c.json?.dry_run === false)).toBe(true)
    expect(created).toHaveLength(1)
    // `Blob.text()` drops a byte-order mark, so read the raw bytes.
    const buf = await new Promise<ArrayBuffer>((resolve) => {
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result as ArrayBuffer)
      reader.readAsArrayBuffer(created[0])
    })
    const bytes = new Uint8Array(buf)
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
    // Nothing of the passwords stays on the page.
    expect(document.body.textContent).not.toMatch(/abc/)
    vi.unstubAllGlobals()
  })

  it("waits for a role before it can be confirmed", async () => {
    const { calls, user } = mount(ADMIN)
    await screen.findByRole("button", { name: "Issue 409 passwords" })
    await user.click(screen.getByLabelText(/^A role/))
    expect(screen.getByRole("button", { name: "Issue passwords" })).toBeDisabled()
    expect(screen.getByText(/Choose a role to see the count/)).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Role" }))
    await user.click(await screen.findByRole("option", { name: "Finance" }))
    expect(await screen.findByRole("button", { name: "Issue 409 passwords" })).toBeEnabled()
    await waitFor(() =>
      expect(calls.some((c) => c.json?.who === "role" && c.json?.role === "FINANCE" && c.json?.dry_run)).toBe(true)
    )
  })

  it("is not offered to any other office role", async () => {
    mount(CELL)
    await screen.findByText("People")
    expect(screen.queryByRole("button", { name: /Issue.*password/ })).not.toBeInTheDocument()
    expect(screen.queryByText(/have never signed in/)).not.toBeInTheDocument()
  })
})
