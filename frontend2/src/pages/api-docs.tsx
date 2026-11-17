import { plural } from "@/lib/count"
import { useState } from "react"
import { Link } from "react-router-dom"

import { useApi } from "@/lib/query"
import { Chip } from "@/ui/chip"
import { CopyButton } from "@/ui/copy"
import { PageHeader } from "@/ui/page-header"
import { Section } from "@/ui/section"
import { Callout, ErrorState, SkeletonRows } from "@/ui/state"
import { Meta } from "@/ui/text"
import { Segmented } from "@/ui/toggle"

import { buildExamples, EXAMPLE_LABEL, type ExampleKind } from "./api-examples"

/**
 * The API documentation page, drawn from `GET /api/v1/meta`.
 *
 * The server's FIELDS registry is the one place the field names are written
 * down; this page only reads it, so it cannot describe a field that is not
 * there or miss one that is. What is shown is what the signed-in person's own
 * token would receive: a head of department sees no amount fields.
 */

type MetaField = { name: string; type: string; description: string; money: boolean }

type MetaEndpoint = {
  name: string
  path: string
  scope: string
  title: string
  description: string
  who: string
  available: boolean
  params: string[]
  date_field: string
  fields: MetaField[]
}

type ApiMeta = {
  rate_limit_per_minute: number
  max_page_size: number
  max_file_page_size: number
  formats: string[]
  params: Record<string, string>
  endpoints: MetaEndpoint[]
}

const KINDS = Object.keys(EXAMPLE_LABEL) as ExampleKind[]

function CodeBlock({ code, label }: { code: string; label: string }) {
  return (
    <div className="relative min-w-0">
      <pre
        tabIndex={0}
        aria-label={label}
        className="well max-w-full overflow-x-auto p-3 pr-10 font-mono text-xs leading-relaxed"
      >
        <code>{code}</code>
      </pre>
      <CopyButton value={code} label={label} className="absolute right-2 top-2" />
    </div>
  )
}

export function ApiDocs() {
  const { data, isLoading, isError, refetch } = useApi<ApiMeta>(["api-meta"], "/api/v1/meta")
  const [kind, setKind] = useState<ExampleKind>("excel")
  const origin = typeof window === "undefined" ? "" : window.location.origin

  const header = (
    <PageHeader
      title="API documentation"
      sub="Read your own data from Excel, Google Sheets, Python or Power BI."
    />
  )

  if (isLoading) {
    return (
      <div className="page space-y-10">
        {header}
        <SkeletonRows rows={4} rowHeight={64} />
      </div>
    )
  }

  if (isError || !data) {
    return (
      <div className="page space-y-10">
        {header}
        <ErrorState
          title="Could not load the documentation"
          message="The server did not answer. Try again."
          onRetry={() => refetch()}
        />
      </div>
    )
  }

  return (
    <div className="page space-y-10">
      {header}

      <Section title="Getting started">
        <ol className="max-w-prose list-decimal space-y-2 pl-5 text-sm">
          <li>
            Create a token under <Link to="/me" className="underline underline-offset-2">API access on your profile</Link>.
            Copy it when it is shown: it is not shown again.
          </li>
          <li>
            Send it with every request as the header <code className="font-mono text-xs">Authorization: Bearer YOUR_TOKEN</code>.
          </li>
          <li>
            Ask for <code className="font-mono text-xs">format=csv</code> or <code className="font-mono text-xs">format=xlsx</code> to
            get a file for a spreadsheet, or leave it out for JSON.
          </li>
        </ol>
        <p className="mt-3 max-w-prose text-sm text-fg-muted">
          A token reads only, and sees exactly what you see in the app. It is limited to {plural(data.rate_limit_per_minute, "request")} a
          minute; past that the answer is 429 with a Retry-After header. JSON pages hold up to {plural(data.max_page_size, "row")} and
          csv or xlsx up to {data.max_file_page_size}; JSON answers carry a <code className="font-mono text-xs">next</code> link
          for the following page.
        </p>
      </Section>

      <Section title="Parameters every endpoint takes">
        <dl className="divide-y divide-line border-y border-line">
          {Object.entries(data.params).map(([name, text]) => (
            <div key={name} className="grid grid-cols-[minmax(0,1fr)] gap-x-6 gap-y-0.5 py-2.5 sm:grid-cols-[10rem_minmax(0,1fr)]">
              <dt>
                <code className="font-mono text-sm">{name}</code>
              </dt>
              <dd className="text-sm text-fg-muted">{text}</dd>
            </div>
          ))}
        </dl>
      </Section>

      <div className="flex flex-wrap items-center gap-3">
        <span className="text-sm font-medium">Examples for</span>
        <Segmented
          label="Example language"
          value={kind}
          onChange={(id) => setKind(id as ExampleKind)}
          items={KINDS.map((k) => ({ id: k, label: EXAMPLE_LABEL[k] }))}
        />
      </div>

      {data.endpoints.map((e) => {
        const examples = buildExamples({ origin, path: e.path, params: {} })
        return (
          <Section
            key={e.name}
            id={e.name}
            title={e.title}
            sub={e.description}
            showSub
            action={<code className="font-mono text-xs text-fg-muted">GET {e.path}</code>}
          >
            <div className="space-y-4">
              {!e.available && (
                <Callout tone="caution">Your role cannot read this, so a token of yours cannot either.</Callout>
              )}
              <p className="max-w-prose text-sm">
                <span className="font-medium">Who sees what.</span> {e.who}
              </p>
              <p className="flex flex-wrap items-center gap-1.5 text-sm">
                <span className="font-medium">Parameters</span>
                {e.params.map((p) => (
                  <Chip key={p}>{p}</Chip>
                ))}
                <Meta>Scope needed: {e.scope}. Dates are on {e.date_field}.</Meta>
              </p>

              <ul className="divide-y divide-line border-y border-line" aria-label={`${e.title} fields`}>
                {e.fields.map((f) => (
                  <li
                    key={f.name}
                    className="grid grid-cols-[minmax(0,1fr)] gap-x-6 gap-y-0.5 py-2 sm:grid-cols-[13rem_5rem_minmax(0,1fr)]"
                  >
                    <code className="break-all font-mono text-sm">{f.name}</code>
                    <Meta>{f.type}</Meta>
                    <span className="text-sm text-fg-muted">{f.description}</span>
                  </li>
                ))}
              </ul>

              <CodeBlock code={examples[kind]} label={`${EXAMPLE_LABEL[kind]} example for ${e.title}`} />
            </div>
          </Section>
        )
      })}
    </div>
  )
}
