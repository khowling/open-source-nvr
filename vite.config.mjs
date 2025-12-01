import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    proxy: {
      '/api': 'http://localhost:8080',
      '/video': 'http://localhost:8080',
      '/image': 'http://localhost:8080',
      '/mp4': 'http://localhost:8080'
    }
  },
  build: {
    outDir: 'build',
    sourcemap: true
  }
})
