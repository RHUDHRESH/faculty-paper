import type { InfiniteData, QueryClient } from "@tanstack/react-query"

import type { FeedPost } from "@/pages/feed"

type FeedPage = { tab: string; results: FeedPost[]; next: string | null }
type ForYouPage = { items: { kind: string; post?: FeedPost }[] }

/**
 * Apply `fn` to a post in every cache that holds it: each feed tab, "For
 * you", the post's own page, and the profile it appears on. Return null to
 * remove it.
 *
 * Without this a like made on the Everyone tab is gone again on the post's
 * own page until it refetches, which reads as the like not having worked.
 */
export function patchPost(qc: QueryClient, id: string, fn: (p: FeedPost) => FeedPost | null) {
  const apply = (list: FeedPost[]) => list.flatMap((p) => (p.id === id ? (fn(p) ?? []) : [p]))
  qc.setQueriesData<InfiniteData<FeedPage>>({ queryKey: ["feed"] }, (data) =>
    data && Array.isArray(data.pages)
      ? { ...data, pages: data.pages.map((page) => ({ ...page, results: apply(page.results) })) }
      : data
  )
  qc.setQueriesData<ForYouPage>({ queryKey: ["for-you"] }, (data) =>
    data && Array.isArray(data.items)
      ? {
          ...data,
          items: data.items.flatMap((item) => {
            if (item.kind !== "post" || !item.post || item.post.id !== id) return [item]
            const next = fn(item.post)
            return next ? [{ ...item, post: next }] : []
          }),
        }
      : data
  )
  qc.setQueriesData<FeedPost>({ queryKey: ["feed-post", id] }, (p) => (p ? (fn(p) ?? p) : p))
  qc.setQueriesData<{ posts?: FeedPost[] }>({ queryKey: ["person"] }, (d) =>
    d && Array.isArray(d.posts) ? { ...d, posts: apply(d.posts) } : d
  )
}

export function prependPost(qc: QueryClient, post: FeedPost, keys: readonly (readonly unknown[])[]) {
  for (const key of keys) {
    qc.setQueryData<InfiniteData<FeedPage>>(key, (data) => {
      if (!data || data.pages.length === 0) return data
      const [first, ...rest] = data.pages
      return { ...data, pages: [{ ...first, results: [post, ...first.results] }, ...rest] }
    })
  }
}
