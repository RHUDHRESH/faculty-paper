import { useEffect, useState } from "react"

import { Dialog, DialogBody, DialogContent, DialogHeader, DialogTitle } from "@/ui/dialog"

/**
 * `?` anywhere (outside a text field) lists the keys the app answers to.
 * The queues have always taken j / k / x / Enter and the palette Ctrl K;
 * nothing ever said so except a line of small print on two pages.
 */
const GROUPS: { title: string; keys: [string, string][] }[] = [
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
    ],
  },
  {
    title: "Filing a paper",
    keys: [["Ctrl Enter", "Continue to the next step"]],
  },
]

function typing(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el) return false
  return el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName)
}

export function Shortcuts() {
  const [open, setOpen] = useState(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "?" && !e.ctrlKey && !e.metaKey && !typing(e.target)) {
        e.preventDefault()
        setOpen(true)
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
        </DialogHeader>
        <DialogBody className="space-y-5">
          {GROUPS.map((g) => (
            <section key={g.title}>
              <h3 className="mb-2 text-sm font-medium text-fg-muted">{g.title}</h3>
              <dl className="divide-y divide-line rounded-md ring-1 ring-line">
                {g.keys.map(([k, what]) => (
                  <div key={k} className="flex items-center justify-between gap-4 px-3 py-2 text-sm">
                    <dt>{what}</dt>
                    <dd>
                      <kbd className="whitespace-pre rounded border border-edge bg-sunken px-1.5 py-0.5 font-mono text-xs">
                        {k}
                      </kbd>
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </DialogBody>
      </DialogContent>
    </Dialog>
  )
}
