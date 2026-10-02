import { useInstitution } from "@/app/institution"
import { cn } from "@/lib/cn"

/**
 * A sheet: the Principal's reports are documents, so they are set like one.
 *
 * Warm paper under it, a surface-coloured page on it with a hairline and the
 * panel radius, a masthead (the college's emblem and name, what the document
 * is, the year and the day it was prepared) over a rule, then a text column no
 * wider than a reader's measure. On paper it loses the frame and keeps the
 * type, so the screen and the printed council pack read as the same thing
 * (docs/ux/27, concept A).
 */
export function Sheet({
  title,
  scope,
  children,
  className,
}: {
  /** What the document is ("Research publications and incentive spend"). */
  title: string
  /** The right-hand line of the masthead ("Calendar year 2025 · FY 2025-26"). */
  scope: string
  children: React.ReactNode
  className?: string
}) {
  const { college_name } = useInstitution()
  const prepared = new Date().toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" })
  return (
    <article
      className={cn(
        "rounded-panel bg-surface px-5 py-8 ring-1 ring-edge sm:px-12 sm:py-12",
        "print:rounded-none print:px-0 print:py-0 print:ring-0",
        className
      )}
    >
      <header className="flex flex-wrap items-end justify-between gap-x-8 gap-y-3 border-b border-fg pb-4">
        <div className="flex items-center gap-3">
          <img src="/brand/emblem-192.png" alt="" width={40} height={40} className="size-10 shrink-0 object-contain" />
          <div>
            <p className="text-base font-semibold leading-tight">{college_name || "Saveetha Engineering College"}</p>
            <p className="text-sm text-fg-muted">{title}</p>
          </div>
        </div>
        <div className="text-right text-sm text-fg-muted">
          <p className="text-fg">{scope}</p>
          <p>Prepared {prepared}</p>
        </div>
      </header>
      <div className="mt-10 space-y-12">{children}</div>
    </article>
  )
}

/** A part of a document: a title in the interface face, then its content. No box, no number. */
export function Part({
  title,
  note,
  children,
  className,
  ...rest
}: {
  title: string
  /** One short line, only if the part cannot be read without it. */
  note?: React.ReactNode
  children: React.ReactNode
  className?: string
} & Omit<React.ComponentProps<"section">, "title">) {
  return (
    <section className={cn("min-w-0 break-inside-avoid", className)} {...rest}>
      <h2 className="mb-3 text-lg font-semibold">{title}</h2>
      {note && <p className="-mt-2 mb-3 max-w-prose text-sm text-fg-muted">{note}</p>}
      {children}
    </section>
  )
}
