import { useCallback, useEffect, useRef, useState } from "react"

import { cn } from "@/lib/cn"

/**
 * A pane width the reviewer sets by dragging, remembered between claims and
 * visits. A workspace whose panes reset on every claim would have the
 * reviewer re-drag them forty times a day.
 */
export function useStoredWidth(key: string, initial: number, min: number, max: number) {
  const storageKey = `review.pane.${key}`
  const [width, setWidth] = useState(() => {
    const saved = Number(localStorage.getItem(storageKey))
    return Number.isFinite(saved) && saved >= min && saved <= max ? saved : initial
  })
  const set = useCallback(
    (next: number) => {
      // NaN is "put it back", which is what a double-click on the strip asks.
      if (Number.isNaN(next)) {
        setWidth(initial)
        localStorage.removeItem(storageKey)
        return
      }
      const clamped = Math.round(Math.min(max, Math.max(min, next)))
      setWidth(clamped)
      localStorage.setItem(storageKey, String(clamped))
    },
    [initial, max, min, storageKey]
  )
  return [width, set] as const
}

/**
 * The strip between two panes. Drag it, or focus it and use the arrow keys,
 * so the layout is reachable without a mouse. `edge` says which side of the
 * strip the pane it resizes is on: dragging right grows a pane on the left
 * and shrinks one on the right.
 */
export function ResizeHandle({
  edge,
  width,
  min,
  max,
  onChange,
  label,
}: {
  edge: "left" | "right"
  width: number
  min: number
  max: number
  onChange: (width: number) => void
  label: string
}) {
  const start = useRef<{ x: number; w: number } | null>(null)
  const [dragging, setDragging] = useState(false)

  useEffect(() => {
    if (!dragging) return
    // Text under the pointer must not be selected while a pane is dragged,
    // and the PDF canvas must not swallow the pointer once it crosses over.
    const prev = document.body.style.userSelect
    document.body.style.userSelect = "none"
    document.body.style.cursor = "col-resize"
    return () => {
      document.body.style.userSelect = prev
      document.body.style.cursor = ""
    }
  }, [dragging])

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={width}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      onPointerDown={(e) => {
        start.current = { x: e.clientX, w: width }
        e.currentTarget.setPointerCapture(e.pointerId)
        setDragging(true)
      }}
      onPointerMove={(e) => {
        const s = start.current
        if (!s) return
        const dx = e.clientX - s.x
        onChange(edge === "left" ? s.w + dx : s.w - dx)
      }}
      onPointerUp={() => {
        start.current = null
        setDragging(false)
      }}
      onPointerCancel={() => {
        start.current = null
        setDragging(false)
      }}
      onDoubleClick={() => onChange(NaN)}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 64 : 16
        const grow = edge === "left" ? "ArrowRight" : "ArrowLeft"
        const shrink = edge === "left" ? "ArrowLeft" : "ArrowRight"
        if (e.key === grow) {
          e.preventDefault()
          onChange(width + step)
        } else if (e.key === shrink) {
          e.preventDefault()
          onChange(width - step)
        }
      }}
      className={cn(
        "group relative hidden w-1.5 shrink-0 cursor-col-resize touch-none lg:block",
        "focus-visible:outline-none"
      )}
    >
      <span
        aria-hidden
        className={cn(
          "absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-line transition-colors",
          "group-hover:w-0.5 group-hover:bg-accent group-focus-visible:w-0.5 group-focus-visible:bg-accent",
          dragging && "w-0.5 bg-accent"
        )}
      />
    </div>
  )
}
