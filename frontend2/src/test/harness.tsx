import type { ReactElement } from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { render, type RenderResult } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"

import { AuthProvider, type Me } from "@/app/auth"
import { ApiError } from "@/lib/api"

/**
 * A page, mounted with the three things every page in this app assumes are
 * above it: a router, a query client and a signed-in account.
 *
 * Without this each test reassembles the same three providers, and the one
 * that forgets `retry: false` on the query client spends two seconds
 * retrying a failure it deliberately caused before the assertion about the
 * error state can run — which reads as a flaky test rather than as a missing
 * option.
 */

export const FACULTY: Me = {
  id: "u-faculty",
  email: "asha@example.edu",
  name: "Dr Asha Menon",
  role: "FACULTY",
  department: "Mechanical Engineering",
}

export const HOD: Me = {
  id: "u-hod",
  email: "head.physics@example.edu",
  name: "Dr Meera Pillai",
  role: "HOD",
  department: "Physics",
}

export const FINANCE: Me = {
  id: "u-finance",
  email: "finance@example.edu",
  name: "R Iyer",
  role: "FINANCE",
  department: null,
}

/** What one endpoint answers. Throw from it to make the request fail. */
export type ApiHandler = (path: string) => unknown

/** Keyed by path prefix, so a query string on the call site does not have to
 *  be repeated in the test. The longest matching prefix wins. */
export type ApiTable = Record<string, ApiHandler>

/**
 * An `api` stand-in built from a table of endpoints.
 *
 * A path with no entry is rejected rather than resolved as `undefined`: an
 * endpoint a test forgot to stub is a hole in the test, and a component that
 * silently renders "0" because of it is exactly the bug this suite is here
 * to catch.
 */
export function fakeApi(table: ApiTable) {
  const prefixes = Object.keys(table).sort((a, b) => b.length - a.length)

  return function fake<T>(path: string): Promise<T> {
    const match = prefixes.find((p) => path.startsWith(p))
    if (!match) {
      return Promise.reject(
        new ApiError(404, `No handler in this test for ${path}`)
      )
    }
    try {
      return Promise.resolve(table[match](path) as T)
    } catch (err) {
      return Promise.reject(err)
    }
  }
}

/** A handler that fails the way a dropped request does. */
export function failing(status = 500, detail = "The server did not answer"): ApiHandler {
  return () => {
    throw new ApiError(status, detail)
  }
}

export function renderWithProviders(
  ui: ReactElement,
  { route = "/" }: { route?: string } = {}
): RenderResult {
  const client = new QueryClient({
    defaultOptions: {
      // A test that provoked a failure should see the error state on the
      // first tick, not after the production retry policy has had its turn.
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  })

  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[route]}>
        <AuthProvider>{ui}</AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>
  )
}
