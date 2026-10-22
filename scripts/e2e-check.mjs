/**
 * 浏览器端到端验证（借用 jetbot-demo 的 playwright 安装）。
 * 验证：应用能启动、空态渲染、设置对话框可用、无页面错误。
 */
import { chromium } from 'file:///Users/hongxin/Workspace/dsh-playground/jetbot-demo/node_modules/playwright/index.mjs'
import { mkdirSync } from 'node:fs'

mkdirSync(new URL('../docs/screenshots/', import.meta.url).pathname, { recursive: true })

const browser = await chromium.launch({
  executablePath:
    '/Users/hongxin/Library/Caches/ms-playwright/chromium_headless_shell-1217/chrome-headless-shell-mac-arm64/chrome-headless-shell',
})
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const errors = []
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message))
page.on('console', (m) => {
  if (m.type() === 'error') errors.push('console: ' + m.text())
})

await page.goto('http://localhost:5188', { waitUntil: 'networkidle' })

// 1. 启动到空态
await page.waitForSelector('.empty-state h1', { timeout: 20_000 })
const h1 = await page.textContent('.empty-state h1')
if (!h1 || !h1.includes('Tim Harness')) throw new Error('空态标题异常: ' + h1)
console.log('✓ 应用启动，空态渲染正常：', h1)

// 2. 侧栏会话与品牌
const brand = await page.textContent('.brand-name')
if (!brand.includes('TIM HARNESS')) throw new Error('侧栏品牌异常')
console.log('✓ 侧栏渲染正常')

// 3. 打开设置
await page.click('.btn-footer:has-text("设置")')
await page.waitForSelector('.modal.settings', { timeout: 5_000 })
const provCount = await page.locator('.prov-item').count()
if (provCount < 3) throw new Error('默认 Provider 数量异常: ' + provCount)
console.log(`✓ 设置对话框打开，默认 ${provCount} 个 Provider`)

// 4. 网络/数据 tab 可切换
await page.click('.settings-tabs .rp-tab:has-text("网络")')
await page.click('.settings-tabs .rp-tab:has-text("数据")')
await page.click('.settings-tabs .rp-tab:has-text("模型服务")')
console.log('✓ 设置三个分页切换正常')

await page.screenshot({ path: new URL('../docs/screenshots/settings.png', import.meta.url).pathname })
await page.click('.modal-head .btn-icon') // 关闭设置

// 5. 右面板（文件/任务）
await page.waitForSelector('.rightpanel', { timeout: 5_000 })
const fsBadge = await page.textContent('.fs-badge')
console.log('✓ 右侧工作区面板渲染，存储模式:', fsBadge.trim())
await page.click('.rp-tab:has-text("任务")')
await page.click('.rp-tab:has-text("文件")')

// 6. 空态截图（深色）
await page.screenshot({ path: new URL('../docs/screenshots/app-home.png', import.meta.url).pathname })

// 7. 浅色主题切换（按钮文案随当前主题变化，用图标定位）
const themeBtn = page.locator('.btn-footer', { hasText: /浅色|深色/ }).first()
await themeBtn.click()
await page.waitForTimeout(300)
await page.screenshot({ path: new URL('../docs/screenshots/app-light.png', import.meta.url).pathname })
await themeBtn.click()

// 8. 输入框可用（不真正发送 —— 没有 key 时应得到引导性报错而不是崩溃）
await page.fill('.composer textarea', '测试输入')
const val = await page.inputValue('.composer textarea')
if (val !== '测试输入') throw new Error('输入框异常')
console.log('✓ 输入区正常')

await browser.close()

if (errors.length > 0) {
  console.error('✗ 页面错误：')
  for (const e of errors) console.error('  ' + e)
  throw new Error('存在页面错误')
}
console.log('\n全部浏览器端到端检查通过，无页面错误。')
