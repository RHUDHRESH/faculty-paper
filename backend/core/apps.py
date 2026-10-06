from django.apps import AppConfig
from django.db.models.signals import post_delete, post_save, pre_save


class CoreConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "core"

    def ready(self):
        # Any row of this app saved or deleted makes the shared college-wide
        # figures stale (core/services/aggregate_cache.py).
        from core.services.aggregate_cache import bump
        from core.services.validation import normalise_on_save

        # Tidy identifiers on every save (trim, lowercase email, bare DOI).
        for name in ("User", "Claim", "Publication", "PaidLedger"):
            pre_save.connect(normalise_on_save, sender=self.get_model(name), dispatch_uid=f"normalise-{name}")

        # A research faculty member's claims share one yearly threshold, so a
        # claim that moves re-decides the others (core/services/research_threshold.py).
        from core.services import research_threshold

        claim_model = self.get_model("Claim")
        post_save.connect(research_threshold.on_claim_saved, sender=claim_model, dispatch_uid="research-threshold-save")
        post_delete.connect(research_threshold.on_claim_deleted, sender=claim_model, dispatch_uid="research-threshold-delete")

        for model in self.get_models():
            if model.__name__ == "AIUsage":
                # The AI audit is written on every model call and feeds no
                # college-wide figure; bumping for it would throw the cached
                # reports away every time somebody asked the assistant.
                continue
            post_save.connect(bump, sender=model, dispatch_uid=f"aggregates-save-{model.__name__}")
            post_delete.connect(bump, sender=model, dispatch_uid=f"aggregates-delete-{model.__name__}")
