import { clsx, type ClassValue } from "clsx"
import { extendTailwindMerge } from "tailwind-merge"

// Our own type sizes (styles.css @theme). Without this, tailwind-merge takes
// `text-display` for a colour, sees `text-fg` later, and drops the size --
// which shrank every page title to 14px.
const twMerge = extendTailwindMerge({
  extend: { classGroups: { "font-size": [{ text: ["display", "figure", "figure-xl", "honour"] }] } },
})

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
