import { useEffect, useState, type Dispatch, type SetStateAction } from "react"
import * as RadixMenu from "@radix-ui/react-dropdown-menu"
import { Check, Columns3, Download, Grid3x3, Rows3 } from "lucide-react"

import type { ExportFormat } from "@/lib/table-export"
import { Button } from "@/ui/button"
import { Menu, MenuContent, MenuItem, MenuLabel, MenuTrigger } from "@/ui/menu"
import { toast } from "@/ui/toast"

/**
 * The tools above a list: choose the columns, draw grid lines, tighten the
 * rows, and download or print the list. Built for staff who read a table on
 * a screen all day and want the lines and the figures they need, not the
 * ones a designer chose.
 *
 * What goes wrong without it: every list invents its own CSV button, so a
 * person who learns to export the faculty list cannot do it for claims, and
 * a hidden column comes back on every visit because nothing remembers it.
 */

export type Density = "comfortable" | "compact"

export type TablePrefs = {
  hidden: Set<string>
  setHidden: Dispatch<SetStateAction<Set<string>>>
  grid: boolean
  setGrid: (on: boolean) => void
  density: Density
  setDensity: (d: Density) => void
  reset: () => void
}

type Stored = { hidden?: unknown; grid?: unknown; density?: unknown }

const keyFor = (tableId: string) => `table-prefs:${tableId}`

// Storage can be missing, disabled (some private modes throw on access) or
// full. Every touch is guarded: a table must work without remembering.
function readStored(tableId: string): Stored {
  try {
    const raw = window.localStorage.getItem(keyFor(tableId))
    if (!raw) return {}
    const value: unknown = JSON.parse(raw)
    return value && typeof value === "object" ? (value as Stored) : {}
  } catch {
    return {}
  }
}

function writeStored(tableId: string, value: Required<Stored>) {
  try {
    window.localStorage.setItem(keyFor(tableId), JSON.stringify(value))
  } catch {
    // Not remembered this time; the table still works for this visit.
  }
}

/** Keeps only keys that are real columns, never the first, and at least two
 *  columns showing. A saved choice that breaks those rules is dropped. */
function sanitiseHidden(saved: unknown, keys: string[]): Set<string> {
  const lead = keys[0]
  const list = Array.isArray(saved) ? saved.filter((k): k is string => typeof k === "string") : []
  const hidden = new Set(list.filter((k) => keys.includes(k) && k !== lead))
  return keys.length - hidden.size < 2 ? new Set() : hidden
}

/**
 * The per-table view choices, remembered in this browser under
 * `table-prefs:<tableId>`. Works the same with no storage at all; the choices
 * just do not survive a reload.
 */
export function useTablePrefs(tableId: string, columnKeys: string[], defaultHidden: string[] = []): TablePrefs {
  const [stored] = useState<Stored>(() => readStored(tableId))
  const [hidden, setHidden] = useState<Set<string>>(() =>
    sanitiseHidden(stored.hidden === undefined ? defaultHidden : stored.hidden, columnKeys)
  )
  const [grid, setGrid] = useState<boolean>(stored.grid === true)
  const [density, setDensity] = useState<Density>(stored.density === "compact" ? "compact" : "comfortable")

  useEffect(() => {
    writeStored(tableId, { hidden: [...hidden], grid, density })
  }, [tableId, hidden, grid, density])

  function reset() {
    setHidden(sanitiseHidden(defaultHidden, columnKeys))
    setGrid(false)
    setDensity("comfortable")
  }

  return { hidden, setHidden, grid, setGrid, density, setDensity, reset }
}

const ITEM =
  "flex h-9 max-sm:h-11 cursor-pointer select-none items-center gap-2.5 rounded-control px-2.5 text-sm font-medium text-fg outline-none " +
  "transition-colors duration-[var(--dur-1)] " +
  "data-[disabled]:pointer-events-none data-[disabled]:opacity-50 " +
  "data-[highlighted]:bg-hover data-[highlighted]:ring-1 data-[highlighted]:ring-inset data-[highlighted]:ring-edge"

