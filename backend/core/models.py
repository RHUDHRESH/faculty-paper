import uuid

from django.contrib.auth.models import AbstractBaseUser, BaseUserManager, PermissionsMixin
from django.db import models


def cuid():
    return uuid.uuid4().hex


class Role(models.TextChoices):
    FACULTY = "FACULTY"
    HOD = "HOD"
    PRINCIPAL = "PRINCIPAL"
    RESEARCH_CELL = "RESEARCH_CELL"  # imports helper only — not in approval chain
    FINANCE = "FINANCE"
    SUPER_ADMIN = "SUPER_ADMIN"


class ClaimStatus(models.TextChoices):
    """Live chain: DRAFT → SUBMITTED → CLEARED → PRINCIPAL_APPROVED → PAID.

    The research cell clears a submitted ticket, the Principal approves the
    spend, and Finance pays what the Principal approved. Rejection can happen
    at either approval step.

    PRINCIPAL_APPROVED was previously a relic of the old ERP chain. It is now
    the live step before payment, which also means tickets imported under the
    old chain sit at exactly the right place.
    """

    DRAFT = "DRAFT"
    SUBMITTED = "SUBMITTED"
    CLEARED = "CLEARED"
    PRINCIPAL_APPROVED = "PRINCIPAL_APPROVED"
    PAID = "PAID"
    REJECTED = "REJECTED"

    # Legacy — no new claim enters these.
    HOD_APPROVED = "HOD_APPROVED"
    RESEARCH_APPROVED = "RESEARCH_APPROVED"
    FINANCE_APPROVED = "FINANCE_APPROVED"


#: Cleared for payment — the new status plus the old chain's terminal approvals,
#: so tickets already approved under the previous flow are still payable.
PAYABLE_STATUSES = (
    ClaimStatus.CLEARED,
    ClaimStatus.PRINCIPAL_APPROVED,
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
    override_by = models.ForeignKey(
        "User",
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="duplicate_overrides",
    )
    override_at = models.DateTimeField(null=True, blank=True)

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
