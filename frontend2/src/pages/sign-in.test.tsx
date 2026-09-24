import { screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return { ...actual, api: vi.fn() }
})

vi.mock("@/app/google", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/app/google")>()
  return { ...actual, loadGoogleIdentity: vi.fn() }
})

import { loadGoogleIdentity, type GoogleIdentity } from "@/app/google"
import { ApiError, api } from "@/lib/api"
import { SignIn } from "@/pages/sign-in"
import { renderWithProviders } from "@/test/harness"

/**
 * "Continue with Google" on the way in. A Google account linked from the
 * profile may be a personal Gmail, so nothing here may narrow Google's
 * account chooser to the college domain — the server decides.
 */

/**
 * The page asks `fetch` (not `api`) whether each provider is on. Answered
 * with a plain `{ ok, json }` rather than a real `Response`: the page makes
 * two of these in sequence before Google's button can appear, and reading a
 * real body through its stream twice was slow enough, on a loaded machine,
 * to run past `findByRole`'s one-second wait.
 */
function stubConfigs(google: { enabled: boolean; client_id: string | null }) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const body = url.includes("/google/")
        ? { ...google, hosted_domain: "example.edu" }
        : { enabled: false, publishable_key: null }
      return { ok: true, json: async () => body }
    })
  )
}

/** Google's button is the far end of two config requests and a script load. */
const GOOGLE_BUTTON_WAIT = { timeout: 4000 }

function fakeGoogle() {
  let callback: ((response: { credential: string }) => void) | undefined
  const google: GoogleIdentity = {
    accounts: {
      id: {
        initialize: vi.fn((options) => {
          callback = options.callback
        }),
        renderButton: vi.fn((parent: HTMLElement) => {
          const button = document.createElement("button")
          button.type = "button"
          button.textContent = "Continue with Google"
          button.onclick = () => callback?.({ credential: "id-token-from-google" })
          parent.appendChild(button)
        }),
      },
    },
  }
  vi.mocked(loadGoogleIdentity).mockResolvedValue(google)
  return google
}

function mount(onGoogle: (path: string) => unknown) {
  vi.mocked(api).mockReset()
  vi.mocked(api).mockImplementation(async (path: string) => {
    if (path === "/api/auth/me") throw new ApiError(401, "Unauthorized")
    if (path === "/api/institution") return { college_name: "Test College" }
    if (path === "/api/auth/google") return onGoogle(path)
    throw new ApiError(404, `No handler in this test for ${path}`)
  })
  renderWithProviders(<SignIn />, { route: "/sign-in" })
  return userEvent.setup()
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("SignIn — Google", () => {
  it("draws Google's button with no domain hint, and trades the token for a session", async () => {
    stubConfigs({ enabled: true, client_id: "client-id.apps.googleusercontent.com" })
    const google = fakeGoogle()
    const user = mount(() => ({ id: "u-1" }))

    await user.click(
      await screen.findByRole("button", { name: "Continue with Google" }, GOOGLE_BUTTON_WAIT)
    )

    const options = vi.mocked(google.accounts.id.initialize).mock.calls[0][0]
    expect(options.client_id).toBe("client-id.apps.googleusercontent.com")
    expect(options).not.toHaveProperty("hd")
    expect(options).not.toHaveProperty("hosted_domain")
    await waitFor(() =>
      expect(vi.mocked(api)).toHaveBeenCalledWith("/api/auth/google", {
        method: "POST",
        json: { credential: "id-token-from-google" },
      })
    )
    expect(screen.getByText(/then link Google from your profile/)).toBeInTheDocument()
  })

  it("shows the server's refusal", async () => {
    stubConfigs({ enabled: true, client_id: "client-id.apps.googleusercontent.com" })
    fakeGoogle()
    const user = mount(() => {
      throw new ApiError(
        403,
        "This Google account is not linked to an account here. Sign in with your email and password, then link Google from your profile."
      )
    })
    await user.click(
      await screen.findByRole("button", { name: "Continue with Google" }, GOOGLE_BUTTON_WAIT)
    )
    expect(await screen.findByRole("alert")).toHaveTextContent(/then link Google from your profile/)
  })

  it("asks the server once whether each provider is on", async () => {
    // Every request here is a round trip to a server half a second away, on
    // the page five hundred people open on a Monday morning.
    stubConfigs({ enabled: true, client_id: "client-id.apps.googleusercontent.com" })
    fakeGoogle()
    mount(() => ({}))
    await screen.findByRole("button", { name: "Continue with Google" }, GOOGLE_BUTTON_WAIT)
    const urls = vi.mocked(fetch).mock.calls.map(([url]) => String(url))
    expect(urls.filter((u) => u.includes("/api/auth/google/config"))).toHaveLength(1)
    expect(urls.filter((u) => u.includes("/api/auth/clerk/config"))).toHaveLength(1)
  })

  it("never loads Google's script when the server has it switched off", async () => {
    stubConfigs({ enabled: false, client_id: null })
    mount(() => ({}))
    expect(await screen.findByRole("button", { name: "Sign in" })).toBeInTheDocument()
    await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalled())
    expect(loadGoogleIdentity).not.toHaveBeenCalled()
    expect(screen.queryByText(/then link Google from your profile/)).toBeNull()
  })
})
