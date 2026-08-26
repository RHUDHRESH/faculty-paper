import { ChevronLeft, ChevronRight } from "lucide-react"

import { Button } from "@/ui/button"
import { Meta } from "@/ui/text"

/**
 * The pager under a server-paged list.
 *
 * It lives here because five screens had written it out separately —
 * audit, papers, payments, people and publications — and the five copies had
 * already drifted in the one way that matters: three of them said
 * "1–20 of 412" and two said only "Page 1 of 21", so on those two a reader
 * could not tell whether the filter had matched forty rows or four thousand
 * without paging to the end and reading the number off the last screen.
 *
 * It renders nothing at all when everything fits on one page. A pager that
 * says "Page 1 of 1" is a control that has never once been useful, and it
 * appears under every short list.
 */
export function Pagination({
  page,
  pageSize,
  total,
  onChange,
}: {
  /** Zero-based, matching the `offset = page * pageSize` the API takes. */
  page: number
  pageSize: number
  total: number
  onChange: (page: number) => void
}) {
  if (total <= pageSize) return null

  const pageCount = Math.max(1, Math.ceil(total / pageSize))
  const start = page * pageSize + 1
  const end = Math.min(total, (page + 1) * pageSize)

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
      {/* Both figures, always: which rows these are, and how many there are
          in total. The second is the one a reader actually came for. */}
      <Meta className="tabular">
        {start}–{end} of {total}
      </Meta>
      <div className="flex items-center gap-1">
        <Button kind="quiet" size="sm" onClick={() => onChange(page - 1)} disabled={page === 0}>
          <ChevronLeft />
          Previous
        </Button>
        <Meta className="px-1 tabular">
          Page {page + 1} of {pageCount}
        </Meta>
        <Button
          kind="quiet"
          size="sm"
          onClick={() => onChange(page + 1)}
          disabled={page + 1 >= pageCount}
        >
          Next
          <ChevronRight />
        </Button>
      </div>
    </div>
  )
}
