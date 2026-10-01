"""Scrape the college's public website into SCRAPE_DIR (outside the repo).

Writes:
  faculty.json      one row per faculty card (name, designation, department,
                    qualifications, photo file, profile PDF text fields)
  departments.json  name, slug, description, header image, research focus
  photos/<sha>.jpg  400px square JPEGs
  images/           department header images and the college logo

Run:  PYTHONUTF8=1 python scripts/college_site/scrape.py
Nothing here is ever committed: the repository is public.
"""
from __future__ import annotations

import hashlib
import io
import json
import re
import sys

from bs4 import BeautifulSoup
from PIL import Image, ImageOps

from fetch import OUT, get

BASE = "https://saveetha.ac.in/"
DESIG_RE = re.compile(r"professor|lecturer|head|dean|principal|assistant|associate|director|instructor|teaching|fellow|trainer|coordinator", re.I)
EMAIL_RE = re.compile(r"[\w.+-]+@[\w-]+(?:\.[\w-]+)+")


def text(el) -> str:
    return re.sub(r"\s+", " ", el.get_text(" ", strip=True)).strip() if el else ""


def faculty_pages() -> list[str]:
    xml = (get(BASE + "page-sitemap.xml") or b"").decode("utf8", "ignore")
    urls = re.findall(r"https://saveetha\.ac\.in/[^\]<\s]+", xml)
    out = []
    for u in urls:
        if "wp-content" in u:
            continue
        parts = u[len(BASE):].strip("/").split("/")
        if len(parts) == 2 and parts[1].startswith("faculty"):
            out.append(u)
    return sorted(set(out))


def dept_name(soup: BeautifulSoup, slug: str) -> str:
    title = text(soup.find("title"))
    title = re.sub(r"\s*[|\-–]\s*Saveetha.*$", "", title, flags=re.I)
    title = re.sub(r"^Faculty\s*[-–:]?\s*", "", title, flags=re.I).strip()
    if title and title.lower() not in ("faculty", ""):
        return title
    return slug.replace("-amp-", " and ").replace("-", " ").title().replace(" And ", " and ")


def save_photo(url: str) -> str | None:
    data = get(url)
    if not data:
        return None
    try:
        img = ImageOps.exif_transpose(Image.open(io.BytesIO(data))).convert("RGB")
    except Exception:  # noqa: BLE001
        return None
    img = ImageOps.fit(img, (min(400, min(img.size)),) * 2, Image.LANCZOS)
    name = hashlib.sha1(url.encode()).hexdigest()[:16] + ".jpg"
    path = OUT / "photos" / name
    path.parent.mkdir(exist_ok=True)
    if not path.exists():
        img.save(path, "JPEG", quality=85)
    return name


def save_image(url: str, max_side: int = 1600) -> str | None:
    data = get(url)
    if not data:
        return None
    try:
        img = ImageOps.exif_transpose(Image.open(io.BytesIO(data))).convert("RGB")
    except Exception:  # noqa: BLE001
        return None
    img.thumbnail((max_side, max_side))
    name = hashlib.sha1(url.encode()).hexdigest()[:16] + ".jpg"
    path = OUT / "images" / name
    path.parent.mkdir(exist_ok=True)
    if not path.exists():
        img.save(path, "JPEG", quality=82)
    return name


BULLETS = " -,.●•▪"
SECTION_RE = re.compile(r"^\s*([A-Z][A-Z &/()\-]{3,}):?\s*$")


def parse_pdf(url: str) -> dict:
    import pypdf

    data = get(url)
    if not data or not data.startswith(b"%PDF"):
        return {}
    try:
        reader = pypdf.PdfReader(io.BytesIO(data))
        body = "\n".join((p.extract_text() or "") for p in reader.pages[:4])
    except Exception:  # noqa: BLE001
        return {}
    sections: dict[str, list[str]] = {}
    current = "_"
    for line in body.splitlines():
        line = line.replace("", "").replace("•", "").strip()
        if not line:
            continue
        line = re.sub(r"[-]", "", line).strip()
        if not line:
            continue
        m = SECTION_RE.match(line)
        if m and len(line) < 60:
            current = m.group(1).strip().upper()
            continue
        if line.endswith(":") and len(line) < 60:
            # "Ph.Ds AWARDED WITH DETAILS:" -- a heading with a lower-case letter.
            current = line.rstrip(":").strip().upper()
            continue
        sections.setdefault(current, []).append(line)
    out: dict = {}
    for key, lines in sections.items():
        if "SPECIALI" in key or "RESEARCH INTEREST" in key or "AREA" in key:
            out["research_areas"] = [
                l.strip(BULLETS) for l in lines
                if 2 < len(l) < 80 and ":" not in l and l.strip(BULLETS).lower() not in ("nil", "na", "-")
            ][:12]
    m = re.search(r"Scopus ID:\s*(\d{6,})", body)
    if m:
        out["scopus_author_id"] = m.group(1)
    emails = [e for e in EMAIL_RE.findall(body) if "saveetha" in e.lower()]
    if emails:
        out["email"] = emails[0].lower()
    m = re.search(r"Teaching Experience[^:]*:\s*([^\n]+)", body)
    if m:
        out["teaching_experience"] = m.group(1).strip()
    return out


