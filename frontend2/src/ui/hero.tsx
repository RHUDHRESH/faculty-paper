import { useEffect, useState } from "react"
import { Link } from "react-router-dom"

import { cn } from "@/lib/cn"
import type { Area } from "@/ui/chip"

/** Whether the reader asked the system to stop moving things. */
function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
}

/**
 * Counts from 0 to `value` over 700ms, once per session per `key`
 * (docs/ux/00 §5). Returns the value unchanged under reduced motion, on a
 * repeat view, or when the value is not yet known.
 */
export function useCountUp(value: number | null | undefined, key: string): number | null {
  const [shown, setShown] = useState<number | null>(value ?? null)
  useEffect(() => {
    if (value == null) {
      setShown(null)
      return
    }
    const flag = `countup:${key}`
    let seen = false
    try {
      seen = sessionStorage.getItem(flag) === "1"
      sessionStorage.setItem(flag, "1")
    } catch {
      seen = true
    }
    if (seen || prefersReducedMotion() || value === 0 || typeof requestAnimationFrame === "undefined") {
      setShown(value)
      return
    }
    const start = performance.now()
    let raf = 0
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / 700)
      setShown(Math.round(value * (1 - Math.pow(1 - t, 3))))
      if (t < 1) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [value, key])
  return shown
}

export type HeroFigureProps = {
  /** null while loading: shows an em dash, never 0. */
  value: number | null | undefined
  label: React.ReactNode
  /** Rendered before the number, e.g. "#" for a rank. */
  prefix?: string
  /** A link target — every hero figure deep-links somewhere. */
  to?: string
  /** Text equivalent for assistive tech; defaults to "value label". */
  srLabel?: string
  /** A small line under the label (a delta, a caution chip). */
  note?: React.ReactNode
  size?: "xl" | "md"
  countKey?: string
}

/** One figure in a hero: big tabular number, label, optional link. */
export function HeroFigure({ value, label, prefix, to, srLabel, note, size = "xl", countKey }: HeroFigureProps) {
  const shown = useCountUp(value, countKey ?? String(label))
  const text = shown == null ? "—" : `${prefix ?? ""}${shown.toLocaleString("en-IN")}`
  const body = (
    <>
      <span
        aria-hidden
        className={cn("figure block", size === "xl" ? "text-figure-xl" : "text-figure")}
      >
        {text}
      </span>
      <span aria-hidden className="mt-1 block text-sm opacity-80">
        {label}
      </span>
      <span className="sr-only">
        {srLabel ?? (value == null ? `${String(label)}: loading` : `${prefix ?? ""}${value} ${String(label)}`)}
      </span>
      {note && <span className="mt-1 block text-xs">{note}</span>}
    </>
  )
  return to ? (
    <Link to={to} className="block min-w-0 rounded-lg hover:underline hover:decoration-1 hover:underline-offset-4">
      {body}
    </Link>
  ) : (
    <div className="min-w-0">{body}</div>
  )
}

/**
 * Every page opens with this (docs/ux/00 §8). A tinted band in the page's
 * area colour that answers the page's question in one number or sentence,
 * with the college emblem as a faint watermark and a 3px area rule on top.
 *
 * `variant="solid"` — navy field, white type, gold ribbon — is for Home and
 * Landing only.
 */
export function HeroBand({
  area = "record",
  variant = "wash",
  eyebrow,
  title,
  titleClassName,
  figure,
  figures,
  sentence,
  actions,
  aside,
  children,
  className,
}: {
  area?: Area
  variant?: "wash" | "solid"
  eyebrow?: React.ReactNode
  title: React.ReactNode
  titleClassName?: string
  /** The one number that answers the page. */
  figure?: HeroFigureProps
  /** Several figures in a row (Home). */
  figures?: HeroFigureProps[]
  sentence?: React.ReactNode
  actions?: React.ReactNode
  aside?: React.ReactNode
  children?: React.ReactNode
  className?: string
}) {
  const solid = variant === "solid"
  return (
    <section
      data-area={area}
      data-variant={variant}
      className={cn(
        "relative isolate overflow-hidden rounded-2xl",
        solid
          ? "bg-brand text-brand-fg"
          : "hero-wash text-fg shadow-[inset_0_0_0_1px_var(--area-line)]",
        className
      )}
    >
      <div aria-hidden className={cn("absolute inset-x-0 top-0 h-[3px]", solid ? "ribbon" : "bg-(--area-fill)")} />
      <img
        src="/brand/emblem-192.png"
        alt=""
        aria-hidden
        draggable={false}
        className="pointer-events-none absolute -right-8 -bottom-10 -z-10 size-56 opacity-5 select-none"
      />
      <div className="flex flex-col gap-6 p-6 sm:p-8 lg:flex-row lg:items-start">
        <div className="min-w-0 flex-1">
          {eyebrow && (
            <p className={cn("text-sm font-medium", solid ? "text-brand-fg/80" : "text-(--area)")}>{eyebrow}</p>
          )}
          <div className="mt-1 flex flex-wrap items-start justify-between gap-4">
            <h1 className={cn("display text-display min-w-0", titleClassName)}>{title}</h1>
            {actions && <div className="flex shrink-0 flex-wrap gap-2">{actions}</div>}
          </div>
          {sentence && (
            <p className={cn("mt-2 max-w-prose text-base", solid ? "text-brand-fg/85" : "text-fg-muted")}>
              {sentence}
            </p>
          )}
          {figure && (
            <div className={cn("mt-6", solid ? "" : "text-(--area)")}>
              <HeroFigure {...figure} />
            </div>
          )}
          {figures && figures.length > 0 && (
            <div className="mt-6 grid grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-4">
              {figures.map((f, i) => (
                <HeroFigure key={i} {...f} size={f.size ?? "md"} />
              ))}
            </div>
          )}
          {children}
        </div>
        {aside && <div className="shrink-0">{aside}</div>}
      </div>
    </section>
  )
}
