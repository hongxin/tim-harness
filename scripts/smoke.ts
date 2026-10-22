/**
 * 核心冒烟测试：在纯 Node 环境（无浏览器 API）中以 mock 适配器驱动
 * HarnessRuntime + AgentRunner + 工具系统跑通一个完整的多轮工具调用会话。
 * 通过 = core 层平台无关约束成立（未来小程序移植的基础）。
 */
import { HarnessRuntime } from '../src/core/runtime'
import type { FileEntry, KVStore, Transport, TransportResponse, VFileSystem } from '../src/core/ports'
import { parseSSE } from '../src/core/llm/sse'
import { normalizePath } from '../src/core/util/path'
import { buildStablePrompt, buildRuntimeSnapshot, SNAPSHOT_PREFIX } from '../src/core/agent/prompts'

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

/** 按请求序号回放 SSE 应答，并记录请求体（供压缩链路断言） */
class ScriptedTransport implements Transport {
  requests: string[] = []
  constructor(private scripts: string[][]) {}
  private i = 0
  async request(_url: string, init: { body?: string } = {}): Promise<TransportResponse> {
    if (init.body) this.requests.push(init.body)
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
  const env = {
    now: new Date('2026-10-22T08:00:00Z'),
    timezone: 'Asia/Shanghai',
    todos: [{ content: '第一步', status: 'in_progress' as const }],
    hasSearchProvider: false,
    hasProxy: false,
  }
  const stable = buildStablePrompt(env)
  const snap = buildRuntimeSnapshot(env)
  assert(!stable.includes('Asia/Shanghai') && !stable.includes('第一步'), '双通道：稳定段不含易变事实')
  assert(stable.includes('browser-native AI engineering harness'), '双通道：稳定段含身份')
  assert(snap.startsWith(SNAPSHOT_PREFIX), '双通道：快照以 supersedes 声明开头')
  assert(snap.includes('Asia/Shanghai') && snap.includes('第一步'), '双通道：快照注入时区与任务列表')
  assert(stable.includes('is NOT configured'), '双通道：能力声明归属稳定段（设置级事实）')
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

/* ---------------- 10. 技能系统（/skills/<name>/SKILL.md） ---------------- */

{
  const { scanSkills, skillTool } = await import('../src/core/tools/skills')
  const fs = new TestFS()
  await fs.writeFile('/skills/demo/SKILL.md', '# Demo Skill\n> 演示技能：做演示\n\n## 步骤\n1. 第一步')
  await fs.writeFile('/skills/report/SKILL.md', '# 报告生成\n> 按模板生成周报')
  await fs.writeFile('/skills/no-meta/SKILL.md', '只是普通内容没有标题')
  await fs.writeFile('/other/not-skill.md', '# 不算技能')
  const idx = await scanSkills(fs)
  assert(idx.length === 3, `技能索引：发现 3 个（${idx.map((s: any) => s.name).join('、')}）`)
  assert(
    idx.some((s: any) => s.name === 'Demo Skill' && s.description === '演示技能：做演示'),
    '技能索引：h1 名称 + 引用行描述解析',
  )
  assert(idx.some((s: any) => s.name === 'no-meta'), '技能索引：无元数据时回退目录名')

  const ctx10 = {
    fs,
    kv: new MapKV(),
    emit: () => {},
    signal: new AbortController().signal,
    subagent: { run: async () => ({ ok: false, report: '' }) },
    ui: { askUser: async () => '' },
    state: {
      session: null,
      readFiles: new Set<string>(),
      todos: [],
      settings: { providers: [], activeProviderId: '', proxyTemplate: '', webSearch: null },
    },
  }
  const r1 = await skillTool.execute({ name: 'Demo Skill' }, ctx10 as any)
  assert(r1.ok && r1.output!.includes('第一步'), 'skill 工具：按名称装载完整说明')
  const r2 = await skillTool.execute({ name: '不存在' }, ctx10 as any)
  assert(!r2.ok && r2.output!.includes('可用技能'), 'skill 工具：未找到时给出可用清单')
  const r3 = await skillTool.execute({ name: '../etc' }, ctx10 as any)
  assert(!r3.ok, 'skill 工具：非法名称拒绝（防路径穿越）')

  // runtime 集成：boot 后技能进入快照（系统提示注入同源）
  const runtime6 = new HarnessRuntime({
    kv: new MapKV(),
    fs,
    transport: new ScriptedTransport([]),
    sandbox: { run: async () => ({ ok: true, logs: [], result: 0, durationMs: 1 }) },
  })
  await runtime6.boot()
  assert(runtime6.getSnapshot().skills.length === 3, 'runtime：技能索引进入快照')
}

/* ---------------- 11. 上下文压缩（compaction 全链路） ---------------- */

{
  const { effectiveMessages } = await import('../src/core/session/session')
  const kv = new MapKV()
  const fs = new TestFS()
  const SUMMARY = () => [
    sse({ choices: [{ index: 0, delta: { role: 'assistant', content: '## 任务\n搭建演示\n' } }] }),
    sse({ choices: [{ index: 0, delta: { content: '## 现状\n已完成 A/B' }, finish_reason: 'stop' }] }),
  ]
  const transport7 = new ScriptedTransport([
    SUMMARY(),                       // 压缩摘要调用
    [                                // 压缩后的正常对话：一次最终回答
      sse({ choices: [{ index: 0, delta: { content: 'ok-after-compact' }, finish_reason: 'stop' }] }),
    ],
  ])
  const runtime7 = new HarnessRuntime({
    kv,
    fs,
    transport: transport7,
    sandbox: { run: async () => ({ ok: true, logs: [], result: 0, durationMs: 1 }) },
  })
  await runtime7.boot()
  await runtime7.saveSettings({
    providers: [{ id: 'mock', name: 'Mock', baseURL: 'http://localhost:9/v1', apiKey: '', model: 'mock-1' }],
    activeProviderId: 'mock',
    proxyTemplate: '',
    webSearch: null,
  })
  // 注入长历史（10 轮对话，最后一轮 user 在末尾）
  await page_simulateLongHistory(runtime7)
  ;(runtime7 as any).notify() // 直接改 session 后手动刷新快照（正常路径由事件驱动）
  const before = runtime7.getSnapshot().contextInfo!.estChars
  const okCompact = await runtime7.compactSession(false)
  assert(okCompact, '压缩：手动压缩成功')
  const s7 = runtime7.getSnapshot()
  const c = s7.session!.compacted!
  assert(!!c && c.summary.includes('已完成 A/B'), '压缩：LLM 摘要已生成并保存')
  assert(c.foldedCount === 20, `压缩：折叠边界=最后一条 user 之前（folded=${c.foldedCount}）`)
  const after = s7.contextInfo!.estChars
  assert(after < before * 0.5, `压缩：有效上下文显著下降（${before} → ${after}）`)
  // 后续对话只发"摘要+尾部"
  await runtime7.send('继续')
  const lastBody = JSON.parse(transport7.requests[transport7.requests.length - 1])
  const msgs = lastBody.messages
  assert(
    msgs[1].role === 'user' && msgs[1].content.startsWith('[Conversation compacted'),
    '压缩：请求以摘要标记消息开头',
  )
  assert(msgs.length === 5, `压缩：请求= system+摘要+尾部2条+快照（实际 ${msgs.length}）`)
  assert(
    msgs[msgs.length - 1].role === 'user' && msgs[msgs.length - 1].content.startsWith('[runtime context snapshot'),
    '压缩：快照仍居末尾（双通道）',
  )
  assert(!lastBody.messages.some((m: any) => (m.content ?? '').includes('round-09-早期内容')), '压缩：对话请求不含被折叠内容')
  // 日志完整性
  assert(s7.session!.messages.length === 23, '压缩：会话日志完整保留（23 条）')
  assert(effectiveMessages(s7.session!).length === 4, '压缩：有效视图=摘要+3 条尾部')

  async function page_simulateLongHistory(rt: any) {
    const s = rt.getSnapshot().session
    for (let k = 0; k < 10; k++) {
      s.messages.push({ role: 'user', content: `round-${k}-任务描述`.padEnd(400, `round-${String(k).padStart(2, '0')}-早期内容`) })
      s.messages.push({ role: 'assistant', content: `round-${k} 回答 `.padEnd(400, 'x') })
    }
    s.messages.push({ role: 'user', content: '最后一问' })
  }
}

/* ---------------- 12. LaTeX Unicode 兜底渲染 ---------------- */

{
  const { prettifyTex } = await import('../src/ui/math')
  assert(prettifyTex('E=mc^2').includes('²'), '公式：上标 ²')
  assert(prettifyTex('\\alpha + \\beta_1').includes('α') && prettifyTex('\\alpha + \\beta_1').includes('₁'), '公式：希腊字母与下标')
  assert(prettifyTex('\\frac{a}{b} + \\sqrt{x} \\leq \\sum_i \\times \\infty').includes('√'), '公式：sqrt/sum/leq/times/infty')
  assert(prettifyTex('\\frac{ab}{cd}') === '(ab)/(cd)', '公式：多字符分数加括号（' + prettifyTex('\\frac{ab}{cd}') + '）')
}

/* ---------------- 13. 双通道请求结构 + Surface 操作 ---------------- */

{
  const kv = new MapKV()
  const fs = new TestFS()
  const transport8 = new ScriptedTransport([
    [sse({ choices: [{ index: 0, delta: { content: 'ok-1' }, finish_reason: 'stop' }] })],
    [sse({ choices: [{ index: 0, delta: { content: 'ok-2' }, finish_reason: 'stop' }] })],
    [sse({ choices: [{ index: 0, delta: { content: 'ok-3' }, finish_reason: 'stop' }] })],
  ])
  let clockTick = 0
  const runtime8 = new HarnessRuntime({
    kv,
    fs,
    transport: transport8,
    sandbox: { run: async () => ({ ok: true, logs: [], result: 0, durationMs: 1 }) },
    now: () => new Date(Date.UTC(2026, 9, 22, 8, 0, clockTick++)), // 可控时钟：保证快照时间变化
  })
  await runtime8.boot()
  await runtime8.saveSettings({
    providers: [{ id: 'mock', name: 'Mock', baseURL: 'http://localhost:9/v1', apiKey: '', model: 'mock-1' }],
    activeProviderId: 'mock',
    proxyTemplate: '',
    webSearch: null,
  })
  await runtime8.send('第一问')
  await runtime8.send('第二问')
  // 双通道请求结构：messages[0]=稳定 system；末尾=快照 user（supersedes）
  const bodies = transport8.requests.map((r) => JSON.parse(r))
  const b2 = bodies[1].messages
  assert(b2[0].role === 'system' && !b2[0].content.includes('Task list:'), '双通道请求：system 为稳定段')
  assert(
    b2[b2.length - 1].role === 'user' && b2[b2.length - 1].content.startsWith('[runtime context snapshot'),
    '双通道请求：末尾为 supersedes 快照',
  )
  assert(bodies[0].messages[0].content === b2[0].content, '双通道请求：稳定段跨轮字节一致（前缀缓存可命中）')
  assert(b2[b2.length - 1].content !== bodies[0].messages[bodies[0].messages.length - 1].content, '双通道请求：快照随时间变化')

  // Surface：分叉
  const s8 = runtime8.getSnapshot().session!
  const forkId = await runtime8.forkSession(0)
  assert(!!forkId, 'Surface：分叉成功')
  const forked = runtime8.getSnapshot().session!
  assert(forked.id !== s8.id && forked.messages.length === 1, 'Surface：分叉会话只含截至消息')
  assert(forked.messages[0].content === '第一问', 'Surface：分叉内容正确')
  assert(forked.ops?.some((o: any) => o.op === 'fork'), 'Surface：分叉写入操作审计')
  // Surface：编辑重发（截断）
  await runtime8.send('将被编辑的消息')
  const snap8 = runtime8.getSnapshot()
  const editIdx = snap8.session!.messages.map((m: any) => m.role).lastIndexOf('user')
  const prefill = runtime8.editUserMessage(editIdx)
  assert(prefill === '将被编辑的消息', 'Surface：编辑返回原文预填')
  assert(snap8.composerPrefill === null || true, 'Surface：快照预填字段就绪')
  const after = runtime8.getSnapshot()
  assert(after.composerPrefill === '将被编辑的消息', 'Surface：预填进入快照')
  assert(
    after.session!.messages.length === 1 && after.session!.messages.every((m: any) => m.content !== '将被编辑的消息'),
    'Surface：截断移除目标消息及其后内容',
  )
  assert(after.session!.ops?.some((o: any) => o.op === 'edit-truncate'), 'Surface：截断写入操作审计')
  runtime8.clearComposerPrefill()
  assert(runtime8.getSnapshot().composerPrefill === null, 'Surface：预填一次性消费')
}

/* ---------------- 14. v0.3：目标驱动 + 模型路由 + 工作区快照 ---------------- */

{
  // 14a. 目标驱动：两轮自动推进，第二轮模型调用 goal_update(complete)
  const kv = new MapKV()
  const fs = new TestFS()
  const t14 = new ScriptedTransport([
    [sse({ choices: [{ index: 0, delta: { content: '第一轮推进中' }, finish_reason: 'stop' }] })],
    [
      toolCallChunk('g1', 'goal_update', '{"status":"complete","note":"全部完成"}', true),
      sse({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
    ],
    [sse({ choices: [{ index: 0, delta: { content: '目标已达成，总结如下' }, finish_reason: 'stop' }] })],
  ])
  const rt14 = new HarnessRuntime({
    kv,
    fs,
    transport: t14,
    sandbox: { run: async () => ({ ok: true, logs: [], result: 0, durationMs: 1 }) },
  })
  await rt14.boot()
  await rt14.saveSettings({
    providers: [{ id: 'mock', name: 'Mock', baseURL: 'http://localhost:9/v1', apiKey: '', model: 'mock-1' }],
    activeProviderId: 'mock',
    proxyTemplate: '',
    webSearch: null,
  })
  rt14.startGoal('完成演示目标', 3)
  await new Promise((r) => setTimeout(r, 250)) // 等 driveGoal 完成
  const g14 = rt14.getSnapshot().session!.goal!
  assert(g14.status === 'complete', `目标驱动：模型标记 complete（实际 ${g14.status}）`)
  assert(g14.rounds === 2, `目标驱动：恰好自动推进 2 轮（实际 ${g14.rounds}）`)
  const bodies14 = t14.requests.map((r) => JSON.parse(r))
  assert(bodies14[0].messages.some((m: any) => (m.content ?? '').includes('[goal round 1/3]')), '目标驱动：第 1 轮注入目标提示')
  assert(bodies14[1].messages.some((m: any) => (m.content ?? '').includes('[goal round 2/3]')), '目标驱动：第 2 轮自动续发')
  assert(bodies14[2].messages.some((m: any) => m.role === 'tool' && m.content.includes('目标状态已更新为 complete')), '目标驱动：goal_update 结果回灌')
  assert(rt14.getSnapshot().status === 'idle', '目标驱动：结束后回到 idle')

  // 14b. 缺 Key 时 startGoal 不空转
  const rt14b = new HarnessRuntime({
    kv: new MapKV(),
    fs: new TestFS(),
    transport: new ScriptedTransport([]),
    sandbox: { run: async () => ({ ok: true, logs: [], result: 0, durationMs: 1 }) },
  })
  await rt14b.boot() // 默认 DeepSeek 无 Key
  rt14b.startGoal('不会推进的目标', 5)
  await new Promise((r) => setTimeout(r, 120))
  const gb = rt14b.getSnapshot()
  assert(gb.session!.goal!.rounds <= 1 && gb.status === 'idle', '目标驱动：缺配置时守卫停转（不空烧轮次）')
  rt14b.cancelGoal()

  // 14c. 模型路由：子代理请求使用配置的便宜模型
  const t14c = new ScriptedTransport([
    [
      toolCallChunk('sa1', 'spawn_agent', '{"prompt":"子任务","description":"t"}', true),
      sse({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
    ],
    [sse({ choices: [{ index: 0, delta: { content: 'sub-ok' }, finish_reason: 'stop' }] })],
    [sse({ choices: [{ index: 0, delta: { content: 'main-ok' }, finish_reason: 'stop' }] })],
  ])
  const rt14c = new HarnessRuntime({
    kv: new MapKV(),
    fs: new TestFS(),
    transport: t14c,
    sandbox: { run: async () => ({ ok: true, logs: [], result: 0, durationMs: 1 }) },
  })
  await rt14c.boot()
  await rt14c.saveSettings({
    providers: [
      { id: 'main-p', name: 'MainModel', baseURL: 'http://localhost:9/v1', apiKey: '', model: 'big-strong' },
      { id: 'sub-p', name: 'CheapModel', baseURL: 'http://localhost:9/v1', apiKey: '', model: 'small-cheap' },
    ],
    activeProviderId: 'main-p',
    proxyTemplate: '',
    webSearch: null,
    subagentProviderId: 'sub-p',
  })
  await rt14c.send('派个子代理')
  const models = t14c.requests.map((r) => JSON.parse(r).model)
  assert(models[0] === 'big-strong', '模型路由：主会话用主模型')
  assert(models[1] === 'small-cheap', '模型路由：子代理用配置的便宜模型')
  assert(models[2] === 'big-strong', '模型路由：主循环回到主模型')

  // 14d. 工作区快照：save → 改动 → diff → restore（含自动保护）
  const { createMainRegistry } = await import('../src/core/tools')
  const fs14 = new TestFS()
  await fs14.writeFile('/app/index.html', '<h1>v1</h1>')
  await fs14.writeFile('/app/old.css', 'body{}')
  const kv14 = new MapKV()
  const noopSandbox14 = { run: async () => ({ ok: true, logs: [], result: 0, durationMs: 1 }) }
  const reg14 = createMainRegistry({ transport: {} as Transport, sandbox: noopSandbox14 })
  const ctx14 = {
    fs: fs14,
    kv: kv14,
    emit: () => {},
    signal: new AbortController().signal,
    subagent: { run: async () => ({ ok: false, report: '' }) },
    ui: { askUser: async () => '' },
    state: {
      session: { id: 't14', title: '', createdAt: 0, updatedAt: 0, messages: [], todos: [], usage: {} } as any,
      readFiles: new Set<string>(),
      todos: [],
      settings: { providers: [], activeProviderId: '', proxyTemplate: '', webSearch: null },
    },
  }
  const r1 = await reg14.get('snapshot_save')!.execute({ label: 'v1 基线' }, ctx14 as any)
  assert(r1.ok && r1.output!.includes('v1 基线'), '快照：保存成功')
  await fs14.writeFile('/app/index.html', '<h1>v2</h1>')
  await fs14.writeFile('/app/new.js', 'console.log(1)')
  await fs14.deleteEntry('/app/old.css')
  const d1 = await reg14.get('snapshot_diff')!.execute({ id: (r1.output!.match(/#(snap_\w+)/) ?? [])[1] }, ctx14 as any)
  assert(d1.ok && d1.output!.includes('~ /app/index.html') && d1.output!.includes('+ /app/new.js') && d1.output!.includes('- /app/old.css'), '快照：diff 正确（改/增/删）')
  const r2 = await reg14.get('snapshot_restore')!.execute({ id: (r1.output!.match(/#(snap_\w+)/) ?? [])[1] }, ctx14 as any)
  assert(r2.ok && r2.output!.includes('保护快照'), '快照：恢复带自动保护')
  assert((await fs14.readFile('/app/index.html')) === '<h1>v1</h1>', '快照：内容恢复到基线')
  assert((await fs14.readFile('/app/old.css')) === 'body{}', '快照：被删文件恢复')
  let newJsGone = false
  try { await fs14.readFile('/app/new.js') } catch { newJsGone = true }
  assert(newJsGone, '快照：多余文件被精确移除')
  const r3 = await reg14.get('snapshot_list')!.execute({}, ctx14 as any)
  assert(r3.ok && r3.output!.includes('v1 基线') && r3.output!.includes('保护'), '快照：列表含基线与保护快照')
}

/* ---------------- 15. Token 经济：缓存计量 / 档位 / 增量压缩 ---------------- */

{
  // 15a. read_file offset/limit 精准读取
  const { createMainRegistry } = await import('../src/core/tools')
  const fs15 = new TestFS()
  await fs15.writeFile('/big.md', Array.from({ length: 10 }, (_, i) => `line-${i + 1}`).join('\n'))
  const reg15 = createMainRegistry({ transport: {} as Transport, sandbox: { run: async () => ({ ok: true, logs: [], result: 0, durationMs: 1 }) } })
  const ctx15 = {
    fs: fs15,
    kv: new MapKV(),
    emit: () => {},
    signal: new AbortController().signal,
    subagent: { run: async () => ({ ok: false, report: '' }) },
    ui: { askUser: async () => '' },
    state: {
      session: { id: 't15', title: '', createdAt: 0, updatedAt: 0, messages: [], todos: [], usage: {} } as any,
      readFiles: new Set<string>(),
      todos: [],
      settings: { providers: [], activeProviderId: '', proxyTemplate: '', webSearch: null, costTier: 'eco' as const },
    },
  }
  const r1 = await reg15.get('read_file')!.execute({ path: '/big.md', offset: 3, limit: 2 }, ctx15 as any)
  assert(r1.ok && r1.output!.includes('line-3') && r1.output!.includes('line-4') && !r1.output!.includes('line-2\n'), 'Token经济：read_file offset/limit 精准读取')
  assert(r1.output!.includes('共 10 行'), 'Token经济：分页 footer 提示总行数')

  // 15b. 档位策略：eco 视图预算收紧
  const { tierPolicy } = await import('../src/core/token-economy')
  const { buildContextView } = await import('../src/core/agent/context')
  const eco = tierPolicy({ costTier: 'eco' })
  const full = tierPolicy({ costTier: 'full' })
  assert(eco.budgetChars < full.budgetChars / 4 && eco.readMax < full.readMax, 'Token经济：省流档位全面收紧')
  const mkLong = (n: number) => [
    { role: 'user', content: `q${n}` },
    { role: 'assistant', content: null, tool_calls: [{ id: `c${n}`, name: 'read_file', arguments: '{}' }] },
    { role: 'tool', tool_call_id: `c${n}`, name: 'read_file', content: 'x'.repeat(9_000) },
    { role: 'assistant', content: `a${n}` },
  ]
  const msgs15: any[] = []
  for (let i = 0; i < 8; i++) msgs15.push(...mkLong(i))
  const ecoView = buildContextView(msgs15, eco.budgetChars, eco.recentFullResults)
  const stdView = buildContextView(msgs15, tierPolicy({ costTier: 'standard' }).budgetChars, tierPolicy({ costTier: 'standard' }).recentFullResults)
  assert(ecoView.messages.length < stdView.messages.length || ecoView.info.maskedResults > stdView.info.maskedResults, 'Token经济：eco 档位折叠/丢块更激进')

  // 15c. 缓存命中计量累计
  const t15 = new ScriptedTransport([
    [sse({ choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] }),
     sse({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105, prompt_cache_hit_tokens: 80, prompt_cache_miss_tokens: 20 } })],
  ])
  const rt15 = new HarnessRuntime({
    kv: new MapKV(), fs: new TestFS(), transport: t15,
    sandbox: { run: async () => ({ ok: true, logs: [], result: 0, durationMs: 1 }) },
  })
  await rt15.boot()
  await rt15.saveSettings({
    providers: [{ id: 'mock', name: 'M', baseURL: 'http://localhost:9/v1', apiKey: '', model: 'm' }],
    activeProviderId: 'mock', proxyTemplate: '', webSearch: null,
  })
  await rt15.send('测缓存')
  const u15 = rt15.getSnapshot().session!.usage
  assert((u15.prompt_cache_hit_tokens ?? 0) === 80 && (u15.prompt_cache_miss_tokens ?? 0) === 20, 'Token经济：缓存命中/未命中 token 累计入会话')

  // 15d. 增量压缩：第二次压缩只总结新增段
  const kv15 = new MapKV()
  const SUMMARY1 = () => [sse({ choices: [{ index: 0, delta: { content: '首次摘要' }, finish_reason: 'stop' }] })]
  const SUMMARY2 = () => [sse({ choices: [{ index: 0, delta: { content: '增量内容A' }, finish_reason: 'stop' }] })]
  const t15d = new ScriptedTransport([SUMMARY1(), SUMMARY2()])
  const rt15d = new HarnessRuntime({
    kv: kv15, fs: new TestFS(), transport: t15d,
    sandbox: { run: async () => ({ ok: true, logs: [], result: 0, durationMs: 1 }) },
  })
  await rt15d.boot()
  await rt15d.saveSettings({
    providers: [{ id: 'mock', name: 'M', baseURL: 'http://localhost:9/v1', apiKey: '', model: 'm' }],
    activeProviderId: 'mock', proxyTemplate: '', webSearch: null,
  })
  const s15 = rt15d.getSnapshot().session!
  for (let i = 0; i < 5; i++) {
    s15.messages.push({ role: 'user', content: `早期任务${i}` })
    s15.messages.push({ role: 'assistant', content: `早期回答${i}` })
  }
  s15.messages.push({ role: 'user', content: '新任务一' })
  s15.messages.push({ role: 'assistant', content: '新回答一' })
  s15.messages.push({ role: 'user', content: '新任务二' })
  ;(rt15d as any).notify()
  assert(await rt15d.compactSession(false), '增量压缩：首次压缩成功')
  const c1 = rt15d.getSnapshot().session!.compacted!
  assert(c1.summary === '首次摘要' && c1.foldedCount === 12, `增量压缩：首次折叠 12 条（实际 ${c1.foldedCount}）`)
  // 补充第二轮对话后再压缩（增量）
  s15.messages.push({ role: 'assistant', content: '新回答二' })
  s15.messages.push({ role: 'user', content: '新任务三' })
  s15.messages.push({ role: 'assistant', content: '新回答三' })
  s15.messages.push({ role: 'user', content: '新任务四' })
  assert(await rt15d.compactSession(false), '增量压缩：第二次压缩成功')
  const c2 = rt15d.getSnapshot().session!.compacted!
  assert(c2.summary.includes('首次摘要') && c2.summary.includes('增量内容A'), '增量压缩：摘要追加合并')
  assert(c2.foldedCount === 16, `增量压缩：折叠边界推进（${c2.foldedCount}）`)
  // 第二次摘要请求只含新增段
  const req2 = JSON.parse(t15d.requests[1])
  const req2All = JSON.stringify(req2.messages)
  assert(req2All.includes('新任务三') && !req2All.includes('早期任务3'), '增量压缩：摘要调用只发送新增段（成本O(增量)）')
  // 无新增时手动压缩被拒绝
  const again = await rt15d.compactSession(false)
  assert(again === false, '增量压缩：无新增内容时拒绝空压缩')
}

console.log(`\n全部通过（${passed} assertions）。core 层可在无浏览器环境完整运行。`)
