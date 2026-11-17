"""Standings: everybody's three numbers, the papers behind them, and who may see which.

Synthetic people and papers only. What is pinned:

- a person's totals are the sums of the papers listed behind them, for every
  person and every period (they come from one pass);
- the Top 5 is the first five of the standings, for each measure and period;
- month, academic year and calendar year are by month paid, and the edges
  (31 May / 1 June, December / January) fall on the right side;
- a paper repeated under the same title counts once, a voided payment counts
  for nothing;
- a head sees their department and no incentive, ever; faculty see themselves;
- the existing table export carries the rows and nothing more.
"""

from __future__ import annotations

import csv
import io
import json
from datetime import date
from unittest.mock import patch

from django.core.cache import cache
from django.test import Client, TestCase

from core.models import Claim, ClaimStatus, PaidLedger, Role, User
from core.services import rbac, top5
from core.test_search import money_keys_in

TODAY = date(2026, 9, 24)  # academic year 2026-27 began on 1 June 2026


class _Standings(TestCase):
    def setUp(self):
        cache.clear()
        patcher = patch("core.services.top5.today", return_value=TODAY)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.asha = self._user("asha", "ECE", "TSEC001")
        self.ravi = self._user("ravi", "ECE", "TSEC002")
        self.mina = self._user("mina", "CSE", "TSCS001")
        self.nobody = self._user("nobody", "CSE", "TSCS002")
        self.head = self._user("head", "CSE", "TSCS900", role=Role.HOD)
        self.client = Client()

    def _user(self, name, dept, staff_id=None, role=Role.FACULTY):
        return User.objects.create_user(
            email=f"{name}@x.edu", password=None, name=name.title(), role=role,
            department=dept, staff_id=staff_id, designation="Professor",
        )

    def _office(self, role=Role.PRINCIPAL):
        found = User.objects.filter(email=f"{role.lower()}@x.edu").first()
        return found or User.objects.create_user(
            email=f"{role.lower()}@x.edu", password=None, name=role.title(), role=role
        )

    def _row(self, staff, title, amount, *, snip="1.5", month=date(2026, 8, 1),
             kind=PaidLedger.Kind.PAYMENT, claim=None, cycle=1, **extra):
        raw = {"SNIP Value": snip} if snip is not None else {}
        return PaidLedger.objects.create(
            staff_id=staff, paper_title=title, amount=amount, payout_month=month, kind=kind,
            claim=claim, cycle=cycle, raw_json=json.dumps(raw), **extra,
        )

    def _get(self, viewer, path="/api/dashboard/standings", expect=200, **params):
        self.client.force_login(viewer)
        res = self.client.get(path, params)
        self.assertEqual(res.status_code, expect, res.content[:300])
        return res.json()

    def _papers(self, viewer, person, expect=200, **params):
        return self._get(viewer, f"/api/dashboard/standings/{person.pk}/papers", expect, **params)

    def _by_name(self, body):
        return {r["name"]: r for r in body["rows"]}


