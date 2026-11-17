import { useState } from "react"
import { X } from "lucide-react"

import { Avatar } from "@/ui/person"
import { Input } from "@/ui/field"
import { InlineError } from "@/ui/state"
import { useMentionSearch } from "@/ui/composer"

export type Person = { id: string; name: string }

/**
 * Who a scheduled report is sent to: type a name, press the person, and they
 * appear as a chip with a remove button. Uses the one person lookup every role
 * can call (`/api/mentions/search`), so an HOD and the research coordinator
 * both find colleagues the same way.
 */
export function PeoplePicker({
  chosen,
  onChange,
  id,
}: {
  chosen: Person[]
  onChange: (people: Person[]) => void
  id?: string
}) {
  const [query, setQuery] = useState("")
  const { status, results } = useMentionSearch(query.trim() ? query : null, "USER")
  const offered = results.filter((c) => !chosen.some((p) => p.id === c.id))

  return (
    <div className="space-y-2">
      {chosen.length > 0 && (
        <ul aria-label="People who will get this report" className="flex flex-wrap gap-2">
          {chosen.map((p) => (
            <li key={p.id} className="inline-flex items-center gap-2 rounded-full bg-accent-wash py-1 pl-1.5 pr-1 text-base">
              <Avatar person={{ name: p.name, initials: "", photo_url: null }} size="xs" />
              {p.name}
              <button
                type="button"
                aria-label={`Remove ${p.name}`}
                onClick={() => onChange(chosen.filter((c) => c.id !== p.id))}
                className="grid size-7 place-items-center rounded-full text-fg-muted hover:bg-hover hover:text-fg"
              >
                <X className="size-4" aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      )}
      <Input
        id={id}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Type a name to add someone"
        autoComplete="off"
      />
      {status === "loading" && <p className="text-sm text-fg-muted">Looking…</p>}
      {status === "failed" && <InlineError message="Could not search for people just now." />}
      {status === "ready" && offered.length === 0 && (
        <p className="text-sm text-fg-muted">
          {results.length > 0 ? "Everybody matching that is already added." : `Nobody here matches “${query.trim()}”.`}
        </p>
      )}
      {offered.length > 0 && (
        <ul aria-label="People found" className="max-h-48 divide-y divide-line overflow-y-auto rounded-control ring-1 ring-inset ring-edge">
          {offered.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                onClick={() => {
                  onChange([...chosen, { id: c.id, name: c.label }])
                  setQuery("")
                }}
                className="flex min-h-11 w-full items-center gap-3 px-3 py-2 text-left text-base hover:bg-hover"
              >
                <Avatar person={{ name: c.label, initials: c.initials ?? "", photo_url: c.photo_url ?? null }} size="sm" />
                <span className="min-w-0 flex-1 truncate">{c.label}</span>
                {c.hint && <span className="shrink-0 truncate text-sm text-fg-muted">{c.hint}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
