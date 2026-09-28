import { useCollegeName } from "@/app/institution"

/**
 * The reasons a desk writes again and again, one press away.
 *
 * Most send-backs are the same six sentences. The common ones are offered as
 * chips, and the last few this person actually wrote come back too (kept on
 * this device only). Pressing one fills the box; it can still be edited, and
 * nothing is sent until the dialog's own button is pressed.
 */
function common(college: string): string[] {
  return [
  "Attach the published paper as a PDF.",
  "Attach the cited references that carry the college's affiliation, with their numbers.",
  `The affiliation on the paper does not read ${college}.`,
  "The paper is not yet indexed in Scopus — file it again once it appears.",
  "The DOI or ISSN does not match the paper attached.",
  "The author position or the number of authors does not match the paper.",
  ]
}

const KEY = "send-back-reasons"

function recent(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || "[]")
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []
  } catch {
    return []
  }
}

/** Remember a reason once it has actually been sent. */
export function rememberReason(text: string) {
  const t = text.trim()
  if (t.length < 10) return
  try {
    localStorage.setItem(KEY, JSON.stringify([t, ...recent().filter((r) => r !== t)].slice(0, 5)))
  } catch {
    /* a convenience, nothing more */
  }
}

export function ReasonChips({ onPick }: { onPick: (text: string) => void }) {
  const college = useCollegeName()
  const mine = recent()
  const stock = common(college)
  const chips = [...mine, ...stock.filter((c) => !mine.includes(c))].slice(0, 9)
  return (
    <div className="flex flex-wrap gap-1.5" role="group" aria-label="Quick picks">
      {chips.map((c) => (
        <button
          key={c}
          type="button"
          onClick={() => onPick(c)}
          className="max-w-full truncate rounded-full bg-sunken px-2.5 py-1 text-left text-xs text-fg-muted ring-1 ring-inset ring-line hover:text-fg"
          title={c}
        >
          {c}
        </button>
      ))}
    </div>
  )
}
