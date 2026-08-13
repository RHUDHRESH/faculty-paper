from django.contrib import admin
from django.urls import path

from core.api import api
from core.views import claim_media

urlpatterns = [
    path("admin/", admin.site.urls),
    path("api/", api.urls),
    # Served in every environment, not just DEBUG — uploaded proofs used to 404
    # in production because static() was gated on DEBUG.
    path("media/claims/<str:filename>", claim_media, name="claim-media"),
]
