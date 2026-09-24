"""The Scopus profile workbook: one sheet per person, their papers as Scopus lists them.

Each sheet opens with the person's Scopus author id (row 1), a block of
metrics (total publications, citations, h-index, publications per year), and
a table headed Year / Title / Journal / Document Type / Citations / DOI / EID
/ Publisher / ISSN / Volume. A sheet is tied to a member by that Scopus id,
and each row to a Publication by DOI, then EID, then normalised title -- a
paper OpenAlex never returned becomes a Publication of its own
(`source = "scopus_sheet"`). The member is put on each paper with confidence
0.95: Scopus says they wrote it.
"""

from __future__ import annotations

import re
from typing import Any

from core.models import Publication, User
from core.services.normalize import normalize_doi, normalize_title
from core.services.publications import _Index, ensure_user_authorship


def _text(v: Any) -> str:
    if v is None:
        return ""
    if isinstance(v, float) and v.is_integer():
        v = int(v)
    return str(v).strip()


def read_sheets(path: str) -> list[dict]:
    import openpyxl

    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    sheets = []
    for ws in wb.worksheets:
        scopus_id = ""
        metrics: dict[str, Any] = {}
        header: list[str] | None = None
        rows: list[dict] = []
        for values in ws.iter_rows(values_only=True):
            cells = list(values)
            if header is None:
                if cells and _text(cells[0]) == "Scopus ID" and len(cells) > 1:
                    scopus_id = _text(cells[1])
                for i in range(0, len(cells) - 1):
                    label = _text(cells[i])
                    if label in ("Total Publications", "Total Citations", "H-Index") and label not in metrics:
                        metrics[label] = cells[i + 1]
                if "Title" in [_text(c) for c in cells] and "Year" in [_text(c) for c in cells]:
                    header = [_text(c) for c in cells]
                continue
            row = {header[i]: cells[i] for i in range(min(len(header), len(cells))) if header[i]}
            if not _text(row.get("Title")):
                if rows:
                    break
                continue
            rows.append(row)
        if scopus_id and header:
            sheets.append({"sheet": ws.title, "scopus_id": re.sub(r"\D", "", scopus_id), "metrics": metrics, "rows": rows})
    wb.close()
    return sheets


def import_workbook(path: str) -> dict[str, Any]:
    index = _Index()
    report: dict[str, Any] = {"sheets": []}
    for sheet in read_sheets(path):
        user = User.objects.filter(scopus_author_id=sheet["scopus_id"]).first()
        entry = {"sheet": sheet["sheet"], "scopus_id": sheet["scopus_id"], "rows": len(sheet["rows"]),
                 "user": user.name if user else None, "matched_existing": 0, "created": 0,
                 "sheet_total_publications": sheet["metrics"].get("Total Publications")}
        report["sheets"].append(entry)
        if user is None:
            continue
        for row in sheet["rows"]:
            doi = normalize_doi(_text(row.get("DOI")))
            eid = _text(row.get("EID"))
            eid = eid if eid.startswith("2-s2.0-") else ""
            title = " ".join(_text(row.get("Title")).split())
            key = normalize_title(title)[:512]
            pid = index.find(doi, eid, key)
            if pid:
                pub = Publication.objects.get(id=pid)
                entry["matched_existing"] += 1
                if eid and not pub.eid:
                    pub.eid = eid
                    pub.save(update_fields=["eid"])
            else:
                year = row.get("Year")
                cites = row.get("Citations")
                pub = Publication.objects.create(
                    doi=doi, eid=eid or None, title=title, normalized_title=key,
                    year=int(year) if isinstance(year, (int, float)) else None,
                    venue=_text(row.get("Journal"))[:512], issn=_text(row.get("ISSN"))[:64],
                    type=_text(row.get("Document Type"))[:64], source="scopus_sheet",
                    citations=int(cites) if isinstance(cites, (int, float)) else 0,
                )
                index.add(pub.id, pub.doi, pub.eid, key)
                entry["created"] += 1
            ensure_user_authorship(pub, user, method="scopus_sheet", confidence=0.95)
    return report
