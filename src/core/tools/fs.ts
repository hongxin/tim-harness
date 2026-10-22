/**
 * 虚拟文件系统工具族：ls / read_file / write_file / edit_file / grep / glob
 * 体现 DSH 的工作纪律：先读后写、edit 要求唯一匹配、错误信息指导下一步。
 */
import type { ToolDef, ToolResult } from '../types'
import {
  displayPath,
  formatBytes,
  globToRegExp,
  joinPath,
  likelyTextFile,
  normalizePath,
  truncate,
} from '../util/path'

const READ_MAX = 200_000 // read_file 单文件上限（字符）
const GREP_MAX_FILES = 2000
const GREP_MAX_MATCHES = 200
const WRITE_MAX = 2_000_000

function err(message: string): ToolResult {
  return { ok: false, output: `Error: ${message}` }
}

function ok(output: string, meta?: Record<string, unknown>): ToolResult {
  return { ok: true, output, meta }
}

/** 递归收集文件路径（深度与数量受限） */
async function walkFiles(
  fs: import('../ports').VFileSystem,
  dir: string,
  out: string[],
  depth = 0,
): Promise<void> {
  if (depth > 12 || out.length > GREP_MAX_FILES) return
  const entries = await fs.list(dir)
  for (const e of entries) {
    if (e.kind === 'dir') await walkFiles(fs, e.path, out, depth + 1)
    else out.push(e.path)
  }
}

export const lsTool: ToolDef = {
  name: 'ls',
  description:
    'List entries of a directory in the virtual workspace. Input is a directory path relative to / (default "."). Returns names, kinds and sizes.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Directory path, e.g. "src" or "/src/core". Default "."' },
    },
  },
  async execute(args, ctx) {
    const dir = normalizePath(String(args.path ?? '.'))
    try {
      const entries = await ctx.fs.list(dir)
      if (entries.length === 0) return ok(`(empty directory ${displayPath(dir)})`)
      entries.sort((a, b) => a.path.localeCompare(b.path))
      const lines = entries.map(
        (e) =>
          `${e.kind === 'dir' ? 'd' : '-'} ${displayPath(e.path)}${e.kind === 'dir' ? '/' : ''}${
            e.size != null ? `  (${formatBytes(e.size)})` : ''
          }`,
      )
      return ok(lines.join('\n') + `\n\n${entries.length} entries.`)
    } catch (e) {
      return err(`无法列出 ${displayPath(dir)}：${e instanceof Error ? e.message : e}`)
    }
  },
}

export const readFileTool: ToolDef = {
  name: 'read_file',
  description:
    'Read a UTF-8 text file from the virtual workspace and return line-numbered content. Use it before editing an existing file. Large files are truncated.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path, e.g. "src/index.ts"' },
    },
    required: ['path'],
  },
  async execute(args, ctx) {
    const path = normalizePath(String(args.path ?? ''))
    if (path === '/') return err('路径是一个目录')
    try {
      const content = await ctx.fs.readFile(path)
      ctx.state.readFiles.add(path)
      const numbered = content
        .split('\n')
        .map((line, i) => `${String(i + 1).padStart(5)}\t${line}`)
        .join('\n')
      return ok(truncate(numbered, READ_MAX) + `\n\n[${displayPath(path)} · ${content.length} chars]`)
    } catch (e) {
      return err(`读取 ${displayPath(path)} 失败：${e instanceof Error ? e.message : e}`)
    }
  },
}

export const writeFileTool: ToolDef = {
  name: 'write_file',
  description:
    'Create or fully overwrite a UTF-8 text file in the virtual workspace (parent directories are created automatically). For an existing file you MUST have read it with read_file earlier in this session; prefer edit_file for targeted changes.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path' },
      content: { type: 'string', description: 'Full file content (UTF-8)' },
    },
    required: ['path', 'content'],
  },
  async execute(args, ctx) {
    const path = normalizePath(String(args.path ?? ''))
    const content = String(args.content ?? '')
    if (path === '/') return err('路径无效')
    if (content.length > WRITE_MAX) return err(`内容过大（${content.length} chars，上限 ${WRITE_MAX}）`)
    let exists = false
    try {
      await ctx.fs.readBytes(path)
      exists = true
    } catch {
      exists = false
    }
    if (exists && !ctx.state.readFiles.has(path)) {
      return err(
        `${displayPath(path)} 已存在但本会话尚未读取过。请先用 read_file 读取，确认要整体覆盖后再 write_file（或改用 edit_file 做局部修改）。`,
      )
    }
    try {
      await ctx.fs.writeFile(path, content)
      ctx.state.readFiles.add(path)
      return ok(`已写入 ${displayPath(path)}（${content.length} chars）`)
    } catch (e) {
      return err(`写入 ${displayPath(path)} 失败：${e instanceof Error ? e.message : e}`)
    }
  },
}

