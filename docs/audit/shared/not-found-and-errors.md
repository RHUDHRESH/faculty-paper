# Audit: Not found, not open, and a page that breaks

Built in `frontend2/src/pages/not-found.tsx` (`NotFound`, `RoleGate`), `pages/crash.tsx` (`CrashGuard`), wired in `main.tsx`.

## 1. Who and why
Anybody with a stale link or a mistyped address; a faculty member sent an office link; anybody whose tab is open across a release.

## 2. What it showed before
Screenshot: `img/not-open-before-1440.png`.

| Case | Problem |
|---|---|
| Faculty opens `/payments` | The page loaded, asked the server, and printed the server's sentence: "Only Finance can see or process payments", with a "Try again" button for a refusal no retry changes. It named a desk to someone the college keeps the chain from. |
| Not open (page did not load first) | "Ask the research cell". For faculty "Payments is a real page, but..." named the page. |
| A page fails while drawing | There was no error boundary at all. React removes the whole app on an uncaught error: a white page, no sidebar, no way out. The commonest cause is a release going live while a tab is open. |
| No page at this address | Good; kept (search box, home button). No "Go back". |

## 3. What changed
- `RoleGate`: a faculty member at an address the nav declares for other roles only gets the "Not open to this account" screen before anything loads. It does not name the page for faculty and says "Ask the research office". Offices are not gated; addresses the nav does not list are never blocked.
- `CrashGuard`: "This page could not be drawn" with Reload and Go home; "This page has been updated" for a stale build ("Reload to pick it up"). Plain elements only so the error screen cannot itself break. A link out clears it.
- "Go back" beside "Go to your papers".

## 4. Evidence after
Screenshots `img/not-open-after-1440.png`, `img/not-found-after-1440.png`, `img/not-found-after-390.png`. Tests: `shared-views.test.tsx` (RoleGate for faculty and Finance; CrashGuard stale and ordinary). `node audit/routes.mjs` passes.
