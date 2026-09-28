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

        for model in self.get_models():
            post_save.connect(bump, sender=model, dispatch_uid=f"aggregates-save-{model.__name__}")
            post_delete.connect(bump, sender=model, dispatch_uid=f"aggregates-delete-{model.__name__}")
