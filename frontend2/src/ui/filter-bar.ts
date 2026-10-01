/**
 * The row of filters above a queue or a list, laid out one way everywhere.
 *
 * From `sm` up the filters sit on one wrapping line at the widths each page
 * gives them. On a phone every filter takes the full width, one per line:
 * three comboboxes at three different fixed widths, stacked, read as a
 * staircase rather than as a form (People, the audit log and the four desks
 * all did it). Bottom-aligned, so a filter with a label above it lines up
 * with one without. The search field (the first child) takes the whole row and\n * the rest sit two to a row, so five filters are three rows tall, not five.
 */
export const filterBar =
  "flex flex-wrap items-end gap-3 max-sm:grid max-sm:grid-cols-2 max-sm:gap-2 max-sm:[&>*]:w-full max-sm:[&>*]:max-w-none max-sm:[&>*:first-child]:col-span-2"
