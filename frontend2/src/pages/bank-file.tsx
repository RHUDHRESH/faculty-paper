import { useState } from "react"
import { Download } from "lucide-react"

import { queryClient, useApi } from "@/lib/query"
import { Button } from "@/ui/button"
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/ui/dialog"
import { Field, Textarea } from "@/ui/field"
import { money } from "@/ui/paper"

type Exported = { id: string; created_at: string; by: string | null; count: number; total: number; scope: string }
export type BankExports = {
  month: string
  exports: Exported[]
  new_count: number
  new_total: number
  all_count: number
  all_total: number
}

const when = (iso: string) => new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`

/** Start a file download without leaving the page. */
function download(url: string) {
  const a = document.createElement("a")
  a.href = url
  a.download = ""
  document.body.appendChild(a)
  a.click()
  a.remove()
}

/**
 * The bank-upload file for one month, remembered.
 *
 * The bank pays what it is sent, so a second file for the same month is how a
 * month gets paid twice. The first file downloads plainly and records itself;
 * after that this says "already generated on 3 May by Kavya" and offers only
 * what is safe: the payments not yet sent, or the whole month again with a
 * reason that goes on the record. The server refuses a repeat that did not
 * choose, so the link cannot be used to skip this.
 */
export function BankFileButton({ month, size = "md" }: { month: string; size?: "sm" | "md" }) {
  const key = ["bank-exports", month]
  const { data } = useApi<BankExports>(key, `/api/payouts/bank-exports?month=${month}`)
  const [asking, setAsking] = useState(false)
  const [again, setAgain] = useState(false)
  const [reason, setReason] = useState("")

  const last = data?.exports[0]
  const base = `/api/payouts/statement.csv?month=${month}`

  function go(url: string) {
    download(url)
    setAsking(false)
    setAgain(false)
    setReason("")
    // The server writes the record as it answers; read it back a moment later.
    window.setTimeout(() => void queryClient.invalidateQueries({ queryKey: key }), 1200)
  }

  if (!last) {
    return (
      <Button kind="default" size={size} onClick={() => go(base)}>
        <Download />
        Bank file (CSV)
      </Button>
    )
  }

  return (
    <>
      <Button kind="default" size={size} onClick={() => setAsking(true)}>
        <Download />
        Bank file (CSV)
      </Button>
      <Dialog open={asking} onOpenChange={setAsking}>
        <DialogContent size="md">
          <DialogHeader>
            <DialogTitle>This month's bank file was already made</DialogTitle>
            <DialogDescription>
              Generated on {when(last.created_at)}
              {last.by ? ` by ${last.by}` : ""}, {plural(last.count, "payment")}, {money(last.total)}.
              {data && data.new_count > 0
                ? ` ${plural(data.new_count, "payment")} (${money(data.new_total)}) ${data.new_count === 1 ? "has" : "have"} been made since.`
                : " Nothing has been paid since."}
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-4">
            <p className="text-sm text-fg-muted">
              Sending the same payments to the bank twice pays them twice. Download only what has not gone yet, or send
              the whole month again if the first file never reached the bank.
            </p>
            {again && (
              <Field label="Why the whole month is going again" hint="At least 10 characters. It is kept with the file.">
                <Textarea value={reason} onChange={(e) => setReason(e.target.value)} />
              </Field>
            )}
          </DialogBody>
          <DialogFooter className="flex-wrap">
            <Button kind="quiet" onClick={() => setAsking(false)}>
              Cancel
            </Button>
            {!again && (
              <Button kind="default" onClick={() => setAgain(true)}>
                The whole month again
              </Button>
            )}
            {again ? (
              <Button
                kind="danger"
                disabled={reason.trim().length < 10}
                onClick={() => go(`${base}&scope=all&reason=${encodeURIComponent(reason.trim())}`)}
              >
                Download the whole month again
              </Button>
            ) : (
              <Button kind="primary" disabled={!data || data.new_count === 0} onClick={() => go(`${base}&scope=new`)}>
                {data && data.new_count > 0
                  ? `Download the ${plural(data.new_count, "new payment")}`
                  : "No new payments"}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
