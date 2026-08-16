import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

// Where /api and /media are forwarded while running locally. Defaults to a
// local Django; set VITE_PROXY_TARGET to a deployed API to drive the real
// backend from a local UI (useful for checking a deploy against live data).
const API_TARGET = process.env.VITE_PROXY_TARGET || "http://127.0.0.1:8000";

const proxy = {
  "/api": { target: API_TARGET, changeOrigin: true },
  // Uploaded evidence is served by Django behind an access check. Without
  // this, /media/... fell through to the SPA and every attachment link
  // returned index.html instead of the file.
  "/media": { target: API_TARGET, changeOrigin: true },
};

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: { port: 5173, proxy },
  preview: { port: 4173, proxy },
});
