"""Uploaded files kept in the database.

For a host with no persistent disk and no object store (Render's free plan):
the evidence PDFs live in the same Postgres as the claims they belong to, so
they survive every deploy and are backed up with everything else. Files are
still served only through the authenticated /media view -- this class never
produces a public URL.

Chosen with DJANGO_MEDIA_STORAGE=db. Postgres rows hold up to 1 GB each; the
upload endpoint already caps a file at 10 MB.
"""
from __future__ import annotations

from django.core.files.base import ContentFile
from django.core.files.storage import Storage
from django.utils.deconstruct import deconstructible


@deconstructible
class DatabaseStorage(Storage):
    def _model(self):
        from core.models import StoredFile

        return StoredFile

    def _open(self, name, mode="rb"):
        row = self._model().objects.filter(name=name).only("content").first()
        if row is None:
            raise FileNotFoundError(name)
        f = ContentFile(bytes(row.content))
        f.name = name
        return f

    def _save(self, name, content):
        content.seek(0) if hasattr(content, "seek") else None
        data = content.read()
        self._model().objects.update_or_create(
            name=name, defaults={"content": data, "size": len(data)}
        )
        return name

    def exists(self, name):
        return self._model().objects.filter(name=name).exists()

    def delete(self, name):
        self._model().objects.filter(name=name).delete()

    def size(self, name):
        row = self._model().objects.filter(name=name).only("size").first()
        if row is None:
            raise FileNotFoundError(name)
        return row.size

    def url(self, name):
        from django.conf import settings

        return f"{settings.MEDIA_URL}{name}"

    def listdir(self, path):
        prefix = (path.rstrip("/") + "/") if path else ""
        names = self._model().objects.filter(name__startswith=prefix).values_list("name", flat=True)
        dirs, files = set(), []
        for n in names:
            rest = n[len(prefix):]
            if "/" in rest:
                dirs.add(rest.split("/", 1)[0])
            else:
                files.append(rest)
        return sorted(dirs), sorted(files)
