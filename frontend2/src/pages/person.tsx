import { useEffect, useRef, useState } from "react"
import { Link, useParams, useSearchParams } from "react-router-dom"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import {
  Camera,
  ExternalLink,
  FileText,
  Mail,
  Pencil,
  Search,
  UserCheck,
  UserPlus,
  Users,
} from "lucide-react"

import { useAuth } from "@/app/auth"
import { api, ApiError } from "@/lib/api"
import { cn } from "@/lib/cn"
import { useApi } from "@/lib/query"
import { Interests } from "@/pages/profile"
import { PostCard, useFeed, type FeedPost } from "@/pages/feed"
import { Button } from "@/ui/button"
import { Combobox } from "@/ui/combobox"
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/ui/dialog"
import { Checkbox, Field, Input, NumberInput, Textarea } from "@/ui/field"
import { Pagination } from "@/ui/pagination"
import { Avatar, PersonLink, type PersonBrief } from "@/ui/person"
import { EmptyState, ErrorState, InlineError, Skeleton, SkeletonRows, SkeletonText } from "@/ui/state"
import { Figure, Meta, PageTitle, SectionTitle, Sub } from "@/ui/text"
import { toast } from "@/ui/toast"

/**
 * A colleague's public profile (`/u/:id`), and the directory of everybody
 * (`/u`).
 *
 * The owner's words: faculty should be able to view others' profiles like
 * Facebook — that is the point of the discussions. So anybody signed in can
 * open anybody's page, and it shows who they are, what they have published,
 * who they wrote it with and what they have been posting.
 *
 * Never money, for anybody looking: `/api/people/{id}` carries no amount, no
 * ticket number and no stage in the chain, so there is nothing here to hide
 * per role. The research-post setting is the one private part, and the
 * server sends it only to the person themself and to the research
 * coordinator or super admin who set it (`research_post`).
 *
 * The office's own record of a person — payments and all — stays at
 * `/people/:id`, reached from here only by those who may open it.
 */

/* ------------------------------------------------------------------------ */
/* Data                                                                      */
/* ------------------------------------------------------------------------ */

type ProfilePaper = {
  id: string
  title: string
  journal_title: string | null
  publication_year: number | null
  quartile: string | null
  doi: string | null
  author_position: number | null
  total_authors: number | null
  coauthors: { id: string; name: string }[]
}

type ResearchPost = {
  research_faculty: boolean
  quota: number | null
  quota_note: string | null
  year: number
  used: number
  may_edit: boolean
}

export type Profile = {
  person: PersonBrief & {
    role_label: string
    bio: string | null
    interests: string[]
    scopus_url: string | null
    orcid_id: string | null
    orcid_url: string | null
    research_faculty: boolean
  }
  is_me: boolean
  papers: ProfilePaper[]
  counts: { papers: number; q1: number; first_author: number; areas: number }
  areas: { key: string; count: number }[]
  coauthors: (PersonBrief & { together: number })[]
  follow: { following: boolean; followers: number; following_count: number }
  posts: FeedPost[]
  research_post: ResearchPost | null
  may_open_record: boolean
}

type PersonCard = PersonBrief & { interests: string[]; papers: number; following: boolean }

type Directory = { total: number; limit: number; offset: number; results: PersonCard[] }

/** How many papers show before "Show all". */
const PAPERS_SHOWN = 8

/* ------------------------------------------------------------------------ */
/* The profile                                                               */
/* ------------------------------------------------------------------------ */