class Totals(_Standings):
    def setUp(self):
        super().setUp()
        self._row("TSEC001", "Deep Nets: A Study", 1000, snip="2", month=date(2026, 7, 1))
        self._row("TSEC001", "deep nets a study", 500, snip="2", month=date(2026, 9, 1))  # the same paper again
        self._row("TSEC001", "A count only paper", 0, snip="1.25", month=date(2026, 9, 1))
        self._row("TSEC002", "Ravi one", 3000, snip="N/A", month=date(2026, 9, 1))
        self._row("TSCS001", "Mina one", 2000, snip="3.5", month=date(2025, 7, 1))
        self.viewer = self._office()

    def test_every_total_is_the_sum_of_its_papers_in_every_period(self):
        for params in (
            {}, {"period": "month"}, {"period": "month", "month": "2026-07"},
            {"period": "year"}, {"period": "year", "year": 2025},
            {"period": "year", "academic": "false", "year": 2026},
        ):
            body = self._get(self.viewer, page_size=100, **params)
            self.assertTrue(body["rows"], params)
            for row in body["rows"]:
                if not row["count"] and not row["remuneration"]:
                    continue
                papers = self._papers(self.viewer, self.mina if row["name"] == "Mina" else User.objects.get(pk=row["user_id"]), **params)
                got = papers["totals"]
                self.assertEqual(round(sum(p["snip"] for p in papers["papers"]), 2), row["snip"], (params, row["name"]))
                self.assertEqual(round(sum(p["amount"] for p in papers["papers"]), 2), row["remuneration"], (params, row["name"]))
                self.assertEqual(sum(1 for p in papers["papers"] if p["counted"]), row["count"], (params, row["name"]))
                self.assertEqual(got, {"snip": row["snip"], "remuneration": row["remuneration"], "count": row["count"]})

    def test_college_totals_are_the_sum_of_the_rows(self):
        body = self._get(self.viewer, page_size=100)
        self.assertEqual(body["totals"]["count"], sum(r["count"] for r in body["rows"]))
        self.assertEqual(body["totals"]["remuneration"], sum(r["remuneration"] for r in body["rows"]))
        self.assertEqual(body["totals"]["snip"], round(sum(r["snip"] for r in body["rows"]), 2))

    def test_the_definitions_are_the_top_five_definitions(self):
        rows = self._by_name(self._get(self.viewer, page_size=100))
        # One paper twice (counted once, both payments paid), plus a count-only paper.
        self.assertEqual((rows["Asha"]["count"], rows["Asha"]["remuneration"], rows["Asha"]["snip"]), (2, 1500, 3.25))
        # A SNIP that is not a number adds nothing.
        self.assertEqual((rows["Ravi"]["count"], rows["Ravi"]["snip"]), (1, 0))

    def test_duplicates_are_listed_and_counted_once(self):
        papers = self._papers(self.viewer, self.asha)["papers"]
        self.assertEqual(len(papers), 3)
        repeat = [p for p in papers if p["duplicate_of"]]
        self.assertEqual(len(repeat), 1)
        self.assertEqual(repeat[0]["duplicate_of"], "Deep Nets: A Study")
        self.assertFalse(repeat[0]["counted"])
        self.assertEqual(repeat[0]["snip"], 0)
        self.assertEqual(repeat[0]["amount"], 500)  # the money was paid
        self.assertEqual(sum(1 for p in papers if p["counted"]), 2)

    def test_a_row_says_where_its_snip_came_from(self):
        claim = Claim.objects.create(
            owner=self.nobody, status=ClaimStatus.PAID, paper_title="App paper", remuneration=700,
            snip=2.5, payout_month=date(2026, 9, 1),
        )
        sheet = self._papers(self.viewer, self.asha)["papers"]
        self.assertEqual({p["snip_source"] for p in sheet if p["counted"]}, {"settled sheet"})
        paid = self._papers(self.viewer, self.nobody)["papers"]
        self.assertEqual([(p["snip_source"], p["snip"], p["counted_in"]) for p in paid], [("claim", 2.5, "paid")])
        none = self._papers(self.viewer, self.ravi)["papers"]
        self.assertEqual([(p["snip_source"], p["snip"]) for p in none], [("none", 0)])
        count_only = [p for p in sheet if p["title"] == "A count only paper"][0]
        self.assertEqual(count_only["counted_in"], "count only")
        del claim

    def test_an_app_payment_on_the_ledger_takes_its_snip_from_the_claim(self):
        claim = Claim.objects.create(
            owner=self.nobody, status=ClaimStatus.PAID, paper_title="Paid in the app", remuneration=900,
            snip=4.0, payout_month=date(2026, 9, 1),
        )
        PaidLedger.objects.create(
            claim=claim, payout_month=date(2026, 9, 1), amount=900, staff_id="TSCS002", paper_title="Paid in the app",
        )
        paper = self._papers(self.viewer, self.nobody)["papers"]
        self.assertEqual([(p["snip"], p["snip_source"]) for p in paper], [(4.0, "claim")])

    def test_a_voided_payment_is_not_counted_and_is_listed_aside(self):
        claim = Claim.objects.create(owner=self.asha, status=ClaimStatus.CLEARED, paper_title="Voided", snip=3)
        self._row("TSEC001", "Voided", 5000, claim=claim, month=date(2026, 9, 1))
        self._row("TSEC001", "Voided", -5000, claim=claim, kind=PaidLedger.Kind.REVERSAL, month=date(2026, 9, 1))
        body = self._papers(self.viewer, self.asha)
        self.assertNotIn("Voided", [p["title"] for p in body["papers"]])
        self.assertEqual(body["totals"]["remuneration"], 1500)
        self.assertEqual([(v["title"], v["amount"]) for v in body["voided"]], [("Voided", 5000)])
        self.assertEqual(self._by_name(self._get(self.viewer, page_size=100))["Asha"]["remuneration"], 1500)

    def test_people_with_nothing_are_found_and_read_as_zero_without_a_rank(self):
        body = self._get(self.viewer, q="nobody")
        row = body["rows"][0]
        self.assertEqual((row["snip"], row["remuneration"], row["count"]), (0, 0, 0))
        self.assertEqual((row["rank_snip"], row["rank_remuneration"], row["rank_count"]), (None, None, None))

    def test_search_by_staff_id_and_name(self):
        self.assertEqual([r["name"] for r in self._get(self.viewer, q="tscs001")["rows"]], ["Mina"])
        self.assertEqual({r["name"] for r in self._get(self.viewer, q="as")["rows"]}, {"Asha"})

    def test_sort_and_pages(self):
        body = self._get(self.viewer, sort="remuneration", page_size=2)
        self.assertEqual([r["name"] for r in body["rows"]], ["Ravi", "Mina"])
        self.assertEqual((body["total"], body["page"], body["page_size"]), (self.total_people(), 1, 2))
        again = self._get(self.viewer, sort="remuneration", page_size=2, page=2)
        self.assertEqual(again["rows"][0]["name"], "Asha")
        by_name = self._get(self.viewer, sort="name", page_size=100)
        names = [r["name"] for r in by_name["rows"]]
        self.assertEqual(names, sorted(names, key=str.casefold))
        self._get(self.viewer, expect=400, sort="salary")
        self._get(self.viewer, expect=400, period="week")
        self._get(self.viewer, expect=400, period="month", month="2026-13")

    def total_people(self):
        return User.objects.filter(role__in=rbac.CLAIMANT_ROLES, active=True).count()

    def test_ranks_are_by_the_top_five_order(self):
        rows = self._by_name(self._get(self.viewer, page_size=100))
        self.assertEqual(rows["Mina"]["rank_snip"], 1)  # 3.5 against 3.25
        self.assertEqual(rows["Asha"]["rank_snip"], 2)
        self.assertEqual(rows["Ravi"]["rank_remuneration"], 1)
        self.assertEqual(rows["Asha"]["rank_count"], 1)


