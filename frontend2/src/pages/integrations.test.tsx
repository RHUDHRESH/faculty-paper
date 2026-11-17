import { screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return { ...actual, api: vi.fn() }
})

import type { Me } from "@/app/auth"
import { hubSections, pagesFor } from "@/app/nav"
import { api } from "@/lib/api"
import { Integrations } from "@/pages/integrations"
import { FACULTY, FINANCE, failing, fakeApi, renderWithProviders } from "@/test/harness"

const ADMIN: Me = { id: "u-a", email: "a@x.edu", name: "Admin", role: "SUPER_ADMIN", department: null }

const field = (name: string, label: string, extra: object = {}) => ({
  name,
  label,
  help: "",
  secret: true,
  configured: false,
  source: "none",
  masked: "",
  value: "",
  ...extra,
})
const provider = (id: string, label: string, fields: object[], extra: object = {}) => ({
  provider: id,
  label,
  about: `About ${label}`,
  configured: false,
  source: "none",
  masked: "",
  last_tested_at: null,
  last_test_ok: null,
  last_test_message: "",
  usage: { today: 0, month: 0 },
  rate_limit: null,
  fields,
  ...extra,
})

const LISTING = {
  providers: [
    provider("scopus", "Scopus (Elsevier)", [
      field("scopus.api_key", "API key", { configured: true, source: "environment", masked: "••••ab12" }),
    ], {
      configured: true,
      source: "environment",
      masked: "••••ab12",
      usage: { today: 4, month: 1234 },
      rate_limit: { remaining: 17, limit: 20000, reset: null },
    }),
    provider("anthropic", "Claude (Anthropic)", [
      field("anthropic.api_key", "API key", { configured: true, source: "app", masked: "••••wxyz" }),
    ], { configured: true, source: "app", masked: "••••wxyz" }),
    provider("openalex", "OpenAlex", [
      field("openalex.mailto", "Contact email", { secret: false, configured: true, source: "app", value: "lab@example.test" }),
    ]),
  ],
}

const calls = (method: string, prefix: string) =>
  vi
    .mocked(api)
    .mock.calls.filter(([p, o]) => String(p).startsWith(prefix) && ((o as RequestInit | undefined)?.method ?? "GET") === method)

beforeEach(() => {
  vi.mocked(api).mockClear()
})

function serve(extra: Record<string, () => unknown> = {}) {
  vi.mocked(api).mockImplementation(
    fakeApi({ "/api/auth/me": () => ADMIN, "/api/admin/integrations": () => LISTING, ...extra })
  )
}

