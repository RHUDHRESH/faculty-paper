import { useState } from "react"
import { CloudDownload, Upload } from "lucide-react"

import { api } from "@/lib/api"
import { useApi } from "@/lib/query"
import { Button } from "@/ui/button"
import { Field, Input } from "@/ui/field"
import { Callout, ErrorState, SkeletonText } from "@/ui/state"
import { Meta, PageTitle, SectionTitle, Sub } from "@/ui/text"
import { toast } from "@/ui/toast"

/**
 * The two tables every payment is worked out against.
 *
 * SCImago decides a journal's quartile and SNIP decides its SNIP, and both
 * are terms in the formula — a paper in a journal missing from these tables
 * is priced as though the journal had no standing at all. They were loadable
 * only by management command, which meant the reference data behind roughly
 * ₹2.7 crore of payments was refreshed by whoever remembered to, from a
 * shell, with no record on screen of when it last happened.
 *
 * The counts are the point of this screen more than the buttons are. 32,187
 * journals and the years they cover is the answer to "why did this paper
 * price at nothing", and until now there was nowhere to look it up.
 */

type Stats = { count: number; years: number[] }

export function Reference() {
  return (
    <div className="page space-y-8">
      <header>
        <PageTitle>Reference data</PageTitle>
        <Sub className="mt-1">
          The journal tables every amount is worked out against. A journal
          missing from these is priced as though it had no standing.
        </Sub>
      </header>

      <Callout tone="caution" title="Replacing a year changes what papers are worth">
        Importing a year overwrites the rows already held for it. Papers
        already paid keep the amount they were paid, but anything still being
        checked is priced against whatever is here now.
      </Callout>

      <ScimagoPanel />
      <SnipPanel />
    </div>
  )
}

/* ------------------------------------------------------------------------ */

