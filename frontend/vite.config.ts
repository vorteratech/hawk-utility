import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// API and WebSocket calls during dev are proxied to the FastAPI backend on
// :8000 so the frontend can use same-origin URLs (/api/..., /ws/...) and the
// CORS layer in production-mode (single-origin) matches dev behavior.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:8000',
      '/ws': { target: 'ws://127.0.0.1:8000', ws: true },
    },
  },
})