class Periods(_Standings):
    def setUp(self):
        super().setUp()
        self._row("TSEC001", "Last day of the old year", 100, snip="1", month=date(2026, 5, 1))   # 2025-26
        self._row("TSEC001", "First day of the new year", 200, snip="2", month=date(2026, 6, 1))  # 2026-27
        self._row("TSEC002", "December", 300, snip="3", month=date(2025, 12, 1))
        self._row("TSEC002", "January", 400, snip="4", month=date(2026, 1, 1))
        self._row("TSCS001", "September", 500, snip="5", month=date(2026, 9, 1))
        self.viewer = self._office()

    def figures(self, **params):
        body = self._get(self.viewer, page_size=100, **params)
        return {r["name"]: r["remuneration"] for r in body["rows"] if r["remuneration"]}

    def test_academic_year_edges(self):
        self.assertEqual(self.figures(period="year", year=2025), {"Asha": 100, "Ravi": 700})
        self.assertEqual(self.figures(period="year", year=2026), {"Asha": 200, "Mina": 500})
        self.assertEqual(self.figures(period="year"), {"Asha": 200, "Mina": 500})  # the current one
        self.assertEqual(self._get(self.viewer, period="year", year=2025)["label"], "Academic year 2025-26")

    def test_calendar_year_edges(self):
        self.assertEqual(self.figures(period="year", academic="false", year=2025), {"Ravi": 300})
        self.assertEqual(
            self.figures(period="year", academic="false", year=2026), {"Asha": 300, "Ravi": 400, "Mina": 500}
        )
        body = self._get(self.viewer, period="year", academic="false", year=2026)
        self.assertEqual((body["label"], body["academic"]), ("Calendar year 2026", False))

    def test_a_named_month_and_the_default_month(self):
        self.assertEqual(self.figures(period="month", month="2025-12"), {"Ravi": 300})
        self.assertEqual(self.figures(period="month", month="2026-06"), {"Asha": 200})
        # No month named: the latest month with a payment, not the month it is today.
        body = self._get(self.viewer, period="month")
        self.assertEqual((body["month"], body["label"]), ("2026-09", "September 2026"))
        self.assertEqual(self.figures(period="month"), {"Mina": 500})

    def test_the_default_month_is_the_latest_even_when_it_is_in_the_past(self):
        PaidLedger.objects.all().delete()
        self._row("TSEC001", "Old", 100, month=date(2026, 2, 1))
        cache.clear()
        self.assertEqual(self._get(self.viewer, period="month")["month"], "2026-02")

    def test_the_choices_list_the_months_paid_in(self):
        choices = self._get(self.viewer, period="month")["choices"]
        self.assertEqual(choices["months"][0], "2026-09")
        self.assertIn("2025-12", choices["months"])
        self.assertEqual(choices["academic_years"][:2], [2026, 2025])

    def test_all_time(self):
        self.assertEqual(self.figures(), {"Asha": 300, "Ravi": 700, "Mina": 500})


