import { resolve } from "node:path"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

// ckman backend for `npm run dev`; override with CKMAN_URL=http://host:8808
const ckman = process.env.CKMAN_URL ?? "http://127.0.0.1:8808"

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": resolve(import.meta.dirname, "./src"),
    },
  },
  server: {
    proxy: {
      "/api": ckman,
      "/swagger": ckman,
      "/docs": ckman,
    },
  },
})
