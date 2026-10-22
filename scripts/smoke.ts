/**
 * 核心冒烟测试：在纯 Node 环境（无浏览器 API）中以 mock 适配器驱动
 * HarnessRuntime + AgentRunner + 工具系统跑通一个完整的多轮工具调用会话。
 * 通过 = core 层平台无关约束成立（未来小程序移植的基础）。
 */
import { HarnessRuntime } from '../src/core/runtime'
import type { FileEntry, KVStore, Transport, TransportResponse, VFileSystem } from '../src/core/ports'
import { parseSSE } from '../src/core/llm/sse'
import { normalizePath } from '../src/core/util/path'
import { buildSystemPrompt } from '../src/core/agent/prompts'

let passed = 0
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) {
    console.error(`✗ FAIL: ${msg}`)
    throw new Error(`SMOKE FAIL: ${msg}`)
  }
  passed++
  console.log(`✓ ${msg}`)
}

/* ---------------- mock 适配器 ---------------- */

class MapKV implements KVStore {
  store = new Map<string, unknown>()
  async get<T>(key: string): Promise<T | undefined> {
    return this.store.get(key) as T | undefined
  }
  async set<T>(key: string, value: T): Promise<void> {
    this.store.set(key, value)
  }
  async delete(key: string): Promise<void> {
    this.store.delete(key)
  }
  async keys(prefix?: string): Promise<string[]> {
    const all = [...this.store.keys()]
    return prefix ? all.filter((k) => k.startsWith(prefix)) : all
  }
}

class TestFS implements VFileSystem {
  files = new Map<string, string>()
  async readFile(path: string): Promise<string> {
    const p = normalizePath(path)
    if (!this.files.has(p)) throw new Error(`文件不存在：${p}`)
    return this.files.get(p)!
  }
  async readBytes(path: string): Promise<Uint8Array> {
    return new TextEncoder().encode(await this.readFile(path))
  }
  async writeFile(path: string, data: string | Uint8Array): Promise<void> {
    this.files.set(normalizePath(path), typeof data === 'string' ? data : new TextDecoder().decode(data))
  }
  async deleteEntry(path: string): Promise<void> {
    const p = normalizePath(path)
    for (const k of [...this.files.keys()]) if (k === p || k.startsWith(p + '/')) this.files.delete(k)
  }
  async mkdir(): Promise<void> {}
  async list(dir: string): Promise<FileEntry[]> {
    const p = normalizePath(dir)
    const prefix = p === '/' ? '/' : p + '/'
    const out: FileEntry[] = []
    const seen = new Set<string>()
    for (const k of this.files.keys()) {
      if (!k.startsWith(prefix)) continue
      const rest = k.slice(prefix.length)
      if (!rest) continue
      if (rest.includes('/')) {
        const child = prefix + rest.split('/')[0]
        if (!seen.has(child)) {
          seen.add(child)
          out.push({ path: child, kind: 'dir' })
        }
      } else {
        out.push({ path: k, kind: 'file', size: this.files.get(k)!.length })
      }
    }
    return out.sort((a, b) => a.path.localeCompare(b.path))
  }
  async listAll(): Promise<FileEntry[]> {
    return [...this.files.entries()].map(([path, c]) => ({ path, kind: 'file' as const, size: c.length }))
  }
}

/** 按请求序号回放 SSE 应答 */
class ScriptedTransport implements Transport {
  constructor(private scripts: string[][]) {}
  private i = 0
  async request(): Promise<TransportResponse> {
    const events = this.scripts[this.i++] ?? this.scripts[this.scripts.length - 1]
    const body = events.join('') + 'data: [DONE]\n\n'
    // 每次只给 5 字节，模拟真实网络分片，同时考验 SSE 解析器
    const chunks: Uint8Array[] = []
    for (let j = 0; j < body.length; j += 5) chunks.push(new TextEncoder().encode(body.slice(j, j + 5)))
    return {
      status: 200,
      headers: {},
      text: async () => body,
      bytes: async function* () {
        for (const c of chunks) yield c
      },
    }
  }
}

