import { defineConfig } from 'vite'

// 微信 PoC 冒烟打包（Node 运行）：core + wx 适配器 + wx 模拟器
export default defineConfig({
  build: {
    target: 'es2022',
    lib: {
      entry: 'scripts/wechat-smoke.ts',
      formats: ['es'],
      fileName: () => 'wechat-smoke.mjs',
    },
    outDir: 'dist-wechat-smoke',
    minify: false,
  },
})
