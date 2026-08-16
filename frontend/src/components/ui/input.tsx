import * as React from "react"

import { cn } from "@/lib/utils"

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        // --input is a 3:1 outline colour (see index.css). Filling the field
        // with it turned every input into a grey slab with no visible edge; it
        // belongs on the border, over a normal field surface.
        // Taller than the stock 32px: these are typed into all day. Matches
        // the button radius so a field and the button beside it agree.
        "h-9 w-full min-w-0 rounded-[calc(var(--radius)*0.7)] border border-input bg-card px-3 py-1 text-base transition-[color,border-color,box-shadow] duration-[120ms] ease-[var(--ease-out-soft)] outline-none file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground/70 hover:border-[color-mix(in_oklch,var(--input),var(--foreground)_14%)] focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-sm dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40",
        className
      )}
      {...props}
    />
  )
}

export { Input }