class TopFiveIsTheTopOfTheStandings(_Standings):
    def setUp(self):
        super().setUp()
        for i, name in enumerate(["zed", "amy", "bob", "cat", "dan", "eve", "fay"]):
            u = self._user(name, "ECE" if i % 2 else "CSE", f"TS{i:03d}")
            for k in range(1 + i % 3):
                self._row(u.staff_id, f"{name} paper {k}", 100 * (1 + i % 4), snip=str(1 + i % 2),
                          month=date(2026, 9 if k else 6, 1))
        self.viewer = self._office()

    def test_for_each_measure_and_period(self):
        for params in ({}, {"period": "month"}, {"period": "year"}, {"period": "year", "academic": "false"},
                       {"period": "year", "year": 2025}, {"department": "ECE"}):
            board = self._get(self.viewer, "/api/dashboard/top5", **params)
            for measure in ("snip", "remuneration", "count"):
                body = self._get(self.viewer, page_size=100, sort=measure, **params)
                ranked = [r for r in body["rows"] if r[measure] > 0][:5]
                self.assertEqual(
                    [(r["user_id"], r["value"], r["name"]) for r in board[measure]],
                    [(r["user_id"], r[measure], r["name"]) for r in ranked],
                    (params, measure),
                )
                self.assertEqual([r["rank"] for r in board[measure]], [r[f"rank_{measure}"] for r in ranked])


