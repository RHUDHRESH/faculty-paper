import { Link } from "react-router-dom"

import { useApi } from "@/lib/query"
import { Button } from "@/ui/button"
import { PageHeader } from "@/ui/page-header"
import { ErrorState, NotOpen, SkeletonRows } from "@/ui/state"
import { type Column, Table } from "@/ui/table"
import { Meta } from "@/ui/text"

import { count } from "./admin-b-parts"

/**
 * The accounts behind "No department on the account" in the reports.
 *
 * Papers and payments by these people have nowhere to go on a department chart,
 * so the charts list them last under that name. This is the list to fix. It
 * reads GET /api/admin/data-fill/accounts: anyone who reads the college's
 * reports may see it, a super admin also gets the way to fill it from the
 * faculty list.
 */

type Account = { id: string; name: string; email: string; role: string; staff_id: string; designation: string }
type Payload = { total: number; rows: Account[]; can_fix: boolean }


export function NoDepartment() {
  const { data, isLoading, error, refetch } = useApi<Payload>(["admin", "data-fill", "accounts"], "/api/admin/data-fill/accounts")

  if (error?.status === 403) {
    return (
      <div className="page py-8">
        <NotOpen message="Ask the research office if you think it should be yours." />
      </div>
    )
  }

  const columns: Column<Account>[] = [
    {
      key: "name",
      header: "Account",
      exportValue: (a) => a.name,
      cell: (a) => (
        <Link to={`/faculty/${a.id}`} className="underline-offset-4 hover:underline">
          {a.name}
        </Link>
      ),
    },
    { key: "email", header: "Email", exportValue: (a) => a.email, cell: (a) => <span className="break-all">{a.email}</span> },
    { key: "staff", header: "Staff ID", exportValue: (a) => a.staff_id, empty: "–", cell: (a) => a.staff_id || null },
    { key: "designation", header: "Designation", exportValue: (a) => a.designation, empty: "–", cell: (a) => a.designation || null },
  ]

  return (
    <div className="page space-y-6">
      <PageHeader
        title="Accounts with no department"
        sub={
          data
            ? `${count(data.total)} ${data.total === 1 ? "account has" : "accounts have"} no department. Their papers are listed last on the department charts.`
            : "Their papers are listed last on the department charts."
        }
        action={
          data?.can_fix ? (
            <Button asChild kind="default">
              <Link to="/data/health#data-fill">Fill from the faculty list</Link>
            </Button>
          ) : undefined
        }
      />
      {isLoading ? (
        <SkeletonRows rows={6} />
      ) : error ? (
        <ErrorState title="Could not load the accounts" message="The server did not answer." onRetry={() => void refetch()} />
      ) : (
        <>
          <Table
            rows={data?.rows ?? []}
            columns={columns}
            getKey={(a) => a.id}
            caption="Accounts with no department"
            maxHeight="none"
            tools={{ id: "no-department", title: "Accounts with no department" }}
            empty={{ title: "Every account has a department", message: "Nothing to fix here." }}
          />
          <Meta className="block max-w-prose">
            A department is set on the account by a super admin, or comes from the faculty list when the list is imported.
          </Meta>
        </>
      )}
    </div>
  )
}
