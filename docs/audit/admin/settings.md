# Institution (`/settings`)

## Who and why
The super admin (and the research cell can read), once when the college is set up and rarely after: "What does the app call the college, and how do people reach us?"

## What it showed before
![before](shots/settings-before-1440.png)

- A sentence with " — " fragments and three fields with their hints written as a paragraph each. Nothing showed what the name would look like where people read it.
- The toast came from a different library than every other page ("Saved", with a description), not the shared toast.
- No record of who changed the name, and when. The audit log held the action as a sentence ("Updated the institution settings") rather than a code, with the new values only, so it could not say "from what".
- No sign of where the change shows up.

## What changed
- One line saying what the page is for, and the form with its hints under the fields.
- "How it reads": the sign-in screen as it will look with what is typed (name, note, support line), so a typo is seen before it is saved.
- "Show change history": who changed which detail, from what to what, and when. The audit entry is now `SETTINGS_UPDATE` with before and after, and the admin history endpoint reads it in words.
- Toast: "Saved. The college's details are updated everywhere they are shown." or "Could not save. Nothing was changed."

## Evidence after
- `shots/settings-after-1440.png`, `shots/settings-after-390.png`. No sideways scroll.
- Tests: `src/pages/institution-settings.test.tsx`, `backend/core/test_admin_b.py::test_changing_the_college_name_is_recorded_from_and_to`, `core.test_product` (the audit row is still written).
