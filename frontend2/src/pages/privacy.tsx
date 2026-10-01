import { Link } from "react-router-dom"

import { useAuth } from "@/app/auth"
import { useInstitution } from "@/app/institution"
import { Mark } from "@/ui/art"

/**
 * What this system holds about a person and why -- public, because Google
 * shows it on the "Sign in with Google" screen and because the people whose
 * payments it decides are entitled to read it without an account.
 *
 * It says who sees a claim in general terms and does not walk through the
 * offices one by one: a page every member of staff can read is the wrong
 * place to publish the order a claim travels in.
 */
export function Privacy() {
  const { college_name, support_email } = useInstitution()
  const { me } = useAuth()
  const college = college_name || "the college"
  return (
    <main className="page max-w-3xl py-12 max-sm:py-6">
      {/* Signed in, the sidebar already carries the name; the mark is for a visitor with no account. */}
      {!me && (
        <Link to="/" className="mb-8 flex items-center gap-3">
          <Mark className="size-9" />
          <span className="font-semibold">Faculty Publications · {college}</span>
        </Link>
      )}
      <h1 className="display text-[1.75rem] leading-9">Privacy</h1>
      <p className="mt-1.5 text-base text-fg-muted">What this system holds about you, who sees it, and how to correct it.</p>

      <nav aria-label="On this page" className="mt-6 flex flex-wrap gap-x-4 gap-y-1 text-sm">
        <a href="#holds" className="text-accent hover:underline">What it holds</a>
        <a href="#google" className="text-accent hover:underline">Signing in with Google</a>
        <a href="#sees" className="text-accent hover:underline">Who sees it</a>
        <a href="#corrections" className="text-accent hover:underline">Corrections and questions</a>
      </nav>

      <div className="mt-8 max-w-[65ch] space-y-10 text-base leading-relaxed text-fg">
        <p>
          This system is run by {college} to record the research its staff publish and to pay the
          publication incentive the college's policy provides. It is used only by the college's
          staff.
        </p>
        <section id="holds" className="scroll-mt-6 space-y-2">
          <h2 className="text-lg font-semibold">What it holds</h2>
          <p>
            Your name, college email, department, designation, staff and biometric identifiers and
            Scopus author details, as held by the college. The papers you file and the evidence you
            attach. How each claim was checked, approved and paid. A record of who did what, kept
            for audit.
          </p>
        </section>
        <section id="google" className="scroll-mt-6 space-y-2">
          <h2 className="text-lg font-semibold">Signing in with Google</h2>
          <p>
            If you choose "Continue with Google", Google tells this system your email address and
            name so it can find the account the college already made for you. Nothing else is read
            from your Google account, nothing is posted to it, and signing in this way never creates
            an account.
          </p>
        </section>
        <section id="sees" className="scroll-mt-6 space-y-2">
          <h2 className="text-lg font-semibold">Who sees it</h2>
          <p>
            Only the people who act on a claim see it, and only what their part needs. Heads of
            department see their department's publications but no amounts. Colleagues see your
            published papers, never what they were paid. Your data is not sold or shared with anyone
            outside the college.
          </p>
        </section>
        <section id="corrections" className="scroll-mt-6 space-y-2">
          <h2 className="text-lg font-semibold">Corrections and questions</h2>
          <p>
            You can ask for any detail to be corrected from your{" "}
            {me ? (
              <Link to="/me" className="text-accent underline">
                account page
              </Link>
            ) : (
              "account page"
            )}
            .
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
        </section>
      </div>
      <p className="mt-12 text-sm">
        <Link to="/" className="rounded-sm text-accent underline underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-accent">
          Back to Faculty Publications
        </Link>
      </p>
    </main>
  )
}
