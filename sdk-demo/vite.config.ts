import { defineConfig } from 'vite'

// Dev server binds 0.0.0.0 so the Even App (phone, over Tailscale) can load it via `evenhub qr`.
export default defineConfig({
  server: { host: '0.0.0.0', port: 5173 },
  build: { outDir: 'dist', target: 'es2022' },
})
