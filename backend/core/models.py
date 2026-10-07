import threading
import uuid

from django.contrib.auth.models import AbstractBaseUser, BaseUserManager, PermissionsMixin
from django.db import models
from django.db.models.functions import Lower
from django.utils import timezone


def cuid():
    return uuid.uuid4().hex


_clock_lock = threading.Lock()
_clock_last = None


def monotonic_now():
    """Now, but never at or before the last value this process handed out.

    The system clock on some hosts ticks once a millisecond, so two rows
    written in the same loop share a timestamp exactly -- and with a random
    id as the tie-break, "newest first" then orders them by coin toss. The
    feed is ordered by when things were written, so its rows take their time
    from here: one microsecond past the previous one when the clock has not
    moved.
    """
    global _clock_last
    from datetime import timedelta

    from django.utils import timezone

    with _clock_lock:
        now = timezone.now()
        if _clock_last is not None and now <= _clock_last:
            now = _clock_last + timedelta(microseconds=1)
        _clock_last = now
        return now


class Role(models.TextChoices):
    FACULTY = "FACULTY"
    HOD = "HOD"
    PRINCIPAL = "PRINCIPAL"
    #: Sits between the Principal and Finance. The Principal agrees the spend
    #: is right; the Director authorises it against the institution's own
    #: position before any money moves.
    DIRECTOR = "DIRECTOR"
    #: Checks and clears filed papers, beside the admin office rather than
    #: after it -- the chain is faculty, then *either* the coordinator or the
    #: admin, then the Principal. Two desks doing one job, not two steps.
    RESEARCH_COORDINATOR = "RESEARCH_COORDINATOR"
    RESEARCH_CELL = "RESEARCH_CELL"  # imports helper only — not in approval chain
    FINANCE = "FINANCE"
    SUPER_ADMIN = "SUPER_ADMIN"


class ClaimStatus(models.TextChoices):
    """Live chain:

        DRAFT → SUBMITTED → CLEARED → PRINCIPAL_APPROVED → DIRECTOR_APPROVED → PAID

    Faculty file it. The admin office (research cell) clears a submitted ticket
    on the facts. The Principal approves the spend. The Director authorises it.
    Finance pays what the Director authorised. Rejection can happen at any of
    the three review steps, and each sends the ticket back one step rather than
    all the way to the claimant.

    DIRECTOR_APPROVED is the newest link and was inserted *between* the two
    that already existed, which is why PRINCIPAL_APPROVED is no longer payable
    on its own. Tickets sitting at PRINCIPAL_APPROVED when the step was added
    were deliberately left where they were: they flow into the Director's queue
    and are authorised like anything else, rather than being migrated past a
    gate that did not exist when they were approved.
    """

    DRAFT = "DRAFT"
    SUBMITTED = "SUBMITTED"
    CLEARED = "CLEARED"
    PRINCIPAL_APPROVED = "PRINCIPAL_APPROVED"
    DIRECTOR_APPROVED = "DIRECTOR_APPROVED"
    PAID = "PAID"
    REJECTED = "REJECTED"

    # Legacy — no new claim enters these.
    HOD_APPROVED = "HOD_APPROVED"
    RESEARCH_APPROVED = "RESEARCH_APPROVED"
    FINANCE_APPROVED = "FINANCE_APPROVED"


#: In the chain and not yet paid — every status between "the office has
#: checked it" and "the money has gone", plus the old chain's terminal
#: approvals so imported tickets are still accounted for.
#:
#: This is *not* the set Finance may pay from. Only DIRECTOR_APPROVED is
#: payable, and `_mark_one_paid` checks for that one status by name. This
#: tuple answers the different question of "what is committed but unspent",
#: which is what the budget and the reports need.
PAYABLE_STATUSES = (
    ClaimStatus.CLEARED,
    ClaimStatus.PRINCIPAL_APPROVED,
    ClaimStatus.DIRECTOR_APPROVED,
    ClaimStatus.RESEARCH_APPROVED,
    ClaimStatus.FINANCE_APPROVED,
)


class QuartileMode(models.TextChoices):
    Q1 = "Q1"
    Q2 = "Q2"
    Q3 = "Q3"
    Q4 = "Q4"
    NO_SNIP = "NO_SNIP"
    SNIP_ONLY = "SNIP_ONLY"
    OTHERS = "Others"


class BatchStatus(models.TextChoices):
    PENDING = "PENDING"
    RUNNING = "RUNNING"
    DONE = "DONE"
    FAILED = "FAILED"


class ClaimReason(models.TextChoices):
    """Why the article is being filed — drives whether money is payable."""

    INCENTIVE = "INCENTIVE", "Faculty Publication Incentive"
    COUNT_ONLY = "COUNT_ONLY", "Publication count only"
    #: A student project taken to a conference. The team is named and stored;
    #: the money goes to the faculty on it, because a student author is paid
    #: nothing under `student_remuneration_zero` and always has been.
    STUDENT_PROJECT = "STUDENT_PROJECT", "Student project conference incentive"


class AttachmentKind(models.TextChoices):
    PUBLISHED_PAPER = "PUBLISHED_PAPER", "Full-length published paper"
    SEC_REFERENCE = "SEC_REFERENCE", "Cited reference with SEC affiliation"


class UserManager(BaseUserManager):
    def create_user(self, email, password=None, **extra):
        if not email:
            raise ValueError("Email required")
        email = self.normalize_email(email)
        user = self.model(email=email, **extra)
        user.set_password(password)
        user.save(using=self._db)
        return user

    def create_superuser(self, email, password=None, **extra):
        extra.setdefault("is_staff", True)
        extra.setdefault("is_superuser", True)
        extra.setdefault("role", Role.SUPER_ADMIN)
        return self.create_user(email, password, **extra)


class User(AbstractBaseUser, PermissionsMixin):
    id = models.CharField(primary_key=True, max_length=32, default=cuid, editable=False)
    email = models.EmailField(unique=True)
    name = models.CharField(max_length=255)
    role = models.CharField(max_length=32, choices=Role.choices, default=Role.FACULTY)
    department = models.CharField(max_length=255, blank=True, null=True)
    employee_id = models.CharField(max_length=64, blank=True, null=True, unique=True)
    staff_id = models.CharField(max_length=64, blank=True, null=True, db_index=True)
    biometric_id = models.CharField(max_length=64, blank=True, null=True, db_index=True)
    designation = models.CharField(max_length=128, blank=True, null=True)
    scopus_author_url = models.TextField(blank=True, null=True)
    scopus_author_id = models.CharField(max_length=64, blank=True, null=True, db_index=True)
    #: When `sync_scopus_authors` last paged through this person's Scopus
    #: profile (AU-ID search); oldest first, so an interrupted run resumes.
    scopus_synced_at = models.DateTimeField(blank=True, null=True)
    must_change_password = models.BooleanField(default=False)

    #: Regular or research, set by an admin rather than inferred from the
    #: designation text. Nine accounts carry "Research" in a designation
    #: today, spelt four different ways, and a payout rule keyed on a job
    #: title is a payout rule that changes when somebody retypes one.
    faculty_type = models.CharField(
        max_length=16,
        choices=[("REGULAR", "Regular faculty"), ("RESEARCH", "Research faculty")],
        default="REGULAR",
        db_index=True,
    )
    #: RETIRED: the old rule, "the first N papers each year are unpaid". It no
    #: longer decides any amount. Research faculty now have a rupee threshold
    #: per year (see `ResearchThreshold`); anybody still carrying one of these
    #: is shown as "old rule, please set a rupee threshold" until the research
    #: coordinator sets it. Nothing writes these any more.
    research_quota = models.PositiveIntegerField(blank=True, null=True)
    research_quota_note = models.TextField(blank=True, null=True)

    #: The one detail on an account its owner edits directly
    #: (PATCH /auth/profile/self). Nothing is paid or checked against it, so
    #: routing it through a super admin would only guarantee it goes stale.
    phone = models.CharField(max_length=32, blank=True, null=True)

    #: A few lines about themselves, shown on the public profile. Self-service
    #: for the same reason as the phone: nothing is paid on it.
    bio = models.TextField(blank=True, null=True)
    #: The person's ORCID iD, checksum-verified before it is kept. Unlike the
    #: Scopus link it attributes no claim to anybody, so it is theirs to set.
    orcid_id = models.CharField(max_length=19, blank=True, null=True)
    #: The storage name of their profile photo (`avatars/<uuid>.<ext>`),
    #: re-encoded small on upload so it carries no camera metadata.
    photo = models.CharField(max_length=255, blank=True, null=True)

    #: A Google account the person linked from their profile, identified by
    #: Google's stable subject id rather than by email: a personal Gmail
    #: address never matches the college address the account was made with,
    #: and an address can be renamed where the subject cannot. Unique, so one
    #: Google account opens at most one account here.
    google_sub = models.CharField(max_length=255, unique=True, blank=True, null=True)
    #: Shown back on the profile so the person can see which account it is.
    google_email = models.EmailField(blank=True, null=True)
    google_linked_at = models.DateTimeField(blank=True, null=True)
    #: When they closed the first-sign-in welcome. Kept on the server so it is
    #: never shown twice, whichever device they sign in from next.
    welcome_seen_at = models.DateTimeField(blank=True, null=True)

    active = models.BooleanField(default=True)
    is_staff = models.BooleanField(default=False)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    objects = UserManager()

    USERNAME_FIELD = "email"
    REQUIRED_FIELDS = ["name"]

    class Meta:
        constraints = [
            # Sign-in lowercases what is typed; two accounts differing only in
            # case would make one of them unreachable (migration 0062).
            models.UniqueConstraint(Lower("email"), name="user_email_ci_unique"),
            # One staff id, one person: the ledger and the ERP import attribute
            # money by it.
            models.UniqueConstraint(
                fields=["staff_id"],
                condition=models.Q(staff_id__isnull=False) & ~models.Q(staff_id=""),
                name="user_staff_id_unique",
            ),
            # ...in any case: the payments page matches the ledger's staff id
            # case-insensitively (migration 0068).
            models.UniqueConstraint(
                Lower("staff_id"),
                condition=models.Q(staff_id__isnull=False) & ~models.Q(staff_id=""),
                name="user_staff_id_ci_unique",
            ),
        ]

    def __str__(self):
        return self.email


class Budget(models.Model):
    """What the college has allocated, and against which year.

    Without one, the principal approves spend with no idea what is left --
    which makes an approval step ceremony rather than control. A row with no
    department is the college-wide allocation; a row with one is that
    department's ring-fence inside it.
    """

    id = models.CharField(primary_key=True, max_length=32, default=cuid, editable=False)
    #: "2026-27", the Indian financial year the allocation belongs to.
    financial_year = models.CharField(max_length=9, db_index=True)
    #: Blank means the whole college.
    department = models.CharField(max_length=128, blank=True, null=True)
    amount = models.FloatField()
    note = models.TextField(blank=True, null=True)
    created_by = models.ForeignKey(
        "User", null=True, blank=True, on_delete=models.SET_NULL, related_name="budgets"
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        # One allocation per department per year: two rows for the same slice
        # give two different answers to "what is left".
        constraints = [
            models.UniqueConstraint(
                fields=["financial_year", "department"], name="one_budget_per_slice"
            ),
            models.CheckConstraint(condition=models.Q(amount__gte=0), name="budget_amount_non_negative"),
        ]
        ordering = ["-financial_year", "department"]

    def __str__(self) -> str:
        return f"{self.financial_year} {self.department or 'college-wide'}: {self.amount}"


class DepartmentTarget(models.Model):
    """What a head has asked their department, or one of its members, to reach.

    A head could see what their department had published and had no way to say
    what it *should* publish, so every review meeting started by agreeing the
    number again from memory. A target written down is the difference between
    "we should do better" and "we agreed eleven Q1 papers and we are at four".

    Deliberately not money. A head is money-blind everywhere else in this
    system and a rupee target would be the one place it leaked back in -- so
    the metrics are counts of work: papers, top-quartile papers, papers led
    from here.

    `person` null means the whole department. A departmental target and a
    personal one for somebody inside it are both useful and are not the same
    row, which is why the uniqueness constraint includes the person.
    """

    class Metric(models.TextChoices):
        PUBLICATIONS = "PUBLICATIONS", "Publications"
        Q1 = "Q1", "Q1 publications"
        FIRST_AUTHOR = "FIRST_AUTHOR", "Papers led from this department"

    id = models.CharField(primary_key=True, max_length=32, default=cuid, editable=False)
    department = models.CharField(max_length=255, db_index=True)
    #: Publication year the target is set against.
    year = models.PositiveIntegerField(db_index=True)
    metric = models.CharField(max_length=24, choices=Metric.choices)
    target = models.PositiveIntegerField()
    #: Null means the department as a whole.
    person = models.ForeignKey(
        "User", null=True, blank=True, on_delete=models.CASCADE,
        related_name="targets_set_on_them",
    )
    note = models.TextField(blank=True, null=True)
    #: When the number is meant to be reached by. Optional: a year-long
    #: target already has the year as its horizon, and a head who wants the
    #: Q1 papers in before the accreditation visit can say so.
    due_date = models.DateField(blank=True, null=True)
    set_by = models.ForeignKey(
        "User", null=True, blank=True, on_delete=models.SET_NULL,
        related_name="targets_set",
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["department", "year", "metric", "person"],
                name="one_target_per_metric_per_person_per_year",
            ),
            # A null person is not equal to another null person in SQL, so the
            # constraint above never fires for two departmental targets on the
            # same metric. This one covers that case explicitly.
            models.UniqueConstraint(
                fields=["department", "year", "metric"],
                condition=models.Q(person__isnull=True),
                name="one_department_target_per_metric_per_year",
            ),
        ]
        ordering = ["-year", "department", "metric"]

    def __str__(self) -> str:
        who = self.person.name if self.person_id else self.department
        return f"{who} {self.year} {self.metric}: {self.target}"


class DepartmentPlan(models.Model):
    """What a department says it is for, in the head's words.

    A target says how much; nothing said *what*. A new lecturer asking "what
    should I be working on here" had nobody's answer but whoever they happened
    to ask, and two heads in succession could steer the same department in
    different directions without either direction ever being written down.

    One row per department. `research_areas` is a short list of short labels
    ("Photonics", "Condensed matter") rather than prose, so it can be shown as
    chips and matched against later; the prose belongs in `vision`.
    """

    id = models.CharField(primary_key=True, max_length=32, default=cuid, editable=False)
    department = models.CharField(max_length=255, unique=True)
    vision = models.TextField(blank=True, default="")
    research_areas = models.JSONField(default=list, blank=True)
    updated_by = models.ForeignKey(
        "User", null=True, blank=True, on_delete=models.SET_NULL,
        related_name="department_plans_updated",
    )
    updated_at = models.DateTimeField(auto_now=True)

    def __str__(self) -> str:
        return f"{self.department} plan"


