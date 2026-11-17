import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return { ...actual, api: vi.fn() }
})

import { api } from "@/lib/api"
import { KeyText, MyKeysSection, OwnKeyNotice, type KeyProvider } from "@/pages/my-keys"
import { renderWithProviders } from "@/test/harness"

const SECRET = "placeholder-key-0123456789-WXYZ"

function base(over: Partial<KeyProvider> & Pick<KeyProvider, "provider" | "label">): KeyProvider {
  return {
    about: `About ${over.label}`,
    works_without_key: false,
    fields: [{ name: "value", label: "API key", secret: true, required: true, help: "" }],
    policy: "own_preferred",
    has_own_key: false,
    masked: "",
    has_inst_token: false,
    values: {},
    key_label: "",
    source: "college",
    ignored: false,
    usage: { today: 0, month: 0 },
    last_used_at: null,
    last_test: null,
    problem: "",
    ...over,
  }
}

const AI = base({
  provider: "ai",
  label: "AI service",
  about: "Your own AI key: the app's AI features you use run on your account.",
  fields: [
    { name: "kind", label: "Kind of service", secret: false, required: true, help: "" },
    { name: "base_url", label: "Service address", secret: false, required: false, help: "" },
    { name: "model", label: "Model", secret: false, required: false, help: "" },
    { name: "value", label: "API key", secret: true, required: true, help: "" },
  ],
  values: { kind: "openai", base_url: "", model: "" },
})
const SCOPUS = base({
  provider: "scopus",
  label: "Scopus (Elsevier)",
  fields: [
    { name: "value", label: "API key", secret: true, required: true, help: "" },
    { name: "inst_token", label: "Institution token", secret: true, required: false, help: "" },
  ],
})
const OPENALEX = base({
  provider: "openalex",
  label: "OpenAlex",
  works_without_key: true,
  fields: [
    { name: "mailto", label: "Contact email", secret: false, required: false, help: "" },
    { name: "value", label: "API key", secret: true, required: false, help: "" },
  ],
  values: { mailto: "" },
})

type Call = { path: string; method: string; json?: unknown }
let calls: Call[]
let providers: KeyProvider[]

function serve() {
  vi.mocked(api).mockImplementation((async (path: string, options: { method?: string; json?: unknown } = {}) => {
    const method = (options.method ?? "GET").toUpperCase()
    calls.push({ path, method, json: options.json })
    if (method === "GET" && path === "/api/me/keys") return { providers, policies: [] }
    const named = path.match(/^\/api\/me\/keys\/([a-z]+)(\/test)?$/)
    if (named && method === "PUT") {
      const body = options.json as Record<string, string>
      providers = providers.map((p) =>
        p.provider === named[1]
          ? { ...p, has_own_key: true, masked: "••••WXYZ", source: "yours" as const, values: { ...p.values, ...body, value: "" } }
          : p
      )
      return providers.find((p) => p.provider === named[1])
    }
    if (named && method === "DELETE") {
      providers = providers.map((p) => (p.provider === named[1] ? { ...p, has_own_key: false, masked: "", source: "college" as const } : p))
      return providers.find((p) => p.provider === named[1])
    }
    if (named && named[2] && method === "POST") return { ok: true, latency_ms: 123, message: "The key works." }
    throw new Error(`unexpected ${method} ${path}`)
  }) as never)
}

beforeEach(() => {
  calls = []
  providers = [AI, SCOPUS, OPENALEX]
  vi.mocked(api).mockReset()
})

const row = (id: string) => within(screen.getByTestId(`key-row-${id}`))

