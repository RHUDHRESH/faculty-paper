import { useState } from "react"
import { LoaderCircle, Upload } from "lucide-react"
import { useQueryClient } from "@tanstack/react-query"

import { api } from "@/lib/api"
import { formatCount } from "@/lib/count"
import { useApi } from "@/lib/query"
import { Button } from "@/ui/button"
import { Field } from "@/ui/field"
import { InlineError } from "@/ui/state"
import { Meta } from "@/ui/text"
import { toast } from "@/ui/toast"

/**
 * What `GET /api/journals/flag-lists` answers: one row per list, with how many
 * journals it holds and when it was loaded (null while it has never been).
 */
type Lists = { source: string; label: string; entries: number; loaded_at: string | null }[]

/** The two lists the journal check needs, in the words a teacher would use. */
const LISTS: { source: string; title: string; hint: string }[] = [
  {
    source: "SCOPUS_DISCONTINUED",
    title: "Journals Scopus has dropped",
    hint: "A .csv with the journal title and ISSN (scopus-discontinued.csv in the project's journal-lists folder).",
  },
  {
    source: "HIJACKED",
    title: "Journals with fake copies",
    hint: "A .csv with the real journal and the fake website (hijacked.csv in the same folder).",
  },
]

const day = (iso: string) => new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })

/**
 * Loads the lists behind "Check a journal": journals Scopus has dropped, and
 * real journals that fake websites copy. Until a list is loaded the check
 * says "unknown" for it, never "fine", so loading them is what turns two grey
 * lines into real answers. Super admin only, a file pick each.
 */
export function JournalListsImport() {
  const lists = useApi<Lists>(["journals", "flag-lists"], "/api/journals/flag-lists")
  return (
    <div className="space-y-5">
      {LISTS.map((l) => (
        <ListRow key={l.source} {...l} current={lists.data?.find((x) => x.source === l.source)} onLoaded={() => void lists.refetch()} />
      ))}
    </div>
  )
}

function ListRow({
  source,
  title,
  hint,
  current,
  onLoaded,
}: {
  source: string
  title: string
  hint: string
  current: Lists[number] | undefined
  onLoaded: () => void
}) {
  const qc = useQueryClient()
  const [file, setFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [pick, setPick] = useState(0)

  async function run() {
    if (!file) return
    setBusy(true)
    setFailure(null)
    try {
      const body = new FormData()
      body.append("file", file)
      const res = await api<{ entries: number }>(`/api/journals/flag-lists/upload?source=${encodeURIComponent(source)}`, {
        method: "POST",
        body,
      } as unknown as Parameters<typeof api>[1])
      toast.ok(`${formatCount(res.entries)} journals loaded`)
      setFile(null)
      setPick((n) => n + 1)
      onLoaded()
      void qc.invalidateQueries({ queryKey: ["journals"] })
    } catch (err) {
      setFailure(err instanceof Error ? err.message : "The server did not answer.")
      toast.fail(err, "The list could not be loaded")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-2">
      <p className="text-sm font-medium text-fg">{title}</p>
      <Meta className="block">
        {current?.loaded_at
          ? `${formatCount(current.entries)} journals, loaded ${day(current.loaded_at)}. Loading a file again replaces them.`
          : "Not loaded yet, so the journal check says unknown."}
      </Meta>
      <Field label="File" hint={hint}>
        <input
          key={pick}
          type="file"
          accept=".csv,text/csv"
          disabled={busy}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setFile(e.target.files?.[0] ?? null)}
          className="block w-full text-sm file:mr-3 file:rounded-md file:border file:border-line file:bg-surface file:px-3 file:py-1.5 file:text-sm disabled:opacity-50"
        />
      </Field>
      <div className="flex flex-wrap items-center gap-3">
        <Button kind="default" size="sm" disabled={!file || busy} onClick={() => void run()}>
          {busy ? <LoaderCircle aria-hidden className="animate-spin motion-reduce:animate-none" /> : <Upload aria-hidden />}
          {busy ? "Loading…" : "Load this list"}
        </Button>
        {!file && !busy ? <Meta>Choose the file first.</Meta> : null}
      </div>
      {failure ? <InlineError message={failure} /> : null}
    </div>
  )
}