class DepartmentAssignment(models.Model):
    """A piece of work a head has handed to somebody in their department.

    Three kinds, because a head hands out three different things: a task
    ("draft the criterion 3 narrative"), a pairing of two people who should
    write together, and a research area somebody is asked to take up. They
    share a status and a deadline, and the people on one see it on their own
    home screen -- which is the whole point: an instruction given in a
    corridor has no record, and nobody can tell later whether it was done.

    Both people must be in the department the assignment belongs to; that is
    checked by the endpoints, which know who is asking. The database refuses
    the one shape that is wrong whoever asks: a person paired with themselves.
    Deliberately carries no money -- a head is money-blind.
    """

    class Kind(models.TextChoices):
        TASK = "TASK", "Task"
        PAIRING = "PAIRING", "Co-author pairing"
        RESEARCH_AREA = "RESEARCH_AREA", "Research area"

    class Status(models.TextChoices):
        OPEN = "OPEN", "Open"
        IN_PROGRESS = "IN_PROGRESS", "In progress"
        DONE = "DONE", "Done"

    id = models.CharField(primary_key=True, max_length=32, default=cuid, editable=False)
    department = models.CharField(max_length=255, db_index=True)
    kind = models.CharField(max_length=16, choices=Kind.choices)
    title = models.CharField(max_length=200)
    notes = models.TextField(blank=True, default="")
    assignee = models.ForeignKey(
        "User", on_delete=models.CASCADE, related_name="assignments"
    )
    #: The second author of a PAIRING; empty for every other kind.
    partner = models.ForeignKey(
        "User", null=True, blank=True, on_delete=models.CASCADE,
        related_name="paired_assignments",
    )
    due_date = models.DateField(blank=True, null=True)
    status = models.CharField(
        max_length=16, choices=Status.choices, default=Status.OPEN, db_index=True
    )
    created_by = models.ForeignKey(
        "User", null=True, blank=True, on_delete=models.SET_NULL,
        related_name="assignments_created",
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        constraints = [
            models.CheckConstraint(
                condition=~models.Q(partner=models.F("assignee")),
                name="assignment_partner_is_not_the_assignee",
            ),
        ]
        ordering = ["-created_at"]

    def __str__(self) -> str:
        return f"{self.department} {self.kind}: {self.title[:40]}"


class JournalStanding(models.Model):
    """Whether a journal is still recognised, and by whom.

    A journal indexed when a paper was published can be discontinued by
    Scopus, or removed from the UGC-CARE list, afterwards. Paying on today's
    standing for a paper published three years ago is wrong in both
    directions, so the date the standing changed is the part that matters.
    """

    class Source(models.TextChoices):
        SCOPUS_DISCONTINUED = "SCOPUS_DISCONTINUED", "Scopus discontinued list"
        UGC_CARE = "UGC_CARE", "UGC-CARE list"

    id = models.CharField(primary_key=True, max_length=32, default=cuid, editable=False)
    source = models.CharField(max_length=32, choices=Source.choices, db_index=True)
    issn = models.CharField(max_length=32, db_index=True)
    title = models.CharField(max_length=512, blank=True, null=True)
    #: True = currently recognised by this source. False = removed/discontinued.
    listed = models.BooleanField(default=True)
    #: When the source removed it. A paper published before this date was in a
    #: recognised journal at the time, which is the question the policy asks.
    changed_on = models.DateField(blank=True, null=True)
    reason = models.CharField(max_length=255, blank=True, null=True)
    imported_at = models.DateTimeField(auto_now=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["source", "issn"], name="one_standing_per_source_and_issn"
            )
        ]
        indexes = [models.Index(fields=["issn", "listed"])]

    def __str__(self) -> str:
        return f"{self.issn} {self.source} listed={self.listed}"


