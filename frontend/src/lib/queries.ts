import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationOptions,
  type UseQueryOptions,
} from "@tanstack/react-query"

import { api } from "@/lib/api"

/**
 * Thin TanStack Query wrappers over the existing api() client.
 *
 * Pages used to hand-roll useState + useEffect + load(), where a failed fetch
 * fell through to the empty state ("No tickets yet") with no way to retry.
 * useApiQuery gives every consumer isError + refetch for free, plus background
 * refetch so two reviewers working the same queue see each other's actions.
 */
export function useApiQuery<T>(
  key: readonly unknown[],
  path: string,
  options?: Omit<UseQueryOptions<T, Error>, "queryKey" | "queryFn">
) {
  return useQuery<T, Error>({
    queryKey: key,
    queryFn: () => api<T>(path),
    ...options,
  })
}

export function useApiMutation<TOut = unknown, TIn = unknown>(
  makePath: (input: TIn) => string,
  method: "POST" | "PATCH" | "PUT" | "DELETE" = "POST",
  options?: UseMutationOptions<TOut, Error, TIn> & { invalidate?: readonly unknown[][] }
) {
  const qc = useQueryClient()
  const { invalidate, ...rest } = options || {}
  return useMutation<TOut, Error, TIn>({
    mutationFn: (input: TIn) =>
      api<TOut>(makePath(input), { method, json: input as unknown }),
    onSuccess: (...args) => {
      for (const key of invalidate || []) qc.invalidateQueries({ queryKey: key })
      rest.onSuccess?.(...args)
    },
    ...rest,
  })
}
