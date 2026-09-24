import { Dialog, DialogBody, DialogContent, DialogHeader, DialogTitle } from "@/ui/dialog"
import type { ShortcutGroup } from "@/app/shortcuts"

/**
 * The list itself. Its own module so the dialog -- and the animation library
 * the dialog moves with -- is fetched when somebody presses `?`, not with the
 * first screen everybody waits for.
 */
export function ShortcutsDialog({
  open,
  onOpenChange,
  groups,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  groups: ShortcutGroup[]
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
        </DialogHeader>
        <DialogBody className="space-y-5">
          {groups.map((g) => (
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
