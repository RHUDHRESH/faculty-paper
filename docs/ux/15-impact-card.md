# 15 · Impact card: something people are proud to share

Area: **honours**. Route: `/impact` (`pages/impact.tsx`). The server renders the image at
`/api/me/impact/card.png?format=`. The public link is `/share/impact/{token}`.

## What the walk found
- The card is a navy rectangle with a thin gold left bar, a yellow pill "#1 in S&H-ENGLISH",
  three huge numbers and "Best published in …".
- It reads like a slide, not a keepsake. There is no photo, no emblem and no visual story.
- **It says 20 papers, while Home and My research say 10.** A card that disagrees with the app
  is not something anyone will share. Fixing the source (spec 01) is a precondition.
- It offers only two formats (1200×627 and 1080×1080), and it has no Story (9:16) format.

## Design: "The Certificate"
Spotify Wrapped works because the user is the main character and there is **one surprising,
specific stat**, not a table. A college certificate works because of its crest, its paper and
its signature. The card combines the two:

```
1080×1350 (portrait, default) — also 1080×1920 story, 1200×627 LinkedIn, 1080×1080 square
┌──────────────────────────────────────────────┐
│▓▓▓▓▓▓▓▓▓▓ gold ribbon 12px ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓│
│ [emblem 72]  SAVEETHA ENGINEERING COLLEGE    │  navy ground, fine guilloché
│              Research Impact · 2026           │  pattern (SVG, 4% white lines)
│                                               │
│            ◯ photo 280 (or monogram           │  gold double ring around photo
│              in Fraunces on navy wash)        │
│                                               │
│        Dr. R. Subhashini                      │  Fraunces 72, white
│        Assistant Professor (SG) · English     │  Inter 32, 80% white
│                                               │
│   ┌ THE HEADLINE STAT (one, chosen) ─────────┐│  cream plate, navy text
│   │  #1                                       ││  Fraunces 160
│   │  in S&H-English this academic year        ││
│   └───────────────────────────────────────────┘│
│    20 papers    ·   2 in Q1   ·   46 citations │  Inter 40 tabular, gold dots
│    ▁▂▃▅▇ Record strip (years, gold cells)      │
│                                               │
│  "Writes about English-language assessment    │  headline, Inter italic 30
│   with machine learning."                     │
│                                               │
│  verify: sec.edu/i/7Kx2  · QR 120             │  QR → public share link
│▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓│
└──────────────────────────────────────────────┘
```

**Headline stat selection.** The server picks the most flattering *true* stat, in this
priority order:

1. A dept rank of #1 to #3
2. A college rank in the top 10%
3. A first Q1 paper this year
4. Citations growth of 50% or more
5. Most papers in a year, as a personal best
6. The fallback: total papers

The user can switch between up to 4 eligible headlines ("Pick your headline").

**Themes.** There are three themes, all on-brand:

- **Navy** (default)
- **Cream**: cream paper with navy ink and a gold ribbon, the certificate look
- **Midnight**: dark navy with gold foil-like gradient type

## Page IA
```
DESKTOP
┌ HeroBand area=honours ──────────────────────────────────────────────────────────────┐
│ Your impact card                                                                      │
│ "Made from your record. It never shows money, your staff id or how to reach you."    │
├ Left 60%: live preview (SharePlate, drop shadow `lift`, 500ms reveal) ───────────────┤
│                                   │ Right 40%: controls                              │
│   [ card preview, scaled ]        │ Format: [Portrait][Story][LinkedIn][Square]      │
│                                   │ Theme:  (● Navy) (○ Cream) (○ Midnight) swatches │
│                                   │ Headline: ◉ #1 in S&H-English ○ 46 citations …   │
│                                   │ Show: ☑ photo ☑ record strip ☑ QR  ☑ headline    │
│                                   │ [⬇ Download PNG]  [Share ▾]                     │
│                                   │   Share ▾: LinkedIn · WhatsApp · X · Copy link   │
│                                   │ Public link: ( ) off  — explains what's visible  │
└───────────────────────────────────┴───────────────────────────────────────────────────┘
PHONE: preview first (fits width), controls below; Share uses navigator.share with
the PNG file when available (native share sheet → WhatsApp/Instagram Story).
```

## Interactions
- Every control updates the preview immediately. The preview is an SVG/HTML rendering of the
  same layout. **Download** fetches the server PNG with identical parameters, so what you see is
  what you get.
- **Share** uses `navigator.share({files:[png]})` where supported. Otherwise it offers intent
  URLs: LinkedIn `https://www.linkedin.com/sharing/share-offsite/?url=`, WhatsApp
  `https://wa.me/?text=`, and X `https://twitter.com/intent/tweet?url=&text=`. Each carries
  the **public link**, whose OG image is the card, so the post shows the card.
- **Sharing requires the public link.** Choosing a share target while the link is off shows a
  confirm: "Turn on your public link? Anyone with it sees this card — nothing else." The link
  is turned on only after confirmation (existing toggle).
- **QR / verify line** points to the public link. Scanning it shows the live card with a
  "Verified by Saveetha Engineering College" line and the date. This makes the card credible.
- **Once a year (June)**, a "Your year in research" story sequence of 5 slides is offered from
  Home Moments: papers, top venue, most-cited paper, co-authors map and the headline. It uses
  the same renderer with `format=story&slide=n`. This is optional (phase 2).

## Copy
- Sub-line: "Made from your record. It never shows money, your staff id or how to reach you."
- Headline picker label: "Pick your headline".
- Public-link help: "Anyone with the link sees this card and a 'Verified by Saveetha' line.
  Turn it off and the link stops working at once." (Existing.)
- Low data (0 papers matched): "Your card fills in once your record is matched. [Check my
  record]". The preview shows a greyed sample card with "Sample" diagonal text.
- Share text default: "My research impact at Saveetha Engineering College — {headline}."

## Data
- Existing endpoints: `/api/me/impact`, `/api/me/impact/card.png`, `/api/me/impact/share`,
  and the `/api/share/impact/{token}` endpoints (public link and PNG).
- **NEW params:** `card.png?format=portrait|story|linkedin|square&theme=navy|cream|midnight&headline={key}&photo=1&strip=1&qr=1`.
- **NEW:** `/api/me/impact` adds `headlines:[{key,big,label,priority}]`, `strip`, `headline_text`
  and `photo_url`. Paper counts come from the **same source** as Home (spec 01).
- The public share page must emit `og:image` pointing at the token PNG in LinkedIn format.

## Acceptance
- [ ] The card figures equal Home and My research for the same user (the 20-vs-10 bug is
      gone).
- [ ] 4 formats, 3 themes, a headline picker and element toggles. The preview matches the
      downloaded PNG pixel-for-pixel in layout.
- [ ] Crest, photo/monogram, gold ribbon, Record strip and QR are all present in the default
      card.
- [ ] Share works natively on mobile and via intent URLs on desktop. Sharing asks before
      enabling the public link.
- [ ] The public link page shows "Verified by Saveetha Engineering College" and has a correct
      OG preview.