class DuplicateFinding(models.Model):
    """A payment that looks like it was made twice for one paper.

    Raised by a sweep over history rather than at submission time, because the
    imported ERP ledger was never checked at all -- and the answer is a
    judgement somebody has to record, not a flag a script can set.
    """

    class Kind(models.TextChoices):
        SAME_PERSON = "SAME_PERSON", "Same person paid more than once"
        CROSS_PERSON = "CROSS_PERSON", "Paid to more than one person"

    class Status(models.TextChoices):
        OPEN = "OPEN", "Not yet reviewed"
        CONFIRMED = "CONFIRMED", "A real duplicate"
        DISMISSED = "DISMISSED", "Not a duplicate"
        RECOVERED = "RECOVERED", "Recovered"

    id = models.CharField(primary_key=True, max_length=32, default=cuid, editable=False)
    kind = models.CharField(max_length=16, choices=Kind.choices, db_index=True)
    status = models.CharField(
        max_length=16, choices=Status.choices, default=Status.OPEN, db_index=True
    )
    #: The normalised title or DOI the rows were grouped on.
    match_key = models.CharField(max_length=512, db_index=True)
    matched_on = models.CharField(max_length=16, default="title")
    paper_title = models.TextField(blank=True, null=True)
    faculty_name = models.CharField(max_length=255, blank=True, null=True)
    #: Everything in the group, as recorded when the sweep ran.
    rows_json = models.TextField()
    payment_count = models.PositiveIntegerField(default=0)
    total_amount = models.FloatField(default=0)
    #: What the second and later payments came to -- the sum at issue.
    extra_amount = models.FloatField(default=0)
    reviewed_by = models.ForeignKey(
        "User", null=True, blank=True, on_delete=models.SET_NULL,
        related_name="duplicate_reviews",
    )
    reviewed_at = models.DateTimeField(blank=True, null=True)
    note = models.TextField(blank=True, null=True)
    recovered_amount = models.FloatField(blank=True, null=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-extra_amount"]
        constraints = [
            models.UniqueConstraint(
                fields=["kind", "match_key", "faculty_name"], name="one_finding_per_group"
            )
        ]

    def __str__(self) -> str:
        return f"{self.kind} {self.match_key[:40]} {self.extra_amount}"


class FormulaConfig(models.Model):
    id = models.CharField(primary_key=True, max_length=32, default=cuid, editable=False)
    name = models.CharField(max_length=128, default="Policy v1")
    version = models.PositiveIntegerField(default=1)
    effective_from = models.DateField(blank=True, null=True)
    effective_to = models.DateField(blank=True, null=True)
    snip_multiplier = models.FloatField(default=55000)
    snip_cap = models.FloatField(default=30)
    # Additional Quartile Incentive (QFA), Engineering journals only.
    qf_q1 = models.FloatField(default=50000)
    qf_q2 = models.FloatField(default=30000)
    qf_q3 = models.FloatField(default=15000)
    qf_q4 = models.FloatField(default=7000)
    qf_no_snip = models.FloatField(default=0)
    qf_snip_only = models.FloatField(default=0)
    #: Retired. The QFA table in the policy has rows for Q1-Q4 and nothing else,
    #: so an "Others" incentive is not authorised; the calculator ignores this.
    qf_others = models.FloatField(default=0)
    # Fixed rates for the categories that carry no SNIP (Step 8, II–IV).
    fixed_journal_no_snip = models.FloatField(default=5000)
    fixed_other_no_snip = models.FloatField(default=4000)
    fixed_web_of_science = models.FloatField(default=5000)
    #: "Publications with more than nine authors shall not be eligible."
    max_authors = models.PositiveIntegerField(default=9)
    #: "a minimum of two (2) SEC-affiliated references" for remuneration.
    min_sec_references = models.PositiveIntegerField(default=2)
    #: Claims at or above this amount need a second, distinct approver before
    #: Finance can pay them. Zero disables the rule — it needs two admin
    #: accounts to satisfy, so it is opt-in rather than on by default.
    high_value_threshold = models.FloatField(default=0)
    #: The day of the month filing closes for that month's payment run, 1-28.
    #: Empty means the college has not set one, and then nobody is reminded of
    #: a deadline -- a reminder about a date nobody decided is fake urgency.
    filing_cutoff_day = models.PositiveSmallIntegerField(blank=True, null=True)
    #: The month the research year starts in, 1-12. It is the year a research
    #: faculty member's rupee threshold runs on, and the year the faculty home
    #: calls "this year". 6 is the college's academic year (1 June to 31 May).
    research_year_start_month = models.PositiveSmallIntegerField(default=6)
    author_point_json = models.TextField()
    # e.g. {"Journal": 1, "Conference Proceeding": 0.8, "Book Series": 0.5, "Other": 0.5}
    publication_type_multipliers_json = models.TextField(
        default='{"Journal":1,"Conference Proceeding":1,"Book Series":1,"Other":1}'
    )
    student_remuneration_zero = models.BooleanField(default=True)
    qf_only_for_no_snip = models.BooleanField(default=True)
    #: The Final Year Student Project Reimbursement Scheme: a fixed amount per
    #: team per conference paper, paid to the team's mentor. A scheme of its
    #: own -- not the SNIP formula, no author-position split (college decision
    #: of 2026-09-23, "15k per conference").
    student_project_amount = models.FloatField(default=15000)
    active = models.BooleanField(default=True)
    notes = models.TextField(blank=True, null=True)
    updated_by = models.ForeignKey(
        User, null=True, blank=True, on_delete=models.SET_NULL, related_name="formula_edits"
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        constraints = [
            # The calculator reads "the" active formula; two would make which
            # one priced a claim an accident of ordering.
            models.UniqueConstraint(
                fields=["active"], condition=models.Q(active=True), name="one_active_formula"
            ),
            models.CheckConstraint(
                condition=models.Q(snip_multiplier__gte=0, snip_cap__gte=0, qf_q1__gte=0, qf_q2__gte=0,
                                   qf_q3__gte=0, qf_q4__gte=0, fixed_journal_no_snip__gte=0,
                                   fixed_other_no_snip__gte=0, fixed_web_of_science__gte=0,
                                   high_value_threshold__gte=0, student_project_amount__gte=0),
                name="formula_amounts_non_negative",
            ),
        ]


class PriorImport(models.Model):
    id = models.CharField(primary_key=True, max_length=32, default=cuid, editable=False)
    filename = models.CharField(max_length=255)
    row_count = models.IntegerField()
    mapping_json = models.TextField()
    imported_by = models.ForeignKey(User, on_delete=models.CASCADE, related_name="prior_imports")
    created_at = models.DateTimeField(auto_now_add=True)


class PriorPayment(models.Model):
    id = models.CharField(primary_key=True, max_length=32, default=cuid, editable=False)
    faculty_name = models.CharField(max_length=255, blank=True, null=True)
    employee_id = models.CharField(max_length=64, blank=True, null=True)
    paper_title = models.TextField(blank=True, null=True)
    normalized_title = models.CharField(max_length=512, blank=True, null=True, db_index=True)
    doi = models.CharField(max_length=255, blank=True, null=True, db_index=True)
    issn = models.CharField(max_length=32, blank=True, null=True, db_index=True)
    journal_title = models.CharField(max_length=512, blank=True, null=True)
    publication_year = models.IntegerField(blank=True, null=True)
    amount_paid = models.FloatField(blank=True, null=True)
    paid_at = models.DateTimeField(blank=True, null=True)
    claim_ref = models.CharField(max_length=255, blank=True, null=True)
    raw_json = models.TextField()
    import_batch = models.ForeignKey(
        PriorImport, null=True, blank=True, on_delete=models.SET_NULL, related_name="payments"
    )
    created_at = models.DateTimeField(auto_now_add=True)


class Claim(models.Model):
    id = models.CharField(primary_key=True, max_length=32, default=cuid, editable=False)
    owner = models.ForeignKey(User, on_delete=models.CASCADE, related_name="claims")
    status = models.CharField(max_length=32, choices=ClaimStatus.choices, default=ClaimStatus.DRAFT)
    status_note = models.CharField(max_length=255, blank=True, null=True)
    ticket_number = models.CharField(max_length=32, blank=True, null=True, unique=True, db_index=True)
    contest_forward = models.BooleanField(default=False)
    contest_note = models.TextField(blank=True, null=True)
    verification_snapshot_json = models.TextField(blank=True, null=True)
    verification_ok = models.BooleanField(default=True)

    # Faculty-filled (Raw_Data)
    paper_title = models.TextField(blank=True, null=True)
    journal_title = models.CharField(max_length=512, blank=True, null=True)
    issn = models.CharField(max_length=32, blank=True, null=True)
    publication_year = models.IntegerField(blank=True, null=True)
    publication_date = models.CharField(max_length=64, blank=True, null=True)
    publication_type = models.CharField(max_length=128, blank=True, null=True)
    # Comma-separated sets: a journal sits in several indexes at once, and an
    # article can be filed under more than one type.
    indexing_level = models.CharField(max_length=128, blank=True, null=True)
    #: Legacy combined column, derived from the two below for ERP exports.
    indexing_ref = models.CharField(max_length=255, blank=True, null=True)
    # AU Annexure and UGC Care are separate registers with separate numbers;
    # one shared box could only ever hold one of them.
    au_annexure_ref = models.CharField(max_length=128, blank=True, null=True)
    ugc_care_ref = models.CharField(max_length=128, blank=True, null=True)
    yukthi_id = models.CharField(max_length=64, blank=True, null=True)
    self_reported_quartile = models.CharField(max_length=32, blank=True, null=True)
    #: The claimant's own SNIP declaration. Kept apart from `snip` because the
    #: payout must only ever be computed from server-verified values.
    self_reported_snip = models.FloatField(blank=True, null=True)
    impact_factor = models.CharField(max_length=64, blank=True, null=True)
    #: normalize_title(paper_title), indexed so duplicate detection is a lookup
    #: rather than a scan.
    normalized_title = models.CharField(max_length=512, blank=True, null=True, db_index=True)

    staff_id = models.CharField(max_length=64, blank=True, null=True, db_index=True)
    biometric_id = models.CharField(max_length=64, blank=True, null=True)
    designation = models.CharField(max_length=128, blank=True, null=True)
    scopus_author_url = models.TextField(blank=True, null=True)
    scopus_author_id = models.CharField(max_length=64, blank=True, null=True, db_index=True)

    proof_url = models.TextField(blank=True, null=True)
    sec_refs = models.TextField(blank=True, null=True)
    sec_proof_url = models.TextField(blank=True, null=True)
    # Citations of SEC-affiliated work, listed long-hand by the author
    reference_articles = models.TextField(blank=True, null=True)
    claim_reason = models.CharField(
        max_length=32, choices=ClaimReason.choices, default=ClaimReason.INCENTIVE
    )

    total_authors = models.IntegerField(default=1)
    author_position = models.IntegerField(default=1)
    authors_json = models.TextField(blank=True, null=True)

    # System verify outputs
    doi = models.CharField(max_length=255, blank=True, null=True, db_index=True)
    eid = models.CharField(max_length=64, blank=True, null=True)
    scopus_url = models.TextField(blank=True, null=True)
    cover_date = models.CharField(max_length=32, blank=True, null=True)
    aggregation_type = models.CharField(max_length=64, blank=True, null=True)
    indexing_status = models.CharField(max_length=64, blank=True, null=True)
    linkage_status = models.CharField(max_length=64, blank=True, null=True)
    engineering_class = models.CharField(max_length=64, blank=True, null=True)

    subject_category = models.CharField(max_length=255, blank=True, null=True)
    subjects_json = models.TextField(blank=True, null=True)

    snip = models.FloatField(blank=True, null=True)
    snip_year = models.IntegerField(blank=True, null=True)
    quartile = models.CharField(max_length=16, blank=True, null=True)
    # Where the verified value came from. Money is computed only from values
    # with a source: SCOPUS / SNIP_DUMP / MANUAL for snip, SCIMAGO / MANUAL
    # for quartile. MANUAL entries survive re-verification; everything else is
    # overwritten (or cleared) by the next verify run.
    snip_source = models.CharField(max_length=16, blank=True, null=True)
    quartile_source = models.CharField(max_length=16, blank=True, null=True)
    manual_verified_by = models.ForeignKey(
        User, null=True, blank=True, on_delete=models.SET_NULL, related_name="manual_verifications"
    )
    manual_verified_at = models.DateTimeField(blank=True, null=True)
    manual_verification_note = models.TextField(blank=True, null=True)
    scimago_verified = models.BooleanField(default=False)
    scimago_sjr = models.FloatField(blank=True, null=True)
    scimago_categories_json = models.TextField(blank=True, null=True)
    scimago_dataset_year = models.IntegerField(blank=True, null=True)
    scimago_opened_confirmed = models.BooleanField(default=False)
    manual_quartile_reason = models.TextField(blank=True, null=True)

    is_student_publication = models.BooleanField(default=False)
    #: Set on a STUDENT_PROJECT claim. The team is confirmed at filing time and
    #: displayed on the ticket, so whoever clears it can see who did the work.
    team = models.ForeignKey(
        "Team", null=True, blank=True, on_delete=models.SET_NULL, related_name="claims"
    )
    #: What the research threshold decided, recorded on the claim rather than
    #: recomputed later: a threshold can be changed afterwards, and a paid
    #: claim must keep the reason it was paid the way it was.
    #: `quota_applied` is true when the threshold took any of the amount;
    #: `quota_note` says so in plain words. (The names are from the old
    #: papers-a-year quota, kept so the columns and the API keep their shape.)
    quota_applied = models.BooleanField(default=False)
    quota_note = models.TextField(blank=True, null=True)
    #: The rupees of this claim's incentive that count against the person's
    #: research threshold and so are not paid. `remuneration` is what is left
    #: to pay, so the policy's own amount is remuneration + research_absorbed.
    #: Fixed when the claim is paid, so a threshold changed later never
    #: reprices money that has gone out.
    research_absorbed = models.FloatField(default=0)
    #: Retired. Was "paper k of the year" under the old papers-a-year quota;
    #: nothing assigns or reads it any more. Kept so history is not lost.
    quota_position = models.PositiveIntegerField(blank=True, null=True)
    #: An affirmation the claimant has to make. Defaulting it true would assert
    #: it on their behalf, which is the one thing a confirmation must not do.
    affiliation_ok = models.BooleanField(default=False)

    qf_amount = models.FloatField(blank=True, null=True)
    base_amount = models.FloatField(blank=True, null=True)
    author_point = models.FloatField(blank=True, null=True)
    remuneration = models.FloatField(blank=True, null=True)
    calc_error = models.TextField(blank=True, null=True)
    #: Which of the policy's four Step 8 categories produced the amount, and why.
    #: An unexplained number is the thing faculty and Finance both query.
    remuneration_category = models.CharField(max_length=8, blank=True, null=True)
    remuneration_note = models.TextField(blank=True, null=True)

    formula_config = models.ForeignKey(
        FormulaConfig, null=True, blank=True, on_delete=models.SET_NULL, related_name="claims"
    )
    formula_snapshot_json = models.TextField(blank=True, null=True)

    duplicate_warning = models.BooleanField(default=False)
    duplicate_matches_json = models.TextField(blank=True, null=True)
    override_duplicate = models.BooleanField(default=False)
    override_reason = models.TextField(blank=True, null=True)
    #: Who waved the duplicate warning away, and when. Without a name against
    #: it, the dismissal is anonymous by the time anyone reviews the payment.
    #: When the research cell cleared it, and when the principal approved.
    #: updated_at moves for any edit, so it cannot answer "waiting since".
    cleared_at = models.DateTimeField(null=True, blank=True)
    principal_approved_by = models.ForeignKey(
        "User",
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="principal_approvals",
    )
    principal_approved_at = models.DateTimeField(null=True, blank=True)
    #: The Director's authorisation, which is what Finance pays against. Kept
    #: as its own pair of columns rather than folded into the Principal's:
    #: "who agreed the spend" and "who authorised it" are different questions
    #: and an auditor asks both.
    director_approved_by = models.ForeignKey(
        "User",
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="director_approvals",
    )
    director_approved_at = models.DateTimeField(null=True, blank=True)
    #: The policy amount the Director authorised (before the research
    #: threshold takes its share, so remuneration + research_absorbed),
    #: written in the same step as the authorisation. If the claim prices to
    #: anything else at payment time (a policy edit, a corrected SNIP, a
    #: changed author count), it goes back to the Principal with an audit row
    #: instead of being paid at a figure nobody signed. The threshold's own
    #: re-ordering between a person's claims moves only the split, never this
    #: figure, so it does not trip the lock. Null on claims authorised before
    #: the column existed and not backfilled, which are not locked.
    authorised_amount = models.FloatField(null=True, blank=True)
    override_by = models.ForeignKey(
        "User",
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="duplicate_overrides",
    )
    override_at = models.DateTimeField(null=True, blank=True)

    #: Paused at the desk it is sitting at, without leaving it. A flag rather
    #: than a status, so the paper keeps its place in the chain and every
    #: status filter -- the queues, the counts, the budget, the reports --
    #: goes on finding it where it was. Only the research supervisor's desk
    #: (SUBMITTED) and the Principal's (CLEARED) can hold a paper; any status
    #: change lifts the hold, because the paper is no longer where it was held.
    on_hold = models.BooleanField(default=False)
    hold_reason = models.TextField(blank=True, null=True)
    held_by = models.ForeignKey(
        "User", null=True, blank=True, on_delete=models.SET_NULL, related_name="held_claims"
    )
    held_at = models.DateTimeField(null=True, blank=True)
    #: The reviewer the coordination desk has given this claim to. Advisory:
    #: anyone at the desk may still act on it. It only counts while the person
    #: can act at the desk the claim is now at (`coordination.effective_assignee`),
    #: so a claim that has moved on stops belonging to its old reviewer without
    #: any status change having to remember to clear it.
    assigned_to = models.ForeignKey(
        "User", null=True, blank=True, on_delete=models.SET_NULL, related_name="assigned_claims"
    )
    assigned_at = models.DateTimeField(null=True, blank=True)
    #: REJECTED has always meant "returned to the claimant to fix and file
    #: again". This marks the other kind of rejection -- not accepted at all --
    #: which cannot be edited or refiled. A flag on REJECTED rather than a new
    #: status, so everything that counts rejections keeps counting both.
    rejected_outright = models.BooleanField(default=False)

    year_mismatch = models.BooleanField(default=False)
    year_mismatch_override = models.BooleanField(default=False)
    year_mismatch_reason = models.TextField(blank=True, null=True)

    voucher_number = models.CharField(max_length=64, blank=True, null=True)
    payout_month = models.DateField(blank=True, null=True)

    # Who moved the money along. A high-value claim needs a second approver
    # distinct from the person who cleared it.
    cleared_by = models.ForeignKey(
        User, null=True, blank=True, on_delete=models.SET_NULL, related_name="cleared_claims"
    )
    second_approved_by = models.ForeignKey(
        User, null=True, blank=True, on_delete=models.SET_NULL, related_name="second_approvals"
    )
    second_approved_at = models.DateTimeField(blank=True, null=True)

    scopus_raw_json = models.TextField(blank=True, null=True)
    scimago_raw_json = models.TextField(blank=True, null=True)

    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)
    submitted_at = models.DateTimeField(blank=True, null=True)
    paid_at = models.DateTimeField(blank=True, null=True)

    class Meta:
        indexes = [
            models.Index(fields=["status", "-updated_at"]),
            models.Index(fields=["owner", "status"]),
            models.Index(fields=["payout_month"]),
            models.Index(fields=["-submitted_at"]),
        ]
        constraints = [
            # A research-quota slot belongs to one paper. The position was
            # handed out by reading MAX(quota_position) and writing MAX+1 in
            # two separate statements with no lock, so two submits for the
            # same author and year that interleaved both read the same maximum
            # and both wrote the same number -- two papers sharing a slot, a
            # quota of N zeroing N-1 papers, and one paper paid that should
            # not have been. The retry in save() below closes the window it
            # can see; this is the guarantee that holds when it cannot, and it
            # is what makes a retry safe to write at all.
            #
            # NULLs are distinct on both backends this runs on, so the many
            # claims with no position -- drafts, count-only filings, papers
            # with no year, and every claim of a non-research faculty member
            # -- are unaffected.
            models.UniqueConstraint(
                fields=["owner", "publication_year", "quota_position"],
                name="uniq_claim_quota_slot_per_owner_year",
            ),
            # One filed claim per person per paper (migration 0075). Filed
            # means anything past a draft and not sent back: a draft can be
            # abandoned and a sent-back claim is the same claim edited and
            # filed again, so neither holds the paper. The application checks
            # first and says so in words; this is what holds when two requests
            # race past that check.
            #
            # Claims imported from the old workbook (ticket "ERP-...") are
            # history, not filings, and are left out: the workbook records
            # some papers paid twice to one person, those payments are real,
            # and the import has to keep every one so its total reconciles.
            # They are watched by the duplicate sweep instead.
            models.UniqueConstraint(
                Lower("doi"),
                "owner",
                condition=(
                    models.Q(doi__isnull=False)
                    & ~models.Q(doi="")
                    & ~models.Q(status__in=["DRAFT", "REJECTED"])
                    & (models.Q(ticket_number__isnull=True) | ~models.Q(ticket_number__startswith="ERP-"))
                ),
                name="one_filed_claim_per_person_per_doi",
            ),
            # Money and author counts that cannot be (migration 0062).
            models.CheckConstraint(
                condition=models.Q(remuneration__isnull=True) | models.Q(remuneration__gte=0),
                name="claim_remuneration_non_negative",
            ),
            models.CheckConstraint(
                condition=models.Q(total_authors__gte=1) & models.Q(author_position__gte=1),
                name="claim_author_counts_positive",
            ),
        ]


class ClaimAttachment(models.Model):
    """An uploaded evidence file for a claim.

    A SEC_REFERENCE row also carries which citation it is: the number as printed
    in the manuscript's reference list, and the article's title. Those used to
    live in two unrelated free-text columns on Claim, so nothing connected
    reference 14 to its title or to the file that proved it.
    """

    id = models.CharField(primary_key=True, max_length=32, default=cuid, editable=False)
    claim = models.ForeignKey(Claim, on_delete=models.CASCADE, related_name="attachments")
    kind = models.CharField(max_length=32, choices=AttachmentKind.choices)
    url = models.TextField()
    filename = models.CharField(max_length=255, blank=True, null=True)
    size_bytes = models.IntegerField(default=0)
    #: sha256 of the file's own bytes. Renaming a PDF does not change it, so the
    #: same document uploaded twice is recognisable — as two references that are
    #: really one, or as evidence already used on another claim.
    content_hash = models.CharField(max_length=64, blank=True, null=True, db_index=True)
    ref_number = models.CharField(max_length=32, blank=True, null=True)
    ref_title = models.TextField(blank=True, null=True)
    uploaded_by = models.ForeignKey(
        User, null=True, blank=True, on_delete=models.SET_NULL, related_name="claim_uploads"
    )
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["created_at"]
        indexes = [models.Index(fields=["claim", "kind"])]


class ClaimAction(models.Model):
    id = models.CharField(primary_key=True, max_length=32, default=cuid, editable=False)
    claim = models.ForeignKey(Claim, on_delete=models.CASCADE, related_name="actions")
    actor = models.ForeignKey(User, on_delete=models.CASCADE, related_name="actions")
    from_status = models.CharField(max_length=32, choices=ClaimStatus.choices, blank=True, null=True)
    to_status = models.CharField(max_length=32, choices=ClaimStatus.choices, blank=True, null=True)
    action = models.CharField(max_length=64)
    note = models.TextField(blank=True, null=True)
    override = models.BooleanField(default=False)
    override_reason = models.TextField(blank=True, null=True)
    created_at = models.DateTimeField(auto_now_add=True)


class ScimagoJournal(models.Model):
    id = models.CharField(primary_key=True, max_length=32, default=cuid, editable=False)
    source_id = models.CharField(max_length=64, blank=True, null=True)
    title = models.CharField(max_length=512)
    issn = models.CharField(max_length=32, blank=True, null=True, db_index=True)
    eissn = models.CharField(max_length=32, blank=True, null=True, db_index=True)
    sjr = models.FloatField(blank=True, null=True)
    year = models.IntegerField(db_index=True)
    categories_json = models.TextField()
    raw_json = models.TextField(blank=True, null=True)
    verified_live = models.BooleanField(default=False)
    fetched_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        unique_together = [("issn", "year")]


class SnipSource(models.Model):
    """SNIP_2025 dump row."""
    id = models.CharField(primary_key=True, max_length=32, default=cuid, editable=False)
    source_id = models.CharField(max_length=64, blank=True, null=True, db_index=True)
    title = models.CharField(max_length=512)
    print_issn = models.CharField(max_length=32, blank=True, null=True, db_index=True)
    e_issn = models.CharField(max_length=32, blank=True, null=True, db_index=True)
    snip = models.FloatField(blank=True, null=True)
    sjr = models.FloatField(blank=True, null=True)
    year = models.IntegerField(default=2025, db_index=True)
    raw_json = models.TextField(blank=True, null=True)
    created_at = models.DateTimeField(auto_now_add=True)


class FacultyMaster(models.Model):
    """Faculty_Data sheet."""
    id = models.CharField(primary_key=True, max_length=32, default=cuid, editable=False)
    department = models.CharField(max_length=128, blank=True, null=True)
    biometric_id = models.CharField(max_length=64, blank=True, null=True, db_index=True)
    staff_id = models.CharField(max_length=64, blank=True, null=True, unique=True)
    scopus_author_id = models.CharField(max_length=64, blank=True, null=True)
    name = models.CharField(max_length=255)
    designation = models.CharField(max_length=128, blank=True, null=True)
    email = models.EmailField(blank=True, null=True)
    phone = models.CharField(max_length=64, blank=True, null=True)
    raw_json = models.TextField(blank=True, null=True)
    created_at = models.DateTimeField(auto_now_add=True)


class Team(models.Model):
    """A student project team, looked up by its code when a claim is filed.

    Teams exist outside any one claim because the same team enters more than
    one conference, and retyping five students and a mentor each time is how
    the second entry ends up describing a slightly different team from the
    first. The code is what a faculty member actually has to hand.
    """

    id = models.CharField(primary_key=True, max_length=32, default=cuid, editable=False)
    #: What the department calls it. Unique, and matched case-insensitively
    #: because it is read off a printed sheet as often as it is copied.
    code = models.CharField(max_length=64, unique=True, db_index=True)
    title = models.CharField(max_length=300, blank=True, null=True)
    department = models.CharField(max_length=255, blank=True, null=True, db_index=True)
    #: The academic year the team belongs to, as "2025-26".
    academic_year = models.CharField(max_length=9, blank=True, null=True)

    #: The faculty member accountable for the project. Where an incentive is
    #: paid on a student project claim, it is paid against this account.
    mentor = models.ForeignKey(
        "User", null=True, blank=True, on_delete=models.SET_NULL, related_name="teams_mentored"
    )
    #: Kept as text as well, because the roster carries mentors this system has
    #: no account for and losing the name is worse than not linking it.
    mentor_name = models.CharField(max_length=255, blank=True, null=True)
    #: The roster's "Faculty ID" exactly as the department wrote it. `mentor`
    #: is linked by matching it against `User.staff_id`; kept on its own so an
    #: unmatched mentor can still be found and linked once their account
    #: exists, rather than the one identifier the roster gave being lost.
    mentor_staff_id = models.CharField(max_length=64, blank=True, null=True, db_index=True)
    #: When the office's roster import last wrote this team. Null for a team
    #: entered by hand. A student-project claim is paid per team, so where the
    #: team came from is part of why the claim is payable.
    imported_at = models.DateTimeField(blank=True, null=True)

    active = models.BooleanField(default=True)
    created_by = models.ForeignKey(
        "User", null=True, blank=True, on_delete=models.SET_NULL, related_name="teams_created"
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["code"]

    def __str__(self) -> str:
        return f"{self.code} ({self.title or 'untitled'})"


class TeamMember(models.Model):
    """One student on a team, and the mentor who is accountable for them.

    A student is a name and a register number, not an account: they do not
    sign in, they are not paid, and creating a login for every project student
    would put thousands of payable identities in a system whose whole guard is
    that an identity decides who gets money.
    """

    id = models.CharField(primary_key=True, max_length=32, default=cuid, editable=False)
    team = models.ForeignKey(Team, on_delete=models.CASCADE, related_name="members")
    name = models.CharField(max_length=255)
    register_number = models.CharField(max_length=64, blank=True, null=True, db_index=True)
    programme = models.CharField(max_length=128, blank=True, null=True)
    year_of_study = models.CharField(max_length=32, blank=True, null=True)
    #: Each student has a mentor. Usually the team's, sometimes not.
    mentor_name = models.CharField(max_length=255, blank=True, null=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["name"]
        constraints = [
            models.UniqueConstraint(
                fields=["team", "register_number"],
                condition=models.Q(register_number__isnull=False),
                name="one_row_per_student_per_team",
            )
        ]

    def __str__(self) -> str:
        return f"{self.name} ({self.register_number or 'no register number'})"


class ScopusProfile(models.Model):
    """One author's Scopus profile, as the office's profile workbook has it.

    Academic figures, not money: publications, citations, the h-index and the
    document list Scopus holds for the author. Imported rather than fetched,
    because the college's workbook is what it has and the Scopus API key is
    rationed for verifying claims.

    `user` is the account the profile was linked to when it was imported --
    by the account's own Scopus id, or through the faculty master's. It is a
    record of that match, not the only way to find a person's profile: an id
    corrected on an account afterwards is matched again on the next import,
    and `core.services.scopus_profiles.profile_for` looks the id up directly.
    """

    id = models.CharField(primary_key=True, max_length=32, default=cuid, editable=False)
    #: Digits only. The workbook hands them over as floats ("57527550200.0").
    scopus_id = models.CharField(max_length=64, unique=True)
    user = models.ForeignKey(
        User, null=True, blank=True, on_delete=models.SET_NULL, related_name="scopus_profiles"
    )
    author_name = models.CharField(max_length=255, blank=True, null=True)
    affiliation = models.CharField(max_length=512, blank=True, null=True)
    total_publications = models.PositiveIntegerField(blank=True, null=True)
    total_citations = models.PositiveIntegerField(blank=True, null=True)
    h_index = models.PositiveIntegerField(blank=True, null=True)
    #: Every Metric | Value pair on the sheet, as read, plus the Year |
    #: Publications table under "Publications by year".
    metrics = models.JSONField(default=dict, blank=True)
    # The papers on the sheet go into the publication record (Publication /
    # Authorship), not here: one list of papers, not two.
    source_sheet = models.CharField(max_length=255, blank=True, default="")
    source_file = models.CharField(max_length=255, blank=True, null=True)
    imported_at = models.DateTimeField()

    class Meta:
        ordering = ["author_name", "scopus_id"]

    def __str__(self) -> str:
        return f"{self.scopus_id} ({self.source_sheet})"


class BankExport(models.Model):
    """One bank-upload file Finance generated for a payout month.

    Without a record, the same month's file could be downloaded and sent to
    the bank twice, and the bank pays what it is sent. Each file lists the
    ledger rows it carried (`PaidLedger.bank_export`), so the next file for the
    month defaults to what has *not* gone yet, and a full re-export is a
    deliberate act with a reason.
    """

    id = models.CharField(primary_key=True, max_length=32, default=cuid, editable=False)
    #: "YYYY-MM".
    month = models.CharField(max_length=7, db_index=True)
    created_by = models.ForeignKey(
        "User", null=True, blank=True, on_delete=models.SET_NULL, related_name="bank_exports"
    )
    created_at = models.DateTimeField(auto_now_add=True)
    row_count = models.PositiveIntegerField(default=0)
    total_amount = models.FloatField(default=0)
    #: sha256 of the file's bytes, so two identical files are recognisable.
    sha256 = models.CharField(max_length=64, blank=True, default="")
    #: "new" (only payments not yet sent) or "all" (the whole month again).
    scope = models.CharField(max_length=8, default="all")
    #: Why a month was sent again; required for scope "all" after a first file.
    reason = models.TextField(blank=True, null=True)

    class Meta:
        ordering = ["-created_at"]

    def __str__(self) -> str:
        return f"{self.month} {self.scope} {self.row_count} rows"


class PaidLedger(models.Model):
    """Master_List_Accounts style month ledger.

    Append-only. A payment is one `PAYMENT` row; voiding it writes a
    `REVERSAL` row for the same `cycle` rather than editing anything, and
    paying the claim again starts the next cycle. The two partial unique
    indexes below are what make "one live payment per claim" a fact of the
    database rather than a habit of the code: a second PAYMENT in the same
    cycle is refused by the database, whatever the application did.
    """

    class Kind(models.TextChoices):
        PAYMENT = "PAYMENT", "Payment"
        REVERSAL = "REVERSAL", "Reversal of a payment"
        ADJUSTMENT = "ADJUSTMENT", "Correction to a payment"

    id = models.CharField(primary_key=True, max_length=32, default=cuid, editable=False)
    claim = models.ForeignKey(Claim, null=True, blank=True, on_delete=models.SET_NULL, related_name="ledger_rows")
    kind = models.CharField(max_length=12, choices=Kind.choices, default=Kind.PAYMENT)
    #: 1 for the first payment of a claim; one more after each void.
    cycle = models.PositiveSmallIntegerField(default=1)
    #: Sent by the client with a pay request and stored with the row it made,
    #: so a retry after a timeout finds its own payment instead of making a
    #: second one. Null on rows that did not come from a pay request.
    idempotency_key = models.CharField(max_length=128, null=True, blank=True, unique=True)
    bank_export = models.ForeignKey(
        BankExport, null=True, blank=True, on_delete=models.SET_NULL, related_name="rows"
    )
    payout_month = models.DateField(db_index=True)
    department = models.CharField(max_length=128, blank=True, null=True)
    faculty_name = models.CharField(max_length=255, blank=True, null=True)
    staff_id = models.CharField(max_length=64, blank=True, null=True)
    biometric_id = models.CharField(max_length=64, blank=True, null=True)
    paper_title = models.TextField(blank=True, null=True)
    journal_title = models.CharField(max_length=512, blank=True, null=True)
    amount = models.FloatField(default=0)
    voucher_number = models.CharField(max_length=64, blank=True, null=True)
    raw_json = models.TextField(blank=True, null=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [
            # One live payment per claim (migration 0075). NULL claims -- the
            # old workbook's history -- are distinct, so they are unaffected.
            models.UniqueConstraint(
                fields=["claim", "cycle"],
                condition=models.Q(kind="PAYMENT"),
                name="one_payment_per_claim_cycle",
            ),
            # A payment can be reversed once; two Super Admins pressing Void
            # together write one reversal and one refusal, never two.
            models.UniqueConstraint(
                fields=["claim", "cycle"],
                condition=models.Q(kind="REVERSAL"),
                name="one_reversal_per_claim_cycle",
            ),
        ]


class ResearchThreshold(models.Model):
    """One decision about a research faculty member's yearly rupee threshold.

    Research faculty are already paid to do research, so the first part of the
    incentives they earn each year is not paid: "no incentive up to ₹3 lakh a
    year". The research coordinator or a super admin sets that amount for each
    person. Every decision is a row, never an edit in place, so who set what,
    when, and why stays on record and a past year keeps the threshold that
    applied then.

    The threshold in force on a day is the newest row whose `effective_from`
    is on or before it. `amount` empty means "not set": the person is treated
    as regular faculty from that day and the coordinator is warned.
    """

    id = models.CharField(primary_key=True, max_length=32, default=cuid, editable=False)
    user = models.ForeignKey(User, on_delete=models.CASCADE, related_name="research_thresholds")
    amount = models.FloatField(blank=True, null=True)
    effective_from = models.DateField()
    note = models.TextField(blank=True, null=True)
    set_by = models.ForeignKey(
        User, null=True, blank=True, on_delete=models.SET_NULL, related_name="research_thresholds_set"
    )
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-effective_from", "-created_at"]
        indexes = [models.Index(fields=["user", "-effective_from"])]
        constraints = [
            models.CheckConstraint(
                condition=models.Q(amount__isnull=True) | models.Q(amount__gte=0),
                name="research_threshold_non_negative",
            ),
        ]

    def __str__(self) -> str:
        return f"{self.user_id} from {self.effective_from}: {self.amount}"


class ImmutableRecord(Exception):
    """Somebody tried to edit or delete a row that is a record of what happened."""


class AuditQuerySet(models.QuerySet):
    """A queryset that cannot rewrite history.

    Without this, `AuditLog.objects.filter(...).update(...)` or `.delete()` --
    from a shell, a data fix, a well-meant clean-up -- quietly erases who moved
    money. `_base_manager` stays plain for the rare test that must backdate a
    row, and Django's own SET NULL when a user is deleted does not pass here.
    """

    def update(self, **kwargs):
        raise ImmutableRecord("The audit log is append-only: rows cannot be edited.")

    def delete(self):
        raise ImmutableRecord("The audit log is append-only: rows cannot be deleted.")

    def bulk_update(self, *args, **kwargs):
        raise ImmutableRecord("The audit log is append-only: rows cannot be edited.")


class AuditLog(models.Model):
    """Who did what, and when. Append-only: written once, never changed.

    Enforced in three places so that no single mistake undoes it: this model
    (save and delete refuse once a row exists), the queryset (update and delete
    refuse), and on PostgreSQL a trigger from migration 0075 that refuses any
    UPDATE or DELETE except the SET NULL Django writes when a person's account
    is removed.
    """

    id = models.CharField(primary_key=True, max_length=32, default=cuid, editable=False)
    actor = models.ForeignKey(
        User, null=True, blank=True, on_delete=models.SET_NULL, related_name="audit_logs"
    )
    action = models.CharField(max_length=128)
    entity = models.CharField(max_length=64)
    entity_id = models.CharField(max_length=64, blank=True, null=True)
    detail_json = models.TextField(blank=True, null=True)
    created_at = models.DateTimeField(auto_now_add=True)

    objects = AuditQuerySet.as_manager()

    def save(self, *args, **kwargs):
        if not self._state.adding:
            raise ImmutableRecord("The audit log is append-only: a row cannot be edited.")
        super().save(*args, **kwargs)

    def delete(self, *args, **kwargs):
        raise ImmutableRecord("The audit log is append-only: a row cannot be deleted.")


class ClaimConfirmation(models.Model):
    """One eligibility condition ticked by a person for one article, at filing.

    Legal record (services/filing_conditions.py): the exact text and version
    shown, when it was ticked, and from where. Never edited. The AuditLog row written alongside
    outlives the claim if the claim is ever deleted.
    """

    id = models.CharField(primary_key=True, max_length=32, default=cuid, editable=False)
    claim = models.ForeignKey(Claim, on_delete=models.CASCADE, related_name="confirmations")
    user = models.ForeignKey(User, null=True, on_delete=models.SET_NULL, related_name="claim_confirmations")
    condition_id = models.CharField(max_length=32)
    text_version = models.CharField(max_length=16)
    text = models.TextField()
    doi = models.CharField(max_length=255, blank=True, null=True)
    paper_title = models.TextField(blank=True, null=True)
    ticked_at = models.DateTimeField()
    recorded_at = models.DateTimeField(auto_now_add=True)
    ip_address = models.CharField(max_length=64, blank=True, null=True)
    user_agent = models.CharField(max_length=512, blank=True, default="")

    class Meta:
        indexes = [models.Index(fields=["claim", "recorded_at"])]


class Notification(models.Model):
    id = models.CharField(primary_key=True, max_length=32, default=cuid, editable=False)
    user = models.ForeignKey(User, on_delete=models.CASCADE, related_name="notifications")
    title = models.CharField(max_length=255)
    body = models.TextField(blank=True, null=True)
    href = models.CharField(max_length=512, blank=True, null=True)
    read = models.BooleanField(default=False)
    claim_id = models.CharField(max_length=32, blank=True, null=True)
    created_at = models.DateTimeField(auto_now_add=True)
    #: Which kind of alert this is (core.services.notify.KINDS). It is what a
    #: person switches off, and what the bell's tabs filter on. Rows written
    #: before kinds existed, or by code that writes rows directly, are
    #: "general" -- which can be switched off like any other.
    kind = models.CharField(max_length=40, default="general", db_index=True)
    #: Alerts with the same key merge while unread: three likes on one post
    #: are one line, "Asha and 2 others liked your post".
    group_key = models.CharField(max_length=160, blank=True, null=True, db_index=True)
    group_count = models.PositiveIntegerField(default=1)
    #: Who the grouped alert is about, newest first: [{"id", "name"}].
    actors = models.JSONField(default=list, blank=True)
    #: When this alert also went out by email. What the daily email cap counts.
    emailed_at = models.DateTimeField(blank=True, null=True, db_index=True)


class ProfileChangeRequest(models.Model):
    """A detail a claimant cannot change themselves, asked for and decided on.

    Identity fields — name, staff id, biometric id, the Scopus link — decide
    who gets paid and whose record a paper is checked against, so a claimant
    cannot edit their own. That is right, and it left them with no way to fix a
    misspelt name except to email somebody and hope.

    The request used to be a notification and an audit entry. Both are
    write-only: an admin who missed the notification lost the request for good,
    there was no list of what was outstanding, and the person who asked never
    found out whether anything had happened. This is the row that makes it a
    piece of work somebody can pick up, finish, and be seen to have finished.
    """

    class State(models.TextChoices):
        PENDING = "PENDING", "Waiting for the research office"
        APPROVED = "APPROVED", "Applied"
        DECLINED = "DECLINED", "Declined"

    id = models.CharField(primary_key=True, max_length=32, default=cuid, editable=False)
    user = models.ForeignKey(
        User, on_delete=models.CASCADE, related_name="profile_change_requests"
    )
    field = models.CharField(max_length=64)
    #: What the record said when the request was made. Kept because the value
    #: can move underneath a pending request, and an approver needs to know
    #: they are overwriting something different from what was asked about.
    current_value = models.CharField(max_length=512, blank=True, null=True)
    proposed_value = models.CharField(max_length=512)
    note = models.TextField(blank=True, null=True)
    status = models.CharField(max_length=16, choices=State.choices, default=State.PENDING, db_index=True)
    decided_by = models.ForeignKey(
        User, on_delete=models.SET_NULL, null=True, blank=True,
        related_name="profile_changes_decided",
    )
    decided_at = models.DateTimeField(blank=True, null=True)
    decision_note = models.TextField(blank=True, null=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        indexes = [models.Index(fields=["status", "-created_at"])]

    def __str__(self) -> str:
        return f"{self.user_id} · {self.field} → {self.proposed_value}"


class ClaimNote(models.Model):
    """A note about one ticket, written for a named audience.

    Kept apart from ClaimAction because that is the claim's history and the
    claimant can read it. A principal raising a concern with the research cell
    is not part of the story the claimant is shown, and putting it there would
    leak it the moment anyone opened their own ticket.
    """

    class Audience(models.TextChoices):
        #: The research cell only. The claimant and finance never see it.
        ADMIN = "ADMIN", "Admin only"

    id = models.CharField(primary_key=True, max_length=32, default=cuid, editable=False)
    claim = models.ForeignKey(Claim, on_delete=models.CASCADE, related_name="notes")
    author = models.ForeignKey(
        User, null=True, blank=True, on_delete=models.SET_NULL, related_name="claim_notes"
    )
    audience = models.CharField(
        max_length=16, choices=Audience.choices, default=Audience.ADMIN
    )
    body = models.TextField()
    resolved_at = models.DateTimeField(blank=True, null=True)
    resolved_by = models.ForeignKey(
        User, null=True, blank=True, on_delete=models.SET_NULL,
        related_name="claim_notes_resolved",
    )
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-created_at"]
        indexes = [models.Index(fields=["claim", "-created_at"])]


class ReviewMark(models.Model):
    """A reviewer's mark on a claim: a region or a quoted span of one document.

    Kept apart from ClaimNote (a desk-to-desk message) and ClaimFlag (a doubt
    about the paper) because a mark can be *for the claimant*: an ISSUE mark
    with audience CLAIMANT is what a send-back is built from, and it is what
    the claimant sees, in place, on their own PDF. Everything else is staff
    only. Which mark reaches whom is decided in `core.api.review_marks`.

    `upload` is null for a checklist-only mark (no document, no page).
    `rect_*` are fractions of the page (0..1, origin top-left), so a mark
    survives any rendering size.
    """

    class Kind(models.TextChoices):
        ISSUE = "ISSUE", "Issue"
        OK = "OK", "OK"
        NOTE = "NOTE", "Note"

    class Audience(models.TextChoices):
        CLAIMANT = "CLAIMANT", "For the claimant"
        STAFF = "STAFF", "Staff only"

    class Checklist(models.TextChoices):
        AFFILIATION = "affiliation", "Affiliation"
        AUTHOR_POSITION = "author_position", "Author position"
        SEC_REFS = "sec_refs", "SEC references"
        INDEXING = "indexing", "Indexing"
        QUARTILE = "quartile", "Quartile"
        DUPLICATE = "duplicate", "Duplicate"
        OTHER = "other", "Other"

    id = models.CharField(primary_key=True, max_length=32, default=cuid, editable=False)
    claim = models.ForeignKey(Claim, on_delete=models.CASCADE, related_name="review_marks")
    upload = models.ForeignKey(
        "ClaimAttachment", null=True, blank=True, on_delete=models.CASCADE,
        related_name="review_marks",
    )
    page = models.PositiveIntegerField(null=True, blank=True)
    rect_x = models.FloatField(null=True, blank=True)
    rect_y = models.FloatField(null=True, blank=True)
    rect_w = models.FloatField(null=True, blank=True)
    rect_h = models.FloatField(null=True, blank=True)
    quote = models.TextField(blank=True, default="")
    kind = models.CharField(max_length=8, choices=Kind.choices, default=Kind.ISSUE)
    audience = models.CharField(max_length=10, choices=Audience.choices, default=Audience.CLAIMANT)
    checklist_key = models.CharField(
        max_length=24, choices=Checklist.choices, blank=True, default=""
    )
    body = models.TextField(blank=True, default="")
    author = models.ForeignKey(
        User, null=True, blank=True, on_delete=models.SET_NULL, related_name="review_marks"
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)
    resolved_at = models.DateTimeField(blank=True, null=True)
    resolved_by = models.ForeignKey(
        User, null=True, blank=True, on_delete=models.SET_NULL,
        related_name="review_marks_resolved",
    )
    #: Set when the claim went back to the claimant with this mark open: the
    #: moment the mark became part of what the claimant reads.
    sent_back_at = models.DateTimeField(blank=True, null=True)
    #: Set when the claim was filed again with this mark still open: the
    #: claimant says they fixed it, and the reviewer confirms ("fixed?") by
    #: resolving it, or reopens it.
    resolved_in_resubmission = models.BooleanField(default=False)

    class Meta:
        ordering = ["upload_id", "page", "rect_y", "created_at"]
        indexes = [models.Index(fields=["claim", "audience"])]


class SendBackRecord(models.Model):
    """What went back to the claimant, as it stood when it went.

    The reason the reviewer wrote, the open claimant-facing marks and the
    failed checklist items at that moment. The faculty fix view reads the
    latest one; a later edit to a mark does not rewrite what was sent.
    """

    id = models.CharField(primary_key=True, max_length=32, default=cuid, editable=False)
    claim = models.ForeignKey(Claim, on_delete=models.CASCADE, related_name="send_backs")
    action = models.ForeignKey(
        ClaimAction, null=True, blank=True, on_delete=models.SET_NULL, related_name="send_backs"
    )
    reason = models.TextField(blank=True, default="")
    marks_json = models.TextField(default="[]")
    checklist_json = models.TextField(default="[]")
    created_by = models.ForeignKey(
        User, null=True, blank=True, on_delete=models.SET_NULL, related_name="send_backs"
    )
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-created_at"]


class MonthlyBatch(models.Model):
    id = models.CharField(primary_key=True, max_length=32, default=cuid, editable=False)
    name = models.CharField(max_length=255)
    status = models.CharField(max_length=16, choices=BatchStatus.choices, default=BatchStatus.PENDING)
    created_by = models.ForeignKey(User, on_delete=models.CASCADE, related_name="monthly_batches")
    error_message = models.TextField(blank=True, null=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)
    started_at = models.DateTimeField(blank=True, null=True)
    finished_at = models.DateTimeField(blank=True, null=True)
    #: Touched per row while processing. A RUNNING batch whose heartbeat has
    #: gone stale was killed mid-run (deploy, spin-down) and can be resumed.
    heartbeat_at = models.DateTimeField(blank=True, null=True)


class MonthlyRow(models.Model):
    id = models.CharField(primary_key=True, max_length=32, default=cuid, editable=False)
    batch = models.ForeignKey(MonthlyBatch, on_delete=models.CASCADE, related_name="rows")
    row_number = models.IntegerField()
    author_id_raw = models.TextField(blank=True, null=True)
    paper_title = models.TextField(blank=True, null=True)
    index_status = models.CharField(max_length=255, blank=True, null=True)
    linkage = models.CharField(max_length=64, blank=True, null=True)
    matched_title = models.TextField(blank=True, null=True)
    journal = models.CharField(max_length=512, blank=True, null=True)
    aggregation_type = models.CharField(max_length=64, blank=True, null=True)
    issn = models.CharField(max_length=32, blank=True, null=True)
    cover_date = models.CharField(max_length=32, blank=True, null=True)
    eid = models.CharField(max_length=64, blank=True, null=True)
    doi = models.CharField(max_length=255, blank=True, null=True)
    scopus_url = models.TextField(blank=True, null=True)
    sjr_quartile = models.CharField(max_length=64, blank=True, null=True)
    subjects = models.TextField(blank=True, null=True)
    snip = models.CharField(max_length=64, blank=True, null=True)
    engineering_class = models.CharField(max_length=64, blank=True, null=True)
    raw_json = models.TextField(blank=True, null=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["row_number"]


class Thread(models.Model):
    """A conversation, attached to the things it is about.

    Deliberately not a chat room. A thread can name a journal, a paper, a
    person or a department, and those names are resolved to real records when
    the post is written -- so "what does @Nature actually pay" is answerable
    by the system rather than by whoever happens to read it, and a thread
    about a paper can be found from the paper.

    Visibility is three-valued and enforced in one place:

    - PUBLIC      everybody signed in
    - DEPARTMENT  one department, so a head can talk with their own staff
    - OFFICE      the research cell and a super admin, plus whoever opened it

    That last clause is the whole reason OFFICE exists: "ask the admin why my
    claim was sent back" has to be invisible to colleagues and visible to the
    person who asked, or nobody uses it and they email instead.
    """

    class Visibility(models.TextChoices):
        PUBLIC = "PUBLIC", "Everybody"
        DEPARTMENT = "DEPARTMENT", "One department"
        OFFICE = "OFFICE", "The office, and whoever asked"
        #: A named set of people and nobody else. The only visibility whose
        #: audience is a list rather than a property of the reader, which is
        #: why it needs `ThreadParticipant` and why the other three did not.
        DIRECT = "DIRECT", "The people in it"

    id = models.CharField(primary_key=True, max_length=32, default=cuid, editable=False)
    title = models.CharField(max_length=300)
    visibility = models.CharField(
        max_length=16, choices=Visibility.choices, default=Visibility.PUBLIC, db_index=True
    )
    #: Set when visibility is DEPARTMENT; ignored otherwise.
    department = models.CharField(max_length=255, blank=True, null=True, db_index=True)
    #: One of the 302 Scimago subject categories, so threads group by field
    #: rather than by a free-text tag nobody spells the same way twice.
    topic = models.CharField(max_length=255, blank=True, null=True, db_index=True)

    #: What it is about, where it is about something we hold.
    claim = models.ForeignKey(
        "Claim", null=True, blank=True, on_delete=models.SET_NULL, related_name="threads"
    )
    journal_title = models.CharField(max_length=512, blank=True, null=True)

    created_by = models.ForeignKey(
        User, null=True, on_delete=models.SET_NULL, related_name="threads_started"
    )
    created_at = models.DateTimeField(auto_now_add=True)
    #: Moved by every post, so a list can be ordered by activity without
    #: joining and aggregating on every read.
    last_post_at = models.DateTimeField(auto_now_add=True, db_index=True)
    post_count = models.PositiveIntegerField(default=0)

    resolved = models.BooleanField(default=False)
    resolved_by = models.ForeignKey(
        User, null=True, blank=True, on_delete=models.SET_NULL,
        related_name="threads_resolved",
    )
    resolved_at = models.DateTimeField(blank=True, null=True)
    #: A locked thread is readable and closed to new posts.
    locked = models.BooleanField(default=False)
    #: What a direct conversation was started about -- {kind, id, title} of a
    #: paper, a person or a collaboration request -- shown as a card at its top.
    context = models.JSONField(blank=True, null=True)

    class Meta:
        ordering = ["-last_post_at"]
        indexes = [
            models.Index(fields=["visibility", "-last_post_at"]),
            models.Index(fields=["department", "-last_post_at"]),
        ]

    def __str__(self) -> str:
        return self.title[:60]


class ThreadParticipant(models.Model):
    """One person who is in a direct conversation.

    Distinct from `ThreadSubscription`, which is notification routing and
    grants nothing: `visible_threads` has never consulted it. This table *is*
    the audience, and `visible_threads` reads it. Keeping the two apart means
    somebody can mute a conversation they are in without leaving it, and being
    told about a thread still never implies being able to open it.
    """

    id = models.CharField(primary_key=True, max_length=32, default=cuid, editable=False)
    thread = models.ForeignKey(
        Thread, on_delete=models.CASCADE, related_name="participants"
    )
    user = models.ForeignKey(
        "User", on_delete=models.CASCADE, related_name="direct_threads"
    )
    added_at = models.DateTimeField(auto_now_add=True)
    #: When they last had the conversation open and in front of them. What
    #: "unread" is counted from, and what the others see as "seen".
    last_read_at = models.DateTimeField(blank=True, null=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["thread", "user"], name="one_row_per_person_per_thread"
            )
        ]

    def __str__(self) -> str:
        return f"{self.user_id} in {self.thread_id}"


class Post(models.Model):
    """One message in a thread.

    Deleted rather than removed: a moderated post leaves a tombstone so the
    replies underneath it still make sense. A thread with a hole in it reads
    as a bug, and reconstructing who was answering what is impossible once
    the message they answered is simply gone.
    """

    class Kind(models.TextChoices):
        HUMAN = "HUMAN", "Written by a person"
        AGENT = "AGENT", "Answered by the assistant"
        SYSTEM = "SYSTEM", "Recorded by the system"

    id = models.CharField(primary_key=True, max_length=32, default=cuid, editable=False)
    thread = models.ForeignKey(Thread, on_delete=models.CASCADE, related_name="posts")
    #: Null for an agent or system post -- nobody wrote it.
    author = models.ForeignKey(
        User, null=True, blank=True, on_delete=models.SET_NULL, related_name="posts"
    )
    kind = models.CharField(max_length=8, choices=Kind.choices, default=Kind.HUMAN)
    body = models.TextField()
    reply_to = models.ForeignKey(
        "self", null=True, blank=True, on_delete=models.SET_NULL, related_name="replies"
    )
    created_at = models.DateTimeField(auto_now_add=True)
    edited_at = models.DateTimeField(blank=True, null=True)
    deleted_at = models.DateTimeField(blank=True, null=True)
    deleted_by = models.ForeignKey(
        User, null=True, blank=True, on_delete=models.SET_NULL, related_name="posts_deleted"
    )

    class Meta:
        ordering = ["created_at"]
        indexes = [models.Index(fields=["thread", "created_at"])]

    def __str__(self) -> str:
        return f"{self.thread_id}: {self.body[:40]}"


class Mention(models.Model):
    """An @name in a post, resolved to the record it points at.

    Resolved when the post is written rather than when it is read. A person
    changing department, or a journal being retitled, must not silently
    re-point a mention somebody already answered -- and the alternative,
    re-parsing the text on every read, means the same string quietly means
    something different a year later.
    """

    class Kind(models.TextChoices):
        USER = "USER", "A person"
        JOURNAL = "JOURNAL", "A journal"
        PAPER = "PAPER", "A paper"
        DEPARTMENT = "DEPARTMENT", "A department"
        AGENT = "AGENT", "The assistant"

    id = models.CharField(primary_key=True, max_length=32, default=cuid, editable=False)
    post = models.ForeignKey(Post, on_delete=models.CASCADE, related_name="mentions")
    kind = models.CharField(max_length=16, choices=Kind.choices, db_index=True)
    #: What was typed, kept so the post can be rendered as it was written.
    label = models.CharField(max_length=300)

    user = models.ForeignKey(
        User, null=True, blank=True, on_delete=models.SET_NULL, related_name="mentioned_in"
    )
    claim = models.ForeignKey(
        "Claim", null=True, blank=True, on_delete=models.SET_NULL, related_name="mentioned_in"
    )
    journal_title = models.CharField(max_length=512, blank=True, null=True)
    department = models.CharField(max_length=255, blank=True, null=True)

    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        indexes = [models.Index(fields=["kind", "user"])]

    def __str__(self) -> str:
        return f"@{self.label} ({self.kind})"


class ThreadSubscription(models.Model):
    """Who hears about a thread.

    Subscribed automatically by starting one, posting in one, or being
    mentioned in one -- the three moments somebody has demonstrably taken an
    interest. `muted` exists so leaving a noisy thread does not mean losing
    the record that you were in it.
    """

    id = models.CharField(primary_key=True, max_length=32, default=cuid, editable=False)
    thread = models.ForeignKey(Thread, on_delete=models.CASCADE, related_name="subscriptions")
    user = models.ForeignKey(User, on_delete=models.CASCADE, related_name="thread_subscriptions")
    muted = models.BooleanField(default=False)
    created_at = models.DateTimeField(auto_now_add=True)
    last_read_at = models.DateTimeField(blank=True, null=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["thread", "user"], name="one_subscription_per_thread")
        ]

    def __str__(self) -> str:
        return f"{self.user_id} -> {self.thread_id}"


class CalendarEvent(models.Model):
    """Something with a date on it.

    Nothing in this system held a future date. A payout run was a processing
    batch with no schedule, and a submission window or a deadline was not
    modelled at all -- so a calendar built on what existed could only replay
    months that had already been paid.

    Kept deliberately plain: a title, a kind, a day or a span, and who may see
    it. An event can come out of a thread, which is the point of having both
    -- "we should submit to this by March" becomes a date rather than a
    sentence somebody has to remember reading.
    """

    class Kind(models.TextChoices):
        PAYOUT_RUN = "PAYOUT_RUN", "Payout run"
        SUBMISSION_WINDOW = "SUBMISSION_WINDOW", "Submission window"
        DEADLINE = "DEADLINE", "Deadline"
        MEETING = "MEETING", "Meeting"
        OTHER = "OTHER", "Something else"

    id = models.CharField(primary_key=True, max_length=32, default=cuid, editable=False)
    title = models.CharField(max_length=300)
    kind = models.CharField(
        max_length=24, choices=Kind.choices, default=Kind.OTHER, db_index=True
    )
    starts_on = models.DateField(db_index=True)
    #: Null for a single day. A window has both.
    ends_on = models.DateField(blank=True, null=True)
    description = models.TextField(blank=True, null=True)

    #: Deliberately NOT `Thread.Visibility.choices`.
    #:
    #: It used to be, and that stopped being safe the moment threads gained
    #: DIRECT: a direct thread's audience is a row per person in
    #: `ThreadParticipant`, and an event has no such table. A calendar event
    #: marked DIRECT would be an event with an empty audience -- created
    #: successfully, then visible to nobody, including whoever made it.
    visibility = models.CharField(
        max_length=16,
        choices=[
            (v, label)
            for v, label in Thread.Visibility.choices
            if v != Thread.Visibility.DIRECT
        ]
        #: A personal reminder: its creator's and nobody else's, the office
        #: included. Threads have no such thing; a diary does.
        + [("PRIVATE", "Only me")],
        default=Thread.Visibility.PUBLIC,
        db_index=True,
    )
    department = models.CharField(max_length=255, blank=True, null=True, db_index=True)

    #: Null on both for an all-day entry. A time is local college time.
    starts_at = models.TimeField(blank=True, null=True)
    ends_at = models.TimeField(blank=True, null=True)

    #: Where it came from, when it came from somewhere.
    thread = models.ForeignKey(
        Thread, null=True, blank=True, on_delete=models.SET_NULL, related_name="events"
    )
    claim = models.ForeignKey(
        "Claim", null=True, blank=True, on_delete=models.SET_NULL, related_name="events"
    )

    created_by = models.ForeignKey(
        User, null=True, on_delete=models.SET_NULL, related_name="events_created"
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["starts_on", "title"]
        indexes = [models.Index(fields=["starts_on", "visibility"])]

    def __str__(self) -> str:
        return f"{self.starts_on} {self.title[:40]}"


class CalendarFeed(models.Model):
    """The secret in somebody's calendar subscription URL.

    A bearer token: whoever holds the link reads the feed, which is why the
    feed carries titles and dates only, and why a reset replaces the token --
    the old link stops working at once.
    """

    user = models.OneToOneField(User, on_delete=models.CASCADE, related_name="calendar_feed")
    token = models.CharField(max_length=64, unique=True)
    created_at = models.DateTimeField(auto_now=True)

    def __str__(self) -> str:
        return f"feed {self.user_id}"


class ResearchInterest(models.Model):
    """A subject domain somebody has said they work in.

    Two uses, and the second is why it is a row rather than a free-text field
    on the profile. It grounds the "what could I write next" suggestion, and it
    makes "who could I work with" answerable for somebody who has not published
    here yet — a new lecturer has no co-authors and no claim history, so
    inference has nothing to work from and they see an empty screen forever.

    The domain is drawn from the 302 subject categories our own Scimago rows
    are classified under, not typed freely. A domain nobody's journals are
    filed under cannot be matched against anything later, so free text would
    quietly produce a field that looks set and does nothing.
    """

    id = models.CharField(primary_key=True, max_length=32, default=cuid, editable=False)
    user = models.ForeignKey(
        User, on_delete=models.CASCADE, related_name="research_interests"
    )
    domain = models.CharField(max_length=160)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        # One row per person per domain. Saying it twice is not more true, and
        # a duplicate would double that domain's weight in every match.
        constraints = [
            models.UniqueConstraint(
                fields=["user", "domain"], name="unique_interest_per_person"
            )
        ]
        indexes = [models.Index(fields=["domain"])]
        ordering = ["domain"]

    def __str__(self) -> str:
        return f"{self.user_id}: {self.domain}"


class DiscoverDismissal(models.Model):
    """"Not interested" on a Discover card, kept per person on the server so it
    follows them between devices. `key` is the feed id (`topic:ml`,
    `venue:ieee access`, `person:<id>`, `paper:<id>`); undo deletes the row."""

    id = models.CharField(primary_key=True, max_length=32, default=cuid, editable=False)
    user = models.ForeignKey(User, on_delete=models.CASCADE, related_name="discover_dismissals")
    kind = models.CharField(max_length=24)
    key = models.CharField(max_length=300)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["user", "key"], name="unique_dismissal_per_person")
        ]

    def __str__(self) -> str:
        return f"{self.user_id}: {self.key}"


class SystemSetting(models.Model):
    """Institution-level configuration that belongs to the data, not the code.

    A college's name is not a deployment variable -- it is a fact about the
    institution, and a fresh install of this product at another college must
    be able to state its own without a code change. Values here are the
    white-label layer: identity strings an office owns, never secrets (those
    stay in the environment) and never workflow rules (those stay in the
    versioned payout policy).
    """

    key = models.CharField(primary_key=True, max_length=64)
    value = models.JSONField(default=dict)
    updated_by = models.ForeignKey(
        User, null=True, blank=True, on_delete=models.SET_NULL, related_name="system_settings"
    )
    updated_at = models.DateTimeField(auto_now=True)

    def __str__(self) -> str:
        return f"{self.key}"


class StoredFile(models.Model):
    """An uploaded file kept in the database (core.storage_db.DatabaseStorage)."""

    name = models.CharField(max_length=512, unique=True)
    content = models.BinaryField()
    size = models.PositiveIntegerField(default=0)
    created_at = models.DateTimeField(auto_now_add=True)

    def __str__(self) -> str:
        return self.name


class JournalWatch(models.Model):
    """A journal the research cell has chosen to look at twice.

    Scopus's discontinued list and UGC-CARE removals arrive late, and cloned
    titles reuse real ISSNs. The research cell keeps its own list, with the
    reason, and every ticket in that journal carries the warning to the desk.
    Matched by ISSN when one is given, otherwise by the title (ignoring case).
    """

    id = models.CharField(primary_key=True, max_length=32, default=cuid, editable=False)
    issn = models.CharField(max_length=32, blank=True, null=True, db_index=True)
    title = models.CharField(max_length=512, blank=True, null=True)
    reason = models.TextField()
    added_by = models.ForeignKey(
        User, null=True, blank=True, on_delete=models.SET_NULL, related_name="journal_watches"
    )
    created_at = models.DateTimeField(auto_now_add=True)


class ClaimFlag(models.Model):
    """A discrepancy somebody noticed on a claim, which never stops it.

    The college's rule (2026-09-23): a claim with a question over it keeps
    moving and can be paid. Holding the money until the question is answered
    is what a hold is for; a flag is the record that the question was asked,
    by whom, and what the answer was -- so that paying a claim somebody had
    doubts about is a visible decision rather than an unnoticed one.

    Seen by the research cell, the coordinator, the Principal and the super
    admin. Never by the Director or Finance (the same rule as the contested
    payment-history match, `core.visibility`) and never by the claimant.
    """

    class Kind(models.TextChoices):
        CONTENT_MISMATCH = "CONTENT_MISMATCH", "The file does not match the claim"
        AMOUNT = "AMOUNT", "Amount"
        AUTHOR = "AUTHOR", "Author"
        AFFILIATION = "AFFILIATION", "Affiliation"
        DUPLICATE = "DUPLICATE", "Possible duplicate"
        OTHER = "OTHER", "Something else"

    class Source(models.TextChoices):
        AUTO = "AUTO", "Raised by a check"
        MANUAL = "MANUAL", "Raised by a reviewer"

    id = models.CharField(primary_key=True, max_length=32, default=cuid, editable=False)
    claim = models.ForeignKey(Claim, on_delete=models.CASCADE, related_name="flags")
    kind = models.CharField(max_length=32, choices=Kind.choices, db_index=True)
    source = models.CharField(max_length=8, choices=Source.choices, default=Source.MANUAL)
    note = models.TextField()
    #: Null for a flag a check raised on its own.
    raised_by = models.ForeignKey(
        User, null=True, blank=True, on_delete=models.SET_NULL, related_name="flags_raised"
    )
    raised_at = models.DateTimeField(auto_now_add=True)
    resolved_by = models.ForeignKey(
        User, null=True, blank=True, on_delete=models.SET_NULL, related_name="flags_resolved"
    )
    resolved_at = models.DateTimeField(blank=True, null=True, db_index=True)
    resolution_note = models.TextField(blank=True, null=True)
    #: What an automatic check keys its flag on -- one flag per file, per
    #: import rule -- so running the check again raises nothing twice, and a
    #: flag somebody has resolved is not raised again behind their back.
    #: Null on a reviewer's own flag: two people may well ask two questions.
    auto_key = models.CharField(max_length=255, blank=True, null=True)

    class Meta:
        ordering = ["-raised_at"]
        indexes = [models.Index(fields=["claim", "resolved_at"])]
        constraints = [
            models.UniqueConstraint(fields=["claim", "auto_key"], name="one_auto_flag_per_key")
        ]

    @property
    def is_open(self) -> bool:
        return self.resolved_at is None

    def __str__(self) -> str:
        return f"{self.kind} on {self.claim_id}"


class AttachmentCheck(models.Model):
    """What one file on a claim was found to say, against what the claim says.

    Keyed on the claim and the file's URL rather than on the attachment row:
    a draft's attachment set is deleted and rebuilt on every save
    (`_persist_attachments`), and a result tied to the row would vanish with
    it while the file itself had not changed.
    """

    class Outcome(models.TextChoices):
        MATCHED = "MATCHED", "The file says what the claim says"
        MISMATCH = "MISMATCH", "The title or DOI is not in the file"
        NO_TEXT = "NO_TEXT", "No text to read -- probably scanned"
        UNREADABLE = "UNREADABLE", "The file could not be opened"

    id = models.CharField(primary_key=True, max_length=32, default=cuid, editable=False)
    claim = models.ForeignKey(Claim, on_delete=models.CASCADE, related_name="file_checks")
    url = models.TextField()
    kind = models.CharField(max_length=32, choices=AttachmentKind.choices)
    filename = models.CharField(max_length=255, blank=True, null=True)
    #: The bytes that were read.
    content_hash = models.CharField(max_length=64, blank=True, null=True)
    #: The claim's facts the file was compared with, hashed
    #: (`content_check.claim_fingerprint`). A result is reused only while the
    #: claim still says the same thing; change the title and the file is read
    #: again.
    claim_fingerprint = models.CharField(max_length=64, blank=True, null=True)
    outcome = models.CharField(max_length=16, choices=Outcome.choices)
    #: Which of the claim's facts turned up in the text, and which did not:
    #: title, doi, journal, claimant, affiliation (a published paper) or
    #: reference_title, affiliation (a cited reference).
    found_json = models.TextField(default="[]")
    missing_json = models.TextField(default="[]")
    #: Found as a share of what could be looked for, 0-100. Null when there
    #: was no text to look in.
    score = models.PositiveSmallIntegerField(blank=True, null=True)
    detail = models.TextField(blank=True, null=True)
    text_chars = models.PositiveIntegerField(default=0)
    checked_at = models.DateTimeField()

    class Meta:
        ordering = ["checked_at"]
        constraints = [
            models.UniqueConstraint(fields=["claim", "url"], name="one_check_per_claim_file")
        ]

    def __str__(self) -> str:
        return f"{self.outcome} {self.url}"


# ---------------------------------------------------------------- the feed --


class FeedPost(models.Model):
    """One post in the college's feed.

    The feed replaced the open threads: a colleague sharing a paper, asking
    who has used a machine, or announcing a seminar wants to be *seen*, and a
    list of thread titles hid all of that behind a click. Private conversations
    (a named few, or the research office) stay as threads -- they are messages,
    not posts.

    Visibility is two-valued and read in one place (`core.social.visible_posts`):

    - EVERYONE    everybody signed in
    - DEPARTMENT  the author's department, snapshotted into `department` when
                  the post is written. A department-only post must not follow
                  its author into their next department.

    No money is ever stored or rendered here. A paper reference points at the
    author's own filed paper and is shown by title, journal, year and quartile.
    """

    class Visibility(models.TextChoices):
        EVERYONE = "EVERYONE", "Everybody"
        DEPARTMENT = "DEPARTMENT", "My department"

    id = models.CharField(primary_key=True, max_length=32, default=cuid, editable=False)
    author = models.ForeignKey(User, on_delete=models.CASCADE, related_name="feed_posts")
    body = models.TextField(blank=True, default="")
    visibility = models.CharField(
        max_length=16, choices=Visibility.choices, default=Visibility.EVERYONE, db_index=True
    )
    #: The author's department when they wrote it. Always set when they had
    #: one: it is what a DEPARTMENT post is visible to, and what "follow a
    #: department" and the department tab match on.
    department = models.CharField(max_length=255, blank=True, null=True, db_index=True)

    link_url = models.CharField(max_length=500, blank=True, null=True)
    paper = models.ForeignKey(
        "Claim", null=True, blank=True, on_delete=models.SET_NULL, related_name="feed_posts"
    )
    #: A paper on the author's publication record that is not filed as a
    #: claim yet, shown as the same card.
    publication = models.ForeignKey(
        "Publication", null=True, blank=True, on_delete=models.SET_NULL, related_name="feed_posts"
    )
    #: Resolved @mentions, as written. Resolved once, when the post is saved,
    #: for the reason `Mention` gives: a name must not quietly re-point later.
    mentions_json = models.TextField(default="[]")

    #: An image or a PDF, stored under `feed/` and served only through the
    #: authenticated view that checks the reader may see this post.
    attachment_name = models.CharField(max_length=255, blank=True, null=True)
    attachment_kind = models.CharField(max_length=8, blank=True, null=True)
    attachment_label = models.CharField(max_length=255, blank=True, null=True)
    attachment_size = models.PositiveIntegerField(blank=True, null=True)

    #: Ordered on, so it comes from `monotonic_now`: two posts must never tie.
    created_at = models.DateTimeField(default=monotonic_now, db_index=True)
    edited_at = models.DateTimeField(blank=True, null=True)

    #: Hidden by the super admin. Still there for its author, who is told why.
    hidden_at = models.DateTimeField(blank=True, null=True)
    hidden_by = models.ForeignKey(
        User, null=True, blank=True, on_delete=models.SET_NULL, related_name="feed_posts_hidden"
    )
    hidden_reason = models.CharField(max_length=300, blank=True, null=True)

    #: The open thread this post was carried over from, when it was one.
    legacy_thread = models.OneToOneField(
        "Thread", null=True, blank=True, on_delete=models.SET_NULL, related_name="feed_post"
    )

    class Meta:
        ordering = ["-created_at", "-id"]
        indexes = [
            models.Index(fields=["-created_at", "-id"], name="feedpost_newest_first"),
            models.Index(fields=["author", "-created_at"], name="feedpost_by_author"),
            models.Index(fields=["department", "-created_at"], name="feedpost_by_department"),
        ]

    def __str__(self) -> str:
        return f"{self.author_id}: {self.body[:40]}"


class FeedComment(models.Model):
    """A reply under a post.

    `kind` exists only for comments carried over from an old thread, where
    the assistant or the system had written some of the replies.
    """

    class Kind(models.TextChoices):
        HUMAN = "HUMAN", "Written by a person"
        AGENT = "AGENT", "Answered by the assistant"
        SYSTEM = "SYSTEM", "Recorded by the system"

    id = models.CharField(primary_key=True, max_length=32, default=cuid, editable=False)
    post = models.ForeignKey(FeedPost, on_delete=models.CASCADE, related_name="comments")
    #: Null for a carried-over assistant or system reply -- nobody wrote it.
    author = models.ForeignKey(
        User, null=True, blank=True, on_delete=models.CASCADE, related_name="feed_comments"
    )
    kind = models.CharField(max_length=8, choices=Kind.choices, default=Kind.HUMAN)
    body = models.TextField()
    mentions_json = models.TextField(default="[]")
    created_at = models.DateTimeField(default=monotonic_now)
    edited_at = models.DateTimeField(blank=True, null=True)

    class Meta:
        ordering = ["created_at", "id"]
        indexes = [models.Index(fields=["post", "created_at"], name="feedcomment_by_post")]

    def __str__(self) -> str:
        return f"{self.post_id}: {self.body[:40]}"


class FeedReaction(models.Model):
    """A reaction to a post: a like, or one of the three a college has use for.

    One of each kind per person per post -- congratulating twice is still
    congratulating once -- but a person may both like a post and say they
    would like to work on it, because those are different things to say.
    """

    class Kind(models.TextChoices):
        LIKE = "LIKE", "Like"
        CONGRATS = "CONGRATS", "Congrats"
        INTERESTED = "INTERESTED", "Interested"
        #: "I would like to work on this with you." Opens a message to the
        #: author, which is the point of saying it.
        COLLABORATE = "COLLABORATE", "Want to collaborate"

    id = models.CharField(primary_key=True, max_length=32, default=cuid, editable=False)
    post = models.ForeignKey(FeedPost, on_delete=models.CASCADE, related_name="reactions")
    user = models.ForeignKey(User, on_delete=models.CASCADE, related_name="feed_reactions")
    kind = models.CharField(max_length=16, choices=Kind.choices, default=Kind.LIKE)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["post", "user", "kind"], name="one_reaction_kind_per_person_per_post"
            )
        ]


class Follow(models.Model):
    """Somebody following a colleague, a department, a subject area or a journal.

    Exactly one of `person`, `department`, `topic` and `journal` is set. A
    department is kept as the name people are filed under, because that is
    the only department record the system has; a topic is a subject area as
    the papers and interests spell it; a journal is its title.
    """

    id = models.CharField(primary_key=True, max_length=32, default=cuid, editable=False)
    follower = models.ForeignKey(User, on_delete=models.CASCADE, related_name="follows")
    person = models.ForeignKey(
        User, null=True, blank=True, on_delete=models.CASCADE, related_name="followers"
    )
    department = models.CharField(max_length=255, blank=True, null=True)
    topic = models.CharField(max_length=160, blank=True, null=True)
    journal = models.CharField(max_length=512, blank=True, null=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["follower", "person"], name="follow_a_person_once",
                condition=models.Q(person__isnull=False),
            ),
            models.UniqueConstraint(
                fields=["follower", "department"], name="follow_a_department_once",
                condition=models.Q(department__isnull=False),
            ),
            models.UniqueConstraint(
                fields=["follower", "topic"], name="follow_a_topic_once",
                condition=models.Q(topic__isnull=False),
            ),
            models.UniqueConstraint(
                fields=["follower", "journal"], name="follow_a_journal_once",
                condition=models.Q(journal__isnull=False),
            ),
            models.CheckConstraint(
                condition=(
                    models.Q(person__isnull=False, department__isnull=True,
                             topic__isnull=True, journal__isnull=True)
                    | models.Q(person__isnull=True, department__isnull=False,
                               topic__isnull=True, journal__isnull=True)
                    | models.Q(person__isnull=True, department__isnull=True,
                               topic__isnull=False, journal__isnull=True)
                    | models.Q(person__isnull=True, department__isnull=True,
                               topic__isnull=True, journal__isnull=False)
                ),
                name="follow_one_thing",
            ),
        ]


