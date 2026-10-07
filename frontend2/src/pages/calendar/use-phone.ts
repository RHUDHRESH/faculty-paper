import { useEffect, useState } from "react"

/**
 * Whether the screen is a phone's. The calendar opens on the agenda there and
 * the event sheet comes up from the bottom, where a thumb is: a month grid
 * seven columns wide is dots, and a sheet from the right on a 390px screen
 * covers the page it is supposed to sit beside.
 */
export function usePhone(): boolean {
  const query = "(max-width: 47.99rem)"
  const [phone, setPhone] = useState(() => window.matchMedia(query).matches)
  useEffect(() => {
    const m = window.matchMedia(query)
    const on = () => setPhone(m.matches)
    m.addEventListener?.("change", on)
    return () => m.removeEventListener?.("change", on)
  }, [])
  return phone
}