describe("Integrations", () => {
  it("says where each key comes from and shows only its last four characters", async () => {
    serve()
    renderWithProviders(<Integrations />)
    expect(await screen.findByText(/Configured from environment/)).toBeTruthy()
    expect(screen.getAllByText(/Configured from app/).length).toBe(2)
    expect(screen.getByText(/ends ••••ab12/)).toBeTruthy()
    expect(screen.getByText(/Calls today 4\. Calls this month 1,234\./)).toBeTruthy()
    expect(screen.getByText(/17 of 20,000 calls left/)).toBeTruthy()
  })

  it("never pre-fills a key, and a plain setting is shown", async () => {
    serve()
    renderWithProviders(<Integrations />)
    await screen.findByText(/Configured from environment/)
    const boxes = screen.getAllByLabelText(/New api key/i) as HTMLInputElement[]
    expect(boxes.length).toBe(2)
    for (const box of boxes) {
      expect(box.type).toBe("password")
      expect(box.value).toBe("")
    }
    expect((screen.getByLabelText("Contact email") as HTMLInputElement).value).toBe("lab@example.test")
  })

  it("saves a new key, empties the box, and does not echo the value", async () => {
    serve({ "/api/admin/integrations/scopus.api_key": () => LISTING.providers[0] })
    renderWithProviders(<Integrations />)
    await screen.findByText(/Configured from environment/)
    const scopus = within(screen.getByRole("region", { name: "Scopus (Elsevier)" }))
    const box = scopus.getByLabelText(/New api key/i) as HTMLInputElement
    const save = scopus.getByRole("button", { name: "Save" })
    expect((save as HTMLButtonElement).disabled).toBe(true)
    await userEvent.type(box, "sk-placeholder-0000-1111")
    await userEvent.click(save)
    const puts = calls("PUT", "/api/admin/integrations/scopus.api_key")
    expect(puts).toHaveLength(1)
    expect((puts[0][1] as { json: unknown }).json).toEqual({ value: "sk-placeholder-0000-1111" })
    await vi.waitFor(() => expect(box.value).toBe(""))
    expect(document.body.textContent).not.toContain("sk-placeholder-0000-1111")
  })

  it("clears a value saved in the app, and offers no Clear for one from the environment", async () => {
    serve({ "/api/admin/integrations/anthropic.api_key": () => LISTING.providers[1] })
    renderWithProviders(<Integrations />)
    await screen.findByText(/Configured from environment/)
    expect(within(screen.getByRole("region", { name: "Scopus (Elsevier)" })).queryByRole("button", { name: "Clear" })).toBeNull()
    await userEvent.click(within(screen.getByRole("region", { name: "Claude (Anthropic)" })).getByRole("button", { name: "Clear" }))
    const puts = calls("PUT", "/api/admin/integrations/anthropic.api_key")
    expect(puts).toHaveLength(1)
    expect((puts[0][1] as { json: unknown }).json).toEqual({ value: "" })
  })

  it("runs a test and says in words whether it worked", async () => {
    serve({
      "/api/admin/integrations/scopus/test": () => ({ ok: true, latency_ms: 212, message: "The key works.", provider: LISTING.providers[0] }),
      "/api/admin/integrations/anthropic/test": () => ({ ok: false, latency_ms: 80, message: "Anthropic refused the key (401).", provider: LISTING.providers[1] }),
    })
    renderWithProviders(<Integrations />)
    await screen.findByText(/Configured from environment/)
    await userEvent.click(within(screen.getByRole("region", { name: "Scopus (Elsevier)" })).getByRole("button", { name: "Test connection" }))
    expect(await screen.findByText(/It worked \(212 ms\)\. The key works\./)).toBeTruthy()
    await userEvent.click(within(screen.getByRole("region", { name: "Claude (Anthropic)" })).getByRole("button", { name: "Test connection" }))
    expect(await screen.findByText(/It did not work \(80 ms\)\. Anthropic refused the key \(401\)\./)).toBeTruthy()
    expect(calls("POST", "/api/admin/integrations/scopus/test")).toHaveLength(1)
  })

  it("shows the calm not-open gate and sends nothing for anybody but a super admin", async () => {
    for (const who of [FINANCE, FACULTY]) {
      vi.mocked(api).mockImplementation(fakeApi({ "/api/auth/me": () => who, "/api/admin/integrations": () => LISTING }))
      const { unmount } = renderWithProviders(<Integrations />)
      expect(await screen.findByRole("heading", { name: "Not open to this account" })).toBeInTheDocument()
      expect(vi.mocked(api).mock.calls.some(([p]) => String(p).startsWith("/api/admin/integrations"))).toBe(false)
      unmount()
    }
  })

  it("shows the gate, not a server error, when the API says 403", async () => {
    vi.mocked(api).mockImplementation(fakeApi({ "/api/auth/me": () => ADMIN, "/api/admin/integrations": failing(403, "Forbidden") }))
    renderWithProviders(<Integrations />)
    expect(await screen.findByRole("heading", { name: "Not open to this account" })).toBeInTheDocument()
  })

  it("is under System on the admin hub for the super admin, and offered to nobody else", () => {
    const system = hubSections("admin", "SUPER_ADMIN").find((s) => s.title === "System")
    expect(system?.items.map((i) => i.to)).toContain("/admin/integrations")
    expect(pagesFor("SUPER_ADMIN").map((i) => i.to)).toContain("/admin/integrations")
    for (const role of ["RESEARCH_CELL", "PRINCIPAL", "FINANCE", "FACULTY"] as const) {
      expect(pagesFor(role).map((i) => i.to), role).not.toContain("/admin/integrations")
    }
  })
})