class PostReport(models.Model):
    """Somebody telling the super admin a post should not be there."""

    class Status(models.TextChoices):
        OPEN = "OPEN", "Waiting for the super admin"
        HIDDEN = "HIDDEN", "The post was hidden"
        DISMISSED = "DISMISSED", "Looked at, left up"

    id = models.CharField(primary_key=True, max_length=32, default=cuid, editable=False)
    post = models.ForeignKey(FeedPost, on_delete=models.CASCADE, related_name="reports")
    reporter = models.ForeignKey(User, on_delete=models.CASCADE, related_name="post_reports")
    reason = models.CharField(max_length=500)
    status = models.CharField(
        max_length=16, choices=Status.choices, default=Status.OPEN, db_index=True
    )
    created_at = models.DateTimeField(auto_now_add=True)
    resolved_at = models.DateTimeField(blank=True, null=True)
    resolved_by = models.ForeignKey(
        User, null=True, blank=True, on_delete=models.SET_NULL, related_name="post_reports_resolved"
    )

    class Meta:
        ordering = ["created_at"]
        constraints = [
            models.UniqueConstraint(
                fields=["post", "reporter"], name="one_open_report_per_person_per_post",
                condition=models.Q(status="OPEN"),
            )
        ]


# ---------------------------------------------------------------------------
# Rewards for work already done: badges, celebrations, goals
# and the wall of fame. Everything here is computed from recognised papers
# (`core.services.records`) and none of it carries money -- these are the
# things other people see.
# ---------------------------------------------------------------------------