class WhoMaySee(_Standings):
    def setUp(self):
        super().setUp()
        self._row("TSEC001", "ECE paper", 1000, snip="2")
        self._row("TSCS001", "CSE paper", 2000, snip="3")
        self._row("TSCS001", "CSE paper two", 500, snip="1")

    def test_the_office_sees_everyone_with_money(self):
        for role in (Role.PRINCIPAL, Role.DIRECTOR, Role.SUPER_ADMIN, Role.RESEARCH_COORDINATOR,
                     Role.FINANCE, Role.RESEARCH_CELL):
            body = self._get(self._office(role))
            self.assertEqual(body["scope"], "college")
            self.assertTrue(body["money"])
            self.assertTrue({"Asha", "Mina"} <= set(self._by_name(body)), role)
            self.assertEqual(self._by_name(body)["Mina"]["remuneration"], 2500, role)
            self.assertEqual(body["totals"]["remuneration"], 3500)

    def test_the_department_filter(self):
        body = self._get(self._office(), department="ece", page_size=100)
        self.assertEqual({r["name"] for r in body["rows"]}, {"Asha", "Ravi"})
        self.assertEqual(body["totals"]["count"], 1)
        self.assertEqual(self._by_name(body)["Asha"]["rank_snip"], 1)  # ranked within what is shown

    def test_a_head_sees_their_department_and_no_money_at_all(self):
        body = self._get(self.head, page_size=100)
        self.assertEqual({r["name"] for r in body["rows"]}, {"Mina", "Nobody", "Head"})
        self.assertEqual(body["scope"], "department")
        self.assertFalse(body["money"])
        self.assertEqual(money_keys_in(body), [])
        for row in body["rows"]:
            self.assertNotIn("remuneration", row)
            self.assertNotIn("rank_remuneration", row)
        self.assertNotIn("remuneration", body["totals"])
        self.assertNotIn("2500", json.dumps(body))
        self.assertEqual(self._by_name(body)["Mina"]["snip"], 4)

    def test_a_head_cannot_widen_or_sort_by_money(self):
        self._get(self.head, expect=403, department="ECE")
        self.assertEqual(self._get(self.head, department="cse")["department"], "CSE")
        self._get(self.head, expect=403, sort="remuneration")

    def test_a_heads_papers_have_no_money_and_stop_at_the_department(self):
        body = self._papers(self.head, self.mina)
        self.assertEqual(len(body["papers"]), 2)
        self.assertEqual(body["totals"], {"snip": 4, "count": 2})
        self.assertEqual(money_keys_in(body), [])
        self.assertNotIn("counted_in", json.dumps(body))
        self.assertNotIn("voided", body)
        self.assertNotIn("2000", json.dumps(body))
        self._papers(self.head, self.asha, expect=403)

    def test_a_faculty_member_sees_only_themself_but_their_place_in_the_college(self):
        body = self._get(self.asha, page_size=100)
        self.assertEqual(body["scope"], "self")
        self.assertEqual([r["name"] for r in body["rows"]], ["Asha"])
        self.assertEqual(body["rows"][0]["remuneration"], 1000)
        self.assertEqual(body["rows"][0]["rank_snip"], 2)  # behind Mina, of the whole college
        self.assertEqual(body["totals"], {"snip": 2, "remuneration": 1000, "count": 1})
        self.assertNotIn("Mina", json.dumps(body))
        self.assertEqual(self._get(self.asha, q="mina")["rows"], [])
        self.assertEqual(self._get(self.asha, department="CSE")["rows"][0]["name"], "Asha")

    def test_a_faculty_member_with_nothing_still_has_a_row(self):
        body = self._get(self.nobody)
        self.assertEqual([(r["name"], r["count"], r["rank_snip"]) for r in body["rows"]], [("Nobody", 0, None)])

    def test_a_faculty_member_sees_only_their_own_papers(self):
        own = self._papers(self.asha, self.asha)
        self.assertEqual([p["title"] for p in own["papers"]], ["ECE paper"])
        self.assertEqual(own["papers"][0]["amount"], 1000)
        self._papers(self.asha, self.mina, expect=403)
        self._papers(self.asha, self.ravi, expect=403)

    def test_signed_out_and_unknown_people(self):
        self.client.logout()
        self.assertEqual(self.client.get("/api/dashboard/standings").status_code, 401)
        self.assertEqual(self.client.get(f"/api/dashboard/standings/{self.asha.pk}/papers").status_code, 401)
        self._get(self._office(), "/api/dashboard/standings/nope/papers", expect=404)

    def test_someone_who_left_no_account_is_kept_by_key(self):
        self._row("TSXX777", "Outside paper", 800, faculty_name="Retired Person", department="ECE")
        body = self._get(self._office(), page_size=100)
        row = self._by_name(body)["Retired Person"]
        self.assertIsNone(row["user_id"])
        papers = self._get(self._office(), f"/api/dashboard/standings/{row['key']}/papers")
        self.assertEqual(papers["totals"]["remuneration"], 800)
        self.assertEqual(papers["person"]["name"], "Retired Person")


