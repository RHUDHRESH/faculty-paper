import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return { ...actual, api: vi.fn() }
})

import { api } from "@/lib/api"
import { AdminApiTokens, ApiAccessSection, type ApiTokenRow } from "@/pages/api-access"
import { renderWithProviders } from "@/test/harness"

const SECRET = "sec_" + "a1B2c3D4".repeat(5)

function token(over: Partial<ApiTokenRow> = {}): ApiTokenRow {
  return {
    id: "t1",
    name: "Excel on my laptop",
    prefix: "sec_a1B2",
    scopes: ["read:papers", "read:claims"],
    status: "active",
    created_at: "2026-11-01T10:00:00Z",
    last_used_at: null,
    use_count: 0,
    expires_at: "2027-11-01T10:00:00Z",
    revoked_at: null,
    ...over,
  }
}

const OPTIONS = [
  { scope: "read:papers", label: "Papers: the publication record" },
  { scope: "read:claims", label: "Claims: incentive claims you may see" },
]

type Call = { path: string; method: string; json?: unknown }
type Options = { method?: string; json?: unknown }
let calls: Call[]
let tokens: ApiTokenRow[]

function serve(extra: Record<string, unknown> = {}) {
  vi.mocked(api).mockImplementation((async (path: string, options: Options = {}) => {
    const method = (options.method ?? "GET").toUpperCase()
    calls.push({ path, method, json: options.json })
    if (method === "GET" && path === "/api/me/api-tokens") {
      return {
        enabled: true,
        scope_options: OPTIONS,
        default_days: 365,
        max_days: 730,
        rate_limit_per_minute: 60,
        tokens,
        ...extra,
      }
    }
    if (method === "POST" && path === "/api/me/api-tokens") {
      const made = token({ id: "t2", name: (options.json as { name: string }).name })
      tokens = [made, ...tokens]
      return { token: made, secret: SECRET }
    }
    if (method === "DELETE" && path.startsWith("/api/me/api-tokens/")) {
      tokens = tokens.map((t) => (t.id === path.split("/").pop() ? { ...t, status: "revoked" as const } : t))
      return { ok: true }
    }
    throw new Error(`unexpected ${method} ${path}`)
  }) as never)
}

beforeEach(() => {
  calls = []
  tokens = [token()]
  vi.mocked(api).mockReset()
})

describe("API access on the profile", () => {
  it("lists a token with its prefix, scopes, uses and never-used state", async () => {
    serve()
    renderWithProviders(<ApiAccessSection />)
    expect(await screen.findByText("Excel on my laptop")).toBeInTheDocument()
    expect(screen.getByText("sec_a1B2…")).toBeInTheDocument()
    expect(screen.getByText("papers")).toBeInTheDocument()
    expect(screen.getByText("claims")).toBeInTheDocument()
    expect(screen.getByText("Never used")).toBeInTheDocument()
    expect(screen.getByText("0 uses")).toBeInTheDocument()
    expect(screen.getByRole("link", { name: /how to use a token/i })).toHaveAttribute("href", "/api-docs")
  })

  it("creates a token, shows the secret once with a copy button, and forgets it on Done", async () => {
    const user = userEvent.setup()
    const writeText = vi.spyOn(navigator.clipboard, "writeText")
    serve()
    renderWithProviders(<ApiAccessSection />)
    await user.click(await screen.findByRole("button", { name: "Create token" }))

    const dialog = await screen.findByRole("dialog")
    const submit = within(dialog).getByRole("button", { name: "Create token" })
    expect(submit).toBeDisabled()
    await user.type(within(dialog).getByLabelText("Name"), "Power BI")
    // Only what the role can read is offered.
    expect(within(dialog).getAllByRole("checkbox")).toHaveLength(2)
    await user.click(within(dialog).getByRole("checkbox", { name: /Papers/ }))
    expect(submit).toBeEnabled()
    await user.click(submit)

    const shown = await screen.findByLabelText("Token")
    expect(shown).toHaveValue(SECRET)
    expect(screen.getByText("Copy it now; it will not be shown again.")).toBeInTheDocument()
    expect(calls.find((c) => c.method === "POST")?.json).toEqual({
      name: "Power BI",
      scopes: ["read:papers"],
      expires_in_days: 365,
    })

    await user.click(screen.getByRole("button", { name: "Copy token" }))
    expect(writeText).toHaveBeenCalledWith(SECRET)
    expect(await screen.findByRole("button", { name: "Copied" })).toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "Done" }))
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
    // The list is refreshed and holds no secret.
    expect(await screen.findByText("Power BI")).toBeInTheDocument()
    expect(document.body.textContent).not.toContain(SECRET)
  })

  it("asks before revoking, then revokes", async () => {
    const user = userEvent.setup()
    serve()
    renderWithProviders(<ApiAccessSection />)
    await user.click(await screen.findByRole("button", { name: "Revoke Excel on my laptop" }))
    const dialog = await screen.findByRole("dialog")
    expect(within(dialog).getByText("Revoke this token?")).toBeInTheDocument()
    expect(calls.some((c) => c.method === "DELETE")).toBe(false)
    await user.click(within(dialog).getByRole("button", { name: "Revoke" }))
    await waitFor(() =>
      expect(calls.some((c) => c.method === "DELETE" && c.path === "/api/me/api-tokens/t1")).toBe(true)
    )
    expect(await screen.findByText("Revoked")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Revoke Excel on my laptop" })).not.toBeInTheDocument()
  })

  it("says so, and offers no Create token, when the role is switched off", async () => {
    serve({ enabled: false, tokens: [] })
    renderWithProviders(<ApiAccessSection />)
    expect(await screen.findByText("API access is switched off for your role")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Create token" })).not.toBeInTheDocument()
  })
})

describe("API access for the super admin", () => {
  it("lists everybody's tokens, revokes one and switches a role off", async () => {
    const user = userEvent.setup()
    const owner = { id: "u1", name: "Dr Asha Menon", email: "a@x.edu", role: "FACULTY", department: "CSE" }
    let access: Record<string, boolean> = { FACULTY: true, HOD: true }
    vi.mocked(api).mockImplementation((async (path: string, options: Options = {}) => {
      const method = (options.method ?? "GET").toUpperCase()
      calls.push({ path, method, json: options.json })
      if (path === "/api/admin/api-tokens" && method === "GET") return { access, tokens: [{ ...token(), owner }] }
      if (path === "/api/admin/api-access") {
        const body = options.json as { role: string; enabled: boolean }
        access = { ...access, [body.role]: body.enabled }
        return { access }
      }
      if (method === "DELETE") return { ok: true }
      throw new Error(`unexpected ${method} ${path}`)
    }) as never)
    renderWithProviders(<AdminApiTokens />)

    expect(await screen.findByText("Dr Asha Menon")).toBeInTheDocument()
    expect(screen.getByText("sec_a1B2…")).toBeInTheDocument()

    await user.click(screen.getByRole("switch", { name: "Faculty" }))
    await waitFor(() =>
      expect(calls.find((c) => c.path === "/api/admin/api-access")?.json).toEqual({
        role: "FACULTY",
        enabled: false,
      })
    )

    await user.click(screen.getByRole("button", { name: "Revoke Excel on my laptop for Dr Asha Menon" }))
    const dialog = await screen.findByRole("dialog")
    await user.click(within(dialog).getByRole("button", { name: "Revoke" }))
    await waitFor(() =>
      expect(calls.some((c) => c.method === "DELETE" && c.path === "/api/admin/api-tokens/t1")).toBe(true)
    )
  })
})
