import { useEffect, useState } from "react"

/**
 * Light / dark / follow-the-system, applied by toggling `.dark` on <html>.
 *
 * index.css already carried a complete `.dark` palette and nothing ever put the
 * class on, so the theme was unreachable. "system" is the default because most
 * people have already told their OS which they want.
 */
export type Theme = "light" | "dark" | "system"

const STORAGE_KEY = "pubtickets-theme"
const media = () => window.matchMedia("(prefers-color-scheme: dark)")

export function resolveTheme(theme: Theme): "light" | "dark" {
  if (theme !== "system") return theme
  return media().matches ? "dark" : "light"
}

export function applyTheme(theme: Theme): void {
  document.documentElement.classList.toggle("dark", resolveTheme(theme) === "dark")
}

export function readStoredTheme(): Theme {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw === "light" || raw === "dark" || raw === "system") return raw
  } catch {
    /* private browsing */
  }
  return "system"
}

export function useTheme(): { theme: Theme; setTheme: (next: Theme) => void } {
  const [theme, setThemeState] = useState<Theme>(readStoredTheme)

  useEffect(() => {
    applyTheme(theme)
    if (theme !== "system") return
    // Following the system means following it as it changes, not only at load.
    const mq = media()
    const onChange = () => applyTheme("system")
    mq.addEventListener("change", onChange)
    return () => mq.removeEventListener("change", onChange)
  }, [theme])

  return {
    theme,
    setTheme: (next) => {
      try {
        localStorage.setItem(STORAGE_KEY, next)
      } catch {
        /* private browsing */
      }
      setThemeState(next)
    },
  }
}
