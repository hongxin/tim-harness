/**
 * 浏览器端到端验证（借用 jetbot-demo 的 playwright 安装）。
 * 覆盖：启动/空态/设置/面板（v0.1）+ 滚动跟随/回到最新/HTML 预览/控制台回传/文件树（v0.1.1）。
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
console.log('✓ 应用启动，空态渲染正常')

// 2. 侧栏
const brand = await page.textContent('.brand-name')
if (!brand.includes('TIM HARNESS')) throw new Error('侧栏品牌异常')
console.log('✓ 侧栏渲染正常')

// 3. 设置对话框
await page.click('.btn-footer:has-text("设置")')
await page.waitForSelector('.modal.settings', { timeout: 5_000 })
const provCount = await page.locator('.prov-item').count()
if (provCount < 3) throw new Error('默认 Provider 数量异常: ' + provCount)
await page.click('.settings-tabs .rp-tab:has-text("网络")')
await page.click('.settings-tabs .rp-tab:has-text("数据")')
await page.click('.settings-tabs .rp-tab:has-text("模型服务")')
console.log(`✓ 设置对话框与三个分页正常（${provCount} 个 Provider）`)
await page.screenshot({ path: new URL('../docs/screenshots/settings.png', import.meta.url).pathname })
await page.click('.modal-head .btn-icon')

// 4. 空态截图（清屏状态）
await page.screenshot({ path: new URL('../docs/screenshots/app-home.png', import.meta.url).pathname })

// 5. 浅色主题
const themeBtn = page.locator('.btn-footer[title*="主题"]').first()
await themeBtn.click()
await page.waitForTimeout(300)
await page.screenshot({ path: new URL('../docs/screenshots/app-light.png', import.meta.url).pathname })
await themeBtn.click()

// 6. 滚动跟随 + 回到最新（注入 30 组消息模拟长会话）
await page.evaluate(() => {
  const rt = window.__TIM_RUNTIME__
  const s = rt.getSnapshot().session
  for (let i = 0; i < 30; i++) {
    s.messages.push({ role: 'user', content: '用户消息 ' + i })
    s.messages.push({ role: 'assistant', content: ('这是第 ' + i + ' 条回复，内容稍长以撑起滚动。').repeat(3) })
  }
  rt.notify()
})
await page.waitForTimeout(400)
const scroll1 = await page.$eval('.chat-scroll', (el) => ({
  sh: el.scrollHeight, ch: el.clientHeight, st: el.scrollTop,
}))
if (!(scroll1.sh > scroll1.ch)) throw new Error('对话区未产生滚动: ' + JSON.stringify(scroll1))
if (scroll1.sh - scroll1.st - scroll1.ch > 40) throw new Error('未自动跟随到底部: ' + JSON.stringify(scroll1))
console.log('✓ 滚动：内容溢出且自动跟随到底部')

// 滚动条可见性（thumb 有实际尺寸与颜色）
const thumbVisible = await page.evaluate(() => {
  const el = document.querySelector('.chat-scroll')
  const wide = el.offsetWidth - el.clientWidth // 滚动条占据的宽度
  return wide >= 8
})
if (!thumbVisible) throw new Error('滚动条不可见（占用宽度 < 8px）')
console.log('✓ 滚动条可见')

await page.$eval('.chat-scroll', (el) => (el.scrollTop = 0))
await page.waitForTimeout(250)
if (!(await page.isVisible('.jump-latest'))) throw new Error('回到最新按钮未出现')
await page.click('.jump-latest')
await page.waitForTimeout(700)
const dist = await page.$eval('.chat-scroll', (el) => el.scrollHeight - el.scrollTop - el.clientHeight)
if (dist > 40) throw new Error('点击回到最新后未到底部, dist=' + dist)
console.log('✓ 「回到最新」按钮出现并可回到底部')

// 7. 导入文件（走 runtime 真实 API，触发 fsRev）→ 文件树 → 预览 + 控制台回传
await page.evaluate(async () => {
  const rt = window.__TIM_RUNTIME__
  await rt.importWorkspaceFiles([
    {
      path: '/demo/index.html',
      content:
        '<!doctype html><html><head><meta charset="utf-8"><title>demo</title></head><body><h1 style="font-family:sans-serif">Hi Tim Preview</h1><script>console.log("hello preview");setTimeout(()=>{throw new Error("boom")},60);</script></body></html>',
    },
    { path: '/demo/data.json', content: '{"n":1}' },
  ])
})
// 文件树（先离开再回到文件 tab 模拟真实切换；展开 demo 目录）
await page.click('.rp-tab:has-text("任务")')
await page.click('.rp-tab:has-text("文件")')
await page.waitForSelector('.ft-row', { timeout: 5_000 })
await page.click('.ft-row.dir')
await page.waitForTimeout(200)
const treeText = await page.textContent('.file-tree')
if (!treeText.includes('demo') || !treeText.includes('index.html') || !treeText.includes('data.json')) {
  throw new Error('文件树内容异常: ' + treeText)
}
console.log('✓ 文件树：目录分组、展开与文件展示正常')
await page.screenshot({ path: new URL('../docs/screenshots/files-tree.png', import.meta.url).pathname })

// 预览（先注册 message 监听，再点击）
await page.evaluate(() => {
  window.__timLogs = []
  addEventListener('message', (e) => {
    if (e.data && e.data.__tim_preview) window.__timLogs.push(e.data.entry)
  })
})
await page.click('.rp-tab:has-text("预览")')
await page.waitForSelector('.preview-pick-item', { timeout: 5_000 })
await page.click('.preview-pick-item')
await page.waitForSelector('.preview-frame', { timeout: 5_000 })
await page.waitForTimeout(700)
const logs = await page.evaluate(() => window.__timLogs)
if (!logs.some((l) => (l.text || '').includes('hello preview'))) {
  throw new Error('预览控制台未捕获 console.log: ' + JSON.stringify(logs))
}
if (!logs.some((l) => l.level === 'error' && (l.text || '').includes('boom'))) {
  throw new Error('预览控制台未捕获运行时错误: ' + JSON.stringify(logs))
}
const pcCount = await page.locator('.pc-line').count()
if (pcCount < 2) throw new Error('控制台面板行数异常: ' + pcCount)
console.log(`✓ HTML 预览：iframe 渲染 + 控制台回传（${pcCount} 条，含错误捕获）`)
await page.screenshot({ path: new URL('../docs/screenshots/preview.png', import.meta.url).pathname })

// 大窗预览
await page.click('.preview-toolbar .btn-ghost[title="大窗预览"]')
await page.waitForSelector('.preview-big', { timeout: 5_000 })
await page.screenshot({ path: new URL('../docs/screenshots/preview-big.png', import.meta.url).pathname })
await page.click('.preview-big .btn-icon')
console.log('✓ 大窗预览可开合')

// 8. 输入区
await page.fill('.composer textarea', '测试输入')
const val = await page.inputValue('.composer textarea')
if (val !== '测试输入') throw new Error('输入框异常')
console.log('✓ 输入区正常')

await browser.close()

if (errors.length > 0) {
  // 过滤预览沙箱中"预期内"的测试错误（demo 页面故意 throw boom 以验证捕获）
  const real = errors.filter((e) => !/\bboom\b/.test(e))
  if (real.length > 0) {
    console.error('✗ 页面错误：')
    for (const e of real) console.error('  ' + e)
    throw new Error('存在页面错误')
  }
}
console.log('\n全部浏览器端到端检查通过，无页面错误。')
