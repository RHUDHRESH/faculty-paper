import { useState } from "react"

import { api } from "@/lib/api"
import { formatCount } from "@/lib/count"
import { queryClient, useApi } from "@/lib/query"
import { Select } from "@/ui/field"
import { Avatar } from "@/ui/person"
import { Section } from "@/ui/section"
import { ErrorState, SkeletonRows } from "@/ui/state"
import { Meta } from "@/ui/text"
import { toast } from "@/ui/toast"
import { Ago } from "@/ui/when"

/**
 * Integrations > "Who brings their own key": the super admin's policy for each
 * service, and who has brought a key. Names and counts only; a key's value
 * never reaches this page (`/api/admin/keys/overview`).
 */

type Policy = "college" | "own_preferred" | "own_required"

type Person = {
  user_id: string
  name: string
  initials?: string
  photo_url?: string | null
  department: string
  calls_today: number
  calls_month: number
  last_used_at: string | null
}

type ServiceOverview = {
  provider: string
  label: string
  policy: Policy
  can_require: boolean
  people_with_own_key: number
  calls_today: number
  calls_month: number
  people: Person[]
}

type Overview = { providers: ServiceOverview[] }

const KEY = ["admin", "keys", "overview"]

const CHOICES: { value: Policy; label: string }[] = [
  { value: "college", label: "Everyone uses the college key" },
  { value: "own_preferred", label: "Own key if they have one, else the college key" },
  { value: "own_required", label: "Everyone must bring their own key" },
]

export function OwnKeysAdmin() {
  const { data, isLoading, error, refetch } = useApi<Overview>(KEY, "/api/admin/keys/overview")

  return (
    <Section
      title="Who brings their own key"
      sub="Let people add their own keys so the features they use run on their allowance, not the college's."
      showSub
      id="own-keys"
    >
      {isLoading ? (
        <SkeletonRows rows={4} />
      ) : error || !data ? (
        <ErrorState
          title="Could not load who brings their own key"
          message="The server did not answer. Nothing was changed."
          onRetry={() => void refetch()}
        />
      ) : (
        <ul className="divide-y divide-line border-y border-line">
          {data.providers.map((s) => (
            <ServiceRow key={s.provider} service={s} />
          ))}
        </ul>
      )}
    </Section>
  )
}

function ServiceRow({ service: s }: { service: ServiceOverview }) {
  const [busy, setBusy] = useState(false)

  async function choose(policy: Policy) {
    setBusy(true)
    try {
      await api(`/api/admin/keys/policy/${s.provider}`, { method: "PUT", json: { policy } })
      toast.ok(`${s.label}: policy saved`)
      await queryClient.invalidateQueries({ queryKey: KEY })
    } catch (e) {
      toast.fail(e, "Could not save. Nothing was changed.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <li className="space-y-3 py-4" data-testid={`policy-row-${s.provider}`}>
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <p className="font-medium">{s.label}</p>
          <Meta className="block">
            {formatCount(s.people_with_own_key)} {s.people_with_own_key === 1 ? "person has" : "people have"} their own key.
            {s.people_with_own_key > 0 && ` Calls today ${formatCount(s.calls_today)}, this month ${formatCount(s.calls_month)}.`}
          </Meta>
        </div>
        <label className="block min-w-0 basis-72 text-sm">
          <span className="mb-1 block font-medium">Policy for {s.label}</span>
          <Select
            value={s.policy}
            disabled={busy}
            onChange={(e) => void choose(e.target.value as Policy)}
            aria-label={`Policy for ${s.label}`}
          >
            {CHOICES.map((c) => (
              <option key={c.value} value={c.value} disabled={c.value === "own_required" && !s.can_require}>
                {c.label}
              </option>
            ))}
          </Select>
        </label>
      </div>
      {!s.can_require && <Meta className="block">{s.label} works without a key, so it cannot be made required.</Meta>}

      {s.people.length > 0 && (
        <table className="w-full text-left text-sm">
          <caption className="sr-only">People who brought their own {s.label} key</caption>
          <thead className="text-fg-muted">
            <tr>
              <th scope="col" className="py-1 pr-3 font-medium">Person</th>
              <th scope="col" className="py-1 pr-3 text-right font-medium">Today</th>
              <th scope="col" className="py-1 pr-3 text-right font-medium">This month</th>
              <th scope="col" className="hidden py-1 font-medium sm:table-cell">Last used</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {s.people.map((p) => (
              <tr key={p.user_id}>
                <td className="py-2 pr-3">
                  <span className="flex min-w-0 items-center gap-2">
                    <Avatar person={{ name: p.name, initials: p.initials ?? "", photo_url: p.photo_url ?? null }} size="xs" />
                    <span className="min-w-0 break-words">
                      {p.name}
                      {p.department && <Meta className="ml-1">{p.department}</Meta>}
                    </span>
                  </span>
                </td>
                <td className="py-2 pr-3 text-right tabular-nums">{formatCount(p.calls_today)}</td>
                <td className="py-2 pr-3 text-right tabular-nums">{formatCount(p.calls_month)}</td>
                <td className="hidden py-2 sm:table-cell">{p.last_used_at ? <Ago iso={p.last_used_at} /> : <Meta>Not yet</Meta>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </li>
  )
}

