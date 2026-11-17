"""Ready-made reports for the Report studio: a definition each, to open and adjust.

They are ordinary definitions. Whoever opens one runs it through the same
checks as a report they built, so a template that needs a field the reader
may not use (a head of department and anything with money, a stage the
college holds) is simply not offered to them.
"""
from __future__ import annotations

from typing import Any

from core.services import report_engine

TEMPLATES: tuple[dict[str, Any], ...] = (
    {
        "key": "monthly-payment-statement",
        "name": "Monthly payment statement",
        "description": "What was paid each month, by department: the number of payments and the total.",
        "definition": {
            "dataset": "payments",
            "group_by": ["month", "department"],
            "date_bucket": "month",
            "aggregates": [{"fn": "count"}, {"field": "amount", "fn": "sum"}],
            "sort": [{"field": "month", "dir": "desc"}, {"field": "department", "dir": "asc"}],
        },
    },
    {
        "key": "papers-and-snip-by-academic-year",
        "name": "Papers and SNIP by academic year",
        "description": "For each department and academic year: how many papers, and the average SNIP of their journals.",
        "definition": {
            "dataset": "papers",
            "group_by": ["department", "publication_date"],
            "date_bucket": "academic_year",
            "aggregates": [{"fn": "count"}, {"field": "snip", "fn": "avg", "label": "Average SNIP"}],
            "sort": [{"field": "department", "dir": "asc"}, {"field": "publication_date", "dir": "asc"}],
        },
    },
    {
        "key": "quartile-by-department",
        "name": "Quartile distribution by department",
        "description": "How many papers each department has in Q1, Q2, Q3 and Q4 journals.",
        "definition": {
            "dataset": "papers",
            "pivot": {"rows": "department", "columns": "quartile", "value": {"fn": "count"}},
        },
    },
    {
        "key": "top-10-by-snip",
        "name": "Top 10 papers by SNIP",
        "description": "The ten papers in journals with the highest SNIP.",
        "definition": {
            "dataset": "papers",
            "columns": ["title", "faculty", "department", "journal", "quartile", "snip"],
            "filters": [{"field": "snip", "op": "not_empty"}],
            "sort": [{"field": "snip", "dir": "desc"}],
            "top_n": 10,
        },
    },
    {
        "key": "top-10-by-amount",
        "name": "Top 10 claims by amount",
        "description": "The ten claims with the largest amounts.",
        "definition": {
            "dataset": "claims",
            "columns": ["claim_no", "claimant", "department", "paper", "status", "amount"],
            "filters": [{"field": "amount", "op": "not_empty"}],
            "sort": [{"field": "amount", "dir": "desc"}],
            "top_n": 10,
        },
    },
    {
        "key": "top-10-by-papers",
        "name": "Top 10 faculty by number of papers",
        "description": "The ten people with the most papers, with their citations and h-index.",
        "definition": {
            "dataset": "faculty",
            "columns": ["name", "department", "designation", "papers_total", "citations", "h_index"],
            "sort": [{"field": "papers_total", "dir": "desc"}],
            "top_n": 10,
        },
    },
    {
        "key": "faculty-with-no-paper-this-year",
        "name": "Faculty with no paper this year",
        "description": "Everyone with no paper dated this calendar year, and when they last published.",
        "definition": {
            "dataset": "faculty",
            "columns": ["name", "staff_id", "department", "designation", "papers_total", "last_paper_date"],
            "filters": [{"field": "papers_this_year", "op": "eq", "value": 0}],
            "sort": [{"field": "department", "dir": "asc"}, {"field": "name", "dir": "asc"}],
        },
    },
    {
        "key": "claims-waiting-by-stage",
        "name": "Claims waiting, by stage and age",
        "description": "For each stage: how many claims are waiting, and the average and longest wait in days.",
        "definition": {
            "dataset": "claims",
            "filters": [{"field": "days_waiting", "op": "not_empty"}],
            "group_by": ["stage"],
            "aggregates": [
                {"fn": "count"},
                {"field": "days_waiting", "fn": "avg", "label": "Average days waiting"},
                {"field": "days_waiting", "fn": "max", "label": "Longest wait in days"},
            ],
            "sort": [{"field": "max_days_waiting", "dir": "desc"}],
        },
    },
    {
        "key": "scopus-link-coverage",
        "name": "Scopus link coverage by department",
        "description": "How many people in each department have their Scopus profile linked, and how many do not.",
        "definition": {
            "dataset": "faculty",
            "pivot": {"rows": "department", "columns": "scopus_linked", "value": {"fn": "count"}},
        },
    },
    {
        "key": "fyp-teams-with-publications",
        "name": "Final-year project teams with publications",
        "description": "The teams that produced an article, with their mentor, students and DOI.",
        "definition": {
            "dataset": "teams",
            "filters": [{"field": "article_title", "op": "not_empty"}],
            "sort": [{"field": "department", "dir": "asc"}, {"field": "team", "dir": "asc"}],
        },
    },
    {
        "key": "payments-month-on-month",
        "name": "Payments, month on month",
        "description": "The total paid in each month, as a trend.",
        "definition": {
            "dataset": "payments",
            "group_by": ["month"],
            "date_bucket": "month",
            "aggregates": [{"field": "amount", "fn": "sum", "label": "Total paid"}, {"fn": "count", "label": "Payments"}],
            "sort": [{"field": "month", "dir": "asc"}],
        },
    },
)


def for_user(user) -> list[dict[str, Any]]:
    """The templates this person can run, each with its definition checked and normalised."""
    out = []
    for t in TEMPLATES:
        try:
            checked = report_engine.plan(user, t["definition"])
        except report_engine.ReportError:
            continue
        out.append({
            "key": t["key"], "name": t["name"], "description": t["description"],
            "dataset": checked.dataset.key, "definition": checked.definition,
        })
    return out
