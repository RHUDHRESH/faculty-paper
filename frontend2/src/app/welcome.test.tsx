import { screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return { ...actual, api: vi.fn() }
})

import { api } from "@/lib/api"
import { Welcome, welcomeOnHome } from "@/app/welcome"
import { FACULTY, fakeApi, renderWithProviders } from "@/test/harness"

/**
 * The first-sign-in welcome is an inline note on Home, never a dialog. The
 * shell mounts it only where `welcomeOnHome` says so, so the route rule is
 * asserted on that helper and the note itself is asserted as a plain section.
 */

const UNSEEN = { ...FACULTY, welcome_seen: false }

function mount(route: string, me = UNSEEN) {
  vi.mocked(api).mockImplementation(
    fakeApi({
      "/api/auth/me/welcome-seen": () => ({ ok: true }),
      "/api/auth/me": () => me,
    })
  )
  // The shell's rule, as it is written in shell.tsx.
  return renderWithProviders(
    <>{welcomeOnHome(me, route) ? <Welcome /> : null}</>,
    { route }
  )
}

describe("first-sign-in welcome", () => {
  it("renders on Home for an account that has not seen it", async () => {
    mount("/")
    expect(await screen.findByTestId("welcome")).toBeInTheDocument()
    expect(screen.getByRole("heading", { name: /welcome, asha/i })).toBeInTheDocument()
  })

  it("does not render on /papers", () => {
    expect(welcomeOnHome(UNSEEN, "/papers")).toBe(false)
    mount("/papers")
    expect(screen.queryByTestId("welcome")).toBeNull()
  })

  it("is never a dialog", async () => {
    mount("/")
    await screen.findByTestId("welcome")
    expect(screen.queryByRole("dialog")).toBeNull()
  })

  it("hides on Got it and records the welcome once", async () => {
    const user = userEvent.setup()
    mount("/")
    await screen.findByTestId("welcome")
    await user.click(screen.getByRole("button", { name: "Got it" }))
    expect(screen.queryByTestId("welcome")).toBeNull()
    const posts = vi
      .mocked(api)
      .mock.calls.filter(([path, opts]) => path === "/api/auth/me/welcome-seen" && (opts as { method?: string })?.method === "POST")
    expect(posts).toHaveLength(1)
  })

  it("offers the rest of the items behind a phone-only control", async () => {
    const user = userEvent.setup()
    mount("/")
    await screen.findByTestId("welcome")
    const showRest = screen.getByRole("button", { name: "Show the rest" })
    expect(showRest).toBeInTheDocument()
    const items = screen.getByTestId("welcome").querySelectorAll("li")
    expect(items[1].className).toContain("hidden")
    await user.click(showRest)
    expect(screen.queryByRole("button", { name: "Show the rest" })).toBeNull()
    expect(screen.getByTestId("welcome").querySelectorAll("li")[1].className).not.toContain("hidden")
  })
})
