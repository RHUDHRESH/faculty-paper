import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter } from "react-router-dom"
import { describe, expect, it } from "vitest"

import { formatCount } from "@/lib/count"
import { Answer } from "@/ui/answer"
import { Breadcrumbs } from "@/ui/breadcrumbs"
import { PageHeader } from "@/ui/page-header"
import { Details, Section } from "@/ui/section"
import { Skeleton } from "@/ui/state"

const wrap = (ui: React.ReactElement) => render(<MemoryRouter>{ui}</MemoryRouter>)

describe("real counts", () => {
  it("never caps a count", () => {
    expect(formatCount(1284)).toBe("1,284")
    expect(formatCount(150)).toBe("150")
    expect(formatCount(109265)).toBe("1,09,265")
    expect(formatCount(null)).toBe("0")
  })
})

describe("Answer", () => {
  it("shows the real number and links it to the list behind it", () => {
    wrap(<Answer items={[{ value: 1284, label: "Waiting to clear", to: "/clearing" }]} />)
    const link = screen.getByRole("link")
    expect(link).toHaveAttribute("href", "/clearing")
    expect(link).toHaveTextContent("1,284 Waiting to clear")
    expect(screen.queryByText(/99\+/)).toBeNull()
  })

  it("says what a zero means", () => {
    wrap(<Answer items={[{ value: 0, label: "Waiting to clear", zero: "Nothing waiting" }]} />)
    expect(screen.getByText("Nothing waiting", { selector: "span[aria-hidden]" })).toBeInTheDocument()
  })

  it("sets a long money value smaller on a phone and lets it wrap, so it cannot overflow", () => {
    wrap(
      <Answer
        items={[
          { value: "₹12,34,56,789", label: "Paid this year" },
          { value: "₹4,500", label: "Owed" },
        ]}
      />
    )
    const long = screen.getByText("₹12,34,56,789", { selector: "span[aria-hidden]" })
    expect(long).toHaveClass("max-sm:text-xl")
    expect(long.className).toContain("overflow-wrap:anywhere")
    expect(screen.getByText("₹4,500", { selector: "span[aria-hidden]" })).not.toHaveClass("max-sm:text-xl")
  })

  it("holds at most four figures", () => {
    const items = Array.from({ length: 6 }, (_, i) => ({ value: i + 1, label: `Thing ${i}` }))
    wrap(<Answer items={items} />)
    expect(screen.getAllByText(/^Thing \d$/, { selector: "span[aria-hidden]" })).toHaveLength(4)
  })
})

describe("PageHeader", () => {
  it("has a title, one line of purpose and one primary action, and no rule", () => {
    const { container } = wrap(
      <PageHeader title="People" sub="Who can sign in, and what they can do" action={<button>Add a person</button>} />
    )
    expect(screen.getByRole("heading", { level: 1, name: "People" })).toBeInTheDocument()
    expect(screen.getByText("Who can sign in, and what they can do")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Add a person" })).toBeInTheDocument()
    expect(container.querySelector("header")).not.toHaveClass("border-b")
  })

  it("draws breadcrumbs above the title when given", () => {
    wrap(<PageHeader title="Run" breadcrumbs={[{ label: "Admin", to: "/admin" }, { label: "Run" }]} />)
    expect(screen.getByRole("navigation", { name: "Breadcrumb" })).toBeInTheDocument()
  })
})

describe("Breadcrumbs", () => {
  it("links every crumb but the last, which marks the current page", () => {
    wrap(<Breadcrumbs items={[{ label: "Admin", to: "/admin" }, { label: "Imports", to: "/imports" }, { label: "ERP workbook, 28 Sep" }]} />)
    expect(screen.getAllByRole("link").map((a) => a.getAttribute("href"))).toEqual(["/admin", "/imports"])
    expect(screen.getByText("ERP workbook, 28 Sep")).toHaveAttribute("aria-current", "page")
  })
})

describe("Section and Details", () => {
  it("labels a section by its title", () => {
    wrap(
      <Section title="Waiting on you">
        <p>rows</p>
      </Section>
    )
    expect(screen.getByRole("region", { name: "Waiting on you" })).toBeInTheDocument()
  })

  it("says how much is behind a disclosure, and opens it", async () => {
    wrap(
      <Details count={1284} label="details">
        <p>the detail</p>
      </Details>
    )
    const button = screen.getByRole("button", { name: /show details/i })
    expect(button).toHaveTextContent("(1,284)")
    expect(screen.queryByText("the detail")).toBeNull()
    await userEvent.click(button)
    expect(screen.getByText("the detail")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /hide details/i })).toHaveAttribute("aria-expanded", "true")
  })
})

describe("Skeleton", () => {
  it("is a .skeleton block, which styles.css keeps invisible for the first 300 ms", () => {
    const { container } = render(<Skeleton className="h-3" />)
    expect(container.firstElementChild).toHaveClass("skeleton")
  })
})