const enc = new TextEncoder()
function sse(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`
}
function toolCallChunk(id: string, name: string, argsSoFar: string, first: boolean): string {
  return sse({
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [
            {
              index: 0,
              ...(first ? { id, type: 'function' } : {}),
              function: { ...(first ? { name } : {}), arguments: argsSoFar },
            },
          ],
        },
      },
    ],
  })
}
const FINAL = () => [
  sse({ choices: [{ index: 0, delta: { role: 'assistant', content: '全部' } }] }),
  sse({ choices: [{ index: 0, delta: { content: '完成。' }, finish_reason: 'stop' }] }),
  sse({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } }),
]

/* ---------------- 1. SSE 解析器单元测试 ---------------- */

{
  const pieces = [
    'data: {"a":',
    '1}\n\nda',
    'ta: {"a":2}\n\n: heartbeat\n\ndata: [DONE]',
    '\n\n',
  ]
  const out: string[] = []
  for await (const ev of parseSSE((async function* () {
    for (const p of pieces) yield enc.encode(p)
  })())) {
    out.push(ev.data)
  }
  assert(out[0] === '{"a":1}' && out[1] === '{"a":2}' && out[2] === '[DONE]', 'SSE 解析：跨 chunk 半行缓冲与心跳注释')
}

/* ---------------- 2. 系统提示词 ---------------- */

{
  const prompt = buildSystemPrompt({
    now: new Date('2026-10-22T08:00:00Z'),
    timezone: 'Asia/Shanghai',
    todos: [{ content: '第一步', status: 'in_progress' }],
    hasSearchProvider: false,
    hasProxy: false,
  })
  assert(prompt.includes('Asia/Shanghai') && prompt.includes('第一步') && prompt.includes('>'), '系统提示词注入时区与任务列表')
  assert(prompt.includes('is NOT configured'), '系统提示词诚实声明搜索能力缺失')
}

/* ---------------- 3. 工具语义直测（观测门 / 唯一匹配 / grep / glob） ---------------- */

{
  const kv = new MapKV()
  const fs = new TestFS()
  await fs.writeFile('/docs/readme.md', '# Title\n\nhello world\nhello again\n')
  const { createMainRegistry } = await import('../src/core/tools')
  const noopSandbox = { run: async () => ({ ok: true, logs: [], result: 42, durationMs: 1 }) }
  const registry = createMainRegistry({ transport: {} as Transport, sandbox: noopSandbox })
  const ctx = {
    fs,
    kv,
    emit: () => {},
    signal: new AbortController().signal,
    subagent: { run: async () => ({ ok: false, report: '' }) },
    ui: { askUser: async () => 'yes' },
    state: {
      session: { id: 't', title: '', createdAt: 0, updatedAt: 0, messages: [], todos: [], usage: {} } as any,
      readFiles: new Set<string>(),
      todos: [],
      settings: { providers: [], activeProviderId: '', proxyTemplate: '', webSearch: null },
    },
  }

  const write = registry.get('write_file')!
  const gate = await write.execute({ path: 'docs/readme.md', content: 'x' }, ctx as any)
  assert(!gate.ok && gate.output.includes('尚未读取'), '观测门：未读先写被拒绝')

  const read = registry.get('read_file')!
  const r = await read.execute({ path: 'docs/readme.md' }, ctx as any)
  assert(r.ok && r.output.includes('hello world'), 'read_file 返回行号内容')

  const w2 = await write.execute({ path: 'docs/readme.md', content: 'x' }, ctx as any)
  assert(w2.ok, '观测门：读后允许写')

  await fs.writeFile('/docs/readme.md', '# Title\n\nhello world\nhello again\n')
  const edit = registry.get('edit_file')!
  const e1 = await edit.execute({ path: 'docs/readme.md', old_string: 'hello', new_string: 'hi' }, ctx as any)
  assert(!e1.ok && e1.output.includes('2 次'), 'edit_file：多处匹配且未开 replace_all 时拒绝')
  const e2 = await edit.execute(
    { path: 'docs/readme.md', old_string: 'hello', new_string: 'hi', replace_all: true },
    ctx as any,
  )
  assert(e2.ok && fs.files.get('/docs/readme.md')!.includes('hi again'), 'edit_file：replace_all 生效')

  const grep = registry.get('grep')!
  const g = await grep.execute({ pattern: 'hi' }, ctx as any)
  assert(g.ok && g.output.includes('docs/readme.md:4'), 'grep：路径:行号 输出')

  const glob = registry.get('glob')!
  const gl = await glob.execute({ pattern: 'docs/*.md' }, ctx as any)
  assert(gl.ok && gl.output.includes('docs/readme.md'), 'glob：模式匹配')

  const todo = registry.get('todo_write')!
  const t = await todo.execute({ todos: [{ content: 'A', status: 'in_progress' }, { content: 'B', status: 'pending' }] }, ctx as any)
  assert(t.ok && (ctx.state.todos as any[]).length === 2, 'todo_write：任务列表落位')

  const ask = registry.get('ask_user')!
  const a = await ask.execute({ question: '继续吗？', options: ['是', '否'] }, ctx as any)
  assert(a.ok && a.output.includes('[用户回答] yes'), 'ask_user：Promise 桥接用户应答')

  const spawn = registry.get('spawn_agent')!
  const sub = await spawn.execute({ prompt: '调研 X', description: 'x' }, ctx as any)
  assert(!sub.ok, 'spawn_agent：mock 失败路径正确回传')
}

/* ---------------- 4. HarnessRuntime 端到端：多轮工具调用会话 ---------------- */

{
  const kv = new MapKV()
  const fs = new TestFS()
  const scripts: string[][] = [
    // 第 1 轮：写文件
    [
      toolCallChunk('call_1', 'write_file', '{"path":"notes/hello', true),
      toolCallChunk('call_1', 'write_file', '.md","content":"# Hi\\nWorld"}', false),
      sse({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
      sse({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }),
    ],
    // 第 2 轮：读回来
    [
      toolCallChunk('call_2', 'read_file', '{"path":"notes/hello.md"}', true),
      sse({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
    ],
    // 第 3 轮：最终回答
    FINAL(),
  ]
  const transport = new ScriptedTransport(scripts)
  const runtime = new HarnessRuntime({
    kv,
    fs,
    transport,
    sandbox: { run: async () => ({ ok: true, logs: [], result: 0, durationMs: 1 }) },
    now: () => new Date('2026-10-22T08:00:00Z'),
  })
  await runtime.boot()

  // 无 key 的远程 provider 应被拒绝
  await runtime.send('你好')
  assert(runtime.getSnapshot().lastError?.includes('API Key') === true, '运行时守卫：缺 Key 拒绝发送')

  await runtime.saveSettings({
    providers: [
      { id: 'mock', name: 'Mock', baseURL: 'http://localhost:9/v1', apiKey: '', model: 'mock-1' },
    ],
    activeProviderId: 'mock',
    proxyTemplate: '',
    webSearch: null,
  })
  runtime.clearError()
  await runtime.send('创建 notes/hello.md，内容为 "# Hi" 与一行 "World"，然后读回来确认')

  const snap = runtime.getSnapshot()
  const session = snap.session!
  assert(snap.status === 'idle' && snap.lastError === null, '端到端：turn 正常结束')
  assert(session.title.includes('hello') || session.title.length > 0, '端到端：会话标题派生')
  assert(fs.files.get('/notes/hello.md') === '# Hi\nWorld', '端到端：write_file 参数流式拼装正确落盘')

  const roles = session.messages.map((m) => m.role)
  assert(
    roles.join(',') === 'user,assistant,tool,assistant,tool,assistant' ||
      roles.join(',').startsWith('user,assistant,tool'),
    `端到端：消息序列合法（${roles.join(',')}）`,
  )
  const toolMsg = session.messages.find((m) => m.role === 'tool' && m.name === 'read_file')
  assert(!!toolMsg && toolMsg!.content!.includes('World'), '端到端：工具结果回灌会话')
  const final = [...session.messages].reverse().find((m) => m.role === 'assistant' && m.content)
  assert(final!.content === '全部完成。', '端到端：流式内容分片正确拼装')

  // 持久化与恢复
  const stored = await kv.get<any>('session:' + session.id)
  assert(!!stored && stored.messages.length === session.messages.length, '端到端：会话已持久化到 KV')
  assert((session.usage.total_tokens ?? 0) >= 15, '端到端：usage 聚合')
}

/* ---------------- 5. 会话完整性修复（日志配平） ---------------- */

{
  const { repairSessionIntegrity } = await import('../src/core/session/repair')
  const dangling = {
    id: 's_x',
    title: 't',
    createdAt: 0,
    updatedAt: 0,
    todos: [],
    usage: {},
    messages: [
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'c1', name: 'read_file', arguments: '{"path":"a"}' },
          { id: 'c2', name: 'run_js', arguments: '{"code":"1"}' },
        ],
      },
      { role: 'tool', tool_call_id: 'c1', name: 'read_file', content: 'ok' },
      // c2 缺失 —— 模拟中断
      { role: 'assistant', content: 'done' },
    ],
  } as any
  const fixed = repairSessionIntegrity(dangling)
  assert(fixed === 1, '日志配平：识别并补齐 1 个悬空 tool_call')
  const c2msg = dangling.messages.find((m: any) => m.tool_call_id === 'c2')
  assert(!!c2msg && c2msg.content.includes('中断'), '日志配平：合成结果含幂等性指引')
  const idxTool = dangling.messages.indexOf(c2msg)
  const idxDone = dangling.messages.findIndex((m: any) => m.content === 'done')
  assert(idxTool > 0 && idxTool < idxDone, '日志配平：合成结果插入位置正确（紧跟连续 tool 块）')
  const again = repairSessionIntegrity(dangling)
  assert(again === 0, '日志配平：幂等，二次修复无操作')
}

/* ---------------- 6. 中止路径：ask_user 挂起 → 停止 → 配平 ---------------- */

{
  const kv = new MapKV()
  const fs = new TestFS()
  const scripts: string[][] = [
    [
      toolCallChunk('call_ask', 'ask_user', '{"question":"继续吗？"}', true),
      sse({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
    ],
  ]
  const runtime2 = new HarnessRuntime({
    kv,
    fs,
    transport: new ScriptedTransport(scripts),
    sandbox: { run: async () => ({ ok: true, logs: [], result: 0, durationMs: 1 }) },
    now: () => new Date('2026-10-22T08:00:00Z'),
  })
  await runtime2.boot()
  await runtime2.saveSettings({
    providers: [{ id: 'mock', name: 'Mock', baseURL: 'http://localhost:9/v1', apiKey: '', model: 'mock-1' }],
    activeProviderId: 'mock',
    proxyTemplate: '',
    webSearch: null,
  })
  const running = runtime2.send('请先问我')
  await new Promise((r) => setTimeout(r, 150)) // 等 ask_user 挂起
  assert(runtime2.getSnapshot().ask !== null, '中止测试：ask_user 已挂起等待用户')
  runtime2.stop()
  await running
  const s2 = runtime2.getSnapshot()
  assert(s2.status === 'idle' && s2.ask === null, '中止测试：停止后状态复位、ask 清空')
  const msgs = s2.session!.messages
  const repairedMsg = [...msgs].reverse().find((m) => m.role === 'tool' && m.content?.includes('中断'))
  assert(!!repairedMsg && repairedMsg.tool_call_id === 'call_ask', '中止测试：悬空 ask_user 调用已配平（可继续会话）')
  // 下一次发送的请求体合法性：序列里每个 tool_call 都有结果
  const assistantWithCalls = msgs.filter((m) => m.role === 'assistant' && m.tool_calls?.length)[0]
  const answered = new Set(msgs.filter((m) => m.role === 'tool').map((m) => m.tool_call_id))
  assert(assistantWithCalls.tool_calls!.every((tc) => answered.has(tc.id)), '中止测试：消息序列满足 API 配平约束')
}

/* ---------------- 7. 模型默认值迁移（deepseek-chat → deepseek-flash） ---------------- */

{
  const kv = new MapKV()
  // 模拟用户旧版保存的设置（已填 Key、模型为旧默认）
  await kv.set('app:settings', {
    providers: [{ id: 'deepseek', name: 'DeepSeek', baseURL: 'https://api.deepseek.com/v1', apiKey: 'sk-old', model: 'deepseek-chat' }],
    activeProviderId: 'deepseek',
    proxyTemplate: '',
    webSearch: null,
  })
  const runtime3 = new HarnessRuntime({
    kv,
    fs: new TestFS(),
    transport: new ScriptedTransport([]),
    sandbox: { run: async () => ({ ok: true, logs: [], result: 0, durationMs: 1 }) },
  })
  await runtime3.boot()
  const snap3 = runtime3.getSnapshot()
  const p = snap3.settings!.providers[0]
  assert(p.model === 'deepseek-flash', '模型迁移：旧默认 deepseek-chat 升级为 deepseek-flash')
  assert(p.apiKey === 'sk-old', '模型迁移：不动用户已保存的 API Key')
  assert(snap3.providerLabel === 'DeepSeek · DeepSeek V4.1 Flash', '模型迁移：顶栏显示名友好化')
  // 自定义模型名不被动
  await kv.set('app:settings', {
    providers: [{ id: 'deepseek', name: 'DeepSeek', baseURL: 'https://api.deepseek.com/v1', apiKey: 'sk-x', model: 'my-custom-model' }],
    activeProviderId: 'deepseek',
    proxyTemplate: '',
    webSearch: null,
  })
  const runtime4 = new HarnessRuntime({
    kv,
    fs: new TestFS(),
    transport: new ScriptedTransport([]),
    sandbox: { run: async () => ({ ok: true, logs: [], result: 0, durationMs: 1 }) },
  })
  await runtime4.boot()
  assert(runtime4.getSnapshot().settings!.providers[0].model === 'my-custom-model', '模型迁移：用户自定义模型名不受影响')
}

/* ---------------- 8. 上下文预算视图（JetBot ContextManager 思想） ---------------- */

{
  const { buildContextView, estimateChars } = await import('../src/core/agent/context')
  const mkTurn = (i: number) => [
    { role: 'user', content: `任务 ${i}` },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: `c${i}`, name: i % 2 === 0 ? 'read_file' : 'ls', arguments: `{"path":"f${i}"}` }],
    },
    {
      role: 'tool',
      tool_call_id: `c${i}`,
      name: i % 2 === 0 ? 'read_file' : 'ls',
      content: i % 5 === 0 ? 'dir a\ndir b\ndir a\ndir b\n' : 'x'.repeat(8_000), // ls 短结果=项目地图
      toolOk: i % 7 === 0 ? false : true,
    },
    { role: 'assistant', content: `第 ${i} 轮完成。` },
  ]
  const msgs: any[] = []
  for (let i = 0; i < 40; i++) msgs.push(...mkTurn(i))

  const small = buildContextView(msgs.slice(0, 4), 1_000_000)
  assert(small.messages.length === 4 && !small.info.masked, '上下文：未超预算走快路径')

  const view = buildContextView(msgs, 60_000)
  assert(view.info.masked, '上下文：超预算触发折叠视图')
  assert(
    estimateChars(view.messages) <= 60_000 * 1.03,
    `上下文：视图降至预算内（${estimateChars(view.messages)} chars）`,
  )
  const longResults = msgs.filter((m: any) => m.role === 'tool' && m.content.length === 8_000).length
  assert(
    msgs.length === 160 && longResults === 32,
    `上下文：原会话日志不被改动（${msgs.length} 条 / ${longResults} 条长结果）`,
  )

  const toolMsgs = view.messages.filter((m: any) => m.role === 'tool')
  assert(
    toolMsgs.slice(-4).every((m: any) => !m.content.includes('[Result masked')),
    '上下文：最近 4 条工具结果保持全文',
  )
  assert(toolMsgs.some((m: any) => m.content.includes('[Result masked')), '上下文：旧的长结果被折叠为摘要')
  assert(
    view.messages.some((m: any) => m.role === 'tool' && m.name === 'ls' && m.content.includes('dir a')),
    '上下文：ls 项目地图短结果豁免折叠',
  )
  const answeredIds = new Set(view.messages.filter((m: any) => m.role === 'tool').map((m: any) => m.tool_call_id))
  assert(
    view.messages
      .filter((m: any) => m.role === 'assistant' && m.tool_calls)
      .every((m: any) => m.tool_calls.every((tc: any) => answeredIds.has(tc.id))),
    '上下文：视图满足 API 配平约束',
  )
}

/* ---------------- 9. 审批缝（拒绝 → 允许 → 会话记忆） ---------------- */

{
  async function waitCond(fn: () => boolean, ms = 4_000): Promise<void> {
    const t0 = Date.now()
    while (!fn()) {
      if (Date.now() - t0 > ms) throw new Error('waitCond 超时')
      await new Promise((r) => setTimeout(r, 20))
    }
  }
  const kv = new MapKV()
  const fs = new TestFS()
  const wf = (id: string) => [
    toolCallChunk(id, 'write_file', '{"path":"/a.md","content":"A"}', true),
    sse({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
  ]
  const scripts: string[][] = [wf('k1'), wf('k2'), wf('k3'), FINAL()]
  const runtime5 = new HarnessRuntime({
    kv,
    fs,
    transport: new ScriptedTransport(scripts),
    sandbox: { run: async () => ({ ok: true, logs: [], result: 0, durationMs: 1 }) },
  })
  await runtime5.boot()
  await runtime5.saveSettings({
    providers: [{ id: 'mock', name: 'Mock', baseURL: 'http://localhost:9/v1', apiKey: '', model: 'mock-1' }],
    activeProviderId: 'mock',
    proxyTemplate: '',
    webSearch: null,
    toolApproval: 'on',
  })
  const turn = runtime5.send('写 a.md')
  await waitCond(() => runtime5.getSnapshot().approval !== null)
  runtime5.answerApproval(runtime5.getSnapshot().approval!.id, 'deny')
  await waitCond(() => runtime5.getSnapshot().approval !== null)
  runtime5.answerApproval(runtime5.getSnapshot().approval!.id, 'allow')
  await turn
  const s5 = runtime5.getSnapshot()
  const toolResults = s5.session!.messages.filter((m) => m.role === 'tool' && m.name === 'write_file')
  assert(toolResults.length === 3, `审批：三次 write_file 调用全部落账（${toolResults.length}）`)
  assert(toolResults[0].content!.includes('用户拒绝'), '审批：拒绝产生明确错误结果')
  assert(
    toolResults[1].content!.includes('已写入') && toolResults[2].content!.includes('已写入'),
    '审批：允许后两次写入成功',
  )
  assert(fs.files.get('/a.md') === 'A', '审批：文件实际写入')
  const denyCount = toolResults.filter((m) => m.content!.includes('用户拒绝')).length
  assert(denyCount === 1, '审批：会话内记忆生效（仅第一次被拒）')
  assert(s5.approval === null, '审批：结束无残留挂起卡片')
}

console.log(`\n全部通过（${passed} assertions）。core 层可在无浏览器环境完整运行。`)
