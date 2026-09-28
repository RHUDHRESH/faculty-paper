import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { CloudDownload, FileText, Sparkles } from "lucide-react"
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom"
import { describe, expect, it, vi } from "vitest"

import { BigSearch } from "@/ui/big-search"
import { Sparkline } from "@/ui/chart"
import { ChoiceGroup, ChoiceTile } from "@/ui/choice"
import { Chip } from "@/ui/chip"
import { ConnectionPath } from "@/ui/connection"
import { JournalCard, PaperCard, PersonCard } from "@/ui/entity"
import { HeroBand } from "@/ui/hero"
import { cellName, RecordStrip, shadeOf } from "@/ui/record-strip"
import { Illustration, SharePlate } from "@/ui/share-plate"
import { StatTile } from "@/ui/stat"
import { Timeline } from "@/ui/timeline"

const wrap = (ui: React.ReactNode) => render(<MemoryRouter>{ui}</MemoryRouter>)

function Where() {
  const l = useLocation()
  return <p data-testid="where">{l.pathname + l.search}</p>
}

describe("Convocation shared components", () => {
  it("Chip carries its area", () => {
    wrap(<Chip tone="area" area="research">Topic</Chip>)
    expect(screen.getByText("Topic")).toHaveAttribute("data-area", "research")
  })

  it("HeroBand shows a dash, never 0, while a figure loads, and links figures", () => {
    wrap(
      <HeroBand
        variant="solid"
        title="Good morning"
        figures={[
          { value: null, label: "papers", to: "/papers" },
          { value: 46, label: "citations", to: "/research#citations" },
        ]}
      />
    )
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Good morning")
    expect(screen.getByText("—")).toBeInTheDocument()
    expect(screen.queryByText("0")).toBeNull()
    expect(screen.getByRole("link", { name: /46 citations/ })).toHaveAttribute("href", "/research#citations")
  })

  it("StatTile is a link when given `to` and shows a caution chip", () => {
    wrap(<StatTile icon={FileText} figure={10} label="papers" to="/papers" caution="10 lack a subject" delta={2} />)
    expect(screen.getByRole("link")).toHaveAttribute("href", "/papers")
    expect(screen.getByText("10 lack a subject")).toBeInTheDocument()
    expect(screen.getByText(/\+2/)).toBeInTheDocument()
  })

  it("ChoiceTile in a group has radio semantics and arrows move", async () => {
    const pick = vi.fn()
    wrap(
      <ChoiceGroup label="Method">
        <ChoiceTile icon={CloudDownload} title="Scopus" checked recommended onSelect={() => pick("s")} />
        <ChoiceTile icon={Sparkles} title="DOI" checked={false} onSelect={() => pick("d")} />
      </ChoiceGroup>
    )
    const radios = screen.getAllByRole("radio")
    expect(radios[0]).toHaveAttribute("aria-checked", "true")
    expect(screen.getByText("Recommended")).toBeInTheDocument()
    radios[0].focus()
    await userEvent.keyboard("{ArrowRight}")
    expect(pick).toHaveBeenLastCalledWith("d")
  })

  it("BigSearch submits and switches scope", async () => {
    const submit = vi.fn()
    const scope = vi.fn()
    wrap(<BigSearch value="ml" onChange={() => {}} onSubmit={submit} onScope={scope} />)
    await userEvent.click(screen.getByRole("tab", { name: "People" }))
    expect(scope).toHaveBeenCalledWith("people")
    await userEvent.type(screen.getByRole("searchbox"), "{Enter}")
    expect(submit).toHaveBeenCalledWith("ml")
  })

  it("PaperCard bolds you, works out position and offers File it", () => {
    wrap(
      <PaperCard
        title="Enhanced ML"
        journal="IEEE Access"
        year={2024}
        quartile="Q1"
        authors={[{ name: "A" }, { name: "Me", you: true }, { name: "C" }]}
        claim={{ unclaimed: true, fileTo: "/file?paper=1" }}
      />
    )
    expect(screen.getByText("Me").tagName).toBe("STRONG")
    expect(screen.getByText(/2 of 3/)).toBeInTheDocument()
    expect(screen.getByRole("link", { name: /File it/ })).toHaveAttribute("href", "/file?paper=1")
  })

  it("PersonCard and JournalCard render their contract", () => {
    wrap(
      <>
        <PersonCard person={{ name: "Dr X", initials: "DX", photo_url: null, department: "ECE" }} to="/people/1" context="3 papers together" />
        <JournalCard name="IEEE Access" quartile="Q1" colleagues={4} />
      </>
    )
    expect(screen.getByRole("link", { name: /View/ })).toHaveAttribute("href", "/people/1")
    expect(screen.getByText("3 papers together")).toBeInTheDocument()
    expect(screen.getByText("4 colleagues published here")).toBeInTheDocument()
  })

  it("RecordStrip cells are named buttons that deep-link", async () => {
    expect(shadeOf(0)).toBe(0)
    expect(shadeOf(5)).toBe(4)
    expect(cellName("2024-03", 2)).toBe("March 2024, 2 papers")
    render(
      <MemoryRouter>
        <Routes>
          <Route path="*" element={<><RecordStrip data={[{ month: "2024-03", papers: 2 }]} endYear={2025} years={2} /><Where /></>} />
        </Routes>
      </MemoryRouter>
    )
    expect(screen.getAllByRole("button")).toHaveLength(24)
    await userEvent.click(screen.getByRole("button", { name: "March 2024, 2 papers" }))
    expect(screen.getByTestId("where")).toHaveTextContent("/papers?month=2024-03")
  })

  it("ConnectionPath names the route and caps at three paths", () => {
    const p = (n: string) => ({ person: { name: n, initials: n[0], photo_url: null }, evidence: "3 papers" })
    wrap(<ConnectionPath paths={[[p("Me"), p("X"), p("Y")], [p("Me"), p("Z")], [p("Me"), p("W")], [p("Me"), p("V")]]} />)
    expect(screen.getAllByRole("list")).toHaveLength(3)
    expect(screen.getByLabelText("Me → X (3 papers) → Y (3 papers)")).toBeInTheDocument()
  })

  it("Timeline groups by year, newest first", () => {
    wrap(
      <Timeline
        events={[
          { date: "2022-01-01", kind: "paper", title: "Old" },
          { date: "2024-05-01", kind: "first-q1", title: "First Q1" },
        ]}
      />
    )
    const years = screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent)
    expect(years).toEqual(["2024", "2022"])
  })

  it("SharePlate, Illustration and Sparkline render", () => {
    const { container } = wrap(
      <>
        <SharePlate>Certificate</SharePlate>
        <Illustration name="empty-papers" />
        <Sparkline values={[1, 3, 2]} label="trend" />
        <Sparkline values={[1]} />
      </>
    )
    expect(screen.getByText("Certificate")).toHaveAttribute("data-area", "honours")
    expect(container.querySelector('img[src="/illustrations/empty-papers.svg"]')).not.toBeNull()
    expect(screen.getByRole("img", { name: "trend" })).toBeInTheDocument()
  })
})
