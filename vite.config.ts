import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// GitHub Pages 部署在 https://hongxin.github.io/tim-harness/ 子路径下，
// 构建时需要正确的 base（仿 JetBot 方案）；本地 dev 保持根路径。
export default defineConfig(({ command }) => ({
  base: command === 'build' ? '/tim-harness/' : '/',
  plugins: [react()],
  server: { port: 5188, host: true },
  preview: { port: 5188, host: true },
  build: { target: 'es2022', sourcemap: false },
}))