def scrape_faculty_page(url: str) -> tuple[dict, list[dict]]:
    html = get(url)
    if not html:
        return {}, []
    soup = BeautifulSoup(html, "html.parser")
    slug = url[len(BASE):].strip("/").split("/")[0]
    department = dept_name(soup, slug)
    people = []
    for col in soup.select('[data-element_type="column"]'):
        heads = col.find_all("h4", recursive=True)
        imgs = col.find_all("img")
        if len(heads) != 1 or len(imgs) != 1:
            continue
        # Skip columns that contain nested columns (outer wrappers).
        if col.select('[data-element_type="column"]'):
            continue
        name = text(heads[0])
        if not name or len(name) > 80:
            continue
        paras = [text(p) for p in col.find_all("p") if text(p)]
        designation = next((p for p in paras if DESIG_RE.search(p)), "")
        quals = next((p for p in paras if p != designation and re.search(r"\b(M\.|B\.|Ph\.?D|MBA|MCA|M\.?Sc|M\.?E|M\.?Tech)", p)), "")
        a = imgs[0].find_parent("a")
        profile = a["href"] if a and a.get("href", "").lower().endswith(".pdf") else None
        photo_url = imgs[0].get("src")
        row = {
            "name": name,
            "designation": designation,
            "qualifications": quals,
            "department": department,
            "department_slug": slug,
            "source_page": url,
            "photo_url": photo_url,
            "profile_pdf": profile,
        }
        people.append(row)
    return {"slug": slug, "name": department, "faculty_page": url}, people


def scrape_department(slug: str) -> dict:
    url = BASE + slug + "/"
    html = get(url)
    if not html:
        return {}
    soup = BeautifulSoup(html, "html.parser")
    og_img = soup.find("meta", property="og:image")
    og_desc = soup.find("meta", property="og:description") or soup.find("meta", attrs={"name": "description"})
    paras = [text(p) for p in soup.select(".elementor-widget-text-editor p")]
    paras = [p for p in paras if len(p) > 120][:3]
    description = " ".join(paras[:2]) or (og_desc.get("content", "") if og_desc else "")
    image = og_img.get("content") if og_img else None
    if not image:
        # The first content picture that is not a logo: the department banner.
        for img in soup.select(".elementor-widget-image img"):
            src = img.get("src") or ""
            if src and "logo" not in src.lower():
                image = src
                break
    out = {"slug": slug, "url": url, "description": description[:1500], "image_url": image}
    if image:
        out["image_file"] = save_image(image)
    # The department "research" pages list publications and supervisors, not
    # focus areas -- nothing there is a clean research-focus list, so none is kept.
    return out


def main() -> None:
    with_pdfs = "--no-pdf" not in sys.argv
    pages = faculty_pages()
    print(len(pages), "faculty pages", flush=True)
    faculty, departments = [], {}
    for url in pages:
        dept, people = scrape_faculty_page(url)
        if not people:
            print("  no cards:", url, flush=True)
            continue
        departments[dept["slug"]] = dept
        print(f"  {len(people):4d}  {dept['name']}", flush=True)
        faculty.extend(people)
    seen = set()
    unique = []
    for row in faculty:
        key = (row["name"].lower(), row["department_slug"])
        if key in seen:
            continue
        seen.add(key)
        unique.append(row)
    for i, row in enumerate(unique):
        if row["photo_url"]:
            row["photo_file"] = save_photo(row["photo_url"])
        if with_pdfs and row["profile_pdf"]:
            row.update(parse_pdf(row["profile_pdf"]))
        if i % 50 == 0:
            print("  profiles", i, "/", len(unique), flush=True)
            (OUT / "faculty.json").write_text(json.dumps(unique, indent=1, ensure_ascii=False), encoding="utf8")
    for slug, dept in departments.items():
        dept.update(scrape_department(slug))
    logo = save_image("https://saveetha.ac.in/wp-content/uploads/2024/03/sec-logo-01as.png", 800)
    (OUT / "faculty.json").write_text(json.dumps(unique, indent=1, ensure_ascii=False), encoding="utf8")
    (OUT / "departments.json").write_text(json.dumps(list(departments.values()), indent=1, ensure_ascii=False), encoding="utf8")
    print("faculty", len(unique), "photos", sum(1 for r in unique if r.get("photo_file")),
          "departments", len(departments), "logo", logo, flush=True)


if __name__ == "__main__":
    main()
