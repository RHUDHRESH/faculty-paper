import { useEffect, useRef, useState } from "react"
import { Link, useParams, useSearchParams } from "react-router-dom"
import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
  type InfiniteData,
  type QueryClient,
} from "@tanstack/react-query"
import {
  ArrowLeft,
  EyeOff,
  FileText,
  Flag,
  Heart,
  ImagePlus,
  Link2,
  Mail,
  MessageCircle,
  MoreHorizontal,
  Pencil,
  Trash2,
  Users,
  X,
} from "lucide-react"

import { useAuth, type Me } from "@/app/auth"
import { api, ApiError } from "@/lib/api"
import { cn } from "@/lib/cn"
import { useApi } from "@/lib/query"
import { Button } from "@/ui/button"
import { Composer, renderBody, type Candidate, type MentionKind, type ResolvedMention } from "@/ui/composer"
import {
  ConfirmDialog,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/ui/dialog"
import { Field, Input, Textarea } from "@/ui/field"
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/ui/menu"
import { Avatar, initialsOf, PersonLink, type PersonBrief } from "@/ui/person"
import { EmptyState, ErrorState, InlineError, SkeletonRows } from "@/ui/state"
import { Meta, PageTitle, Sub } from "@/ui/text"
import { toast } from "@/ui/toast"
import { Ago } from "@/ui/when"

/**
 * Discussions — the college's feed.
 *
 * The owner's words: the threads section was not working, and the point of
 * it is a small social network where colleagues see each other's work. So
 * this is a feed of posts rather than a list of thread titles: a post shows
 * its words, its picture, the paper it is about and the last couple of
 * replies, and a like or a comment lands on screen the moment it is made.
 *
 * Who sees a post is the server's decision (`core.social.visible_posts`):
 * everybody, or the author's department. A department-only post says so on
 * its face, so nobody replies to one believing the whole college will read it.
 *
 * Private conversations are not here. They are Messages (`pages/discussions`),
 * one click away in the header.
 */

/* ------------------------------------------------------------------------ */
/* Data                                                                      */
/* ------------------------------------------------------------------------ */

export type FeedComment = {
  id: string
  post_id: string
  author: PersonBrief | null
  kind: "HUMAN" | "AGENT" | "SYSTEM"
  body: string
  mentions: ResolvedMention[]
  created_at: string
  edited_at: string | null
  may_edit: boolean
  may_delete: boolean
  /** Written here, not yet confirmed by the server. */
  pending?: boolean
}

export type FeedPost = {
  id: string
  author: PersonBrief | null
  body: string
  mentions: ResolvedMention[]
  visibility: "EVERYONE" | "DEPARTMENT"
  department: string | null
  link_url: string | null
  paper: {
    id: string
    title: string
    journal_title: string | null
    publication_year: number | null
    quartile: string | null
    doi: string | null
  } | null
  attachment: { url: string; kind: "image" | "file"; name: string | null; size: number | null } | null
  created_at: string
  edited_at: string | null
  like_count: number
  liked: boolean
  comment_count: number
  comments_preview: FeedComment[]
  comments?: FeedComment[]
  hidden: boolean
  hidden_reason: string | null
  reported_by_me: boolean
  may_edit: boolean
  may_delete: boolean
  may_moderate: boolean
  legacy_thread_id: string | null
  pending?: boolean
}

type FeedPage = { tab: string; results: FeedPost[]; next: string | null }

type Report = {
  id: string
  reason: string
  created_at: string
  reporter: PersonBrief
  post: FeedPost
}

type PaperOption = {
  id: string
  title: string
  journal_title: string | null
  publication_year: number | null
  quartile: string | null
}

type Tab = "everyone" | "following" | "department" | "reported"

/** What `@` offers in the feed: the feed notifies people and names
 *  departments and journals. It does not resolve ticket numbers or answer
 *  `@agent`, so it does not offer them. */
const FEED_MENTIONS: MentionKind[] = ["USER", "DEPARTMENT", "JOURNAL"]

/** How often an open feed re-asks. A post a colleague writes should arrive
 *  without anybody reloading, and a minute is not chatter. */
const POLL_MS = 60_000

/** The same cap the server holds (`UPLOAD_MAX_BYTES`), said before the upload
 *  rather than after it. */
const MAX_BYTES = 10 * 1024 * 1024

function readTab(value: string | null): Tab {
  return value === "following" || value === "department" || value === "reported" ? value : "everyone"
}

function feedPath(tab: string, cursor: string | null, author?: string): string {
  const query = new URLSearchParams({ tab, limit: "20" })
  if (cursor) query.set("cursor", cursor)
  if (author) query.set("author", author)
  return `/api/feed?${query.toString()}`
}

/** The feed, or one author's posts. `author` is how a profile lists more. */
export function useFeed(tab: Exclude<Tab, "reported">, author?: string) {
  return useInfiniteQuery<FeedPage, ApiError, InfiniteData<FeedPage>, readonly unknown[], string | null>({
    queryKey: ["feed", tab, author ?? null],
    queryFn: ({ pageParam }) => api<FeedPage>(feedPath(tab, pageParam, author)),
    initialPageParam: null,
    getNextPageParam: (last) => last.next,
    refetchInterval: POLL_MS,
  })
}

/* ------------------------------------------------------------------------ */
/* One change, everywhere the post is on screen                              */
/* ------------------------------------------------------------------------ */

/**
 * Apply `fn` to a post in every cache that holds it: each feed tab, the
 * post's own page, and the profile it appears on. Return null to remove it.
 *
 * Without this a like made on the Everyone tab is gone again on the post's
 * own page until it refetches, which reads as the like not having worked.
 */
function patchPost(qc: QueryClient, id: string, fn: (p: FeedPost) => FeedPost | null) {
  const apply = (list: FeedPost[]) => list.flatMap((p) => (p.id === id ? (fn(p) ?? []) : [p]))
  qc.setQueriesData<InfiniteData<FeedPage>>({ queryKey: ["feed"] }, (data) =>
    data && Array.isArray(data.pages)
      ? { ...data, pages: data.pages.map((page) => ({ ...page, results: apply(page.results) })) }
      : data
  )
  qc.setQueriesData<FeedPost>({ queryKey: ["feed-post", id] }, (p) => (p ? (fn(p) ?? p) : p))
  qc.setQueriesData<{ posts?: FeedPost[] }>({ queryKey: ["person"] }, (d) =>
    d && Array.isArray(d.posts) ? { ...d, posts: apply(d.posts) } : d
  )
}

function prependPost(qc: QueryClient, post: FeedPost, keys: readonly (readonly unknown[])[]) {
  for (const key of keys) {
    qc.setQueryData<InfiniteData<FeedPage>>(key, (data) => {
      if (!data || data.pages.length === 0) return data
      const [first, ...rest] = data.pages
      return { ...data, pages: [{ ...first, results: [post, ...first.results] }, ...rest] }
    })
  }
}

function meAsAuthor(me: Me | null): PersonBrief | null {
  if (!me) return null
  return {
    id: me.id,
    name: me.name,
    initials: initialsOf(me.name),
    photo_url: me.photo_url ?? null,
    department: me.department ?? null,
    designation: me.designation ?? null,
  }
}

/** The people chosen from the @ menu whose names are still in the text. */
function mentionIds(text: string, picked: Candidate[]): string[] {
  const lower = text.toLowerCase()
  const ids = picked
    .filter((c) => c.kind === "USER" && lower.includes(c.label.toLowerCase()))
    .map((c) => c.id)
  return [...new Set(ids)]
}

/* ------------------------------------------------------------------------ */
/* The page                                                                  */
/* ------------------------------------------------------------------------ */

export function Feed() {
  const { me } = useAuth()
  const moderator = me?.role === "SUPER_ADMIN"
  const [params, setParams] = useSearchParams()
  const tab = readTab(params.get("tab"))
  const composerRef = useRef<HTMLTextAreaElement>(null)

  const reports = useApi<{ results: Report[] }>(["feed-reports"], "/api/feed/reports", {
    enabled: moderator,
    refetchInterval: POLL_MS,
  })

  const tabs: { key: Tab; label: string }[] = [
    { key: "everyone", label: "Everyone" },
    { key: "following", label: "Following" },
    ...(me?.department ? [{ key: "department" as Tab, label: "My department" }] : []),
    ...(moderator
      ? [
          {
            key: "reported" as Tab,
            label: `Reported${reports.data?.results.length ? ` (${reports.data.results.length})` : ""}`,
          },
        ]
      : []),
  ]

  function focusComposer() {
    composerRef.current?.focus()
    composerRef.current?.scrollIntoView({ block: "center", behavior: "smooth" })
  }

  return (
    <div className="page max-w-2xl space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <PageTitle>Discussions</PageTitle>
          <Sub className="mt-1">
            What colleagues are working on, sharing and asking. Post for everybody, or just your
            department.
          </Sub>
        </div>
        <div className="flex shrink-0 gap-2">
          <Button kind="quiet" size="md" asChild>
            <Link to="/u">
              <Users />
              Find people
            </Link>
          </Button>
          <Button kind="default" size="md" asChild>
            <Link to="/messages">
              <Mail />
              Messages
            </Link>
          </Button>
        </div>
      </header>

      {tab !== "reported" && <PostComposer tab={tab} textareaRef={composerRef} />}

      <div
        role="tablist"
        aria-label="Which posts"
        className="inline-flex max-w-full gap-0.5 overflow-x-auto rounded-md bg-sunken p-0.5"
      >
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={tab === t.key}
            onClick={() =>
              setParams((prev) => {
                const next = new URLSearchParams(prev)
                if (t.key === "everyone") next.delete("tab")
                else next.set("tab", t.key)
                return next
              })
            }
            className={cn(
              "h-7 shrink-0 rounded-sm px-3 text-sm font-medium transition-colors",
              "duration-[var(--dur-1)] ease-out",
              tab === t.key ? "bg-surface text-fg" : "text-fg-muted hover:text-fg"
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "reported" ? (
        <ReportsQueue query={reports} />
      ) : (
        <FeedList tab={tab} onWrite={focusComposer} department={me?.department ?? null} />
      )}
    </div>
  )
}

function FeedList({
  tab,
  onWrite,
  department,
}: {
  tab: Exclude<Tab, "reported">
  onWrite: () => void
  department: string | null
}) {
  const feed = useFeed(tab)
  const posts = feed.data?.pages.flatMap((p) => p.results) ?? []

  if (feed.isPending) return <SkeletonRows rows={4} rowHeight={120} />
  if (feed.isError) {
    return (
      <ErrorState
        title="Could not load the feed"
        message="The server did not answer. Nothing anybody posted has been lost."
        onRetry={() => void feed.refetch()}
      />
    )
  }

  if (posts.length === 0) {
    if (tab === "following") {
      return (
        <EmptyState
          icon={Users}
          title="Nobody you follow has posted yet"
          message="Follow colleagues and departments from their profiles, and what they post gathers here."
          action={
            <Button kind="primary" size="sm" asChild>
              <Link to="/u">Find people to follow</Link>
            </Button>
          }
        />
      )
    }
    return (
      <EmptyState
        icon={MessageCircle}
        title={tab === "department" ? `Nothing from ${department || "your department"} yet` : "Nothing here yet"}
        message={
          tab === "department"
            ? "Posts by people in your department appear here, including the ones only your department can see."
            : "This is where the college talks. Share a paper you have published, a seminar, a call for collaborators, or a question."
        }
        action={
          <Button kind="primary" size="sm" onClick={onWrite}>
            Write the first post
          </Button>
        }
      />
    )
  }

  return (
    <div className="space-y-4">
      {posts.map((p) => (
        <PostCard key={p.id} post={p} />
      ))}
      <div className="flex justify-center">
        {feed.hasNextPage ? (
          <Button
            kind="default"
            size="md"
            onClick={() => void feed.fetchNextPage()}
            disabled={feed.isFetchingNextPage}
          >
            {feed.isFetchingNextPage ? "Loading…" : "Show older posts"}
          </Button>
        ) : (
          <Meta className="text-xs">You are all caught up.</Meta>
        )}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------------ */
/* Writing a post                                                            */
/* ------------------------------------------------------------------------ */

/**
 * The box at the top of the feed.
 *
 * The post appears in the feed the moment Post is pressed and is swapped for
 * the server's copy when it answers. If the server refuses it, it comes back
 * out of the feed and the words go back into the box — a failed post must
 * never cost somebody what they typed.
 */
function PostComposer({
  tab,
  textareaRef,
}: {
  tab: Exclude<Tab, "reported">
  textareaRef: React.RefObject<HTMLTextAreaElement | null>
}) {
  const { me } = useAuth()
  const qc = useQueryClient()
  const [text, setText] = useState("")
  const [picked, setPicked] = useState<Candidate[]>([])
  const [visibility, setVisibility] = useState<"EVERYONE" | "DEPARTMENT">("EVERYONE")
  const [file, setFile] = useState<File | null>(null)
  const [preview, setPreview] = useState<string | null>(null)
  const [linkOpen, setLinkOpen] = useState(false)
  const [link, setLink] = useState("")
  const [paper, setPaper] = useState<PaperOption | null>(null)
  const [fileError, setFileError] = useState<string | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)

  const papers = useApi<{ results: PaperOption[] }>(["feed-my-papers"], "/api/feed/my-papers", {
    staleTime: 5 * 60_000,
  })

  useEffect(() => {
    if (!file || !file.type.startsWith("image/")) {
      setPreview(null)
      return
    }
    const url = URL.createObjectURL(file)
    setPreview(url)
    return () => URL.revokeObjectURL(url)
  }, [file])

  const create = useMutation<FeedPost, ApiError, { form: FormData; temp: FeedPost }, { restore: () => void }>({
    // A multipart body is the one shape `api()`'s options type omits (see
    // `uploadAttachment` in file-paper.tsx); it still goes through `api()` so
    // the CSRF header is attached.
    mutationFn: ({ form }) =>
      api<FeedPost>("/api/feed/posts", { method: "POST", body: form } as unknown as Parameters<typeof api>[1]),
    onMutate: ({ temp }) => {
      // Everyone, and the tab being looked at -- once, when they are the same.
      const tabs = tab === "everyone" ? ["everyone"] : ["everyone", tab]
      prependPost(qc, temp, tabs.map((t) => ["feed", t, null]))
      const draft = { text, picked, visibility, file, link, linkOpen, paper }
      return {
        restore: () => {
          setText(draft.text)
          setPicked(draft.picked)
          setVisibility(draft.visibility)
          setFile(draft.file)
          setLink(draft.link)
          setLinkOpen(draft.linkOpen)
          setPaper(draft.paper)
        },
      }
    },
    onSuccess: (real, { temp }) => {
      patchPost(qc, temp.id, () => real)
    },
    onError: (err, { temp }, context) => {
      patchPost(qc, temp.id, () => null)
      context?.restore()
      toast.fail(err)
    },
  })

  const hasSomething = !!text.trim() || !!file || !!paper || !!link.trim()

  function send() {
    if (!hasSomething || !me) return
    const body = text.trim()
    const form = new FormData()
    form.set("body", body)
    form.set("visibility", visibility)
    if (link.trim()) form.set("link_url", link.trim())
    if (paper) form.set("paper_id", paper.id)
    for (const id of mentionIds(body, picked)) form.append("mention_ids", id)
    if (file) form.set("file", file)

    const temp: FeedPost = {
      id: `temp-${Date.now()}`,
      author: meAsAuthor(me),
      body,
      mentions: [],
      visibility,
      department: me.department ?? null,
      link_url: link.trim() || null,
      paper: paper ? { ...paper, doi: null } : null,
      attachment: file
        ? { url: preview ?? "", kind: file.type.startsWith("image/") ? "image" : "file", name: file.name, size: file.size }
        : null,
      created_at: new Date().toISOString(),
      edited_at: null,
      like_count: 0,
      liked: false,
      comment_count: 0,
      comments_preview: [],
      hidden: false,
      hidden_reason: null,
      reported_by_me: false,
      may_edit: false,
      may_delete: false,
      may_moderate: false,
      legacy_thread_id: null,
      pending: true,
    }
    create.mutate({ form, temp })
    setText("")
    setPicked([])
    setFile(null)
    setLink("")
    setLinkOpen(false)
    setPaper(null)
    setFileError(null)
  }

  function choose(f: File | undefined) {
    if (!f) return
    if (f.size > MAX_BYTES) {
      setFileError("That file is over 10 MB. A smaller copy will look the same here.")
      return
    }
    setFileError(null)
    setFile(f)
  }

  const department = me?.department

  return (
    <section aria-label="Write a post" className="panel space-y-3 px-3 py-3 sm:px-4">
      <div className="flex gap-3">
        <Avatar person={meAsAuthor(me)} size="md" className="hidden sm:inline-flex" />
        <Composer
          className="min-w-0 flex-1"
          value={text}
          onChange={setText}
          onPick={(c) => setPicked((list) => [...list, c])}
          onSend={send}
          canSend={hasSomething}
          busy={false}
          label="Write a post"
          hideLabel
          rows={2}
          maxRows={12}
          menu="below"
          offer={FEED_MENTIONS}
          placeholder="Share a paper, a seminar or a question. Type @ to name a colleague."
          prompt="Keep typing a colleague's name, a department or a journal."
          textareaRef={textareaRef}
          toolbar={
            <>
              <input
                ref={fileInput}
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif,application/pdf"
                className="sr-only"
                tabIndex={-1}
                aria-hidden
                onChange={(e) => {
                  choose(e.target.files?.[0])
                  e.target.value = ""
                }}
              />
              <Button kind="quiet" size="sm" type="button" onClick={() => fileInput.current?.click()} title="Add a picture or a PDF">
                <ImagePlus />
                <span className="hidden sm:inline">Picture or PDF</span>
              </Button>
              <Button
                kind="quiet"
                size="sm"
                type="button"
                aria-pressed={linkOpen}
                onClick={() => setLinkOpen((o) => !o)}
                title="Add a link"
              >
                <Link2 />
                <span className="hidden sm:inline">Link</span>
              </Button>
              <PaperPicker papers={papers.data?.results ?? []} loading={papers.isLoading} onPick={setPaper} />
              <Audience value={visibility} onChange={setVisibility} department={department} />
            </>
          }
        />
      </div>

      {(linkOpen || file || paper || fileError) && (
        <div className="space-y-2 sm:pl-13">
          {linkOpen && (
            <Input
              value={link}
              onChange={(e) => setLink(e.target.value)}
              placeholder="https://doi.org/…"
              aria-label="Link"
              inputMode="url"
            />
          )}
          {fileError && <InlineError message={fileError} />}
          {file && (
            <div className="flex items-center gap-3 rounded-md bg-sunken p-2">
              {preview ? (
                <img src={preview} alt="" className="size-14 shrink-0 rounded-sm object-cover" />
              ) : (
                <FileText className="size-5 shrink-0 text-fg-muted" aria-hidden />
              )}
              <span className="min-w-0 flex-1 truncate text-sm">{file.name}</span>
              <Button kind="quiet" size="icon" type="button" onClick={() => setFile(null)} aria-label="Remove the attachment">
                <X />
              </Button>
            </div>
          )}
          {paper && (
            <div className="flex items-center gap-3 rounded-md bg-sunken p-2">
              <FileText className="size-5 shrink-0 text-accent" aria-hidden />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm">{paper.title}</span>
                <Meta className="block truncate text-xs">
                  {[paper.journal_title, paper.publication_year, paper.quartile].filter(Boolean).join(" · ")}
                </Meta>
              </span>
              <Button kind="quiet" size="icon" type="button" onClick={() => setPaper(null)} aria-label="Remove the paper">
                <X />
              </Button>
            </div>
          )}
        </div>
      )}
    </section>
  )
}

/**
 * Who will see it, chosen before posting and not after — a department-only
 * announcement that went to the whole college cannot be taken back out of
 * the forty feeds it already reached.
 */
function Audience({
  value,
  onChange,
  department,
}: {
  value: "EVERYONE" | "DEPARTMENT"
  onChange: (v: "EVERYONE" | "DEPARTMENT") => void
  department: string | null | undefined
}) {
  const options: { key: "EVERYONE" | "DEPARTMENT"; label: string; disabled?: boolean }[] = [
    { key: "EVERYONE", label: "Everybody" },
    { key: "DEPARTMENT", label: department ? `${department} only` : "My department only", disabled: !department },
  ]
  return (
    <div role="radiogroup" aria-label="Who can see it" className="inline-flex max-w-full rounded-md bg-sunken p-0.5">
      {options.map((o) => (
        <button
          key={o.key}
          type="button"
          role="radio"
          aria-checked={value === o.key}
          disabled={o.disabled}
          title={o.disabled ? "Your account has no department set" : undefined}
          onClick={() => onChange(o.key)}
          className={cn(
            "h-6 max-w-44 truncate rounded-sm px-2 text-xs font-medium transition-colors",
            "duration-[var(--dur-1)] ease-out disabled:opacity-50",
            value === o.key ? "bg-surface text-fg" : "text-fg-muted hover:text-fg"
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

function PaperPicker({
  papers,
  loading,
  onPick,
}: {
  papers: PaperOption[]
  loading: boolean
  onPick: (p: PaperOption) => void
}) {
  if (!loading && papers.length === 0) return null
  return (
    <Menu>
      <MenuTrigger asChild>
        <Button kind="quiet" size="sm" type="button" title="Point the post at one of your papers">
          <FileText />
          <span className="hidden sm:inline">My paper</span>
        </Button>
      </MenuTrigger>
      <MenuContent className="max-h-72 w-80 max-w-[90vw] overflow-y-auto">
        {loading ? (
          <MenuItem disabled>Loading your papers…</MenuItem>
        ) : (
          papers.map((p) => (
            <MenuItem key={p.id} onSelect={() => onPick(p)} className="h-auto py-1.5">
              <span className="block truncate">{p.title}</span>
              <span className="block truncate text-xs text-fg-subtle">
                {[p.journal_title, p.publication_year, p.quartile].filter(Boolean).join(" · ")}
              </span>
            </MenuItem>
          ))
        )}
      </MenuContent>
    </Menu>
  )
}

/* ------------------------------------------------------------------------ */
/* A post                                                                    */
/* ------------------------------------------------------------------------ */

/**
 * One post: who, when, for whom, what — and the replies under it.
 *
 * `open` is the post's own page, where every comment is shown; in the feed
 * the last two are, with the rest one click away.
 */
export function PostCard({ post, open = false }: { post: FeedPost; open?: boolean }) {
  const qc = useQueryClient()
  const [commenting, setCommenting] = useState(open)
  const [showAll, setShowAll] = useState(open)
  const [editing, setEditing] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [reporting, setReporting] = useState(false)
  const [hiding, setHiding] = useState(false)

  const like = useMutation<{ liked: boolean; like_count: number }, ApiError, boolean>({
    mutationFn: (next) => api(`/api/feed/posts/${post.id}/like`, { method: next ? "POST" : "DELETE" }),
    onMutate: (next) => {
      patchPost(qc, post.id, (p) => ({ ...p, liked: next, like_count: Math.max(0, p.like_count + (next ? 1 : -1)) }))
    },
    onSuccess: (r) => patchPost(qc, post.id, (p) => ({ ...p, liked: r.liked, like_count: r.like_count })),
    onError: (err, next) => {
      patchPost(qc, post.id, (p) => ({ ...p, liked: !next, like_count: Math.max(0, p.like_count + (next ? -1 : 1)) }))
      toast.fail(err)
    },
  })

  const remove = useMutation<unknown, ApiError, void>({
    mutationFn: () => api(`/api/feed/posts/${post.id}`, { method: "DELETE" }),
    onSuccess: () => {
      patchPost(qc, post.id, () => null)
      toast.ok("Post deleted")
    },
    onError: (err) => toast.fail(err),
  })

  const unhide = useMutation<FeedPost, ApiError, void>({
    mutationFn: () => api<FeedPost>(`/api/feed/posts/${post.id}/unhide`, { method: "POST" }),
    onSuccess: (p) => {
      patchPost(qc, post.id, () => p)
      void qc.invalidateQueries({ queryKey: ["feed-reports"] })
    },
    onError: (err) => toast.fail(err),
  })

  const author = post.author
  const departmentOnly = post.visibility === "DEPARTMENT"
  const pending = post.pending === true

  return (
    <article
      aria-busy={pending}
      className={cn("panel space-y-3 px-3 py-3 sm:px-4", pending && "opacity-70")}
    >
      <header className="flex items-start gap-3">
        <Link to={author ? `/u/${author.id}` : "#"} tabIndex={-1} aria-hidden className="shrink-0">
          <Avatar person={author} size="md" />
        </Link>
        <div className="min-w-0 flex-1">
          <PersonLink id={author?.id} name={author?.name} className="text-base" />
          <Meta className="block text-xs">
            {[author?.designation, author?.department].filter(Boolean).join(" · ")}
            {author?.designation || author?.department ? " · " : ""}
            {pending ? (
              "posting…"
            ) : (
              <Link to={`/discussions/p/${post.id}`} className="hover:underline">
                <Ago iso={post.created_at} />
              </Link>
            )}
            {post.edited_at ? " · edited" : ""}
          </Meta>
          {departmentOnly && (
            <span className="mt-1 inline-flex items-center gap-1 rounded-sm bg-accent-wash px-1.5 py-0.5 text-xs text-fg">
              <Users className="size-3" aria-hidden />
              Only {post.department || "their department"} can see this
            </span>
          )}
        </div>
        {!pending && (
          <PostMenu
            post={post}
            onEdit={() => setEditing(true)}
            onDelete={() => setDeleting(true)}
            onReport={() => setReporting(true)}
            onHide={() => setHiding(true)}
            onUnhide={() => unhide.mutate()}
          />
        )}
      </header>

      {post.hidden && (
        <p className="rounded-md bg-caution-wash px-3 py-2 text-sm text-fg">
          <EyeOff className="mr-1 inline size-3.5 align-[-2px]" aria-hidden />
          Hidden by the administrator{post.hidden_reason ? `: ${post.hidden_reason}` : ""}. Only you
          {post.may_moderate ? " and the author" : ""} can see it.
        </p>
      )}

      {editing ? (
        <EditPost post={post} onDone={() => setEditing(false)} />
      ) : (
        post.body && (
          <div className="whitespace-pre-wrap break-words text-base leading-relaxed">
            {renderBody(post.body, post.mentions)}
          </div>
        )
      )}

      {post.link_url && <LinkCard url={post.link_url} />}
      {post.paper && <PaperCard paper={post.paper} />}
      {post.attachment && <Attachment attachment={post.attachment} />}

      <div className="flex items-center gap-1 border-t border-line pt-2">
        <Button
          kind="quiet"
          size="sm"
          aria-pressed={post.liked}
          disabled={pending}
          onClick={() => like.mutate(!post.liked)}
          className={cn(post.liked && "text-accent hover:text-accent")}
        >
          <Heart className={cn(post.liked && "fill-current")} />
          Like
          {post.like_count > 0 && <span className="tabular">{post.like_count}</span>}
        </Button>
        <Button kind="quiet" size="sm" disabled={pending} onClick={() => setCommenting(true)}>
          <MessageCircle />
          Comment
          {post.comment_count > 0 && <span className="tabular">{post.comment_count}</span>}
        </Button>
      </div>

      {!pending && (
        <Comments post={post} showAll={showAll} onShowAll={() => setShowAll(true)} composing={commenting} />
      )}

      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        danger
        title="Delete this post?"
        description="It goes for everybody, with its comments and likes. This cannot be undone."
        confirmLabel="Delete it"
        onConfirm={async () => {
          await remove.mutateAsync()
        }}
      />
      {reporting && <ReportDialog post={post} onClose={() => setReporting(false)} />}
      {hiding && <HideDialog post={post} onClose={() => setHiding(false)} />}
    </article>
  )
}

function PostMenu({
  post,
  onEdit,
  onDelete,
  onReport,
  onHide,
  onUnhide,
}: {
  post: FeedPost
  onEdit: () => void
  onDelete: () => void
  onReport: () => void
  onHide: () => void
  onUnhide: () => void
}) {
  async function copyLink() {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}/discussions/p/${post.id}`)
      toast.ok("Link copied")
    } catch {
      toast.fail(new Error("Could not copy the link — your browser refused."))
    }
  }

  return (
    <Menu>
      <MenuTrigger asChild>
        <Button kind="quiet" size="icon" aria-label="More about this post" className="-mr-1 -mt-1">
          <MoreHorizontal />
        </Button>
      </MenuTrigger>
      <MenuContent align="end">
        <MenuItem onSelect={() => void copyLink()}>Copy link</MenuItem>
        {post.may_edit && (
          <MenuItem onSelect={onEdit}>
            <Pencil className="size-3.5" aria-hidden /> Edit
          </MenuItem>
        )}
        {post.may_delete && (
          <MenuItem danger onSelect={onDelete}>
            <Trash2 className="size-3.5" aria-hidden /> Delete
          </MenuItem>
        )}
        {!post.may_edit && (
          <MenuItem onSelect={onReport} disabled={post.reported_by_me}>
            <Flag className="size-3.5" aria-hidden />
            {post.reported_by_me ? "Reported" : "Report to the administrator"}
          </MenuItem>
        )}
        {post.may_moderate &&
          (post.hidden ? (
            <MenuItem onSelect={onUnhide}>Show it again</MenuItem>
          ) : (
            <MenuItem danger onSelect={onHide}>
              <EyeOff className="size-3.5" aria-hidden /> Hide from everybody
            </MenuItem>
          ))}
      </MenuContent>
    </Menu>
  )
}

function EditPost({ post, onDone }: { post: FeedPost; onDone: () => void }) {
  const qc = useQueryClient()
  const [text, setText] = useState(post.body)
  const save = useMutation<FeedPost, ApiError, string>({
    mutationFn: (body) => api<FeedPost>(`/api/feed/posts/${post.id}`, { method: "PATCH", json: { body } }),
    onSuccess: (p) => {
      patchPost(qc, post.id, (old) => ({ ...p, comments: old.comments }))
      onDone()
    },
    onError: (err) => toast.fail(err),
  })
  return (
    <div className="space-y-2">
      <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} maxRows={14} aria-label="Edit your post" autoFocus />
      <div className="flex justify-end gap-2">
        <Button kind="quiet" size="sm" onClick={onDone} disabled={save.isPending}>
          Cancel
        </Button>
        <Button kind="primary" size="sm" onClick={() => save.mutate(text.trim())} disabled={save.isPending}>
          {save.isPending ? "Saving…" : "Save"}
        </Button>
      </div>
    </div>
  )
}

function LinkCard({ url }: { url: string }) {
  let host = url
  try {
    host = new URL(url).host.replace(/^www\./, "")
  } catch {
    /* shown as written */
  }
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer nofollow"
      className="flex items-center gap-3 rounded-md bg-sunken px-3 py-2 hover:bg-hover"
    >
      <Link2 className="size-4 shrink-0 text-fg-muted" aria-hidden />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{host}</span>
        <Meta className="block truncate text-xs">{url}</Meta>
      </span>
    </a>
  )
}

/** A paper the author filed, by what it is — never by what it paid. */
function PaperCard({ paper }: { paper: NonNullable<FeedPost["paper"]> }) {
  return (
    <div className="flex items-start gap-3 rounded-md bg-sunken px-3 py-2.5">
      <FileText className="mt-0.5 size-4 shrink-0 text-accent" aria-hidden />
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium">{paper.title}</span>
        <Meta className="block text-xs">
          {[paper.journal_title, paper.publication_year, paper.quartile].filter(Boolean).join(" · ")}
        </Meta>
        {paper.doi && (
          <a
            href={`https://doi.org/${paper.doi}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-accent underline-offset-4 hover:underline"
          >
            doi.org/{paper.doi}
          </a>
        )}
      </span>
    </div>
  )
}

function Attachment({ attachment }: { attachment: NonNullable<FeedPost["attachment"]> }) {
  if (attachment.kind === "image" && attachment.url) {
    return (
      <a href={attachment.url} target="_blank" rel="noopener noreferrer" className="block overflow-hidden rounded-md bg-sunken">
        <img
          src={attachment.url}
          alt={attachment.name ? `Attached: ${attachment.name}` : "Attached picture"}
          loading="lazy"
          decoding="async"
          className="mx-auto max-h-96 w-auto object-contain"
        />
      </a>
    )
  }
  return (
    <a
      href={attachment.url}
      target="_blank"
      rel="noopener noreferrer"
      className="flex items-center gap-3 rounded-md bg-sunken px-3 py-2 hover:bg-hover"
    >
      <FileText className="size-4 shrink-0 text-fg-muted" aria-hidden />
      <span className="min-w-0 flex-1 truncate text-sm">{attachment.name || "Attached PDF"}</span>
      {attachment.size != null && (
        <Meta className="shrink-0 text-xs tabular">{Math.max(1, Math.round(attachment.size / 1024))} KB</Meta>
      )}
    </a>
  )
}

/* ------------------------------------------------------------------------ */
/* Comments                                                                  */
/* ------------------------------------------------------------------------ */

function Comments({
  post,
  showAll,
  onShowAll,
  composing,
}: {
  post: FeedPost
  showAll: boolean
  onShowAll: () => void
  composing: boolean
}) {
  const qc = useQueryClient()
  const inline = post.comments
  const all = useApi<{ results: FeedComment[] }>(["feed-comments", post.id], `/api/feed/posts/${post.id}/comments`, {
    enabled: showAll && !inline,
  })
  const shown = inline ?? (showAll && all.data ? all.data.results : post.comments_preview)
  const hiddenCount = Math.max(0, post.comment_count - shown.length)
  const [confirming, setConfirming] = useState<FeedComment | null>(null)

  const remove = useMutation<unknown, ApiError, FeedComment>({
    mutationFn: (c) => api(`/api/feed/comments/${c.id}`, { method: "DELETE" }),
    onMutate: (c) => changeComments(qc, post.id, (list) => list.filter((x) => x.id !== c.id), -1),
    onError: (err) => {
      toast.fail(err)
      void qc.invalidateQueries({ queryKey: ["feed"] })
      void qc.invalidateQueries({ queryKey: ["feed-post", post.id] })
    },
  })

  if (shown.length === 0 && !composing) return null

  return (
    <div className="space-y-2">
      {hiddenCount > 0 && (
        <button type="button" onClick={onShowAll} className="text-sm text-fg-muted hover:text-fg hover:underline">
          {all.isFetching ? "Loading…" : `View all ${post.comment_count} comments`}
        </button>
      )}
      {shown.length > 0 && (
        <ul className="space-y-2">
          {shown.map((c) => (
            <li key={c.id} className={cn("flex gap-2", c.pending && "opacity-70")}>
              <Avatar person={c.author} size="sm" className="mt-0.5" />
              <div className="min-w-0 flex-1 rounded-lg bg-sunken px-3 py-1.5">
                <div className="flex flex-wrap items-baseline gap-x-2">
                  {c.kind === "HUMAN" ? (
                    <PersonLink id={c.author?.id} name={c.author?.name} className="text-sm" />
                  ) : (
                    <span className="text-sm font-medium">{c.kind === "AGENT" ? "Assistant" : "Recorded"}</span>
                  )}
                  <Meta className="text-xs">
                    {c.pending ? "sending…" : <Ago iso={c.created_at} />}
                    {c.edited_at ? " · edited" : ""}
                  </Meta>
                  {c.may_delete && !c.pending && (
                    <button
                      type="button"
                      onClick={() => setConfirming(c)}
                      className="ml-auto text-xs text-fg-subtle hover:text-critical"
                    >
                      Delete
                    </button>
                  )}
                </div>
                <div className="whitespace-pre-wrap break-words text-sm leading-relaxed">
                  {renderBody(c.body, c.mentions)}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
      {composing && <CommentBox post={post} />}
      <ConfirmDialog
        open={confirming !== null}
        onOpenChange={(o) => !o && setConfirming(null)}
        danger
        title="Delete this comment?"
        description="It goes for everybody. This cannot be undone."
        confirmLabel="Delete it"
        onConfirm={() => {
          if (confirming) remove.mutate(confirming)
          setConfirming(null)
        }}
      />
    </div>
  )
}

/** Change a post's comment list wherever it is held, and its count with it. */
function changeComments(
  qc: QueryClient,
  postId: string,
  fn: (list: FeedComment[]) => FeedComment[],
  delta: number
) {
  patchPost(qc, postId, (p) => ({
    ...p,
    comment_count: Math.max(0, p.comment_count + delta),
    comments_preview: fn(p.comments_preview).slice(-2),
    comments: p.comments ? fn(p.comments) : p.comments,
  }))
  qc.setQueryData<{ results: FeedComment[] }>(["feed-comments", postId], (d) =>
    d ? { results: fn(d.results) } : d
  )
}

function CommentBox({ post }: { post: FeedPost }) {
  const { me } = useAuth()
  const qc = useQueryClient()
  const [text, setText] = useState("")
  const [picked, setPicked] = useState<Candidate[]>([])

  const add = useMutation<FeedComment, ApiError, { body: string; mention_ids: string[]; temp: FeedComment }>({
    mutationFn: ({ body, mention_ids }) =>
      api<FeedComment>(`/api/feed/posts/${post.id}/comments`, { method: "POST", json: { body, mention_ids } }),
    onMutate: ({ temp }) => changeComments(qc, post.id, (list) => [...list, temp], +1),
    onSuccess: (real, { temp }) =>
      changeComments(qc, post.id, (list) => list.map((c) => (c.id === temp.id ? real : c)), 0),
    onError: (err, { temp, body }) => {
      changeComments(qc, post.id, (list) => list.filter((c) => c.id !== temp.id), -1)
      setText(body)
      toast.fail(err)
    },
  })

  function send() {
    const body = text.trim()
    if (!body) return
    const temp: FeedComment = {
      id: `temp-${Date.now()}`,
      post_id: post.id,
      author: meAsAuthor(me),
      kind: "HUMAN",
      body,
      mentions: [],
      created_at: new Date().toISOString(),
      edited_at: null,
      may_edit: false,
      may_delete: false,
      pending: true,
    }
    add.mutate({ body, mention_ids: mentionIds(body, picked), temp })
    setText("")
    setPicked([])
  }

  return (
    <div className="flex gap-2">
      <Avatar person={meAsAuthor(me)} size="sm" className="mt-1 hidden sm:inline-flex" />
      <Composer
        className="min-w-0 flex-1"
        value={text}
        onChange={setText}
        onPick={(c) => setPicked((list) => [...list, c])}
        onSend={send}
        submitOnEnter
        label="Write a comment"
        hideLabel
        rows={1}
        maxRows={8}
        menu="below"
        offer={FEED_MENTIONS}
        sendLabel="Reply"
        placeholder="Write a comment…"
        prompt="Keep typing a colleague's name, a department or a journal."
        autoFocus
      />
    </div>
  )
}

/* ------------------------------------------------------------------------ */
/* Reporting and moderating                                                  */
/* ------------------------------------------------------------------------ */

function ReportDialog({ post, onClose }: { post: FeedPost; onClose: () => void }) {
  const qc = useQueryClient()
  const [reason, setReason] = useState("")
  const report = useMutation<unknown, ApiError, string>({
    mutationFn: (r) => api(`/api/feed/posts/${post.id}/report`, { method: "POST", json: { reason: r } }),
    onSuccess: () => {
      patchPost(qc, post.id, (p) => ({ ...p, reported_by_me: true }))
      toast.ok("Reported to the administrator")
      onClose()
    },
  })
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>Report this post</DialogTitle>
          <DialogDescription>
            The administrator reads it and decides whether to hide it. {post.author?.name || "The author"} is not
            told who reported it.
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <Field label="What is wrong with it">
            <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} maxLength={500} placeholder="It shares somebody's personal details" />
          </Field>
          {report.error && <InlineError message={report.error.message} />}
        </DialogBody>
        <DialogFooter>
          <Button kind="quiet" onClick={onClose}>
            Cancel
          </Button>
          <Button kind="primary" onClick={() => report.mutate(reason.trim())} disabled={report.isPending}>
            {report.isPending ? "Sending…" : "Report it"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function HideDialog({ post, onClose }: { post: FeedPost; onClose: () => void }) {
  const qc = useQueryClient()
  const [reason, setReason] = useState("")
  const hide = useMutation<FeedPost, ApiError, string>({
    mutationFn: (r) => api<FeedPost>(`/api/feed/posts/${post.id}/hide`, { method: "POST", json: { reason: r } }),
    onSuccess: (p) => {
      patchPost(qc, post.id, () => p)
      void qc.invalidateQueries({ queryKey: ["feed-reports"] })
      toast.ok("Hidden. Its author has been told why.")
      onClose()
    },
  })
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>Hide this post from everybody</DialogTitle>
          <DialogDescription>
            It stays visible to its author, with the reason you give here, and you can show it again later.
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <Field label="Reason, as the author will read it">
            <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} maxLength={300} placeholder="Off topic for a college feed" />
          </Field>
          {hide.error && <InlineError message={hide.error.message} />}
        </DialogBody>
        <DialogFooter>
          <Button kind="quiet" onClick={onClose}>
            Cancel
          </Button>
          <Button kind="danger" onClick={() => hide.mutate(reason.trim())} disabled={hide.isPending}>
            {hide.isPending ? "Hiding…" : "Hide it"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function ReportsQueue({ query }: { query: ReturnType<typeof useApi<{ results: Report[] }>> }) {
  const qc = useQueryClient()
  const dismiss = useMutation<unknown, ApiError, string>({
    mutationFn: (id) => api(`/api/feed/reports/${id}/dismiss`, { method: "POST" }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["feed-reports"] })
      toast.ok("Left up. The report is closed.")
    },
    onError: (err) => toast.fail(err),
  })

  if (query.isPending) return <SkeletonRows rows={3} rowHeight={120} />
  if (query.isError) {
    return (
      <ErrorState
        title="Could not load the reports"
        message="The server did not answer. No report has been lost."
        onRetry={() => void query.refetch()}
      />
    )
  }
  const rows = query.data?.results ?? []
  if (rows.length === 0) {
    return (
      <EmptyState
        icon={Flag}
        title="Nothing reported"
        message="When somebody reports a post it waits here for you, with their reason."
      />
    )
  }
  return (
    <div className="space-y-6">
      {rows.map((r) => (
        <div key={r.id} className="space-y-2">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <p className="text-sm">
              <PersonLink id={r.reporter.id} name={r.reporter.name} /> reported this <Ago iso={r.created_at} />:{" "}
              <span className="text-fg-muted">“{r.reason}”</span>
            </p>
            <Button kind="default" size="sm" onClick={() => dismiss.mutate(r.id)} disabled={dismiss.isPending}>
              Leave it up
            </Button>
          </div>
          <PostCard post={r.post} />
        </div>
      ))}
    </div>
  )
}

/* ------------------------------------------------------------------------ */
/* One post, on its own page                                                 */
/* ------------------------------------------------------------------------ */

export function PostPage() {
  const { id } = useParams<{ id: string }>()
  const post = useApi<FeedPost>(["feed-post", id], `/api/feed/posts/${id}`, { enabled: !!id })

  return (
    <div className="page max-w-2xl space-y-4">
      <Button kind="quiet" size="sm" asChild className="-ml-2">
        <Link to="/discussions">
          <ArrowLeft />
          Discussions
        </Link>
      </Button>
      {post.isPending ? (
        <SkeletonRows rows={2} rowHeight={140} />
      ) : post.isError ? (
        <ErrorState
          title={post.error.status === 404 ? "This post is not here" : "Could not load this post"}
          message={
            post.error.status === 404
              ? "It may have been deleted, or it is for a department this account is not in."
              : "The server did not answer. Nothing has been lost."
          }
          onRetry={post.error.status === 404 ? undefined : () => void post.refetch()}
        />
      ) : (
        <PostCard post={post.data} open />
      )}
    </div>
  )
}
