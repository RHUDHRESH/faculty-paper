/**
 * The workspace's "add a mark" key (m) reaches the marks layer by an event,
 * because the layer's contract (`<MarkLayer claimId uploadId page scale>`)
 * has no prop for it. A layer that wants the key listens for this on
 * `window`; until one does, pressing m does nothing.
 */
export const ADD_MARK_EVENT = "review:add-mark"

export function requestMark(): void {
  window.dispatchEvent(new CustomEvent(ADD_MARK_EVENT))
}