class Badge(models.Model):
    """Something a person has done, recognised once, with the paper that did it.

    Awarded by `core.services.achievements.award_badges`, which is safe to run
    any number of times: `(user, key)` is unique, so a second run finds the row
    and leaves it. `key` is the kind plus whatever makes it repeatable --
    `FIRST_Q1` happens once, `TOP10_DEPARTMENT:2025` once a year.

    `earned_on` is when the achievement happened (the evidence paper's date),
    not when this row was written: a badge for a 2024 paper says 2024 even
    though the engine that noticed it was built in 2026.
    """

    id = models.CharField(primary_key=True, max_length=32, default=cuid, editable=False)
    user = models.ForeignKey(User, on_delete=models.CASCADE, related_name="badges")
    kind = models.CharField(max_length=32, db_index=True)
    key = models.CharField(max_length=80)
    earned_on = models.DateField()
    #: The paper that earned it, copied rather than linked: most history is a
    #: ledger row with no claim, and a badge must still say which paper it was.
    evidence_title = models.TextField(blank=True, default="")
    evidence_journal = models.CharField(max_length=512, blank=True, default="")
    evidence_year = models.IntegerField(blank=True, null=True)
    evidence_claim = models.ForeignKey(
        Claim, null=True, blank=True, on_delete=models.SET_NULL, related_name="badges"
    )
    #: One plain sentence, e.g. "With a colleague in ECE".
    detail = models.CharField(max_length=255, blank=True, default="")
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-earned_on", "kind"]
        constraints = [
            models.UniqueConstraint(fields=["user", "key"], name="one_badge_per_key_per_person")
        ]

    def __str__(self) -> str:
        return f"{self.user_id} {self.key}"


