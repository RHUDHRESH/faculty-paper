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
 * The first-sign-in welcome is one thin info line on Home, never a dialog. The
 * shell mounts it only where `welcomeOnHome` says so, so the route rule is
 * asserted on that helper and the line itself is asserted as a plain section.
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

function welcomePosts() {
  return vi
    .mocked(api)
    .mock.calls.filter(([path, opts]) => path === "/api/auth/me/welcome-seen" && (opts as { method?: string })?.method === "POST")
}

describe("first-sign-in welcome", () => {
  it("renders on Home for an account that has not seen it, as one line", async () => {
    mount("/")
    const line = await screen.findByTestId("welcome")
    expect(line).toHaveTextContent("Welcome, Asha.")
    // One line: no list, no card heading, no second action beyond the guides link.
    expect(line.querySelector("ol, ul, h2")).toBeNull()
    expect(line.className).toContain("bg-accent-wash")
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

  it("dismisses with the X and records the welcome once", async () => {
    const user = userEvent.setup()
    mount("/")
    await screen.findByTestId("welcome")
    await user.click(screen.getByRole("button", { name: "Dismiss" }))
    expect(screen.queryByTestId("welcome")).toBeNull()
    expect(welcomePosts()).toHaveLength(1)
  })

  it("links to the guides, and following the link records it too", async () => {
    const user = userEvent.setup()
    mount("/")
    const guides = await screen.findByRole("link", { name: "See the guides" })
    expect(guides).toHaveAttribute("href", "/help")
    await user.click(guides)
    expect(screen.queryByTestId("welcome")).toBeNull()
    expect(welcomePosts()).toHaveLength(1)
  })

  it("has no phone-only collapse any more", async () => {
    mount("/")
    await screen.findByTestId("welcome")
    expect(screen.queryByRole("button", { name: "Show the rest" })).toBeNull()
  })
})