function ScimagoPanel() {
  const { data, isLoading, error, refetch } = useApi<Stats>(
    ["admin", "scimago", "stats"],
    "/api/admin/scimago/stats"
  )
  const [year, setYear] = useState(String(new Date().getFullYear() - 1))
  const [file, setFile] = useState<File | null>(null)
  const [busy, setBusy] = useState<"upload" | "sync" | null>(null)

  async function upload() {
    if (!file) return
    setBusy("upload")
    try {
      const body = new FormData()
      body.append("file", file)
      body.append("year", year)
      const res = await api<{ imported: number; skipped: number; year: number }>(
        "/api/admin/scimago/import",
        { method: "POST", body } as unknown as Parameters<typeof api>[1]
      )
      toast.ok(
        `${res.imported.toLocaleString("en-IN")} journals loaded for ${res.year}${
          res.skipped ? `, ${res.skipped.toLocaleString("en-IN")} rows skipped` : ""
        }.`
      )
      setFile(null)
      void refetch()
    } catch (err) {
      toast.fail(err)
    } finally {
      setBusy(null)
    }
  }

  async function sync() {
    setBusy("sync")
    try {
      const res = await api<{ imported?: number }>("/api/admin/scimago/sync", {
        method: "POST",
        json: { year: Number(year) },
      })
      toast.ok(
        `Fetched ${(res.imported ?? 0).toLocaleString("en-IN")} journals for ${year} from SCImago.`
      )
      void refetch()
    } catch (err) {
      toast.fail(err)
    } finally {
      setBusy(null)
    }
  }

  return (
    <section className="space-y-4">
      <div>
        <SectionTitle>SCImago — quartiles</SectionTitle>
        <Sub className="mt-1">
          Where a journal's Q1–Q4 comes from. The quartile is a multiplier in
          the payout, so a journal absent here is worth measurably less.
        </Sub>
      </div>

      {isLoading ? (
        <SkeletonText lines={2} />
      ) : error ? (
        <ErrorState onRetry={() => void refetch()} />
      ) : data ? (
        <p className="text-sm">
          <span className="text-lg font-medium">
            {data.count.toLocaleString("en-IN")}
          </span>{" "}
          journals held.
          <Meta className="mt-0.5 block">
            {data.years.length > 0
              ? `Years covered: ${data.years.join(", ")}`
              : "No years loaded — every paper is being priced without a quartile."}
          </Meta>
        </p>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Year" hint="Which year's ranking this is.">
          <Input
            value={year}
            onChange={(e) => setYear(e.target.value)}
            inputMode="numeric"
          />
        </Field>
        <Field label="CSV" hint="A SCImago rank export.">
          <input
            type="file"
            accept=".csv,text/csv"
            onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
              setFile(e.target.files?.[0] || null)
            }
            className="block w-full text-sm file:mr-3 file:rounded-md file:border file:border-line file:bg-surface file:px-3 file:py-1.5 file:text-sm"
          />
        </Field>
        <div className="flex items-end gap-2">
          <Button
            kind="default"
            disabled={!file || !year.trim() || busy !== null}
            onClick={() => void upload()}
          >
            <Upload />
            {busy === "upload" ? "Loading…" : "Import"}
          </Button>
          <Button
            kind="quiet"
            disabled={!year.trim() || busy !== null}
            onClick={() => void sync()}
          >
            <CloudDownload />
            {busy === "sync" ? "Fetching…" : "Fetch it"}
          </Button>
        </div>
      </div>

      <Meta>
        "Fetch it" downloads the year's dump from the SCImago portal directly,
        parsed exactly the same way as an uploaded file — so the two cannot
        disagree about an ISSN or where the decimal point goes in an SJR.
      </Meta>
    </section>
  )
}

/* ------------------------------------------------------------------------ */

function SnipPanel() {
  const { data, isLoading, error, refetch } = useApi<Stats>(
    ["admin", "snip", "stats"],
    "/api/admin/snip/stats"
  )
  const [year, setYear] = useState(String(new Date().getFullYear() - 1))
  const [file, setFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)

  async function upload() {
    if (!file) return
    setBusy(true)
    try {
      const body = new FormData()
      body.append("file", file)
      body.append("year", year)
      const res = await api<{ imported?: number }>("/api/admin/snip/import", {
        method: "POST",
        body,
      } as unknown as Parameters<typeof api>[1])
      toast.ok(
        `${(res.imported ?? 0).toLocaleString("en-IN")} sources loaded for ${year}.`
      )
      setFile(null)
      void refetch()
    } catch (err) {
      toast.fail(err)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="space-y-4">
      <div>
        <SectionTitle>SNIP — citation impact</SectionTitle>
        <Sub className="mt-1">
          The figure the amount is multiplied by. A journal with no SNIP here
          falls back to a flat conference or book-chapter rate.
        </Sub>
      </div>

      {isLoading ? (
        <SkeletonText lines={2} />
      ) : error ? (
        <ErrorState onRetry={() => void refetch()} />
      ) : data ? (
        <p className="text-sm">
          <span className="text-lg font-medium">
            {data.count.toLocaleString("en-IN")}
          </span>{" "}
          sources held.
          <Meta className="mt-0.5 block">
            {data.years.length > 0
              ? `Years covered: ${data.years.join(", ")}`
              : "No years loaded."}
          </Meta>
        </p>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Year">
          <Input
            value={year}
            onChange={(e) => setYear(e.target.value)}
            inputMode="numeric"
          />
        </Field>
        <Field
          label="CSV"
          hint="Columns Title, Print ISSN, E-ISSN, SNIP, SJR, Source ID."
        >
          <input
            type="file"
            accept=".csv,text/csv"
            onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
              setFile(e.target.files?.[0] || null)
            }
            className="block w-full text-sm file:mr-3 file:rounded-md file:border file:border-line file:bg-surface file:px-3 file:py-1.5 file:text-sm"
          />
        </Field>
        <div className="flex items-end">
          <Button
            kind="default"
            disabled={!file || !year.trim() || busy}
            onClick={() => void upload()}
          >
            <Upload />
            {busy ? "Loading…" : "Import"}
          </Button>
        </div>
      </div>
    </section>
  )
}
