# UI audit harness

Puppeteer scripts that walk the app the way a reviewer would. They need the
local stack running (`backend` on :8000, `frontend` on :5173) and the demo
passwords from `manage.py seed`.

| script | what it checks |
|---|---|
| `audit.mjs` | every page, as the role that owns it: crashes, failed requests, text a user should never see (`undefined`, `NaN`, mojibake), controls with no accessible name, unlabelled fields, duplicate ids, viewport overflow, page titles |
| `responsive.mjs` | the same pages at 390px and 1440px, in light and dark, for overflow and WCAG contrast |
| `flow-wizard.mjs` | the claim wizard end to end: the confirmation gate, prefilled identity, per-step validation, the estimate, back-preserves-work, autosave |
| `flow-search.mjs` | that a queue search reaches the server rather than filtering the page on screen, and resets pagination |
| `flow-empty.mjs` | that a search with no matches says so, instead of claiming the account is empty |

```bash
node audit/audit.mjs              # all pages
node audit/audit.mjs finance      # only pages whose name/path matches
node audit/responsive.mjs
node audit/flow-wizard.mjs
```

`pages.mjs` is the inventory. Keep it in step with the routes in `App.tsx` —
two paths in it were wrong when it was written, and the audit reported the
resulting 404s as "generic page title" rather than "this page does not exist".

`shots.mjs` writes a full-page screenshot of every page to `audit/shots/`
(git-ignored). `W`, `THEME` and `SUFFIX` env vars vary the capture:

```bash
node audit/shots.mjs                       # desktop, light
W=390 THEME=dark SUFFIX=-dark node audit/shots.mjs
```

`mojibake.py` finds text that was UTF-8, read as cp1252, and written back —
"₹" as "â‚¹", "→" as "â†'". It tests by decoding rather than matching a list,
so it catches sequences nobody thought to grep for. `--fix` repairs in place.

## Rebuilding from the ERP workbook

`backend/core/management/commands/rebuild_from_erp.py` loads the workbook into
the models that actually drive the app, and refuses to finish if its own total
disagrees with the sheet.

```bash
python manage.py rebuild_from_erp ../data/Publication_Processing_ERP_V3.0.xlsx \
    --confirm --credentials-out ../faculty-credentials.csv
```

Two traps in the workbook, both found by `audit/check_shift.py` and
`audit/why_unmatched.py`:

- The newest 406 rows of `Master_List_Accounts` carry six extra columns. In
  those rows the column headed **Amount holds the author count**, and the payout
  is the last trailing column — reading the header loses **Rs 27,29,099**. That
  block also shows the ERP's own working, `(SNIP x 55000 + QF) x APP`, which
  reconciles with the recorded payout on 350 of 406 rows and independently
  confirms the Step 8 formula.
- 267 ledger rows name staff who are not in `Faculty_Data` — 58 people who have
  since left. Each keeps their own inactive record rather than being folded into
  one holding account, which would put a false name on real payments.

`audit/erp_truth.py` prints what the workbook contains and
`audit/verify_rebuild.py` checks the app against it.
