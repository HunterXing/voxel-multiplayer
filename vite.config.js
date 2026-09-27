import { defineConfig } from 'vite'

// Root is the game/ folder itself so that `shared/` (used by both the browser
// client and the node server) resolves without any path juggling.
export default defineConfig({
  server: {
    port: 5173,
    open: false,
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
})
