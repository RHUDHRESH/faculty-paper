import { Link } from "react-router-dom"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { ArrowLeft, BarChart3, Lock } from "lucide-react"

import { api, ApiError } from "@/lib/api"
import { useApi } from "@/lib/query"
import { REACTIONS } from "@/pages/reactions"
import { Button } from "@/ui/button"
import { Trend } from "@/ui/chart"
import { Switch } from "@/ui/field"
import { EmptyState, ErrorState, SkeletonRows } from "@/ui/state"
import { Figure, Meta, PageTitle, SectionTitle, Sub } from "@/ui/text"
import { toast } from "@/ui/toast"
import { Ago } from "@/ui/when"

/**
 * Your own numbers (`/u/me/stats`): followers, profile views, how far your
 * posts reach and how many people engage with them.
 *
 * Yours alone. The server has no way to ask for anybody else's
 * (`/api/people/me/stats` only), a profile carries a summary only to its
 * owner, and who visited is never shown -- only how many. The switches at
 * the bottom turn off each kind of social notification, and stop your own
 * visits being counted in anybody else's numbers.
 */

type Stats = {
  days: number
  followers: number
  following: number
  new_followers_30d: number
  profile_views_30d: number
  profile_visits_30d: number
  views_by_day: { day: string; count: number }[]
  posts: {
    count: number
    count_30d: number
    reach: number
    reach_30d: number
    reactions: number
    reactions_by_kind: Record<string, number>
    comments: number
    engagement_rate: number | null
  }
  top_posts: {
    id: string
    excerpt: string
    created_at: string
    visibility: "EVERYONE" | "DEPARTMENT"
    reach: number
    reactions: number
    comments: number
    engaged: number
    engagement_rate: number | null
  }[]
  privacy: string
}

export type StatsSummary = {
  followers: number
  following: number
  profile_views_30d: number
  reach_30d: number
  engagement_rate: number | null
}

function percent(rate: number | null | undefined): string {
  return rate == null ? "—" : `${Math.round(rate * 100)}%`
}

function dayLabel(iso: string): string {
  return new Date(`${iso}T00:00:00`).toLocaleDateString("en-IN", { day: "numeric", month: "short" })
}

export function MyStats() {
  const query = useApi<Stats>(["my-stats"], "/api/people/me/stats")

  return (
    <div className="page max-w-3xl space-y-10">
      <div className="space-y-3">
        <Button kind="quiet" size="sm" asChild className="-ml-2">
          <Link to="/u/me">
            <ArrowLeft />
            Your profile
          </Link>
        </Button>
        <header>
          <PageTitle>Your stats</PageTitle>
          <Sub className="mt-1 flex items-center gap-1.5">
            <Lock className="size-3.5 shrink-0" aria-hidden />
            {query.data?.privacy ?? "Only you see these numbers."}
          </Sub>
        </header>
      </div>

      {query.isPending ? (
        <SkeletonRows rows={5} rowHeight={72} />
      ) : query.isError ? (
        <ErrorState
          title="Could not load your stats"
          message="The server did not answer. Nothing has been lost."
          onRetry={() => void query.refetch()}
        />
      ) : (
        <StatsBody stats={query.data} />
      )}

      <SocialSettingsPanel />
    </div>
  )
}

function Tile({ label, value, note }: { label: string; value: string | number; note?: string }) {
  return (
    <div className="space-y-0.5">
      <Figure className="block text-3xl">{value}</Figure>
      <Meta className="block text-sm">{label}</Meta>
      {note && <Meta className="block text-xs">{note}</Meta>}
    </div>
  )
}

