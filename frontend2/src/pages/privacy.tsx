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
      <h1 className="display text-2xl">Privacy</h1>
      <p className="mt-2 text-sm text-fg-muted">What this system holds about you, who sees it, and how to correct it.</p>
      <div className="mt-8 max-w-[65ch] space-y-4 text-base leading-7 text-fg [&_h2]:mt-10 [&_h2]:border-t [&_h2]:border-line [&_h2]:pt-6 [&_h2]:text-lg [&_h2]:font-semibold [&_h2]:text-fg">
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
      <p className="mt-12 border-t border-line pt-6 text-sm">
        <Link to="/" className="rounded-sm text-accent underline underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-accent">
          Back to Faculty Publications
        </Link>
      </p>
    </main>
  )
}
