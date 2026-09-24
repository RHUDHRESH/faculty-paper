import { useState } from "react"
import { Download, Link2 } from "lucide-react"

import { useAuth } from "@/app/auth"
import { useApi, useApiMutation } from "@/lib/query"
import { Button } from "@/ui/button"
import { CopyButton } from "@/ui/copy"
import { Switch } from "@/ui/field"
import { InlineError, Skeleton } from "@/ui/state"
import { Meta, PageTitle, SectionTitle, Sub } from "@/ui/text"
import { toast } from "@/ui/toast"

type ShareState = { enabled: boolean; token: string | null; path: string | null }

export type Impact = {
  name: string
  designation: string
  department: string
  college: string
  papers: number
  q1: number
  first_author: number
  citations: number | null
  rank: number | null
  ranked_among: number | null
  rank_on_card: boolean
  top_journal: string | null
  since: number | null
  as_of: string
  share: ShareState
}

const SIZES = [
  { key: "wide", label: "LinkedIn", dims: "1200 × 627" },
  { key: "square", label: "WhatsApp and Instagram", dims: "1080 × 1080" },
] as const

/**
 * The person's research impact, as a card they can post.
 *
 * The card is drawn by the server so that the public link can carry a real
 * preview image -- LinkedIn and WhatsApp read OpenGraph tags and run no
 * JavaScript. What is on it is only what the person would want strangers to
 * read: no money, no staff id, no email, and a department place only when it
 * is in the top ten.
 *
 * Sharing is off until they turn it on, and turning it off takes the page and
 * the image down at once. The link stays the same, so turning it back on
 * restores anything already posted.
 */
export function ImpactCardPage() {
  const { me } = useAuth()
  const query = useApi<Impact>(["impact"], "/api/me/impact")
  const share = useApiMutation<{ enabled: boolean }, ShareState>("/api/me/impact/share", {
    method: "PUT",
    invalidates: [["impact"]],
  })
  // The image is cached by the browser; a version on the URL fetches it
  // again after the facts behind it have moved.
  const [version] = useState(() => Date.now())

  const data = query.data
  const shareUrl = data?.share.path ? `${window.location.origin}${data.share.path}` : null

  async function toggle(enabled: boolean) {
    try {
      await share.mutateAsync({ enabled })
      toast.ok(enabled ? "Your card can be seen by anyone with the link" : "Your card is private again")
    } catch (err) {
      toast.fail(err)
    }
  }

  if (query.isError) {
    return (
      <div className="page py-8">
        <InlineError message="Could not load your impact card." onRetry={() => void query.refetch()} />
      </div>
    )
  }

  return (
    <div className="page space-y-10">
      <header className="space-y-1">
        <PageTitle>Your impact card</PageTitle>
        <Sub>
          Your published work on one card, to post where you like. It never shows money, your
          staff id or how to reach you.
        </Sub>
      </header>

      {!data ? (
        <Skeleton className="aspect-[1200/627] w-full rounded-lg" />
      ) : (
        <>
          <section aria-label="What the card says" className="grid grid-cols-2 gap-x-8 gap-y-5 sm:grid-cols-4">
            <Fact label="Papers" value={data.papers} />
            <Fact label="In Q1 journals" value={data.q1} />
            <Fact
              label="Citations"
              value={data.citations}
              hint={data.citations == null ? "Not known yet" : "From Scopus"}
            />
            <Fact
              label={data.department ? `Place in ${data.department}` : "Place in department"}
              value={data.rank}
              prefix="#"
              hint={
                data.rank == null
                  ? "Nothing recognised yet"
                  : data.rank_on_card
                    ? `of ${data.ranked_among} · on the card`
                    : `of ${data.ranked_among} · shown on the card only in the top ten`
              }
            />
          </section>

          <section className="space-y-6">
            {SIZES.map((s) => {
              const src = `/api/me/impact/card.png?size=${s.key}&v=${version}`
              return (
                <figure key={s.key} className="space-y-2">
                  <img
                    src={src}
                    alt={`Your impact card for ${s.label}, ${s.dims}`}
                    className={
                      s.key === "wide"
                        ? "aspect-[1200/627] w-full rounded-lg ring-1 ring-line"
                        : "aspect-square w-full max-w-md rounded-lg ring-1 ring-line"
                    }
                  />
                  <figcaption className="flex flex-wrap items-center justify-between gap-2">
                    <Meta>
                      For {s.label} · {s.dims}
                    </Meta>
                    <Button asChild size="sm">
                      <a href={src} download={`impact-card-${s.key}-${(me?.name || "card").replace(/\W+/g, "-").toLowerCase()}.png`}>
                        <Download />
                        Download
                      </a>
                    </Button>
                  </figcaption>
                </figure>
              )
            })}
          </section>

          <section aria-label="Sharing" className="space-y-3">
            <SectionTitle>A link anyone can open</SectionTitle>
            <Switch
              checked={data.share.enabled}
              disabled={share.isPending || Boolean(me?.impersonated_by)}
              onCheckedChange={(on) => void toggle(on)}
              label="Share my card by link"
              hint="Anyone with the link sees the card, with a preview when it is posted. Turn it off and the link stops working at once."
            />
            {shareUrl && (
              <p className="well flex min-w-0 items-center gap-2 px-3 py-2 text-sm">
                <Link2 className="size-4 shrink-0 text-fg-subtle" aria-hidden />
                <a href={shareUrl} target="_blank" rel="noreferrer" className="min-w-0 truncate text-accent hover:underline">
                  {shareUrl}
                </a>
                <CopyButton value={shareUrl} label="the link" />
              </p>
            )}
          </section>
        </>
      )}
    </div>
  )
}

function Fact({
  label,
  value,
  hint,
  prefix = "",
}: {
  label: string
  value: number | null
  hint?: string
  prefix?: string
}) {
  return (
    <div className="min-w-0">
      <p className="text-sm text-fg-muted">{label}</p>
      <p className="figure mt-1 text-2xl">{value == null ? "—" : `${prefix}${value.toLocaleString("en-IN")}`}</p>
      {hint && <p className="mt-0.5 text-sm text-fg-muted">{hint}</p>}
    </div>
  )
}