export function PublicProfile() {
  const { id = "me" } = useParams<{ id: string }>()
  const query = useApi<Profile>(["person", id], `/api/people/${id}`)

  if (query.isPending) {
    return (
      <div className="page max-w-3xl space-y-8">
        <div className="flex items-center gap-4">
          <Skeleton className="size-24 rounded-full" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-7 w-1/2" />
            <Skeleton className="h-4 w-1/3" />
          </div>
        </div>
        <SkeletonText lines={5} />
      </div>
    )
  }
  if (query.isError) {
    return (
      <div className="page max-w-3xl">
        <ErrorState
          title={query.error.status === 404 ? "Nobody here by that link" : "Could not load this profile"}
          message={
            query.error.status === 404
              ? "The account may have been closed, or the link is wrong. Search for them by name instead."
              : "The server did not answer. Nothing has been lost."
          }
          onRetry={query.error.status === 404 ? undefined : () => void query.refetch()}
        />
        <div className="mt-4 text-center">
          <Button kind="default" size="md" asChild>
            <Link to="/u">Find people</Link>
          </Button>
        </div>
      </div>
    )
  }

  return <ProfileView data={query.data} routeId={id} />
}

function ProfileView({ data, routeId }: { data: Profile; routeId: string }) {
  const { person } = data
  const [editing, setEditing] = useState(false)

  return (
    <div className="page max-w-3xl space-y-10">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-start">
        <Avatar person={person} size="xl" className="shrink-0" />
        <div className="min-w-0 flex-1 space-y-2">
          <div>
            <PageTitle>{person.name}</PageTitle>
            <Sub className="mt-1">
              {[person.designation, person.department].filter(Boolean).join(" · ") || person.role_label}
            </Sub>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {person.research_faculty && (
              <span className="inline-flex items-center rounded-sm bg-accent-wash px-1.5 py-0.5 text-xs font-medium text-fg">
                Research faculty
              </span>
            )}
            {person.orcid_url && (
              <a
                href={person.orcid_url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-sm text-accent underline-offset-4 hover:underline"
              >
                ORCID {person.orcid_id}
                <ExternalLink className="size-3" aria-hidden />
              </a>
            )}
            {person.scopus_url && (
              <a
                href={person.scopus_url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-sm text-accent underline-offset-4 hover:underline"
              >
                Scopus profile
                <ExternalLink className="size-3" aria-hidden />
              </a>
            )}
          </div>
          {person.bio && <p className="max-w-prose whitespace-pre-wrap text-base">{person.bio}</p>}
          {person.interests.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {person.interests.map((i) => (
                <Link
                  key={i}
                  to={`/u?interest=${encodeURIComponent(i)}`}
                  className="rounded-sm bg-sunken px-1.5 py-0.5 text-xs text-fg-muted hover:bg-hover hover:text-fg"
                >
                  {i}
                </Link>
              ))}
            </div>
          )}
          <FollowBar data={data} routeId={routeId} onEdit={() => setEditing(true)} />
        </div>
      </header>

      {data.research_post && (
        <ResearchPostPanel personId={person.id} routeId={routeId} post={data.research_post} isMe={data.is_me} />
      )}

      <Counts counts={data.counts} />

      <Papers papers={data.papers} isMe={data.is_me} name={person.name} />

      {data.coauthors.length > 0 && (
        <section className="space-y-3">
          <SectionTitle>Written with, from this college</SectionTitle>
          <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {data.coauthors.map((c) => (
              <li key={c.id} className="flex items-center gap-3">
                <Avatar person={c} size="sm" />
                <span className="min-w-0 flex-1">
                  <PersonLink id={c.id} name={c.name} className="block truncate text-sm" />
                  <Meta className="block truncate text-xs">
                    {[c.department, `${c.together} paper${c.together === 1 ? "" : "s"} together`]
                      .filter(Boolean)
                      .join(" · ")}
                  </Meta>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <Posts data={data} />

      {editing && <EditProfile data={data} routeId={routeId} onClose={() => setEditing(false)} />}
    </div>
  )
}

function FollowBar({
  data,
  routeId,
  onEdit,
}: {
  data: Profile
  routeId: string
  onEdit: () => void
}) {
  const qc = useQueryClient()
  const key = ["person", routeId]
  const follow = useMutation<{ following: boolean; followers: number }, ApiError, boolean>({
    mutationFn: (next) => api(`/api/follows/people/${data.person.id}`, { method: next ? "POST" : "DELETE" }),
    onMutate: (next) => {
      qc.setQueryData<Profile>(key, (d) =>
        d
          ? {
              ...d,
              follow: {
                ...d.follow,
                following: next,
                followers: Math.max(0, d.follow.followers + (next ? 1 : -1)),
              },
            }
          : d
      )
    },
    onSuccess: (r) => {
      qc.setQueryData<Profile>(key, (d) => (d ? { ...d, follow: { ...d.follow, ...r } } : d))
      void qc.invalidateQueries({ queryKey: ["feed", "following"] })
    },
    onError: (err, next) => {
      qc.setQueryData<Profile>(key, (d) =>
        d
          ? {
              ...d,
              follow: {
                ...d.follow,
                following: !next,
                followers: Math.max(0, d.follow.followers + (next ? -1 : 1)),
              },
            }
          : d
      )
      toast.fail(err)
    },
  })

  const { following, followers, following_count } = data.follow

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 pt-1">
      <Meta className="text-sm">
        <span className="tabular font-medium text-fg">{followers}</span> follower{followers === 1 ? "" : "s"} ·{" "}
        <span className="tabular font-medium text-fg">{following_count}</span> following
      </Meta>
      <div className="flex flex-wrap gap-2">
        {data.is_me ? (
          <>
            <Button kind="default" size="md" onClick={onEdit}>
              <Pencil />
              Edit profile
            </Button>
            <Button kind="quiet" size="md" asChild>
              <Link to="/me">Account details</Link>
            </Button>
          </>
        ) : (
          <>
            <Button
              kind={following ? "default" : "primary"}
              size="md"
              aria-pressed={following}
              onClick={() => follow.mutate(!following)}
            >
              {following ? <UserCheck /> : <UserPlus />}
              {following ? "Following" : "Follow"}
            </Button>
            <Button kind="default" size="md" asChild>
              <Link to={`/messages?to=${data.person.id}`}>
                <Mail />
                Message
              </Link>
            </Button>
            {data.may_open_record && (
              <Button kind="quiet" size="md" asChild>
                <Link to={`/people/${data.person.id}`}>Office record</Link>
              </Button>
            )}
          </>
        )}
      </div>
    </div>
  )
}

function Counts({ counts }: { counts: Profile["counts"] }) {
  const items = [
    { label: counts.papers === 1 ? "paper" : "papers", value: counts.papers },
    { label: "in Q1 journals", value: counts.q1 },
    { label: "as first author", value: counts.first_author },
  ]
  return (
    <div className="flex flex-wrap gap-x-8 gap-y-2">
      {items.map((i) => (
        <span key={i.label} className="flex items-baseline gap-2">
          <Figure className="text-2xl">{i.value}</Figure>
          <Meta>{i.label}</Meta>
        </span>
      ))}
    </div>
  )
}

/**
 * Their own published and filed work — by title, journal, year and
 * quartile, with the colleagues who filed the same paper. Nothing about
 * where a paper is in the chain: to a colleague a filed paper is published
 * work, and which desk has it is the college's business.
 */
export function Papers({ papers, isMe, name }: { papers: ProfilePaper[]; isMe: boolean; name: string }) {
  const [all, setAll] = useState(false)
  const shown = all ? papers : papers.slice(0, PAPERS_SHOWN)

  return (
    <section className="space-y-3">
      <SectionTitle>Published work</SectionTitle>
      {papers.length === 0 ? (
        <EmptyState
          icon={FileText}
          title={isMe ? "Nothing filed yet" : "Nothing filed here yet"}
          message={
            isMe
              ? "Papers you file appear here for colleagues to see — by title, journal and year, never by what they paid."
              : `When ${name} files a paper with the college it appears here.`
          }
          action={
            isMe ? (
              <Button kind="primary" size="sm" asChild>
                <Link to="/papers/new">File a paper</Link>
              </Button>
            ) : undefined
          }
        />
      ) : (
        <>
          <ul className="divide-y divide-line border-y border-line">
            {shown.map((p) => (
              <li key={p.id} className="space-y-0.5 py-3">
                <p className="text-base">
                  {p.doi ? (
                    <a
                      href={`https://doi.org/${p.doi}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="underline-offset-4 hover:underline"
                    >
                      {p.title}
                    </a>
                  ) : (
                    p.title
                  )}
                </p>
                <Meta className="block">
                  {[
                    p.journal_title,
                    p.publication_year,
                    p.quartile,
                    p.author_position && p.total_authors
                      ? `author ${p.author_position} of ${p.total_authors}`
                      : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </Meta>
                {p.coauthors.length > 0 && (
                  <Meta className="block text-xs">
                    With{" "}
                    {p.coauthors.map((c, i) => (
                      <span key={c.id}>
                        {i > 0 ? ", " : ""}
                        <PersonLink id={c.id} name={c.name} className="font-normal text-fg-muted" />
                      </span>
                    ))}
                  </Meta>
                )}
              </li>
            ))}
          </ul>
          {papers.length > PAPERS_SHOWN && (
            <Button kind="quiet" size="sm" onClick={() => setAll((a) => !a)}>
              {all ? "Show fewer" : `Show all ${papers.length}`}
            </Button>
          )}
        </>
      )}
    </section>
  )
}

function Posts({ data }: { data: Profile }) {
  const [more, setMore] = useState(false)
  const older = useFeed("everyone", more ? data.person.id : undefined)
  const posts = more ? (older.data?.pages.flatMap((p) => p.results) ?? data.posts) : data.posts

  return (
    <section className="space-y-3">
      <SectionTitle>Posts</SectionTitle>
      {posts.length === 0 ? (
        <EmptyState
          icon={Users}
          title={data.is_me ? "You have not posted yet" : "No posts yet"}
          message={
            data.is_me
              ? "Share a paper, a seminar or a question in Discussions and it shows here too."
              : `Nothing from ${data.person.name} in Discussions that you can see.`
          }
          action={
            data.is_me ? (
              <Button kind="primary" size="sm" asChild>
                <Link to="/discussions">Write a post</Link>
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div className="space-y-4">
          {posts.map((p) => (
            <PostCard key={p.id} post={p} />
          ))}
          {!more && data.posts.length >= 5 && (
            <Button kind="default" size="md" onClick={() => setMore(true)}>
              Show all their posts
            </Button>
          )}
          {more && older.hasNextPage && (
            <Button kind="default" size="md" onClick={() => void older.fetchNextPage()} disabled={older.isFetchingNextPage}>
              {older.isFetchingNextPage ? "Loading…" : "Show older posts"}
            </Button>
          )}
        </div>
      )}
    </section>
  )
}

/* ------------------------------------------------------------------------ */
/* The research post                                                         */
/* ------------------------------------------------------------------------ */

function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"]
  const v = n % 100
  return `${n}${s[(v - 20) % 10] || s[v] || s[0]}`
}

/**
 * Whether somebody is research faculty, and their yearly quota.
 *
 * Two readers, two shapes. The research coordinator (and the super admin)
 * gets a tick box, the quota and a note, saved here — it used to take a trip
 * through the office's account screen for what is one decision about one
 * person. The person themself gets one line saying how far into the quota
 * they are, because the quota decides which of their papers carry no
 * remuneration and finding that out from a zero on a payment is the worst
 * way to learn it. Everybody else gets the badge in the header and no more.
 */
function ResearchPostPanel({
  personId,
  routeId,
  post,
  isMe,
}: {
  personId: string
  routeId: string
  post: ResearchPost
  isMe: boolean
}) {
  if (!post.may_edit) {
    if (!post.research_faculty || !post.quota) return null
    return (
      <p className="rounded-md bg-accent-wash px-3 py-2 text-sm">
        Research faculty · {post.used} of your {post.quota} quota papers for {post.year} filed — papers after
        the {ordinal(post.quota)} are paid.
      </p>
    )
  }
  return <ResearchPostEditor personId={personId} routeId={routeId} post={post} isMe={isMe} />
}

function ResearchPostEditor({
  personId,
  routeId,
  post,
  isMe,
}: {
  personId: string
  routeId: string
  post: ResearchPost
  isMe: boolean
}) {
  const qc = useQueryClient()
  const [ticked, setTicked] = useState(post.research_faculty)
  const [quota, setQuota] = useState(post.quota != null ? String(post.quota) : "")
  const [note, setNote] = useState(post.quota_note ?? "")
  useEffect(() => {
    setTicked(post.research_faculty)
    setQuota(post.quota != null ? String(post.quota) : "")
    setNote(post.quota_note ?? "")
  }, [post.research_faculty, post.quota, post.quota_note])

  const quotaNumber = quota.trim() === "" ? null : Number(quota)
  const quotaInvalid = ticked && (quotaNumber === null || !Number.isInteger(quotaNumber) || quotaNumber < 0 || quotaNumber > 50)

  const save = useMutation<unknown, ApiError, void>({
    mutationFn: () =>
      api(`/api/admin/users/${personId}`, {
        method: "PATCH",
        json: ticked
          ? { faculty_type: "RESEARCH", research_quota: quotaNumber, research_quota_note: note.trim() || null }
          : // Unticking clears the quota on the server; saying so here too keeps
            // a stale number from riding along in the request.
            { faculty_type: "REGULAR", research_quota: null, research_quota_note: null },
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["person", routeId] })
      toast.ok(ticked ? `Research faculty, ${quotaNumber} papers a year` : "No longer research faculty")
    },
  })

  const dirty =
    ticked !== post.research_faculty ||
    (ticked && (quotaNumber !== post.quota || (note.trim() || null) !== (post.quota_note || null)))

  return (
    <section aria-label="Research post" className="panel space-y-3 px-4 py-4">
      <div>
        <SectionTitle className="text-base">Research post</SectionTitle>
        <Meta className="block">
          Only the research coordinator and the super admin see this box. A research post's first papers each
          year, up to the quota, carry no remuneration; the rest are paid in full.
          {isMe ? " This is your own account." : ""}
        </Meta>
      </div>
      <Checkbox
        checked={ticked}
        onCheckedChange={(v) => setTicked(v === true)}
        label="Research faculty"
        hint="Unticking clears the quota."
      />
      {ticked && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-[10rem_1fr]">
          <Field label="Papers a year" error={quotaInvalid ? "A whole number, 0 to 50." : undefined}>
            <NumberInput value={quota} onChange={(e) => setQuota(e.target.value)} min={0} max={50} step={1} unit="papers" />
          </Field>
          <Field label="Note (optional)">
            <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="2026-27 agreement" maxLength={300} />
          </Field>
        </div>
      )}
      {ticked && post.research_faculty && post.quota ? (
        <Meta className="block text-xs">
          {post.used} of {post.quota} quota papers for {post.year} filed so far.
        </Meta>
      ) : null}
      {save.error && <InlineError message={save.error.message} />}
      <div className="flex justify-end">
        <Button kind="primary" size="md" disabled={!dirty || quotaInvalid || save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? "Saving…" : "Save research post"}
        </Button>
      </div>
    </section>
  )
}

/* ------------------------------------------------------------------------ */
/* Editing your own                                                          */
/* ------------------------------------------------------------------------ */

/**
 * The self-service part of a profile: photo, a few lines about yourself,
 * ORCID, research interests. Everything else — name, department, the Scopus
 * link — decides who gets paid, and stays a request to the office on the
 * account page.
 */
function EditProfile({ data, routeId, onClose }: { data: Profile; routeId: string; onClose: () => void }) {
  const qc = useQueryClient()
  const { refresh } = useAuth()
  const [bio, setBio] = useState(data.person.bio ?? "")
  const [orcid, setOrcid] = useState(data.person.orcid_id ?? "")
  const fileInput = useRef<HTMLInputElement>(null)

  function refreshEverywhere() {
    void qc.invalidateQueries({ queryKey: ["person"] })
    void qc.invalidateQueries({ queryKey: ["feed"] })
    void refresh()
  }

  const save = useMutation<unknown, ApiError, void>({
    mutationFn: () =>
      api("/api/auth/profile/self", {
        method: "PATCH",
        json: { bio: bio.trim(), orcid_id: orcid.trim() },
      }),
    onSuccess: () => {
      refreshEverywhere()
      toast.ok("Profile saved")
      onClose()
    },
  })

  const photo = useMutation<{ photo_url: string | null }, ApiError, File | null>({
    mutationFn: (file) => {
      if (!file) return api("/api/people/me/photo", { method: "DELETE" })
      const form = new FormData()
      form.set("file", file)
      // Multipart: the cast `api()` needs for a FormData body (file-paper.tsx).
      return api("/api/people/me/photo", { method: "POST", body: form } as unknown as Parameters<typeof api>[1])
    },
    onSuccess: (r) => {
      qc.setQueryData<Profile>(["person", routeId], (d) =>
        d ? { ...d, person: { ...d.person, photo_url: r.photo_url } } : d
      )
      refreshEverywhere()
      toast.ok(r.photo_url ? "Photo updated" : "Photo removed")
    },
    onError: (err) => toast.fail(err),
  })

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>Edit your profile</DialogTitle>
          <DialogDescription>
            Everybody in the college can see this page. Your name, department and Scopus link are kept by the
            research office — ask for a change on your account page.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-5">
          <div className="flex items-center gap-4">
            <Avatar person={data.person} size="lg" />
            <div className="flex flex-wrap gap-2">
              <input
                ref={fileInput}
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif"
                className="sr-only"
                tabIndex={-1}
                aria-hidden
                onChange={(e) => {
                  const f = e.target.files?.[0]
                  e.target.value = ""
                  if (f) photo.mutate(f)
                }}
              />
              <Button kind="default" size="md" onClick={() => fileInput.current?.click()} disabled={photo.isPending}>
                <Camera />
                {photo.isPending ? "Uploading…" : data.person.photo_url ? "Change photo" : "Add a photo"}
              </Button>
              {data.person.photo_url && (
                <Button kind="quiet" size="md" onClick={() => photo.mutate(null)} disabled={photo.isPending}>
                  Remove
                </Button>
              )}
            </div>
          </div>
          <Meta className="block text-xs">
            A photo is cropped square and made small, and the camera's details are removed before anyone sees it.
          </Meta>

          <Field label="About you" hint={`${bio.length} of 600 characters. What you work on, and what you would like to hear about.`}>
            <Textarea value={bio} onChange={(e) => setBio(e.target.value)} rows={3} maxRows={8} maxLength={600} />
          </Field>

          <Field label="ORCID iD" hint="Paste the link from orcid.org or the sixteen characters.">
            <Input value={orcid} onChange={(e) => setOrcid(e.target.value)} placeholder="0000-0002-1825-0097" />
          </Field>

          <div className="space-y-1">
            <Interests />
          </div>

          {save.error && <InlineError message={save.error.message} />}
        </DialogBody>
        <DialogFooter>
          <Button kind="quiet" onClick={onClose} disabled={save.isPending}>
            Close
          </Button>
          <Button kind="primary" onClick={() => save.mutate()} disabled={save.isPending}>
            {save.isPending ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/* ------------------------------------------------------------------------ */
/* The directory                                                             */
/* ------------------------------------------------------------------------ */

/**
 * Everybody, searchable by name, department, designation or research
 * interest. The way into a colleague's profile when you do not already have
 * a post of theirs to click.
 */
export function PeopleDirectory() {
  const [params, setParams] = useSearchParams()
  const q = params.get("q") ?? ""
  const department = params.get("department") ?? ""
  const interest = params.get("interest") ?? ""
  const page = Math.max(1, Number(params.get("page") ?? "1") || 1)
  const [draft, setDraft] = useState(q)
  const limit = 24

  useEffect(() => setDraft(q), [q])
  useEffect(() => {
    if (draft === q) return
    const t = setTimeout(() => set({ q: draft, page: "" }), 250)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft])

  function set(entries: Record<string, string>) {
    setParams((prev) => {
      const next = new URLSearchParams(prev)
      for (const [k, v] of Object.entries(entries)) {
        if (v) next.set(k, v)
        else next.delete(k)
      }
      return next
    })
  }

  const query = new URLSearchParams({ limit: String(limit), offset: String((page - 1) * limit) })
  if (q) query.set("q", q)
  if (department) query.set("department", department)
  if (interest) query.set("interest", interest)
  const people = useApi<Directory>(["people-directory", q, department, interest, page], `/api/people?${query}`)
  const departments = useApi<string[]>(["meta", "departments"], "/api/meta/departments")

  const filtered = !!(q || department || interest)

  return (
    <div className="page space-y-6">
      <header>
        <PageTitle>People</PageTitle>
        <Sub className="mt-1">Everybody at the college. Open a profile to see their work and follow them.</Sub>
      </header>

      <div className="flex flex-wrap items-center gap-2 sm:gap-3">
        <div className="relative w-full sm:max-w-xs">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-fg-subtle" aria-hidden />
          <Input
            type="search"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Name, department or research interest"
            aria-label="Search people"
            className="pl-8"
          />
        </div>
        <Combobox
          value={department}
          onChange={(v) => set({ department: v, page: "" })}
          options={[
            { value: "", label: "Every department" },
            ...(departments.data ?? []).map((d) => ({ value: d, label: d })),
          ]}
          aria-label="Department"
          className="w-full sm:w-60"
        />
        {interest && (
          <Button kind="quiet" size="md" onClick={() => set({ interest: "", page: "" })}>
            Interested in {interest} ×
          </Button>
        )}
      </div>

      {people.isPending ? (
        <SkeletonRows rows={6} rowHeight={64} />
      ) : people.isError ? (
        <ErrorState
          title="Could not load people"
          message="The server did not answer. Nothing has changed."
          onRetry={() => void people.refetch()}
        />
      ) : people.data.results.length === 0 ? (
        <EmptyState
          icon={Users}
          title={filtered ? "Nobody matches that" : "Nobody here yet"}
          message={filtered ? "Try part of a name, or clear the department." : "Accounts appear here as the office adds them."}
        />
      ) : (
        <>
          <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {people.data.results.map((p) => (
              <li key={p.id}>
                <Link
                  to={`/u/${p.id}`}
                  className={cn("panel flex h-full items-start gap-3 px-3 py-3 hover:bg-hover")}
                >
                  <Avatar person={p} size="md" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-base font-medium">{p.name}</span>
                    <Meta className="block truncate text-xs">
                      {[p.designation, p.department].filter(Boolean).join(" · ")}
                    </Meta>
                    <Meta className="mt-1 block truncate text-xs">
                      {p.papers} paper{p.papers === 1 ? "" : "s"}
                      {p.interests.length > 0 ? ` · ${p.interests.join(", ")}` : ""}
                      {p.following ? " · following" : ""}
                    </Meta>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
          <Pagination
            page={page - 1}
            pageSize={limit}
            total={people.data.total}
            onChange={(n) => set({ page: n > 0 ? String(n + 1) : "" })}
          />
        </>
      )}
    </div>
  )
}