class Celebration(models.Model):
    """A one-time moment on somebody's home screen, shown once and then gone.

    One row per person per occasion, so "shown once" is a fact in the database
    rather than a flag in one browser's storage: a person who signs in on their
    phone does not see yesterday's celebration a second time. `key` makes the
    fan-out idempotent -- the same milestone reached twice by two job runs is
    one celebration.
    """

    class Kind(models.TextChoices):
        BADGE = "BADGE", "A badge"
        TARGET = "TARGET", "A department target"

    id = models.CharField(primary_key=True, max_length=32, default=cuid, editable=False)
    user = models.ForeignKey(User, on_delete=models.CASCADE, related_name="celebrations")
    kind = models.CharField(max_length=16, choices=Kind.choices)
    key = models.CharField(max_length=160)
    title = models.CharField(max_length=200)
    body = models.TextField(blank=True, default="")
    badge = models.ForeignKey(
        Badge, null=True, blank=True, on_delete=models.CASCADE, related_name="celebrations"
    )
    created_at = models.DateTimeField(auto_now_add=True)
    seen_at = models.DateTimeField(blank=True, null=True)

    class Meta:
        ordering = ["created_at"]
        constraints = [
            models.UniqueConstraint(fields=["user", "key"], name="one_celebration_per_occasion")
        ]


