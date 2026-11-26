import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  build: {
    // SECURITY: never emit source maps into the deployed bundle. Maps would
    // expose the full original TypeScript source (including any embedded
    // default values) to anyone who can fetch the assets. This is the Vite
    // default, pinned explicitly so it can never be switched on by accident.
    sourcemap: false,
  },
})
