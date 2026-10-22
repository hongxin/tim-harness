import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: { port: 5188, host: true },
  preview: { port: 5188, host: true },
  build: { target: 'es2022', sourcemap: false },
})
