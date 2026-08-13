import { defineConfig } from "@playwright/test"

/**
 * The spec in e2e/ had no config and no dependency, so it could never run.
 * Install once with:  npm install && npx playwright install chromium
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  fullyParallel: false,
  retries: 0,
  reporter: "list",
  use: {
    baseURL: process.env.E2E_BASE_URL || "http://localhost:5173",
    trace: "on-first-retry",
  },
})
