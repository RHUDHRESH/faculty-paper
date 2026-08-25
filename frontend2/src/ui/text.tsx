import { cn } from "@/lib/cn"

/**
 * The type scale, as components, so a heading cannot be a div with a size on
 * it that some other screen writes slightly differently.
 *
 * There is no all-caps letterspaced eyebrow here. Six shouted grey labels
 * down a page is not hierarchy — it is noise at one volume, which is what
 * the old app's every section header was.
 */

export function PageTitle({ children, className }: React.ComponentProps<"h1">) {
  return <h1 className={cn("text-xl font-semibold", className)}>{children}</h1>
}

export function SectionTitle({ children, className }: React.ComponentProps<"h2">) {
  return <h2 className={cn("text-base font-semibold", className)}>{children}</h2>
}

/** Secondary line under a title. Never a second sentence of instructions. */
export function Sub({ children, className }: React.ComponentProps<"p">) {
  return <p className={cn("text-base text-fg-muted", className)}>{children}</p>
}

/** Metadata beside content — dates, counts, departments. */
export function Meta({ children, className }: React.ComponentProps<"span">) {
  return <span className={cn("text-sm text-fg-muted", className)}>{children}</span>
}

/** A machine category: a column head, a field name in a grid. The only place
 *  uppercase is used, because here it genuinely is a label and not a phrase. */
export function ColumnLabel({ children, className }: React.ComponentProps<"span">) {
  return (
    <span
      className={cn(
        "text-xs font-medium uppercase tracking-[0.04em] text-fg-subtle",
        className
      )}
    >
      {children}
    </span>
  )
}
