import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { useReducedMotion } from "motion/react"

import { cn } from "@/lib/cn"

/**
 * Text that fades in word by word as it arrives. Words already on screen never
 * re-animate: only the suffix beyond what was rendered last time gets the
 * `stream-word` class. If the text is replaced rather than appended, all of it
 * counts as new. Reduced motion (or `animate={false}`) renders plain text.
 */
export function StreamingText({
  text,
  className,
  animate = true,
  as: Tag = "span",
}: {
  text: string
  className?: string
  animate?: boolean
  as?: "span" | "p" | "div"
}) {
  const reduce = useReducedMotion()
  const prev = useRef("")
  let stable = text.startsWith(prev.current) ? prev.current.length : 0
  // Back up to a word boundary so a half-arrived word re-renders whole.
  while (stable > 0 && !/\s/.test(text[stable - 1] ?? "")) stable--
  useEffect(() => {
    prev.current = text
  }, [text])

  if (reduce || !animate) return <Tag className={className}>{text}</Tag>
  const head = text.slice(0, stable)
  const words = text.slice(stable).split(/(\s+)/).filter(Boolean)
  let w = 0
  return (
    <Tag className={className}>
      {head}
      {words.map((part, i) => {
        if (/^\s+$/.test(part)) return part
        const n = w++
        return (
          <span key={`${stable}-${i}`} className="stream-word" style={{ animationDelay: `${Math.min(n, 30) * 16}ms` }}>
            {part}
          </span>
        )
      })}
    </Tag>
  )
}

/**
 * Reveals a finished string as if it were streaming, for endpoints that return
 * whole results. Reduced motion returns it at once.
 */
export function useTypewriter(full: string, wordsPerTick = 3, tickMs = 45): string {
  const reduce = useReducedMotion()
  const [state, setState] = useState({ full, n: 0 })
  const n = state.full === full ? state.n : 0
  const parts = full.split(/(\s+)/)
  useEffect(() => {
    if (reduce || n >= parts.length) return
    const t = setTimeout(() => setState({ full, n: n + wordsPerTick * 2 }), tickMs)
    return () => clearTimeout(t)
  }, [full, n, parts.length, reduce, wordsPerTick, tickMs])
  return reduce ? full : parts.slice(0, n).join("")
}

/** Claude-style waiting state: three pulsing dots and a soft shimmer over the label. */
export function ThinkingIndicator({ label = "Thinking", className }: { label?: string; className?: string }) {
  return (
    <span role="status" className={cn("inline-flex items-center gap-2 text-sm text-fg-muted", className)}>
      <span className="thinking-dots" aria-hidden>
        <i />
        <i />
        <i />
      </span>
      <span className="thinking-shimmer">{label}…</span>
    </span>
  )
}

/**
 * Keeps a scroll container pinned to the bottom while `dep` changes, unless
 * the user has scrolled up more than `slack` px. Attach the ref to the
 * scrolling element.
 */
export function useStickToBottom<T extends HTMLElement>(dep: unknown, slack = 48) {
  const ref = useRef<T>(null)
  const pinned = useRef(true)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const onScroll = () => {
      pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight <= slack
    }
    el.addEventListener("scroll", onScroll, { passive: true })
    return () => el.removeEventListener("scroll", onScroll)
  }, [slack])
  useLayoutEffect(() => {
    const el = ref.current
    if (el && pinned.current) el.scrollTop = el.scrollHeight
  }, [dep])
  return ref
}
