import { useAuth } from "@/app/auth"
import { HOME_DATA, homeTrack } from "@/app/home-data"
import { useApi } from "@/lib/query"
import { Answer } from "@/ui/answer"
import { PageHeader } from "@/ui/page-header"
import { DepartmentsToCallAbout, yearFigure } from "@/pages/home-principal"
import { YourPapers } from "@/pages/home-staff"
import { HomeTrack } from "@/pages/home-track"
import { n, type Brief } from "@/pages/principal-parts"
import { Top5Board } from "@/pages/top5-board"
import type { TrackPayload } from "@/pages/track-data"

/**
 * The Vice principal's Home.
 *
 * The Principal's Home with the desk taken out. They see the same year, the
 * same Top 5 board (incentive paid included), the same departments and the
 * same line of where every claim is, and nothing on it approves, sends back
 * or pays: there is no queue here and no button that changes a claim. Their
 * own papers are last, as on every officer's Home.
 */
export function VicePrincipalHome() {
  const { me } = useAuth()
  const brief = useApi<Brief>(HOME_DATA.principalBrief.key, HOME_DATA.principalBrief.path)
  const mine = homeTrack(me?.role)
  const track = useApi<TrackPayload>(mine.key, mine.path)

  const b = brief.data
  const year = b ? yearFigure(b) : null
  const moving = track.data?.total ?? null
  const late = track.data ? track.data.stages.reduce((sum, s) => sum + (s.ageing?.older ?? 0), 0) : null

  return (
    <div className="page space-y-8">
      <PageHeader title="Home" sub="How the college's research is doing and where every claim is." />

      <Answer
        items={[
          {
            value: year ? year.value : brief.isError ? "Not available" : null,
            label: year ? year.label : "the year",
            to: b ? `/reports/papers?year=${b.year}` : "/reports/brief",
            tone: year ? year.tone : "neutral",
          },
          {
            value: moving,
            label: "claims on their way",
            zero: "No claim is on its way",
            to: "/track",
          },
          {
            value: late,
            label: "in one place for over a month",
            zero: "Nothing has waited over a month",
            to: "/track",
            tone: late ? "caution" : "neutral",
          },
          {
            value: b ? n(b.push.length) : brief.isError ? "Not available" : null,
            label: "departments to call about",
            zero: "No department is behind",
            to: "/reports/departments",
            tone: b && b.push.length > 0 ? "caution" : "neutral",
          },
        ]}
      />

      <Top5Board />

      <HomeTrack />

      <DepartmentsToCallAbout brief={brief} />

      <YourPapers />
    </div>
  )
}
