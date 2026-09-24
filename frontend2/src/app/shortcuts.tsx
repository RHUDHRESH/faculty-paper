import { lazy, Suspense, useEffect, useState } from "react"

/**
 * `?` anywhere (outside a text field) lists the keys the app answers to.
 * The queues have always taken j / k / x / Enter and the palette Ctrl K;
 * nothing ever said so except a line of small print on two pages.
 *
 * Only the listener is here. The dialog is fetched the first time it opens
 * (`shortcuts-dialog.tsx`), because it is on every screen and needed on few.
 */
export type ShortcutGroup = { title: string; keys: [string, string][] }

export const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    title: "Anywhere",
    keys: [
      ["Ctrl K", "Jump to a page, a paper, a person or a ticket number"],
      ["?", "Show this list"],
      ["Esc", "Close a dialog, a sheet or a menu"],
    ],
  },
  {
    title: "In a queue (clearing, approvals, authorisations, payments)",
    keys: [
      ["j  /  ↓", "Next ticket"],
      ["k  /  ↑", "Previous ticket"],
      ["x", "Select or unselect the ticket"],
      ["Enter", "Open the ticket"],
      ["/", "Search the queue (clearing and approvals)"],
    ],
  },
  {
    title: "Filing a paper",
    keys: [["Ctrl Enter", "Continue to the next step"]],
  },
]

const OPEN_EVENT = "shortcuts:open"

/** Open the list from a button, for anybody who would never guess `?`. */
export function openShortcuts() {
  window.dispatchEvent(new CustomEvent(OPEN_EVENT))
}

const ShortcutsDialog = lazy(() =>
  import("@/app/shortcuts-dialog").then((m) => ({ default: m.ShortcutsDialog }))
)

function typing(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el) return false
  return el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName)
}

export function Shortcuts() {
  const [open, setOpen] = useState(false)
  // Once fetched it stays mounted, so closing still plays its exit.
  const [wanted, setWanted] = useState(false)

  useEffect(() => {
    const show = () => {
      setWanted(true)
      setOpen(true)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "?" && !e.ctrlKey && !e.metaKey && !typing(e.target)) {
        e.preventDefault()
        show()
      }
    }
    window.addEventListener("keydown", onKey)
    window.addEventListener(OPEN_EVENT, show)
    return () => {
      window.removeEventListener("keydown", onKey)
      window.removeEventListener(OPEN_EVENT, show)
    }
  }, [])

  if (!wanted) return null
  return (
    <Suspense fallback={null}>
      <ShortcutsDialog open={open} onOpenChange={setOpen} groups={SHORTCUT_GROUPS} />
    </Suspense>
  )
}
