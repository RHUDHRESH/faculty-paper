"""A lighter hash for the one-time passwords an admin issues in bulk.

Hashing a whole college at the default cost is 0.35 s an account, so 500 people
is three minutes inside one web request -- past every proxy's timeout on the
free host, with the half-finished work rolled back and nothing to show for it.
These are 12 to 14 random characters from a 56-letter alphabet (about 70 bits)
and are replaced the moment the person signs in (`must_change_password`), so
the slow hash buys nothing here. Django re-hashes them with the preferred
hasher at the first successful sign-in, because this one is not first in
`PASSWORD_HASHERS`.
"""
from django.contrib.auth.hashers import PBKDF2PasswordHasher


class IssuedPasswordHasher(PBKDF2PasswordHasher):
    algorithm = "pbkdf2_sha256_issued"
    iterations = 20_000
