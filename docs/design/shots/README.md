# Design shots: before and after

Twelve views, signed in as each role, at 1440 and 390 px wide, in the light and dark themes.
`before/` is the app at `83575bd` (the last commit before the art direction pass); `after/` is the
foundation commit. Files are named `<view>-<width>-<scheme>.webp`.

| View | Role | Route |
|---|---|---|
| signin | anonymous | `/` |
| faculty-home | Faculty (a real person with 145 papers) | `/` |
| faculty-papers | Faculty | `/papers` |
| faculty-form | Faculty | `/papers/new` |
| research-home | Research cell | `/` |
| research-queue | Research cell | `/clearing` |
| research-review | Research cell | `/review/:claimId` |
| admin-home | Super admin | `/` |
| report | Super admin | `/reports` |
| settings | Super admin | `/settings` |
| principal-home | Principal | `/` |
| director-home | Director | `/` |

Data: a copy of `data/local-full.sqlite3` (real names and photos; never committed). Sessions came
from `manage.py e2e_session --role <ROLE> --json` for the office roles, and a session written
the same way for one real faculty member. One Playwright Chromium, reduced motion on, the
first-run welcome dialog dismissed, a viewport (not full-page) capture after the page settled.
Compare them side by side: same view, same width, same scheme.

To retake a set:

```
cd frontend2
SESS=sessions.json PORT=5170 OUT=shots TAG=after SCHEMES=light,dark WIDTHS=1440,390 \
  node audit/shoot.mjs faculty::/ cell::/clearing admin::/ anon::/
```

`audit/shoot.mjs` is documented at its top (the session file, the `name::route` targets, what it
prints). A server serving a worktree whose `node_modules` is a junction must allow the real
`node_modules` path in `server.fs.allow`, or Vite refuses the font files and every screenshot is
taken in fallback fonts.
