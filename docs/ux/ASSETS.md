# Assets: sources and licences

## Illustrations: `frontend2/public/illustrations/`

All eight illustrations are **original drawings made for this app** in the "Convocation" house
style (see `00-design-language.md` §4). They are dedicated to the public domain under
**CC0 1.0**. No third-party artwork is included, so no attribution is required and there are no
redistribution limits.

| File | Used by (spec) | Plate / ground | Notes |
|---|---|---|---|
| `hero-landing.svg` | 01 sign-in panel | **navy** `--color-brand` only. It uses white/gold ink and is invisible on light grounds. | Portico + rising papers + constellation |
| `empty-papers.svg` | 03 My papers (no record yet) | record wash `#eef2fd` | |
| `empty-search.svg` | 02 Search (no results) | record wash | |
| `scopus-pull.svg` | 04 File a paper, Pull ChoiceTile (120px) | record wash | |
| `celebrate.svg` | 04 filing receipt, 01 Moments | honours wash `#fdf6e3` / cream | |
| `ideas.svg` | 06 Discover empty/feature, 05 Future section | research wash `#e8f6f4` | |
| `network-bridge.svg` | 08 Who to work with (empty), connection help | people wash `#fcefe9` | You → X → Y |
| `empty-messages.svg` | 10 Messages (no thread selected) | people wash | |

Rules for builders:

- Use the files as `<img src="/illustrations/…svg" alt="">` (decorative, with the heading
  carrying the meaning) on a `rounded-3xl` plate of the listed wash.
- In dark mode the plate stays a *light* wash. This is deliberate, because the inks are fixed
  colours. The exception is `hero-landing.svg`, which only ever sits on navy.
- Canvas is 320×200 with a ground line at y=176. New drawings must follow the same grid and the
  three-ink rule.

## Why not unDraw or other packs
unDraw was considered (the brief suggested it). Its licence (read 2026-09-24 at
https://undraw.co/license) allows free commercial use without attribution. However, it
forbids redistributing collections and "automated or manual downloading without consent". It
also restricts compiling assets to replicate a similar service.

Because of that clause, and because the house style needs one consistent hand across empty
states and the existing `ui/art.tsx` spot art, the set was drawn in-house instead. **Nothing
was downloaded.**

If more scenes are needed later, the options are:

- Draw them to the same rules. This is preferred.
- Use an explicitly CC0 set, recording the source URL, licence and date here. Examples are
  Open Doodles (CC0) and Open Peeps (CC0), but check their current licence pages at the time.

## Fonts
| Font | Package | Licence | Status |
|---|---|---|---|
| Inter Variable | `@fontsource-variable/inter` | OFL 1.1 | installed |
| Fraunces Variable | `@fontsource-variable/fraunces` | OFL 1.1 | **to install** (honour moments only, see §2) |

## Icons
Lucide (`lucide-react`, ISC licence) is already installed. Every icon named in the specs was
checked against the installed `lucide-react.d.ts` on 2026-09-24. Note: this version exports
`FilePlusCorner` (not `FilePlus2`), `CloudDownload` (not `DownloadCloud`), and has no `History`
icon.

## Brand
`frontend2/public/brand/emblem*.png` and `wordmark.png` are Saveetha Engineering College marks,
supplied by the college. They are not covered by this CC0 dedication.
