import { useMemo, useRef, useState } from "react"
import { ArrowDown, ArrowUp, GripVertical, X } from "lucide-react"

import { cn } from "@/lib/cn"
import { Button } from "@/ui/button"
import { Checkbox, Input } from "@/ui/field"
import type { Dataset } from "./model"

/** Moves one item to a new place in a list, leaving the list alone if it cannot. */
export function moved<T>(list: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return list
  const next = [...list]
  const [item] = next.splice(from, 1)
  next.splice(to, 0, item)
  return next
}

/**
 * "Show me": the columns of the report, in the order they will appear.
 *
 * The chosen columns are listed first, in order, each with Move up and Move
 * down buttons (a keyboard and a thumb can use these; dragging is the extra,
 * not the only way). Below them every field in the dataset is a checkbox with
 * a search box over it, so a dataset with forty fields is still a list a
 * person can scan.
 */
export function ColumnsPicker({
  dataset,
  value,
  onChange,
}: {
  dataset: Dataset
  value: string[]
  onChange: (columns: string[]) => void
}) {
  const [search, setSearch] = useState("")
  const dragging = useRef<number | null>(null)
  const label = (key: string) => dataset.fields.find((f) => f.key === key)?.label ?? key

  const shown = useMemo(() => {
    const term = search.trim().toLowerCase()
    return term ? dataset.fields.filter((f) => f.label.toLowerCase().includes(term)) : dataset.fields
  }, [dataset.fields, search])

  function toggle(key: string, on: boolean) {
    onChange(on ? [...value, key] : value.filter((k) => k !== key))
  }

  return (
    <div className="space-y-4">
      {value.length > 0 ? (
        <ol aria-label="Columns in the order they will appear" className="divide-y divide-line rounded-control ring-1 ring-inset ring-edge">
          {value.map((key, i) => (
            <li
              key={key}
              draggable
              onDragStart={() => {
                dragging.current = i
              }}
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => {
                if (dragging.current !== null) onChange(moved(value, dragging.current, i))
                dragging.current = null
              }}
              className="flex items-center gap-1 bg-surface px-2 py-1.5"
            >
              <GripVertical aria-hidden className="size-4 shrink-0 cursor-grab text-fg-subtle" />
              <span className="min-w-0 flex-1 truncate text-base">{label(key)}</span>
              <Button
                type="button"
                kind="quiet"
                size="icon-sm"
                aria-label={`Move ${label(key)} up`}
                disabled={i === 0}
                onClick={() => onChange(moved(value, i, i - 1))}
              >
                <ArrowUp />
              </Button>
              <Button
                type="button"
                kind="quiet"
                size="icon-sm"
                aria-label={`Move ${label(key)} down`}
                disabled={i === value.length - 1}
                onClick={() => onChange(moved(value, i, i + 1))}
              >
                <ArrowDown />
              </Button>
              <Button type="button" kind="quiet" size="icon-sm" aria-label={`Remove ${label(key)}`} onClick={() => toggle(key, false)}>
                <X />
              </Button>
            </li>
          ))}
        </ol>
      ) : (
        <p className="text-sm text-fg-muted">Nothing chosen yet. Tick what you want to see below.</p>
      )}

      <div className="space-y-2">
        <Input
          type="search"
          aria-label="Find a column"
          placeholder="Find a column"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <ul aria-label="All the columns you can show" className="max-h-64 space-y-0.5 overflow-y-auto pr-1">
          {shown.map((f) => (
            <li key={f.key} className={cn("rounded-control px-2 py-2 hover:bg-hover")}>
              <Checkbox
className="size-5"
                label={f.label}
                hint={f.description || undefined}
                checked={value.includes(f.key)}
                onCheckedChange={(v) => toggle(f.key, v === true)}
              />
            </li>
          ))}
          {shown.length === 0 && <li className="px-2 py-2 text-sm text-fg-muted">No column is called that.</li>}
        </ul>
      </div>
    </div>
  )
}
