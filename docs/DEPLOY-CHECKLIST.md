# Deploy checklist

## Email (Brevo SMTP relay)

Render's free plan blocks outbound ports 25, 465 and 587, so mail goes to
Brevo on port **2525** with STARTTLS. Until `EMAIL_HOST` is set, every alert
stays in the app and the settings page says the mail server is not set up.

Set these on the backend service (Render > Environment):

| Variable | Value |
| --- | --- |
| `EMAIL_BACKEND` | `django.core.mail.backends.smtp.EmailBackend` |
| `EMAIL_HOST` | `smtp-relay.brevo.com` |
| `EMAIL_PORT` | `2525` |
| `EMAIL_USE_TLS` | `true` |
| `EMAIL_HOST_USER` | the SMTP login shown in Brevo > SMTP & API > SMTP (looks like `xxxxxx@smtp-brevo.com`) |
| `EMAIL_HOST_PASSWORD` | an SMTP key generated on that same page (not the Brevo account password) |
| `DEFAULT_FROM_EMAIL` | a sender verified in Brevo > Senders, e.g. `Faculty Papers <research@your-college.edu>` |
| `APP_BASE_URL` | the https address people open, so email buttons land on the right page |
| `EMAIL_DAILY_CAP` | `280` (Brevo free allows 300 a day) |
| `EMAIL_HOURLY_PER_PERSON` | `4` (the rest go in the hourly batch; `0` = no limit) |
| `EMAIL_TIMEOUT` | `20` |

After deploying:

1. Run `python manage.py migrate` (registers the hourly `email-batch` schedule
   beside `weekly-digest`).
2. Make sure the django-q2 worker (`python manage.py qcluster`) is running, or
   no digest or batch goes out.
3. Sign in as the super admin, open Settings > Notifications, and press
   **Send a test email to myself**. The status line says whether it went and,
   if not, why.
4. Authenticate the sending domain in Brevo (SPF and DKIM records) so mail
   does not land in spam.

Local and test runs never touch a real server: tests use Django's locmem
backend, and `DEBUG` defaults to the console backend.
