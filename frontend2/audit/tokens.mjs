/**
 * `bg-[--color-accent]` is not valid Tailwind v4. It emits
 * `background-color:--color-accent` — not a value — so the browser drops the
 * declaration and the colour silently does nothing. It looks right in the
 * source and is invisible in review, which is how it reached every file in
 * this app at once. So it is checked mechanically instead.
 */
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"

const walk = (dir) =>
  readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    return statSync(p).isDirectory() ? walk(p) : p.endsWith(".tsx") || p.endsWith(".ts") ? [p] : []
  })

const bad = []
for (const file of walk("src")) {
  readFileSync(file, "utf8").split("\n").forEach((line, i) => {
    for (const m of line.matchAll(/[\w-]+-\[--[a-z0-9-]+\]/g)) {
      bad.push(`${file}:${i + 1}  ${m[0]}`)
    }
  })
}

if (bad.length) {
  console.error(`${bad.length} dead token reference(s) — these emit invalid CSS and do nothing:\n`)
  bad.forEach((b) => console.error("  " + b))
  console.error("\nTokens live in @theme, so Tailwind generates real utilities: bg-accent, text-fg-muted,")
  console.error("border-line, rounded-md, shadow-pop, ease-out. Only --dur-* needs duration-[var(--dur-1)].")
  process.exit(1)
}
console.log("tokens: all references resolve")
