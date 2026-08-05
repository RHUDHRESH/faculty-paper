# Mentor verification — S. Joyal Isac (Saveetha Engineering College)

Verified against public web sources (Google Scholar, Scopus/ORCID citations, Crossref, Indian Scientist Awards profile, LinkedIn) and exercised on **live** production API `https://faculty-paper-api.onrender.com` (2026-07-30).

## Identity

| Field | Value |
| --- | --- |
| Name | **S. Joyal Isac** / Joyal Isac / JOYAL ISAC S |
| Role | Assistant Professor, EEE (also listed publicly as ERP-related faculty at Saveetha) |
| College | Saveetha Engineering College, Chennai |
| Email | joyalisac@saveetha.ac.in |
| Google Scholar | https://scholar.google.co.in/citations?user=nWxnn9cAAAAJ |
| Scopus Author ID | **57983494200** (~27 docs, ~167 cites, h-index ~8) |
| ORCID | https://orcid.org/0000-0002-8611-1865 |
| Focus | Power systems, power quality, UPQC, DFIG/PMSG renewables, fuzzy / PSO / swarm optimization |

## Papers used in live API tests

### Book / proceedings chapters (Scopus linked)

| Year | Title | DOI |
| --- | --- | --- |
| 2022 | Fuzzy Controlled Multi-converter-UPQC for Power Quality Improvement in Distribution System | `10.1007/978-981-16-9239-0_1` |
| 2014 | Optimal Capacitor Placement in Radial Distribution System… (Fuzzy + Hybrid PSO) | `10.1007/978-81-322-2119-7_128` |
| 2019 | Improvement of LVRT Capability of Grid-Connected DFIG WTs Using Fuzzy Logic Controller | `10.1007/978-981-13-2182-5_33` |
| 2022 | PMSG based WECS: Control techniques, MPPT methods… (AIP) | title match (DOI optional) |

### Journal (Crossref + Scopus linked)

| Year | Title | DOI |
| --- | --- | --- |
| 2023 | Multi-Converter UPQC Optimization for Power Quality Improvement Using Beetle Swarm-Based Butterfly Optimization Algorithm | `10.1080/15325008.2023.2210575` |

Other Crossref hits attributed to the same author family (not all exercised end-to-end): e.g. `10.3390/smartcities9060102` (2026, federated urban energy), `10.1109/iccsp60870.2024.10543326` (street-light monitoring).

## Live backend results (production)

### Enrich / verify / calculate (mentor Scopus `57983494200`)

- Health, faculty login, profile Scopus author id: **PASS**
- Enrich for all 4 chapter/proceeding titles: **PASS** (SNIP resolved; Scimago quartile often null for book series — expected)
- Scopus verify indexed + **linked** to mentor author id: **PASS** on all 4
- Remuneration calculate: **PASS** (e.g. rem ≈ ₹39 081 / ₹46 435 / ₹41 622 depending on SNIP)

### Journal path

- Enrich DOI `10.1080/15325008.2023.2210575` → journal *Electric Power Components and Systems*, SNIP **0.815**: **PASS**
- Scopus verify with correct Butterfly Optimization title → indexed + linked: **PASS**
- Submit ticket **FP-2026-000003**, rem **₹52 377.50**, `verification_ok=True`: **PASS**

### Full ticket lifecycle (live Neon data)

| Ticket | Paper | Flow |
| --- | --- | --- |
| **FP-2026-000002** | Fuzzy Multi-converter-UPQC (2022) | SUBMITTED → HoD → Principal → **PAID** (₹39 081) |
| **FP-2026-000003** | Multi-Converter UPQC journal (2023) | SUBMITTED → HoD → Principal → **PAID** (₹52 377.50) |

Prior-check after claim correctly returns `warning: true` for the journal DOI.

**Fails: 0** — no backend/frontend code changes required; no redeploy.

## Product notes for mentor demos

1. Faculty profile should carry Scopus Author ID `57983494200` for author-link verification.
2. Book-series venues (LNEE / AISC / AIP) often lack SCImago quartile — faculty picks Q1–Q4 (or contest-forwards with a note).
3. Contest flag only sticks when verification **issues** exist; clean Scopus link → normal SUBMIT, not contest.
4. Demo HoD is CSE-scoped — faculty department must be CSE for that HoD to see tickets in the demo tenants.
