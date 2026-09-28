import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return { ...actual, api: vi.fn() }
})

vi.mock("@/app/google", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/app/google")>()
  return { ...actual, loadGoogleIdentity: vi.fn() }
})

import { loadGoogleIdentity, type GoogleIdentity } from "@/app/google"
import { api } from "@/lib/api"
import { Profile } from "@/pages/profile"
import { failing, fakeApi, renderWithProviders, type ApiTable } from "@/test/harness"

/**
 * The account page, as the product owner put it: every account has an email
 * and a password; Google can be linked for sign-in; some details you change
 * yourself and the rest go to the research office as a request.
 */

function me(over: Record<string, unknown> = {}) {
  return {
    id: "u-faculty",
    email: "asha@example.edu",
    name: "Dr Asha Menon",
    role: "FACULTY",
    department: "Mechanical Engineering",
    employee_id: null,
    staff_id: "STF-1",
    biometric_id: "BIO-1",
    designation: "Assistant Professor",
    scopus_author_url: "",
    scopus_author_id: "5710",
    faculty_type: "REGULAR",
    research_quota: null,
    research_quota_note: null,
    must_change_password: false,
    active: true,
    portal: "faculty",
    phone: null,
    google: null,
    ...over,
  }
}

const COUNTS = {
  counts: { draft: 0, filed: 0, checked: 0, approved: 0, authorised: 0, paid: 0, sent_back: 0, all: 0 },
}

function mount(account = me(), extra: ApiTable = {}) {
  vi.mocked(api).mockReset()
  vi.mocked(api).mockImplementation(
    fakeApi({
      "/api/auth/me": () => account,
      "/api/auth/profile/corrections": () => ({ results: [] }),
      "/api/auth/profile/correction": () => ({ ok: true }),
      "/api/auth/profile/self": () => ({ ...account, phone: "+91 98400 12345" }),
      "/api/auth/google/config": () => ({
        enabled: true,
        client_id: "client-id.apps.googleusercontent.com",
        hosted_domain: "example.edu",
      }),
      "/api/auth/google/link": () => ({
        google: { email: "asha.personal@gmail.com", linked_at: "2026-03-05T10:00:00+05:30" },
      }),
      "/api/meta/departments": () => ["Mechanical Engineering", "Physics"],
      "/api/claims/counts": () => COUNTS,
      "/api/dashboard": () => ({ total_paid: 0 }),
      "/api/me/interests": () => ({ domains: [] }),
      "/api/meta/research-domains": () => ({ domains: [] }),
      ...extra,
    })
  )
  renderWithProviders(<Profile />, { route: "/me" })
  return userEvent.setup()
}

function writes(path: string, method = "POST") {
  return vi
    .mocked(api)
    .mock.calls.filter(
      ([p, options]) => p === path && (options as { method?: string } | undefined)?.method === method
    )
    .map(([, options]) => (options as { json?: unknown }).json)
}

/** The row for one detail: its label, its value and what can be done about it. */
async function row(label: string) {
  const term = await screen.findByText(label, { selector: "dt" })
  return term.closest("[data-detail]") as HTMLElement
}

/** A stand-in for Google Identity Services: renders a button that hands back a token. */
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

