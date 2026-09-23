import uuid

from django.contrib.auth.models import AbstractBaseUser, BaseUserManager, PermissionsMixin
from django.db import models


def cuid():
    return uuid.uuid4().hex


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
    #: How many papers a year this person is expected to produce before any
    #: incentive is due. Research faculty are already paid to do research, so
    #: the scheme rewards what exceeds the expectation: papers up to the quota
    #: carry no remuneration and only the surplus is reimbursed.
    #:
    #: Null means no quota, which is what every regular account has.
    research_quota = models.PositiveIntegerField(blank=True, null=True)
    #: Shown beside the quota, because a number with no reason attached reads
    #: as a penalty rather than as an agreement.
    research_quota_note = models.TextField(blank=True, null=True)

    #: The one detail on an account its owner edits directly
    #: (PATCH /auth/profile/self). Nothing is paid or checked against it, so
    #: routing it through a super admin would only guarantee it goes stale.
    phone = models.CharField(max_length=32, blank=True, null=True)

    #: A Google account the person linked from their profile, identified by
    #: Google's stable subject id rather than by email: a personal Gmail
    #: address never matches the college address the account was made with,
    #: and an address can be renamed where the subject cannot. Unique, so one
    #: Google account opens at most one account here.
    google_sub = models.CharField(max_length=255, unique=True, blank=True, null=True)
    #: Shown back on the profile so the person can see which account it is.
    google_email = models.EmailField(blank=True, null=True)
    google_linked_at = models.DateTimeField(blank=True, null=True)

    active = models.BooleanField(default=True)
    is_staff = models.BooleanField(default=False)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    objects = UserManager()

    USERNAME_FIELD = "email"
    REQUIRED_FIELDS = ["name"]

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
            )
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
    author_point_json = models.TextField()
    # e.g. {"Journal": 1, "Conference Proceeding": 0.8, "Book Series": 0.5, "Other": 0.5}
    publication_type_multipliers_json = models.TextField(
        default='{"Journal":1,"Conference Proceeding":1,"Book Series":1,"Other":1}'
    )
    student_remuneration_zero = models.BooleanField(default=True)
    qf_only_for_no_snip = models.BooleanField(default=True)
    active = models.BooleanField(default=True)
    notes = models.TextField(blank=True, null=True)
    updated_by = models.ForeignKey(
        User, null=True, blank=True, on_delete=models.SET_NULL, related_name="formula_edits"
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)


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
    #: What the quota decided, recorded on the claim rather than recomputed
    #: later: a research faculty member's quota can be changed afterwards, and
    #: a paper must keep the reason it was priced the way it was.
    quota_applied = models.BooleanField(default=False)
    quota_note = models.TextField(blank=True, null=True)
    #: Which paper of the year this is, against a research quota. Assigned once
    #: when the paper is first priced past draft, and never recomputed.
    #:
    #: Stored rather than derived because there is nothing to derive it from.
    #: `created_at` is not enough — `auto_now_add` reads a clock whose
    #: resolution is coarser than a loop, so several claims share a timestamp
    #: to the microsecond — and the id is a random uuid, so breaking the tie on
    #: it orders papers arbitrarily rather than by when they were filed. A
    #: number handed out in order, once, is the only thing that survives both.
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
        ]

    #: (year, position) as they stood the last time this row was read or
    #: written, so `save()` can tell whether either actually moved without
    #: going back to the database for a row it already has.
    _quota_baseline = None

    @classmethod
    def from_db(cls, db, field_names, values):
        obj = super().from_db(db, field_names, values)
        # Only when both columns were actually selected. Touching a deferred
        # field here would fire a query per row behind every `.only()`.
        if "publication_year" in field_names and "quota_position" in field_names:
            obj._remember_quota_baseline()
        return obj

    def _remember_quota_baseline(self):
        self._quota_baseline = (self.publication_year, self.quota_position)

    def _quota_baseline_or_fetch(self):
        """(year, position) as the database has them for this row.

        Normally free -- it was recorded when the row was read or last
        written. The fallback is for a row loaded with `.only()`, where the
        two columns were never selected.
        """
        if self._quota_baseline is not None:
            return self._quota_baseline
        stored = (
            Claim.objects.filter(pk=self.pk)
            .values_list("publication_year", "quota_position")
            .first()
        )
        return stored or (self.publication_year, self.quota_position)

    def _quota_slot_taken(self, year, position):
        if year is None or position is None or self.owner_id is None:
            return False
        return (
            Claim.objects.filter(
                owner_id=self.owner_id, publication_year=year, quota_position=position
            )
            .exclude(pk=self.pk)
            .exists()
        )

    def _next_quota_slot(self, year):
        top = (
            Claim.objects.filter(
                owner_id=self.owner_id,
                publication_year=year,
                quota_position__isnull=False,
            )
            .exclude(pk=self.pk)
            .aggregate(top=models.Max("quota_position"))["top"]
            or 0
        )
        return top + 1

    def _close_quota_gap(self, year):
        """Renumber a year's remaining papers 1..N after one of them leaves.

        The quota means "the first N papers of the year", but it is enforced
        as "the papers numbered 1 to N". The moment the sequence has a hole --
        a year corrected on a rejected claim, a withdrawal, a deletion -- the
        two stop meaning the same thing and the quota covers fewer papers than
        it was supposed to. Three papers numbered 1, 2, 3; the first one's
        year is corrected; the year is left holding two papers numbered 2 and
        3 against a quota of 2, so one of them is paid for a paper the quota
        was meant to cover.

        Renumbering is by existing position order, which is filing order, so
        no paper overtakes another -- the objection to deriving a position
        from `created_at` or from a random uuid does not apply to reusing the
        order already recorded.

        A bucket holding a paper that has already been paid is left exactly as
        it is. Renumbering only ever moves a position down, and moving a
        position down can only move a paper from outside the quota to inside
        it, which is a downward repricing of money that has already gone out.
        The gap stays open in that bucket rather than have the fix move
        settled money.
        """
        if year is None or self.owner_id is None:
            return
        rows = list(
            Claim.objects.filter(
                owner_id=self.owner_id,
                publication_year=year,
                quota_position__isnull=False,
            )
            .exclude(pk=self.pk)
            .order_by("quota_position", "created_at")
        )
        moving = [
            row
            for row, wanted in zip(rows, range(1, len(rows) + 1))
            if row.quota_position != wanted
        ]
        if not moving:
            return
        if any(row.status == ClaimStatus.PAID or row.paid_at is not None for row in moving):
            return
        # Two passes through a scratch range: the unique constraint would
        # reject 2 -> 1 while some other row still holds 1 on the way past.
        offset = (rows[-1].quota_position or len(rows)) + len(rows) + 1
        for n, row in enumerate(rows, start=1):
            if row.quota_position != n:
                Claim.objects.filter(pk=row.pk).update(quota_position=offset + n)
        for n, row in enumerate(rows, start=1):
            if row.quota_position != n:
                Claim.objects.filter(pk=row.pk).update(quota_position=n)
                row.quota_position = n

    def save(self, *args, **kwargs):
        """Keep the research-quota slot honest across a save.

        Three things the column could not look after on its own:

        * A corrected `publication_year` used to carry the old year's number
          into the new year, where that number had already been issued. Two
          papers then shared position 1, both sat inside a quota of 2, and the
          year's third paper -- which should have been paid -- was not. A slot
          belongs to the year that issued it, so it is dropped when the year
          changes and a fresh one is taken when the paper is next filed.
        * Leaving a year opens a hole in its sequence, which shrinks that
          year's quota. `_close_quota_gap` shuts it.
        * Two interleaved submits could be handed the same number. The unique
          constraint refuses the second one; this takes the next free slot
          rather than failing the save.
        """
        update_fields = kwargs.get("update_fields")
        touched = update_fields is None or bool(
            {"publication_year", "quota_position"} & set(update_fields)
        )
        if not touched or self._state.adding:
            super().save(*args, **kwargs)
            self._remember_quota_baseline()
            return

        old_year, old_position = self._quota_baseline_or_fetch()
        vacated = None
        if old_year != self.publication_year:
            if old_position is not None:
                self.quota_position = None
                vacated = old_year
                if update_fields is not None:
                    kwargs["update_fields"] = list(set(update_fields) | {"quota_position"})
        elif self.quota_position is not None and self.quota_position != old_position:
            if self._quota_slot_taken(self.publication_year, self.quota_position):
                self.quota_position = self._next_quota_slot(self.publication_year)

        super().save(*args, **kwargs)
        self._remember_quota_baseline()
        if vacated is not None:
            self._close_quota_gap(vacated)

    def delete(self, *args, **kwargs):
        """Close the hole a deleted paper leaves in its year's sequence.

        Same defect as a corrected year, reached the other way: the quota is
        enforced as "the papers numbered 1..N", so a paper removed from the
        middle of a year takes one of that year's payable slots with it. The
        guard on already-paid papers in `_close_quota_gap` applies here too.
        """
        year = self.publication_year if self.quota_position is not None else None
        result = super().delete(*args, **kwargs)
        if year is not None:
            self._close_quota_gap(year)
        return result


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


