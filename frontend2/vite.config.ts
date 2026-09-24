import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"
import path from "node:path"

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": path.resolve(__dirname, "./src") } },
  build: {
    rolldownOptions: {
      output: {
        // One named group, and only one. React, the router and the query
        // client are on every screen and change only when a dependency is
        // upgraded, so they sit in a chunk of their own that a deploy of the
        // app does not invalidate -- they were in the entry chunk, which
        // every release renamed. Everything else is left to the bundler, on
        // purpose: a group holding a module the first screen needs and one it
        // does not pulls both onto the first screen. Grouping the animation
        // library did exactly that -- `MotionConfig` in main.tsx is a few
        // hundred bytes, and it brought all 125 KB with it.
        codeSplitting: {
          groups: [
            {
              name: "vendor",
              test: /node_modules[\\/](react|react-dom|scheduler|react-router|react-router-dom|@tanstack|cookie|set-cookie-parser)[\\/]/,
            },
          ],
        },
      },
    },
  },
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
