import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 4187,
    proxy: {
      "/api": process.env.ATAPE_SERVER_URL || "http://127.0.0.1:8080",
      "/healthz": process.env.ATAPE_SERVER_URL || "http://127.0.0.1:8080"
    }
  }
})
