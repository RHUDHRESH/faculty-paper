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
    """Live chain: DRAFT → SUBMITTED → CLEARED → PAID, or REJECTED.

    Admin clears a submitted ticket; Finance pays a cleared one. The HoD and
    Principal statuses below belong to the old chain and are kept only so
    tickets filed under it still load, report, and can be paid out.
    """

    DRAFT = "DRAFT"
    SUBMITTED = "SUBMITTED"
    CLEARED = "CLEARED"
    PAID = "PAID"
    REJECTED = "REJECTED"

    # Legacy — no new claim enters these.
    HOD_APPROVED = "HOD_APPROVED"
    PRINCIPAL_APPROVED = "PRINCIPAL_APPROVED"
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
    qf_others = models.FloatField(default=4000)  # conference / others from Accounts sheet
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
