import type { IllustrationName } from "@/ui/illustration"

/** Decorative mounted print: the minimalist skin renders nothing. Kept so imports compile. */
export function Plate(_props: {
  name: IllustrationName
  width?: number
  caption?: React.ReactNode
  alt?: string
  className?: string
  eager?: boolean
}) {
  return null
}