class DepartmentMilestone(models.Model):
    """A department crossed 50, 75 or 100 per cent of one of its targets.

    Recorded so the crossing is celebrated once however many times the check
    runs. The target's size is part of the key: a head who raises the number
    has set a new target, and reaching half of it is a new milestone.
    """

    id = models.CharField(primary_key=True, max_length=32, default=cuid, editable=False)
    department = models.CharField(max_length=255, db_index=True)
    year = models.PositiveIntegerField()
    metric = models.CharField(max_length=24)
    target = models.PositiveIntegerField()
    threshold = models.PositiveSmallIntegerField()
    done = models.PositiveIntegerField()
    reached_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-reached_at"]
        constraints = [
            models.UniqueConstraint(
                fields=["department", "year", "metric", "target", "threshold"],
                name="one_milestone_per_target_threshold",
            )
        ]


class ResearchGoal(models.Model):
    """What a person means to publish this year, in their own numbers.

    Private to them. Their head sees only counts across the department
    (`/api/hod/goals`) -- how many people set a goal, how many met it -- never
    whose goal is whose. Nothing reminds anybody about a goal.
    """

    class Metric(models.TextChoices):
        PAPERS = "PAPERS", "Papers"
        Q1 = "Q1", "Q1 papers"
        FIRST_AUTHOR = "FIRST_AUTHOR", "First-author papers"
        CITATIONS = "CITATIONS", "Citations"

    id = models.CharField(primary_key=True, max_length=32, default=cuid, editable=False)
    user = models.ForeignKey(User, on_delete=models.CASCADE, related_name="research_goals")
    year = models.PositiveIntegerField()
    metric = models.CharField(max_length=16, choices=Metric.choices)
    target = models.PositiveIntegerField()
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["year", "metric"]
        constraints = [
            models.UniqueConstraint(
                fields=["user", "year", "metric"], name="one_goal_per_metric_per_year"
            )
        ]


class WallPin(models.Model):
    """The paper of the month a head chose for their department's wall.

    `department` empty is the college-wide wall, which the Principal or a
    super admin pins. The paper is named by its normalised title (the key the
    wall groups co-authors under) and its title is copied so the pin still
    reads correctly if the paper's record later changes.
    """

    id = models.CharField(primary_key=True, max_length=32, default=cuid, editable=False)
    department = models.CharField(max_length=255, blank=True, default="")
    month = models.DateField()
    paper_key = models.CharField(max_length=512)
    title = models.TextField()
    pinned_by = models.ForeignKey(
        User, null=True, blank=True, on_delete=models.SET_NULL, related_name="wall_pins"
    )
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["department", "month"], name="one_pin_per_wall_month")
        ]


class WallCheer(models.Model):
    """One person congratulating the authors of one paper on the wall of fame.

    Keyed by the wall's paper key (the normalised title it groups co-authors
    under), because most wall papers are historic ledger rows with no claim
    and no feed post to react to. Once per person per paper, by constraint.
    """

    id = models.CharField(primary_key=True, max_length=32, default=cuid, editable=False)
    paper_key = models.CharField(max_length=512, db_index=True)
    user = models.ForeignKey(User, on_delete=models.CASCADE, related_name="wall_cheers")
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["paper_key", "user"], name="one_cheer_per_person_paper")
        ]


# ---------------------------------------------------------------------------
# The social layer's second storey: collaboration, profiles that say what
# somebody is good at, and the numbers a person sees about their own reach.
# ---------------------------------------------------------------------------


class CollaborationRequest(models.Model):
    """"Shall we write this together?" -- sent as a card in a direct message.

    It lives in the conversation between the two people, as a message with a
    structured part, so the answer and whatever they say around it stay in
    one place. Suggesting a call keeps it open; accepting makes a
    `Collaboration` both of them can see on their profiles.
    """

    class State(models.TextChoices):
        PENDING = "PENDING", "Waiting for an answer"
        CALL = "CALL", "A call was suggested"
        ACCEPTED = "ACCEPTED", "Accepted"
        DECLINED = "DECLINED", "Declined"

    id = models.CharField(primary_key=True, max_length=32, default=cuid, editable=False)
    thread = models.ForeignKey(Thread, on_delete=models.CASCADE, related_name="collab_requests")
    #: The message that carries the card.
    post = models.OneToOneField(Post, on_delete=models.CASCADE, related_name="collab_request")
    sender = models.ForeignKey(User, on_delete=models.CASCADE, related_name="collab_requests_sent")
    recipient = models.ForeignKey(
        User, on_delete=models.CASCADE, related_name="collab_requests_received"
    )
    topic = models.CharField(max_length=200)
    journal = models.CharField(max_length=512, blank=True, default="")
    message = models.TextField(blank=True, default="")
    state = models.CharField(max_length=16, choices=State.choices, default=State.PENDING)
    response_note = models.CharField(max_length=500, blank=True, default="")
    responded_at = models.DateTimeField(blank=True, null=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-created_at"]


class Collaboration(models.Model):
    """Two (or more) colleagues who agreed to work on something together.

    Shown on every member's profile and drawn in the collaboration graph
    beside the co-authorships the claims imply. Ended rather than deleted, so
    the graph can one day say "worked together on" as well as "working on".
    """

    id = models.CharField(primary_key=True, max_length=32, default=cuid, editable=False)
    request = models.OneToOneField(
        CollaborationRequest, null=True, blank=True, on_delete=models.SET_NULL,
        related_name="collaboration",
    )
    topic = models.CharField(max_length=200)
    journal = models.CharField(max_length=512, blank=True, default="")
    members = models.ManyToManyField(User, related_name="collaborations")
    created_at = models.DateTimeField(auto_now_add=True)
    ended_at = models.DateTimeField(blank=True, null=True)

    class Meta:
        ordering = ["-created_at"]


class PinnedPaper(models.Model):
    """One of the (at most three) papers somebody chose to show first."""

    id = models.CharField(primary_key=True, max_length=32, default=cuid, editable=False)
    user = models.ForeignKey(User, on_delete=models.CASCADE, related_name="pinned_papers")
    claim = models.ForeignKey("Claim", on_delete=models.CASCADE, related_name="pins")
    position = models.PositiveSmallIntegerField(default=0)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["position", "created_at"]
        constraints = [
            models.UniqueConstraint(fields=["user", "claim"], name="pin_a_paper_once")
        ]


class Skill(models.Model):
    """Something a person says they can do, for colleagues to vouch for."""

    id = models.CharField(primary_key=True, max_length=32, default=cuid, editable=False)
    user = models.ForeignKey(User, on_delete=models.CASCADE, related_name="skills")
    name = models.CharField(max_length=80)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["name"]
        constraints = [
            # "Python" and "python" are one skill; listing it twice would split
            # its endorsements in two.
            models.UniqueConstraint(
                models.functions.Lower("name"), "user", name="one_skill_per_name_per_person"
            )
        ]
        indexes = [models.Index(fields=["name"], name="skill_by_name")]


class Endorsement(models.Model):
    """A colleague vouching for somebody's skill. Once each."""

    id = models.CharField(primary_key=True, max_length=32, default=cuid, editable=False)
    skill = models.ForeignKey(Skill, on_delete=models.CASCADE, related_name="endorsements")
    endorser = models.ForeignKey(User, on_delete=models.CASCADE, related_name="endorsements_given")
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["skill", "endorser"], name="endorse_a_skill_once")
        ]


class ProfileVisit(models.Model):
    """Somebody opened somebody else's profile, counted once per day.

    Only ever shown back as numbers, and only to the person visited. Who
    visited is kept so the count can be of people rather than page loads; it
    is never shown to anybody. A person can choose not to be counted
    (`SocialSettings.count_my_visits`).
    """

    id = models.CharField(primary_key=True, max_length=32, default=cuid, editable=False)
    profile = models.ForeignKey(User, on_delete=models.CASCADE, related_name="profile_visits")
    viewer = models.ForeignKey(User, on_delete=models.CASCADE, related_name="profiles_visited")
    day = models.DateField()
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["profile", "viewer", "day"], name="one_visit_per_viewer_per_day"
            )
        ]
        indexes = [models.Index(fields=["profile", "day"], name="visit_by_profile_day")]


class PostView(models.Model):
    """A post reached somebody's screen. Once per person: this is reach, not load count."""

    id = models.CharField(primary_key=True, max_length=32, default=cuid, editable=False)
    post = models.ForeignKey(FeedPost, on_delete=models.CASCADE, related_name="views")
    viewer = models.ForeignKey(User, on_delete=models.CASCADE, related_name="posts_seen")
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["post", "viewer"], name="one_view_per_person_per_post")
        ]


class SocialSettings(models.Model):
    """A person's switches that are about them rather than one kind of alert.

    `count_my_visits` off means their visits to other people's profiles and
    posts are not recorded for anybody's statistics. `whatsapp_opt_in` is the
    explicit consent WhatsApp's business rules want before a message; it only
    matters once the college has configured the channel. A person with no row
    is counted and not on WhatsApp.

    Which kinds of alert a person wants, and how, is not here: that is
    `NotificationPreference`, the one store every alert (social ones included)
    is checked against. The social layer's old mute list was moved into it
    (migration 0051).
    """

    user = models.OneToOneField(
        User, primary_key=True, on_delete=models.CASCADE, related_name="social_settings"
    )
    count_my_visits = models.BooleanField(default=True)
    whatsapp_opt_in = models.BooleanField(default=False)
    updated_at = models.DateTimeField(auto_now=True)


