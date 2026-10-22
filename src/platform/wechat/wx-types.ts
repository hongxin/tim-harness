/**
 * 微信小程序 wx API 最小类型声明（结构化，只声明 tim-harness 用到的面）。
 * 真实环境由微信基础库提供全局 `wx`；测试环境由 scripts/wx-mock.ts 提供。
 */

export interface WxOnChunkReceivedResult {
  data: ArrayBuffer
}

export interface WxRequestTask {
  abort(): void
  onChunkReceived(callback: (res: WxOnChunkReceivedResult) => void): void
}

export interface WxRequestOptions {
  url: string
  method?: string
  header?: Record<string, string>
  data?: string | unknown
  /** 开启分块传输（SSE 流式必需，基础库 ≥2.20.1） */
  enableChunked?: boolean
  timeout?: number
  success?: (res: { statusCode: number; header: Record<string, string>; data: string }) => void
  fail?: (err: { errMsg: string }) => void
}

export interface WxStat {
  size?: number
}

export interface WxFileSystemManager {
  readFile(opts: {
    filePath: string
    encoding?: string
    success: (res: { data: string | ArrayBuffer }) => void
    fail: (err: { errMsg: string }) => void
  }): void
  writeFile(opts: {
    filePath: string
    data: string | ArrayBuffer
    encoding?: string
    success: (r?: unknown) => void
    fail: (err: { errMsg: string }) => void
  }): void
  unlink(opts: { filePath: string; success: (r?: unknown) => void; fail: (err: { errMsg: string }) => void }): void
  rmdir(opts: { dirPath: string; recursive?: boolean; success: (r?: unknown) => void; fail: (err: { errMsg: string }) => void }): void
  mkdir(opts: { dirPath: string; recursive?: boolean; success: (r?: unknown) => void; fail: (err: { errMsg: string }) => void }): void
  readdir(opts: { dirPath: string; success: (res: { files: string[] }) => void; fail: (err: { errMsg: string }) => void }): void
  stat(opts: { path: string; success: (res: { stats: WxStat & { isDirectory?: () => boolean } }) => void; fail: (err: { errMsg: string }) => void }): void
}

export interface WxEnv {
  USER_DATA_PATH: string
}

export interface WxLike {
  request(options: WxRequestOptions): WxRequestTask
  getStorageInfoSync(): { keys: string[] }
  getStorageSync(key: string): unknown
  setStorageSync(key: string, value: unknown): void
  removeStorageSync(key: string): void
  getFileSystemManager(): WxFileSystemManager
  env: WxEnv
}

declare const wx: WxLike
