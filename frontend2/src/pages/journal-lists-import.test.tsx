import { screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>()
  return { ...actual, api: vi.fn() }
})

import { api } from "@/lib/api"
import { JournalListsImport } from "@/pages/journal-lists-import"
import { renderWithProviders } from "@/test/harness"

const NOT_LOADED = [
  { source: "SCOPUS_DISCONTINUED", label: "Scopus discontinued list", entries: 0, loaded_at: null },
  { source: "HIJACKED", label: "Hijacked journals list", entries: 604, loaded_at: "2026-10-07T05:00:00Z" },
  { source: "OTHER", label: "Other list", entries: 0, loaded_at: null },
]

function mount() {
  vi.mocked(api).mockReset()
  vi.mocked(api).mockImplementation(((path: string) => {
    if (path === "/api/journals/flag-lists") return Promise.resolve(NOT_LOADED)
    if (path.startsWith("/api/journals/flag-lists/upload")) return Promise.resolve({ source: "x", entries: 1746 })
    return Promise.reject(new Error(`unexpected ${path}`))
  }) as typeof api)
  renderWithProviders(<JournalListsImport />)
}

const csv = () => new File(["title,issn\nABB Review,1013-3119"], "scopus-discontinued.csv", { type: "text/csv" })

describe("Journal safety lists", () => {
  it("says which list is loaded and which is not", async () => {
    mount()
    expect(await screen.findByText(/604 journals, loaded 7 Oct 2026/)).toBeInTheDocument()
    expect(screen.getByText("Not loaded yet, so the journal check says unknown.")).toBeInTheDocument()
    for (const b of screen.getAllByRole("button", { name: "Load this list" })) expect(b).toBeDisabled()
  })

  it("sends the chosen file to the list it was picked under, and nothing else", async () => {
    mount()
    await screen.findByText(/604 journals/)
    const [dropped] = screen.getAllByLabelText("File")
    await userEvent.upload(dropped, csv())
    await userEvent.click(screen.getAllByRole("button", { name: "Load this list" })[0])
    await waitFor(() =>
      expect(vi.mocked(api).mock.calls.some((c) => c[0] === "/api/journals/flag-lists/upload?source=SCOPUS_DISCONTINUED")).toBe(true)
    )
    const call = vi.mocked(api).mock.calls.find((c) => String(c[0]).includes("/upload"))!
    const init = call[1] as unknown as { method: string; body: FormData }
    expect(init.method).toBe("POST")
    expect((init.body.get("file") as File).name).toBe("scopus-discontinued.csv")
    expect(vi.mocked(api).mock.calls.filter((c) => String(c[0]).includes("/upload"))).toHaveLength(1)
  })
})
