import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

/**
 * Google's script is fetched once per page load, whoever asks first.
 *
 * The sign-in page and the profile's "Link Google account" both need it. The
 * sign-in page used to decide it was ready the moment a `<script>` tag with
 * the right id existed — not when it had finished loading — so arriving at a
 * second screen mid-download drew nothing and said nothing.
 */

type Loader = typeof import("@/app/google")

async function freshLoader(): Promise<Loader> {
  vi.resetModules()
  return import("@/app/google")
}

function scripts() {
  return Array.from(document.head.querySelectorAll("script")).filter((s) =>
    s.src.includes("accounts.google.com/gsi/client")
  )
}

const FAKE = { accounts: { id: { initialize: () => {}, renderButton: () => {} } } }

beforeEach(() => {
  for (const s of scripts()) s.remove()
  delete (window as unknown as { google?: unknown }).google
})

afterEach(() => {
  delete (window as unknown as { google?: unknown }).google
})

describe("loadGoogleIdentity", () => {
  it("adds Google's script once, however many screens ask", async () => {
    const { loadGoogleIdentity } = await freshLoader()
    const first = loadGoogleIdentity()
    const second = loadGoogleIdentity()
    expect(scripts()).toHaveLength(1)

    ;(window as unknown as { google?: unknown }).google = FAKE
    scripts()[0].dispatchEvent(new Event("load"))

    await expect(first).resolves.toBe(FAKE)
    await expect(second).resolves.toBe(FAKE)
  })

  it("answers straight away when the script is already there", async () => {
    ;(window as unknown as { google?: unknown }).google = FAKE
    const { loadGoogleIdentity } = await freshLoader()
    await expect(loadGoogleIdentity()).resolves.toBe(FAKE)
    expect(scripts()).toHaveLength(0)
  })

  it("fails loudly when the script cannot load, and tries again next time", async () => {
    const { loadGoogleIdentity } = await freshLoader()
    const attempt = loadGoogleIdentity()
    scripts()[0].dispatchEvent(new Event("error"))
    await expect(attempt).rejects.toThrow(/did not load/)
    expect(scripts()).toHaveLength(0)

    void loadGoogleIdentity().catch(() => {})
    expect(scripts()).toHaveLength(1)
  })
})