class PaidLedger(models.Model):
    """Master_List_Accounts style month ledger."""
    id = models.CharField(primary_key=True, max_length=32, default=cuid, editable=False)
    claim = models.ForeignKey(Claim, null=True, blank=True, on_delete=models.SET_NULL, related_name="ledger_rows")
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


class AuditLog(models.Model):
    id = models.CharField(primary_key=True, max_length=32, default=cuid, editable=False)
    actor = models.ForeignKey(
        User, null=True, blank=True, on_delete=models.SET_NULL, related_name="audit_logs"
    )
    action = models.CharField(max_length=128)
    entity = models.CharField(max_length=64)
    entity_id = models.CharField(max_length=64, blank=True, null=True)
    detail_json = models.TextField(blank=True, null=True)
    created_at = models.DateTimeField(auto_now_add=True)


class Notification(models.Model):
    id = models.CharField(primary_key=True, max_length=32, default=cuid, editable=False)
    user = models.ForeignKey(User, on_delete=models.CASCADE, related_name="notifications")
    title = models.CharField(max_length=255)
    body = models.TextField(blank=True, null=True)
    href = models.CharField(max_length=512, blank=True, null=True)
    read = models.BooleanField(default=False)
    claim_id = models.CharField(max_length=32, blank=True, null=True)
    created_at = models.DateTimeField(auto_now_add=True)


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
        PENDING = "PENDING", "Waiting for the research cell"
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
        ],
        default=Thread.Visibility.PUBLIC,
        db_index=True,
    )
    department = models.CharField(max_length=255, blank=True, null=True, db_index=True)

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
