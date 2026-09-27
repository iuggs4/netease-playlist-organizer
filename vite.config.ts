import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { crx } from '@crxjs/vite-plugin'
import { fileURLToPath, URL } from 'node:url'
import manifest from './manifest.json'

export default defineConfig({
  plugins: [react(), crx({ manifest })],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  build: {
    // panel.html 不在 manifest 里，作为额外入口声明，否则不会被构建
    rollupOptions: {
      input: {
        panel: fileURLToPath(new URL('./panel.html', import.meta.url)),
      },
    },
  },
})
