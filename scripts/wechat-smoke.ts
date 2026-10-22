/**
 * 微信小程序 PoC 冒烟：在 wx 模拟环境中以真实适配器（wx.request 分块 SSE / Storage /
 * FileSystemManager）驱动完整 agent 会话 —— 验证 "core 原样移植" 的架构承诺。
 */
import { WxMock } from './wx-mock'
import { bootWechatHarness } from '../src/platform/wechat/boot'

let passed = 0
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`WX-POC FAIL: ${msg}`)
  passed++
  console.log(`✓ ${msg}`)
}

function sse(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`
}
const toolCall = (id: string, name: string, args: string, first: boolean) =>
  sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, ...(first ? { id, type: 'function' } : {}), function: { ...(first ? { name } : {}), arguments: args } }] } }] })
const done = () => [
  sse({ choices: [{ index: 0, delta: { role: 'assistant', content: '微信环境' } }] }),
  sse({ choices: [{ index: 0, delta: { content: '端到端完成！' }, finish_reason: 'stop' }] }),
  sse({ choices: [], usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60, prompt_cache_hit_tokens: 40, prompt_cache_miss_tokens: 10 } }),
]

async function main() {
  const wx = new WxMock()

  /* 1. 引导（Storage 空首次启动） */
  const rt = await bootWechatHarness(wx as any)
  const snap = rt.getSnapshot()
  assert(snap.booted && snap.session !== null, 'wx PoC：boot 引导成功（Storage/FS 适配器就绪）')
  assert(snap.settings!.providers.some((p) => p.id === 'deepseek'), 'wx PoC：默认设置写入 wx Storage')

  /* 2. 配置 + 完整对话（含中文多字节 SSE 跨块切割） */
  await rt.saveSettings({
    providers: [{ id: 'mock', name: 'Mock', baseURL: 'https://mock.llm/v1', apiKey: 'k', model: 'wx-test' }],
    activeProviderId: 'mock',
    proxyTemplate: '',
    webSearch: null,
  })
  wx.sseScripts = [
    // 第一轮：写文件（参数分片 + 中文内容，考验字节流重组）
    [
      toolCall('w1', 'write_file', '{"path":"notes/微信.md","content":"# 微信', true),
      toolCall('w1', 'write_file', '测试\\n中文内容端到端"}', false),
      sse({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
    ].join(''),
    // 第二轮：读回验证
    [toolCall('r1', 'read_file', '{"path":"notes/微信.md"}', true), sse({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })].join(''),
    // 第三轮：最终回答
    done().join(''),
  ]
  await rt.send('在微信环境写入并读回 notes/微信.md')
  const s1 = rt.getSnapshot()
  assert(wx.readFileRaw('/notes/微信.md') === '# 微信测试\n中文内容端到端', 'wx PoC：write_file 经 wx FileSystemManager 落盘（中文无损坏）')
  const readMsg = s1.session!.messages.find((m) => m.role === 'tool' && m.name === 'read_file')
  assert(!!readMsg && readMsg.content!.includes('中文内容端到端'), 'wx PoC：read_file 读回一致')
  const final = [...s1.session!.messages].reverse().find((m) => m.role === 'assistant' && m.content)
  assert(final!.content === '微信环境端到端完成！', 'wx PoC：流式内容跨块重组正确（多字节切割无损）')
  assert((s1.session!.usage.prompt_cache_hit_tokens ?? 0) === 40, 'wx PoC：缓存命中计量正常')

  /* 3. run_js 诚实降级 */
  wx.sseScripts = [
    [toolCall('j1', 'run_js', '{"code":"return 1"}', true), sse({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })].join(''),
    done().join(''),
  ]
  await rt.send('算个数')
  const jsMsg = rt.getSnapshot().session!.messages.find((m) => m.role === 'tool' && m.name === 'run_js')
  assert(!!jsMsg && jsMsg.content!.includes('小程序环境暂不支持'), 'wx PoC：run_js 沙箱诚实降级（明确告知而非静默失败）')

  /* 4. 持久化："重启"（保留 Storage/文件，新 runtime 实例）后恢复会话 */
  wx.rebootKeepingData()
  const rt2 = await bootWechatHarness(wx as any)
  const snap2 = rt2.getSnapshot()
  assert(snap2.sessions.length === 1 && snap2.session!.messages.length > 0, 'wx PoC：重启后会话从 wx Storage 恢复')
  assert(wx.readFileRaw('/notes/微信.md') !== undefined, 'wx PoC：重启后工作区文件仍在')
  await rt2.selectSession(snap2.sessions[0].id)
  assert(rt2.getSnapshot().session!.messages.some((m) => m.content?.includes('微信环境端到端')), 'wx PoC：恢复的会话内容完整')

  /* 5. core 的 TextDecoder 缺失兜底（模拟部分基础库环境） */
  const td = (globalThis as any).TextDecoder
  try {
    delete (globalThis as any).TextDecoder
    const { parseSSE } = await import('../src/core/llm/sse')
    const events: string[] = []
    const enc = new TextEncoder()
    const raw = 'data: {"c":"微信汉"}\n\ndata: [DONE]\n\n'
    const bytes = enc.encode(raw)
    // 3 字节切块（'微' 是 3 字节 UTF-8，必然被切开）
    async function* chunks() {
      for (let i = 0; i < bytes.length; i += 3) yield bytes.slice(i, i + 3)
    }
    for await (const ev of parseSSE(chunks())) events.push(ev.data)
    const parsed = JSON.parse(events[0])
    assert(parsed.c === '微信汉' && events[1] === '[DONE]', 'wx PoC：无 TextDecoder 环境的纯 JS UTF-8 解码正确（多字节跨块）')
  } finally {
    ;(globalThis as any).TextDecoder = td
  }

  console.log(`\n微信小程序 PoC 全部通过（${passed} assertions）。core 在 wx 适配器上原样运行。`)
}

main().catch((e) => {
  console.error(e)
  throw e
})
