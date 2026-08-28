import { defineConfig } from "vitest/config"
import react from "@vitejs/plugin-react"
import path from "node:path"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))

/**
 * The test config is separate from `vite.config.ts` on purpose.
 *
 * `vite.config.ts` carries the dev proxy and the Tailwind plugin, neither of
 * which a test run wants, and `npm run check` typechecks it under
 * `tsconfig.node.json` — a `test` block bolted onto it would drag Vitest's
 * types into the build config for no gain. This file is not in any tsconfig
 * project, so it is compiled only by Vite itself, at the moment tests run.
 */
export default defineConfig({
  plugins: [react()],
  resolve: { alias: { "@": path.resolve(here, "./src") } },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
    css: false,
    restoreMocks: true,
  },
})
