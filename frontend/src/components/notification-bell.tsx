"use client"

import { useState } from "react"
import { useNavigate } from "react-router-dom"
import { Bell } from "lucide-react"
import {
  markAllNotificationsRead,
  markNotificationRead,
  refreshNotifications,
  useNotifications,
} from "@/lib/use-notifications"
import { Button } from "@/components/ui/button"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import { cn } from "@/lib/utils"

export function NotificationBell({ className }: { className?: string }) {
  const [open, setOpen] = useState(false)
  const navigate = useNavigate()
  // Shared across every bell the shell renders — see lib/use-notifications.
  const { items, unread } = useNotifications()

  async function markAll() {
    await markAllNotificationsRead()
  }

  function openItem(id: string, href?: string | null) {
    markNotificationRead(id)
    setOpen(false)
    // SPA navigation — an <a href> here forced a full page reload and re-auth.
    if (href) navigate(href)
  }

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o)
        // The poll only tracks the unread count; the list itself is fetched
        // when someone actually looks at it.
        if (o) refreshNotifications()
      }}
    >
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className={cn(
            "relative text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
            className
          )}
          aria-label={unread > 0 ? `Notifications, ${unread} unread` : "Notifications"}
        >
          <Bell className="size-4" />
          {unread > 0 ? (
            <span className="absolute right-1.5 top-1.5 size-2 rounded-full bg-amber-400 ring-2 ring-sidebar" />
          ) : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 p-0" side="top">
        <div className="flex items-center justify-between px-4 py-3">
          <span className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
            Notifications
          </span>
          <Button type="button" size="sm" variant="ghost" className="h-8 text-xs" onClick={markAll}>
            Mark read
          </Button>
        </div>
        <Separator />
        <ScrollArea className="h-72">
          {items.length === 0 ? (
            <p className="px-4 py-10 text-center text-sm text-muted-foreground">
              No notifications yet
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {items.map((n) => (
                <li key={n.id}>
                  <button
                    type="button"
                    className={cn(
                      "block w-full px-4 py-3 text-left transition-colors hover:bg-accent/60 active:bg-accent",
                      !n.read && "bg-accent/40"
                    )}
                    onClick={() => openItem(n.id, n.href)}
                  >
                    <div className="text-sm font-medium text-foreground">{n.title}</div>
                    {n.body ? (
                      <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                        {n.body}
                      </p>
                    ) : null}
                    <p className="mt-1.5 text-[10px] text-muted-foreground">
                      {new Date(n.created_at).toLocaleString()}
                    </p>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </ScrollArea>
      </PopoverContent>
    </Popover>
  )
}