export const editFileTool: ToolDef = {
  name: 'edit_file',
  description:
    'Replace a literal text snippet inside an existing file. You must have read the file with read_file first. old_string must appear exactly once unless replace_all is true.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path' },
      old_string: { type: 'string', description: 'Exact literal text to replace' },
      new_string: { type: 'string', description: 'Replacement text (empty string deletes)' },
      replace_all: { type: 'boolean', description: 'Replace every occurrence. Default false.' },
    },
    required: ['path', 'old_string', 'new_string'],
  },
  async execute(args, ctx) {
    const path = normalizePath(String(args.path ?? ''))
    const oldStr = String(args.old_string ?? '')
    const newStr = String(args.new_string ?? '')
    const replaceAll = args.replace_all === true
    if (!oldStr) return err('old_string 不能为空')
    if (!ctx.state.readFiles.has(path)) {
      return err(`本会话尚未 read_file 读取 ${displayPath(path)}，请先读取再编辑。`)
    }
    let content: string
    try {
      content = await ctx.fs.readFile(path)
    } catch (e) {
      return err(`读取 ${displayPath(path)} 失败：${e instanceof Error ? e.message : e}`)
    }
    const count = content.split(oldStr).length - 1
    if (count === 0) {
      return err(
        `old_string 在 ${displayPath(path)} 中未找到。请重新 read_file 获取当前内容后再试（注意空白与缩进必须完全一致）。`,
      )
    }
    if (count > 1 && !replaceAll) {
      return err(`old_string 出现了 ${count} 次。请提供更长的唯一上下文，或设置 replace_all=true。`)
    }
    const updated = replaceAll
      ? content.split(oldStr).join(newStr)
      : content.replace(oldStr, newStr)
    try {
      await ctx.fs.writeFile(path, updated)
      return ok(
        `已修改 ${displayPath(path)}：${replaceAll ? `替换 ${count} 处` : '替换 1 处'}，文件现为 ${updated.length} chars。`,
      )
    } catch (e) {
      return err(`写入 ${displayPath(path)} 失败：${e instanceof Error ? e.message : e}`)
    }
  },
}

export const grepTool: ToolDef = {
  name: 'grep',
  description:
    'Search file contents across the virtual workspace with a regular expression. Returns matching lines as path:line: text (up to 200 matches). Only text files are searched.',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Regular expression (RE2/JS syntax)' },
      path: { type: 'string', description: 'Limit search to this subdirectory. Default "/"' },
    },
    required: ['pattern'],
  },
  async execute(args, ctx) {
    const pattern = String(args.pattern ?? '')
    const root = normalizePath(String(args.path ?? '/'))
    let re: RegExp
    try {
      re = new RegExp(pattern)
    } catch (e) {
      return err(`正则不合法：${e instanceof Error ? e.message : e}`)
    }
    const files: string[] = []
    try {
      await walkFiles(ctx.fs, root, files)
    } catch (e) {
      return err(`遍历 ${displayPath(root)} 失败：${e instanceof Error ? e.message : e}`)
    }
    const results: string[] = []
    let searched = 0
    for (const f of files) {
      if (!likelyTextFile(f)) continue
      let content: string
      try {
        content = await ctx.fs.readFile(f)
      } catch {
        continue
      }
      searched++
      const lines = content.split('\n')
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i])) {
          results.push(`${displayPath(f)}:${i + 1}: ${lines[i].trim().slice(0, 200)}`)
          if (results.length >= GREP_MAX_MATCHES) break
        }
      }
      if (results.length >= GREP_MAX_MATCHES) break
    }
    if (results.length === 0) return ok(`（在 ${searched} 个文本文件中未匹配到 "${pattern}"）`)
    return ok(results.join('\n') + `\n\n${results.length} matches (searched ${searched} files)`)
  },
}

export const globTool: ToolDef = {
  name: 'glob',
  description:
    'Find files in the virtual workspace whose paths match a glob pattern (supports *, **, ?). Returns up to 500 paths.',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Glob pattern, e.g. "src/**/*.ts" or "*.md"' },
    },
    required: ['pattern'],
  },
  async execute(args, ctx) {
    const pattern = String(args.pattern ?? '')
    let re: RegExp
    try {
      re = globToRegExp(pattern)
    } catch (e) {
      return err(`glob 模式不合法：${e instanceof Error ? e.message : e}`)
    }
    const files: string[] = []
    await walkFiles(ctx.fs, '/', files)
    const matched = files
      .filter((f) => re.test(f) || re.test(displayPath(f)))
      .sort()
      .slice(0, 500)
    if (matched.length === 0) return ok(`（没有匹配 "${pattern}" 的文件）`)
    return ok(matched.map(displayPath).join('\n') + `\n\n${matched.length} files`)
  },
}

/** 供 UI 使用的路径工具再导出 */
export { joinPath }
