import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"
import path from "node:path"

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": path.resolve(__dirname, "./src") } },
  server: {
    port: 5174,
    // Do not watch anything Playwright writes.
    //
    // `outputDir` is `./e2e/.artifacts`, inside the Vite root, and traces are
    // kept `retain-on-failure`. So chokidar ends up watching a `.network`
    // trace file that Playwright still has open, gets EBUSY on Windows, and
    // the FSWatcher error goes unhandled -- taking the dev server down.
    //
    // The failure mode is what makes it worth a comment: it fires *only after
    // a test has already failed*, so every subsequent test dies on
    // ECONNREFUSED and the run reports a cascade of defects that are not
    // there. Two false failures in the last suite run traced back to this.
    watch: {
      ignored: ["**/e2e/.artifacts/**", "**/test-results/**", "**/playwright-report/**"],
    },
    // The API is same-origin in production (Vercel rewrites /api to Cloud
    // Run), so it has to be same-origin here too or the session cookie is
    // cross-site and never sent. The target is the local Django port unless
    // pointed elsewhere — what lets a scratch backend (a setup-wizard check,
    // a product smoke test) be driven through the real frontend.
    proxy: {
      "/api": {
        target: process.env.VITE_API_PROXY || "http://localhost:8000",
        changeOrigin: true,
      },
      "/media": {
        target: process.env.VITE_API_PROXY || "http://localhost:8000",
        changeOrigin: true,
      },
    },
  },
})
