import { defineConfig } from 'vite'

// 将 core（平台无关层）打包为可在 Node 中运行的单文件冒烟测试。
// 这本身也是对“core 不依赖浏览器”这一架构约束的持续验证。
export default defineConfig({
  build: {
    target: 'es2022',
    lib: {
      entry: 'scripts/smoke.ts',
      formats: ['es'],
      fileName: () => 'smoke.mjs',
    },
    outDir: 'dist-smoke',
    minify: false,
  },
})
