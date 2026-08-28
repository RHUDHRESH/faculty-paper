import "@testing-library/jest-dom/vitest"

import { cleanup } from "@testing-library/react"
import { afterEach, vi } from "vitest"

/**
 * What jsdom does not have, and what the app assumes every browser does.
 *
 * Without these the first render of any page that draws a table throws
 * "ResizeObserver is not defined" and the failure looks like a bug in the
 * component rather than a missing browser API — which is how a test suite
 * ends up with a lot of `try/catch` in it instead of four lines here.
 */

class TestResizeObserver implements ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = TestResizeObserver
}

// `shell.tsx` asks whether the viewport is wide; jsdom has no media queries.
// Answering "no" keeps every test on the narrow layout, which is the one that
// renders without a sidebar to disambiguate from.
if (typeof window.matchMedia === "undefined") {
  window.matchMedia = (query: string): MediaQueryList =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList
}

// Radix's dismissable layers and the combobox both use these; jsdom stubs
// neither, and both are no-ops as far as any assertion here is concerned.
Element.prototype.scrollIntoView = () => {}
Element.prototype.hasPointerCapture = () => false
Element.prototype.setPointerCapture = () => {}
Element.prototype.releasePointerCapture = () => {}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})
