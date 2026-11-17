import { useLocation, useSearchParams } from "react-router-dom"

import { Designer, type Seed } from "@/pages/report-studio/designer"
import { StudioStart } from "@/pages/report-studio/start"

/**
 * The Report studio, at /reports/studio.
 *
 * One address, three ways in, told apart by the query string so a reload or a
 * bookmark lands where the person was:
 *
 *   (nothing)  the start screen: templates, saved reports, ask in plain words
 *   ?t=<key>   the designer, opened on a template
 *   ?r=<id>    the designer, opened on a saved report
 *   ?new=1     the designer, blank (or filled from a plain-words answer, which
 *              rides along in the router's state)
 *
 * This replaces the old Build a report page, whose address now redirects here.
 */
export function ReportStudio() {
  const [params] = useSearchParams()
  const location = useLocation()
  const savedId = params.get("r")
  const templateKey = params.get("t")
  const fresh = params.get("new")

  if (!savedId && !templateKey && !fresh) return <StudioStart />

  const state = location.state as { seed?: Seed } | null
  return <Designer savedId={savedId} templateKey={templateKey} seed={state?.seed ?? null} />
}
