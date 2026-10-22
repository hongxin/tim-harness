/** 虚拟工作区路径工具（POSIX 风格，根为 /）。纯函数，无平台依赖。 */

export function normalizePath(p: string): string {
  if (!p) return '/'
  const abs = p.startsWith('/') ? p : '/' + p
  const parts: string[] = []
  for (const seg of abs.split('/')) {
    if (!seg || seg === '.') continue
    if (seg === '..') {
      parts.pop()
      continue
    }
    parts.push(seg)
  }
  return '/' + parts.join('/')
}

export function joinPath(base: string, rel: string): string {
  if (rel.startsWith('/')) return normalizePath(rel)
  return normalizePath(base.replace(/\/$/, '') + '/' + rel)
}

export function dirname(p: string): string {
  const n = normalizePath(p)
  if (n === '/') return '/'
  const idx = n.lastIndexOf('/')
  return idx <= 0 ? '/' : n.slice(0, idx)
}

export function basename(p: string): string {
  const n = normalizePath(p)
  if (n === '/') return '/'
  return n.slice(n.lastIndexOf('/') + 1)
}

export function extname(p: string): string {
  const b = basename(p)
  const i = b.lastIndexOf('.')
  return i > 0 ? b.slice(i + 1).toLowerCase() : ''
}

/** 相对显示（去掉开头的 /） */
export function displayPath(p: string): string {
  const n = normalizePath(p)
  return n === '/' ? '/' : n.slice(1)
}

const TEXT_EXTS = new Set([
  'txt', 'md', 'markdown', 'json', 'jsonc', 'json5', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf',
  'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'vue', 'svelte',
  'css', 'scss', 'less', 'html', 'htm', 'xml', 'svg',
  'py', 'rb', 'go', 'rs', 'java', 'kt', 'c', 'h', 'cpp', 'hpp', 'cs', 'swift', 'php', 'sh', 'bash', 'zsh',
  'sql', 'graphql', 'env', 'gitignore', 'editorconfig', 'log', 'csv', 'tsv',
])

/** 依据扩展名猜测是否为文本文件（grep 等工具的初筛） */
export function likelyTextFile(path: string): boolean {
  const ext = extname(path)
  if (!ext) return true // 无扩展名默认尝试文本（如 Makefile、LICENSE）
  return TEXT_EXTS.has(ext)
}

/** 极简 glob → RegExp：支持 ** * ? ；不支持 {} 展开 */
export function globToRegExp(pattern: string): RegExp {
  let re = ''
  let i = 0
  while (i < pattern.length) {
    const c = pattern[i]
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        // ** 匹配任意（含 /）
        re += '.*'
        i += 2
        if (pattern[i] === '/') i++ // "**/" 中的 / 吸收
        continue
      }
      re += '[^/]*'
      i++
      continue
    }
    if (c === '?') {
      re += '[^/]'
      i++
      continue
    }
    re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    i++
  }
  return new RegExp('^' + re + '$')
}

/** 生成短 id */
export function genId(prefix = ''): string {
  const rnd =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID().replace(/-/g, '').slice(0, 12)
      : Math.random().toString(36).slice(2, 14) + Date.now().toString(36)
  return prefix + rnd
}

/** 字节人类可读化 */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

/** 截断长文本，附说明 */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return text.slice(0, max) + `\n…[truncated ${text.length - max} chars]`
}