describe("My API keys on the profile", () => {
  it("shows one row per service with a plain explanation and a status line", async () => {
    serve()
    renderWithProviders(<MyKeysSection />)
    expect(await screen.findByText("Your own AI key: the app's AI features you use run on your account.")).toBeInTheDocument()
    expect(row("ai").getByText("Using the college key")).toBeInTheDocument()
    expect(row("scopus").getByText("Using the college key")).toBeInTheDocument()
    expect(screen.getByRole("heading", { name: "My API keys" })).toBeInTheDocument()
    // Nothing to remove or test until a key is saved.
    expect(row("scopus").queryByRole("button", { name: /Remove/ })).toBeNull()
    expect(row("scopus").queryByRole("button", { name: "Test" })).toBeNull()
  })

  it("never pre-fills the key box, and Save waits for something typed", async () => {
    serve()
    renderWithProviders(<MyKeysSection />)
    await screen.findByTestId("key-row-scopus")
    const scopus = row("scopus")
    const box = scopus.getByLabelText("API key") as HTMLInputElement
    expect(box.type).toBe("password")
    expect(box.value).toBe("")
    expect(scopus.getByRole("button", { name: "Save" })).toBeDisabled()
  })

  it("saves a key, sends only what was typed, and empties the box", async () => {
    const user = userEvent.setup()
    serve()
    renderWithProviders(<MyKeysSection />)
    await screen.findByTestId("key-row-scopus")
    const scopus = row("scopus")
    await user.type(scopus.getByLabelText("API key"), SECRET)
    await user.type(scopus.getByLabelText(/Institution token/), "inst-token-0123456789")
    await user.click(scopus.getByRole("button", { name: "Save" }))
    await waitFor(() => expect(calls.find((c) => c.method === "PUT")).toBeTruthy())
    expect(calls.find((c) => c.method === "PUT")?.json).toEqual({ value: SECRET, inst_token: "inst-token-0123456789" })
    expect(await screen.findByText("Using your key")).toBeInTheDocument()
    expect((row("scopus").getByLabelText(/New API key/) as HTMLInputElement).value).toBe("")
    // The key is on screen nowhere, only its last four characters.
    expect(document.body.textContent).not.toContain(SECRET)
    expect(row("scopus").getByText(/Saved key ends WXYZ/)).toBeInTheDocument()
    expect(row("scopus").getByRole("button", { name: "Test" })).toBeInTheDocument()
  })

  it("lets an AI key choose Claude and hides the address", async () => {
    const user = userEvent.setup()
    serve()
    renderWithProviders(<MyKeysSection />)
    await screen.findByTestId("key-row-ai")
    const ai = row("ai")
    expect(ai.getByLabelText("Service address")).toBeInTheDocument()
    await user.selectOptions(ai.getByLabelText("Kind of service"), "anthropic")
    expect(ai.queryByLabelText("Service address")).toBeNull()
    await user.type(ai.getByLabelText("API key"), SECRET)
    await user.click(ai.getByRole("button", { name: "Save" }))
    await waitFor(() => expect(calls.find((c) => c.method === "PUT")?.json).toMatchObject({ kind: "anthropic", base_url: "", value: SECRET }))
  })

  it("tests a saved key and says in words whether it worked, then shows usage", async () => {
    const user = userEvent.setup()
    providers = [AI, base({ ...SCOPUS, has_own_key: true, masked: "••••WXYZ", source: "yours", usage: { today: 3, month: 1234 } }), OPENALEX]
    serve()
    renderWithProviders(<MyKeysSection />)
    await screen.findByTestId("key-row-scopus")
    const scopus = row("scopus")
    expect(scopus.getByText("Using your key")).toBeInTheDocument()
    expect(scopus.getByText(/Calls today 3\. Calls this month 1,234\./)).toBeInTheDocument()
    await user.click(scopus.getByRole("button", { name: "Test" }))
    expect(await scopus.findByText(/It worked \(123 ms\)\. The key works\./)).toBeInTheDocument()
    expect(calls.some((c) => c.method === "POST" && c.path === "/api/me/keys/scopus/test")).toBe(true)
  })

  it("removes a key only after confirming", async () => {
    const user = userEvent.setup()
    providers = [AI, base({ ...SCOPUS, has_own_key: true, masked: "••••WXYZ", source: "yours" }), OPENALEX]
    serve()
    renderWithProviders(<MyKeysSection />)
    await screen.findByTestId("key-row-scopus")
    await user.click(row("scopus").getByRole("button", { name: /Remove my Scopus/ }))
    expect(calls.some((c) => c.method === "DELETE")).toBe(false)
    const dialog = await screen.findByRole("dialog")
    await user.click(within(dialog).getByRole("button", { name: "Remove" }))
    await waitFor(() => expect(calls.some((c) => c.method === "DELETE" && c.path === "/api/me/keys/scopus")).toBe(true))
  })

  it("says plainly that a feature is not available when the college requires your own key", async () => {
    providers = [base({ ...AI, policy: "own_required", source: "none" }), SCOPUS, OPENALEX]
    serve()
    renderWithProviders(<MyKeysSection />)
    await screen.findByTestId("key-row-ai")
    expect(row("ai").getByText("Not available: add your key")).toBeInTheDocument()
    expect(screen.getByTestId("key-note-ai").textContent).toMatch(/asks everyone to bring their own key/)
  })

  it("says a saved key is not used when the college has chosen its own", async () => {
    providers = [AI, base({ ...SCOPUS, has_own_key: true, masked: "••••WXYZ", policy: "college", ignored: true, source: "college" }), OPENALEX]
    serve()
    renderWithProviders(<MyKeysSection />)
    await screen.findByTestId("key-row-scopus")
    expect(screen.getByTestId("key-note-scopus").textContent).toMatch(/kept but not used/)
  })

  it("shows a server refusal in the row", async () => {
    const user = userEvent.setup()
    vi.mocked(api).mockImplementation((async (_path: string, options: { method?: string } = {}) => {
      if ((options.method ?? "GET") === "GET") return { providers, policies: [] }
      throw new Error("That is too short to be a key.")
    }) as never)
    renderWithProviders(<MyKeysSection />)
    await screen.findByTestId("key-row-scopus")
    await user.type(row("scopus").getByLabelText("API key"), "short")
    await user.click(row("scopus").getByRole("button", { name: "Save" }))
    expect(await screen.findByRole("alert")).toHaveTextContent("That is too short to be a key.")
  })
})

describe("the link to My API keys", () => {
  it("OwnKeyNotice is one plain sentence with a link", () => {
    renderWithProviders(<OwnKeyNotice what="AI" />)
    expect(screen.getByTestId("own-key-notice").textContent).toBe(
      "Your college asks everyone to use their own AI key. Add yours in your Profile, under My API keys."
    )
    expect(screen.getByRole("link", { name: /Add yours in your Profile, under My API keys/ })).toHaveAttribute("href", "/profile#my-api-keys")
  })

  it("KeyText turns the pointer in a server sentence into a link", () => {
    renderWithProviders(
      <p>
        <KeyText text="Your college asks everyone to use their own Scopus key. Add yours in your Profile, under My API keys." />
      </p>
    )
    expect(screen.getByRole("link", { name: "Profile, under My API keys" })).toHaveAttribute("href", "/profile#my-api-keys")
  })

  it("KeyText leaves a sentence with nothing to point at alone", () => {
    renderWithProviders(
      <p data-testid="plain">
        <KeyText text="Nothing to point at." />
      </p>
    )
    expect(screen.getByTestId("plain").textContent).toBe("Nothing to point at.")
  })
})
