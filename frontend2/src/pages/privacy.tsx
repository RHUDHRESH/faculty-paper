import { Link } from "react-router-dom"

import { useInstitution } from "@/app/institution"
import { Mark } from "@/ui/art"

/**
 * What this system holds about a person and why -- public, because Google
 * shows it on the "Sign in with Google" screen and because the people whose
 * payments it decides are entitled to read it without an account.
 */
export function Privacy() {
  const { college_name, support_email } = useInstitution()
  const college = college_name || "the college"
  return (
    <main className="page max-w-3xl py-12">
      <Link to="/" className="mb-8 flex items-center gap-3">
        <Mark className="size-9" />
        <span className="font-semibold">Faculty Publications · {college}</span>
      </Link>
      <h1 className="display text-xl">Privacy</h1>
      <div className="mt-6 space-y-5 text-base leading-7 text-fg-muted [&_h2]:mt-8 [&_h2]:text-lg [&_h2]:font-semibold [&_h2]:text-fg">
        <p>
          This system is run by {college} to record the research its staff publish and to pay the
          publication incentive the college's policy provides. It is used only by the college's
          staff.
        </p>
        <h2>What it holds</h2>
        <p>
          Your name, college email, department, designation, staff and biometric identifiers and
          Scopus author details, as held by the college; the papers you file and the evidence you
          attach; how each claim was checked, approved and paid; and a record of who did what, kept
          for audit.
        </p>
        <h2>Signing in with Google</h2>
        <p>
          If you choose "Continue with Google", Google tells this system your email address and
          name so it can find the account the college already made for you. Nothing else is read
          from your Google account, nothing is posted to it, and signing in this way never creates
          an account.
        </p>
        <h2>Who sees it</h2>
        <p>
          Each office sees what its step needs: the research office checks claims, the Principal
          approves them, the Director authorises them and Finance pays them. Heads of department
          see their department's publications but no amounts. Your data is not sold or shared with
          anyone outside the college.
        </p>
        <h2>Corrections and questions</h2>
        <p>
          You can ask for any detail to be corrected from your profile page.
          {support_email ? (
            <>
              {" "}For anything else, write to{" "}
              <a className="text-accent underline" href={"mailto:" + support_email}>
                {support_email}
              </a>
              .
            </>
          ) : (
            " For anything else, contact the college's research office."
          )}
        </p>
      </div>
    </main>
  )
}