class NotificationPreference(models.Model):
    """How one person wants one kind of alert: in the app and by email, in the
    app only, or not at all.

    No row means the kind's default (core.services.notify.KINDS). A row is
    written only when somebody changes a setting, so a kind added next year
    reaches everybody at its default without a data migration.
    """

    class Level(models.TextChoices):
        EMAIL = "email", "In the app and by email"
        IN_APP = "in_app", "In the app"
        OFF = "off", "Off"

    id = models.CharField(primary_key=True, max_length=32, default=cuid, editable=False)
    user = models.ForeignKey(
        User, on_delete=models.CASCADE, related_name="notification_preferences"
    )
    kind = models.CharField(max_length=40)
    level = models.CharField(max_length=8, choices=Level.choices)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["user", "kind"], name="one_preference_per_kind")
        ]

    def __str__(self) -> str:
        return f"{self.user_id} {self.kind}={self.level}"


class CitationCount(models.Model):
    """How often OpenAlex says a paper has been cited, keyed by its DOI.

    Keyed by DOI rather than by claim: co-authors each file their own claim
    for one paper, and it is checked once and told to each of them.
    """

    doi = models.CharField(primary_key=True, max_length=255)
    #: Null until OpenAlex has been asked, or when it did not know the DOI.
    count = models.IntegerField(blank=True, null=True)
    openalex_id = models.CharField(max_length=64, blank=True, null=True)
    #: Oldest first is the order the daily job works through, so a DOI list
    #: larger than one day's share is covered over several days.
    checked_at = models.DateTimeField(blank=True, null=True, db_index=True)
    changed_at = models.DateTimeField(blank=True, null=True)


class CitationHistory(models.Model):
    """A citation count as it was on a day it changed."""

    citation = models.ForeignKey(CitationCount, on_delete=models.CASCADE, related_name="history")
    count = models.IntegerField()
    at = models.DateTimeField(default=timezone.now)

    class Meta:
        ordering = ["at"]


class Publication(models.Model):
    """One paper, whoever in the college wrote it -- the full publication record.

    Filled from OpenAlex (every work whose raw affiliation names the college,
    plus every DOI the college's claims and ledger rows carry), from the
    Scopus profile workbook, and -- for a paper neither source knows -- from
    the claim or ledger row itself (`source = "record"`). Carries no money.

    Identity is the OpenAlex id where there is one, else the DOI, else the
    Scopus EID; `normalized_title` is the last resort when linking records.
    """

    id = models.CharField(primary_key=True, max_length=32, default=cuid, editable=False)
    openalex_id = models.CharField(max_length=32, unique=True, blank=True, null=True)
    doi = models.CharField(max_length=255, blank=True, null=True, db_index=True)
    eid = models.CharField(max_length=64, blank=True, null=True, db_index=True)
    title = models.TextField(blank=True, default="")
    normalized_title = models.CharField(max_length=512, blank=True, default="", db_index=True)
    year = models.IntegerField(blank=True, null=True, db_index=True)
    date = models.DateField(blank=True, null=True)
    venue = models.CharField(max_length=512, blank=True, default="")
    issn = models.CharField(max_length=64, blank=True, default="")
    #: OpenAlex work type (article, book-chapter...) or the record's own
    #: document type when OpenAlex does not know the paper.
    type = models.CharField(max_length=64, blank=True, default="", db_index=True)
    #: SJR quartile from the college's own records (claim or ledger row).
    quartile = models.CharField(max_length=8, blank=True, default="", db_index=True)
    citations = models.IntegerField(default=0)
    citations_refreshed_at = models.DateTimeField(blank=True, null=True, db_index=True)
    #: Scopus lists this paper (seen on a member's AU-ID search).
    scopus_indexed = models.BooleanField(default=False, db_index=True)
    #: Scopus's cited-by count, beside OpenAlex's `citations`.
    scopus_citations = models.IntegerField(blank=True, null=True)
    oa_url = models.TextField(blank=True, default="")
    #: A short list of topic names, JSON.
    topics_json = models.TextField(blank=True, default="[]")
    #: openalex | scopus_sheet | scopus | record
    source = models.CharField(max_length=16, default="openalex")
    claims = models.ManyToManyField("Claim", blank=True, related_name="publications")
    ledger_rows = models.ManyToManyField("PaidLedger", blank=True, related_name="publications")
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-year", "title"]

    def __str__(self):
        return f"{self.year} {self.title[:60]}"


class Authorship(models.Model):
    """One author on one publication, inside or outside the college.

    `author_key` identifies the person across papers when nobody in the
    college is behind the row: the OpenAlex author id (``A123``) when OpenAlex
    gave one, else ``n:<normalised name>``. The co-author graph and the
    external search group on it.
    """

    publication = models.ForeignKey(Publication, on_delete=models.CASCADE, related_name="authorships")
    #: 1-based; null for an author added from a record with no author order.
    position = models.IntegerField(blank=True, null=True)
    display_name = models.CharField(max_length=255)
    raw_affiliation = models.TextField(blank=True, default="")
    openalex_author_id = models.CharField(max_length=32, blank=True, default="", db_index=True)
    orcid = models.CharField(max_length=19, blank=True, default="", db_index=True)
    institution_name = models.CharField(max_length=255, blank=True, default="")
    institution_country = models.CharField(max_length=8, blank=True, default="")
    author_key = models.CharField(max_length=160, db_index=True)
    #: The raw affiliation names the college, or a college record put them here.
    is_college = models.BooleanField(default=False, db_index=True)
    #: OpenAlex's `is_corresponding` flag (or the claim's author list); false when no source says so.
    is_corresponding = models.BooleanField(default=False)
    user = models.ForeignKey(
        "User", null=True, blank=True, on_delete=models.SET_NULL, related_name="authorships"
    )
    #: 0..1: how sure the matcher is that `user` wrote this.
    match_confidence = models.FloatField(default=0)
    #: orcid | record | author_id | name | name_dept | scopus_sheet | manual
    match_method = models.CharField(max_length=16, blank=True, default="")
    #: Set when a person corrects a match; the matcher leaves the row alone.
    match_locked = models.BooleanField(default=False)

    class Meta:
        ordering = ["publication_id", "position"]
        # (user, publication, position) was tried in 0062 and dropped: it saved
        # 0.6 ms on a person's papers and made the external-author search 3x
        # slower on SQLite (ordered walk over scattered rows).
        indexes = [models.Index(fields=["user", "publication"], name="authorship_user_pub")]

    def __str__(self):
        return f"{self.display_name} on {self.publication_id}"


class PublicationMerge(models.Model):
    """Two records of one paper folded into one by a super admin.

    `snapshot_json` holds everything needed to put the removed record back:
    its own fields, the authorships deleted as repeats, which authorships,
    claims, ledger rows and posts moved, and the kept record's fields before
    the merge filled its blanks. `undone_at` is set when that happened.
    """

    id = models.CharField(primary_key=True, max_length=32, default=cuid, editable=False)
    kept_id = models.CharField(max_length=32, db_index=True)
    removed_id = models.CharField(max_length=32, db_index=True)
    reason = models.CharField(max_length=32, blank=True, default="")
    snapshot_json = models.TextField(default="{}")
    actor = models.ForeignKey("User", null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    created_at = models.DateTimeField(auto_now_add=True)
    undone_at = models.DateTimeField(blank=True, null=True)

    class Meta:
        ordering = ["-created_at"]


class PublicationMetrics(models.Model):
    """A college member's publication record in six numbers, kept current by
    match_authors and the weekly citation refresh."""

    user = models.OneToOneField(
        "User", on_delete=models.CASCADE, primary_key=True, related_name="publication_metrics"
    )
    total_publications = models.IntegerField(default=0)
    total_citations = models.IntegerField(default=0)
    h_index = models.IntegerField(default=0)
    i10_index = models.IntegerField(default=0)
    first_year = models.IntegerField(blank=True, null=True)
    last_year = models.IntegerField(blank=True, null=True)
    computed_at = models.DateTimeField(default=timezone.now)


class AuthorAlias(models.Model):
    """What the office decided about one college author name nobody matched.

    Keyed on the normalised name (`author_names.name_key`), so every spelling
    that sorts to the same parts shares one decision. `MATCHED` names a user
    and match_authors applies it on every future run; `NOT_ROSTER` hides the
    name (a former member of staff); `AMBIGUOUS` parks it for a closer look.
    """

    MATCHED = "MATCHED"
    NOT_ROSTER = "NOT_ROSTER"
    AMBIGUOUS = "AMBIGUOUS"
    STATUSES = [(MATCHED, "Matched"), (NOT_ROSTER, "Not on our roster"), (AMBIGUOUS, "Ambiguous")]

    id = models.CharField(primary_key=True, max_length=32, default=cuid, editable=False)
    name_key = models.CharField(max_length=160, unique=True)
    #: One spelling as it appeared, for display.
    sample_name = models.CharField(max_length=255, blank=True, default="")
    status = models.CharField(max_length=16, choices=STATUSES)
    user = models.ForeignKey(User, null=True, blank=True, on_delete=models.CASCADE, related_name="author_aliases")
    decided_by = models.ForeignKey(User, null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)


class ScoutRun(models.Model):
    """One research-scout answer for one person (core.services.scout).

    Kept so a result is shown again for 24 hours without asking Claude again,
    and so the per-person daily limit is counted from rows. ``usage_json``
    holds token counts for operators; it never leaves the API.
    """

    class Status(models.TextChoices):
        QUEUED = "QUEUED"
        RUNNING = "RUNNING"
        DONE = "DONE"
        FAILED = "FAILED"

    id = models.CharField(primary_key=True, max_length=32, default=cuid, editable=False)
    user = models.ForeignKey(User, on_delete=models.CASCADE, related_name="scout_runs")
    status = models.CharField(max_length=16, choices=Status.choices, default=Status.QUEUED)
    result_json = models.TextField(blank=True, default="")
    usage_json = models.TextField(blank=True, default="")
    error = models.TextField(blank=True, default="")
    error_code = models.CharField(max_length=32, blank=True, default="")
    created_at = models.DateTimeField(default=timezone.now, db_index=True)
    finished_at = models.DateTimeField(blank=True, null=True)

    class Meta:
        ordering = ["-created_at"]


class CompassState(models.Model):
    """One person's research compass (core.services.compass), kept between visits.

    The portrait and the paths are worth keeping because a model wrote them
    and asking again costs a call; each carries the hash of the facts it was
    made from, so one made before the record changed is not shown as current.
    The plan is kept for a different reason: it is the person's own, ticks and
    all, and a new paper on the record must not wipe out what they have done.
    ``facts_hash`` is the hash of the facts last seen. JSON as text, like
    ``ScoutRun``. Carries no money.
    """

    id = models.CharField(primary_key=True, max_length=32, default=cuid, editable=False)
    user = models.OneToOneField(User, on_delete=models.CASCADE, related_name="compass")
    portrait_json = models.TextField(blank=True, default="")
    paths_json = models.TextField(blank=True, default="")
    chosen_path = models.CharField(max_length=32, blank=True, default="")
    plan_json = models.TextField(blank=True, default="")
    facts_hash = models.CharField(max_length=64, blank=True, default="")
    updated_at = models.DateTimeField(auto_now=True)
    created_at = models.DateTimeField(auto_now_add=True)

    def __str__(self) -> str:
        return f"Compass of {self.user_id}"


class AIPrecheck(models.Model):
    """The AI claim pre-check for one claim, as it stood for one set of inputs.

    Keyed on `input_hash`: the claim's facts and each attached file's identity
    (core.services.ai_precheck.input_hash), so the same claim with the same
    files is answered from here and a changed claim is read again. It is a
    reading aid for the research cell and nothing in the money path ever
    consults it.
    """

    id = models.CharField(primary_key=True, max_length=32, default=cuid, editable=False)
    claim = models.ForeignKey(Claim, on_delete=models.CASCADE, related_name="ai_prechecks")
    input_hash = models.CharField(max_length=64)
    result_json = models.TextField(default="{}")
    model = models.CharField(max_length=128, blank=True, default="")
    host = models.CharField(max_length=255, blank=True, default="")
    hosted = models.BooleanField(default=False)
    #: Estimated from characters (about four to a token) unless the provider
    #: reports its own; the result says which.
    tokens_in = models.IntegerField(blank=True, null=True)
    tokens_out = models.IntegerField(blank=True, null=True)
    created_by = models.ForeignKey(
        User, null=True, blank=True, on_delete=models.SET_NULL, related_name="ai_prechecks"
    )
    created_at = models.DateTimeField(default=timezone.now)

    class Meta:
        ordering = ["-created_at"]
        constraints = [
            models.UniqueConstraint(fields=["claim", "input_hash"], name="one_ai_precheck_per_inputs")
        ]


class AIFeedback(models.Model):
    """A thumbs up or down on one AI answer, one per person per answer."""

    id = models.CharField(primary_key=True, max_length=32, default=cuid, editable=False)
    user = models.ForeignKey(User, on_delete=models.CASCADE, related_name="ai_feedback")
    feature = models.CharField(max_length=48)
    target_id = models.CharField(max_length=64)
    claim = models.ForeignKey(
        Claim, null=True, blank=True, on_delete=models.CASCADE, related_name="ai_feedback"
    )
    rating = models.SmallIntegerField()
    comment = models.CharField(max_length=500, blank=True, default="")
    created_at = models.DateTimeField(default=timezone.now)

    class Meta:
        ordering = ["-created_at"]
        constraints = [
            models.UniqueConstraint(
                fields=["user", "feature", "target_id"], name="one_ai_feedback_per_answer"
            )
        ]


class AIUsage(models.Model):
    """One AI call, or one refusal to make one (core.services.ai_harness).

    The audit trail and the meter in one table: who asked, for which feature,
    which model, how long it took, how many tokens, and how it ended. The
    per-person daily limit and the college's monthly cap are counted from
    these rows, so they survive a restart of a host that forgets everything
    held in memory. No prompt and no answer is stored here: an audit row that
    kept the text would be a second copy of whatever the person asked about.

    ``outcome`` is ``ok`` (answered), ``cached`` (answered from memory, no
    call made), ``rejected`` (the model answered and the answer was not
    usable: wrong shape, or a guard refused it), ``failed`` (the provider
    could not answer; see ``code``) or ``refused`` (never sent: a limit, the
    breaker, a full queue). ``ok`` and ``rejected`` spent the allowance and
    are what a limit counts; the others did not.
    """

    id = models.CharField(primary_key=True, max_length=32, default=cuid, editable=False)
    user = models.ForeignKey(User, null=True, blank=True, on_delete=models.SET_NULL, related_name="ai_usage")
    role = models.CharField(max_length=32, blank=True, default="")
    feature = models.CharField(max_length=64, db_index=True)
    model = models.CharField(max_length=96, blank=True, default="")
    tier = models.CharField(max_length=16, blank=True, default="")
    outcome = models.CharField(max_length=16, db_index=True)
    code = models.CharField(max_length=32, blank=True, default="")
    attempts = models.PositiveSmallIntegerField(default=0)
    latency_ms = models.PositiveIntegerField(default=0)
    prompt_chars = models.PositiveIntegerField(default=0)
    output_chars = models.PositiveIntegerField(default=0)
    tokens_in = models.PositiveIntegerField(default=0)
    tokens_out = models.PositiveIntegerField(default=0)
    #: False when the tokens are chars/4 because the service did not say.
    tokens_exact = models.BooleanField(default=False)
    #: How many things a guard removed or rewrote in the answer.
    guard_hits = models.PositiveSmallIntegerField(default=0)
    created_at = models.DateTimeField(default=timezone.now)

    class Meta:
        ordering = ["-created_at"]
        indexes = [
            models.Index(fields=["user", "created_at"], name="aiusage_user_when"),
            models.Index(fields=["created_at", "outcome"], name="aiusage_when_outcome"),
        ]
