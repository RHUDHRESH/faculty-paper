import { cn } from "@/lib/cn"
import { Illustration, type IllustrationName } from "@/ui/illustration"

/**
 * A mounted print (DESIGN.md, "The Mount Rule").
 *
 * The 213 drawings in `public/illustrations/generated` are the art of this
 * product, and a drawing on bare paper at 96px reads as a sticker. Mounted,
 * it reads as a plate in a bound volume: a sand-coloured margin, a hairline,
 * the panel radius, and (when it is big enough to be looked at) a caption
 * line beneath it, on the page, as a caption sits under a print. The mount
 * stays light in dark mode, so the cream fills inside a drawing look intended.
 *
 *   `width`    the drawing's own width in px; the mount adds 12px a side.
 *   `caption`  one short line, in the page's own voice ("A desk, as it should
 *              be."). Required once a plate is 240px or more; optional in a
 *              page header, where a caption on every page would be noise.
 *
 * Placement rules (DESIGN.md, "Illustration and photographs"): one plate per
 * view; 128 to 160px in a page header on a Home view; 240 to 360px in an empty
 * state; never in a table, never on a card, never two in one viewport, never
 * under 96px. Choose the drawing for the role or the situation, never one
 * drawing for two roles.
 */
export function Plate({
  name,
  width = 160,
  caption,
  alt,
  className,
  eager = false,
}: {
  name: IllustrationName
  width?: number
  caption?: React.ReactNode
  /** Decorative by default (the heading beside it carries the meaning). */
  alt?: string
  className?: string
  eager?: boolean
}) {
  return (
    <figure className={cn("m-0 inline-block max-w-full shrink-0", className)} style={{ width: width + 24 }}>
      <div className="plate p-3">
        <Illustration name={name} width={width} alt={alt} plate={false} eager={eager} className="mx-auto block" />
      </div>
      {caption && <figcaption className="mt-2 text-balance text-center text-xs text-fg-muted">{caption}</figcaption>}
    </figure>
  )
}
