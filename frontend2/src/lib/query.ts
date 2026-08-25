import {
  QueryClient,
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryOptions,
} from "@tanstack/react-query"

import { api, ApiError } from "@/lib/api"

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      // One retry, and never on a refusal: 401/403/404 will not become 200
      // by asking again, and retrying them just delays the honest answer.
      retry: (count, error) =>
        error instanceof ApiError && error.status < 500 ? false : count < 1,
      refetchOnWindowFocus: false,
    },
  },
})

export function useApi<T>(
  key: readonly unknown[],
  path: string,
  options?: Partial<UseQueryOptions<T, ApiError>>
) {
  return useQuery<T, ApiError>({
    queryKey: key,
    queryFn: () => api<T>(path),
    ...options,
  })
}

/** A write, with the keys it invalidates named at the call site. */
export function useApiMutation<TBody, TResult = unknown>(
  path: string | ((body: TBody) => string),
  options: { method?: string; invalidates?: readonly unknown[][] } = {}
) {
  const qc = useQueryClient()
  return useMutation<TResult, ApiError, TBody>({
    mutationFn: (body) =>
      api<TResult>(typeof path === "function" ? path(body) : path, {
        method: options.method || "POST",
        json: body,
      }),
    onSuccess: () => {
      for (const key of options.invalidates || []) {
        void qc.invalidateQueries({ queryKey: key })
      }
    },
  })
}