class Export(_Standings):
    def test_the_table_export_carries_what_the_reader_was_given(self):
        self._row("TSCS001", "CSE paper", 2000, snip="3")
        self.client.force_login(self.head)
        rows = self.client.get("/api/dashboard/standings", {"page_size": 100}).json()["rows"]
        self.assertNotIn("remuneration", rows[0])
        columns = [("name", "Faculty"), ("snip", "Cumulative SNIP"), ("count", "Papers settled")]
        res = self.client.post(
            "/api/export/table",
            data=json.dumps({
                "title": "Standings", "format": "csv", "filename": "standings",
                "columns": [{"key": k, "label": label} for k, label in columns],
                "rows": [[r[k] for k, _ in columns] for r in rows],
            }),
            content_type="application/json",
        )
        self.assertEqual(res.status_code, 200, res.content[:200])
        text = res.content.decode("utf-8-sig")
        self.assertIn("Cumulative SNIP", text)
        self.assertIn("Mina", text)
        self.assertNotIn("2000", text)
        parsed = list(csv.reader(io.StringIO(text)))
        self.assertTrue(any(r[:1] == ["Mina"] for r in parsed))


class OnePass(_Standings):
    def test_the_service_gives_one_answer_to_the_board_and_the_page(self):
        self._row("TSEC001", "Alpha", 1000, snip="2")
        self._row("TSEC001", "alpha.", 700, snip="2", month=date(2026, 9, 1))
        rec = top5.record()
        sp = top5.span("all", TODAY, latest=rec.latest)
        standing = top5.settle(rec, sp)[f"u:{self.asha.pk}"]
        card = top5.cards(rec, sp)[0]
        self.assertEqual((card["snip"], card["remuneration"], card["count"]), (standing.snip, standing.remuneration, standing.count))
        self.assertEqual((standing.snip, standing.remuneration, standing.count), (2, 1700, 1))


class OnTheDirectoryAndTheRecord(_Standings):
    def setUp(self):
        super().setUp()
        self._row("TSCS001", "CSE one", 2000, snip="3", month=date(2026, 8, 1))
        self._row("TSCS001", "CSE old", 1000, snip="1", month=date(2025, 8, 1))

    def test_the_directory_row_carries_all_time_and_this_year(self):
        body = self._get(self._office(), "/api/directory/faculty", limit=100)
        row = next(r for r in body["results"] if r["name"] == "Mina")
        self.assertEqual(row["standing"]["all"], {"snip": 4, "count": 2, "remuneration": 3000})
        self.assertEqual(row["standing"]["year"], {"snip": 3, "count": 1, "remuneration": 2000})
        nobody = next(r for r in body["results"] if r["name"] == "Nobody")
        self.assertEqual(nobody["standing"]["all"], {"snip": 0, "count": 0, "remuneration": 0})

    def test_a_head_gets_no_incentive_in_it_even_for_themself(self):
        body = self._get(self.head, "/api/directory/faculty", limit=100)
        for row in body["results"]:
            self.assertNotIn("remuneration", row["standing"]["all"])
            self.assertNotIn("remuneration", row["standing"]["year"])
        mine = self._get(self.head, "/api/directory/faculty/me")
        self.assertNotIn("remuneration", mine["standing"]["all"])
        theirs = self._get(self.head, f"/api/directory/faculty/{self.mina.pk}")
        self.assertEqual(theirs["standing"]["all"], {"snip": 4, "count": 2})

    def test_the_record_carries_the_standing_for_the_person_and_the_office(self):
        mine = self._get(self.mina, "/api/directory/faculty/me")
        self.assertEqual(mine["standing"]["year"], {"snip": 3, "count": 1, "remuneration": 2000})
        seen = self._get(self._office(), f"/api/directory/faculty/{self.mina.pk}")
        self.assertEqual(seen["standing"]["all"]["remuneration"], 3000)
