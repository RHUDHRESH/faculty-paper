import { Link, useSearchParams } from "react-router-dom"
import { ArrowRight, Printer } from "lucide-react"

import { useAuth, type Role } from "@/app/auth"
import { ROLE_LABEL } from "@/app/account"
import { guidesFor, ROLE_INTRO, type Guide } from "@/app/guides"
import { useCollegeName } from "@/app/institution"
import { Button } from "@/ui/button"
import { PageHeader } from "@/ui/page-header"
import { Picture } from "@/ui/picture"
import { cn } from "@/lib/cn"

const ROLES = Object.keys(ROLE_LABEL) as Role[]

/**
 * Help: short task guides for each role, written from the role's real jobs,
 * each ending in a link to the page that does it. `?role=` shows another
 * role's guides, so the research cell can print every quick guide for the
 * launch meeting. Print gives one A4 sheet for the chosen role.
 */
export function Help() {
  const { me } = useAuth()
  const [params, setParams] = useSearchParams()
  const asked = params.get("role") as Role | null
  const role: Role = asked && ROLES.includes(asked) ? asked : me?.role ?? "FACULTY"
  const guides = guidesFor(role)

  return (
    <div className="page">
      {/* The printed sheet is the only thing on paper. */}
      <style>{`@media print { @page { size: A4; margin: 12mm } body * { visibility: hidden } .quick-guide, .quick-guide * { visibility: visible } .quick-guide { position: absolute; inset: 0 auto auto 0; width: 100% } }`}</style>

      <div className="print:hidden">
        <PageHeader
          title="Help"
          sub="Short guides to the things you do here. Each one ends with a link that opens the right page."
          actions={
            <Button onClick={() => window.print()}>
              <Printer aria-hidden /> Print quick guide
            </Button>
          }
        />

        <div className="mb-6 flex flex-wrap gap-1.5" role="tablist" aria-label="Guides for">
          {ROLES.map((r) => (
            <button
              key={r}
              role="tab"
              aria-selected={r === role}
              onClick={() => setParams(r === me?.role ? {} : { role: r }, { replace: true })}
              className={cn(
                "rounded-full px-3 py-1 text-sm ring-1 ring-inset",
                r === role ? "bg-accent text-accent-fg ring-accent" : "text-fg-muted ring-edge hover:bg-hover"
              )}
            >
              {ROLE_LABEL[r]}
              {r === me?.role && " (you)"}
            </button>
          ))}
        </div>

        <div className="mb-8 flex items-center gap-4">
          <Picture name={role === "FACULTY" ? "onboard-first-paper" : "onboard-welcome"} className="size-20 shrink-0" />
          <p className="max-w-prose text-pretty text-fg-muted">{ROLE_INTRO[role]}</p>
        </div>

        <div className="grid grid-cols-[minmax(0,1fr)] gap-x-10 lg:grid-cols-[12rem_minmax(0,1fr)]">
          <nav aria-label="Guides" className="mb-6 hidden lg:block">
            <ul className="sticky top-6 space-y-1 text-sm">
              {guides.map((g) => (
                <li key={g.id}>
                  <a href={`#${g.id}`} className="text-fg-muted hover:text-fg">
                    {g.title}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
          <div className="divide-y divide-line">
            {guides.map((g) => (
              <GuideSection key={g.id} guide={g} />
            ))}
          </div>
        </div>
      </div>

      <QuickGuide role={role} guides={guides} />
    </div>
  )
}

function GuideSection({ guide: g }: { guide: Guide }) {
  return (
    <section id={g.id} className="scroll-mt-6 py-6 first:pt-0">
      <h2 className="display text-xl">{g.title}</h2>
      <p className="mt-1 text-fg-muted">{g.when}</p>
      <ol className="mt-3 list-decimal space-y-1.5 pl-5">
        {g.steps.map((s) => (
          <li key={s}>{s}</li>
        ))}
      </ol>
      {g.notes && (
        <div className="mt-4 rounded-xl bg-sunken p-4">
          <p className="font-medium">The three conditions, honestly</p>
          <ul className="mt-2 list-disc space-y-1.5 pl-5 text-sm text-fg-muted">
            {g.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        </div>
      )}
      <Button kind="primary" asChild className="mt-4">
        <Link to={g.to}>
          {g.cta} <ArrowRight aria-hidden />
        </Link>
      </Button>
    </section>
  )
}

/** The one-page A4 hand-out. Hidden on screen. */
function QuickGuide({ role, guides }: { role: Role; guides: Guide[] }) {
  const college = useCollegeName()
  const shown = guides.slice(0, 5)
  return (
    <div className="quick-guide hidden text-[10pt] leading-snug text-black print:block">
      <div className="flex items-center justify-between border-b border-black pb-2">
        <div>
          <p className="text-[9pt]">{college}</p>
          <h1 className="text-[16pt] font-semibold">Publications: quick guide for {ROLE_LABEL[role]}</h1>
        </div>
        <Picture name="onboard-welcome" eager className="size-16" />
      </div>
      <p className="mt-2">{ROLE_INTRO[role]} Sign in with your college email. Help is always in the account menu, or press Ctrl K and type help.</p>
      {shown.map((g) => (
        <div key={g.id} className="mt-3 break-inside-avoid">
          <p className="font-semibold">
            {g.title} <span className="font-normal">(page: {g.to})</span>
          </p>
          <ol className="list-decimal pl-5">
            {g.steps.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ol>
          {g.notes && (
            <ul className="mt-1 list-disc pl-5">
              {g.notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          )}
        </div>
      ))}
    </div>
  )
}
