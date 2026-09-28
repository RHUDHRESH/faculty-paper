import { describe, expect, it } from "vitest"

import { applyEdit, insertMention, markupFor, toDisplay, toMarkup } from "./mention-text"

describe("mention markup round-trip", () => {
  const cases = [
    'Congratulations @user:"Dr. R. Subhashini" on “A paper”! ',
    '@user:"Asha Menon", about @journal:"Ceramics International": see @paper:abc-123',
    "ask @agent and @dept:\"Computer Science\" and @user:R.Subhashini.",
    "email me at joyal@example.com, plain @asha stays",
  ]
  it.each(cases)("display → markup is exact: %s", (markup) => {
    expect(toMarkup(toDisplay(markup))).toBe(markup)
  })

  it("shows names cleanly", () => {
    const m = toDisplay('Congratulations @user:"Dr. R. Subhashini" on it')
    expect(m.text).toBe("Congratulations @Dr. R. Subhashini on it")
    expect(m.spans).toHaveLength(1)
    expect(m.text.slice(m.spans[0].start, m.spans[0].end)).toBe("@Dr. R. Subhashini")
  })

  it("quotes names with dots and spaces, and neutralises a straight quote", () => {
    expect(markupFor("USER", "Dr. R. Subhashini")).toBe('@user:"Dr. R. Subhashini"')
    expect(markupFor("USER", "R.Subhashini")).toBe("@user:R.Subhashini")
    const odd = markupFor("USER", 'Anand "Andy" Kumar')
    expect(odd).toBe("@user:\"Anand ”Andy” Kumar\"")
    expect(toMarkup(toDisplay(`hi ${odd}`))).toBe(`hi ${odd}`)
    expect(toDisplay(`hi ${odd}`).text).toBe("hi @Anand ”Andy” Kumar")
  })

  it("typing around a mention keeps it; deleting into it removes it whole", () => {
    const m = toDisplay('Hi @user:"Asha Menon" there')
    const typed = applyEdit(m, "Hi @Asha Menon there!", 21)
    expect(toMarkup(typed.model)).toBe('Hi @user:"Asha Menon" there!')
    // Backspace at the end of the name.
    const back = applyEdit(m, "Hi @Asha Meno there", 13)
    expect(back.model.text).toBe("Hi  there")
    expect(back.caret).toBe(3)
    expect(toMarkup(back.model)).toBe("Hi  there")
  })

  it("insertMention writes the markup and a trailing space", () => {
    const start = toDisplay("ping @As")
    const r = insertMention(start, 5, 8, "Asha Menon", markupFor("USER", "Asha Menon"), "USER")
    expect(r.model.text).toBe("ping @Asha Menon ")
    expect(toMarkup(r.model)).toBe('ping @user:"Asha Menon" ')
    expect(r.caret).toBe(17)
  })
})
