/**
 * 端口（Ports）定义 —— 六边形架构的核心。
 * core 只面向这些接口编程；浏览器实现见 src/platform/*，
 * 未来的微信小程序实现将提供 wx.request / wx storage 版本的适配器。
 */
import type { AgentEvent, AppSettings, FileEntry, SessionModel, TodoItem, ToolResult } from './types'

export type { FileEntry, SessionModel, TodoItem, ToolResult, AgentEvent, AppSettings } from './types'

/** 键值存储：会话、设置、虚拟 FS 降级持久化等 */
export interface KVStore {
  get<T>(key: string): Promise<T | undefined>
  set<T>(key: string, value: T): Promise<void>
  delete(key: string): Promise<void>
  keys(prefix?: string): Promise<string[]>
}

/** 虚拟文件系统（工作区）。路径为 POSIX 风格、以 / 为根。 */
export interface VFileSystem {
  readFile(path: string): Promise<string>
  readBytes(path: string): Promise<Uint8Array>
  writeFile(path: string, data: string | Uint8Array): Promise<void>
  deleteEntry(path: string): Promise<void>
  mkdir(path: string): Promise<void>
  /** 非递归列目录 */
  list(dir: string): Promise<FileEntry[]>
  /** 递归列出全部条目（grep/glob 用） */
  listAll(): Promise<FileEntry[]>
}

export interface TransportResponse {
  status: number
  headers: Record<string, string>
  text(): Promise<string>
  /** 流式响应体字节序列；非流式响应退化为一次性 chunk */
  bytes(): AsyncIterable<Uint8Array>
}

/** HTTP 传输端口（浏览器: fetch；小程序: wx.request；测试: mock） */
export interface Transport {
  request(
    url: string,
    init: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
  ): Promise<TransportResponse>
}

export interface SandboxResult {
  ok: boolean
  logs: string[]
  result?: unknown
  error?: string
  durationMs: number
}

/** JS 代码沙箱（浏览器: Web Worker；小程序/测试: mock 或禁用） */
export interface CodeSandbox {
  run(code: string, timeoutMs: number, signal?: AbortSignal): Promise<SandboxResult>
}

/** 子代理运行器（由 runtime 注入，避免 core 内部循环依赖） */
export interface SubagentRunner {
  run(instruction: string, description?: string): Promise<{ ok: boolean; report: string }>
}

/** 与用户的交互端口（浏览器: UI 卡片；小程序: 交互组件；headless: 自动应答） */
export interface UIInteractions {
  askUser(question: string, options?: { label: string; description?: string }[]): Promise<string>
}

/**
 * 每一轮（turn）的工具执行上下文。
 * runtime 负责构造；工具只通过它访问世界。
 */
export interface ToolContext {
  fs: VFileSystem
  kv: KVStore
  emit: (e: AgentEvent) => void
  signal: AbortSignal
  subagent: SubagentRunner
  ui: UIInteractions
  state: TurnState
}

/** 跨工具共享的轮内状态 */
export interface TurnState {
  session: SessionModel
  /** 本会话中已 read 过的文件（write/edit 前置策略） */
  readFiles: Set<string>
  todos: TodoItem[]
  settings: AppSettings
}

export type ToolResultOk = ToolResult