function StatsBody({ stats }: { stats: Stats }) {
  const p = stats.posts
  return (
    <>
      <section aria-label="In the last 30 days" className="panel-lead grid grid-cols-2 gap-6 px-4 py-5 sm:grid-cols-3">
        <Tile
          label="followers"
          value={stats.followers}
          note={stats.new_followers_30d ? `${stats.new_followers_30d} new in ${stats.days} days` : undefined}
        />
        <Tile label="following" value={stats.following} />
        <Tile label={`people viewed your profile (${stats.days} days)`} value={stats.profile_views_30d} />
        <Tile label={`people reached by your posts (${stats.days} days)`} value={p.reach_30d} />
        <Tile label="of the people reached reacted or commented" value={percent(p.engagement_rate)} />
        <Tile label={p.count === 1 ? "post" : "posts"} value={p.count} note={p.count_30d ? `${p.count_30d} in ${stats.days} days` : undefined} />
      </section>

      <Trend
        title="Profile views"
        caption={`People who opened your profile each day, over the last ${stats.days} days. Each person counts once a day.`}
        dimension="day"
        points={stats.views_by_day.map((d) => ({ key: d.day, label: dayLabel(d.day), count: d.count }))}
        height={160}
      />

      <section className="space-y-3">
        <SectionTitle>How people reacted</SectionTitle>
        {p.reactions + p.comments === 0 ? (
          <Meta className="block">No reactions or comments yet.</Meta>
        ) : (
          <ul className="flex flex-wrap gap-x-6 gap-y-2">
            {REACTIONS.map((r) => (
              <li key={r.kind} className="flex items-baseline gap-2">
                <span aria-hidden>{r.emoji ?? "♥"}</span>
                <span className="tabular font-medium">{p.reactions_by_kind[r.kind] ?? 0}</span>
                <Meta>{r.label.toLowerCase()}</Meta>
              </li>
            ))}
            <li className="flex items-baseline gap-2">
              <span className="tabular font-medium">{p.comments}</span>
              <Meta>comments</Meta>
            </li>
          </ul>
        )}
      </section>

      <section className="space-y-3">
        <SectionTitle>Your top posts</SectionTitle>
        {stats.top_posts.length === 0 ? (
          <EmptyState
            icon={BarChart3}
            title="No posts yet"
            message="Share a paper or a question in Discussions and how far it reaches shows here."
            action={
              <Button kind="primary" size="sm" asChild>
                <Link to="/discussions">Write a post</Link>
              </Button>
            }
          />
        ) : (
          <ol className="divide-y divide-line border-y border-line">
            {stats.top_posts.map((t) => (
              <li key={t.id} className="flex flex-col gap-1 py-3 sm:flex-row sm:items-center sm:gap-4">
                <span className="min-w-0 flex-1">
                  <Link to={`/discussions/p/${t.id}`} className="line-clamp-2 text-sm underline-offset-4 hover:underline">
                    {t.excerpt}
                  </Link>
                  <Meta className="block text-xs">
                    <Ago iso={t.created_at} />
                    {t.visibility === "DEPARTMENT" ? " · your department only" : ""}
                  </Meta>
                </span>
                <span className="grid shrink-0 grid-cols-4 gap-3 text-right text-sm sm:w-80">
                  <Stat label="reached" value={t.reach} />
                  <Stat label="reactions" value={t.reactions} />
                  <Stat label="comments" value={t.comments} />
                  <Stat label="engaged" value={percent(t.engagement_rate)} />
                </span>
              </li>
            ))}
          </ol>
        )}
      </section>
    </>
  )
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <span className="flex flex-col">
      <span className="tabular font-medium">{value}</span>
      <Meta className="text-xs">{label}</Meta>
    </span>
  )
}

/** The small card on your own profile. */
export function StatsCard({ stats }: { stats: StatsSummary }) {
  return (
    <section aria-label="Your stats" className="panel space-y-3 px-4 py-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <SectionTitle className="text-base">Your stats, last 30 days</SectionTitle>
        <Meta className="flex items-center gap-1 text-xs">
          <Lock className="size-3" aria-hidden />
          Only you see this
        </Meta>
      </div>
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Stat label="followers" value={stats.followers} />
        <Stat label="profile views" value={stats.profile_views_30d} />
        <Stat label="reached by posts" value={stats.reach_30d} />
        <Stat label="engaged" value={percent(stats.engagement_rate)} />
      </div>
      <Button kind="default" size="sm" asChild>
        <Link to="/u/me/stats">
          <BarChart3 />
          All your stats and switches
        </Link>
      </Button>
    </section>
  )
}

type Settings = {
  notifications: { kind: string; label: string; on: boolean }[]
  count_my_visits: boolean
}

/** Each kind of social notification, switchable on its own; and whether your visits are counted. */
export function SocialSettingsPanel() {
  const qc = useQueryClient()
  const query = useApi<Settings>(["social-settings"], "/api/people/me/social-settings")
  const save = useMutation<Settings, ApiError, { muted?: string[]; count_my_visits?: boolean }>({
    mutationFn: (body) => api<Settings>("/api/people/me/social-settings", { method: "PUT", json: body }),
    onSuccess: (s) => qc.setQueryData(["social-settings"], s),
    onError: (err) => {
      toast.fail(err)
      void qc.invalidateQueries({ queryKey: ["social-settings"] })
    },
  })

  function flip(kind: string, on: boolean) {
    const s = query.data
    if (!s) return
    const muted = s.notifications.filter((n) => (n.kind === kind ? !on : !n.on)).map((n) => n.kind)
    qc.setQueryData<Settings>(["social-settings"], {
      ...s,
      notifications: s.notifications.map((n) => (n.kind === kind ? { ...n, on } : n)),
    })
    save.mutate({ muted })
  }

  return (
    <section className="space-y-4" aria-labelledby="social-switches">
      <div>
        <SectionTitle id="social-switches">Notifications and privacy</SectionTitle>
        <Meta className="block">
          Each switch takes effect at once. Alerts about your papers, and email for any kind, are in{" "}
          <Link to="/settings/notifications" className="underline underline-offset-2">notification settings</Link>.
        </Meta>
      </div>
      {query.isPending ? (
        <SkeletonRows rows={4} rowHeight={36} />
      ) : query.isError ? (
        <ErrorState
          title="Could not load your switches"
          message="The server did not answer. Your settings have not changed."
          onRetry={() => void query.refetch()}
        />
      ) : (
        <div className="space-y-3">
          {query.data.notifications.map((n) => (
            <Switch key={n.kind} checked={n.on} onCheckedChange={(on) => flip(n.kind, on)} label={n.label} />
          ))}
          <div className="hairline my-2" />
          <Switch
            checked={query.data.count_my_visits}
            onCheckedChange={(on) => {
              qc.setQueryData<Settings>(["social-settings"], { ...query.data, count_my_visits: on })
              save.mutate({ count_my_visits: on })
            }}
            label="Count my visits in colleagues' stats"
            hint="Off: opening a profile or seeing a post is not counted in anybody's numbers. Nobody is ever shown who visited, either way."
          />
        </div>
      )}
    </section>
  )
}
