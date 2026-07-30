"use client"

import { useCallback, useEffect, useState } from "react"
import { Bell } from "lucide-react"
import { api } from "@/lib/api"
import { Button } from "@/components/ui/button"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import { cn } from "@/lib/utils"

type Note = {
  id: string
  title: string
  body?: string | null
  href?: string | null
  read: boolean
  created_at: string
}

export function NotificationBell({ className }: { className?: string }) {
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState<Note[]>([])

  const load = useCallback(async () => {
    try {
      setItems(await api<Note[]>("/api/notifications"))
    } catch {
      /* ignore when logged out */
    }
  }, [])

  useEffect(() => {
    load()
    const t = setInterval(load, 45000)
    return () => clearInterval(t)
  }, [load])

  const unread = items.filter((n) => !n.read).length

  async function markAll() {
    await api("/api/notifications/read-all", { method: "POST", json: {} })
    await load()
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className={cn(
            "relative text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
            className
          )}
          aria-label="Notifications"
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
                  <a
                    href={n.href || "#"}
                    className={cn(
                      "block px-4 py-3 transition-colors hover:bg-accent/60 active:bg-accent",
                      !n.read && "bg-accent/40"
                    )}
                    onClick={() => setOpen(false)}
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
                  </a>
                </li>
              ))}
            </ul>
          )}
        </ScrollArea>
      </PopoverContent>
    </Popover>
  )
}