describe("Profile — what you change and what the office keeps", () => {
  it("splits the details into the two kinds", async () => {
    mount()
    expect(await screen.findByRole("heading", { name: "Details you can change" })).toBeInTheDocument()
    expect(screen.getByRole("heading", { name: "Details the research office keeps" })).toBeInTheDocument()
    expect(screen.getByLabelText("Phone")).toBeInTheDocument()

    const staff = await row("Staff ID")
    expect(within(staff).getByText("STF-1")).toBeInTheDocument()
    expect(within(staff).queryByRole("textbox")).toBeNull()
    expect(within(staff).getByRole("button", { name: /Request a change/ })).toBeInTheDocument()
  })

  it("saves a phone number through the self-service route", async () => {
    const user = mount()
    await user.type(await screen.findByLabelText("Phone"), "+91 98400 12345")
    await user.click(screen.getByRole("button", { name: "Save phone number" }))
    await waitFor(() => expect(writes("/api/auth/profile/self", "PATCH")).toHaveLength(1))
    expect(writes("/api/auth/profile/self", "PATCH")[0]).toEqual({ phone: "+91 98400 12345" })
  })

  it("shows the server's reason when a number is refused", async () => {
    const user = mount(me(), {
      "/api/auth/profile/self": failing(400, "That does not look like a phone number."),
    })
    await user.type(await screen.findByLabelText("Phone"), "call me")
    await user.click(screen.getByRole("button", { name: "Save phone number" }))
    expect(await screen.findByText("That does not look like a phone number.")).toBeInTheDocument()
  })

  it("shows a pending request on the detail it is about", async () => {
    mount(me(), {
      "/api/auth/profile/corrections": () => ({
        results: [
          {
            id: "r-1",
            field: "staff_id",
            label: "Staff ID",
            current_value: "STF-1",
            proposed_value: "STF-2",
            note: "",
            status: "PENDING",
            decision_note: "",
            created_at: "2026-03-05T10:00:00+05:30",
            decided_at: null,
            decided_by: null,
          },
        ],
      }),
    })
    const staff = await row("Staff ID")
    expect(await within(staff).findByText(/Pending/)).toBeInTheDocument()
    expect(within(staff).getByText(/STF-2/)).toBeInTheDocument()
    expect(within(staff).getByRole("button", { name: /Change your request/ })).toBeInTheDocument()
  })

  it("asks for a role as a request, never as an edit", async () => {
    const user = mount()
    const role = await row("Role")
    expect(within(role).getByText("Faculty")).toBeInTheDocument()
    await user.click(within(role).getByRole("button", { name: /Request a change/ }))

    const dialog = await screen.findByRole("dialog")
    await user.click(within(dialog).getByLabelText("Proposed role"))
    await user.click(within(dialog).getByRole("option", { name: "Head of department" }))
    await user.click(within(dialog).getByRole("button", { name: "Send request" }))

    await waitFor(() => expect(writes("/api/auth/profile/correction")).toHaveLength(1))
    expect(writes("/api/auth/profile/correction")[0]).toMatchObject({ field: "role", proposed: "HOD" })
  })

  it("shows research faculty their quota, which they can also ask about", async () => {
    mount(me({ faculty_type: "RESEARCH", research_quota: 4 }))
    expect(within(await row("Faculty type")).getByText("Research faculty")).toBeInTheDocument()
    const quota = await row("Research quota")
    expect(within(quota).getByText("4 papers a year")).toBeInTheDocument()
    expect(within(quota).getByRole("button", { name: /Request a change/ })).toBeInTheDocument()
  })
})

describe("Profile — sign-in methods", () => {
  it("offers the password change beside Google", async () => {
    mount()
    expect(await screen.findByRole("heading", { name: "Sign-in methods" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Change password" })).toBeInTheDocument()
  })

  it("says Google is not available rather than drawing a dead button", async () => {
    mount(me(), {
      "/api/auth/google/config": () => ({ enabled: false, client_id: null, hosted_domain: null }),
    })
    expect(
      await screen.findByText("Google sign-in is not available on this server.")
    ).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Link Google account" })).toBeNull()
  })

  it("links a Google account — any domain — with the token Google hands back", async () => {
    const google = fakeGoogle()
    const user = mount()
    expect(await screen.findByText("Not linked")).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Link Google account" }))

    await user.click(await screen.findByRole("button", { name: "Continue with Google" }))
    await waitFor(() => expect(writes("/api/auth/google/link")).toHaveLength(1))
    expect(writes("/api/auth/google/link")[0]).toEqual({ credential: "id-token-from-google" })

    // A personal Gmail must be choosable: no domain hint goes to Google.
    const options = vi.mocked(google.accounts.id.initialize).mock.calls[0][0]
    expect(options.client_id).toBe("client-id.apps.googleusercontent.com")
    expect(options).not.toHaveProperty("hd")
    expect(options).not.toHaveProperty("hosted_domain")
  })

  it("says why a link was refused", async () => {
    fakeGoogle()
    const user = mount(me(), {
      "/api/auth/google/link": failing(
        409,
        "That Google account already belongs to another account here, so it cannot be linked to this one."
      ),
    })
    await user.click(await screen.findByRole("button", { name: "Link Google account" }))
    await user.click(await screen.findByRole("button", { name: "Continue with Google" }))
    expect(await screen.findByText(/already belongs to another account here/)).toBeInTheDocument()
  })

  it("shows which Google account is linked and since when, and unlinks it", async () => {
    const user = mount(
      me({ google: { email: "asha.personal@gmail.com", linked_at: "2026-03-05T10:00:00+05:30" } }),
      { "/api/auth/google/link": () => ({ google: null }) }
    )
    expect(
      await screen.findByText(/Linked to asha\.personal@gmail\.com since 5 Mar 2026/)
    ).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Unlink" }))
    const dialog = await screen.findByRole("dialog")
    await user.click(within(dialog).getByRole("button", { name: "Unlink" }))
    await waitFor(() => expect(writes("/api/auth/google/link", "DELETE")).toHaveLength(1))
  })
})
