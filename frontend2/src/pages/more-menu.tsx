import { MoreHorizontal } from "lucide-react"
import { useNavigate } from "react-router-dom"

import { Button } from "@/ui/button"
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/ui/menu"

/**
 * One "More" button for the rare or destructive actions of an admin page.
 *
 * Without it a page ends up with a row of five equal buttons, and an older
 * reader cannot tell the one they came for from the one that deletes things.
 * An item with `to` goes to that page; one with `onSelect` runs it. A
 * destructive item is red and sits after a divider.
 */
export type MoreItem = {
  label: string
  onSelect?: () => void
  to?: string
  danger?: boolean
  disabled?: boolean
}

export function MoreMenu({
  items,
  label = "More",
  kind = "default",
}: {
  items: (MoreItem | false | null | undefined)[]
  label?: string
  kind?: "default" | "quiet"
}) {
  const nav = useNavigate()
  const shown = items.filter((i): i is MoreItem => !!i)
  if (shown.length === 0) return null
  const safe = shown.filter((i) => !i.danger)
  const risky = shown.filter((i) => i.danger)
  const item = (i: MoreItem) => (
    <MenuItem
      key={i.label}
      danger={i.danger}
      disabled={i.disabled}
      onSelect={() => {
        if (i.to) nav(i.to)
        else i.onSelect?.()
      }}
    >
      {i.label}
    </MenuItem>
  )
  return (
    <Menu>
      <MenuTrigger asChild>
        <Button kind={kind}>
          <MoreHorizontal aria-hidden />
          {label}
        </Button>
      </MenuTrigger>
      <MenuContent align="end">
        {safe.map(item)}
        {safe.length > 0 && risky.length > 0 && <MenuSeparator />}
        {risky.map(item)}
      </MenuContent>
    </Menu>
  )
}
