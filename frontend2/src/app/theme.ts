import { useEffect, useState } from "react"

/**
 * Light, dark, or whatever the system says.
 *
 * The choice is a per-device convenience, so it lives in localStorage; every
 * read and write is guarded because storage can be blocked. index.html runs
 * the same resolution before first paint so a dark page never flashes white.
 */
export type ThemeChoice = "light" | "dark" | "system"

const KEY = "theme"

function stored(): ThemeChoice {
  try {
    const v = localStorage.getItem(KEY)
    return v === "light" || v === "dark" ? v : "system"
  } catch {
    return "system"
  }
}

function apply(choice: ThemeChoice) {
  const dark =
    choice === "dark" ||
    (choice === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches)
  document.documentElement.dataset.theme = dark ? "dark" : "light"
}

export function useTheme() {
  const [choice, setChoice] = useState<ThemeChoice>(stored)

  useEffect(() => {
    apply(choice)
    try {
      if (choice === "system") localStorage.removeItem(KEY)
      else localStorage.setItem(KEY, choice)
    } catch {
      /* the choice still holds for this visit */
    }
    if (choice !== "system") return
    const media = window.matchMedia("(prefers-color-scheme: dark)")
    const follow = () => apply("system")
    media.addEventListener("change", follow)
    return () => media.removeEventListener("change", follow)
  }, [choice])

  return [choice, setChoice] as const
}
