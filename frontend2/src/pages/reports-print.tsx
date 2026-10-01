import { Printer } from "lucide-react"

import { useInstitution } from "@/app/institution"
import { Button } from "@/ui/button"

/** Shared by /reports and /reports/build: the one-sentence answer a report
 *  opens with, and the letterhead a printed copy carries. */

export function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"]
  const v = n % 100
  return n + (s[(v - 20) % 10] || s[v] || s[0])
}

/** The report's answer in one sentence, set large enough to be read first. */
export function Answer({ children }: { children: React.ReactNode }) {
  return (
    <p
      data-testid="report-answer"
      className="max-w-3xl font-serif text-xl leading-snug text-ink sm:text-2xl"
    >
      {children}
    </p>
  )
}

/** Only on paper: the college, what the report is, and when it was printed. */
export function PrintStamp({ title, scope }: { title: string; scope: string }) {
  const { college_name } = useInstitution()
  const today = new Date().toLocaleDateString("en-IN", {
    day: "numeric",
    month: "long",
    year: "numeric",
  })
  return (
    <div className="hidden border-b border-black pb-2 print:block">
      <div className="flex items-baseline justify-between gap-4 text-sm">
        <strong className="font-serif text-base">{college_name || "Research office"}</strong>
        <span>Printed {today}</span>
      </div>
      <div className="text-sm">
        {title}{scope ? ` · ${scope}` : ""}
      </div>
    </div>
  )
}

export function PrintButton() {
  return (
    <Button kind="quiet" size="sm" onClick={() => window.print()} className="print:hidden">
      <Printer />
      Print
    </Button>
  )
}
