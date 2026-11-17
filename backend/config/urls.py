from django.contrib import admin
from django.urls import path

from core.api import api
from core.api.v1 import v1
from core.views import avatar_media, claim_media, feed_media, site_media

urlpatterns = [
    path("admin/", admin.site.urls),
    # Before api/: the token API is its own NinjaAPI and must win /api/v1/.
    path("api/v1/", v1.urls),
    path("api/", api.urls),
    # Served in every environment, not just DEBUG — uploaded proofs used to 404
    # in production because static() was gated on DEBUG.
    path("media/claims/<str:filename>", claim_media, name="claim-media"),
    path("media/avatars/<str:filename>", avatar_media, name="avatar-media"),
    path("media/feed/<str:filename>", feed_media, name="feed-media"),
    path("media/site/<str:filename>", site_media, name="site-media"),
]