const FORMATS: { key: ExportFormat | "print"; label: string }[] = [
  { key: "xlsx", label: "Excel (.xlsx)" },
  { key: "pdf", label: "PDF" },
  { key: "csv", label: "CSV" },
  { key: "print", label: "Print" },
]

/**
 * The toolbar row above a table. Columns, grid lines, compact rows, reset, and
 * one Export menu. Reports a failed export as a toast and disables the menu
 * while a file is being made, so a second press cannot start a second file.
 */
export function TableToolbar({
  columns,
  prefs,
  onExport,
}: {
  /** Every column in order, with the name a person sees. The first is locked on. */
  columns: { key: string; label: string }[]
  prefs: TablePrefs
  onExport: (format: ExportFormat | "print") => Promise<unknown> | void
}) {
  const [busy, setBusy] = useState(false)
  const lead = columns[0]?.key
  const showing = columns.filter((c) => !prefs.hidden.has(c.key)).length

  function setColumn(key: string, show: boolean) {
    if (key === lead) return
    if (!show && showing <= 2) return
    prefs.setHidden((prev) => {
      const next = new Set(prev)
      if (show) next.delete(key)
      else next.add(key)
      return next
    })
  }

  async function run(format: ExportFormat | "print") {
    setBusy(true)
    try {
      await onExport(format)
    } catch (e) {
      toast.fail(e, "Could not make the file. Try again.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="table-tools mb-3 flex flex-wrap items-center gap-2">
      <Menu>
        <MenuTrigger asChild>
          <Button kind="default" size="sm" type="button">
            <Columns3 />
            Columns
          </Button>
        </MenuTrigger>
        <MenuContent className="max-h-80 overflow-y-auto">
          <MenuLabel>Show columns</MenuLabel>
          {columns.map((c) => {
            const on = !prefs.hidden.has(c.key)
            const locked = c.key === lead || (on && showing <= 2)
            return (
              <RadixMenu.CheckboxItem
                key={c.key}
                checked={on}
                disabled={locked}
                onSelect={(e) => e.preventDefault()}
                onCheckedChange={(v) => setColumn(c.key, v === true)}
                className={ITEM}
              >
                <span className="flex size-4 shrink-0 items-center justify-center">
                  <RadixMenu.ItemIndicator>
                    <Check className="size-4" />
                  </RadixMenu.ItemIndicator>
                </span>
                <span className="min-w-0 flex-1 truncate">{c.label}</span>
              </RadixMenu.CheckboxItem>
            )
          })}
          <p className="px-2.5 pb-1 pt-2 text-xs text-fg-subtle">The first column always shows.</p>
        </MenuContent>
      </Menu>

      <Button
        kind="default"
        size="sm"
        type="button"
        aria-pressed={prefs.grid}
        onClick={() => prefs.setGrid(!prefs.grid)}
        className="aria-pressed:bg-hover aria-pressed:text-fg"
      >
        <Grid3x3 />
        Grid lines
      </Button>
      <Button
        kind="default"
        size="sm"
        type="button"
        aria-pressed={prefs.density === "compact"}
        onClick={() => prefs.setDensity(prefs.density === "compact" ? "comfortable" : "compact")}
        className="aria-pressed:bg-hover aria-pressed:text-fg"
      >
        <Rows3 />
        Compact rows
      </Button>
      <Button kind="quiet" size="sm" type="button" onClick={prefs.reset}>
        Reset
      </Button>

      <Menu>
        <MenuTrigger asChild>
          <Button kind="default" size="sm" type="button" disabled={busy} loading={busy}>
            <Download />
            Export
          </Button>
        </MenuTrigger>
        <MenuContent align="end">
          {FORMATS.map((f) => (
            <MenuItem key={f.key} onSelect={() => void run(f.key)}>
              {f.label}
            </MenuItem>
          ))}
        </MenuContent>
      </Menu>
      {busy && (
        <span role="status" className="text-sm text-fg-muted">
          Preparing the file...
        </span>
      )}
    </div>
  )
}
