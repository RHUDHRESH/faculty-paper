import { useState } from "react"
import { Link } from "react-router-dom"
import { BellRing, Check, Users } from "lucide-react"

import { useApiMutation } from "@/lib/query"
import { face, type Brief, type PushRow, type Reminder } from "@/pages/hod-parts"
import { Button } from "@/ui/button"
import { Avatar } from "@/ui/person"
import type { EmptyStateProps } from "@/ui/state"
import { Table, type Column } from "@/ui/table"
import { toast } from "@/ui/toast"

/**
 * "Who needs a push" as one table: the colleague, the reason, the next step,
 * and the buttons that do it in the last column. A suggested writing partner is
 * a second button on the same row, because "write with her" is the next step
 * for a person with no Q1 paper and it is one click to make it an assignment
 * both of them see.
 */

const DAY = 24 * 60 * 60 * 1000

function PushActions({
  row,
  pair,
  onRemind,
}: {
  row: PushRow
  pair?: Brief["pairs"][number]
  onRemind: (r: Reminder) => void
}) {
  const p = row.person
  const recently = !!p.last_reminded_at && Date.now() - new Date(p.last_reminded_at).getTime() < DAY
  const [paired, setPaired] = useState(false)
  const create = useApiMutation<
    { kind: string; title: string; notes: string; assignee_id: string; partner_id: string },
    unknown
  >("/api/hod/assignments", { invalidates: [["hod", "assignments"], ["hod", "brief"]] })

  async function pairThem() {
    if (!pair) return
    try {
      await create.mutateAsync({
        kind: "PAIRING",
        title: `Write a paper together${pair.area ? ` in ${pair.area}` : ""}`,
        notes: pair.why,
        assignee_id: pair.mentee.id,
        partner_id: pair.mentor.id,
      })
      setPaired(true)
      toast.ok(`Paired ${pair.mentee.name} with ${pair.mentor.name}. Both see it on their home screen.`)
    } catch (err) {
      toast.fail(err)
    }
  }

  return (
    <div className="flex flex-wrap gap-2">
      {pair && (
        <Button
          kind="default"
          onClick={() => void pairThem()}
          disabled={paired || create.isPending}
          aria-label={`Pair ${p.name} with ${pair.mentor.name}`}
        >
          {paired ? <Check /> : <Users />}
          {paired ? "Paired" : "Pair them"}
        </Button>
      )}
      <Button
        kind={pair ? "quiet" : "default"}
        onClick={() => onRemind({ people: [{ id: p.id, name: p.name }], draft: row.draft })}
        disabled={recently}
        aria-label={recently ? `${p.name} was reminded in the last day` : `Remind ${p.name}`}
      >
        {recently ? <Check /> : <BellRing />}
        {recently ? "Reminded" : "Remind"}
      </Button>
    </div>
  )
}

export function PushTable({
  rows,
  pairs,
  onRemind,
  empty,
  toolsId = "department-push",
}: {
  rows: PushRow[]
  pairs: Brief["pairs"]
  onRemind: (r: Reminder) => void
  empty: EmptyStateProps
  toolsId?: string
}) {
  const pairOf = new Map(pairs.map((x) => [x.mentee.id, x]))
  const next = (r: PushRow) => {
    const pair = pairOf.get(r.person.id)
    return pair ? `Write with ${pair.mentor.name} (${pair.area ?? "same area"}).` : r.next_step
  }
  const columns: Column<PushRow>[] = [
    {
      key: "person",
      header: "Colleague",
      exportValue: (r) => r.person.name,
      cell: (r) => (
        <span className="flex min-w-0 items-center gap-3">
          <Avatar person={face(r.person)} size="md" />
          <Link to={`/faculty/${r.person.id}`} className="font-medium text-accent underline-offset-4 hover:underline">
            {r.person.name}
          </Link>
        </span>
      ),
    },
    { key: "why", header: "Why", exportValue: (r) => r.reasons.join(". "), cell: (r) => r.reasons.join(". ") },
    { key: "next", header: "Next step", exportValue: next, cell: next },
    {
      key: "act",
      header: <span className="sr-only">Remind</span>,
      label: "Remind",
      cell: (r) => <PushActions row={r} pair={pairOf.get(r.person.id)} onRemind={onRemind} />,
    },
  ]
  return (
    <Table
      rows={rows}
      columns={columns}
      getKey={(r) => r.person.id}
      maxHeight="none"
      caption="Colleagues who need a push"
      tools={{ id: toolsId, title: "Who needs a push" }}
      empty={empty}
    />
  )
}
