# Clerk

Clerk is the front door and nothing else.

It answers one question — is this person who they say they are — and the
answer is traded immediately for one of this application's own sessions.
Everything after that is decided here: the role, the department, whether
somebody sees a rupee figure at all. None of it is asked of Clerk, because
all of it is part of deciding who gets paid, and that belongs in one place.

A token claiming `"role": "SUPER_ADMIN"` gets a faculty session if that is
what the user table says. There is a test for exactly that.

## What you need to set

One value, on the server:

```
CLERK_PUBLISHABLE_KEY=pk_live_...
```

That is the whole configuration.

**There is deliberately no `CLERK_SECRET_KEY` setting.** A Clerk session token
is an RS256 JWT whose signing keys are published at the instance's JWKS
endpoint, and the address of that endpoint is encoded in the publishable key
itself — which is not a secret and is already in the browser. So the secret
key is never read, never stored, and never needed. A secret that does not
arrive cannot be leaked.

It also means the key and the instance can never drift apart. They are the
same value.

With the variable unset, `/api/auth/clerk/config` answers `enabled: false`,
the sign-in page shows the password form alone, and says nothing about Clerk.
It does not render a button that would do nothing if pressed.

## The one step that is yours

The Clerk CLI needs to sign in to *your* Clerk account, which is not something
this project can do on your behalf:

```bash
clerk auth login
```

Then link the project and check it over:

```bash
clerk init --app app_3IS6KTCOb69erFvw4x4f6Woe07z
```

```bash
clerk doctor
```

## The email claim

Clerk's default session token is small and **carries no email address**. It is
added with a JWT template in the Clerk dashboard, under **Sessions → Customize
session token**:

```json
{ "email": "{{user.primary_email_address}}" }
```

Without it, sign-in verifies perfectly and then matches nobody — which on
screen reads as the account being missing rather than the instance being
half-configured. So that case is detected and says what is actually wrong.

Several claim names are accepted (`email`, `email_address`,
`primary_email_address`, `user_email`, and a nested `user` object), because
instances name it differently and a template that works is worth more than a
template that matches our first guess.

## What it will not do

**No account is ever created by signing in.** An address Clerk recognises and
this college does not is refused, with a message saying to ask the research
cell. Accounts here carry staff ids, biometric ids and a Scopus link, and they
decide who is paid what — putting a payable identity behind a free signup form
is not a thing that can be allowed.

This is the same rule Google sign-in follows, for the same reason.

## What is checked

- the signature, against the instance's published keys (refetched once on an
  unknown key id, so a key rotation is not an outage)
- `exp` and `iat`, with 30 seconds of leeway for unsynchronised clocks
- **the issuer** — a perfectly valid token from somebody else's Clerk instance
  is still somebody else's token, and the signature check alone would accept
  it. There is a test that signs a token with an attacker's own key and
  confirms the issuer check is what stops it.
- that the account exists here, and is active

Failures are logged but never echoed back in detail. Whether a token expired,
was signed wrongly, or came from another instance is useful to somebody
probing the endpoint and useless to the person in front of the screen.
