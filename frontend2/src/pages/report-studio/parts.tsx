import { useId } from "react"

import { cn } from "@/lib/cn"

/**
 * The few small things every step of the designer shares.
 *
 * A "block" is one question the person is answering ("Only where", "Group
 * by"): a plain heading, one sentence of what it does, then the controls. It
 * is a named group so a screen reader announces the question before each
 * control inside it, and it carries no box of its own: the blocks are
 * separated by one hairline, as the rest of the app is.
 */
export function Block({
  title,
  hint,
  children,
  className,
}: {
  title: string
  hint?: string
  children: React.ReactNode
  className?: string
}) {
  const id = useId()
  return (
    <div
      role="group"
      aria-labelledby={id}
      className={cn("min-w-0 space-y-3 border-t border-line pt-5 first:border-t-0 first:pt-0", className)}
    >
      <div>
        <h3 id={id} className="text-base font-semibold text-fg">
          {title}
        </h3>
        {hint && <p className="pt-1 text-sm text-fg-muted">{hint}</p>}
      </div>
      <div className="space-y-3">{children}</div>
    </div>
  )
}

/** A number in a circle, so the three steps read in order. */
export function StepNumber({ n }: { n: number }) {
  return (
    <span
      aria-hidden
      className="inline-grid size-8 shrink-0 place-items-center rounded-full bg-accent text-base font-semibold text-accent-fg"
    >
      {n}
    </span>
  )
}

/** The heading of one of the three steps. */
export function StepHeading({ n, title, id, sub }: { n: number; title: string; id: string; sub?: string }) {
  return (
    <div className="flex items-start gap-3">
      <StepNumber n={n} />
      <div className="min-w-0">
        <h2 id={id} className="text-xl font-semibold leading-8 text-fg">
          {title}
        </h2>
        {sub && <p className="text-sm text-fg-muted">{sub}</p>}
      </div>
    </div>
  )
}
